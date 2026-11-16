/** Versions 1–13 rebuild the prompt and schema bytes frozen from main 62310eac. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildBodyRepairPrompt } from '../src/body-repair.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { buildStagePrompt, type PromptVersion, type StagePromptKind } from '../src/stage-prompts.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'] as const satisfies readonly StagePromptKind[]
const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const satisfies readonly PromptVersion[]
const dimensions = ['enum_single', 'enum_multi', 'llm_free', 'edit_external'] as const
const floors = ['hint', 'notice', 'heavy'] as const

it('rebuilds every v1–13 prompt and schema variant byte for byte from main', () => {
  const frozen = JSON.parse(readFileSync(new URL('./fixtures/prompt-replay-v1-13.json', import.meta.url), 'utf8')) as Record<string, string>
  const got: Record<string, string> = {}
  const put = (key: string, text: string) => { got[key] = sha(text) }
  for (const version of versions) {
    for (const kind of kinds) {
      put(`prompt/${version}/${kind}`, buildStagePrompt({ ...base, kind, promptVersion: version }))
      put(`schema/${version}/${kind}`, JSON.stringify(nativeStageOutputSchema(kind, version)))
    }
    for (const reviewedKind of kinds) {
      put(`review/${version}/${reviewedKind}`, buildStagePrompt({ ...base, kind: 'review', reviewedKind, promptVersion: version }))
    }
    const bodyReview = { ...base, kind: 'review' as const, reviewedKind: 'body' as const, promptVersion: version }
    put(`aiToneBlocking/${version}/true`, buildStagePrompt({ ...bodyReview, aiToneBlocking: true }))
    put(`aiToneBlocking/${version}/false`, buildStagePrompt({ ...bodyReview, aiToneBlocking: false }))
    for (const floor of floors) put(`floor/${version}/${floor}`, buildStagePrompt({ ...bodyReview, aiToneRepairFloor: floor }))
    for (const settingsDimensionKind of dimensions) {
      put(`settings/${version}/${settingsDimensionKind}`, buildStagePrompt({ ...base, kind: 'settings', settingsDimensionKind, promptVersion: version }))
      put(`settingsReview/${version}/${settingsDimensionKind}`, buildStagePrompt({ ...base, kind: 'review', settingsDimensionKind, promptVersion: version }))
    }
    put(`collection/${version}`, buildStagePrompt({ ...base, kind: 'review', settingsCollectionKinds: { a1: 'enum_single', e1: 'llm_free' }, promptVersion: version }))
    for (const code of ['g4', 'g7'] as const) put(`checklist/${version}/${code}`, buildStagePrompt({ ...base, kind: 'review', settingsDimensionCode: code, promptVersion: version }))
  }
  put('bodyReview/12', buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 12 }))
  put('bodyReview/13', buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 13 }))
  put('bodyPatch', buildBodyRepairPrompt({ novelId: base.novelId, prior: { version: 1, scenes: [] }, inputs: base.inputs, task: { validationError: null }, inputRefs: [] }))
  expect(Object.keys(got).length).toBe(Object.keys(frozen).length)
  for (const [key, hash] of Object.entries(frozen)) expect(got[key], key).toBe(hash)
  expect(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 14 })).toBe(buildStagePrompt({ ...base, kind: 'review', reviewedKind: 'body', promptVersion: 13 }))
  expect(JSON.stringify(nativeStageOutputSchema('review', 14))).toBe(JSON.stringify(nativeStageOutputSchema('review', 13)))
})
