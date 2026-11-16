/** A repeated hookType repairs inside the outline budget. An opening miss repairs inside the body budget and adds no signature. */
import { expect, it } from 'vitest'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

it('fails a repeated hookType and accepts the repair inside the outline budget', async () => {
  let chapterTwo = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'chapter-outline') return output
      const chapter = stage.task?.chapterNumber
      if (chapter === 1) return { ...output, hookType: 'suspense' }
      if (chapter !== 2) return output
      chapterTwo += 1
      if ('changes' in output && Array.isArray(output.changes)) {
        return { ...output, changes: [...output.changes, { op: 'set', path: 'hookType', value: 'danger' }] }
      }
      return { ...output, hookType: chapterTwo === 1 ? 'suspense' : 'danger' }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 2, throughChapter: 2 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  expect(run.promptVersion).toBe(15)
  const outlines = run.attempts.filter(item => item.key.startsWith('chapter-outline/2/candidate/') && !item.key.includes('/review'))
  expect(outlines.map(item => item.key)).toEqual(['chapter-outline/2/candidate/0', 'chapter-outline/2/candidate/1'])
  expect(outlines.every(item => item.failureSignature === undefined)).toBe(true)
  const repair = fixture.runs.storedPrompt(fixture.actor, run.id, 'chapter-outline/2/candidate/1') ?? ''
  expect(repair).toContain('repeats the previous chapter')
}, 180_000)

it('stops a repeated hookType inside the outline budget and does not sign it', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'chapter-outline') return output
      if ('changes' in output) return output
      return { ...output, hookType: 'suspense' }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 2, throughChapter: 2 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Repair limit was exhausted')
  const outlines = run.attempts.filter(item => item.key.startsWith('chapter-outline/2/candidate/') && !item.key.includes('/review'))
  expect(outlines.map(item => item.key)).toEqual(['chapter-outline/2/candidate/0', 'chapter-outline/2/candidate/1'])
  expect(run.attempts.some(item => item.key.startsWith('chapter-outline/2/candidate/2'))).toBe(false)
  expect(outlines.every(item => item.failureSignature === undefined)).toBe(true)
}, 180_000)

it('writes a chapter-1 opening miss into the body repair and does not sign it', async () => {
  let round = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      const index = round++
      if (index > 0) return output
      if ('changes' in output && Array.isArray(output.changes)) return output
      const body = output as { scenes?: { text: string }[] }
      if (body.scenes === undefined) return output
      return { ...body, scenes: body.scenes.map((scene, sceneIndex) => sceneIndex === 0 ? { ...scene, text: `${'阳光明媚，花开满园。'.repeat(20)}${scene.text}` } : scene) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  const bodies = run.attempts.filter(item => item.key.startsWith('body/1/candidate/') && !item.key.includes('/review'))
  expect(bodies.length).toBeGreaterThan(1)
  expect(bodies.every(item => item.failureSignature === undefined)).toBe(true)
  const repair = fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/1') ?? ''
  expect(repair).toContain('openingIn50')
}, 180_000)
