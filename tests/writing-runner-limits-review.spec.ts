import { once } from 'node:events'
import { join } from 'node:path'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as Present from '@deepseek-ai/dsh-tool-present'
import * as Story from '../src/index.ts'
import { openRunStore } from '../src/run-store.ts'
import { parseRequestId } from '../src/contracts.ts'
import { useStageFixture } from './support/stage-fixture.ts'
import { stop } from './support/model.ts'
import { expect, it } from 'vitest'
import { WritingRunner } from '../src/writing-runner.ts'
import { StageDeliveries } from '../src/stage-deliveries.ts'
import { openWritingService } from '../src/service.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

it('rejects incompatible chapter bounds without changing the stopped run or occupying its active slot', async () => {
  const fixture = await useWritingFixture({ executionLimits: { maxChapterWords: 4500 } })
  const run = await fixture.runs.begin(fixture.actor, { ...fixture.input, revision: null, executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } })
  const stopped = await fixture.runs.finish(fixture.actor, run.id, 'stopped', 'Author stopped before native work.')
  await fixture.runner.close()
  await fixture.service.close()
  const service = await openWritingService(fixture.ctx.storageDomain, fixture.service.limits, fixture.service.researchLimits,
    { minChapterWords: 3000, maxChapterWords: 5000 })
  const runner = new WritingRunner(fixture.ctx, service, fixture.runs, { ...fixture.runner.limits, maxChapterWords: 5000 }, new StageDeliveries(fixture.ctx, service, fixture.runs, '.dsh-story'), { allowIncompleteSettings: true })
  fixture.ctx.effect(() => () => service.close())
  fixture.ctx.effect(() => () => runner.close())
  const outcome = await fixture.run(exec => runner.resume(exec, run.id, false))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'run-limits' } })
  if (outcome.status !== 'rejected') throw new Error('Resume was not refused')
  const message = (outcome.reason as Error).message
  expect(message).toContain('maxChapterWords (saved 4500, current 5000)')
  expect(JSON.parse(message.split('\n').at(-1)!)).toEqual({ code: 'run-limits', mismatched: [{ key: 'maxChapterWords', saved: 4500, current: 5000 }] })
  expect(fixture.childRequests).toEqual([])
  expect(fixture.runs.get(fixture.actor, run.id)).toEqual(stopped)
})

it('rejects incompatible research admission limits before changing saved progress or retry authorization', async () => {
  const entered = Promise.withResolvers<void>()
  let observing = true
  const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest(stage) {
    if (observing && stage.kind === 'book-outline') entered.resolve()
  } })
  const outcome = await fixture.run(async exec => {
    const writing = fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 })
    await Promise.race([entered.promise, writing.then(run => { throw new Error(`Writing ended before the settings barrier: ${run.error}`) })])
    observing = false
    const run = fixture.runs.list(fixture.actor, fixture.novel.id)[0]
    if (run === undefined) throw new Error('Native writing did not save its run')
    const stopped = await fixture.runner.stop(exec, run.id)
    expect(await writing).toEqual(stopped)
    return stopped
  })
  if (outcome.status === 'rejected') throw outcome.reason
  const stopped = outcome.value
  expect(stopped.status).toBe('stopped')
  const research = stopped.attempts.find(attempt => attempt.key.endsWith('/research') && attempt.status === 'succeeded')
  expect(research?.output).not.toBeNull()
  if (research === undefined) throw new Error('No durable native research result was retained')
  const saved = fixture.runs.readOutput(fixture.actor, stopped.id, research.id)
  const callsAtStop = fixture.childRequests.length
  await fixture.runner.close()
  await fixture.service.close()
  const service = await openWritingService(fixture.ctx.storageDomain, fixture.service.limits,
    { ...fixture.service.researchLimits, maxResearchLogEvents: 1 }, fixture.service.manuscriptLimits)
  const runner = new WritingRunner(fixture.ctx, service, fixture.runs, fixture.runner.limits, new StageDeliveries(fixture.ctx, service, fixture.runs, '.dsh-story'), { allowIncompleteSettings: true })
  fixture.ctx.effect(() => () => service.close())
  fixture.ctx.effect(() => () => runner.close())
  const resumed = await fixture.run(exec => runner.resume(exec, stopped.id, true))
  expect(fixture.childRequests).toHaveLength(callsAtStop)
  expect(fixture.runs.readOutput(fixture.actor, stopped.id, research.id)).toEqual(saved)
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'rejected', reason: { code: 'run-limits' } })
  expect(fixture.runs.get(fixture.actor, stopped.id)).toEqual(stopped)
})


