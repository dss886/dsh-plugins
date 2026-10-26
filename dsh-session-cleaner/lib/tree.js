/**
 * Pure helpers for the Session id vocabulary and the subagent tree.
 *
 * The tree is derived from stored headers, not from the subagent catalog:
 * existence is a persistence fact, and a catalog id is not a safe path input.
 * Forks are protected by requiring `origin === 'subagent'`.
 */
import { basename, dirname, resolve, sep } from 'node:path'

/** The two accepted id spellings: canonical `session-<uuid>` and a bare uuid. */
export const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every spelling an id may use in derived records and cache filenames.
 * @param id - a validated session id.
 */
export function sessionIdVariants(id) {
  const text = String(id)
  const tail = text.startsWith('session-') ? text.slice('session-'.length) : text
  const variants = new Set([text])
  if (tail.length > 0) {
    variants.add(tail)
    variants.add(`session-${tail}`)
  }
  return [...variants]
}

/**
 * Index latest stored headers by id.
 * @param snapshots - `sessionPersistence.list()` output.
 */
export function buildHeaderIndex(snapshots) {
  const headers = new Map()
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const header = snapshot?.header
    if (header === null || typeof header !== 'object') continue
    if (typeof header.id !== 'string' || header.id.length === 0) continue
    headers.set(header.id, header)
  }
  return headers
}

/**
 * parent id → direct subagent child ids, from stored headers only.
 * @param headers - index from {@link buildHeaderIndex}.
 */
export function buildChildren(headers) {
  const children = new Map()
  for (const [id, header] of headers) {
    if (header.origin !== 'subagent') continue
    const parent = header.parentSession
    if (typeof parent !== 'string' || parent.length === 0) continue
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [id])
    else list.push(id)
  }
  return children
}

/**
 * Breadth-first tree rooted at one session, with parent and depth metadata.
 * Invalid ids are dropped defensively; they can never become paths.
 * @param rootId - archived root id.
 * @param children - map from {@link buildChildren}.
 * @returns nodes in BFS order; the root is always first when valid.
 */
export function collectTree(rootId, children) {
  const nodes = []
  const seen = new Set()
  const queue = [{ id: String(rootId), parentId: null, depth: 0 }]
  while (queue.length > 0) {
    const node = queue.shift()
    if (seen.has(node.id)) continue
    if (!SESSION_ID_RE.test(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
    for (const child of children.get(node.id) ?? []) {
      queue.push({ id: child, parentId: node.id, depth: node.depth + 1 })
    }
  }
  return nodes
}

/**
 * Resolve the artifact directory and confine it to the sessions root.
 * @param root - resolved sessions root.
 * @param location - `snapshot.location` from persistence.
 * @returns the directory, or undefined when it is not a local jsonl artifact
 * inside the root.
 */
export function artifactDir(root, location) {
  if (location === null || typeof location !== 'object') return undefined
  if (location.kind !== 'jsonl' || typeof location.path !== 'string' || location.path.length === 0) return undefined
  const dir = dirname(resolve(location.path))
  const base = resolve(root)
  if (dir === base) return undefined
  if (!dir.startsWith(base + sep)) return undefined
  const name = basename(dir)
  if (name.length === 0 || name === '.' || name === '..') return undefined
  return dir
}
