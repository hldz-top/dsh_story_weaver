import { readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { parseRequestId } from '../src/contracts.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

function fulfilled<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}

/** The two full end-to-end replay cases take 12–23 s alone and up to ~60 s on a loaded CI runner; give only them headroom over the 60 s default. */
const SLOW_REPLAY = { timeout: 120_000 }

it('replays a completed request into its new card and rebuilds missing retained output without child work', SLOW_REPLAY, async () => {
  const fixture = await useWritingFixture({ maxReadChars: 8192 })
  const input = fixture.input
  const completed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(completed.status, completed.error ?? '').toBe('completed')
  const initial = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls[0]!.deliveries
  expect(initial).toHaveLength(8)
  const removed = initial.find(delivery => delivery.description.startsWith('Chapter 1 body'))!
  const original = await readFile(removed.path)
  await rm(removed.path)
  const requests = fixture.childRequests.length
  const replay = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(replay).toEqual(completed)
  expect(fixture.childRequests).toHaveLength(requests)
  const current = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.find(call => call.callId === 'stage-fixture-2')
  expect(current).toBeDefined()
  expect(current!.deliveries.map(delivery => delivery.source).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    .toEqual(initial.map(delivery => delivery.source).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  expect(await readFile(removed.path)).toEqual(original)
})

it('retains saved research after failed native capture and reuses its history without presenting it on retry', async () => {
  let breakResearch = true
  let observeRetry: (() => void) | undefined
  const fixture = await useWritingFixture({ maxReadChars: 8192,
    intervene(stage, output) { return stage.kind === 'research' && breakResearch ? { planId: 0 } : output },
    onChildRequest() { const observe = observeRetry; observeRetry = undefined; observe?.() },
  })
  const input = { ...fixture.input, chapterCount: 1, throughChapter: 1 }
  const failed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('Writing stage ended without a complete structured result')
  const plans = fixture.service.listResearch(fixture.actor, fixture.novel.id)
  expect(plans.length).toBeGreaterThanOrEqual(1)
  expect(plans.every(plan => plan.result !== null)).toBe(true)
  const expected = plans.flatMap(plan => [plan.plan.id, plan.result!.id]).sort()
  const originals = expected.map(artifactId => fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId }))
  const presented = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.flatMap(call => call.deliveries)
  expect(presented.length).toBeGreaterThan(0)
  expect(presented.every(delivery => delivery.description.startsWith('Settings collection'))).toBe(true)
  breakResearch = false
  let retainedBeforeRetry = false
  observeRetry = () => {
    retainedBeforeRetry = expected.every(id => fixture.service.listResearch(fixture.actor, fixture.novel.id).some(plan => plan.plan.id === id || plan.result?.id === id))
    expect(fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.flatMap(call => call.deliveries).every(delivery => delivery.description.startsWith('Settings collection'))).toBe(true)
  }
  const resumed = fulfilled(await fixture.run(exec => fixture.runner.resume(exec, failed.id, true)))
  expect(resumed.status, resumed.error ?? '').toBe('completed')
  expect(retainedBeforeRetry).toBe(true)
  expect(expected.map(artifactId => fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId }))).toEqual(originals)
})

