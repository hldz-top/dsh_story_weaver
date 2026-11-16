/** Character review is blocking for voice and function. Metrics only warn. */
import { expect, it } from 'vitest'
import { parseCharacterSheet } from '../src/character-sheet.ts'
import { parseArtifactId } from '../src/contracts.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { measureCharacterMetrics } from '../src/review-metrics.ts'
import { parseReviewOutput } from '../src/stage-output.ts'
import { buildStagePrompt } from '../src/stage-prompts.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

function card(names: readonly string[], address = '前辈'): ReturnType<typeof parseCharacterSheet> {
  const core = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
  const voice = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |\n'
  return parseCharacterSheet([
    core, ...names.map(name => `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | 技艺 | 嘴上不服 | 1 |`),
    '', voice, ...names.map(name => `| ${name} | 短句 | 甲、乙、丙 | ${address} | 我 | 按剑 | 示弱 |`),
  ].join('\n'))
}

it('warns once when three present characters share one address form', () => {
  const sheet = card(['云望舒', '苏清鸢', '沈丹青'])
  const metrics = measureCharacterMetrics({
    bodyText: '云望舒、苏清鸢和沈丹青都称他前辈。',
    scenes: [{ cast: ['云望舒', '苏清鸢', '沈丹青'] }],
    sheet, protagonistName: '林澜', recentProtagonistFreeScenes: [],
  })
  expect(metrics.warnings).toEqual(['3 characters are present and only 1 address form is used.'])
  expect(metrics.quoteP50).toBe(0)
  expect(metrics.quoteP90).toBe(0)
  expect(metrics.uncastNames).toBe(0)
})

it('admits a version-14 review without character and rejects a version-15 review that omits a character item', () => {
  const ref = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
  const reviewed = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }
  const evidence = [{ artifactId: reviewed.artifactId, quote: '林澜站在门口' }]
  const sources = { reviewed, inputRefs: [ref], evidenceSources: [{ artifactId: reviewed.artifactId, text: '林澜站在门口。' }, { artifactId: ref.artifactId, text: '雾港。' }] }
  const checks = [
    { category: 'completeness', summary: '已读候选并完成完整性检查。', evidence },
    { category: 'consistency', summary: '已读候选并完成一致性检查。', evidence },
  ]
  expect(parseReviewOutput({ version: 1, reviewed, inputRefs: [ref], checks, issues: [] }, {
    ...sources, requiredChecks: ['completeness', 'consistency'], admission: { chinese: true, briefText: '雾港。' },
  }).checks).toHaveLength(2)
  expect(() => parseReviewOutput({ version: 1, reviewed, inputRefs: [ref], checks, issues: [] }, {
    ...sources, requiredChecks: ['completeness', 'consistency', 'character'], admission: { chinese: true, briefText: '雾港。', characterReview: true },
  })).toThrow(/character/)
  const characterChecks = (['character-voice', 'character-function', 'character-arc'] as const).map(id => ({ category: 'character', summary: `${id}：配角站得住。`, evidence }))
  expect(() => parseReviewOutput({ version: 1, reviewed, inputRefs: [ref], checks: [...checks, ...characterChecks], issues: [
    { id: 'character-voice', severity: 'advisory', category: 'character', location: '开篇', message: '台词可以互换。', evidence },
  ] }, { ...sources, requiredChecks: ['completeness', 'consistency', 'character'], admission: { chinese: true, briefText: '雾港。', characterReview: true } })).toThrow(/must be blocking/)
  expect(() => parseReviewOutput({ version: 1, reviewed, inputRefs: [ref], checks: [...checks, ...characterChecks], issues: [
    { id: 'character-arc', severity: 'blocking', category: 'character', location: '开篇', message: '人物没有自己的弧线。', evidence },
  ] }, { ...sources, requiredChecks: ['completeness', 'consistency', 'character'], admission: { chinese: true, briefText: '雾港。', characterReview: true } })).toThrow(/character-arc is fixed advisory/)
})

it('publishes the character category only at version 15', () => {
  expect(JSON.stringify(nativeStageOutputSchema('review', 14))).not.toContain('character')
  expect(JSON.stringify(nativeStageOutputSchema('review', 15))).toContain('character')
  expect(JSON.stringify(nativeStageOutputSchema('review', 15, { characterReview: false }))).toBe(JSON.stringify(nativeStageOutputSchema('review', 14)))
  const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings' as const, chars: 10 }], task: '{"x":1}', requirements: ['r1'], kind: 'review' as const, reviewedKind: 'body' as const }
  expect(buildStagePrompt({ ...base, promptVersion: 15 })).toContain('character-voice')
  expect(buildStagePrompt({ ...base, promptVersion: 15, characterReview: false })).toBe(buildStagePrompt({ ...base, promptVersion: 14 }))
})

it('repairs a blocking character-voice issue inside the body budget and does not sign it', async () => {
  let reviews = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'review' || !stage.task?.requiredChecks?.includes('character')) return output
      reviews += 1
      if (reviews > 1) return output
      const review = output as { checks: { evidence: unknown }[]; issues: object[] }
      const evidence = review.checks[0]?.evidence
      return { ...review, issues: [...review.issues, { id: 'character-voice', severity: 'blocking', category: 'character', location: '开篇', message: '配角的台词可以换成另一个人说。', evidence }] }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status, run.error ?? '').toBe('completed')
  const bodies = run.attempts.filter(item => item.key.startsWith('body/1/candidate/') && !item.key.includes('/review'))
  expect(bodies.map(item => item.key), run.error ?? '').toEqual(['body/1/candidate/0', 'body/1/candidate/1'])
  expect(bodies.every(item => item.failureSignature === undefined)).toBe(true)
}, 180_000)

it('stops a repeated character-voice failure inside the body budget', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'review' || !stage.task?.requiredChecks?.includes('character')) return output
      const review = output as { checks: { evidence: unknown }[]; issues: object[] }
      const evidence = review.checks[0]?.evidence
      return { ...review, issues: [...review.issues, { id: 'character-voice', severity: 'blocking', category: 'character', location: '开篇', message: '配角的台词可以换成另一个人说。', evidence }] }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status, run.error ?? '').toBe('completed')
  const bodies = run.attempts.filter(item => item.key.startsWith('body/1/candidate/') && !item.key.includes('/review')).map(item => item.key)
  expect(bodies).toEqual(['body/1/candidate/0', 'body/1/candidate/1'])
  expect(run.attempts.every(item => item.failureSignature === undefined)).toBe(true)
  expect(run.error).toBeNull()
}, 180_000)