it('unloads the actual plugin only after its active native run saves stopped state', async () => {
  const fixture = await useStageFixture(() => stop())
  await fixture.ctx.plugin(Storage)
  await fixture.ctx.plugin(JsonStorage, { root: join(fixture.root, 'writing-storage') })
  await fixture.ctx.plugin(DomainStorage, { backend: 'json' })
  await fixture.ctx.plugin(LocalFileSystem, { cwd: fixture.root })
  await fixture.ctx.plugin(WebRuntime, { searchProvider: 'unused-search', fetchProvider: 'unused-fetch' })
  fixture.ctx.effect(() => fixture.ctx.web.registerSearchProvider({ id: 'unused-search', available: () => true, search: async () => ({ sources: [], truncated: false }) }))
  fixture.ctx.effect(() => fixture.ctx.web.registerFetchProvider({ id: 'unused-fetch', available: () => true, fetch: async request => ({ url: request.url, statusCode: 200, body: { kind: 'text', content: 'Unused offline response.' }, truncated: false }) }))
  await fixture.ctx.plugin(ToolWeb, { searchMaxQueries: 4, searchMaxResults: 8, searchTimeoutMs: 5000, fetchTimeoutMs: 5000, fetchMaxOutputChars: 10000 })
  await fixture.ctx.plugin(Present, new Present.Config())
  const plugin = await fixture.ctx.plugin(Story, new Story.Config({ ...new Story.Config(), stageProvider: 'stage-spawn', allowIncompleteSettings: true }))
  const runner = fixture.ctx.storyRunner
  const workspace = await fixture.ctx.fs.resolve('.', { cwd: fixture.root })
  const actor = { sessionId: fixture.parent.session.id, workspace: workspace.displayPath }
  const novel = await fixture.ctx.story.createNovel(actor, { requestId: parseRequestId('dispose-fixture-novel'), title: 'Unloading novel', brief: 'Write a fictional lighthouse mystery.' })
  const entered = Promise.withResolvers<void>()
  fixture.ctx.on('llm/stream', async function* (request, next): AsyncIterable<StreamChunk> {
    if (request.sessionId !== fixture.parent.session.id) {
      if (request.signal === undefined) throw new Error('Native writing child has no cancellation signal')
      expect(request.provider).toBe('stage-fixture')
      expect(request.model).toBe('inherited-model')
      request.signal.throwIfAborted()
      entered.resolve()
      await once(request.signal, 'abort')
      request.signal.throwIfAborted()
    }
    yield* next()
  }, { global: true })
  const writing = fixture.run(exec => runner.start(exec, { novelId: novel.id, briefArtifactId: novel.brief.id, requestId: parseRequestId('dispose-fixture-run'),
    settingsRoots: ['a1'], chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write' }))
  await Promise.race([entered.promise, writing.then(result => { throw new Error(`Writing ended before native dispatch barrier: ${JSON.stringify(result)}`) })])
  const run = runner.runs.list(actor, novel.id)[0]
  if (run === undefined) throw new Error('Active native writing run was not stored')
  await plugin.dispose()
  const result = await writing
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  const reopened = await openRunStore(fixture.ctx.storageDomain, runner.runs.limits)
  fixture.ctx.effect(() => () => reopened.close())
  expect(result, JSON.stringify({ storedStatus: reopened.get(actor, run.id).status, error: result.status === 'rejected' ? String(result.reason) : null })).toMatchObject({ status: 'fulfilled', value: { status: 'stopped' } })
  expect(reopened.get(actor, run.id).status).toBe('stopped')
})
