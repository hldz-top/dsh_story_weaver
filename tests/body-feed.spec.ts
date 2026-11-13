/** The body feed is this chapter's events and actions, without word targets or percentage positions. */
import { expect, it } from 'vitest'
import { bodyFeed } from '../src/prose-view.ts'

const inputRefs = [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64) }]
const book = JSON.stringify({
  version: 1, inputRefs, contentMarkdown: '全书 20%–40% 是追查。七场配额 400／310。', ending: '船队返航。',
  characterArcs: [{ character: '沈遥', development: '他从隐瞒走向核对。' }],
  chapters: [{ chapterNumber: 1, title: '先看表', purpose: '沈遥封住漏口。', targetWords: 4300, obligations: [{ id: 'seal', description: '他封住检修口。' }] },
    { chapterNumber: 2, title: '下一班', purpose: '他核对记录。', targetWords: 1500, obligations: [{ id: 'check', description: '他核对签字。' }] }],
})
const chapter = JSON.stringify({
  version: 1, inputRefs, chapterNumber: 1, title: '先看表', targetWords: 4300, throughLine: '他要封住漏口，并看见对不上的记录。',
  constraints: ['篇幅约 260 字。A 段 0%–12.5%。内心台词固定为「这不是事故」。'],
  obligations: [{ id: 'seal', description: '他封住检修口。' }],
  scenes: [{ id: 's1', purpose: '封口。', action: '沈遥用手封住缝。', obligationIds: ['seal'] },
    { id: 's2', purpose: '看见记录。', action: '他读到对不上的一行。', obligationIds: [] }],
  stateNotes: ['漏缝在 22% 处。'],
})

it('feeds only this chapter events and actions', () => {
  const bookFeed = bodyFeed('book-outline', book, 1)
  expect(bookFeed).toBe('先看表\n沈遥封住漏口。\n他封住检修口。')
  expect(bookFeed).not.toContain('%')
  expect(bookFeed).not.toContain('4300')
  expect(bookFeed).not.toContain('下一班')
  const chapterFeed = bodyFeed('chapter-outline', chapter, 1)
  expect(chapterFeed).toBe('先看表\n他要封住漏口，并看见对不上的记录。\n他封住检修口。\n封口。\n沈遥用手封住缝。\n看见记录。\n他读到对不上的一行。')
  expect(chapterFeed).not.toContain('%')
  expect(chapterFeed).not.toContain('260')
  expect(chapterFeed).not.toContain('这不是事故')
  expect(chapterFeed).not.toContain('stateNotes')
})
