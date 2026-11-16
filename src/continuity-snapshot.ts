/** Deterministic continuity snapshot copied from admitted continuity. The runner does not call a model for this. */
import {
  MAX_SNAPSHOT_CHARACTERS, MAX_SNAPSHOT_NAME_CHARS, MAX_SNAPSHOT_NOTE_CHARS, MAX_SNAPSHOT_NOTES,
  type ContinuitySnapshotOutput, type StageInputRef,
} from './stage-output.ts'

/** Admitted continuity fields and earlier snapshots the host copies. `bodyText` is the assembled chapter. */
export interface ContinuitySnapshotProjection {
  readonly chapterNumber: number
  readonly inputRefs: readonly StageInputRef[]
  readonly continuity: {
    readonly characters: readonly { readonly name: string; readonly state: string }[]
    readonly obligations: readonly { readonly status: 'open' | 'fulfilled'; readonly explanation: string }[]
    readonly timeline: readonly { readonly event: string }[]
  }
  /** Assembled chapter prose. A carried note of at least eight code points that occurs here is recovered. */
  readonly bodyText: string
  readonly earlier: readonly { readonly unrecoveredForeshadowing: readonly { readonly note: string }[] }[]
}

/**
 * Copy one compact snapshot from admitted continuity.
 *
 * `characters[].name` becomes `characterStatus[].name`, and `characters[].state` becomes `characterStatus[].status`.
 * `usedPlotBridges` are the fulfilled obligation explanations. When that list is empty, timeline events are used.
 * When both are empty, one note is clipped from `bodyText`.
 * `unrecoveredForeshadowing` keeps earlier snapshot notes this chapter did not recover, then open-obligation explanations.
 * A carried note is recovered when it equals a fulfilled explanation or a timeline event, or when the assembled body contains it.
 * An applied chapter has no open obligations, so a new chapter adds none of those notes.
 * Names, notes, and row counts stay inside the existing snapshot caps. Later duplicates of a clipped name or note are omitted.
 * @param input - Admitted continuity, assembled body, and earlier snapshots in chapter order.
 * @returns A snapshot value that parseContinuitySnapshot admits.
 */
export function projectContinuitySnapshot(input: ContinuitySnapshotProjection): ContinuitySnapshotOutput {
  const characterStatus: { name: string; status: string }[] = []
  const names = new Set<string>()
  for (const character of input.continuity.characters) {
    if (characterStatus.length >= MAX_SNAPSHOT_CHARACTERS) break
    const name = clip(character.name, MAX_SNAPSHOT_NAME_CHARS)
    const status = clip(character.state, MAX_SNAPSHOT_NOTE_CHARS)
    if (name === null || status === null || names.has(name)) continue
    names.add(name)
    characterStatus.push({ name, status })
  }
  const fulfilled = notes(input.continuity.obligations.filter(item => item.status === 'fulfilled').map(item => item.explanation))
  const events = notes(input.continuity.timeline.map(item => item.event))
  const recovered = new Set([...fulfilled, ...events])
  const unrecovered: string[] = []
  for (const snapshot of input.earlier) {
    for (const item of snapshot.unrecoveredForeshadowing) {
      const note = clip(item.note, MAX_SNAPSHOT_NOTE_CHARS)
      if (note === null || recovered.has(note)) continue
      if ([...note].length >= 8 && input.bodyText.includes(note)) continue
      pushUnique(unrecovered, note)
    }
  }
  for (const obligation of input.continuity.obligations) {
    if (obligation.status !== 'open') continue
    const note = clip(obligation.explanation, MAX_SNAPSHOT_NOTE_CHARS)
    if (note !== null) pushUnique(unrecovered, note)
  }
  const bridges: string[] = []
  let bridgeSource = fulfilled
  if (bridgeSource.length === 0) bridgeSource = events
  if (bridgeSource.length === 0) bridgeSource = notes([input.bodyText])
  for (const note of bridgeSource) pushUnique(bridges, note)
  return {
    version: 1, inputRefs: [...input.inputRefs], chapterNumber: input.chapterNumber, characterStatus,
    unrecoveredForeshadowing: unrecovered.map(note => ({ note })), usedPlotBridges: bridges.map(note => ({ note })),
  }
}

function notes(values: readonly string[]): string[] {
  const result: string[] = []
  for (const value of values) {
    const note = clip(value, MAX_SNAPSHOT_NOTE_CHARS)
    if (note !== null) result.push(note)
  }
  return result
}

function pushUnique(target: string[], note: string): void {
  if (target.length >= MAX_SNAPSHOT_NOTES || target.includes(note)) return
  target.push(note)
}

/** @param value - Source text. @param limit - Maximum Unicode code points. @returns The clipped text, or null when it would be blank. */
function clip(value: string, limit: number): string | null {
  const clipped = [...value].slice(0, limit).join('')
  return clipped.trim().length === 0 ? null : clipped
}
