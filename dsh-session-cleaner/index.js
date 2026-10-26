/**
 * @dss886/dsh-session-cleaner — Host half.
 *
 * Deletes archived Sessions (and the subagent Sessions they own) only after
 * the plugin has observed the archive for a configured number of days. The
 * pass runs at startup, never against a live writer, and never through a
 * private runtime field:
 *
 *   - eligibility: `workspaceRegistry.archivedSessionIds`
 *   - artifact lookup: `sessionPersistence.stat(id).location`
 *   - safety probe: `sessionPersistence.open(id, 'write')` (cross-process flock)
 *   - child discovery: stored headers with `origin: 'subagent'`
 *   - accounting: `Workspace.detachSession` / `unarchiveSession` / `unpinSession`
 *   - derived cache: `storageDomain` → `session_projcache` → `sessions`
 *
 * There is no delete route and no agent tool. The only HTTP surface is the
 * settings/status pair used by the General settings row.
 */
import { filePaths, sessionsRoot } from './lib/paths.js'
import { loadSettings, saveSettings, RETENTION_OPTIONS } from './lib/settings.js'
import { freshState, loadState, saveState } from './lib/state.js'
import { acquireLock } from './lib/lock.js'
import { buildChildren, buildHeaderIndex, collectTree, SESSION_ID_RE } from './lib/tree.js'
import { cleanupGone, finishPending, purgeTree } from './lib/purge.js'
import { appendAudit } from './lib/audit.js'

export const name = 'dss886-dsh-session-cleaner'

const ROUTE_SETTINGS = '/dss886-dsh-session-cleaner/api/settings'
const ROUTE_STATUS = '/dss886-dsh-session-cleaner/api/status'
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024

let bootStarted = false
let routesRegistered = false
let passRunning = false
let currentState = null
let stateLoaded = false

/**
 * Register the startup pass, the archive tracker and the settings surface.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['sessionPersistence', 'workspaceRegistry'], (sub) => {
    if (bootStarted) return
    bootStarted = true
    void boot(sub)
      .catch((error) => warn(sub, `startup pass failed: ${describe(error)}`))
      .finally(() => {
        try {
          installTracking(sub)
        } catch (error) {
          warn(sub, `could not install archive tracking: ${describe(error)}`)
        }
        void trackArchives(sub).catch((error) => warn(sub, `archive tracking failed: ${describe(error)}`))
      })
  })

  ctx.inject(['webServer'], (sub) => {
    if (routesRegistered) return
    routesRegistered = true
    sub.effect(() => {
      const disposeSettings = sub.webServer.register({
        kind: 'exact',
        path: ROUTE_SETTINGS,
        handler: settingsHandler(sub),
      })
      const disposeStatus = sub.webServer.register({
        kind: 'exact',
        path: ROUTE_STATUS,
        handler: statusHandler(sub),
      })
      return () => {
        disposeSettings()
        disposeStatus()
      }
    }, 'dss886-dsh-session-cleaner: routes')
  })
}

// --- startup pass -----------------------------------------------------------

/**
 * One deletion pass. The pass lock serializes instances; the state write is a
 * precondition for deleting, so a run that cannot record what it did does not
 * delete.
 * @param ctx - context carrying sessionPersistence and workspaceRegistry.
 */
