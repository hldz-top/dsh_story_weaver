/** Chapter 1 must show a person, an event, and a conflict in the first 50 Story-counted words. */
import { expect, it } from 'vitest'
import { openingIn50Miss, openingIn50RepairInstruction } from '../src/opening-in-50.ts'
import { buildStagePrompt } from '../src/stage-prompts.ts'

const prompt = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }

it('flags a chapter-1 opening that misses a person, an event, or a conflict', () => {
  expect(openingIn50Miss({ chapterNumber: 1, bodyText: '林澜推开门，却见刀已架在师兄颈上。后面才慢慢解释来路。' })).toBeNull()
  const scenery = openingIn50Miss({ chapterNumber: 1, bodyText: '天空很蓝，海风很轻，水面平静，远山含黛。' })
  expect(scenery?.absent).toEqual(['person', 'event', 'conflict'])
  expect(openingIn50RepairInstruction(scenery!)).toMatch(/first 50 Story-counted words/)
  const late = '阳光明媚。'.repeat(40) + '林澜推开门，却见刀已架在师兄颈上。'
  expect(openingIn50Miss({ chapterNumber: 1, bodyText: late })?.absent.length).toBeGreaterThan(0)
  expect(openingIn50Miss({ chapterNumber: 2, bodyText: '阳光明媚。' })).toBeNull()
})

it('adds the opening sentence only on version 15', () => {
  expect(buildStagePrompt({ ...prompt, kind: 'body', promptVersion: 14 })).not.toContain('first 50 Story-counted words')
  expect(buildStagePrompt({ ...prompt, kind: 'body', promptVersion: 15 })).toContain('first 50 Story-counted words')
  expect(buildStagePrompt({ ...prompt, kind: 'body', promptVersion: 15, openingIn50: false })).toBe(buildStagePrompt({ ...prompt, kind: 'body', promptVersion: 14 }))
})
