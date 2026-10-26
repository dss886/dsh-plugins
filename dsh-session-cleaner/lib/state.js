/**
 * Durable observation state.
 *
 * `archived` is keyed by the archived root Session id and records when this
 * plugin first observed the archive (`firstSeenAt`). Harness archives carry no
 * timestamp, so this is the only defensible clock. A lost or corrupt document
 * restarts every clock at "now": the failure direction is always "delete
 * later", never "delete early".
 *
 * `pending` is an idempotency journal, not a user-facing recycle bin. It
 * records a deletion that started so the next boot can finish it after a
 * crash.
 */
import { filePaths } from './paths.js'
import { backupCorrupt, readJson, writeJsonAtomic } from './atomic.js'

/** State document version. */
export const STATE_VERSION = 1

/**
 * @param root - resolved sessions root this state belongs to.
 * @returns an empty state document.
 */
export function freshState(root) {
  return {
    version: STATE_VERSION,
    root,
    updatedAt: Date.now(),
    archived: {},
    pending: [],
    lastRun: null,
  }
}

/**
 * Load and validate the state document.
 * @param root - resolved sessions root.
 * @returns `{ state, missing, corrupt, backup? }`; a corrupt document yields a
 * fresh state with no eligible entries.
 */
export async function loadState(root) {
  const { state: file } = filePaths()
  const result = await readJson(file)
  if (result.missing) return { state: freshState(root), missing: true, corrupt: false }
  if (result.corrupt || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    const backup = await backupCorrupt(file)
    return { state: freshState(root), missing: false, corrupt: true, backup }
  }
  const raw = result.value
  if (raw.version !== STATE_VERSION || typeof raw.root !== 'string') {
    const backup = await backupCorrupt(file)
    return { state: freshState(root), missing: false, corrupt: true, backup }
  }
  const state = freshState(root)
  state.root = raw.root
  state.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()

  if (raw.archived !== null && typeof raw.archived === 'object' && !Array.isArray(raw.archived)) {
    for (const [id, entry] of Object.entries(raw.archived)) {
      if (typeof id !== 'string' || entry === null || typeof entry !== 'object') continue
      const firstSeenAt = Number(entry.firstSeenAt)
      if (!Number.isFinite(firstSeenAt)) continue
      const lastSeenAt = Number(entry.lastSeenAt)
      state.archived[id] = {
        firstSeenAt,
        lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : firstSeenAt,
      }
    }
  }

  if (Array.isArray(raw.pending)) {
    for (const entry of raw.pending) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.rootId !== 'string' || !Array.isArray(entry.ids)) continue
      const ids = entry.ids.filter(id => typeof id === 'string' && id.length > 0)
      if (ids.length === 0) continue
      state.pending.push({
        rootId: entry.rootId,
        ids,
        startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : Date.now(),
      })
    }
  }

  state.lastRun = raw.lastRun !== null && typeof raw.lastRun === 'object' ? raw.lastRun : null
  return { state, missing: false, corrupt: false }
}

/**
 * Persist the state document atomically.
 * @param state - state to write; `updatedAt` is refreshed.
 */
export async function saveState(state) {
  state.updatedAt = Date.now()
  await writeJsonAtomic(filePaths().state, state)
}
