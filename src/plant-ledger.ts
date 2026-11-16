/** Optional foreshadowing plants carried on continuity and copied onto the continuity snapshot. */
import { z } from 'zod'
import { echo, StageValidationRejection } from './stage-rejection.ts'

const nonblank = z.string().min(1).refine(value => value.trim().length > 0, 'Text must not be blank')
const chapter = z.number().int().positive()
/** One planted or paid foreshadowing row. `paidChapter` and `dueChapter` are optional. */
export const foreshadowPlantSchema = z.strictObject({
  id: nonblank,
  text: nonblank.describe('One sentence the reviewed prose supports.'),
  plantedChapter: chapter,
  status: z.enum(['open', 'paid']),
  paidChapter: chapter.optional(),
  dueChapter: chapter.optional(),
})
/** A foreshadowing plant admitted on continuity or stored on a snapshot. */
export type ForeshadowPlant = z.infer<typeof foreshadowPlantSchema>
/** A plant open for this many chapters draws an advisory chapter-outline hint. */
export const DEFAULT_OPEN_PLANT_CHAPTERS = 5

/**
 * Check one chapter's plant list. Duplicate ids are rejected. A paid row must name this chapter, and an open row must not.
 * @param plants - The rows to check.
 * @param chapterNumber - The chapter being admitted.
 */
export function checkPlantList(plants: readonly ForeshadowPlant[], chapterNumber: number): void {
  const seen = new Set<string>()
  for (const plant of plants) {
    if (seen.has(plant.id)) throw new StageValidationRejection(`Duplicate foreshadowing plant: ${echo(plant.id)} appears more than once; each must be unique`)
    seen.add(plant.id)
    if (plant.plantedChapter > chapterNumber) throw new StageValidationRejection(`Plant ${echo(plant.id)} was planted in chapter ${plant.plantedChapter}, after chapter ${chapterNumber}`)
    if (plant.dueChapter !== undefined && plant.dueChapter < plant.plantedChapter) throw new StageValidationRejection(`Plant ${echo(plant.id)} is due in chapter ${plant.dueChapter}, before it was planted in chapter ${plant.plantedChapter}`)
    if (plant.status === 'open' && plant.paidChapter !== undefined) throw new StageValidationRejection(`An open plant has no paid chapter: plant ${echo(plant.id)}`)
    if (plant.status === 'paid' && plant.paidChapter !== chapterNumber) throw new StageValidationRejection(`A plant is paid in the current chapter: plant ${echo(plant.id)} says paidChapter ${plant.paidChapter ?? 'none'}`)
  }
}

/**
 * Carry the previous chapter's open plants into this chapter. Each stays open or is paid now.
 * A plant that is already paid cannot be paid again. A new plant must set `plantedChapter` to this chapter.
 * Omitting `plants` is allowed only when nothing is open.
 * @param input - This chapter's plants and earlier snapshots in chapter order.
 * @returns The admitted list, or undefined when the field was omitted and nothing was open.
 */
export function carryForwardPlants(input: {
  readonly chapterNumber: number
  readonly plants: readonly ForeshadowPlant[] | undefined
  readonly earlier: readonly { readonly plants?: readonly ForeshadowPlant[] }[]
}): ForeshadowPlant[] | undefined {
  const paid = new Map<string, ForeshadowPlant>()
  for (const snapshot of input.earlier) {
    for (const plant of snapshot.plants ?? []) if (plant.status === 'paid') paid.set(plant.id, plant)
  }
  const open = (input.earlier.at(-1)?.plants ?? []).filter(plant => plant.status === 'open')
  if (input.plants === undefined) {
    if (open.length > 0) throw new StageValidationRejection(`Continuity must carry every open plant: missing ${open.map(plant => echo(plant.id)).join(', ')}`)
    return undefined
  }
  checkPlantList(input.plants, input.chapterNumber)
  const present = new Set(input.plants.map(plant => plant.id))
  for (const plant of open) {
    if (!present.has(plant.id)) throw new StageValidationRejection(`Continuity must carry every open plant: missing ${echo(plant.id)}`)
  }
  for (const plant of input.plants) {
    const already = paid.get(plant.id)
    if (already !== undefined) throw new StageValidationRejection(`A paid plant cannot be paid again: plant ${echo(plant.id)} was paid in chapter ${already.paidChapter ?? 'none'}`)
    const prior = open.find(item => item.id === plant.id)
    if (prior === undefined) {
      if (plant.plantedChapter !== input.chapterNumber) throw new StageValidationRejection(`A new plant must give plantedChapter ${input.chapterNumber}: plant ${echo(plant.id)} says ${plant.plantedChapter}`)
      continue
    }
    if (plant.plantedChapter !== prior.plantedChapter || plant.text !== prior.text) throw new StageValidationRejection(`An open plant keeps its planted chapter and text: plant ${echo(plant.id)}`)
  }
  return [...input.plants]
}

/**
 * Advisory reminder for plants that have stayed open for several chapters. An empty list means there is nothing to say.
 * The strings are hints for a chapter outline. They are not blocking issues.
 * @param plants - Plants on the latest earlier snapshot. Absent means the run has no ledger.
 * @param chapterNumber - The chapter outline being planned.
 * @param openChapters - How many chapters a plant may stay open before the hint. Default {@link DEFAULT_OPEN_PLANT_CHAPTERS}.
 * @returns One hint per overdue open plant.
 */
export function advisoryPlantHints(plants: readonly ForeshadowPlant[] | undefined, chapterNumber: number, openChapters = DEFAULT_OPEN_PLANT_CHAPTERS): readonly string[] {
  if (plants === undefined) return []
  const hints: string[] = []
  for (const plant of plants) {
    if (plant.status !== 'open') continue
    const openFor = chapterNumber - plant.plantedChapter
    if (openFor >= openChapters) hints.push(`Advisory: plant ${plant.id} has stayed open for ${openFor} chapters since chapter ${plant.plantedChapter}. This hint does not block the outline.`)
  }
  return hints
}

/**
 * Copy admitted plants onto a host snapshot only for prompt version 15 and later.
 * Older versions keep the snapshot the host already built, even when continuity happens to carry plants.
 * @param promptVersion - The run's prompt version.
 * @param projected - The snapshot copied from character state, notes, and bridges.
 * @param plants - Plants admitted on this chapter's continuity.
 * @returns The snapshot to store.
 */
export function attachContinuityPlants<T extends object>(promptVersion: number, projected: T, plants: readonly ForeshadowPlant[] | undefined): T {
  if (promptVersion < 15 || plants === undefined) return projected
  return { ...projected, plants }
}
