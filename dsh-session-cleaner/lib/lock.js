/**
 * Cross-process pass lock. Only one DSH instance may run the deletion pass at
 * a time; the per-session write lease still guards the individual artifact.
 */
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { filePaths } from './paths.js'

/** A lock older than this is considered abandoned. */
const STALE_MS = 10 * 60 * 1000

/**
 * Try to acquire the pass lock.
 * @returns `{ release }` on success, or null when another live pass owns it.
 */
export async function acquireLock() {
  const { lock } = filePaths()
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
      await handle.close()
      return {
        release: async () => {
          try {
            await unlink(lock)
          } catch {
            /* already gone */
          }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (!(await isStale(lock))) return null
      try {
        await unlink(lock)
      } catch {
        /* raced with another reaper */
      }
    }
  }
  return null
}

/**
 * @param lock - absolute lock path.
 * @returns whether the recorded owner is dead or the file is too old.
 */
async function isStale(lock) {
  try {
    const [text, info] = await Promise.all([readFile(lock, 'utf8'), stat(lock)])
    if (Date.now() - info.mtimeMs > STALE_MS) return true
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && Number.isInteger(parsed.pid)) {
      try {
        process.kill(parsed.pid, 0)
        return false
      } catch (error) {
        return error?.code === 'ESRCH'
      }
    }
  } catch {
    return true
  }
  return false
}
