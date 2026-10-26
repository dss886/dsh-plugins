import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { normalizeSettings, saveSettings } from '../lib/settings.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT_ID = 'session-11111111-1111-4111-8111-111111111111'
const CHILD_ID = '22222222-2222-4222-8222-222222222222'
const GRANDCHILD_ID = '33333333-3333-4333-8333-333333333333'
const FORK_ID = 'session-44444444-4444-4444-8444-444444444444'
const DAY = 24 * 60 * 60 * 1000

/**
 * Build a DSH_HOME and a fake host context.
 * @param options.live - session ids whose write probe must fail.
 * @param options.archived - ids currently in the archive set.
 * @param options.headers - stored headers.
 * @param options.state - state document to preload.
 */
function setup({ live = [], archived = [ROOT_ID], headers, state, unmaterialized = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cleaner-'))
  const root = join(home, 'sessions')
  process.env.DSH_HOME = home
  const storages = join(home, 'storages')
  mkdirSync(storages, { recursive: true })

  const storedHeaders = headers ?? [
    { id: ROOT_ID, cwd: '/tmp/project', createdAt: 1 },
    { id: CHILD_ID, cwd: '/tmp/project', createdAt: 2, origin: 'subagent', parentSession: ROOT_ID },
    { id: GRANDCHILD_ID, cwd: '/tmp/project', createdAt: 3, origin: 'subagent', parentSession: CHILD_ID },
    { id: FORK_ID, cwd: '/tmp/project', createdAt: 4, parentSession: ROOT_ID, isSeeded: true },
  ]

  const project = join(root, '--tmp-project--')
  const locations = new Map()
  for (const header of storedHeaders) {
    const dir = join(project, header.id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, 'x')
    locations.set(header.id, { kind: 'jsonl', path: file })
  }

  const snapshots = storedHeaders.map(header => ({
    header,
    location: locations.get(header.id),
  }))

  const archivedSet = new Set(archived)
  const workspace = {
    sessionIds: [ROOT_ID],
    async detachSession(id) {
      this.sessionIds = this.sessionIds.filter(value => value !== id)
    },
  }
  const cacheRows = new Set([ROOT_ID, CHILD_ID, GRANDCHILD_ID, FORK_ID])
  const emitted = []
  const warnings = []

  const persistence = {
    config: { root },
    async list() {
      return snapshots.filter(snapshot => existsSync(snapshot.location.path))
    },
    async stat(id) {
      const snapshot = snapshots.find(value => value.header.id === id)
      if (snapshot === undefined || !existsSync(snapshot.location.path)) return undefined
      if (unmaterialized.includes(id)) return { header: snapshot.header }
      return snapshot
    },
    async open(id) {
      if (live.includes(id)) {
        const error = new Error('owned')
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      const snapshot = snapshots.find(value => value.header.id === id)
      if (snapshot === undefined || !existsSync(snapshot.location.path)) {
        const error = new Error('missing')
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      }
      return { close: async () => {} }
    },
  }

  const registry = {
    get archivedSessionIds() {
      return [...archivedSet]
    },
    list() {
      return [workspace]
    },
    async unarchiveSession(id) {
      archivedSet.delete(id)
    },
    async unpinSession() {},
  }

  const storageDomain = {
    get(name) {
      if (name !== 'session_projcache') return undefined
      return {
        table() {
          return {
            async delete(id) {
              return cacheRows.delete(id)
            },
          }
        },
      }
    },
  }

  const ctx = {
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    get(name) {
      if (name === 'storageDomain') return storageDomain
      return undefined
    },
    emit(event, id) {
      emitted.push([event, id])
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
  }

  if (state !== undefined) {
    writeFileSync(join(storages, 'dss886-dsh-session-cleaner-state.json'), JSON.stringify(state))
  }
  writeFileSync(
    join(storages, 'dss886-dsh-session-cleaner-settings.json'),
    JSON.stringify({ enabled: true, retentionDays: 30 }),
  )

  return { home, root, project, ctx, snapshots, archivedSet, workspace, cacheRows, emitted, warnings, locations }
}

async function loadHelpers() {
  const module = await import(pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href)
  return module.helpers
}

/** @param ids - expected-removed ids. */
function assertRemoved(setupResult, ids) {
  for (const id of ids) {
    assert.equal(existsSync(setupResult.locations.get(id).path), false, `${id} log should be gone`)
    assert.equal(setupResult.cacheRows.has(id), false, `${id} cache row should be gone`)
  }
}

test('settings accept only 7, 14 or 30 days', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cleaner-settings-'))
  process.env.DSH_HOME = home
  await assert.rejects(() => saveSettings({ enabled: true, retentionDays: 10 }))
  const saved = await saveSettings({ enabled: true, retentionDays: 14 })
  assert.equal(saved.retentionDays, 14)
  const off = await saveSettings({ enabled: false, retentionDays: 14 })
  assert.equal(off.enabled, false)
  assert.equal(normalizeSettings({ enabled: true, retentionDays: 10 }).retentionDays, 30)
  rmSync(home, { recursive: true, force: true })
})

test('deletes an eligible archived tree, including nested subagents, but not forks', async () => {
  const setupResult = setup({
    state: {
      version: 1,
      root: '',
      archived: { [ROOT_ID]: { firstSeenAt: Date.now() - 31 * DAY, lastSeenAt: Date.now() } },
      pending: [],
      lastRun: null,
    },
  })
  setupResult.snapshots // keep reference
  // The state root is filled after the root is known.
  const stateFile = join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.root = setupResult.root
  writeFileSync(stateFile, JSON.stringify(state))

  const helpers = await loadHelpers()
  await helpers.boot(setupResult.ctx)

  assertRemoved(setupResult, [ROOT_ID, CHILD_ID, GRANDCHILD_ID])
  assert.equal(existsSync(setupResult.locations.get(FORK_ID).path), true, 'fork must survive')
  assert.deepEqual(setupResult.workspace.sessionIds, [], 'root accounting should be detached')
  assert.equal(setupResult.archivedSet.has(ROOT_ID), false, 'root should be unarchived')
  assert.equal(setupResult.emitted.some(([event, id]) => event === 'api-session/removed' && id === ROOT_ID), true)

  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved.archived[ROOT_ID], undefined)
  assert.equal(saved.pending.length, 0)
  assert.equal(saved.lastRun.deleted, 3)
  const audit = readFileSync(join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-audit.jsonl'), 'utf8')
  assert.match(audit, /"reason":"retention"/)

  rmSync(setupResult.home, { recursive: true, force: true })
})

test('skips the whole tree when any member is still write-owned', async () => {
  const setupResult = setup({
    live: [CHILD_ID],
    state: {
      version: 1,
      root: '',
      archived: { [ROOT_ID]: { firstSeenAt: Date.now() - 31 * DAY, lastSeenAt: Date.now() } },
      pending: [],
      lastRun: null,
    },
  })
  const stateFile = join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.root = setupResult.root
  writeFileSync(stateFile, JSON.stringify(state))

  const helpers = await loadHelpers()
  await helpers.boot(setupResult.ctx)

  for (const id of [ROOT_ID, CHILD_ID, GRANDCHILD_ID]) {
    assert.equal(existsSync(setupResult.locations.get(id).path), true, `${id} should survive`)
  }
  assert.equal(setupResult.archivedSet.has(ROOT_ID), true, 'root stays archived')
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved.archived[ROOT_ID] !== undefined, true)
  assert.equal(saved.pending.length, 0)

  rmSync(setupResult.home, { recursive: true, force: true })
})

test('first run only records firstSeen and deletes nothing', async () => {
  const setupResult = setup()
  const helpers = await loadHelpers()
  await helpers.boot(setupResult.ctx)

  for (const id of [ROOT_ID, CHILD_ID, GRANDCHILD_ID, FORK_ID]) {
    assert.equal(existsSync(setupResult.locations.get(id).path), true, `${id} should survive`)
  }
  const stateFile = join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-state.json')
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(typeof saved.archived[ROOT_ID].firstSeenAt, 'number')
  assert.equal(saved.lastRun.deleted, 0)

  rmSync(setupResult.home, { recursive: true, force: true })
})

test('an unarchived session is dropped from tracking and never deleted', async () => {
  const setupResult = setup({
    archived: [],
    state: {
      version: 1,
      root: '',
      archived: { [ROOT_ID]: { firstSeenAt: Date.now() - 31 * DAY, lastSeenAt: Date.now() } },
      pending: [],
      lastRun: null,
    },
  })
  const stateFile = join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.root = setupResult.root
  writeFileSync(stateFile, JSON.stringify(state))

  const helpers = await loadHelpers()
  await helpers.boot(setupResult.ctx)

  assert.equal(existsSync(setupResult.locations.get(ROOT_ID).path), true)
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved.archived[ROOT_ID], undefined)

  rmSync(setupResult.home, { recursive: true, force: true })
})

