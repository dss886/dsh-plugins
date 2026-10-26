/**
 * Paths owned by @dss886/dsh-session-cleaner.
 *
 * Every artifact lives below `$DSH_HOME/storages` and carries the plugin token,
 * so a re-install never reads another plugin's state.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Row id, route prefix and state-file token. */
export const PLUGIN_ID = 'dss886-dsh-session-cleaner'

/** The Harness home: `DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** Every durable file this plugin owns. */
export function filePaths() {
  const dir = join(dshHome(), 'storages')
  return {
    dir,
    settings: join(dir, `${PLUGIN_ID}-settings.json`),
    state: join(dir, `${PLUGIN_ID}-state.json`),
    audit: join(dir, `${PLUGIN_ID}-audit.jsonl`),
    lock: join(dir, `${PLUGIN_ID}.lock`),
    projectionCacheDir: join(dir, 'session_projcache', 'sessions'),
  }
}

/**
 * The session artifact root the persistence backend is actually using.
 *
 * The JSONL backend exposes its resolved config at runtime; deriving the root
 * from it keeps a custom `root` configuration working without guessing. The
 * documented default is `$DSH_HOME/sessions`.
 * @param persistence - the `sessionPersistence` service.
 */
export function sessionsRoot(persistence) {
  const configured = persistence?.config?.root
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return resolve(join(dshHome(), 'sessions'))
}
