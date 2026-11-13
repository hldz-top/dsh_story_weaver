/** Prompt versioning: version-1 runs keep their exact original prompts and schemas; new runs get the chapter-quality guardrails. */
import { createHash } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { detectAiTone } from '../src/ai-tone.ts'
import { measureBeats } from '../src/body-text.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { buildStagePrompt, CURRENT_PROMPT_VERSION, type StagePromptKind } from '../src/stage-prompts.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity']
/** SHA-256 of buildStagePrompt / nativeStageOutputSchema output on main a33b4c7 (before versioning), for the request above. */
const frozen: Record<string, string> = {
  settings: '665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87',
  review: '8b5f910f366e95085e3157e6c72d9ac461792233d3bbc6451093b2321ec2bc90',
  'book-outline': '7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0',
  'chapter-outline': '76476009a90f4448b8be4199f46249840b54cf2baf91210b00cbf8197fc81124',
  body: '4876dcaedc3fe01c4a6da07abbe298a42cdab24456d33fa8ab21c4ca7da521bf',
  continuity: 'a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d',
  'settings/enum_single': '1724c29d14ee5c2bc7460f3c2356d1e00b099671a823a1cc7f4ee4302068d78c',
  'review/collection': '73997c9af419645bacbe4136c323ab74313a6343c23d10ed20556fd3ce3d8b50',
  'review/enum_multi': '36c515ad05686d44b67f252c5d4aaa2a0b7c60360d73fd30606ff94dd965f390',
  'schema/settings': '86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b',
  'schema/review': '9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3',
  'schema/book-outline': '62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2',
  'schema/chapter-outline': '331f97fb15c82e27968c9d401d51070695d20fc8dcf01203facfb02b05114e20',
  'schema/body': '21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3',
  'schema/continuity': 'ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0',
}
/** One distinctive phrase per version-2 sentence, keyed by the stage that carries it. */
const guardrails: Record<string, readonly string[]> = {
  review: ['task.measuredBeats', 'no physical form written as a physical object'],
  body: ['instructions for writing, not text', 'technical or financial metaphors', '这条路的气密性比我的信用评级还差', 'carry each scene with dialogue', 'tool or equipment list in the settings'],
  'chapter-outline': ['cannot all hold', 'stateNotes'],
}
const allGuardrails = Object.values(guardrails).flat()
/** Distinctive phrase of the version-3 AI-tone review sentence. */
const AI_TONE_PHRASE = 'task.aiToneMarkers'
/** Distinctive phrase of the version-4 AI-tone body-writing rule. */
const AI_TONE_WRITING_PHRASE = 'Keep the narration free of AI tone'

describe('version 1 is frozen', () => {
  it('rebuilds every pre-versioning prompt byte for byte, with the version omitted or explicit', () => {
    for (const promptVersion of [undefined, 1] as const) {
      const version = promptVersion === undefined ? {} : { promptVersion }
      for (const kind of kinds) expect(sha(buildStagePrompt({ ...base, kind, ...version })), kind).toBe(frozen[kind])
      expect(sha(buildStagePrompt({ ...base, kind: 'settings', settingsDimensionKind: 'enum_single', ...version }))).toBe(frozen['settings/enum_single'])
      expect(sha(buildStagePrompt({ ...base, kind: 'review', settingsCollectionKinds: { a1: 'enum_single', e1: 'llm_free' }, ...version }))).toBe(frozen['review/collection'])
      expect(sha(buildStagePrompt({ ...base, kind: 'review', settingsDimensionKind: 'enum_multi', ...version }))).toBe(frozen['review/enum_multi'])
    }
  })

  it('publishes every pre-versioning output schema unchanged, so chapter outlines omit stateNotes', () => {
    for (const kind of kinds) expect(sha(JSON.stringify(nativeStageOutputSchema(kind, 1))), kind).toBe(frozen[`schema/${kind}`])
  })
})

