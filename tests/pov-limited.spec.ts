/** Limited point of view. The host hint is advisory; the fixed review check is pov-limited. */
import { expect, it } from 'vitest'
import { parseArtifactId } from '../src/contracts.ts'
import { povHeuristicReport, viewpointName } from '../src/pov-limited.ts'
import { parseReviewOutput, StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const otherMind = '韩铁衣心想这人一定在撒谎。'
const ownMind = '林澜心想这人一定在撒谎。'

it('flags another person\'s mind and not the viewpoint\'s own thoughts', () => {
  const paragraphs = [{ id: 'p1', text: `林澜站在门口。${otherMind}` }]
  const flagged = povHeuristicReport({ prose: paragraphs[0]!.text, viewpoint: '林澜', paragraphs })
  expect(flagged.viewpoint).toBe('林澜')
  expect(flagged.hints).toEqual([{ check: 'pov-limited', excerpt: '韩铁衣心想', paragraphId: 'p1' }])
  expect(povHeuristicReport({ prose: `林澜站在门口。${ownMind}`, viewpoint: '林澜' }).hints).toEqual([])
  expect(povHeuristicReport({ prose: `「${otherMind}」林澜点了点头。`, viewpoint: '林澜' }).hints).toEqual([])
  const unnamed = povHeuristicReport({ prose: paragraphs[0]!.text, viewpoint: null })
  expect(unnamed).toEqual({ viewpoint: null, hints: [] })
  expect(viewpointName(['雾港没有这一行。'])).toBeNull()
  expect(viewpointName(['{"constraints":["视角人物：林澜"]}'])).toBe('林澜')
})

it('requires paragraphId on a pov-limited issue and does not require the check before version 12', () => {
  const ref = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
  const reviewed = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }
  const evidence = [{ artifactId: reviewed.artifactId, quote: '韩铁衣心想这人一定在撒谎' }]
  const checks = [
    { category: 'completeness', summary: '已读候选并完成完整性检查。', evidence },
    { category: 'consistency', summary: '已读候选并完成一致性检查。', evidence },
    { category: 'pov', summary: '叙述只写出林澜能感知的内容。', evidence },
  ]
  const expected = {
    reviewed, inputRefs: [ref], requiredChecks: ['completeness', 'consistency'] as const,
    evidenceSources: [
      { artifactId: reviewed.artifactId, text: '林澜站在门口。韩铁衣心想这人一定在撒谎。' },
      { artifactId: ref.artifactId, text: '雾港。' },
    ],
    admission: { chinese: true as const, briefText: '雾港。', povLimited: true as const },
  }
  const issue = { id: 'pov-limited', severity: 'blocking' as const, category: 'pov' as const, location: 'p1', message: '不要直接写韩铁衣的内心。', paragraphId: 'p1', evidence }
  expect(parseReviewOutput({ version: 1, reviewed, inputRefs: [ref], checks, issues: [issue] }, expected).issues[0]?.paragraphId).toBe('p1')
  const { paragraphId: _omit, ...withoutParagraph } = issue
  expect(() => parseReviewOutput({ version: 1, reviewed, inputRefs: [ref], checks, issues: [withoutParagraph] }, expected)).toThrow(/paragraphId/)
  const withoutPov = { version: 1, reviewed, inputRefs: [ref], checks: checks.slice(0, 2), issues: [] as unknown[] }
  expect(() => parseReviewOutput(withoutPov, expected)).toThrow(/pov/)
  expect(parseReviewOutput(withoutPov, { ...expected, admission: { chinese: true, briefText: '雾港。' } }).checks).toHaveLength(2)
  const legacy = [
    { id: 'pov-limited', severity: 'advisory' as const, category: 'style' as const, location: 'p1', message: '这是旧版里的一条普通意见。', evidence },
    { id: 'pov-limited-2', severity: 'blocking' as const, category: 'consistency' as const, location: 'p1', message: '这是旧版里的另一条普通意见。', evidence },
  ]
  const legacyOutput = { version: 1, reviewed, inputRefs: [ref], checks: checks.slice(0, 2), issues: legacy }
  const v11 = { ...expected, admission: { chinese: true as const, briefText: '雾港。' } }
  expect(parseReviewOutput(legacyOutput, v11).issues).toEqual(legacy)
  expect(parseReviewOutput(legacyOutput, { reviewed, inputRefs: [ref], requiredChecks: v11.requiredChecks, evidenceSources: v11.evidenceSources }).issues).toEqual(legacy)
  expect(() => parseReviewOutput({ ...legacyOutput, checks }, expected)).toThrow(/category pov/)
})

function taskOf(prompt: string): { validationError?: string | null; requiredChecks?: string[]; povHeuristic?: { viewpoint: string | null; hints: { excerpt: string }[] } } {
  const body = prompt.split('\n\nTASK_DATA\n\n')[1] ?? '{}'
  const hosted = body.indexOf('\n\nHOST_INPUTS\n\n')
  const json = hosted < 0 ? body : body.slice(0, hosted)
  return JSON.parse((JSON.parse(json) as { task: string }).task) as { validationError?: string | null; requiredChecks?: string[]; povHeuristic?: { viewpoint: string | null; hints: { excerpt: string }[] } }
}

