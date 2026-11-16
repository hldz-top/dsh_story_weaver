/** Required-event hit check. Plot beats below are fixture text; the checker only reads the brief and outline obligations. */
import { expect, it } from 'vitest'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { extractRequiredEvents, missingRequiredEvents, requiredEventKeywords, requiredEventRepairInstruction } from '../src/required-events.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const fogBrief = '守灯人林澜在虚构雾港追查失踪船只。请完成三章故事，每章三千至五千字。'
const brief = [
  fogBrief,
  '必写事件：',
  '1. 三本入门诀全部失败',
  '2. 被落石与雷击接连打中',
  '3. 撞木反噬',
  '4. 一指尚未击出',
].join('\n')
const invented = { id: 'leak', description: '旁白写出韩铁衣的内心' }
const outline = [
  { id: 'manuals', description: '三本入门诀全部失败' },
  invented,
  { id: 'harbor', description: '林澜查明第1处航标并记录证据。' },
]

it('reports a missing brief item by its own number and does not add an outline event the brief never states', () => {
  const events = extractRequiredEvents({ briefText: brief, obligations: outline })
  expect(events.map(event => event.index)).toEqual([1, 2, 3, 4])
  expect(events.map(event => event.text)).toEqual(['三本入门诀全部失败', '被落石与雷击接连打中', '撞木反噬', '一指尚未击出'])
  expect(events.map(event => event.obligationId)).toEqual(['manuals', undefined, undefined, undefined])
  expect(JSON.stringify(events)).not.toContain('韩铁衣')
  expect(JSON.stringify(events)).not.toContain('航标')
  const body = '三本入门诀全部失败。落石砸下，雷击打中他。一指尚未击出。'
  const missing = missingRequiredEvents(body, events)
  expect(missing.map(item => item.index)).toEqual([3])
  const instruction = requiredEventRepairInstruction(missing)
  expect(instruction).toContain('missing item 3')
  expect(instruction).toContain('缺第 3 条')
  expect(instruction).toContain('撞木反噬')
  expect(instruction).not.toContain('韩铁衣')
  expect(instruction).not.toContain('missing item 1')
  expect(instruction).not.toContain('missing item 2')
  expect(instruction).not.toContain('missing item 4')
  expect(missingRequiredEvents(`${body}撞木反噬。`, events)).toEqual([])
})

it('splits a physical chain into keywords and names only the absent ones', () => {
  expect(requiredEventKeywords('被落石与雷击接连打中')).toEqual(['落石', '雷击', '打中'])
  expect(requiredEventKeywords('要求写明和平结局')).toEqual(['要求写明和平结局'])
  const events = extractRequiredEvents({ briefText: '物理链：落石、雷击' })
  expect(events).toMatchObject([{ index: 1, text: '落石、雷击', keywords: ['落石', '雷击'] }])
  const missing = missingRequiredEvents('只有落石滚过。', events)
  expect(requiredEventRepairInstruction(missing)).toContain('missing item 1')
  expect(requiredEventRepairInstruction(missing)).toContain('absent: 雷击')
  expect(missingRequiredEvents('落石之后是雷击。', events)).toEqual([])
})

it('keeps a 第N条 number and a verbatim outline obligation, and ignores phrases the brief does not contain', () => {
  const events = extractRequiredEvents({
    briefText: '本章必写事件：\n第3条：撞木反噬\n追查失踪船只是已写明的义务。',
    obligations: [
      { id: 'boats', description: '追查失踪船只' },
      { id: 'leak', description: '旁白写出韩铁衣的内心' },
    ],
  })
  expect(events.map(event => ({ index: event.index, text: event.text, obligationId: event.obligationId }))).toEqual([
    { index: 3, text: '撞木反噬', obligationId: undefined },
    { index: 4, text: '追查失踪船只', obligationId: 'boats' },
  ])
})

it('does not treat an ordinary mention, or the fog-harbor premise, as a required-event list', () => {
  expect(extractRequiredEvents({
    briefText: '不要把必写事件写死在插件里。三本入门诀全部失败只是例子。',
    obligations: [invented, { id: 'signal-1', description: '林澜查明第1处航标并记录证据。' }],
  })).toEqual([])
  expect(extractRequiredEvents({ briefText: fogBrief, obligations: [{ id: 'signal-1', description: '林澜查明第1处航标并记录证据。' }] })).toEqual([])
  expect(extractRequiredEvents({ briefText: '硬性要求：保持第三人称限知' })).toEqual([])
})

it('writes a missing brief event into the body repair instruction while the review reports none', async () => {
  const fixture = await useWritingFixture({
    backend: 'sqlite',
    brief,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'book-outline') {
        const book = StageOutputSchemas['book-outline'].parse(output)
        return {
          ...book,
          chapters: book.chapters.map(chapter => chapter.chapterNumber === 1
            ? { ...chapter, obligations: [{ id: 'signal-1', description: invented.description }] }
            : chapter),
        }
      }
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      const present = (stage.task.validationError ?? null) === null
        ? '三本入门诀全部失败。落石砸下，雷击打中他。一指尚未击出。'
        : '三本入门诀全部失败。落石砸下，雷击打中他。撞木反噬。一指尚未击出。'
      if ('changes' in output && Array.isArray(output.changes)) {
        const changes = output.changes as { op?: unknown; path?: unknown; value?: unknown }[]
        return {
          version: 1,
          changes: changes.map(change => change.path === 'scenes[0].text' && typeof change.value === 'string'
            ? { ...change, value: change.value.replaceAll(invented.description, '') + present }
            : change),
        }
      }
      const body = StageOutputSchemas.body.parse(output)
      return {
        ...body,
        scenes: body.scenes.map((scene, index) => ({
          ...scene,
          text: scene.text.replaceAll(invented.description, '') + (index === 0 ? present : ''),
        })),
      }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status, outcome.value.error ?? '').toBe('completed')
  const review = outcome.value.attempts.find(item => item.key === 'body/1/candidate/0/review/0' && item.status === 'succeeded')
  if (review === undefined) throw new Error('body review did not run')
  const reviewOutput = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, review.id).text) as { issues: { message?: string }[] }
  expect(reviewOutput.issues).toEqual([])
  expect(JSON.stringify(reviewOutput)).not.toContain('撞木反噬')
  const stored = fixture.runs.storedPrompt(fixture.actor, outcome.value.id, 'body/1/candidate/1')
  if (stored === undefined) throw new Error('repair prompt was not stored')
  const task = JSON.parse(JSON.parse(stored.split('\n\nTASK_DATA\n\n')[1] ?? '{}').task) as { validationError?: string }
  expect(task.validationError).toContain('missing item 3')
  expect(task.validationError).toContain('缺第 3 条')
  expect(task.validationError).toContain('撞木反噬')
  expect(task.validationError).not.toContain('韩铁衣')
  expect(task.validationError).not.toContain('missing item 1')
  expect(task.validationError).not.toContain('missing item 2')
  expect(task.validationError).not.toContain('missing item 4')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters.find(chapter => chapter.chapterNumber === 1)
  if (applied === undefined) throw new Error('chapter 1 was not applied')
  const appliedText = fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied.body.id }).text
  expect(appliedText).toContain('撞木反噬')
  expect(appliedText).not.toContain('韩铁衣')
}, 180_000)
