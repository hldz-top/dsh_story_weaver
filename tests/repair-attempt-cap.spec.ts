/** Settings and outlines stay on the configured repair budget. A body candidate gets one more round. */
import { expect, it } from 'vitest'
import { repairAttemptCap, type RepairCapKind } from '../src/writing-runner.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const configured = 2

it('assigns the default repair cap by stage class', () => {
  const shared: readonly RepairCapKind[] = ['settings', 'book-outline', 'chapter-outline', 'continuity', 'continuity-snapshot', 'review', 'research']
  for (const kind of shared) expect(repairAttemptCap(kind, configured), kind).toBe(2)
  expect(repairAttemptCap('body', configured)).toBe(3)
  expect(repairAttemptCap('body', 1)).toBe(2)
  expect(repairAttemptCap('body', 0)).toBe(0)
  expect(repairAttemptCap('settings', 0)).toBe(0)
  expect(repairAttemptCap('body', Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
})

async function exhaust(intervene: (stage: WritingFixtureStage, output: object) => object) {
  const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: configured }, intervene })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}

function keysOf(run: { attempts: readonly { key: string }[] }, prefix: string): string[] {
  return run.attempts.map(item => item.key).filter(key => key.startsWith(prefix) && !key.includes('/review') && !key.includes('/research'))
}

it('exhausts a settings batch at 2 repair rounds and does not start a third replacement', async () => {
  const run = await exhaust((stage, output) => {
    if (stage.task?.batch !== 'draft' && stage.task?.batch !== 'repair') return output
    const batch = output as { dimensions: { code: string; body: string }[] }
    return { ...batch, dimensions: batch.dimensions.map(item => ({ ...item, body: 'x'.repeat(2501) })) }
  })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Settings batch repair limit was exhausted')
  expect(keysOf(run, 'settings/batch/a1/draft')).toEqual([
    'settings/batch/a1/draft',
    'settings/batch/a1/draft/repair/1',
    'settings/batch/a1/draft/repair/2',
  ])
  expect(run.attempts.some(item => item.key === 'settings/batch/a1/draft/repair/3')).toBe(false)
}, 180_000)

it('exhausts a book outline at 2 repair rounds', async () => {
  const run = await exhaust((stage, output) => {
    if (stage.kind !== 'book-outline') return output
    const book = StageOutputSchemas['book-outline'].parse(output)
    return { ...book, chapters: book.chapters.map(chapter => ({ ...chapter, chapterNumber: 9 })) }
  })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Repair limit was exhausted for book-outline/book')
  expect(keysOf(run, 'book-outline/book/candidate/')).toEqual([
    'book-outline/book/candidate/0',
    'book-outline/book/candidate/1',
    'book-outline/book/candidate/2',
  ])
  expect(run.attempts.some(item => item.key.startsWith('book-outline/book/candidate/3'))).toBe(false)
  expect(run.attempts.some(item => item.key.startsWith('chapter-outline/'))).toBe(false)
}, 180_000)

it('exhausts a chapter outline at 2 repair rounds', async () => {
  const run = await exhaust((stage, output) => {
    if (stage.kind !== 'chapter-outline') return output
    const outline = StageOutputSchemas['chapter-outline'].parse(output)
    return { ...outline, chapterNumber: 9 }
  })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Repair limit was exhausted for chapter-outline/1')
  expect(keysOf(run, 'chapter-outline/1/candidate/')).toEqual([
    'chapter-outline/1/candidate/0',
    'chapter-outline/1/candidate/1',
    'chapter-outline/1/candidate/2',
  ])
  expect(run.attempts.some(item => item.key.startsWith('chapter-outline/1/candidate/3'))).toBe(false)
  expect(run.attempts.some(item => item.key.startsWith('body/'))).toBe(false)
}, 180_000)

it('lets a body candidate enter a third repair round and stops before a fourth', async () => {
  const run = await exhaust((stage, output) => {
    if (stage.kind !== 'body') return output
    const body = StageOutputSchemas.body.parse(output)
    return { ...body, scenes: body.scenes.map(scene => ({ ...scene, sceneId: 'extra-scene' })) }
  })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Repair limit was exhausted for body/1')
  expect(keysOf(run, 'body/1/candidate/')).toEqual([
    'body/1/candidate/0',
    'body/1/candidate/1',
    'body/1/candidate/2',
    'body/1/candidate/3',
  ])
  expect(run.attempts.some(item => item.key.startsWith('body/1/candidate/4'))).toBe(false)
  expect(run.attempts.some(item => item.key.startsWith('continuity/'))).toBe(false)
}, 180_000)

it('keeps continuity on the configured 2 repair rounds inside the shared candidate loop', async () => {
  const run = await exhaust((stage, output) => {
    if (stage.kind !== 'continuity') return output
    const continuity = StageOutputSchemas.continuity.parse(output)
    return { ...continuity, chapterNumber: 9 }
  })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Repair limit was exhausted for continuity/1')
  expect(keysOf(run, 'continuity/1/candidate/')).toEqual([
    'continuity/1/candidate/0',
    'continuity/1/candidate/1',
    'continuity/1/candidate/2',
  ])
  expect(run.attempts.some(item => item.key.startsWith('continuity/1/candidate/3'))).toBe(false)
}, 180_000)
