// @dss886/dsh-usage — host half.
//
// Two data sources, one route, and neither needs a platform login token:
//   1. Balance — the official `GET https://api.deepseek.com/user/balance`,
//      authenticated by the harness's own DeepSeek API key credential. Always
//      available, no session state to expire.
//   2. Token usage — replayed once from the harness's durable session logs and
//      metered live from the `assistant/message` usage the agent loop commits
//      for every model call, accumulated per local day into a small JSON file
//      under the harness home.

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dss886-dsh-usage'
export const inject = ['webServer', 'credentials', 'timer']

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const API_KEY_REF = 'DEEPSEEK_API_KEY'

const STATE_VERSION = 2
const KEEP_DAYS = 92
const BALANCE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const FLUSH_DEBOUNCE_MS = 2_000
const MAX_LOG_BYTES = 64 * 1024 * 1024

/**
 * Official DeepSeek prices in CNY (元) per 1M tokens, transcribed from the
 * Chinese pricing page https://api-docs.deepseek.com/zh-cn/quick_start/pricing.
 *
 * Every rate is quoted in CNY natively, so no exchange-rate assumption takes
 * part in the estimate — the balance API quotes CNY too. Cache-hit input is
 * priced separately from cache-miss input, and off-peak is exactly half of
 * peak.
 */
const PRICES = {
  'deepseek-flash': { hit: { off: 0.02, peak: 0.04 }, miss: { off: 1, peak: 2 }, out: { off: 4, peak: 8 } },
  'deepseek-v4-pro': { hit: { off: 0.15, peak: 0.3 }, miss: { off: 4.5, peak: 9 }, out: { off: 13.5, peak: 27 } },
}

/** A total balance at or below this amount is surfaced as a warning by the card. */
const LOW_BALANCE_THRESHOLD = 10

/** Route namespace shared with `client.js` — keep the two files in step. */
const ROUTE_USAGE = '/dss886-dsh-usage/api/usage'

/**
 * Absolute paths of the meter state files, most current first.
 *
 * The first entry is the file this version writes; the rest are pre-rename
 * names. The first readable one is migrated forward, so renaming the package
 * never resets counters that only grow.
 *
 * @returns the candidate state paths, current name first.
 */
function statePaths() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  const names = [
    'dss886-dsh-usage-meter.json',
    'dss886-usage-meter.json',
    'dsh-usage-meter.json',
    'usage-meter.json',
  ]
  return names.map((name) => join(home, 'storages', name))
}

/**
 * Peak window for the public price table: 01:00–04:00 and 06:00–10:00 UTC on
 * Beijing time (UTC+8) on weekdays, which the Chinese pricing page states as
 * 09:00–12:00 and 14:00–18:00. Chinese public holidays are excluded from peak
 * in that table and are NOT modelled here — the estimate is an upper bound on
 * those days.
 */