async function boot(ctx) {
  const root = sessionsRoot(ctx.sessionPersistence)
  const settings = await loadSettings()
  if (settings.invalid) warn(ctx, 'settings are invalid; automatic deletion is disabled until they are fixed')

  const loaded = await loadState(root)
  if (loaded.corrupt) warn(ctx, `state was corrupt; backup: ${loaded.backup ?? '(copy failed)'}`)
  let state = loaded.state
  if (state.root !== root) {
    warn(ctx, `state root changed (${state.root} -> ${root}); restarting the observation clock`)
    state = freshState(root)
  }
  // Publish the loaded state immediately so a failure before the first save
  // cannot make the finalizer overwrite it with a stale in-memory copy.
  currentState = state
  stateLoaded = true

  const lock = await acquireLock()
  if (lock === null) {
    warn(ctx, 'another cleaner pass is running; skipping this boot')
    return
  }

  passRunning = true
  const summary = {
    startedAt: Date.now(),
    finishedAt: null,
    deleted: 0,
    pending: 0,
    skipped: 0,
    skippedReasons: [],
    errors: 0,
  }
  try {
    const archived = ctx.workspaceRegistry.archivedSessionIds
    const alreadyGone = await reconcileArchives(ctx, state, archived)

    if (alreadyGone.length > 0) {
      // Clean accounting before persisting the removal: a crash in between
      // leaves the state entry in place, so the next boot retries the cleanup.
      await cleanupGone(ctx, alreadyGone, { rootId: null })
      summary.deleted += alreadyGone.length
      await appendAudit({
        at: new Date().toISOString(),
        reason: 'artifact-already-gone',
        ids: alreadyGone,
        retentionDays: settings.retentionDays,
      }).catch(() => {})
    }
    await saveState(state)

    if (!settings.enabled || settings.invalid) return

    let snapshots
    try {
      snapshots = await ctx.sessionPersistence.list()
    } catch (error) {
      warn(ctx, `could not list stored sessions: ${describe(error)}`)
      return
    }
    const headers = buildHeaderIndex(snapshots)
    const children = buildChildren(headers)

    // Finish work a previous process started before looking for new victims.
    for (const pending of [...state.pending]) {
      const sanitized = pending.ids.filter(id => SESSION_ID_RE.test(id))
      if (sanitized.length === 0) {
        state.pending = state.pending.filter(entry => entry !== pending)
        continue
      }
      const nodes = sanitized.map(id => ({ id, parentId: null, depth: 0 }))
      const retried = await purgeTree(ctx, {
        rootId: pending.rootId,
        nodes,
        root,
        state,
        persist: () => saveState(state),
      })
      if (retried.skipped !== undefined) {
        summary.skipped += 1
        summary.skippedReasons.push(`${pending.rootId}:${retried.skipped}`)
        warn(ctx, `pending cleanup for ${pending.rootId} skipped: ${retried.skipped}`)
        continue
      }
      const active = state.pending.find(entry => entry.rootId === pending.rootId) ?? pending
      const finished = await finishPending(ctx, {
        pending: active,
        state,
        persist: () => saveState(state),
        retentionDays: settings.retentionDays,
      })
      summary.deleted += finished.gone.length
      summary.pending += finished.remaining.length
      if (finished.gone.length > 0) {
        await appendAudit({
          at: new Date().toISOString(),
          reason: 'pending-retry',
          rootId: pending.rootId,
          ids: finished.gone,
          remaining: finished.remaining,
          retentionDays: settings.retentionDays,
        }).catch(() => {})
      }
    }

    const now = Date.now()
    const retentionMs = settings.retentionDays * DAY_MS
    const eligible = Object.entries(state.archived)
      .filter(([id, entry]) => archived.includes(id) && now - entry.firstSeenAt >= retentionMs)
      .sort((left, right) => left[1].firstSeenAt - right[1].firstSeenAt)

    for (const [id, entry] of eligible) {
      // Re-check: another window/instance may have unarchived it since the scan.
      if (!ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
        delete state.archived[id]
        continue
      }
      const nodes = collectTree(id, children)
      if (nodes.length === 0) {
        delete state.archived[id]
        continue
      }
      const result = await purgeTree(ctx, {
        rootId: id,
        nodes,
        root,
        state,
        persist: () => saveState(state),
      })
      if (result.skipped !== undefined) {
        summary.skipped += 1
        summary.skippedReasons.push(`${id}:${result.skipped}`)
        if (summary.skippedReasons.length > 50) summary.skippedReasons.shift()
        warn(ctx, `cleanup for ${id} skipped: ${result.skipped}`)
        continue
      }
      const pending = state.pending.find(entry => entry.rootId === id)
      if (pending === undefined) continue
      const finished = await finishPending(ctx, {
        pending,
        state,
        persist: () => saveState(state),
        retentionDays: settings.retentionDays,
      })
      summary.deleted += finished.gone.length
      summary.pending += finished.remaining.length
      if (finished.gone.length > 0) {
        await appendAudit({
          at: new Date().toISOString(),
          reason: 'retention',
          rootId: id,
          ids: finished.gone,
          remaining: finished.remaining,
          dirs: result.dirs,
          retentionDays: settings.retentionDays,
          firstSeenAt: entry.firstSeenAt,
        }).catch(() => {})
      }
    }
  } catch (error) {
    summary.errors += 1
    warn(ctx, `startup pass aborted: ${describe(error)}`)
  } finally {
    summary.finishedAt = Date.now()
    if (currentState !== null) {
      currentState.lastRun = summary
      await saveState(currentState).catch((error) => warn(ctx, `could not save last run: ${describe(error)}`))
    }
    passRunning = false
    await lock.release()
  }
}

/**
 * Bring the observation table in line with the durable archive set.
 * @returns ids that were observed before and whose artifact is now gone.
 */
async function reconcileArchives(ctx, state, archived) {
  const set = new Set(archived.filter(id => SESSION_ID_RE.test(id)))
  const now = Date.now()
  const gone = []
  for (const id of set) {
    const existing = state.archived[id]
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(id)
    } catch (error) {
      if (error?.name !== 'SessionPersistenceNotFoundError') {
        warn(ctx, `could not stat ${id}: ${describe(error)}`)
        continue
      }
      snapshot = undefined
    }
    if (snapshot !== undefined && snapshot !== null) {
      if (existing === undefined) state.archived[id] = { firstSeenAt: now, lastSeenAt: now }
      else existing.lastSeenAt = now
    } else if (existing !== undefined) {
      gone.push(id)
      delete state.archived[id]
    }
  }
  for (const id of Object.keys(state.archived)) {
    if (!set.has(id)) delete state.archived[id]
  }
  return gone
}

// --- archive tracking -------------------------------------------------------

/**
 * Track archive/unarchive transitions while the app is running, so a Session
 * archived early in a long-lived process still gets an accurate firstSeenAt.
 * @param ctx - host context.
 */
