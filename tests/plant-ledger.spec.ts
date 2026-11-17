/** Optional plants ledger: carry open plants, reject a second payment, and hint without blocking. */
import { expect, it } from 'vitest'
import { parseArtifactId } from '../src/contracts.ts'
import { projectContinuitySnapshot } from '../src/continuity-snapshot.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { advisoryPlantHints, attachContinuityPlants, carryForwardPlants, DEFAULT_OPEN_PLANT_CHAPTERS, listPlants, softenPlantField, type ForeshadowPlant } from '../src/plant-ledger.ts'
import { parseContinuityOutput, parseContinuitySnapshot, type StageInputRef } from '../src/stage-output.ts'
import { buildStagePrompt, type StagePromptKind } from '../src/stage-prompts.ts'

const open: ForeshadowPlant = { id: 'spare-key', text: 'The spare key is under the stair.', plantedChapter: 1, status: 'open', dueChapter: 6 }
const paid: ForeshadowPlant = { ...open, status: 'paid', paidChapter: 2 }
const refs: StageInputRef[] = [{ artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000010'), sha256: 'a'.repeat(64) }]
const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']
const prompt = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: refs[0]!.artifactId, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }

it('carries an open plant into the next chapter and can mark it paid there', () => {
  expect(carryForwardPlants({ chapterNumber: 2, plants: [{ ...open }], earlier: [{ plants: [open] }] })).toEqual([open])
  expect(carryForwardPlants({ chapterNumber: 2, plants: [paid], earlier: [{ plants: [open] }] })).toEqual([paid])
  expect(carryForwardPlants({ chapterNumber: 2, plants: undefined, earlier: [{}] })).toBeUndefined()
})

it('rejects a duplicate plant id', () => {
  expect(() => carryForwardPlants({ chapterNumber: 1, plants: [open, { ...open }], earlier: [] })).toThrow(/duplicate foreshadowing plant/i)
})

it('rejects paying a plant that is already paid', () => {
  expect(() => carryForwardPlants({ chapterNumber: 3, plants: [{ ...paid, paidChapter: 3 }], earlier: [{ plants: [paid] }] })).toThrow(/cannot be paid again/i)
})

it('requires a new plant to give this chapter as plantedChapter', () => {
  expect(() => carryForwardPlants({ chapterNumber: 2, plants: [open], earlier: [] })).toThrow(/plantedChapter 2/)
  const continuity = { version: 1, inputRefs: refs, chapterNumber: 1, summary: 'The keeper waits.', characters: [], timeline: [], obligations: [],
    plants: [{ id: 'spare-key', text: 'The spare key is under the stair.', status: 'open' }] }
  const expected = { inputRefs: refs, chapterNumber: 1, obligationIds: [] as string[], reviewedBodyId: refs[0]!.artifactId, evidenceSources: [{ artifactId: refs[0]!.artifactId, text: 'The keeper waits.' }] }
  expect(() => parseContinuityOutput(continuity, expected)).toThrow()
})

it('keeps the previous ledger when a plant check fails', () => {
  const duplicate = softenPlantField({ plants: [open, { ...open }] }, [], 1)
  expect(duplicate.advisory).toMatch(/duplicate foreshadowing plant/i)
  expect(duplicate.value).not.toHaveProperty('plants')
  const repaid = softenPlantField({ plants: [{ ...paid, paidChapter: 3 }] }, [{ plants: [paid] }], 3)
  expect(repaid.advisory).toMatch(/cannot be paid again/i)
  expect(repaid.value).not.toHaveProperty('plants')
  const replaced = softenPlantField({ plants: [open, { ...open, plantedChapter: 2 }] }, [{ plants: [open] }], 2)
  expect(replaced.advisory).toMatch(/duplicate foreshadowing plant/i)
  expect(replaced.value).toMatchObject({ plants: [open] })
  const kept = softenPlantField({ plants: [paid] }, [{ plants: [open] }], 2)
  expect(kept.advisory).toBeNull()
  expect(kept.value).toMatchObject({ plants: [paid] })
})

it('hints when a plant has stayed open for the default span and skips a snapshot with no plants', () => {
  expect(DEFAULT_OPEN_PLANT_CHAPTERS).toBe(5)
  expect(advisoryPlantHints(undefined, 8)).toEqual([])
  expect(advisoryPlantHints([open], open.plantedChapter + DEFAULT_OPEN_PLANT_CHAPTERS - 1)).toEqual([])
  const hints = advisoryPlantHints([open], open.plantedChapter + DEFAULT_OPEN_PLANT_CHAPTERS)
  expect(hints).toEqual(['Advisory: plant spare-key has stayed open for 5 chapters since chapter 1. This hint does not block the outline.'])
  expect(advisoryPlantHints([paid], 9)).toEqual([])
})

it('lists plants with position, status and due chapter', () => {
  expect(listPlants([open, paid])).toEqual([
    { id: 'spare-key', text: open.text, plantedChapter: 1, status: 'open', dueChapter: 6 },
    { id: 'spare-key', text: open.text, plantedChapter: 1, status: 'paid', paidChapter: 2, dueChapter: 6 },
  ])
  expect(listPlants(undefined)).toEqual([])
})

it('publishes plants only at version 15 and leaves versions 1–14 unchanged', () => {
  for (const version of [1, 9, 14] as const) {
    expect(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', version)), String(version)).not.toContain('plants')
    expect(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', version)), String(version)).not.toContain('name_note')
    expect(JSON.stringify(nativeStageOutputSchema('continuity', version)), String(version)).not.toContain('"plants"')
  }
  const published = nativeStageOutputSchema('continuity-snapshot', 15)
  expect(published.properties?.plants?.items?.properties?.status?.enum).toEqual(['open', 'paid'])
  expect(published.required ?? []).not.toContain('plants')
  expect(JSON.stringify(published)).not.toContain('name_note')
  expect(JSON.stringify(nativeStageOutputSchema('continuity', 15))).toContain('"plants"')
  expect(JSON.stringify(nativeStageOutputSchema('continuity', 15, { plantLedger: false }))).not.toContain('"plants"')
  for (const kind of kinds) {
    if (kind !== 'continuity' && kind !== 'chapter-outline' && kind !== 'body') expect(buildStagePrompt({ ...prompt, kind, promptVersion: 15 }), kind).toBe(buildStagePrompt({ ...prompt, kind, promptVersion: 14 }))
    if (kind !== 'continuity' && kind !== 'continuity-snapshot' && kind !== 'chapter-outline' && kind !== 'review') expect(JSON.stringify(nativeStageOutputSchema(kind, 15)), kind).toBe(JSON.stringify(nativeStageOutputSchema(kind, 14)))
  }
  expect(buildStagePrompt({ ...prompt, kind: 'continuity', promptVersion: 14 })).not.toContain('Carry forward every open plant')
  expect(buildStagePrompt({ ...prompt, kind: 'chapter-outline', promptVersion: 14 })).not.toContain('task.plantHints')
  expect(buildStagePrompt({ ...prompt, kind: 'continuity', promptVersion: 15, plantLedger: false })).toBe(buildStagePrompt({ ...prompt, kind: 'continuity', promptVersion: 14 }))
})

it('keeps the host snapshot copy unchanged before version 15', () => {
  const character = { name: 'Keeper', state: 'Has the log.', name_note: 'Lan' }
  const projected = projectContinuitySnapshot({
    chapterNumber: 1, inputRefs: refs, bodyText: 'The keeper closed the gate.', earlier: [],
    continuity: { characters: [character], obligations: [{ status: 'fulfilled', explanation: 'The log was recovered.' }], timeline: [] },
  })
  expect(projected.characterStatus).toEqual([{ name: 'Keeper', status: 'Has the log.' }])
  expect(attachContinuityPlants(14, true, projected, [open])).toEqual(projected)
  expect(attachContinuityPlants(14, true, projected, [open])).not.toHaveProperty('plants')
  expect(attachContinuityPlants(15, false, projected, [open])).toEqual(projected)
  const stored = attachContinuityPlants(15, true, projected, [open])
  expect(stored).toMatchObject({ ...projected, plants: [open] })
  expect(JSON.stringify(stored)).not.toContain('name_note')
  expect(parseContinuitySnapshot(stored, { inputRefs: refs, chapterNumber: 1 })).toEqual(stored)
  expect(() => parseContinuitySnapshot({ ...projected, characterStatus: [{ name: 'Keeper', status: 'Has the log.', name_note: 'Lan' }] }, { inputRefs: refs, chapterNumber: 1 })).toThrow()
})
