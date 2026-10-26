/**
 * Append-only deletion audit. There is no recycle bin, so this file is the
 * only durable record of what this plugin removed and why.
 */
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { filePaths } from './paths.js'

/** Rotate once the audit reaches this size. */
const MAX_BYTES = 5 * 1024 * 1024

/**
 * Append one JSON line.
 * @param entry - lossless-JSON audit record.
 */
export async function appendAudit(entry) {
  const { audit } = filePaths()
  await mkdir(filePaths().dir, { recursive: true, mode: 0o700 })
  try {
    const info = await stat(audit)
    if (info.size >= MAX_BYTES) {
      await unlink(`${audit}.1`).catch(() => {})
      await rename(audit, `${audit}.1`)
    }
  } catch {
    /* no file yet */
  }
  await appendFile(audit, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
