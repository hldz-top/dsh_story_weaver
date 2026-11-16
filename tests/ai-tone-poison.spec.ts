/** Prompt version 13: optional style poison, default repair floor heavy, clean-body fallback, and no whole-chapter style failure. */
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { aiToneHits, aiToneRepairAction, detectAiTone, gradeAiTone, gradeMeetsRepairFloor, selectPoisonRepairHits, type AiToneGrade, type AiTonePoison, type AiToneRepairFloor } from '../src/ai-tone.ts'
import { artifactMarkdown } from '../src/artifact-markdown.ts'
import { aiTonePoisonRepairInstruction, parseArtifactId, parseNovelId, type Artifact, type ArtifactKind } from '../src/contracts.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { parseReviewOutput } from '../src/stage-output.ts'
import { buildStagePrompt, type StagePromptKind } from '../src/stage-prompts.ts'
import type { RunExecutionLimits, WritingRun } from '../src/run-store.ts'
import { useWritingFixture, type WritingFixtureOptions, type WritingFixtureStage } from './support/writing-fixture.ts'
import { createHash } from 'node:crypto'

const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']
const sourceId = parseArtifactId('artifact_00000000-0000-4000-8000-000000000001')
const quote = '灯塔终于亮了。'

function lastLine(text: string | null | undefined): Record<string, unknown> {
  return JSON.parse((text ?? '').split('\n').at(-1) ?? 'null') as Record<string, unknown>
}

describe('poison repair decision', () => {
  const floors: readonly AiToneRepairFloor[] = ['hint', 'notice', 'heavy']
  const grades: readonly AiToneGrade[] = ['hint', 'notice', 'heavy']

  it('treats the floor as the lowest grade that repairs', () => {
    for (const floor of floors) for (const grade of grades) {
      const meets = gradeMeetsRepairFloor(grade, floor)
      expect(meets, `${grade} vs ${floor}`).toBe(grades.indexOf(grade) >= grades.indexOf(floor))
    }
  })

  it('repairs only a present poison other than none whose grade meets the floor', () => {
    expect(aiToneRepairAction({ poison: 'forced', rule: 'dash', grade: 'heavy', floor: 'heavy' })).toBe('repair')
    expect(aiToneRepairAction({ poison: 'false-target', rule: 'reversal', grade: 'heavy', floor: 'heavy' })).toBe('repair')
    expect(aiToneRepairAction({ poison: 'synonym', rule: 'enumeration', grade: 'heavy', floor: 'heavy' })).toBe('repair')
    expect(aiToneRepairAction({ poison: 'forced', rule: 'dash', grade: 'notice', floor: 'heavy' })).toBe('record')
    expect(aiToneRepairAction({ poison: 'forced', rule: 'dash', grade: 'hint', floor: 'heavy' })).toBe('ignore')
    expect(aiToneRepairAction({ poison: 'none', rule: 'reversal', grade: 'heavy', floor: 'heavy' })).toBe('ignore')
    expect(aiToneRepairAction({ poison: undefined, rule: 'reversal', grade: 'heavy', floor: 'heavy' })).toBe('ignore')
    expect(aiToneRepairAction({ poison: 'dash', rule: 'dash', grade: 'heavy', floor: 'heavy' })).toBe('ignore')
    expect(aiToneRepairAction({ poison: 'forced', rule: 'dash', grade: 'notice', floor: 'notice' })).toBe('repair')
    expect(aiToneRepairAction({ poison: 'forced', rule: 'dash', grade: 'hint', floor: 'hint' })).toBe('repair')
    expect(aiToneRepairAction({ poison: 'not-a-poison', rule: 'dash', grade: 'heavy', floor: 'heavy' })).toBe('ignore')
  })

  it('selects a heavy dash covered by the quote and skips a notice and a hint', () => {
    const heavy = `${'——'.repeat(8)}短。`
    const notice = `${'他看着灯。'.repeat(200)}灯塔——终于亮了。`
    const hint = `${'他看着灯。'.repeat(800)}灯塔——终于亮了。`
    const pick = (text: string, poison: AiTonePoison | undefined) => {
      const narration = aiToneHits(text)
      const grades = new Map(gradeAiTone(detectAiTone(text)).markers.map(marker => [marker.rule, marker.grade]))
      return selectPoisonRepairHits({
        narration: narration.narration, hits: narration.hits, grades, floor: 'heavy', bodyArtifactId: sourceId,
        issues: [{ category: 'style', ...(poison === undefined ? {} : { poison }), evidence: [{ artifactId: sourceId, quote: text }] }],
      })
    }
    expect(gradeAiTone(detectAiTone(heavy)).markers.find(marker => marker.rule === 'dash')?.grade).toBe('heavy')
    expect(gradeAiTone(detectAiTone(notice)).markers.find(marker => marker.rule === 'dash')?.grade).toBe('notice')
    expect(gradeAiTone(detectAiTone(hint)).markers.find(marker => marker.rule === 'dash')?.grade).toBe('hint')
    expect(pick(heavy, 'forced').spans).toEqual(['——'])
    expect(pick(notice, 'forced').spans).toEqual([])
    expect(pick(hint, 'forced').spans).toEqual([])
    expect(pick(heavy, 'none').spans).toEqual([])
    expect(pick(heavy, undefined).spans).toEqual([])
  })

  it('does not repair the legitimate reversal 我爱上的不是你的容貌，而是你的灵魂', () => {
    const sentence = '我爱上的不是你的容貌，而是你的灵魂'
    const narration = aiToneHits(sentence)
    const grades = new Map(gradeAiTone(detectAiTone(sentence)).markers.map(marker => [marker.rule, marker.grade]))
    expect(grades.get('reversal')).toBe('heavy')
    const pick = (poison: AiTonePoison | undefined) => selectPoisonRepairHits({
      narration: narration.narration, hits: narration.hits, grades, floor: 'heavy', bodyArtifactId: sourceId,
      issues: [{ category: 'style', ...(poison === undefined ? {} : { poison }), evidence: [{ artifactId: sourceId, quote: sentence }] }],
    })
    expect(pick('none').spans).toEqual([])
    expect(pick(undefined).spans).toEqual([])
    expect(pick('forced').spans.length).toBeGreaterThan(0)
  })
})

