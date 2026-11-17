/** A malformed e5 card is patched inside the settings budget. A bad viewpoint is patched inside the outline budget. */
import { expect, it } from 'vitest'
import { applyCharacterSheetPatch } from '../src/character-sheet-repair.ts'
import { OUTLINE_PATCH_REQUIREMENT } from '../src/outline-repair.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const sheet = [
  '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 林澜 | 守灯人 | 查明航标 | 船队失散 | 独自追查 | 技艺 | 话少但会留下灯 | 1 |',
  '',
  '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| 林澜 | 短句，4-12 字 | 航标、雾、灯 | 我 | 我 | 按灯 | 当众示弱 |',
].join('\n')

it('replaces only contentMarkdown and keeps the settings item identity', () => {
  const prior = {
    version: 1 as const,
    inputRefs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as const, sha256: 'a'.repeat(64) }],
    dimensionCode: 'e5',
    facts: [{ id: 'batch-e5', statement: '旧的自由文本。' }],
    contentMarkdown: '旧的自由文本。',
  }
  const patched = applyCharacterSheetPatch(prior, { version: 1, changes: [{ op: 'set', path: 'contentMarkdown', value: sheet }] })
  expect(patched.contentMarkdown).toBe(sheet)
  expect(patched.dimensionCode).toBe('e5')
  expect(patched.inputRefs).toEqual(prior.inputRefs)
  expect(patched.facts[0]?.id).toBe('batch-e5')
  expect(patched.facts[0]?.statement).not.toBe('旧的自由文本。')
  expect(() => applyCharacterSheetPatch(prior, { version: 1, changes: [{ op: 'set', path: 'facts', value: '改' }] })).toThrow(/contentMarkdown|schema/)
})

it('patches a malformed e5 card inside the settings budget and does not store the broken text', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  const card = run.attempts.filter(item => item.key.includes('/e5/card/'))
  expect(card.map(item => item.key)).toEqual([expect.stringContaining('/e5/card/1')])
  const prompt = fixture.runs.storedPrompt(fixture.actor, run.id, card[0]!.key) ?? ''
  expect(prompt).toContain('内核表')
  expect(prompt).toContain('contentMarkdown')
  const applied = fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(item => item.dimensionCode === 'e5')
  expect(applied).toBeDefined()
  const stored = StageOutputSchemas.settings.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text))
  expect(stored.contentMarkdown).toContain('误读框架')
  expect(stored.contentMarkdown).toContain('禁语')
  expect(stored.facts[0]?.id).toBe('batch-e5')
}, 180_000)

it('fails settings when the card is still malformed after the budget, and does not keep it as free text', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage, output) {
      if (!stage.data.requirements.some(item => item.includes('contentMarkdown'))) return output
      return { version: 1, changes: [{ op: 'set', path: 'contentMarkdown', value: '仍是自由文本，没有角色表。' }] }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Settings repair limit was exhausted for e5')
  expect(run.attempts.some(item => item.key.includes('/e5/card/2'))).toBe(false)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.some(item => item.dimensionCode === 'e5')).toBe(false)
}, 180_000)

it('stores e5 prose when character cards are off and does not ask for a card patch', async () => {
  const fixture = await useWritingFixture({
    characterSheet: false,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  expect(run.attempts.some(item => item.key.includes('/card/'))).toBe(false)
  const applied = fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(item => item.dimensionCode === 'e5')
  const stored = StageOutputSchemas.settings.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text))
  expect(stored.contentMarkdown).toContain('雾港')
  expect(stored.contentMarkdown).not.toContain('内核表')
}, 180_000)

function withCast(output: object, fields: { cast: string[]; pov: string; misread?: string }): object {
  const outline = output as { scenes: object[] }
  return { ...outline, scenes: outline.scenes.map(scene => ({ ...scene, ...fields })) }
}

it('rejects a viewpoint outside the cast and repairs it with an outline patch', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'chapter-outline' || stage.task?.chapterNumber !== 1) return output
      if ('changes' in output) return { version: 1, changes: [{ op: 'set', path: 'scenes[0].pov', value: '林澜' }] }
      return withCast(output, { cast: ['林澜'], pov: '沈丹青' })
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  const outlines = run.attempts.filter(item => item.key.startsWith('chapter-outline/1/candidate/') && !item.key.includes('/review'))
  expect(outlines.map(item => item.key)).toEqual(['chapter-outline/1/candidate/0', 'chapter-outline/1/candidate/1'])
  const repair = fixture.runs.storedPrompt(fixture.actor, run.id, 'chapter-outline/1/candidate/1') ?? ''
  expect(repair).toContain(OUTLINE_PATCH_REQUIREMENT)
  expect(repair).toContain('pov')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).heads.find(item => item.target.kind === 'chapter-outline')
  const stored = StageOutputSchemas['chapter-outline'].parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text))
  expect(stored.scenes[0]?.pov).toBe('林澜')
}, 180_000)

it('rejects an illegal misread and keeps an unknown cast name', async () => {
  let chapter = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'chapter-outline') return output
      if ('changes' in output) return { version: 1, changes: [{ op: 'set', path: 'scenes[0].misread', value: '利益' }] }
      chapter += 1
      if (stage.task?.chapterNumber !== 1) return output
      return withCast(output, { cast: ['路人'], pov: '路人', misread: chapter === 1 ? '命运' : '利益' })
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  const repair = fixture.runs.storedPrompt(fixture.actor, run.id, 'chapter-outline/1/candidate/1') ?? ''
  expect(repair).toContain('misread')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).heads.find(item => item.target.kind === 'chapter-outline')
  const stored = StageOutputSchemas['chapter-outline'].parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text))
  expect(stored.scenes[0]?.cast).toEqual(['路人'])
  expect(stored.scenes[0]?.misread).toBe('利益')
}, 180_000)
