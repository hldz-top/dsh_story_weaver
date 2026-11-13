/** Prompt version 7 drops the sources of percentage positions and per-beat word counts, and grades AI tone. */
import { expect, it } from 'vitest'
import { buildStagePrompt, type StagePromptKind } from '../src/stage-prompts.ts'

const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity']

it('keeps versions 1 through 6 free of the version-7 sentences', () => {
  for (const kind of kinds) for (const promptVersion of [1, 2, 3, 4, 5, 6] as const) {
    const prompt = buildStagePrompt({ ...base, kind, promptVersion, aiToneBlocking: true, ...(kind === 'review' ? { reviewedKind: 'body' as const } : {}) })
    expect(prompt, `${kind}/${promptVersion}`).not.toContain('density-graded hint report')
    if (kind === 'chapter-outline' && promptVersion >= 1) expect(prompt, String(promptVersion)).toContain('pacing guidance for scene allocation')
  }
})

it('drops scene-allocation pacing on a version-7 chapter outline and keeps measured beats on body review only', () => {
  const chapter = buildStagePrompt({ ...base, kind: 'chapter-outline', promptVersion: 7 })
  expect(chapter).not.toContain('pacing guidance for scene allocation')
  expect(chapter).toContain('Do not impose a hard per-scene ceiling')
  expect(chapter).not.toContain('do not output percentage')
  const bodyReview = buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 7, aiToneBlocking: true })
  expect(bodyReview).toContain('task.measuredBeats')
  expect(bodyReview).toContain('density-graded hint report')
  expect(bodyReview).not.toContain('the host itself blocks the chapter')
  const outlineReview = buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'chapter-outline', promptVersion: 7 })
  expect(outlineReview).not.toContain('task.measuredBeats')
  expect(outlineReview).toContain('no physical form written as a physical object')
  const version6 = buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 6, aiToneBlocking: true })
  expect(version6).toContain('the host itself blocks the chapter')
  expect(version6).not.toContain('density-graded hint report')
})
