/** Settings batch width is unchanged; these tests cover the three-request flow and snapshot reuse. */
import { expect, it } from 'vitest'
import { parseRequestId } from '../src/contracts.ts'
import { estimateSettingsBatchBytes, parseSettingsBatch, parseSettingsConsistency, planSettingsBatches, SETTINGS_BATCH_DEGRADE } from '../src/settings-batch.ts'
import { settingsCatalog } from '../src/settings-catalog.ts'
import { StageDeliveries } from '../src/stage-deliveries.ts'
import { WritingRunner } from '../src/writing-runner.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const kinds = new Map(settingsCatalog.map(item => [item.code, item.kind]))
const body = '本书是一部发生在虚构雾港的悬疑冒险小说。'

it('keeps one batch when the estimate fits and splits into fours when it does not', () => {
  const codes = ['a1', 'a2', 'a3', 'a4', 'a5', 'e1']
  expect(estimateSettingsBatchBytes(codes)).toBeGreaterThan(10_000)
  expect(planSettingsBatches(codes, estimateSettingsBatchBytes(codes))).toEqual([codes])
  expect(planSettingsBatches(codes, estimateSettingsBatchBytes(codes) - 1)).toEqual([codes.slice(0, SETTINGS_BATCH_DEGRADE), codes.slice(SETTINGS_BATCH_DEGRADE)])
})

it('rejects a batch over maxOutputBytes, a missing code, and a consistency quote that is not in the body', () => {
  const value = { dimensions: [{ code: 'a1', body }] }
  expect(() => parseSettingsBatch(value, { codes: ['a1'], maxOutputBytes: 8, kinds })).toThrow(/above maxOutputBytes 8/)
  expect(() => parseSettingsBatch({ dimensions: [{ code: 'a1', body }] }, { codes: ['a1', 'a2'], maxOutputBytes: 100_000, kinds })).toThrow(/missing a2/)
  expect(() => parseSettingsConsistency({ issues: [{ dimension: 'a1', kind: 'conflict', quote: '并不存在' }] }, { codes: ['a1'], bodies: new Map([['a1', body]]), maxOutputBytes: 100_000 })).toThrow(/does not occur in a1/)
})

it('asks for a second draft only when settingsCandidateCount is above 1', async () => {
  const fixture = await useWritingFixture({ executionLimits: { settingsCandidateCount: 2 } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.attempts.filter(item => item.key.startsWith('settings/batch/a1/draft')).map(item => item.key).sort()).toEqual(['settings/batch/a1/draft', 'settings/batch/a1/draft/candidate/1'])
  expect(outcome.value.attempts.some(item => item.key.startsWith('settings/repair/'))).toBe(false)
}, 120_000)

it('repairs only the dimension named by the consistency review', async () => {
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.task?.batch !== 'consistency' || stage.task.validationError != null) return output
    return { issues: [{ dimension: 'a1', kind: 'gap', quote: body }] }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a2'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const repair = [...fixture.stages.values()].find(stage => stage.task?.batch === 'repair')
  expect(repair?.task?.codes).toEqual(['a1'])
  expect(outcome.value.attempts.some(item => item.key === 'settings/repair/a1')).toBe(true)
}, 120_000)

it('skips settings when the brief text and roots match a snapshot, and runs them again after one changed character', async () => {
  const fixture = await useWritingFixture({ backend: 'sqlite' })
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  expect(first.value.status).toBe('completed')
  const snapshot = fixture.service.findSettingsSnapshot(fixture.actor, fixture.novel.id, fixture.novel.brief.sha256, ['a1'])
  expect(snapshot?.artifactId).toBeDefined()
  const again = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, requestId: parseRequestId('writing-fixture-again'), chapterCount: 1, throughChapter: 1 }))
  if (again.status === 'rejected') throw again.reason
  expect(again.value.status).toBe('completed')
  expect(again.value.attempts.some(item => item.key.startsWith('settings/'))).toBe(false)
  const original = fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: fixture.novel.brief.id }).text
  const changed = await fixture.service.saveBrief(fixture.actor, { novelId: fixture.novel.id, requestId: parseRequestId('brief-one-character'), expectedRevision: fixture.service.getNovel(fixture.actor, fixture.novel.id).revision, text: `${original}。` })
  const third = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, briefArtifactId: changed.brief.id, requestId: parseRequestId('writing-after-brief'), mode: 'update', chapterCount: 1, throughChapter: 1 }))
  if (third.status === 'rejected') throw third.reason
  expect(third.value.status).toBe('completed')
  expect(third.value.attempts.some(item => item.key === 'settings/batch/a1/draft')).toBe(true)
  expect(fixture.service.findSettingsSnapshot(fixture.actor, fixture.novel.id, fixture.novel.brief.sha256, ['a1'])?.artifactId).toBe(snapshot?.artifactId)
  expect(fixture.service.findSettingsSnapshot(fixture.actor, fixture.novel.id, changed.brief.sha256, ['a1'])?.artifactId).not.toBe(snapshot?.artifactId)
}, 180_000)

it('does not reuse a snapshot when reuseSettingsSnapshot is off, even if the brief text is unchanged', async () => {
  const fixture = await useWritingFixture()
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  const text = fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: fixture.novel.brief.id }).text
  const same = await fixture.service.saveBrief(fixture.actor, { novelId: fixture.novel.id, requestId: parseRequestId('brief-same-text'), expectedRevision: 1, text })
  expect(same.brief.sha256).toBe(fixture.novel.brief.sha256)
  const runner = new WritingRunner(fixture.ctx, fixture.service, fixture.runs, fixture.runner.limits, new StageDeliveries(fixture.ctx, fixture.service, fixture.runs, '.dsh-story'), { allowIncompleteSettings: true, reuseSettingsSnapshot: false })
  const outcome = await fixture.run(exec => runner.start(exec, { ...fixture.input, briefArtifactId: same.brief.id, requestId: parseRequestId('writing-flag-off'), mode: 'update', chapterCount: 1, throughChapter: 1 }))
  await runner.close()
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.attempts.some(item => item.key === 'settings/batch/a1/draft')).toBe(true)
}, 180_000)
