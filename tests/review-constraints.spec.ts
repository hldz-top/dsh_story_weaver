/** Version 8 review admission: Chinese prose, and a brief quote for a new blocking requirement. */
import { expect, it } from 'vitest'
import { parseArtifactId } from '../src/contracts.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { parseReviewOutput } from '../src/stage-output.ts'
import { buildStagePrompt, type StagePromptKind } from '../src/stage-prompts.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const brief = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
const candidate = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }
const briefText = '守灯人林澜在虚构雾港追查失踪船只。穿越只是类型前提。'
const source = '林澜在雾港追查失踪船只。'
const evidence = [{ paragraphId: 'p1', problem: '这段写的是追查船只。' }]
const checks = [
  { category: 'completeness' as const, summary: '已核对完整。', evidence },
  { category: 'consistency' as const, summary: '已核对一致。', evidence },
]
const review = { version: 1, reviewed: candidate, inputRefs: [brief], checks, issues: [] as object[] }
const expected = {
  reviewed: candidate, inputRefs: [brief], requiredChecks: ['completeness', 'consistency'] as const,
  paragraphs: [{ id: 'p1', text: source, sha256: 'c'.repeat(64) }],
  evidenceSources: [{ artifactId: candidate.artifactId, text: source }, { artifactId: brief.artifactId, text: briefText }],
  admission: { chinese: true as const, briefText },
}
const promptBase = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: brief.artifactId, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity']

it('rejects English review prose and admits the same review in Chinese', () => {
  expect(() => parseReviewOutput({ ...review, checks: checks.map(check => ({ ...check, summary: 'The outline is complete.' })) }, expected)).toThrow(/Han characters/)
  expect(() => parseReviewOutput({ ...review, checks: [{ ...checks[0]!, evidence: [{ paragraphId: 'p1', problem: 'This paragraph covers the check.' }] }, checks[1]!] }, expected)).toThrow(/Han characters/)
  const admitted = parseReviewOutput(review, expected)
  expect(admitted.checks[0]?.summary).toBe('已核对完整。')
  expect(admitted.issues).toEqual([])
})

it('rejects a blocking requirement the creative brief does not state', () => {
  const invented = { id: 'wake', severity: 'blocking' as const, category: 'completeness' as const, location: '开篇', message: '缺少穿越醒来接管身体。', evidence }
  expect(() => parseReviewOutput({ ...review, issues: [invented] }, expected)).toThrow(/briefQuote/)
  expect(() => parseReviewOutput({ ...review, issues: [{ ...invented, briefQuote: '醒来接管身体' }] }, expected)).toThrow(/briefQuote/)
  const grounded = parseReviewOutput({ ...review, issues: [{ ...invented, briefQuote: '追查失踪船只' }] }, expected)
  expect(grounded.issues[0]).toMatchObject({ id: 'wake', severity: 'blocking', briefQuote: '追查失踪船只' })
  const contradiction = parseReviewOutput({ ...review, issues: [{ id: 'place', severity: 'blocking', category: 'consistency', location: '雾港', message: '地点与已接受设定矛盾。', evidence }] }, expected)
  expect(contradiction.issues[0]?.category).toBe('consistency')
  expect(contradiction.issues[0]).not.toHaveProperty('briefQuote')
})

it('publishes briefQuote only on version 8 and leaves earlier prompt bytes unchanged', () => {
  expect(JSON.stringify(nativeStageOutputSchema('review', 7))).not.toContain('briefQuote')
  expect(JSON.stringify(nativeStageOutputSchema('review', 8))).toContain('briefQuote')
  expect(JSON.stringify(nativeStageOutputSchema('book-outline', 8))).toBe(JSON.stringify(nativeStageOutputSchema('book-outline', 7)))
  const version7 = buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'book-outline', promptVersion: 7 })
  const version8 = buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'book-outline', promptVersion: 8 })
  expect(version7).not.toContain('briefQuote')
  expect(version8).toContain('briefQuote')
  expect(version8).toContain('Write every check.summary, issue.message, and evidence.problem in Chinese.')
  for (const kind of kinds) if (kind !== 'review') {
    expect(buildStagePrompt({ ...promptBase, kind, promptVersion: 8 }), kind).toBe(buildStagePrompt({ ...promptBase, kind, promptVersion: 7 }))
  }
})

it('repairs an English outline review instead of treating it as a blocking candidate', async () => {
  let english = true
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (!english || stage.kind !== 'review' || stage.task?.reviewed === undefined || stage.sources.get(stage.task.reviewed.artifactId)?.kind !== 'book-outline') return output
    english = false
    const reviewOutput = output as { checks: { summary: string }[] }
    return { ...reviewOutput, checks: reviewOutput.checks.map(check => ({ ...check, summary: 'The outline is complete.' })) }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const reviews = [...fixture.stages.values()].filter(stage => stage.kind === 'review' && stage.task?.reviewed !== undefined && stage.sources.get(stage.task.reviewed.artifactId)?.kind === 'book-outline')
  expect(reviews.length).toBeGreaterThanOrEqual(2)
  expect(reviews[1]?.task?.validationError).toMatch(/Han characters/)
  expect(outcome.value.attempts.filter(item => /^book-outline\/book\/candidate\/\d+$/.test(item.key))).toHaveLength(1)
}, 180_000)