describe('version 13 prompt and schema', () => {
  it('changes only the body-review sentence and publishes optional poison', () => {
    for (const kind of kinds) {
      const reviewed = kind === 'review' ? { reviewedKind: 'body' as const } : {}
      const v12 = buildStagePrompt({ ...base, kind, promptVersion: 12, ...reviewed })
      const v13 = buildStagePrompt({ ...base, kind, promptVersion: 13, ...reviewed })
      if (kind === 'review') {
        expect(v12).toContain('density-graded hint report')
        expect(v12).toContain('fixed check pov-limited')
        expect(v12).toContain('task.metrics')
        expect(v12).not.toContain('optional poison')
        expect(v12).not.toContain('false-target')
        expect(v13).toContain('optional poison')
        expect(v13).toContain('false-target')
        expect(v13).toContain('synonym')
        expect(v13).toContain('forced')
        expect(v13).toContain('fixed check pov-limited')
        expect(v13).toContain('task.metrics')
        expect(v13).toContain('The floor is heavy')
        expect(v13).toContain('never fail the chapter')
        expect(v13).not.toContain('the host itself blocks the chapter')
        expect(v13).not.toBe(v12)
      } else expect(v13, kind).toBe(v12)
    }
    expect(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'chapter-outline', promptVersion: 13 }))
      .toBe(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'chapter-outline', promptVersion: 12 }))
    expect(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 12, aiToneRepairFloor: 'notice' }))
      .toBe(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 12 }))
    expect(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 13, aiToneRepairFloor: 'notice' })).toContain('The floor is notice')
    expect(JSON.stringify(nativeStageOutputSchema('review', 12))).toContain('"pov"')
    expect(JSON.stringify(nativeStageOutputSchema('review', 12))).not.toContain('poison')
    expect(JSON.stringify(nativeStageOutputSchema('review', 11))).not.toContain('poison')
    expect(JSON.stringify(nativeStageOutputSchema('continuity', 13))).toBe(JSON.stringify(nativeStageOutputSchema('continuity', 12)))
    expect(JSON.stringify(nativeStageOutputSchema('continuity', 13))).toContain('name_note')
    expect(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 13))).toBe(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 12)))
    expect(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 13))).not.toContain('name_note')
    const published = nativeStageOutputSchema('review', 13)
    expect(published.properties?.issues?.items?.properties?.poison?.enum).toEqual(['false-target', 'synonym', 'forced', 'none'])
    expect(published.properties?.issues?.items?.required).not.toContain('poison')
    const paragraph = { paragraphId: 'p1', problem: '灯塔终于亮了。' }
    const review = { version: 1, inputRefs: [{ artifactId: sourceId, sha256: 'a'.repeat(64) }], reviewed: { artifactId: sourceId, sha256: 'a'.repeat(64) },
      checks: [{ category: 'completeness', summary: '完整。', evidence: [paragraph] }], issues: [] }
    expect(validateJsonSchemaValue(published, review)).toEqual([])
    const styleIssue = { id: 'ai-tone-1', severity: 'advisory', category: 'style', location: '旁白', message: '破折号过密。', evidence: [paragraph] }
    expect(validateJsonSchemaValue(published, { ...review, issues: [{ ...styleIssue, poison: 'forced' }] })).toEqual([])
    expect(validateJsonSchemaValue(published, { ...review, issues: [{ ...styleIssue, poison: 'dash' }] })).not.toEqual([])
    expect(validateJsonSchemaValue(nativeStageOutputSchema('review', 12), { ...review, issues: [{ ...styleIssue, poison: 'forced' }] })).not.toEqual([])
  })

  it('keeps poison on a style issue and rejects it everywhere else', () => {
    const reviewed = { artifactId: sourceId, sha256: 'a'.repeat(64) }
    const evidence = [{ artifactId: sourceId, quote }]
    const expected = { reviewed, inputRefs: [reviewed], requiredChecks: ['completeness'] as const, evidenceSources: [{ artifactId: sourceId, text: quote }] }
    const review = (issue: object) => ({ version: 1, inputRefs: [reviewed], reviewed, checks: [{ category: 'completeness', summary: '完整。', evidence }], issues: [issue] })
    const style = { id: 'ai-tone-1', severity: 'advisory', category: 'style', location: '旁白', message: '破折号过密。', evidence }
    expect(parseReviewOutput(review({ ...style, poison: 'forced' }), expected).issues[0]?.poison).toBe('forced')
    expect(parseReviewOutput(review({ ...style, poison: 'none' }), expected).issues[0]?.poison).toBe('none')
    expect(parseReviewOutput(review(style), expected).issues[0]).not.toHaveProperty('poison')
    expect(() => parseReviewOutput(review({ ...style, poison: 'dash' }), expected)).toThrow()
    expect(() => parseReviewOutput(review({ id: 'gap', severity: 'blocking', category: 'completeness', location: '简报', message: '缺一件必写事件。', poison: 'forced', evidence }), expected)).toThrow(/poison belongs only on a style issue/)
    expect(() => parseReviewOutput(review({ ...style, severity: 'blocking', poison: 'forced' }), expected)).toThrow(/advisory/)
  })

  it('renders poison when the stored issue has one', () => {
    const novelId = parseNovelId('novel_00c38d7c-50d8-4a1b-93f0-188daf5a9859')
    const id = parseArtifactId('artifact_00c38d7c-50d8-4a1b-93f0-188daf5a9859')
    const text = JSON.stringify({ version: 1, inputRefs: [{ artifactId: id, sha256: 'a'.repeat(64) }], reviewed: { artifactId: id, sha256: 'b'.repeat(64) },
      checks: [{ category: 'completeness', summary: '完整。', evidence: [{ artifactId: id, quote }] }],
      issues: [{ id: 'ai-tone-1', severity: 'advisory', category: 'style', location: '旁白', message: '破折号过密。', poison: 'forced', evidence: [{ artifactId: id, quote }] }] })
    const artifact = (kind: ArtifactKind, body: string): Artifact => ({ id, novelId, kind, revision: 1, text: body, chars: [...body].length, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') })
    expect(artifactMarkdown(artifact('review', text))).toContain('Poison: forced')
    const plain = text.replace(',"poison":"forced"', '')
    expect(artifactMarkdown(artifact('review', plain))).not.toContain('Poison:')
  })
})