function isPeak(time) {
  const beijing = new Date(time + 8 * 3_600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function priceId(model) {
  if (typeof model !== 'string' || model === '') return 'deepseek-flash'
  if (PRICES[model] !== undefined) return model
  if (model.includes('pro')) return 'deepseek-v4-pro'
  return 'deepseek-flash'
}

/**
 * Estimated CNY cost of one usage bucket at its recorded peak/off-peak split.
 * @param bucket - a day or model bucket of disjoint token counters
 * @param model - the model whose price row applies
 * @returns estimated spend in 元
 */
function estimateCostCny(bucket, model) {
  const table = PRICES[priceId(model)]
  const tokens = {
    hit: { off: bucket.hitOff ?? 0, peak: bucket.hitPeak ?? 0 },
    miss: { off: bucket.missOff ?? 0, peak: bucket.missPeak ?? 0 },
    out: { off: bucket.outOff ?? 0, peak: bucket.outPeak ?? 0 },
  }
  let cny = 0
  for (const kind of ['hit', 'miss', 'out']) {
    cny += (tokens[kind].off * table[kind].off + tokens[kind].peak * table[kind].peak) / 1_000_000
  }
  return cny
}

function dayKey(time) {
  const d = new Date(time)
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function monthKey(time) {
  return dayKey(time).slice(0, 7)
}

function emptyBucket() {
  return {
    hitOff: 0, hitPeak: 0,
    missOff: 0, missPeak: 0,
    outOff: 0, outPeak: 0,
    calls: 0,
    models: {},
  }
}

function emptyState() {
  return { version: STATE_VERSION, startedAt: Date.now(), days: {}, seen: [], logs: {} }
}

function prune(state, now) {
  const cutoff = dayKey(now - KEEP_DAYS * 86_400_000)
  for (const key of Object.keys(state.days)) {
    if (key < cutoff) delete state.days[key]
  }
  return state
}

function normalizeBucket(raw) {
  const bucket = emptyBucket()
  if (raw === null || typeof raw !== 'object') return bucket
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  // v1 stored disjoint `i` / `c` / `o` only; carry those forward as off-peak.
  bucket.hitOff = num(raw.hitOff ?? raw.c)
  bucket.hitPeak = num(raw.hitPeak)
  bucket.missOff = num(raw.missOff ?? raw.i)
  bucket.missPeak = num(raw.missPeak)
  bucket.outOff = num(raw.outOff ?? raw.o)
  bucket.outPeak = num(raw.outPeak)
  bucket.calls = num(raw.calls)
  if (raw.models !== null && typeof raw.models === 'object') {
    for (const [model, entry] of Object.entries(raw.models)) {
      if (entry === null || typeof entry !== 'object') continue
      bucket.models[model] = Object.assign(emptyBucket(), {
        hitOff: num(entry.hitOff), hitPeak: num(entry.hitPeak),
        missOff: num(entry.missOff), missPeak: num(entry.missPeak),
        outOff: num(entry.outOff), outPeak: num(entry.outPeak),
        calls: num(entry.calls),
        models: {},
      })
    }
  }
  return bucket
}

function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object') return emptyState()
  const state = emptyState()
  state.startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : Date.now()
  if (raw.days !== null && typeof raw.days === 'object') {
    for (const [key, value] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      state.days[key] = normalizeBucket(value)
    }
  }
  state.seen = Array.isArray(raw.seen) ? raw.seen.filter((s) => typeof s === 'string').slice(-512) : []
  if (raw.logs !== null && typeof raw.logs === 'object') {
    for (const [key, value] of Object.entries(raw.logs)) {
      if (typeof value === 'number' && Number.isFinite(value)) state.logs[key] = value
    }
  }
  return state
}

const BUCKET_FIELDS = ['hitOff', 'hitPeak', 'missOff', 'missPeak', 'outOff', 'outPeak', 'calls']

function mergeBucket(target, incoming) {
  for (const field of BUCKET_FIELDS) target[field] = Math.max(target[field], incoming[field])
  for (const [model, entry] of Object.entries(incoming.models)) {
    if (target.models[model] === undefined) target.models[model] = entry
    else mergeBucket(target.models[model], entry)
  }
}

/**
 * Fold a state file (or the replayed durable-log baseline) into the live
 * in-memory state.
 *
 * Loading is asynchronous, so committed `assistant/message` records can land
 * before it resolves. Assigning the parsed state over the live object would
 * silently drop exactly those records; every counter therefore keeps the
 * larger value (both sides only ever grow) and `seen` is unioned.
 */
function mergeState(target, loaded) {
  if (loaded.startedAt < target.startedAt) target.startedAt = loaded.startedAt
  for (const [key, bucket] of Object.entries(loaded.days)) {
    if (target.days[key] === undefined) target.days[key] = bucket
    else mergeBucket(target.days[key], bucket)
  }
  for (const [key, size] of Object.entries(loaded.logs)) {
    target.logs[key] = Math.max(target.logs[key] ?? 0, size)
  }
  const seen = new Set(target.seen)
  for (const id of loaded.seen) seen.add(id)
  target.seen = [...seen].slice(-512)
  return target
}

function bucketFor(state, time) {
  const key = dayKey(time)
  let bucket = state.days[key]
  if (bucket === undefined) {
    bucket = emptyBucket()
    state.days[key] = bucket
  }
  return bucket
}

/** Fold one usage record into its local day plus the bucket of the calling model. */
function addUsage(state, time, usage, model) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return false
  const peak = isPeak(time)
  const bucket = bucketFor(state, time)
  const apply = (target) => {
    if (peak) {
      target.hitPeak += cacheRead
      target.missPeak += input + cacheWrite
      target.outPeak += output
    } else {
      target.hitOff += cacheRead
      target.missOff += input + cacheWrite
      target.outOff += output
    }
    target.calls += 1
  }
  apply(bucket)
  const key = (model === undefined || model === null || model === '') ? 'unknown' : String(model)
  if (bucket.models[key] === undefined) bucket.models[key] = emptyBucket()
  apply(bucket.models[key])
  return true
}

/** Fold one committed `assistant/message` usage into its local day, once. */
function record(state, sessionId, seq, time, usage, model) {
  if (usage === null || typeof usage !== 'object') return false
  const id = sessionId + ':' + seq
  if (state.seen.includes(id)) return false
  if (!addUsage(state, time, usage, model)) return false
  state.seen.push(id)
  if (state.seen.length > 512) state.seen.splice(0, state.seen.length - 512)
  return true
}

function bucketTokens(bucket) {
  return (bucket.hitOff + bucket.hitPeak) + (bucket.missOff + bucket.missPeak) + (bucket.outOff + bucket.outPeak)
}

function cacheRateOf(bucket) {
  const input = (bucket.hitOff + bucket.hitPeak) + (bucket.missOff + bucket.missPeak)
  return input > 0 ? (bucket.hitOff + bucket.hitPeak) / input : null
}

function emptyTotal() {
  return { hitOff: 0, hitPeak: 0, missOff: 0, missPeak: 0, outOff: 0, outPeak: 0, calls: 0, days: 0, models: {} }
}

function sumDays(state, prefix) {
  const total = emptyTotal()
  for (const [key, bucket] of Object.entries(state.days)) {
    if (!key.startsWith(prefix)) continue
    for (const field of BUCKET_FIELDS) total[field] += bucket[field]
    total.days += 1
    for (const [model, entry] of Object.entries(bucket.models)) {
      if (total.models[model] === undefined) total.models[model] = emptyBucket()
      for (const field of BUCKET_FIELDS) total.models[model][field] += entry[field]
    }
  }
  return total
}

function breakdownOf(total) {
  const models = Object.entries(total.models)
    .map(([model, bucket]) => ({
      model,
      tokens: bucketTokens(bucket),
      cacheRate: cacheRateOf(bucket),
      calls: bucket.calls,
      costCny: estimateCostCny(bucket, model),
    }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  return models
}

/** Rolling window totals over the most recent `days` local days. */
function recentWindow(state, now, days) {
  const total = emptyTotal()
  for (let i = 0; i < days; i += 1) {
    const bucket = state.days[dayKey(now - i * 86_400_000)]
    if (bucket === undefined) continue
    for (const field of BUCKET_FIELDS) total[field] += bucket[field]
    for (const [model, entry] of Object.entries(bucket.models)) {
      if (total.models[model] === undefined) total.models[model] = emptyBucket()
      for (const field of BUCKET_FIELDS) total.models[model][field] += entry[field]
    }
  }
  return { tokens: bucketTokens(total), costCny: estimateCostCny(total, 'deepseek-flash') }
}

function windowSummary(state, now) {
  const todayBucket = state.days[dayKey(now)] ?? emptyBucket()
  const monthTotal = sumDays(state, monthKey(now))
  const today = bucketTokens(todayBucket)
  const monthTokens = bucketTokens(monthTotal)
  const week = recentWindow(state, now, 7)
  return {
    today,
    month: monthTokens,
    todayCacheHit: todayBucket.hitOff + todayBucket.hitPeak,
    todayCacheMiss: todayBucket.missOff + todayBucket.missPeak,
    todayOutput: todayBucket.outOff + todayBucket.outPeak,
    monthCacheHit: monthTotal.hitOff + monthTotal.hitPeak,
    monthCacheMiss: monthTotal.missOff + monthTotal.missPeak,
    monthOutput: monthTotal.outOff + monthTotal.outPeak,
    todayCacheRate: cacheRateOf(todayBucket),
    monthCacheRate: cacheRateOf(monthTotal),
    callsToday: todayBucket.calls,
    callsMonth: monthTotal.calls,
    activeDays: monthTotal.days,
    dailyAverage: monthTotal.days > 0 ? Math.round(monthTokens / monthTotal.days) : 0,
    weekTokens: week.tokens,
    weekDailyAverage: Math.round(week.tokens / 7),
    weekCostCny: week.costCny,
    dailyBurnCny: week.costCny / 7,
    // Money is CNY end to end: the price table and the balance API both quote
    // 元, so no exchange rate takes part anywhere in this snapshot.
    todayCostCny: estimateCostCny(todayBucket, 'deepseek-flash'),
    monthCostCny: estimateCostCny(monthTotal, 'deepseek-flash'),
    models: breakdownOf(monthTotal),
    recentDays: Object.entries(state.days)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 7)
      .map(([date, bucket]) => ({ date, tokens: bucketTokens(bucket), costCny: estimateCostCny(bucket, 'deepseek-flash') })),
    meteredSince: state.startedAt,
  }
}

/**
 * Estimated days of balance left at the last-7-days burn rate.
 *
 * @param balanceTotal - balance amount as the balance endpoint reported it (CNY)
 * @param weekCostCny - estimated 7-day spend already converted to CNY
 * @returns days of runway, or null while either input is unusable
 */
function runwayOf(balanceTotal, weekCostCny) {
  const balance = Number(balanceTotal)
  const cost = Number(weekCostCny)
  if (!Number.isFinite(balance) || balance <= 0) return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  return balance / (cost / 7)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a concatenated-zstd file to UTF-8 text.
 *
 * Durable session logs are appended one frame at a time, and Node's
 * `zstdDecompressSync` stops after the first frame, so frames are located by
 * magic and decoded one at a time. A trailing torn frame (the writer is still
 * appending) is dropped rather than failing the whole read.
 */
function decodeZstdFrames(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[i], end)))
    } catch {
      // Torn trailing frame: keep every frame decoded so far.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function isLoopback(req) {
  const address = req.socket ? req.socket.remoteAddress : undefined
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers ? req.headers.host : undefined
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '::1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function fetchJson(url, headers, timeoutMs) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body, text }
}