/** SHA-256 of every version-4 prompt and output schema for the request above (computed on #22 head d7edafb), so later edits cannot silently change what resumed v4 runs rebuild. */
const frozenV4: Record<string, string> = {
  'settings': '665f40d01dc0b8663aa8a00c64abaf1013f7ffd89430d6065ffdf394e23c6c87',
  'review': 'c465e5f1f7a6dc09f66c3504c0e2efa503b0871e92cc38f1a03456d09304c87a',
  'book-outline': '7100a4c61a77ddecd3e35d714e395297db81c2a1ebe052274d71bda6bc9b65e0',
  'chapter-outline': 'ccc93e46f610fcd8a4aa2d63b4a8147bb832d0313833a264a8a132d52a745eaf',
  'body': 'e8ccabfe084b9f215c915a31353df9187e46f0fb33aa74a1daaf06bfb3e9a998',
  'continuity': 'a9798b274e9f7b347f476ac25dcca939a48a5fdba07185cd2c6db1d4716d3c9d',
  'review/body': '48aa58cd632cc1c1f81a984282debb8dd73b451c41e97966e278ca37745fd773',
  'schema/settings': '86f66293e41cd6e5b92d64ddf6f3a39536affacde2e0c2e4ce60a05fca94c88b',
  'schema/review': '9731f7a748dd104095730772ad5cd0885a45340c865f1d7d0b75da95336c09c3',
  'schema/book-outline': '62d1e8b93ee5b030549ba85fd483fc7fa12e409a63d224ee07fe0c26fd2ce0d2',
  'schema/chapter-outline': '0285fb25e15cbfed01a7b157e83bdb5061ffeda3a999d11c6b2b69518d2f8ef5',
  'schema/body': '21d5342669c4439400a3ff71b4bc16f297d262abfb823ac9f1868f57a32152f3',
  'schema/continuity': 'ee4f82a9defc694c00b3c0b506310ae3ab5a998b5b9214bf291da121417b8ae0'
}

describe('version 4 is frozen', () => {
  it('rebuilds every version-4 prompt and schema byte for byte', () => {
    for (const kind of kinds) expect(sha(buildStagePrompt({ ...base, kind, promptVersion: 4 })), kind).toBe(frozenV4[kind])
    expect(sha(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 4 }))).toBe(frozenV4['review/body'])
    for (const kind of kinds) expect(sha(JSON.stringify(nativeStageOutputSchema(kind, 4))), kind).toBe(frozenV4[`schema/${kind}`])
  })
})

/**
 * A body whose dash hit has emoji and 𠀀 inside its 8-unit marker context, cut mid surrogate pair on both sides. SHA-256 of
 * the version-4 body-review prompt carrying detectAiTone(body) as task.aiToneMarkers, computed by building d7edafb (#22 head,
 * before aiToneBlocking) with the same request, so resumed v3/v4 runs keep sending identical bytes.
 */
const ASTRAL_BODY = '雾港😀😀😀😀😀灯——𠀀𠀀𠀀灯𠀀塔亮了。'
const ASTRAL_REVIEW_V4 = 'b3b46a65f334c9316ecdd6a0c36035f84e7331725726bce8a4288ef6a3c1c55a'

describe('version 4 AI-tone markers are frozen', () => {
  it('rebuilds the marker excerpts and review prompt of d7edafb byte for byte, astral context included', () => {
    const report = detectAiTone(ASTRAL_BODY)
    // UTF-16 window kept as is for every version: it may cut a surrogate pair, and only the prompt sees it (JSON-escaped).
    expect(report.markers.flatMap(marker => marker.examples)).toEqual(['\uDE00😀😀😀灯——𠀀𠀀𠀀灯\uD840'])
    const prompt = buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 4, task: JSON.stringify({ aiToneMarkers: report }) })
    expect(prompt.isWellFormed()).toBe(true)
    expect(sha(prompt)).toBe(ASTRAL_REVIEW_V4)
  })
})

describe('version 3 AI-tone review', () => {
  it('adds the AI-tone sentence only to reviews of a body', () => {
    for (const reviewedKind of kinds) {
      const prompt = buildStagePrompt({ ...base, kind: 'review', reviewedKind, promptVersion: 3 })
      expect(prompt.includes(AI_TONE_PHRASE), reviewedKind).toBe(reviewedKind === 'body')
    }
    expect(buildStagePrompt({ ...base, kind: 'review', promptVersion: 3 })).not.toContain(AI_TONE_PHRASE)
    for (const kind of kinds) if (kind !== 'review') expect(buildStagePrompt({ ...base, kind, reviewedKind: 'body', promptVersion: 3 }), kind).not.toContain(AI_TONE_PHRASE)
  })
})

