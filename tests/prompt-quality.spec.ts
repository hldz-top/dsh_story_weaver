/** Prompt version 6 keeps versions 1–5 byte-identical and adds quality sentences only on the stages that can use them. */
import { expect, it } from 'vitest'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { buildStagePrompt, type StagePromptKind } from '../src/stage-prompts.ts'

const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity']
const REPAIR_STEP = 'one repair step'
const PEOPLE = 'one present want'
const CLASSIFICATION = 'Do not expand this classification into motives'
const REVISION = 'Do not expand the revision into a new plot'

it('leaves versions 1 through 5 unchanged and publishes the same output schema', () => {
  for (const kind of kinds) {
    for (const promptVersion of [1, 2, 3, 4, 5] as const) {
      const historical = buildStagePrompt({ ...base, kind, promptVersion, aiToneBlocking: true })
      expect(historical, `${kind}/${promptVersion}`).not.toContain(REPAIR_STEP)
      expect(historical, `${kind}/${promptVersion}`).not.toContain(PEOPLE)
      expect(historical, `${kind}/${promptVersion}`).not.toContain(CLASSIFICATION)
    }
    expect(JSON.stringify(nativeStageOutputSchema(kind, 6)), kind).toBe(JSON.stringify(nativeStageOutputSchema(kind, 5)))
  }
})

it('adds motive and continuity sentences to the stage that owns those fields', () => {
  const prompt = (kind: StagePromptKind, extra: object = {}) => buildStagePrompt({ ...base, kind, promptVersion: 6, ...extra })
  expect(prompt('settings')).toContain(PEOPLE)
  expect(prompt('settings')).toContain('reader-facing prose')
  expect(prompt('settings')).toContain(REVISION)
  expect(prompt('settings')).not.toContain(CLASSIFICATION)
  expect(prompt('settings', { settingsDimensionKind: 'llm_free' })).toContain(PEOPLE)
  for (const settingsDimensionKind of ['enum_single', 'enum_multi'] as const) {
    const classification = prompt('settings', { settingsDimensionKind })
    expect(classification, settingsDimensionKind).toContain(CLASSIFICATION)
    expect(classification, settingsDimensionKind).toContain('reader-facing prose')
    expect(classification, settingsDimensionKind).toContain(REVISION)
    expect(classification, settingsDimensionKind).not.toContain(PEOPLE)
    expect(classification, settingsDimensionKind).toContain('at most 10 facts')
  }
  expect(prompt('book-outline')).toContain('Do not imitate a named author')
  expect(prompt('book-outline')).toContain('starting want, the pressure that changes it')
  expect(prompt('book-outline')).toContain(REVISION)
  expect(prompt('chapter-outline')).toContain('a later due date is a reminder')
  expect(prompt('chapter-outline')).toContain('who chooses, what they want in that moment')
  expect(prompt('chapter-outline')).toContain('previous applied continuity')
  expect(prompt('body')).toContain('previous scene’s ending')
  expect(prompt('body')).toContain('narrator thesis')
  expect(prompt('body')).toContain('present want inside the choice')
  expect(prompt('body')).not.toContain(REVISION)
  expect(prompt('body')).toContain('Keep the narration free of AI tone')
  expect(prompt('continuity')).toContain('only when the prose performs it')
  expect(prompt('continuity')).not.toContain(REVISION)
  for (const kind of kinds) if (kind !== 'review') expect(prompt(kind)).not.toContain(REPAIR_STEP)
})

it('asks the reviewer for one repair step and keeps taste advisory', () => {
  const review = (reviewedKind?: StagePromptKind) => buildStagePrompt({ ...base, kind: 'review', promptVersion: 6, aiToneBlocking: true, ...(reviewedKind === undefined ? {} : { reviewedKind }) })
  for (const reviewedKind of [undefined, ...kinds]) {
    const prompt = review(reviewedKind)
    expect(prompt, String(reviewedKind)).toContain('speculative risk')
    expect(prompt, String(reviewedKind)).toContain('sentence skeleton')
    expect(prompt, String(reviewedKind)).toContain(REPAIR_STEP)
    expect(prompt, String(reviewedKind)).toContain('severity advisory')
    expect(prompt, String(reviewedKind)).toContain('task.measuredWordCount')
    expect(prompt, String(reviewedKind)).not.toContain(PEOPLE)
  }
  expect(review('body')).toContain('prior applied fact and the sentence that breaks it')
  expect(review('body')).toContain('the host itself blocks the chapter')
  expect(review('body')).toContain('AI-tone issues stay category style')
  expect(review('chapter-outline')).toContain('vague but present plan')
  expect(review('book-outline')).toContain('thin but present arc')
  expect(review('continuity')).toContain('A plain summary is not a block')
  expect(review('settings')).toContain('Do not demand motives or world detail from a classification dimension')
  expect(review('book-outline')).not.toContain('prior applied fact and the sentence that breaks it')
  expect(review('settings')).not.toContain('A plain summary is not a block')
  const advisory = buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 6, aiToneBlocking: false })
  expect(advisory).toContain('AI tone is never blocking')
  expect(advisory).toContain(REPAIR_STEP)
  expect(advisory).not.toContain('the host itself blocks the chapter')
})
