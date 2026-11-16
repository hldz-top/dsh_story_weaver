/** Host continuity snapshots are copied from admitted continuity and still admit under the existing parser. */
import { expect, it } from 'vitest'
import { parseArtifactId } from '../src/contracts.ts'
import { projectContinuitySnapshot, type ContinuitySnapshotProjection } from '../src/continuity-snapshot.ts'
import { parseContinuitySnapshot, StageOutputSchemas, type StageInputRef } from '../src/stage-output.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const bodyRef = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000010'), sha256: 'a'.repeat(64) }
const continuityRef = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000011'), sha256: 'b'.repeat(64) }
const refs: StageInputRef[] = [bodyRef, continuityRef]

function project(overrides: Partial<Pick<ContinuitySnapshotProjection, 'bodyText' | 'earlier'>> & {
  characters?: ContinuitySnapshotProjection['continuity']['characters']
  obligations?: ContinuitySnapshotProjection['continuity']['obligations']
  timeline?: ContinuitySnapshotProjection['continuity']['timeline']
} = {}): ReturnType<typeof projectContinuitySnapshot> {
  return projectContinuitySnapshot({
    chapterNumber: 1, inputRefs: refs, bodyText: overrides.bodyText ?? 'The keeper closed the gate and kept the lamp.',
    earlier: overrides.earlier ?? [],
    continuity: {
      characters: overrides.characters ?? [{ name: 'Keeper', state: 'Has the log.' }],
      obligations: overrides.obligations ?? [{ status: 'fulfilled', explanation: 'The body records recovery.' }],
      timeline: overrides.timeline ?? [{ event: 'The log is recovered.' }],
    },
  })
}

it('copies character state and fulfilled explanations into the existing snapshot fields', () => {
  const snapshot = project()
  expect(snapshot.characterStatus).toEqual([{ name: 'Keeper', status: 'Has the log.' }])
  expect(snapshot.usedPlotBridges).toEqual([{ note: 'The body records recovery.' }])
  expect(snapshot.unrecoveredForeshadowing).toEqual([])
  expect(parseContinuitySnapshot(snapshot, { inputRefs: refs, chapterNumber: 1 })).toEqual(snapshot)
})

it('keeps an older stored snapshot shape readable by the same schema', () => {
  const legacy = { version: 1, inputRefs: refs, chapterNumber: 4, characterStatus: [{ name: 'Keeper', status: 'Has the log.' }],
    unrecoveredForeshadowing: [{ note: 'The key is still missing.' }], usedPlotBridges: [{ note: 'The log was recovered.' }] }
  expect(StageOutputSchemas['continuity-snapshot'].parse(legacy)).toEqual(legacy)
  expect(parseContinuitySnapshot(legacy, { inputRefs: refs, chapterNumber: 4 })).toEqual(legacy)
})

it('caps rows and clips notes to the existing snapshot limits', () => {
  const long = '字'.repeat(200)
  const snapshot = project({
    characters: Array.from({ length: 9 }, (_, index) => ({ name: `人物${index}`, state: long })),
    obligations: Array.from({ length: 7 }, (_, index) => ({ status: 'fulfilled' as const, explanation: `Completed bridge ${index}.` })),
  })
  expect(snapshot.characterStatus).toHaveLength(8)
  expect(snapshot.characterStatus[0]).toEqual({ name: '人物0', status: '字'.repeat(160) })
  expect(snapshot.characterStatus.some(item => item.name === '人物8')).toBe(false)
  expect(snapshot.usedPlotBridges.map(item => item.note)).toEqual(Array.from({ length: 6 }, (_, index) => `Completed bridge ${index}.`))
  expect(parseContinuitySnapshot(snapshot, { inputRefs: refs, chapterNumber: 1 })).toEqual(snapshot)
})

it('omits a later character when clipping its name repeats an earlier name', () => {
  const prefix = '名'.repeat(40)
  const snapshot = project({ characters: [
    { name: `${prefix}甲`, state: 'Keeps the first clipped name.' },
    { name: `${prefix}乙`, state: 'Drops the later clipped name.' },
    { name: 'Keeper', state: 'Has the log.' },
  ] })
  expect(snapshot.characterStatus).toEqual([
    { name: prefix, status: 'Keeps the first clipped name.' },
    { name: 'Keeper', status: 'Has the log.' },
  ])
})

it('carries an unrecovered note forward and drops one the body or a fulfilled explanation recovers', () => {
  const kept = 'The key is still missing from the desk.'
  const snapshot = project({
    bodyText: 'The lantern stays dark tonight. The keeper waits.',
    earlier: [{ unrecoveredForeshadowing: [
      { note: 'The lantern stays dark tonight.' },
      { note: kept },
      { note: 'The body records recovery.' },
    ] }],
    obligations: [
      { status: 'fulfilled', explanation: 'The body records recovery.' },
      { status: 'open', explanation: 'The tide has not turned tonight.' },
    ],
  })
  expect(snapshot.unrecoveredForeshadowing.map(item => item.note)).toEqual([kept, 'The tide has not turned tonight.'])
  expect(snapshot.usedPlotBridges).toEqual([{ note: 'The body records recovery.' }])
})

it('uses a timeline event, then the body, only when continuity has no fulfilled explanation', () => {
  expect(project({ obligations: [], timeline: [{ event: 'The ferry left at dawn.' }] }).usedPlotBridges).toEqual([{ note: 'The ferry left at dawn.' }])
  const bodyText = 'The keeper closed the gate and kept the lamp.'
  expect(project({ obligations: [], timeline: [], bodyText }).usedPlotBridges).toEqual([{ note: bodyText }])
})

it('does not start a snapshot model call after continuity is applied, and the copied snapshot stays usable downstream', async () => {
  const fixture = await useWritingFixture({})
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  expect([...fixture.stages.values()].some(stage => stage.kind === 'continuity-snapshot')).toBe(false)
  expect([...fixture.stages.values()].some(stage => stage.kind === 'review' && stage.task?.reviewed !== undefined && stage.sources.get(stage.task.reviewed.artifactId)?.kind === 'continuity-snapshot')).toBe(false)
  expect(outcome.value.attempts.some(attempt => attempt.key.includes('continuity-snapshot'))).toBe(false)
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const chapter = manuscript.appliedChapters.find(item => item.chapterNumber === 1)
  const snapshotRef = chapter?.snapshot
  if (snapshotRef == null) throw new Error('Applied chapter has no snapshot')
  const stored = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: snapshotRef.id }).text) as {
    characterStatus: { name: string; status: string }[]
    unrecoveredForeshadowing: { note: string }[]
    usedPlotBridges: { note: string }[]
    inputRefs: StageInputRef[]
    chapterNumber: number
  }
  expect(stored.characterStatus).toEqual([{ name: '林澜', status: '已完成第1处航标的核查，仍在雾港与同伴守灯。' }])
  expect(stored.unrecoveredForeshadowing).toEqual([])
  expect(stored.usedPlotBridges).toEqual([{ note: '林澜查明第1处航标并记录证据。' }])
  expect(parseContinuitySnapshot(stored, { inputRefs: stored.inputRefs, chapterNumber: 1 })).toEqual(stored)
  expect(manuscript.history.find(item => item.artifact.id === snapshotRef.id)).toMatchObject({ status: 'applied', childSessionId: null })
  const next = fixture.service.manuscriptResearchInputs(fixture.actor, { novelId: fixture.novel.id, target: { kind: 'chapter-outline', chapterNumber: 2 } })
  expect(next.some(ref => ref.id === snapshotRef.id && ref.kind === 'continuity-snapshot')).toBe(true)
})