const isBody = (stage: WritingFixtureStage) => stage.kind === 'body'
const isBodyReview = (stage: WritingFixtureStage) => stage.kind === 'review' && typeof stage.task?.measuredWordCount === 'number'

async function scripted(script: {
  readonly prefix: (attempt: number) => string
  readonly quotes: (review: number) => readonly string[]
  readonly poison?: (review: number, index: number) => AiTonePoison | undefined
  readonly blocking?: (review: number) => boolean
}, options: WritingFixtureOptions = {}) {
  let bodies = 0
  let reviews = 0
  let previousPrefix = ''
  const bodyTasks: (string | null | undefined)[] = []
  const fixture = await useWritingFixture({ maxReadChars: 8192, ...options, intervene(stage, output) {
    if (isBody(stage)) {
      bodyTasks.push(stage.task?.validationError)
      const prefix = script.prefix(bodies++)
      const priorPrefix = previousPrefix
      previousPrefix = prefix
      const strip = (text: string) => priorPrefix !== '' && text.startsWith(priorPrefix) ? text.slice(priorPrefix.length) : text
      const requirements = 'requirements' in stage.data ? stage.data.requirements : []
      if (requirements.some(item => item.includes('Return a body patch'))) {
        const stored = [...stage.sources.values()].find(item => item.kind === 'body')
        if (stored === undefined) throw new Error('Body patch has no admitted body')
        const prior = JSON.parse(stored.text) as { scenes: { text: string }[] }
        return { version: 1, changes: prior.scenes.map((scene, index) => ({
          op: 'set', path: `scenes[${index}].text`,
          value: index === 0 ? `${prefix}${strip(scene.text)}` : scene.text,
        })) }
      }
      const body = output as { scenes: { sceneId: string; text: string }[] }
      return { ...body, scenes: body.scenes.map((scene, index) => index === 0 ? { ...scene, text: `${prefix}${scene.text}` } : scene) }
    }
    if (isBodyReview(stage)) {
      const reviewIndex = reviews++
      const paragraphs = stage.task?.paragraphs ?? []
      const issues: object[] = script.quotes(reviewIndex).map((quoted, index) => {
        const paragraph = paragraphs.find(item => item.text.includes(quoted)) ?? paragraphs[0]
        if (paragraph === undefined) throw new Error('Body review has no paragraph to cite')
        const poison = script.poison?.(reviewIndex, index)
        return { id: `ai-tone-${index + 1}`, severity: 'advisory', category: 'style', location: '第一段旁白', message: '旁白里的破折号过密。',
          ...(poison === undefined ? {} : { poison }), evidence: [{ paragraphId: paragraph.id, problem: '这一段旁白里的破折号过密。' }] }
      })
      if (script.blocking?.(reviewIndex) === true) {
        const paragraph = paragraphs[0]
        if (paragraph === undefined) throw new Error('Body review has no paragraph to cite')
        issues.push({ id: 'conflict-1', severity: 'blocking', category: 'consistency', location: '第一段', message: '后文与已写事实矛盾。', evidence: [{ paragraphId: paragraph.id, problem: '后文与已写事实矛盾。' }] })
      }
      const review = output as { issues: object[] }
      return { ...review, issues: [...review.issues, ...issues] }
    }
    return output
  } })
  return { fixture, bodyTasks, counts: () => ({ bodies, reviews }) }
}

