/**
 * Artifact purge: preflight with the public write-ownership probe, delete the
 * tree children-first, then remove the derived projection row and the
 * workspace accounting.
 *
 * The write handle is held until the directory is unlinked, so no second
 * instance can acquire the Session between the check and the removal.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { filePaths } from './paths.js'
import { SESSION_ID_RE, artifactDir, sessionIdVariants } from './tree.js'

/**
 * The projection cache opens its domain asynchronously. Deletion may begin
 * while that init is still in flight, so wait briefly for the public
 * `storageDomain` handle instead of silently leaving the row behind.
 * @param ctx - host context.
 * @returns the opened cache domain, or undefined when this profile has none.
 */
const cacheLookups = new WeakMap()
async function projectionCacheOf(ctx) {
  const existing = cacheLookups.get(ctx)
  if (existing !== undefined) return existing
  const lookup = (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const domains = ctx.get('storageDomain')
      if (domains !== undefined && domains !== null && typeof domains.get === 'function') {
        const cache = domains.get('session_projcache')
        if (cache !== undefined && cache !== null && typeof cache.table === 'function') return cache
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
  })()
  cacheLookups.set(ctx, lookup)
  return lookup
}

/**
 * Resolve and claim every artifact in the tree.
 * @param ctx - host context.
 * @param nodes - tree nodes from collectTree.
 * @param root - resolved sessions root.
 * @returns either a skip reason or the claimed entries plus missing ids.
 */
async function preflight(ctx, nodes, root) {
  const persistence = ctx.sessionPersistence
  const entries = new Map()
  const missing = new Set()
  const closeAll = async () => {
    for (const entry of entries.values()) await entry.handle.close().catch(() => {})
    entries.clear()
  }

  for (const node of nodes) {
    if (!SESSION_ID_RE.test(node.id)) {
      await closeAll()
      return { skip: 'invalid-id' }
    }
    let snapshot
    try {
      snapshot = await persistence.stat(node.id)
    } catch (error) {
      if (error?.name === 'SessionPersistenceNotFoundError') snapshot = undefined
      else {
        await closeAll()
        return { skip: 'stat-failed' }
      }
    }
    if (snapshot === undefined || snapshot === null) {
      missing.add(node.id)
      continue
    }
    if (snapshot.location === undefined || snapshot.location === null) {
      // A pending/live session reports a header without a location. It may be
      // an opened artifact held by this process, so it is NOT "already gone":
      // never clean its accounting without removing the log. Retry next boot.
      const sessions = ctx.get('sessions')
      const live = sessions !== undefined && sessions !== null && typeof sessions.get === 'function'
        && sessions.get(node.id) !== undefined
      await closeAll()
      return { skip: live ? 'live-pending' : 'unmaterialized' }
    }
    const dir = artifactDir(root, snapshot.location)
    if (dir === undefined) {
      await closeAll()
      return { skip: 'unsafe-path' }
    }
    try {
      const handle = await persistence.open(node.id, 'write')
      entries.set(node.id, { dir, handle })
    } catch (error) {
      if (error?.name === 'SessionAlreadyOwnedError') {
        await closeAll()
        return { skip: 'live' }
      }
      if (error?.name === 'SessionPersistenceNotFoundError') {
        missing.add(node.id)
        continue
      }
      await closeAll()
      return { skip: 'open-failed' }
    }
  }
  return { entries, missing }
}

/**
 * Purge one archived tree.
 *
 * The caller must persist `state` (including the journal) before calling; this
 * function adds the journal entry through `persist` and refuses to delete when
 * that write fails.
 *
 * @param ctx - host context.
 * @param options.rootId - archived root id.
 * @param options.nodes - tree nodes.
 * @param options.root - resolved sessions root.
 * @param options.state - current state (mutated with the journal entry).
 * @param options.persist - awaited state write.
 * @returns gone and remaining ids, or a skip reason.
 */