it('passes an other-mind hint to the version-12 reviewer and still applies the chapter', async () => {
  const fixture = await useWritingFixture({
    backend: 'sqlite',
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'chapter-outline' && (stage.task?.validationError ?? null) === null && stage.data.kind === 'chapter-outline' && !stage.data.requirements.some(item => item.includes('outline patch'))) {
        const outline = StageOutputSchemas['chapter-outline'].parse(output)
        return { ...outline, constraints: [...outline.constraints, '视角人物：林澜'] }
      }
      if (stage.kind === 'body' && stage.task?.chapterNumber === 1 && stage.data.kind === 'body' && !stage.data.requirements.some(item => item.includes('body patch'))) {
        const body = StageOutputSchemas.body.parse(output)
        return { ...body, scenes: body.scenes.map((scene, index) => index === 0 ? { ...scene, text: `${scene.text}${otherMind}` } : scene) }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  expect(outcome.value.promptVersion).toBe(14)
  const review = [...fixture.stages.values()].find(stage => stage.kind === 'review' && typeof stage.task?.measuredWordCount === 'number')
  if (review === undefined) throw new Error('body review did not run')
  const task = taskOf(review.prompt)
  expect(task.requiredChecks).toContain('pov')
  expect(task.povHeuristic?.viewpoint).toBe('林澜')
  expect(task.povHeuristic?.hints.map(hint => hint.excerpt)).toContain('韩铁衣心想')
  expect(task.validationError ?? null).toBeNull()
  expect(review.prompt).toContain('fixed check pov-limited')
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const chapter = manuscript.appliedChapters[0]
  if (chapter === undefined) throw new Error('chapter was not applied')
  const stored = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: chapter.body.id }).text))
  expect(stored.scenes.some(scene => scene.text.includes(otherMind))).toBe(true)
}, 120_000)

it('does not run the host POV check when a version-11 run resumes', async () => {
  const fixture = await useWritingFixture({
    backend: 'sqlite',
    executionLimits: { researchEnabled: false, maxRepairAttempts: 0 },
    intervene(stage, output) {
      if (stage.kind === 'body' && stage.task?.chapterNumber === 1 && stage.data.kind === 'body') {
        const body = StageOutputSchemas.body.parse(output)
        return { ...body, scenes: body.scenes.map((scene, index) => index === 0 ? { ...scene, text: `${scene.text}${otherMind}` } : scene) }
      }
      return output
    },
  })
  const begun = await fixture.runs.begin(fixture.actor, {
    ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
    executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits },
  }, 11)
  await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stored on prompt version 11.')
  const outcome = await fixture.run(exec => fixture.runner.resume(exec, begun.id, false))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  expect(outcome.value.promptVersion).toBe(11)
  const review = [...fixture.stages.values()].find(stage => stage.kind === 'review' && typeof stage.task?.measuredWordCount === 'number')
  if (review === undefined) throw new Error('body review did not run')
  const task = taskOf(review.prompt)
  expect(task.requiredChecks ?? []).not.toContain('pov')
  expect(task.povHeuristic).toBeUndefined()
  expect(review.prompt).toContain('task.metrics')
  expect(review.prompt).not.toContain('fixed check pov-limited')
  expect(review.prompt).not.toContain('povHeuristic')
}, 120_000)

it('stores a version-11 pov-limited id on a non-pov category and reads it back unchanged on resume', async () => {
  const legacy = { id: 'pov-limited', severity: 'advisory' as const, category: 'style' as const, location: '整章', message: '这是旧版审查里的一条普通意见。' }
  const fixture = await useWritingFixture({
    backend: 'sqlite',
    executionLimits: { researchEnabled: false, maxRepairAttempts: 0 },
    intervene(stage, output) {
      if (stage.kind !== 'review' || typeof stage.task?.measuredWordCount !== 'number') return output
      const review = output as { checks: { evidence: unknown }[]; issues: unknown[] }
      return { ...review, issues: [...review.issues, { ...legacy, evidence: review.checks[0]!.evidence }] }
    },
  })
  const begun = await fixture.runs.begin(fixture.actor, {
    ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
    executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits },
  }, 11)
  await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stored on prompt version 11.')
  const outcome = await fixture.run(exec => fixture.runner.resume(exec, begun.id, false))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  expect(outcome.value.promptVersion).toBe(11)
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const body = manuscript.history.find(item => item.target.kind === 'body' && item.review !== null)
  if (body?.review === null || body?.review === undefined) throw new Error('stored body review is missing')
  const stored = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: body.review.id }).text) as { issues: { id: string; paragraphId?: string }[] }
  const issue = stored.issues.find(item => item.id === 'pov-limited')
  expect(issue).toMatchObject(legacy)
  expect(issue).not.toHaveProperty('paragraphId')
}, 120_000)
