/** Deterministic closing-hook rotation. Types are assigned from the chapter number alone. */
import { expect, it } from 'vitest'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { OUTLINE_PATCH_REQUIREMENT } from '../src/outline-repair.ts'
import {
  HOOK_TYPES, hookLabel, hookRotationRepairInstruction, hookTypeForChapter, labeledHookType, missingHookTypes,
} from '../src/hook-rotation.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

it('rotates 悬念、反转、情绪悬崖、信息炸弹 from chapter 1 and then repeats', () => {
  expect(HOOK_TYPES).toEqual(['悬念', '反转', '情绪悬崖', '信息炸弹'])
  expect([1, 2, 3, 4, 5, 6, 7, 8].map(hookTypeForChapter)).toEqual([
    '悬念', '反转', '情绪悬崖', '信息炸弹', '悬念', '反转', '情绪悬崖', '信息炸弹',
  ])
  for (let chapter = 1; chapter < 12; chapter++) {
    expect(hookTypeForChapter(chapter)).not.toBe(hookTypeForChapter(chapter + 1))
  }
  expect(hookTypeForChapter(1)).toBe(hookTypeForChapter(5))
  expect(hookLabel('情绪悬崖')).toBe('章末钩子：情绪悬崖')
})

it('rejects a chapter number that is not a positive safe integer', () => {
  for (const chapter of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => hookTypeForChapter(chapter)).toThrow(RangeError)
  }
})

it('reads only the labeled type, including a spaced fullwidth colon, and ignores a bare mention', () => {
  expect(labeledHookType('林澜查明航标。章末钩子：悬念')).toBe('悬念')
  expect(labeledHookType('章末钩子 ： 情绪悬崖')).toBe('情绪悬崖')
  expect(labeledHookType('章末钩子:信息炸弹')).toBe('信息炸弹')
  expect(labeledHookType('这一章充满悬念，但没有标签。')).toBeNull()
  expect(labeledHookType('章末钩子：反转，后文又写章末钩子：悬念')).toBe('反转')
})

it('names a missing or wrong label and does not ask for a position or a word quota', () => {
  const missing = missingHookTypes([
    { chapterNumber: 1, text: '林澜查明航标。章末钩子：悬念' },
    { chapterNumber: 2, text: '林澜查明第二处。' },
    { chapterNumber: 3, text: '章末钩子：悬念' },
    { chapterNumber: 4, text: '章末钩子：信息炸弹' },
  ])
  expect(missing).toEqual([
    { chapterNumber: 2, expected: '反转', found: null },
    { chapterNumber: 3, expected: '情绪悬崖', found: '悬念' },
  ])
  const instruction = hookRotationRepairInstruction(missing)
  expect(instruction).toContain('Host hook-type check')
  expect(instruction).toContain('chapter 2 must name 章末钩子：反转')
  expect(instruction).toContain('chapter 3 names 章末钩子：悬念; the assigned type is 章末钩子：情绪悬崖')
  expect(instruction).toContain('悬念、反转、情绪悬崖、信息炸弹')
  expect(instruction).toContain('Do not add a percentage position or a per-beat word quota')
  expect(instruction).not.toContain('%')
  expect(instruction).not.toContain('targetWords')
  expect(missingHookTypes([{ chapterNumber: 8, text: '章末钩子：信息炸弹' }])).toEqual([])
})

it('refuses a book outline that drops the assigned labels, then applies the repaired labels', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.data.kind !== 'book-outline') return output
      if (stage.data.requirements.includes(OUTLINE_PATCH_REQUIREMENT)) {
        const count = stage.task?.chapterCount ?? 0
        return {
          version: 1,
          changes: Array.from({ length: count }, (_, index) => ({
            op: 'set' as const,
            path: `chapters[${index}].purpose`,
            value: `林澜查明第${index + 1}处航标并记录证据。${hookLabel(hookTypeForChapter(index + 1))}`,
          })),
        }
      }
      const book = StageOutputSchemas['book-outline'].parse(output)
      return { ...book, chapters: book.chapters.map(chapter => ({ ...chapter, purpose: chapter.purpose.replace(/章末钩子：\S+/gu, '') })) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  const stored = fixture.runs.storedPrompt(fixture.actor, outcome.value.id, 'book-outline/book/candidate/1')
  if (stored === undefined) throw new Error('hook repair prompt was not stored')
  const task = JSON.parse(JSON.parse(stored.split('\n\nTASK_DATA\n\n')[1] ?? '{}').task) as { validationError?: string }
  expect(task.validationError).toContain('Host hook-type check')
  expect(task.validationError).toContain('chapter 1 must name 章末钩子：悬念')
  expect(task.validationError).not.toContain('%')
  expect(task.validationError).not.toContain('targetWords')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).heads.find(item => item.target.kind === 'book-outline')
  if (applied === undefined) throw new Error('book outline was not applied')
  const book = StageOutputSchemas['book-outline'].parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied.artifact.id }).text))
  expect(book.chapters[0]?.purpose).toContain('章末钩子：悬念')
  expect(JSON.stringify(book)).not.toContain('%')
  expect(JSON.stringify(book)).not.toContain('targetWords')
})