describe('version 2 guardrails', () => {
  it('is followed by version 7 for new runs', () => { expect(CURRENT_PROMPT_VERSION).toBe(7) })

  it('appends each sentence only to its own stage', () => {
    for (const kind of kinds) {
      const prompt = buildStagePrompt({ ...base, kind, promptVersion: 2 })
      for (const phrase of allGuardrails) expect(prompt.includes(phrase), `${kind}: ${phrase}`).toBe((guardrails[kind] ?? []).includes(phrase))
      expect(prompt, kind).not.toContain(AI_TONE_PHRASE)
      expect(prompt, kind).not.toContain(AI_TONE_WRITING_PHRASE)
    }
  })

  it('offers stateNotes as an optional free-text list without enums', () => {
    const schema = nativeStageOutputSchema('chapter-outline', 2) as { properties: Record<string, unknown> }
    expect(schema.properties.stateNotes).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(JSON.stringify(schema.properties.stateNotes)).not.toContain('enum')
    expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 1))).not.toContain('stateNotes')
    const outline = { version: 1, inputRefs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001', sha256: '0'.repeat(64) }], chapterNumber: 1, title: 't', targetWords: 10,
      throughLine: 'x', constraints: [], obligations: [], scenes: [{ id: 's1', purpose: 'p', action: 'a', obligationIds: [] }] }
    expect(StageOutputSchemas['chapter-outline'].parse(outline)).not.toHaveProperty('stateNotes')
    expect(StageOutputSchemas['chapter-outline'].parse({ ...outline, stateNotes: ['漏缝：门框上沿，站立够不着', '协议七：无实体'] }).stateNotes).toHaveLength(2)
  })

  it('measures beats in code points of the scenes joined with blank lines', () => {
    const beats = measureBeats({ version: 1, inputRefs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64) }], chapterNumber: 1,
      scenes: [{ sceneId: 's1', text: '𠀀开场。\n【任务已发布：限时 90 秒】' }, { sceneId: 's2', text: '收尾。' }] })
    expect(beats.totalChars).toBe(25)
    expect(beats.scenes).toEqual([{ sceneId: 's1', offset: 0, percent: 0 }, { sceneId: 's2', offset: 22, percent: 88 }])
    expect(beats.panels).toEqual([{ index: 1, offset: 5, percent: 20, text: '【任务已发布：限时 90 秒】' }])
  })
})

/** Collects each native child's logged prompt text and request for later assertions. */
function recorder() {
  const seen: { stage: WritingFixtureStage; prompt: string; request: string }[] = []
  return { seen, onChildRequest(stage: WritingFixtureStage, request: GenerateOptions) {
    if (seen.some(item => item.stage.sessionId === stage.sessionId)) return
    const prompt = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' && block.text.includes('TASK_DATA') ? [block.text] : [])).join('\n')
    seen.push({ stage, prompt, request: JSON.stringify(request) })
  } }
}

describe('version 4 AI-tone writing rule', () => {
  it('adds the short rule to the body stage only, on top of version 3', () => {
    for (const kind of kinds) {
      const v3 = buildStagePrompt({ ...base, kind, promptVersion: 3 })
      const v4 = buildStagePrompt({ ...base, kind, promptVersion: 4 })
      expect(v3, kind).not.toContain(AI_TONE_WRITING_PHRASE)
      expect(v4.includes(AI_TONE_WRITING_PHRASE), kind).toBe(kind === 'body')
      if (kind !== 'body') expect(v4, kind).toBe(v3)
    }
    const body = buildStagePrompt({ ...base, kind: 'body', promptVersion: 4 })
    expect(body).toContain('ban on technical metaphors comes first')
    expect(body).toContain('technical or financial metaphors')
    expect(body.split('\n\n').filter(paragraph => paragraph.includes(AI_TONE_WRITING_PHRASE))).toHaveLength(1)
  })
})

