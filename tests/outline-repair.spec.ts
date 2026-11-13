/** Outline repair patches an admitted outline and rejects a patch that does not fit. */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { parseArtifactId } from '../src/contracts.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { applyOutlinePatch, buildOutlineRepairPrompt, OUTLINE_PATCH_OUTPUT_SCHEMA, outlineRepairUsesPatch, type OutlinePatch } from '../src/outline-repair.ts'
import { splitParagraphTexts } from '../src/paragraphs.ts'
import { StageValidationRejection } from '../src/stage-rejection.ts'
import { parseBookOutlineOutput, parseChapterOutlineOutput, StageOutputSchemas } from '../src/stage-output.ts'

const source = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
const book = {
  version: 1 as const,
  inputRefs: [source],
  contentMarkdown: '  甲段。  \n\n乙段不变。\n\n丙段。',
  ending: '原来的结局。',
  characterArcs: [{ character: '林澜', development: '从怀疑到合作。' }],
  chapters: [
    { chapterNumber: 1, title: '雾', purpose: '查明第一处。', obligations: [{ id: 'signal-1', description: '记录第一处。' }] },
    { chapterNumber: 2, title: '港', purpose: '查明第二处。', obligations: [{ id: 'signal-2', description: '记录第二处。' }] },
  ],
}
const chapter = {
  version: 1 as const,
  inputRefs: [source],
  chapterNumber: 1,
  title: '雾港',
  throughLine: '林澜去确认第一处航标。\n\n她带回记录。',
  constraints: ['保持已知信息。', '不提前揭示结局。'],
  obligations: [{ id: 'signal-1', description: '记录第一处。' }],
  scenes: [{ id: 'scene-1', purpose: '确认航道。', action: '林澜记下第一处灯光。\n下一句仍留在这一场。', obligationIds: ['signal-1'] }],
  stateNotes: ['灯塔在港外。'],
}

function patch(changes: OutlinePatch['changes']): OutlinePatch {
  return { version: 1, changes }
}

