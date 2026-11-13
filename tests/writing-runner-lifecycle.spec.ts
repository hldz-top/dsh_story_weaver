import { expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { once } from 'node:events'
import { useWritingFixture } from './support/writing-fixture.ts'

function fulfilled<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}

it('replays a completed writing request in the same native parent without new child work', async () => {
  const fixture = await useWritingFixture({ maxReadChars: 8192 })
  const input = { ...fixture.input, chapterCount: 1, throughChapter: 1 }
  const completed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(completed.error).toBeNull()
  expect(completed.status).toBe('completed')
  const requests = fixture.childRequests.length
  const replay = fulfilled(await fixture.run(exec => fixture.runner.start(exec, input)))
  expect(replay).toEqual(completed)
  expect(fixture.childRequests).toHaveLength(requests)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('stops native work, requires permission for an unknown attempt and reuses completed output on resume', async () => {
  const bodyEntered = Promise.withResolvers<void>()
  let observeBody = true
  const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest(stage) {
    if (observeBody && stage.kind === 'body') bodyEntered.resolve()
  } })
  const input = { ...fixture.input, chapterCount: 1, throughChapter: 1 }
  const stopped = fulfilled(await fixture.run(async exec => {
    const running = fixture.runner.start(exec, input)
    await Promise.race([bodyEntered.promise, running.then(result => { throw new Error(`Writing finished before the body barrier: ${result.error}`) })])
    observeBody = false
    const run = fixture.runs.list(fixture.actor, fixture.novel.id)[0]
    if (run === undefined) throw new Error('Writing run was not persisted before its body')
    const stopped = await fixture.runner.stop(exec, run.id)
    expect(await running).toEqual(stopped)
    return stopped
  }))
  expect(stopped.status).toBe('stopped')
  expect(stopped.attempts.some(attempt => attempt.status === 'unknown')).toBe(true)
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toEqual([])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  const saved = stopped.attempts.filter(attempt => attempt.status === 'succeeded')
  expect(saved.length).toBeGreaterThan(0)
  const savedOutputs = saved.map(attempt => fixture.runs.readOutput(fixture.actor, stopped.id, attempt.id))
  const requestsAtStop = fixture.childRequests.length
  const denied = await fixture.run(exec => fixture.runner.resume(exec, stopped.id, false))
  expect(denied).toMatchObject({ status: 'rejected', reason: { code: 'unknown-outcome' } })
  expect(fixture.childRequests).toHaveLength(requestsAtStop)
  const resumed = fulfilled(await fixture.run(exec => fixture.runner.resume(exec, stopped.id, true)))
  expect(resumed.error).toBeNull()
  expect(resumed.status).toBe('completed')
  const savedIds = new Set(saved.map(attempt => attempt.id))
  expect(resumed.attempts.filter(attempt => savedIds.has(attempt.id))).toEqual(saved)
  expect(saved.map(attempt => fixture.runs.readOutput(fixture.actor, stopped.id, attempt.id))).toEqual(savedOutputs)
  const savedChildren = new Set(saved.map(attempt => attempt.childSessionId))
  expect(fixture.childRequests.slice(requestsAtStop).some(request => request.sessionId !== undefined && savedChildren.has(request.sessionId))).toBe(false)
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('awaits an already-admitted begin during shutdown and starts no child after closing', async () => {
  const fixture = await useWritingFixture({ maxReadChars: 8192 })
  const persisted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const begin = fixture.runs.begin.bind(fixture.runs)
  const delayed = vi.spyOn(fixture.runs, 'begin').mockImplementation(async (actor, input) => {
    const run = await begin(actor, input)
    persisted.resolve()
    await release.promise
    return run
  })
  const started = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  try {
    await Promise.race([persisted.promise, started.then(result => { throw new Error(`Writing finished before durable begin was delayed: ${JSON.stringify(result)}`) })])
    let closed = false
    const closing = fixture.runner.close().then(() => { closed = true })
    await setImmediate()
    const closedBeforeRelease = closed
    release.resolve()
    const [startResult, closeResult] = await Promise.allSettled([started, closing])
    expect(closeResult.status).toBe('fulfilled')
    expect(startResult.status).toBe('fulfilled')
    expect(closedBeforeRelease).toBe(false)
    expect(fixture.childRequests).toEqual([])
    expect(fixture.runs.list(fixture.actor, fixture.novel.id)).toMatchObject([{ status: 'stopped' }])
    expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  } finally {
    release.resolve()
    await started
    delayed.mockRestore()
  }
})

it('resumes its own interrupted cross-dimension repair without rejecting the resulting stale prerequisite', async () => {
  let blockedCollection = false
  const stalePublished = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({ maxReadChars: 8192, intervene(stage, output) {
    if (stage.kind !== 'review' || stage.task?.reviewed === undefined || blockedCollection) return output
    if (stage.sources.get(stage.task.reviewed.artifactId)?.kind !== 'settings') return output
    blockedCollection = true
    const review = output as { checks: { evidence: unknown[] }[] }
    return { ...review, issues: [{ id: 'cross-dimension-conflict', category: 'consistency', severity: 'blocking', location: 'Selected dimensions',
      message: 'Repair the selected dimensions together before accepting the collection.', evidence: review.checks[0]!.evidence }] }
  } })
  const apply = fixture.service.applySettingsCandidate.bind(fixture.service)
  let holdRepair = true
  const delayed = vi.spyOn(fixture.service, 'applySettingsCandidate').mockImplementation(async (actor, request) => {
    const result = await apply(actor, request)
    if (holdRepair && result.dimensionCode === 'a1' && fixture.service.getSettings(actor, request.novelId).applied.some(item => item.dimensionCode === 'a2' && item.stale)) {
      holdRepair = false
      if (actor.signal === undefined) throw new Error('Writing application must carry its run cancellation signal')
      stalePublished.resolve()
      await once(actor.signal, 'abort')
    }
    return result
  })
  try {
    const stopped = fulfilled(await fixture.run(async exec => {
      const running = fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a2'], chapterCount: 1, throughChapter: 1 })
      await Promise.race([stalePublished.promise, running.then(result => { throw new Error(`Writing ended before cross-dimension repair was interrupted: ${result.error}`) })])
      const run = fixture.runs.list(fixture.actor, fixture.novel.id)[0]
      if (run === undefined) throw new Error('Writing run was not persisted before repair')
      const stopped = await fixture.runner.stop(exec, run.id)
      expect(await running).toEqual(stopped)
      return stopped
    }))
    expect(stopped.status).toBe('stopped')
    expect(stopped.attempts.some(attempt => attempt.status === 'unknown')).toBe(false)
    expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied).toEqual(expect.arrayContaining([expect.objectContaining({ dimensionCode: 'a2', stale: true })]))
    const existingChildren = new Set(fixture.stages.keys())
    const resumed = fulfilled(await fixture.run(exec => fixture.runner.resume(exec, stopped.id, false)))
    expect(resumed.error).toBeNull()
    expect(resumed.status).toBe('completed')
    expect([...fixture.stages.values()].filter(stage => !existingChildren.has(stage.sessionId) && stage.kind === 'settings' && stage.task?.dimensionCode === 'a1')).toEqual([])
    expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.every(item => !item.stale)).toBe(true)
    expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toHaveLength(1)
    expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  } finally { delayed.mockRestore() }
})
