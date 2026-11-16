/** Body repair patches an admitted body and rejects a patch that does not fit. */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { applyBodyPatch, BODY_PATCH_OUTPUT_SCHEMA, BODY_PATCH_REQUIREMENT, bodyPatchFallback, bodyRepairAfterRejectedPatch, bodyRepairUsesPatch, buildBodyRepairPrompt, type BodyPatch } from '../src/body-repair.ts'
import { parseArtifactId } from '../src/contracts.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { splitParagraphTexts } from '../src/paragraphs.ts'
import { StageValidationRejection } from '../src/stage-rejection.ts'
import { parseBodyOutput, StageOutputSchemas } from '../src/stage-output.ts'

const source = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
const body = {
  version: 1 as const,
  inputRefs: [source],
  chapterNumber: 1,
  scenes: [
    { sceneId: 'scene-1', text: '  甲段。  \n\n乙段不变。\n\n丙段。' },
    { sceneId: 'scene-2', text: '第二场不动。' },
  ],
}

function patch(changes: BodyPatch['changes']): BodyPatch {
  return { version: 1, changes }
}

describe('body patch apply', () => {
  it('replaces one paragraph and keeps every other scene and character', () => {
    const patched = applyBodyPatch(body, patch([
      { op: 'paragraph', path: 'scenes[0].text', paragraphId: 'p1', value: '甲段改了。' },
      { op: 'paragraph', path: 'scenes[0].text', paragraphId: 'p3', value: '丙段也改了。' },
    ]))
    expect(patched.scenes[0]!.text).toBe('  甲段改了。  \n\n乙段不变。\n\n丙段也改了。')
    expect(patched.scenes[0]!.sceneId).toBe('scene-1')
    expect(patched.scenes[1]).toEqual(body.scenes[1])
    expect(patched.chapterNumber).toBe(1)
    expect(patched.inputRefs).toEqual(body.inputRefs)
    expect(patched.version).toBe(1)
    expect(body.scenes[0]!.text).toBe('  甲段。  \n\n乙段不变。\n\n丙段。')
    expect(parseBodyOutput(patched, { inputRefs: [source], chapterNumber: 1, sceneIds: ['scene-1', 'scene-2'] }).scenes).toHaveLength(2)
  })

  it('replaces one whole scene string without rewriting the other scene', () => {
    const patched = applyBodyPatch(body, patch([
      { op: 'set', path: 'scenes[1].text', value: '第二场只改这一句。' },
    ]))
    expect(patched.scenes[1]!.text).toBe('第二场只改这一句。')
    expect(patched.scenes[1]!.sceneId).toBe('scene-2')
    expect(patched.scenes[0]).toEqual(body.scenes[0])
  })

  it('numbers paragraphs the same way the review split does', () => {
    const sample = '甲段。\n\n乙段不变。\n\n丙段。'
    expect(splitParagraphTexts(sample)).toEqual(['甲段。', '乙段不变。', '丙段。'])
    const prompt = buildBodyRepairPrompt({
      novelId: 'novel_00000000-0000-4000-8000-000000000000',
      prior: { ...body, scenes: [{ sceneId: 'scene-1', text: sample }] },
      inputs: [{ artifactId: source.artifactId, sha256: source.sha256, kind: 'body', chars: sample.length }],
      task: { kind: 'body', chapterNumber: 1, validationError: 'Resolve the blocking issues in the exact supplied review.' },
      inputRefs: [source],
    })
    const task = JSON.parse(JSON.parse(prompt.split('\n\nTASK_DATA\n\n')[1]!).task) as { bodyFields: { path: string; kind: string; paragraphs?: string[] }[] }
    expect(task.bodyFields.find(field => field.path === 'scenes[0].text')?.paragraphs).toEqual(['p1', 'p2', 'p3'])
    expect(prompt).not.toContain(sample)
    expect(prompt).toContain(BODY_PATCH_REQUIREMENT)
    expect(prompt).toContain('Do not return the complete body')
    expect(prompt).not.toContain('return the entire candidate')
  })

  it('rejects a patch that does not fit and does not change the admitted body', () => {
    const saved = structuredClone(body)
    const cases: unknown[] = [
      { version: 1, changes: [] },
      { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] },
      { version: 1, changes: [{ op: 'paragraph', path: 'scenes[0].text', paragraphId: 'p9', value: '改' }] },
      { version: 1, changes: [{ op: 'set', path: 'scenes[0].text', value: '一' }, { op: 'set', path: 'scenes[0].text', value: '二' }] },
      { version: 1, changes: [{ op: 'paragraph', path: 'scenes[0].text', paragraphId: 'p1', value: '一' }, { op: 'set', path: 'scenes[0].text', value: '二' }] },
      { version: 1, changes: [{ op: 'set', path: 'scenes[0]', value: '不是字符串' }] },
      { version: 1, changes: [{ op: 'set', path: 'scenes[0].sceneId', value: 'other-scene' }] },
      { version: 1, changes: [{ op: 'set', path: 'inputRefs[0].sha256', value: 'b'.repeat(64) }] },
      { version: 1, changes: [{ op: 'set', path: 'version', value: '2' }] },
      { version: 1, changes: [{ op: 'set', path: 'chapterNumber', value: '2' }] },
      { version: 1, changes: [{ op: 'set', path: 'scenes[01].text', value: '改' }] },
      body,
    ]
    const carriageReturn = { ...body, scenes: [{ ...body.scenes[0]!, text: '甲段。\r\n乙段。' }, body.scenes[1]!] }
    const paragraphChange = { version: 1, changes: [{ op: 'paragraph', path: 'scenes[0].text', paragraphId: 'p1', value: '改' }] }
    expect(() => applyBodyPatch(carriageReturn, paragraphChange)).toThrow(/carriage returns/)
    expect(() => applyBodyPatch(carriageReturn, { version: 1, changes: [{ op: 'set', path: 'scenes[0].text', value: '甲段。\n乙段。' }] })).not.toThrow()
    for (const value of cases) expect(() => applyBodyPatch(body, value), JSON.stringify(value)).toThrow(StageValidationRejection)
    expect(body).toEqual(saved)
    expect(validateJsonSchemaValue(BODY_PATCH_OUTPUT_SCHEMA, body).length).toBeGreaterThan(0)
    expect(validateJsonSchemaValue(BODY_PATCH_OUTPUT_SCHEMA, { version: 1, changes: [{ op: 'set', path: 'scenes[1].text', value: '第二场只改这一句。' }] })).toEqual([])
    expect(validateJsonSchemaValue(nativeStageOutputSchema('body', 10), { version: 1, changes: [{ op: 'set', path: 'scenes[1].text', value: '第二场只改这一句。' }] }).length).toBeGreaterThan(0)
    expect(StageOutputSchemas.body.safeParse(body).success).toBe(true)
  })

  it('asks for a patch only after a version-10 body has been admitted', () => {
    expect(bodyPatchFallback).toBe(true)
    expect(bodyRepairAfterRejectedPatch()).toBe('full-body')
    expect(bodyRepairAfterRejectedPatch(true)).toBe('full-body')
    expect(bodyRepairAfterRejectedPatch(false)).toBe('reject')
    expect(bodyRepairUsesPatch(10, 'body', true)).toBe(true)
    expect(bodyRepairUsesPatch(10, 'body', false)).toBe(false)
    expect(bodyRepairUsesPatch(10, 'book-outline', true)).toBe(false)
    expect(bodyRepairUsesPatch(10, 'chapter-outline', true)).toBe(false)
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      expect(bodyRepairUsesPatch(version, 'body', true), String(version)).toBe(false)
    }
  })
})