async function write(fixture: Awaited<ReturnType<typeof useWritingFixture>>, version: 11 | 12 | 13 = 13): Promise<WritingRun> {
  const begun = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
    executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, version)
  await fixture.runs.finish(fixture.actor, begun.id, 'stopped', `Stored on prompt version ${version}.`)
  const outcome = await fixture.run(exec => fixture.runner.resume(exec, begun.id, false))
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}

function applied(fixture: Awaited<ReturnType<typeof useWritingFixture>>): boolean {
  return fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters.some(item => item.chapterNumber === 1)
}

function storedPoison(fixture: Awaited<ReturnType<typeof useWritingFixture>>): unknown {
  const chapter = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters.find(item => item.chapterNumber === 1)
  if (chapter === undefined) throw new Error('Chapter was not applied')
  const review = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: chapter.bodyReview.id }).text) as { issues: { id?: string; poison?: string }[] }
  return review.issues.find(issue => issue.id === 'ai-tone-1')?.poison
}

describe('version 13 repairs a heavy poison and still applies the chapter', () => {
  it('rewrites a heavy dash and applies the clean repair', { timeout: 120_000 }, async () => {
    const { fixture, bodyTasks, counts } = await scripted({
      prefix: attempt => attempt === 0 ? '——'.repeat(80) : '',
      quotes: review => review === 0 ? ['——'] : [],
      poison: review => review === 0 ? 'forced' : undefined,
    })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', promptVersion: 13, error: null, executionLimits: { aiToneRepairFloor: 'heavy', metricsBlocking: false } })
    expect(counts()).toEqual({ bodies: 2, reviews: 2 })
    expect(lastLine(bodyTasks[1])).toEqual({ code: 'style-repair', reason: 'ai-tone-poison', spans: ['——'] })
    expect(lastLine(aiTonePoisonRepairInstruction(['——']))).toEqual({ code: 'style-repair', reason: 'ai-tone-poison', spans: ['——'] })
    expect(run.attempts.filter(attempt => /^body\/1\/candidate\/\d+\/review\//u.test(attempt.key)).every(attempt => attempt.aiToneBlock === undefined)).toBe(true)
    expect(applied(fixture)).toBe(true)
  })

  it.each([
    ['notice', '——'.repeat(10)],
    ['hint', '——'],
  ] as const)('does not repair a %s dash', { timeout: 120_000 }, async (_grade, prefix) => {
    const { fixture, bodyTasks } = await scripted({ prefix: () => prefix, quotes: () => ['——'], poison: () => 'forced' })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(bodyTasks).toHaveLength(1)
    expect(applied(fixture)).toBe(true)
    expect(storedPoison(fixture)).toBe('forced')
  })

  it.each([
    ['none', 'none' as const],
    ['omitted', undefined],
  ] as const)('does not repair a heavy dash whose poison is %s', { timeout: 120_000 }, async (_label, poison) => {
    const { fixture, bodyTasks } = await scripted({
      prefix: () => '——'.repeat(80), quotes: () => ['——'],
      ...(poison === undefined ? {} : { poison: () => poison }),
    })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(bodyTasks).toHaveLength(1)
    expect(applied(fixture)).toBe(true)
    expect(storedPoison(fixture)).toBe(poison)
  })

  it('applies the chapter when the same heavy poison remains', { timeout: 120_000 }, async () => {
    const { fixture, counts } = await scripted({ prefix: () => '——'.repeat(80), quotes: () => ['——'], poison: () => 'forced' }, { executionLimits: { maxRepairAttempts: 1 } })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(counts().bodies).toBe(2)
    expect(applied(fixture)).toBe(true)
    expect(run.error).toBeNull()
  })

  it('applies the chapter when no body repair is configured', { timeout: 120_000 }, async () => {
    const { fixture, bodyTasks } = await scripted({ prefix: () => '——'.repeat(80), quotes: () => ['——'], poison: () => 'forced' }, { executionLimits: { maxRepairAttempts: 0 } })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(bodyTasks).toHaveLength(1)
    expect(applied(fixture)).toBe(true)
  })

  it('repairs a notice when the recorded floor is notice', { timeout: 120_000 }, async () => {
    const { fixture, bodyTasks } = await scripted({
      prefix: attempt => attempt === 0 ? '——'.repeat(10) : '',
      quotes: review => review === 0 ? ['——'] : [],
      poison: review => review === 0 ? 'forced' : undefined,
    }, { executionLimits: { aiToneRepairFloor: 'notice' } })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null, executionLimits: { aiToneRepairFloor: 'notice' } })
    expect(bodyTasks).toHaveLength(2)
    expect(lastLine(bodyTasks[1]).reason).toBe('ai-tone-poison')
    expect(applied(fixture)).toBe(true)
  })

  it.each([
    ['none', 'none' as const],
    ['omitted', undefined],
  ] as const)('does not repair a heavy legitimate reversal whose poison is %s', { timeout: 120_000 }, async (_label, poison) => {
    const soul = '我爱上的不是你的容貌，而是你的灵魂'
    const { fixture, bodyTasks } = await scripted({
      prefix: () => soul.repeat(24), quotes: () => [soul],
      ...(poison === undefined ? {} : { poison: () => poison }),
    })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(bodyTasks).toHaveLength(1)
    expect(applied(fixture)).toBe(true)
    expect(storedPoison(fixture)).toBe(poison)
  })

  it('repairs that same reversal when the reviewer marks it forced', { timeout: 120_000 }, async () => {
    const soul = '我爱上的不是你的容貌，而是你的灵魂'
    const { fixture, bodyTasks, counts } = await scripted({
      prefix: attempt => attempt === 0 ? soul.repeat(24) : '',
      quotes: review => review === 0 ? [soul] : [],
      poison: review => review === 0 ? 'forced' : undefined,
    })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(counts()).toEqual({ bodies: 2, reviews: 2 })
    expect(lastLine(bodyTasks[1]).reason).toBe('ai-tone-poison')
    expect(applied(fixture)).toBe(true)
  })

  it('applies the last clean body when later poison rounds gain a blocking issue', { timeout: 120_000 }, async () => {
    const marker = '——'.repeat(80)
    const { fixture, counts } = await scripted({
      prefix: attempt => attempt === 0 ? marker : '雨停了，他走了。',
      quotes: review => review === 0 ? ['——'] : [],
      poison: review => review === 0 ? 'forced' : undefined,
      blocking: review => review > 0,
    }, { executionLimits: { maxRepairAttempts: 1 } })
    const run = await write(fixture)
    expect(run).toMatchObject({ status: 'completed', error: null })
    expect(run.error).toBeNull()
    expect(counts().bodies).toBe(3)
    expect(applied(fixture)).toBe(true)
    const chapter = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters.find(item => item.chapterNumber === 1)
    if (chapter === undefined) throw new Error('Chapter was not applied')
    const body = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: chapter.body.id }).text) as { scenes: { text: string }[] }
    expect(body.scenes[0]?.text.startsWith(marker)).toBe(true)
    const review = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: chapter.bodyReview.id }).text) as { issues: { id?: string; severity?: string; poison?: string }[] }
    expect(review.issues.find(issue => issue.id === 'ai-tone-1')).toMatchObject({ severity: 'advisory', poison: 'forced' })
    expect(review.issues.some(issue => issue.severity === 'blocking')).toBe(false)
  })

  it('stays review-blocked when the chapter was never clean', { timeout: 120_000 }, async () => {
    const { fixture } = await scripted({
      prefix: () => '',
      quotes: () => [],
      blocking: () => true,
    }, { executionLimits: { maxRepairAttempts: 0 } })
    const run = await write(fixture)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('Repair limit was exhausted')
    expect(applied(fixture)).toBe(false)
  })
})

