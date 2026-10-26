/**
 * Small durable-file helpers: JSON reads that distinguish "missing" from
 * "corrupt", and temp-file + rename writes.
 */
import { copyFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Read one JSON document.
 * @param file - absolute path.
 * @returns `missing` for ENOENT, `corrupt` for anything unparsable/readable,
 * otherwise the parsed value.
 */
export async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: undefined, missing: true, corrupt: false }
    return { value: undefined, missing: false, corrupt: true, error }
  }
  try {
    return { value: JSON.parse(text), missing: false, corrupt: false }
  } catch (error) {
    return { value: undefined, missing: false, corrupt: true, error }
  }
}

/**
 * Replace one JSON document atomically (same directory, mode 0600).
 * @param file - absolute path.
 * @param value - lossless-JSON value.
 */
export async function writeJsonAtomic(file, value) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, file)
  await chmod(file, 0o600).catch(() => {})
}

/**
 * Move a corrupt document aside so the next run can start clean without
 * destroying the evidence.
 * @param file - absolute path.
 * @returns the backup path, or undefined when even the copy failed.
 */
export async function backupCorrupt(file) {
  const target = `${file}.corrupt-${Date.now()}`
  try {
    await copyFile(file, target)
    await chmod(target, 0o600).catch(() => {})
    return target
  } catch {
    return undefined
  }
}