export function apply(ctx) {
  let state = emptyState()
  let pending = emptyState()
  let loaded = false
  let loadStarted = false
  let loadPromise = null
  let dirty = false
  let flushTimer = null
  let balanceCache = { at: 0, value: null }

  const files = statePaths()
  const file = files[0]

  function resetCaches() {
    balanceCache = { at: 0, value: null }
  }

  // The persisted state file is the only thing here that needs I/O, so it is
  // read on the FIRST request instead of at mount. Events that arrive before
  // that read resolves accumulate in `pending` and are folded into the loaded
  // state, so no committed usage is ever lost to the read window.
  async function ensureLoaded() {
    if (loaded) return
    await readState()
  }

  function readState() {
    if (loadStarted) return loadPromise
    loadStarted = true
    loadPromise = (async () => {
      let stored = emptyState()
      for (const candidate of files) {
        try {
          stored = prune(normalizeState(JSON.parse(await readFile(candidate, 'utf8'))), Date.now())
          break
        } catch {
          // Missing, or an unreadable/corrupt file: try the next name, so a
          // rename never resets counters that only grow.
        }
      }
      state = mergeState(stored, pending)
      pending = emptyState()
      // Replay the durable session logs once, so "this month" includes usage
      // from before the plugin (or this process) started.
      const baseline = await backfillLogs(state)
      if (baseline !== null) {
        mergeState(state, baseline)
        state.logs = Object.assign({}, state.logs, baseline.logs)
        dirty = true
      }
      loaded = true
    })()
    return loadPromise
  }

  /**
   * Replay `assistant/message` usage out of the harness's own durable session
   * logs, one pass per log file and never twice.
   *
   * Each log is a stream of independent zstd frames, so the frames are located
   * by magic and decoded individually (Node's sync decoder stops after the
   * first). File size is the processed marker: a log that grew is re-read, and
   * replayed records are dropped by the same `session:seq` dedupe as live ones.
   *
   * @returns the baseline state, or null when nothing new was read.
   */
  async function backfillLogs(target) {
    const root = join(dirname(dirname(file)), 'sessions')
    let scopes
    try {
      scopes = await readdir(root, { withFileTypes: true })
    } catch {
      return null
    }
    const baseline = emptyState()
    baseline.startedAt = target.startedAt
    let touched = false
    for (const scope of scopes) {
      if (!scope.isDirectory()) continue
      let sessions
      try {
        sessions = await readdir(join(root, scope.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const log = join(root, scope.name, session.name, 'session.v3.jsonl.zstd')
        let info
        try {
          info = await stat(log)
        } catch {
          continue
        }
        if (info.size === 0 || info.size > MAX_LOG_BYTES) continue
        const key = scope.name + '/' + session.name
        if ((target.logs[key] ?? -1) === info.size) continue
        let text
        try {
          text = decodeZstdFrames(await readFile(log))
        } catch {
          continue
        }
        let records = 0
        for (const line of text.split('\n')) {
          if (line === '') continue
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.type !== 'assistant/message' || event.data === null || typeof event.data !== 'object') continue
          const usage = event.data.usage
          if (usage === null || typeof usage !== 'object') continue
          const source = event.data.message !== null && typeof event.data.message === 'object' ? event.data.message.source : undefined
          const model = source !== null && typeof source === 'object' ? source.model : undefined
          const time = typeof event.time === 'number' ? event.time : Date.now()
          const seq = typeof event.seq === 'number' ? event.seq : records
          if (record(baseline, session.name + '@log', seq, time, usage, model)) records += 1
        }
        baseline.logs[key] = info.size
        touched = true
      }
    }
    if (!touched) return null
    prune(baseline, Date.now())
    return baseline
  }

  async function flush() {
    // Never persist the pre-load `emptyState()`: a `session/event` can dirty the
    // meter before the first request runs `ensureLoaded()`, and a flush in that
    // window would overwrite the on-disk counters with zeros.
    if (!loaded || !dirty) return
    dirty = false
    try {
      await mkdir(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await writeFile(tmp, JSON.stringify(state), 'utf8')
      await rename(tmp, file)
    } catch (error) {
      ctx.logger?.warn?.('dss886-dsh-usage: could not persist usage meter: ' + String(error))
    }
  }

  function scheduleFlush() {
    dirty = true
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
    flushTimer.unref?.()
  }

  // ---- credential resolution ----
  async function resolveApiKey() {
    try {
      const credential = await ctx.credentials.resolve(API_KEY_REF)
      const value = credential && typeof credential.value === 'string' ? credential.value.trim() : ''
      return value === '' ? null : value
    } catch {
      return null
    }
  }

  async function describeApiKey() {
    try {
      const info = await ctx.credentials.describe(API_KEY_REF)
      return { configured: info.configured === true, source: info.source ?? null }
    } catch {
      return { configured: false, source: null }
    }
  }

  // ---- balance (official, API-key authenticated) ----
  async function balance(force) {
    const now = Date.now()
    if (!force && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value
    const apiKey = await resolveApiKey()
    if (apiKey === null) {
      const value = { status: 'missing-key', configured: false }
      balanceCache = { at: now, value }
      return value
    }
    try {
      const { status, body } = await fetchJson(BALANCE_URL, { authorization: 'Bearer ' + apiKey }, REQUEST_TIMEOUT_MS)
      if (status === 401 || status === 403) {
        const value = { status: 'invalid-key', configured: true }
        balanceCache = { at: now, value }
        return value
      }
      if (status !== 200 || body === null || typeof body !== 'object' || !Array.isArray(body.balance_infos)) {
        return { status: 'error', configured: true, httpStatus: status }
      }
      const info = body.balance_infos[0]
      const value = {
        status: 'ok',
        configured: true,
        available: body.is_available === true,
        currency: info && info.currency ? info.currency : 'CNY',
        total: info && info.total_balance !== undefined ? info.total_balance : null,
        granted: info && info.granted_balance !== undefined ? info.granted_balance : null,
        toppedUp: info && info.topped_up_balance !== undefined ? info.topped_up_balance : null,
      }
      balanceCache = { at: now, value }
      return value
    } catch (error) {
      return { status: 'unreachable', configured: true, message: String(error && error.message ? error.message : error) }
    }
  }

  async function snapshot(force) {
    await ensureLoaded()
    const now = Date.now()
    prune(state, now)
    const balanceValue = await balance(force)
    const local = windowSummary(state, now)
    const keyInfo = await describeApiKey()
    local.runwayDays = runwayOf(balanceValue.total, local.weekCostCny)
    local.runwayBasisTokens = local.weekTokens
    const balanceTotal = Number(balanceValue.total)
    balanceValue.low = Number.isFinite(balanceTotal) && balanceTotal < LOW_BALANCE_THRESHOLD
    balanceValue.lowThreshold = LOW_BALANCE_THRESHOLD
    return {
      ok: true,
      now,
      source: 'harness',
      usage: local,
      balance: balanceValue,
      apiKey: keyInfo,
      since: state.startedAt,
    }
  }

  async function handleUsage(req, res) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const url = new URL(req.url ?? ROUTE_USAGE, 'http://127.0.0.1')
      const force = url.searchParams.get('force') === '1'
      sendJson(res, 200, await snapshot(force))
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  const onSessionEvent = (session, event) => {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return
    if (event.data === null || typeof event.data !== 'object') return
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const sessionId = session && session.id !== undefined ? String(session.id) : 'unknown'
    const source = event.data.message !== null && typeof event.data.message === 'object' ? event.data.message.source : undefined
    const model = source !== null && typeof source === 'object' ? source.model : undefined
    // Before the state file resolves, meter into `pending`; it is folded into
    // the loaded state and never assigned over.
    const target = loaded ? state : pending
    if (record(target, sessionId, event.seq, time, event.data.usage, model)) scheduleFlush()
  }

  const onSettings = () => {
    resetCaches()
  }

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', onSessionEvent)
    const offCredentials = ctx.on('credentials/reference-updated', onSettings)
    const offSetting = ctx.on('settings/updated', onSettings)
    const offInterval = ctx.interval(() => {
      if (loaded) prune(state, Date.now())
      void flush()
    }, 60_000)
    return () => {
      offEvent()
      offCredentials()
      offSetting()
      offInterval()
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      void flush()
    }
  }, 'dss886-dsh-usage: meter')

  ctx.effect(() => {
    return ctx.webServer.register({ kind: 'exact', path: ROUTE_USAGE, handler: handleUsage })
  }, 'dss886-dsh-usage: routes')
}

export const routes = { usage: ROUTE_USAGE }
export const helpers = {
  dayKey,
  monthKey,
  normalizeState,
  mergeState,
  record,
  windowSummary,
  estimateCostCny,
  runwayOf,
  isPeak,
  decodeZstdFrames,
  PRICES,
}