export async function purgeTree(ctx, { rootId, nodes, root, state, persist }) {
  const claimed = await preflight(ctx, nodes, root)
  if (claimed.skip !== undefined) return { skipped: claimed.skip, gone: [], remaining: nodes.map(node => node.id) }

  const ids = nodes.map(node => node.id)
  state.pending = state.pending.filter(entry => entry.rootId !== rootId)
  state.pending.push({ rootId, ids, startedAt: Date.now() })
  try {
    await persist()
  } catch (error) {
    for (const entry of claimed.entries.values()) await entry.handle.close().catch(() => {})
    return { skipped: 'state-write-failed', gone: [], remaining: ids }
  }

  const gone = new Set()
  const remaining = new Set()
  const blocked = new Set()

  // Deepest first. A node whose parent failed to unlink stays, so a parent is
  // never removed while one of its children survives.
  const ordered = [...nodes].sort((left, right) => right.depth - left.depth)
  for (const node of ordered) {
    if (node.parentId !== null && blocked.has(node.parentId)) {
      blocked.add(node.id)
      remaining.add(node.id)
      continue
    }
    if (claimed.missing.has(node.id)) {
      gone.add(node.id)
      continue
    }
    const entry = claimed.entries.get(node.id)
    if (entry === undefined) {
      blocked.add(node.id)
      remaining.add(node.id)
      continue
    }
    try {
      await rm(entry.dir, { recursive: true, force: true })
      gone.add(node.id)
    } catch (error) {
      blocked.add(node.id)
      remaining.add(node.id)
      ctx.logger?.warn?.(`session-cleaner: could not remove ${node.id}: ${String(error?.message ?? error)}`)
    }
  }

  for (const entry of claimed.entries.values()) await entry.handle.close().catch(() => {})
  return {
    gone: [...gone],
    remaining: [...remaining],
    dirs: [...claimed.entries.values()].map(entry => entry.dir),
  }
}

/**
 * Finish one journal entry: everything that is gone gets its derived row and
 * accounting removed; survivors stay in the journal for the next boot.
 *
 * @param ctx - host context.
 * @param options.pending - journal entry.
 * @param options.state - current state (mutated).
 * @param options.persist - awaited state write.
 * @param options.retentionDays - effective retention, for the audit record.
 * @returns counts for the run.
 */
export async function finishPending(ctx, { pending, state, persist, retentionDays }) {
  const gone = []
  const remaining = []
  for (const id of pending.ids) {
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(id)
    } catch (error) {
      if (error?.name !== 'SessionPersistenceNotFoundError') {
        remaining.push(id)
        continue
      }
      snapshot = undefined
    }
    // `stat` returning a snapshot means the session still exists. It can lack
    // a location while pending/live; only an undefined result proves the log
    // is gone and the accounting may be cleaned.
    if (snapshot !== undefined && snapshot !== null) remaining.push(id)
    else gone.push(id)
  }

  if (gone.length > 0) await cleanupGone(ctx, gone, { rootId: pending.rootId })
  if (gone.includes(pending.rootId)) delete state.archived[pending.rootId]

  if (remaining.length === 0) {
    state.pending = state.pending.filter(entry => entry !== pending)
  } else {
    pending.ids = remaining
  }
  try {
    await persist()
  } catch (error) {
    ctx.logger?.warn?.(`session-cleaner: could not persist cleanup state: ${String(error?.message ?? error)}`)
  }

  return { gone, remaining, retentionDays }
}

/**
 * Remove the derived projection row, cache backups, workspace accounting and
 * the Client row for ids whose log is confirmed gone.
 *
 * Uses the public `storageDomain` service for the projection cache; the cache
 * has no dedicated delete API and otherwise leaves a title/derived-data
 * document behind.
 *
 * @param ctx - host context.
 * @param ids - confirmed-gone session ids.
 * @param options.rootId - archived root, when known.
 */
export async function cleanupGone(ctx, ids, { rootId }) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return

  const cache = await projectionCacheOf(ctx)
  if (cache !== undefined) {
    try {
      const table = cache.table('sessions')
      for (const id of unique) {
        for (const variant of sessionIdVariants(id)) {
          try {
            await table.delete(variant)
          } catch {
            /* row absent or domain closing */
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-cleaner: projection cache cleanup failed: ${String(error?.message ?? error)}`)
    }
  }

  let names = []
  try {
    names = await readdir(filePaths().projectionCacheDir)
  } catch {
    /* no projection cache directory on this backend */
  }
  if (names.length > 0) {
    for (const id of unique) {
      for (const variant of sessionIdVariants(id)) {
        const prefix = `${variant}.json.bak.`
        for (const name of names) {
          if (!name.startsWith(prefix)) continue
          await rm(join(filePaths().projectionCacheDir, name), { force: true }).catch(() => {})
        }
      }
    }
  }

  const registry = ctx.workspaceRegistry
  if (registry !== undefined && registry !== null) {
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch (error) {
      ctx.logger?.warn?.(`session-cleaner: workspace listing failed: ${String(error?.message ?? error)}`)
    }
    for (const workspace of workspaces) {
      for (const id of unique) {
        try {
          await workspace.detachSession(id)
        } catch (error) {
          ctx.logger?.warn?.(`session-cleaner: detach ${id} failed: ${String(error?.message ?? error)}`)
        }
      }
    }
    for (const id of unique) {
      try {
        await registry.unarchiveSession(id)
      } catch {
        /* not archived or already gone */
      }
      try {
        await registry.unpinSession(id)
      } catch {
        /* not pinned */
      }
    }
  }

  for (const id of unique) {
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      ctx.logger?.warn?.(`session-cleaner: removal announcement failed: ${String(error?.message ?? error)}`)
    }
  }
  void rootId
}