describe('outline patch apply', () => {
  it('replaces one field and one paragraph and keeps every other region', () => {
    const patched = applyOutlinePatch('book-outline', book, patch([
      { op: 'set', path: 'ending', value: '新的结局。' },
      { op: 'set', path: 'chapters[0].purpose', value: '先核对灯塔。' },
      { op: 'paragraph', path: 'contentMarkdown', paragraphId: 'p1', value: '甲段改了。' },
      { op: 'paragraph', path: 'contentMarkdown', paragraphId: 'p3', value: '丙段也改了。' },
    ]))
    expect(patched.contentMarkdown).toBe('  甲段改了。  \n\n乙段不变。\n\n丙段也改了。')
    expect(patched.ending).toBe('新的结局。')
    expect(patched.chapters[0]!.purpose).toBe('先核对灯塔。')
    expect(patched.chapters[0]!.title).toBe(book.chapters[0]!.title)
    expect(patched.chapters[0]!.obligations).toEqual(book.chapters[0]!.obligations)
    expect(patched.chapters[1]).toEqual(book.chapters[1])
    expect(patched.characterArcs).toEqual(book.characterArcs)
    expect(patched.inputRefs).toEqual(book.inputRefs)
    expect(patched.version).toBe(1)
    expect(book.contentMarkdown).toBe('  甲段。  \n\n乙段不变。\n\n丙段。')
    expect(parseBookOutlineOutput(patched, { inputRefs: [source], chapterCount: 2 }).chapters.map(item => item.chapterNumber)).toEqual([1, 2])
  })

  it('patches a chapter outline field, paragraph, and string array without rewriting the rest', () => {
    const patched = applyOutlinePatch('chapter-outline', chapter, patch([
      { op: 'paragraph', path: 'throughLine', paragraphId: 'p2', value: '她只改带回的那一句。' },
      { op: 'set', path: 'scenes[0].action', value: '林澜改写这一场。' },
      { op: 'set-strings', path: 'constraints', value: ['保持已知信息。'] },
    ]))
    expect(patched.throughLine).toBe('林澜去确认第一处航标。\n\n她只改带回的那一句。')
    expect(patched.scenes[0]!.action).toBe('林澜改写这一场。')
    expect(patched.scenes[0]!.purpose).toBe(chapter.scenes[0]!.purpose)
    expect(patched.scenes[0]!.obligationIds).toEqual(['signal-1'])
    expect(patched.constraints).toEqual(['保持已知信息。'])
    expect(patched.obligations).toEqual(chapter.obligations)
    expect(patched.title).toBe(chapter.title)
    expect(patched.stateNotes).toEqual(chapter.stateNotes)
    expect(patched.inputRefs).toEqual(chapter.inputRefs)
    expect(parseChapterOutlineOutput(patched, { inputRefs: [source], chapterNumber: 1, obligationIds: ['signal-1'] }).scenes).toHaveLength(1)
  })

  it('numbers paragraphs the same way the review split does', () => {
    const sample = '甲段。\n\n乙段不变。\n\n丙段。'
    expect(splitParagraphTexts(sample)).toEqual(['甲段。', '乙段不变。', '丙段。'])
    const prompt = buildOutlineRepairPrompt({
      novelId: 'novel_00000000-0000-4000-8000-000000000000', kind: 'book-outline', prior: { ...book, contentMarkdown: sample },
      inputs: [{ artifactId: source.artifactId, sha256: source.sha256, kind: 'book-outline', chars: sample.length }],
      task: { kind: 'book-outline', chapterCount: 2, validationError: 'Resolve the blocking issues in the exact supplied review.' },
      inputRefs: [source],
    })
    const task = JSON.parse(JSON.parse(prompt.split('\n\nTASK_DATA\n\n')[1]!).task) as { outlineFields: { path: string; kind: string; paragraphs?: string[] }[] }
    expect(task.outlineFields.find(field => field.path === 'contentMarkdown')?.paragraphs).toEqual(['p1', 'p2', 'p3'])
    expect(prompt).not.toContain(sample)
    expect(prompt).toContain('Return an outline patch')
    expect(prompt).toContain('Do not return the complete outline')
    expect(prompt).not.toContain('return the entire candidate')
  })

  it('rejects a patch that does not fit and does not change the admitted outline', () => {
    const saved = structuredClone(book)
    const cases: unknown[] = [
      { version: 1, changes: [] },
      { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] },
      { version: 1, changes: [{ op: 'paragraph', path: 'contentMarkdown', paragraphId: 'p9', value: '改' }] },
      { version: 1, changes: [{ op: 'set', path: 'ending', value: '一' }, { op: 'set', path: 'ending', value: '二' }] },
      { version: 1, changes: [{ op: 'paragraph', path: 'ending', paragraphId: 'p1', value: '一' }, { op: 'set', path: 'ending', value: '二' }] },
      { version: 1, changes: [{ op: 'set', path: 'chapters[0]', value: '不是字符串' }] },
      { version: 1, changes: [{ op: 'set-strings', path: 'ending', value: ['不是数组'] }] },
      { version: 1, changes: [{ op: 'set', path: 'inputRefs[0].sha256', value: 'b'.repeat(64) }] },
      { version: 1, changes: [{ op: 'set', path: 'version', value: '2' }] },
      { version: 1, changes: [{ op: 'set', path: 'chapters[01].title', value: '改' }] },
      book,
    ]
    const carriageReturn = { ...book, contentMarkdown: '甲段。\r\n乙段。' }
    const paragraphChange = { version: 1, changes: [{ op: 'paragraph', path: 'contentMarkdown', paragraphId: 'p1', value: '改' }] }
    expect(() => applyOutlinePatch('book-outline', carriageReturn, paragraphChange)).toThrow(/carriage returns/)
    expect(() => applyOutlinePatch('book-outline', carriageReturn, { version: 1, changes: [{ op: 'set', path: 'contentMarkdown', value: '甲段。\n乙段。' }] })).not.toThrow()
    for (const value of cases) expect(() => applyOutlinePatch('book-outline', book, value), JSON.stringify(value)).toThrow(StageValidationRejection)
    expect(book).toEqual(saved)
    expect(validateJsonSchemaValue(OUTLINE_PATCH_OUTPUT_SCHEMA, book).length).toBeGreaterThan(0)
    expect(validateJsonSchemaValue(OUTLINE_PATCH_OUTPUT_SCHEMA, { version: 1, changes: [{ op: 'set', path: 'ending', value: '新的结局。' }] })).toEqual([])
    expect(validateJsonSchemaValue(nativeStageOutputSchema('book-outline', 7), { version: 1, changes: [{ op: 'set', path: 'ending', value: '新的结局。' }] }).length).toBeGreaterThan(0)
  })

  it('asks for a patch only after a version-7 outline has been admitted', () => {
    expect(outlineRepairUsesPatch(7, 'book-outline', true)).toBe(true)
    expect(outlineRepairUsesPatch(7, 'chapter-outline', true)).toBe(true)
    expect(outlineRepairUsesPatch(7, 'book-outline', false)).toBe(false)
    expect(outlineRepairUsesPatch(7, 'body', true)).toBe(false)
    expect(outlineRepairUsesPatch(8, 'book-outline', true)).toBe(true)
    expect(outlineRepairUsesPatch(8, 'chapter-outline', true)).toBe(true)
    expect(outlineRepairUsesPatch(8, 'book-outline', false)).toBe(false)
    expect(outlineRepairUsesPatch(8, 'body', true)).toBe(false)
    for (const version of [1, 2, 3, 4, 5, 6] as const) {
      expect(outlineRepairUsesPatch(version, 'book-outline', true)).toBe(false)
      expect(outlineRepairUsesPatch(version, 'chapter-outline', true)).toBe(false)
    }
    expect(StageOutputSchemas['book-outline'].safeParse(book).success).toBe(true)
  })
})
