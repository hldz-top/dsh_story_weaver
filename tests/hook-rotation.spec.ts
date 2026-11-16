/** Hook-type checklist: a repeat of the previous chapter fails the outline round. */
import { expect, it } from 'vitest'
import { assertHookType, hookTypeItems, HOOK_TYPES, repeatedHookInstruction } from '../src/hook-type.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { buildStagePrompt } from '../src/stage-prompts.ts'

const prompt = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }

it('flags the same hook type as the previous chapter and accepts a change', () => {
  expect(HOOK_TYPES).toEqual(['suspense', 'danger', 'gain', 'misread', 'promise'])
  expect(hookTypeItems().map(item => item.id)).toEqual([...HOOK_TYPES])
  const repeated = repeatedHookInstruction('suspense', 'suspense')
  expect(repeated).toMatch(/repeats the previous chapter/)
  expect(repeatedHookInstruction('danger', 'suspense')).toBeNull()
  expect(repeatedHookInstruction(undefined, 'suspense')).toBeNull()
  expect(() => assertHookType('twist')).toThrow(/hookType is twist/)
})

it('publishes hookType only at version 15 and keeps versions 1–14 unchanged', () => {
  expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 14))).not.toContain('hookType')
  expect(JSON.stringify(nativeStageOutputSchema('continuity', 14))).not.toContain('hookType')
  expect(nativeStageOutputSchema('chapter-outline', 15).properties?.hookType?.enum).toEqual([...HOOK_TYPES])
  expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 15, { hookRotation: false }))).not.toContain('hookType')
  expect(buildStagePrompt({ ...prompt, kind: 'chapter-outline', promptVersion: 14 })).not.toContain('hookType')
  expect(buildStagePrompt({ ...prompt, kind: 'chapter-outline', promptVersion: 15 })).toContain('suspense, danger, gain, misread, promise')
  expect(buildStagePrompt({ ...prompt, kind: 'chapter-outline', promptVersion: 15, hookRotation: false, plantLedger: false })).toBe(buildStagePrompt({ ...prompt, kind: 'chapter-outline', promptVersion: 14 }))
})
