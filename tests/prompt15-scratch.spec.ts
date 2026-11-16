/** Version 14 and version 15 share outcomes except for the version-15 checks. */
import { expect, it } from 'vitest'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

function signatures(run: { readonly attempts: readonly { readonly key: string; readonly failureSignature?: string | undefined }[] }, prefix: string): (string | undefined)[] {
  return run.attempts.filter(item => item.key.startsWith(prefix) && !item.key.includes('/review')).map(item => item.failureSignature)
}

async function runVersion(version: 14 | 15, intervene?: (stage: WritingFixtureStage, output: object) => object) {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    ...(intervene === undefined ? {} : { intervene }),
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1, promptVersion: version }))
  if (outcome.status === 'rejected') throw outcome.reason
  return { fixture, run: outcome.value }
}

it('completes a clean body on version 14 and version 15', async () => {
  const older = await runVersion(14)
  const newer = await runVersion(15)
  expect(older.run.status).toBe('completed')
  expect(newer.run.status).toBe('completed')
  expect(signatures(older.run, 'body/1/candidate/')).toEqual([undefined])
  expect(signatures(newer.run, 'body/1/candidate/')).toEqual([undefined])
  const review = newer.fixture.runs.storedPrompt(newer.fixture.actor, newer.run.id, 'body/1/candidate/0/review/0') ?? ''
  expect(review).toContain('character-voice')
  const legacy = older.fixture.runs.storedPrompt(older.fixture.actor, older.run.id, 'body/1/candidate/0/review/0') ?? ''
  expect(legacy).not.toContain('character-voice')
}, 180_000)

it('keeps length-only and non-pov failure signatures the same on version 14 and version 15', async () => {
  const shorten = (stage: WritingFixtureStage, output: object) => {
    if (stage.kind !== 'body') return output
    if ('changes' in output) return output
    const body = output as { scenes?: { text: string }[] }
    if (body.scenes === undefined) return output
    return { ...body, scenes: body.scenes.map(scene => ({ ...scene, text: '林澜推开门，却只看见一片安静。' })) }
  }
  const length14 = await runVersion(14, shorten)
  const length15 = await runVersion(15, shorten)
  expect(length14.run.status).toBe('completed')
  expect(length15.run.status).toBe('completed')
  expect(signatures(length14.run, 'body/1/candidate/')).toEqual(signatures(length15.run, 'body/1/candidate/'))
  expect(signatures(length15.run, 'body/1/candidate/').every(item => item === undefined)).toBe(true)
  let seen = 0
  const consistency = (stage: WritingFixtureStage, output: object) => {
    if (stage.kind !== 'review') return output
    seen += 1
    if (seen > 1) return output
    const review = output as { checks: { evidence: unknown }[]; issues: object[] }
    return { ...review, issues: [...review.issues, { id: 'fixture-consistency', severity: 'blocking', category: 'consistency', location: '开篇', message: '林澜使用了设定里没有的工具。', evidence: review.checks[0]?.evidence }] }
  }
  const pov14 = await runVersion(14, consistency)
  seen = 0
  const pov15 = await runVersion(15, consistency)
  expect(pov14.run.status).toBe('completed')
  expect(pov15.run.status).toBe('completed')
  expect(signatures(pov14.run, 'body/1/candidate/')).toEqual(signatures(pov15.run, 'body/1/candidate/'))
}, 180_000)

it('resumes a version-14 run with the same prompt bytes', async () => {
  const bodyEntered = Promise.withResolvers<void>()
  let observe = true
  const fixture = await useWritingFixture({ onChildRequest(stage) {
    if (observe && stage.kind === 'body') bodyEntered.resolve()
  }, executionLimits: { researchEnabled: false, maxRepairAttempts: 1 } })
  const input = { ...fixture.input, chapterCount: 1, throughChapter: 1, promptVersion: 14 as const }
  const stopped = await fixture.run(async exec => {
    const running = fixture.runner.start(exec, input)
    await Promise.race([bodyEntered.promise, running.then(result => { throw new Error(`finished early: ${result.error}`) })])
    observe = false
    const run = fixture.runs.list(fixture.actor, fixture.novel.id)[0]
    if (run === undefined) throw new Error('run was not stored')
    const stoppedRun = await fixture.runner.stop(exec, run.id)
    expect(await running).toEqual(stoppedRun)
    return stoppedRun
  })
  if (stopped.status === 'rejected') throw stopped.reason
  expect(stopped.value.promptVersion).toBe(14)
  const before = stopped.value.attempts.filter(item => item.status === 'succeeded').map(item => fixture.runs.storedPrompt(fixture.actor, stopped.value.id, item.key))
  expect(before.some(prompt => (prompt ?? '').includes('character-voice'))).toBe(false)
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, stopped.value.id, true))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.status).toBe('completed')
  expect(resumed.value.promptVersion).toBe(14)
  const after = stopped.value.attempts.filter(item => item.status === 'succeeded').map(item => fixture.runs.storedPrompt(fixture.actor, resumed.value.id, item.key))
  expect(after).toEqual(before)
  const review = fixture.runs.storedPrompt(fixture.actor, resumed.value.id, 'body/1/candidate/0/review/0') ?? ''
  expect(review).not.toContain('character-voice')
}, 180_000)