describe('runs keep their prompt version', () => {
  it('resumes a version-1 run with version-1 prompts, schemas and task data', { timeout: 120_000 }, async () => {
    const record = recorder()
    const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest: record.onChildRequest })
    const run = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 1)
    expect(run.promptVersion).toBe(1)
    await fixture.runs.finish(fixture.actor, run.id, 'stopped', 'Stored before prompt versioning.')
    const outcome = await fixture.run(exec => fixture.runner.resume(exec, run.id, false))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.promptVersion).toBe(1)
    const kindsSeen = new Set(record.seen.map(item => item.stage.kind))
    for (const kind of ['chapter-outline', 'body', 'review'] as const) expect(kindsSeen.has(kind)).toBe(true)
    for (const { prompt } of record.seen) for (const phrase of allGuardrails) expect(prompt).not.toContain(phrase)
    expect(record.seen.some(item => item.stage.task !== null && 'measuredBeats' in item.stage.task)).toBe(false)
    expect(record.seen.filter(item => item.stage.kind === 'chapter-outline').every(item => !item.request.includes('stateNotes'))).toBe(true)
  })

  it('resumes a version-2 run without the version-3 AI-tone review', { timeout: 120_000 }, async () => {
    const record = recorder()
    const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest: record.onChildRequest })
    const run = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 2)
    await fixture.runs.finish(fixture.actor, run.id, 'stopped', 'Stored on prompt version 2.')
    const outcome = await fixture.run(exec => fixture.runner.resume(exec, run.id, false))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value).toMatchObject({ status: 'completed', promptVersion: 2 })
    for (const { prompt } of record.seen) expect(prompt).not.toContain(AI_TONE_PHRASE)
    const bodyReview = record.seen.find(item => item.stage.kind === 'review' && typeof item.stage.task?.measuredWordCount === 'number')
    if (bodyReview === undefined) throw new Error('version-2 resume produced no body review')
    const task = JSON.parse((bodyReview.stage.data as { task: string }).task) as object
    expect(task).toHaveProperty('measuredBeats.totalChars')
    expect(task).not.toHaveProperty('aiToneMarkers')
  })

  it('resumes a version-3 run without the version-4 writing rule', { timeout: 120_000 }, async () => {
    const record = recorder()
    const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest: record.onChildRequest })
    const run = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 3)
    await fixture.runs.finish(fixture.actor, run.id, 'stopped', 'Stored on prompt version 3.')
    const outcome = await fixture.run(exec => fixture.runner.resume(exec, run.id, false))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value).toMatchObject({ status: 'completed', promptVersion: 3 })
    expect(record.seen.some(item => item.stage.kind === 'body')).toBe(true)
    for (const { prompt } of record.seen) expect(prompt).not.toContain(AI_TONE_WRITING_PHRASE)
    const bodyReview = record.seen.find(item => item.stage.kind === 'review' && typeof item.stage.task?.measuredWordCount === 'number')
    if (bodyReview === undefined) throw new Error('version-3 resume produced no body review')
    expect(JSON.parse((bodyReview.stage.data as { task: string }).task)).toHaveProperty('aiToneMarkers.source', 'lieflat-less-ai-tone@27d2923 (MIT)')
  })

  it('resumes a version-4 run with the version-4 prompts after a stop', { timeout: 120_000 }, async () => {
    const record = recorder()
    const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest: record.onChildRequest })
    const run = await fixture.runs.begin(fixture.actor, { ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 4)
    await fixture.runs.finish(fixture.actor, run.id, 'stopped', 'Stored on prompt version 4.')
    const outcome = await fixture.run(exec => fixture.runner.resume(exec, run.id, false))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value).toMatchObject({ status: 'completed', promptVersion: 4 })
    expect(outcome.value.executionLimits).not.toHaveProperty('aiToneBlocking')
    expect(record.seen.find(item => item.stage.kind === 'body')?.prompt).toContain(AI_TONE_WRITING_PHRASE)
    const bodyReview = record.seen.find(item => item.stage.kind === 'review' && typeof item.stage.task?.measuredWordCount === 'number')
    expect(bodyReview?.prompt).toContain('AI tone is never blocking')
    expect(bodyReview?.prompt).not.toContain('the host itself blocks the chapter')
  })

  it('starts new runs on version 7 and hands body reviews host-measured beats and graded AI-tone markers', { timeout: 120_000 }, async () => {
    const record = recorder()
    const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest: record.onChildRequest })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value).toMatchObject({ status: 'completed', promptVersion: 7, executionLimits: { aiToneBlocking: true } })
    expect(record.seen.find(item => item.stage.kind === 'settings')?.prompt).toContain('Do not expand this classification into motives')
    expect(record.seen.find(item => item.stage.kind === 'book-outline')?.prompt).toContain('starting want, the pressure that changes it')
    expect(record.seen.find(item => item.stage.kind === 'chapter-outline')?.prompt).toContain('who chooses, what they want in that moment')
    expect(record.seen.find(item => item.stage.kind === 'chapter-outline')?.prompt).not.toContain('pacing guidance for scene allocation')
    expect(record.seen.find(item => item.stage.kind === 'book-outline')?.prompt).not.toContain('3000–5000')
    expect(record.seen.find(item => item.stage.kind === 'body')?.prompt).toContain('aim for about 3000')
    expect(record.seen.find(item => item.stage.kind === 'body')?.prompt).toContain('present want inside the choice')
    expect(record.seen.find(item => item.stage.kind === 'continuity')?.prompt).toContain('only when the prose performs it')
    expect(record.seen.find(item => item.stage.kind === 'body')?.prompt).toContain('tool or equipment list in the settings')
    expect(record.seen.find(item => item.stage.kind === 'body')?.prompt).toContain(AI_TONE_WRITING_PHRASE)
    for (const item of record.seen.filter(item => item.stage.kind !== 'body')) expect(item.prompt).not.toContain(AI_TONE_WRITING_PHRASE)
    expect(record.seen.find(item => item.stage.kind === 'chapter-outline')?.request).toContain('stateNotes')
    const bodyReview = record.seen.find(item => item.stage.kind === 'review' && typeof item.stage.task?.measuredWordCount === 'number')
    if (bodyReview === undefined) throw new Error('version-4 run produced no body review')
    expect(bodyReview.prompt).toContain('task.measuredBeats')
    expect(JSON.parse((bodyReview.stage.data as { task: string }).task)).toHaveProperty('measuredBeats.totalChars')
    expect(bodyReview.prompt).toContain('one repair step')
    expect(bodyReview.prompt).toContain('prior applied fact and the sentence that breaks it')
    expect(bodyReview.prompt).toContain(AI_TONE_PHRASE)
    expect(bodyReview.prompt).toContain('density-graded hint report')
    expect(bodyReview.prompt).not.toContain('the host itself blocks the chapter')
    const chapterOutlineReview = record.seen.find(item => item.stage.kind === 'review' && item.stage.task?.reviewed !== undefined && item.stage.sources.get(item.stage.task.reviewed.artifactId)?.kind === 'chapter-outline')
    expect(chapterOutlineReview?.prompt).not.toContain('task.measuredBeats')
    expect(JSON.parse((bodyReview.stage.data as { task: string }).task)).toHaveProperty('aiToneMarkers.source', 'lieflat-less-ai-tone@27d2923 (MIT)')
    const otherReviews = record.seen.filter(item => item.stage.kind === 'review' && item !== bodyReview && typeof item.stage.task?.measuredWordCount !== 'number')
    expect(otherReviews.length).toBeGreaterThan(0)
    for (const review of otherReviews) expect(JSON.parse((review.stage.data as { task: string }).task)).not.toHaveProperty('aiToneMarkers')
    for (const review of otherReviews) expect(review.prompt).toContain('one repair step')
    for (const review of otherReviews) expect(review.prompt).not.toContain('prior applied fact and the sentence that breaks it')
    for (const review of otherReviews) expect(review.prompt).not.toContain(AI_TONE_PHRASE)
  })
})