function installTracking(ctx) {
  let timer
  let chain = Promise.resolve()
  const onChange = (change) => {
    if (change === null || typeof change !== 'object') return
    if (change.domain !== 'workspace' || change.table !== '') return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      chain = chain.then(() => trackArchives(ctx)).catch((error) => warn(ctx, `archive tracking failed: ${describe(error)}`))
    }, 250)
    timer.unref?.()
  }
  ctx.effect(() => ctx.on('domain/changed', onChange), 'dss886-dsh-session-cleaner: tracking')
  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }, 'dss886-dsh-session-cleaner: tracking timer')
}

/**
 * Reconcile the observation table with the live archive set. This never
 * deletes anything; deletion is a startup-pass concern.
 */
async function trackArchives(ctx) {
  if (passRunning) return
  if (!stateLoaded || currentState === null) {
    const root = sessionsRoot(ctx.sessionPersistence)
    const loaded = await loadState(root)
    currentState = loaded.state
    stateLoaded = true
  }
  const state = currentState
  const archived = ctx.workspaceRegistry.archivedSessionIds
  const set = new Set(archived.filter(id => SESSION_ID_RE.test(id)))
  const now = Date.now()

  for (const id of set) {
    if (state.archived[id] !== undefined) {
      state.archived[id].lastSeenAt = now
      continue
    }
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(id)
    } catch {
      continue
    }
    if (snapshot !== undefined && snapshot !== null) {
      state.archived[id] = { firstSeenAt: now, lastSeenAt: now }
    }
  }
  for (const id of Object.keys(state.archived)) {
    if (!set.has(id)) delete state.archived[id]
  }
  await saveState(state)
}

// --- HTTP surface -----------------------------------------------------------

/**
 * @param ctx - host context.
 * @returns the settings route handler.
 */
function settingsHandler(ctx) {
  return async (req, res) => {
    const write = req.method === 'PUT' || req.method === 'POST'
    const rejection = rejectRequest(ctx, req, write)
    if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: 'unauthenticated request' })
    if (!write) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const settings = await loadSettings()
      return sendJson(res, 200, {
        ok: true,
        settings: { enabled: settings.enabled, retentionDays: settings.retentionDays },
        ...(settings.invalid ? { invalid: true } : {}),
      })
    }
    if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad json body' })
    }
    try {
      const saved = await saveSettings(body)
      return sendJson(res, 200, {
        ok: true,
        settings: { enabled: saved.enabled, retentionDays: saved.retentionDays },
      })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: describe(error) })
    }
  }
}

/**
 * @param ctx - host context.
 * @returns the status route handler.
 */
function statusHandler(ctx) {
  return async (req, res) => {
    const rejection = rejectRequest(ctx, req, false)
    if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: 'unauthenticated request' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

    try {
      // The route context is the webServer child, which does not necessarily
      // expose every host service as a property; `get` is the strict-safe read.
      const root = sessionsRoot(ctx.get('sessionPersistence'))
      const loaded = await loadState(root)
      const state = loaded.state.root === root ? loaded.state : freshState(root)
      const settings = await loadSettings()
      let archived = []
      try {
        const registry = ctx.get('workspaceRegistry')
        archived = registry === undefined || registry === null ? [] : [...registry.archivedSessionIds]
      } catch {
        /* registry not ready */
      }
      const set = new Set(archived)
      const now = Date.now()
      const tracked = Object.keys(state.archived).filter(id => set.has(id)).length
      const eligible = settings.enabled
        ? Object.entries(state.archived).filter(([id, entry]) =>
          set.has(id) && now - entry.firstSeenAt >= settings.retentionDays * DAY_MS).length
        : 0

      return sendJson(res, 200, {
        ok: true,
        settings: { enabled: settings.enabled, retentionDays: settings.retentionDays },
        ...(settings.invalid ? { invalid: true } : {}),
        tracked,
        eligible,
        pending: state.pending.length,
        lastRun: state.lastRun,
      })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: describe(error) })
    }
  }
}

/**
 * Reuse the Connection service's Host/Origin/cookie trust fence when present;
 * otherwise fail closed to loopback plus same-origin for writes.
 * @returns 401/403, or undefined when the request may proceed.
 */
function rejectRequest(ctx, req, write) {
  const connection = ctx.get('connection')
  if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      return 403
    }
  }

  const remote = req.socket?.remoteAddress
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return 403
  if (write && (req.headers.forwarded !== undefined || req.headers['x-forwarded-for'] !== undefined)) return 403
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined) {
    try {
      if (host === undefined || new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * Read a bounded request body as UTF-8.
 * @param req - HTTP request.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    let size = 0
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      text += chunk
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

/**
 * @param res - HTTP response.
 * @param status - HTTP status.
 * @param body - JSON body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Diagnostics must never break the operation. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`session-cleaner: ${message}`)
  } catch {
    /* diagnostics only */
  }
}

/** @param error - unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

// Exported for tests and diagnostics.
export const helpers = {
  boot,
  reconcileArchives,
  trackArchives,
  rejectRequest,
  readBody,
  settingsHandler,
  statusHandler,
  RETENTION_OPTIONS,
  paths: filePaths,
  sessionsRoot,
}