test('a pending session without a location is skipped, never half-cleaned', async () => {
  const setupResult = setup({
    unmaterialized: [ROOT_ID],
    state: {
      version: 1,
      root: '',
      archived: { [ROOT_ID]: { firstSeenAt: Date.now() - 31 * DAY, lastSeenAt: Date.now() } },
      pending: [],
      lastRun: null,
    },
  })
  const stateFile = join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.root = setupResult.root
  writeFileSync(stateFile, JSON.stringify(state))

  const helpers = await loadHelpers()
  await helpers.boot(setupResult.ctx)

  assert.equal(existsSync(setupResult.locations.get(ROOT_ID).path), true)
  assert.deepEqual(setupResult.workspace.sessionIds, [ROOT_ID])
  assert.equal(setupResult.archivedSet.has(ROOT_ID), true)
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved.archived[ROOT_ID] !== undefined, true)
  assert.equal(saved.lastRun.skipped, 1)

  rmSync(setupResult.home, { recursive: true, force: true })
})

test('finishes a pending journal from a previous crash', async () => {
  const setupResult = setup({
    state: {
      version: 1,
      root: '',
      archived: { [ROOT_ID]: { firstSeenAt: Date.now(), lastSeenAt: Date.now() } },
      pending: [{ rootId: ROOT_ID, ids: [ROOT_ID, CHILD_ID], startedAt: Date.now() }],
      lastRun: null,
    },
  })
  const stateFile = join(setupResult.home, 'storages', 'dss886-dsh-session-cleaner-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.root = setupResult.root
  writeFileSync(stateFile, JSON.stringify(state))

  const helpers = await loadHelpers()
  await helpers.boot(setupResult.ctx)

  assertRemoved(setupResult, [ROOT_ID, CHILD_ID])
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved.pending.length, 0)

  rmSync(setupResult.home, { recursive: true, force: true })
})
