/** Project-scoped specification identities. Eight lowercase hex characters, allocated with collision checks. */

/** One stored binding from a full content digest to its project identity. */
export interface SpecIdentityEntry {
  readonly digest: string
  readonly id: string
}

const DIGEST = /^[a-f0-9]{64}$/
const SPEC_ID = /^[a-f0-9]{8}$/

/** @param value - Untrusted identity or digest. @returns Whether it is a full SHA-256 content digest. */
export function isContentDigest(value: string): boolean { return DIGEST.test(value) }

/** @param value - Untrusted identity. @returns Whether it is an 8-character project specification id. */
export function isSpecId(value: string): boolean { return SPEC_ID.test(value) }

/**
 * Next candidate after `offset` collisions. The step is 1 through the whole 32-bit space, so a free id is found
 * after at most as many steps as there are occupied ids. Nothing here treats a shared prefix as the same specification.
 * @param digest - Full content digest.
 * @param offset - How many occupied candidates have already been rejected.
 * @returns Eight lowercase hex characters.
 */
function specIdAt(digest: string, offset: number): string {
  const base = Number.parseInt(digest.slice(0, 8), 16)
  return ((base + offset) >>> 0).toString(16).padStart(8, '0')
}

/**
 * Bind `digest` to one id that no other digest in this project owns.
 * The same digest returns the stored id and the same entry array.
 * @param entries - Identities already stored for this project.
 * @param digest - Full SHA-256 of the specification content.
 * @returns The project's entries, including the binding, and the id to reuse.
 */
export function allocateSpecIdentity(entries: readonly SpecIdentityEntry[], digest: string): { readonly entries: readonly SpecIdentityEntry[]; readonly id: string } {
  if (!isContentDigest(digest)) throw new Error('Specification digest must be 64 lowercase hexadecimal characters')
  const existing = entries.find(entry => entry.digest === digest)
  if (existing !== undefined) return { entries, id: existing.id }
  const used = new Set(entries.map(entry => entry.id))
  for (let offset = 0; offset <= entries.length; offset += 1) {
    const id = specIdAt(digest, offset)
    if (!used.has(id)) return { entries: [...entries, { digest, id }], id }
  }
  throw new Error('No free specification identity remains in this project')
}

/** How a stored or caller-supplied identity resolves inside one project. */
export type ResolvedSpecIdentity = { readonly kind: 'allocated'; readonly digest: string; readonly id: string } | { readonly kind: 'legacy-digest'; readonly digest: string }

/**
 * Resolve an identity without treating an 8-character string as a prefix of a digest.
 * An unknown 8-character id resolves to nothing. A 64-character digest that has not been allocated remains a legacy digest.
 * @param entries - Identities stored for this project.
 * @param identity - Eight-character id or 64-character digest.
 * @returns The resolution, or undefined when `identity` is not an allocated id.
 */
export function resolveSpecIdentity(entries: readonly SpecIdentityEntry[], identity: string): ResolvedSpecIdentity | undefined {
  if (isSpecId(identity)) {
    const entry = entries.find(item => item.id === identity)
    return entry === undefined ? undefined : { kind: 'allocated', digest: entry.digest, id: entry.id }
  }
  if (isContentDigest(identity)) {
    const entry = entries.find(item => item.digest === identity)
    return entry === undefined ? { kind: 'legacy-digest', digest: identity } : { kind: 'allocated', digest: entry.digest, id: entry.id }
  }
  return undefined
}

/**
 * Whether a settings snapshot names the same specification as `identity`.
 * A snapshot that stores `briefId` matches only when that id is still bound to its stored digest.
 * A snapshot written before specification ids matches its 64-character digest, or an allocated id for that digest.
 * @param item - Stored snapshot identity fields.
 * @param identity - Caller-supplied id or legacy digest.
 * @param entries - Identities stored for this project.
 * @returns True when the snapshot is that specification.
 */
export function snapshotMatchesSpec(
  item: { readonly briefSha256: string; readonly briefId?: string | undefined },
  identity: string,
  entries: readonly SpecIdentityEntry[],
): boolean {
  if (item.briefId !== undefined) {
    const entry = entries.find(candidate => candidate.id === item.briefId && candidate.digest === item.briefSha256)
    if (entry === undefined) return false
    return identity === item.briefId || identity === item.briefSha256
  }
  if (!isContentDigest(item.briefSha256)) return false
  if (identity === item.briefSha256) return true
  if (!isSpecId(identity)) return false
  const entry = entries.find(candidate => candidate.id === identity)
  return entry !== undefined && entry.digest === item.briefSha256
}