describe('older runs do not record the floor', () => {
  it('strips a caller-supplied floor from a version-12 run', async () => {
    const fixture = await useWritingFixture()
    const limits: RunExecutionLimits = { ...fixture.runner.limits, aiToneRepairFloor: 'notice' }
    const begun = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 12)
    expect(begun.promptVersion).toBe(12)
    expect(begun.executionLimits).not.toHaveProperty('aiToneRepairFloor')
    expect(begun.executionLimits.metricsBlocking).toBe(false)
    expect(begun.executionLimits.aiToneBlocking).toBe(true)
  })

  it('refuses resume when the recorded floor differs', async () => {
    const fixture = await useWritingFixture()
    const begun = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: { ...fixture.runner.limits, aiToneRepairFloor: 'notice' }, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } })
    const stopped = await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stopped before native work.')
    expect(stopped.executionLimits.aiToneRepairFloor).toBe('notice')
    const outcome = await fixture.run(exec => fixture.runner.resume(exec, stopped.id, false))
    expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'run-limits' } })
    if (outcome.status !== 'rejected') throw new Error('Resume was not refused')
    expect(lastLine(outcome.reason.message)).toEqual({ code: 'run-limits', mismatched: [{ key: 'aiToneRepairFloor', saved: 'notice', current: 'heavy' }] })
    expect(fixture.runs.get(fixture.actor, stopped.id)).toEqual(stopped)
  })
})