it('delivers all eight reused reader documents without internal artifacts or new child requests', SLOW_REPLAY, async () => {
  const fixture = await useWritingFixture({ maxReadChars: 8192 })
  const input = fixture.input
  const completed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(completed.status, completed.error ?? '').toBe('completed')
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const expected = [...manuscript.heads.map(candidate => candidate.artifact.id), ...manuscript.appliedChapters.map(chapter => chapter.body.id)].sort()
  expect(expected).toHaveLength(8)
  const requests = fixture.childRequests.length
  const reuseInput = { ...input, requestId: parseRequestId('reuse-current-stage-versions') }
  const reused = fulfilled(await fixture.run(exec => fixture.runner.start(exec, reuseInput)))
  expect(reused.status, reused.error ?? '').toBe('completed')
  expect(reused.attempts).toEqual([])
  expect(fixture.childRequests).toHaveLength(requests)
  const current = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.find(call => call.callId === 'stage-fixture-2')
  expect(current?.deliveries.flatMap(delivery => delivery.source.kind === 'artifact' ? [delivery.source.artifactId] : []).sort()).toEqual(expected)
  const retained = current!.deliveries[0]!
  const bytes = await readFile(retained.path)
  await rm(retained.path)
  const replayed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, reuseInput)))
  expect(replayed).toEqual(reused)
  expect(fixture.childRequests).toHaveLength(requests)
  const replay = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.find(call => call.callId === 'stage-fixture-3')
  expect(replay?.deliveries.flatMap(delivery => delivery.source.kind === 'artifact' ? [delivery.source.artifactId] : []).sort()).toEqual(expected)
  expect(await readFile(retained.path)).toEqual(bytes)
})

it('completes research without requesting presentation permission for its internal documents', async () => {
  const fixture = await useWritingFixture({ maxReadChars: 8192 })
  const presentArgs = z.object({ files: z.array(z.object({ path: z.string(), description: z.string().optional() })) })
  let researchPresentationRequested = false
  fixture.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'present' && presentArgs.parse(exec.arguments).files.some(file => file.description?.startsWith('Research'))) {
      researchPresentationRequested = true
      throw new Error('Research presentation is not permitted.')
    }
    return next()
  })
  const completed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 })))
  expect(completed.status, completed.error ?? '').toBe('completed')
  expect(researchPresentationRequested).toBe(false)
  expect(fixture.service.listResearch(fixture.actor, fixture.novel.id)[0]!.result).not.toBeNull()
})

it('keeps cancellation authoritative when the stopped research child already saved evidence', async () => {
  let cancel = () => {}
  const fixture = await useWritingFixture({ maxReadChars: 8192, intervene(stage, output) { if (stage.kind === 'research') cancel(); return output } })
  cancel = () => { fixture.parent.cancel({ kind: 'user' }) }
  const stopped = fulfilled(await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 })))
  expect(stopped.status).toBe('stopped')
  expect(fixture.service.listResearch(fixture.actor, fixture.novel.id).some(plan => plan.result !== null)).toBe(true)
  expect(fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.flatMap(call => call.deliveries).every(delivery => delivery.description.startsWith('Settings collection'))).toBe(true)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('cancels and awaits completed replay presentation during close without changing its completed run', async () => {
  const fixture = await useWritingFixture({ maxReadChars: 8192 })
  const input = { ...fixture.input, chapterCount: 1, throughChapter: 1 }
  const completed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(completed.status, completed.error ?? '').toBe('completed')
  const requests = fixture.childRequests.length
  const entered = Promise.withResolvers<AbortSignal>()
  let presentationStopped = false
  fixture.ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'present') return next()
    entered.resolve(exec.signal)
    try { await once(exec.signal, 'abort'); exec.signal.throwIfAborted() }
    finally { presentationStopped = true }
    return next()
  })
  const replay = fixture.run(exec => fixture.runner.start(exec, input))
  let closing: Promise<void> | undefined
  try {
    const signal = await Promise.race([entered.promise, replay.then(result => { throw new Error(`Replay finished before native presentation: ${JSON.stringify(result)}`) })])
    closing = fixture.runner.close()
    expect(signal.aborted).toBe(true)
    const [closeResult, replayResult] = await Promise.all([Promise.allSettled([closing]), replay])
    expect(closeResult[0]!.status).toBe('fulfilled')
    expect(replayResult.status).toBe('rejected')
    expect(presentationStopped).toBe(true)
    expect(fixture.runs.get(fixture.actor, completed.id)).toEqual(completed)
    expect(fixture.childRequests).toHaveLength(requests)
  } finally {
    fixture.parent.cancel({ kind: 'user' })
    await Promise.allSettled([replay, ...(closing === undefined ? [] : [closing])])
  }
})
