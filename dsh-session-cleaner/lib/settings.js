/**
 * The plugin's one preference: whether automatic deletion is enabled and how
 * many days an archive must be observed before it becomes eligible.
 *
 * A corrupt or invalid document disables deletion (fail safe: never delete on
 * a value we cannot understand) instead of falling back to the default.
 */
import { filePaths } from './paths.js'
import { backupCorrupt, readJson, writeJsonAtomic } from './atomic.js'

/** The only retention values the settings surface offers. */
export const RETENTION_OPTIONS = Object.freeze([7, 14, 30])
/** Retention used when the document is missing or carries an unknown value. */
export const DEFAULT_RETENTION_DAYS = 30

/** Settings used when no document exists yet. */
export function defaultSettings() {
  return { enabled: true, retentionDays: DEFAULT_RETENTION_DAYS }
}

/**
 * Normalize a stored value. A malformed document disables deletion; a
 * syntactically valid document with an out-of-set day count falls back to the
 * default so a legacy value cannot silently select an option the UI cannot
 * show.
 * @param raw - parsed document, if any.
 * @returns effective settings; `invalid` is set when the document cannot be
 * trusted, and `enabled` is forced false in that case.
 */
export function normalizeSettings(raw) {
  if (raw === undefined) return { ...defaultSettings(), source: 'default' }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaultSettings(), enabled: false, invalid: true }
  }
  const enabled = raw.enabled !== false
  const days = Number(raw.retentionDays)
  if (!RETENTION_OPTIONS.includes(days)) {
    return { enabled, retentionDays: DEFAULT_RETENTION_DAYS, source: 'normalized' }
  }
  return { enabled, retentionDays: days, source: 'file' }
}

/**
 * Load the effective settings. Missing file means defaults; corrupt file is
 * backed up and disables deletion for this run.
 */
export async function loadSettings() {
  const { settings: file } = filePaths()
  const result = await readJson(file)
  if (result.corrupt) {
    const backup = await backupCorrupt(file)
    return { ...normalizeSettings(undefined), enabled: false, invalid: true, corrupt: true, backup }
  }
  return normalizeSettings(result.value)
}

/**
 * Validate and persist one settings document.
 * @param input - untrusted request body.
 * @returns the effective settings.
 * @throws {TypeError} when a field is invalid.
 */
export async function saveSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('settings must be an object')
  }
  if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
  const days = input.retentionDays
  if (!RETENTION_OPTIONS.includes(days)) {
    throw new TypeError(`retentionDays must be one of ${RETENTION_OPTIONS.join(', ')}`)
  }
  const value = { enabled: input.enabled, retentionDays: days }
  await writeJsonAtomic(filePaths().settings, value)
  return { ...value, source: 'file' }
}
