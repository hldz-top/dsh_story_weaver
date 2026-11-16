/** Chapter-1 opening hard check. The brief supplies the requirement; the first 50 Story words must hit it. */
import { expect, it } from 'vitest'
import { countStoryWords, prefixByStoryWords } from '../src/body-text.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { extractOpeningRequirement, openingIn50Miss, openingIn50RepairInstruction, OPENING_IN_50_UNITS } from '../src/opening-in-50.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const han = (count: number, word = '甲') => word.repeat(count)
const brief = '守灯人林澜在虚构雾港追查失踪船只。\n开篇钩子：雷击打中桅杆'

it('counts the opening window with the Story word counter and stops on the 50th word', () => {
  const text = `${han(49)}雷击${han(10, '乙')}`
  const window = prefixByStoryWords(text, OPENING_IN_50_UNITS)
  expect(OPENING_IN_50_UNITS).toBe(50)
  expect(countStoryWords(window)).toBe(50)
  expect(window.endsWith('雷')).toBe(true)
  expect(window).not.toContain('击')
  expect(prefixByStoryWords('B3 灯', 1)).toBe('B3')
  expect(prefixByStoryWords('短', 50)).toBe('短')
  expect(() => prefixByStoryWords('短', 0)).toThrow(RangeError)
})

it('takes the chapter-1 opening from the brief and ignores an ordinary use of 开篇', () => {
  expect(extractOpeningRequirement(brief)).toEqual({ text: '雷击打中桅杆', keywords: ['雷击打中桅杆'] })
  expect(extractOpeningRequirement('Opening hook: 桅杆裂开')).toEqual({ text: '桅杆裂开', keywords: ['桅杆裂开'] })
  expect(extractOpeningRequirement('第1章开篇：\n冷风灌进舱门')).toEqual({ text: '冷风灌进舱门', keywords: ['冷风灌进舱门'] })
  expect(extractOpeningRequirement('本章是全书的开篇与地基，不是序幕。')).toBeNull()
  expect(extractOpeningRequirement('守灯人林澜在虚构雾港追查失踪船只。')).toBeNull()
  expect(extractOpeningRequirement('开篇钩子：')).toBeNull()
})

it('fails closed when chapter 1 misses the opening inside 50 words and passes the other chapters', () => {
  const late = `${han(50)}雷击打中桅杆。${han(20, '乙')}`
  const early = `雷击打中桅杆。${han(80)}`
  const split = `${han(49)}雷击${han(10, '乙')}`
  const missed = openingIn50Miss({ chapterNumber: 1, bodyText: late, briefText: brief })
  expect(missed).toMatchObject({ check: 'openingIn50', requirement: '雷击打中桅杆', absentKeywords: ['雷击打中桅杆'], units: 50 })
  const instruction = openingIn50RepairInstruction(missed!)
  expect(instruction).toContain('Host openingIn50 check')
  expect(instruction).toContain('first 50 Story-counted words')
  expect(instruction).toContain('雷击打中桅杆')
  expect(instruction).toContain('A later mention does not pass')
  expect(openingIn50Miss({ chapterNumber: 1, bodyText: early, briefText: brief })).toBeNull()
  expect(openingIn50Miss({ chapterNumber: 1, bodyText: split, briefText: brief })?.absentKeywords).toEqual(['雷击打中桅杆'])
  expect(openingIn50Miss({ chapterNumber: 2, bodyText: late, briefText: brief })).toBeNull()
  expect(openingIn50Miss({ chapterNumber: 1, bodyText: late, briefText: '守灯人林澜在虚构雾港追查失踪船只。' })).toBeNull()
})

it('writes a chapter-1 opening miss into the body repair and does not apply the late opening', async () => {
  const filler = '林澜沿着潮湿的石阶走向灯塔，仔细辨认海面上的每一道光。'.repeat(120)
  const fixture = await useWritingFixture({
    brief,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      const body = StageOutputSchemas.body.parse(output)
      const text = (stage.task.validationError ?? null) === null ? `${han(50)}${filler}` : `雷击打中桅杆。${filler}`
      return { ...body, scenes: body.scenes.map((scene, index) => ({ ...scene, text: index === 0 ? text : scene.text })) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  const review = outcome.value.attempts.find(item => item.key === 'body/1/candidate/0/review/0' && item.status === 'succeeded')
  if (review === undefined) throw new Error('body review did not run')
  const reviewOutput = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, review.id).text) as { issues: unknown[] }
  expect(reviewOutput.issues).toEqual([])
  const stored = fixture.runs.storedPrompt(fixture.actor, outcome.value.id, 'body/1/candidate/1')
  if (stored === undefined) throw new Error('opening repair prompt was not stored')
  const task = JSON.parse(JSON.parse(stored.split('\n\nTASK_DATA\n\n')[1] ?? '{}').task) as { validationError?: string }
  expect(task.validationError).toContain('Host openingIn50 check')
  expect(task.validationError).toContain('雷击打中桅杆')
  expect(task.validationError).toContain('first 50')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters.find(item => item.chapterNumber === 1)
  if (applied === undefined) throw new Error('chapter body was not applied')
  const body = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied.body.id }).text))
  expect(prefixByStoryWords(body.scenes.map(scene => scene.text).join('\n\n'), 50)).toContain('雷击打中桅杆')
})

it('does not apply chapter 1 when the opening stays outside the first 50 words', async () => {
  const filler = '林澜沿着潮湿的石阶走向灯塔，仔细辨认海面上的每一道光。'.repeat(120)
  const fixture = await useWritingFixture({
    brief,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 0 },
    intervene(stage, output) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      const body = StageOutputSchemas.body.parse(output)
      return { ...body, scenes: body.scenes.map((scene, index) => ({ ...scene, text: index === 0 ? `${han(50)}${filler}` : scene.text })) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('openingIn50')
  expect(outcome.value.error).toContain('雷击打中桅杆')
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toEqual([])
})
