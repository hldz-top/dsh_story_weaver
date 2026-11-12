import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Present from '@deepseek-ai/dsh-tool-present'
import { provideStageWorkingDirectory } from './support/working-directory.ts'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { parseRequestId, SettingsIncompleteError, type Actor } from '../src/contracts.ts'
import { missingRequiredSettings } from '../src/settings-plan.ts'
import { openWritingService } from '../src/service.ts'
import { openRunStore, type BeginRunInput, type WritingRun } from '../src/run-store.ts'
import { WritingRunner, type WritingRunnerOptions } from '../src/writing-runner.ts'
import { StageDeliveries, registerStageDeliveryProjection } from '../src/stage-deliveries.ts'
import { registerRunTools } from '../src/run-tools.ts'
import { call, ScriptedModel, stop } from './support/model.ts'

const executionLimits = { maxRepairAttempts: 1, maxParallelStages: 1, maxStageRequests: 2, stageTimeoutMs: 1000, maxDelegationDepth: 1, minChapterWords: 3000, maxChapterWords: 5000, stageProvider: 'unmounted-fixture-provider' }
const researchLimits = { maxResearchQuestions: 8, maxResearchCalls: 4, maxResearchSources: 8, maxEvidenceChars: 2000, maxResearchLogEvents: 200 }

async function setup(model: ScriptedModel, runnerOptions: WritingRunnerOptions = { allowIncompleteSettings: true }, runToolOptions: { allowSettingsImport?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-run-tools-'))
  const cwd = join(root, 'author')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  provideStageWorkingDirectory(ctx, root)
  await ctx.plugin(Present, new Present.Config())
  await registerStageDeliveryProjection(ctx)
  const service = await openWritingService(ctx.storageDomain, { maxArtifactBytes: 100_000, maxReadChars: 4 }, researchLimits, executionLimits)
  ctx.effect(() => () => service.close())
  const runs = await openRunStore(ctx.storageDomain, { maxAttempts: 8, maxOutputBytes: 100_000 })
  ctx.effect(() => () => runs.close())
  const runner = new WritingRunner(ctx, service, runs, executionLimits, new StageDeliveries(ctx, service, runs, '.dsh-story'), runnerOptions)
  ctx.effect(() => () => runner.close())
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model))
  const registration = await ctx.plugin({ name: 'run-tool-fixture-registration', inject: ['tools', 'fs'], apply(scope: Context) { registerRunTools(scope, service, runner, runToolOptions) } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(randomUUID()), { provider: 'fixture', model: 'deterministic' }, { cwd })
  const resolved = await ctx.fs.resolve('.', { cwd })
  const actor: Actor = { workspace: resolved.displayPath, sessionId: agent.session.id }
  const novel = await service.createNovel(actor, { requestId: parseRequestId('create'), title: 'Harbor', brief: 'A clock keeper discovers a lost shipping log.' })
  const input: BeginRunInput = { novelId: novel.id, briefArtifactId: novel.brief.id, requestId: parseRequestId('write'), settingsRoots: ['a1'], chapterCount: 3, fromChapter: 1, throughChapter: 3, mode: 'write', revision: null, executionLimits, serviceLimits: { ...service.limits, ...service.researchLimits } }
  return { ctx, agent, root, cwd, actor, novel, service, runs, runner, input, harness, registration }
}

function recordedResults(model: ScriptedModel): ToolResultMessage[] {
  const request = model.requests.at(-1)
  if (request === undefined) throw new Error('Native loop did not issue a model request')
  return request.messages.filter((message): message is ToolResultMessage => message.role === 'tool')
}
function jsonResult(result: ToolResultMessage | undefined): unknown {
  if (result?.isError !== false || result.content.length !== 1 || result.content[0]?.type !== 'text') throw new Error('Expected one successful native JSON result')
  return JSON.parse(result.content[0].text) as unknown
}
function beginConversation(agent: Awaited<ReturnType<typeof setup>>['agent']): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the persisted writing progress.' }], source: { kind: 'user' } }))
}

it('returns exact run history through the real tool loop without exposing stored prompts', async () => {
  let run: WritingRun
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_get_run', { runId: run.id })
    : index === 1 ? call('story_list_runs', { novelId: run.novelId }) : stop())
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  await h.runs.prepareAttempt(h.actor, run.id, { key: 'fixture-stage', prompt: 'Private full stage prompt', inputRefs: [{ artifactId: h.novel.brief.id, sha256: h.novel.brief.sha256 }], outputSchema: { type: 'object', properties: {}, additionalProperties: false } })
  await h.runs.finish(h.actor, run.id, 'stopped', 'Stopped before native execution')
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const results = recordedResults(model)
  expect(jsonResult(results[0])).toMatchObject({ id: run.id, status: 'stopped', attempts: [{ key: 'fixture-stage', status: 'unknown', parentSessionId: h.actor.sessionId }] })
  expect(jsonResult(results[1])).toEqual([jsonResult(results[0])])
  expect(JSON.stringify(results)).not.toContain('Private full stage prompt')
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
  await h.registration.dispose()
  expect(h.ctx.tools.get('story_get_run')).toBeUndefined()
})

it('reports explicit refused and truncated attempt classifications through the real tool loop', async () => {
  let run: WritingRun
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_get_run', { runId: run.id }) : stop())
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  const stage = { prompt: 'Private full stage prompt', inputRefs: [{ artifactId: h.novel.brief.id, sha256: h.novel.brief.sha256 }], outputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  const refused = await h.runs.prepareAttempt(h.actor, run.id, { ...stage, key: 'refused-stage' })
  await h.runs.failAttempt(h.actor, run.id, refused.id, { outcome: 'failed', message: 'Writing stage was refused (refusal)', kind: 'refused' })
  const truncated = await h.runs.prepareAttempt(h.actor, run.id, { ...stage, key: 'truncated-stage' })
  await h.runs.failAttempt(h.actor, run.id, truncated.id, { outcome: 'failed', message: 'Writing stage output was truncated', kind: 'truncated' })
  const plain = await h.runs.prepareAttempt(h.actor, run.id, { ...stage, key: 'plain-stage' })
  await h.runs.failAttempt(h.actor, run.id, plain.id, { outcome: 'failed', message: 'Provider rejected before streaming' })
  await h.runs.finish(h.actor, run.id, 'failed', 'Writing stage was refused (refusal)')
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const value = jsonResult(recordedResults(model)[0]) as { attempts: Record<string, unknown>[] }
  expect(value.attempts.map(attempt => [attempt['key'], attempt['status'], attempt['failureKind']])).toEqual([
    ['refused-stage', 'failed', 'refused'], ['truncated-stage', 'failed', 'truncated'], ['plain-stage', 'failed', undefined],
  ])
  expect('failureKind' in value.attempts[2]!).toBe(false)
})

it('returns recorded evidence events on attempts through the native run tool schemas (live run run_dbabf085 failed this readback)', async () => {
  let run: WritingRun
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_get_run', { runId: run.id })
    : index === 1 ? call('story_list_runs', { novelId: run.novelId }) : stop())
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  const attempt = await h.runs.prepareAttempt(h.actor, run.id, { key: 'review-fixture', prompt: 'Private full stage prompt', inputRefs: [{ artifactId: h.novel.brief.id, sha256: h.novel.brief.sha256 }], outputSchema: { type: 'object', properties: {}, additionalProperties: false } })
  await h.runs.associateChild(h.actor, run.id, attempt.id, SessionId(randomUUID()))
  await h.runs.saveOutput(h.actor, run.id, attempt.id, '{}')
  const cited = { artifactId: h.novel.brief.id, quote: '钟楼' }
  await h.runs.recordEvidenceEvents(h.actor, run.id, attempt.id, [
    { kind: 'reattributed', declared: { artifactId: 'artifact_other', quote: '钟楼' }, admitted: [cited], distance: 0, location: 'checks[0]' },
    { kind: 'dropped', declared: cited, admitted: [], distance: 0, location: 'checks[1]', reason: 'Evidence quote does not occur in its declared source' },
    { kind: 'downgraded', declared: cited, admitted: [], distance: 0, location: 'issues[0]', reason: 'blocking continuity issue "i1" made advisory' },
  ])
  await h.runs.finish(h.actor, run.id, 'stopped', 'Stopped before native execution')
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const results = recordedResults(model)
  const value = jsonResult(results[0]) as { attempts: { evidenceEvents?: { kind: string }[] }[] }
  expect(value.attempts[0]!.evidenceEvents?.map(event => event.kind)).toEqual(['reattributed', 'dropped', 'downgraded'])
  expect(jsonResult(results[1])).toEqual([value])
})

const pageSchema = z.strictObject({ runId: z.string(), attemptId: z.string(), sha256: z.string(), bytes: z.number(), totalChars: z.number(), offset: z.number(), limit: z.number(), text: z.string(), nextOffset: z.number(), eof: z.boolean() })
async function saveRawOutput(h: Awaited<ReturnType<typeof setup>>, run: WritingRun) {
  const attempt = await h.runs.prepareAttempt(h.actor, run.id, { key: 'raw-fixture', prompt: 'Retained private stage prompt', inputRefs: [{ artifactId: h.novel.brief.id, sha256: h.novel.brief.sha256 }], outputSchema: { type: 'object', properties: {}, additionalProperties: false } })
  await h.runs.associateChild(h.actor, run.id, attempt.id, SessionId(randomUUID()))
  await h.runs.saveOutput(h.actor, run.id, attempt.id, '潮🌊汐城钟楼')
  return attempt
}

it('reads exact Unicode raw-output pages and EOF through logged tool results', async () => {
  let run: WritingRun
  let attempt: Awaited<ReturnType<typeof saveRawOutput>>
  const model = new ScriptedModel((request, index) => {
    if (index === 0) return call('story_read_run_output', { runId: run.id, attemptId: attempt.id, offset: 0, limit: 2 })
    if (index < 3) {
      const result = request.messages.findLast((message): message is ToolResultMessage => message.role === 'tool')
      const previous = pageSchema.parse(jsonResult(result))
      return call('story_read_run_output', { runId: run.id, attemptId: attempt.id, offset: previous.nextOffset, limit: 4 }, `page-${index}`)
    }
    return stop()
  })
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  attempt = await saveRawOutput(h, run)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const pages = recordedResults(model).map(result => pageSchema.parse(jsonResult(result)))
  expect(pages).toEqual([
    { runId: run.id, attemptId: attempt.id, sha256: '349ee448ecb2fe2abe0233480858ff4be7f1d43c9a89db2b7e326d4952749250', bytes: 19, totalChars: 6, offset: 0, limit: 2, text: '潮🌊', nextOffset: 2, eof: false },
    { runId: run.id, attemptId: attempt.id, sha256: pages[0]?.sha256, bytes: 19, totalChars: 6, offset: 2, limit: 4, text: '汐城钟楼', nextOffset: 6, eof: true },
    { runId: run.id, attemptId: attempt.id, sha256: pages[0]?.sha256, bytes: 19, totalChars: 6, offset: 6, limit: 4, text: '', nextOffset: 6, eof: true },
  ])
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(3)
})

it.each([{ offset: -1, limit: 2 }, { offset: 7, limit: 2 }, { offset: 0, limit: 0 }, { offset: 0, limit: 5 }, { offset: 0.5, limit: 2 }])('rejects an invalid raw-output interval %j without changing saved progress', async interval => {
  let run: WritingRun
  let attempt: Awaited<ReturnType<typeof saveRawOutput>>
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_read_run_output', { runId: run.id, attemptId: attempt.id, ...interval }) : stop())
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  attempt = await saveRawOutput(h, run)
  const before = h.runs.get(h.actor, run.id)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  expect(recordedResults(model)[0]).toMatchObject({ isError: true })
  expect(JSON.stringify(recordedResults(model))).not.toContain('潮🌊汐城钟楼')
  expect(h.runs.get(h.actor, run.id)).toEqual(before)
})

it.each(['write', 'update'] as const)('replays an exact stopped %s request through the real runner', async mode => {
  let input: BeginRunInput
  const model = new ScriptedModel((_request, index) => {
    if (index !== 0) return stop()
    const { executionLimits: _limits, serviceLimits: _serviceLimits, mode: _mode, revision: _revision, ...args } = input
    return call(`story_${mode}`, { ...args })
  })
  const h = await setup(model)
  input = { ...h.input, mode }
  const run = await h.runs.begin(h.actor, input)
  const expected = await h.runs.finish(h.actor, run.id, 'stopped', 'Stopped before native execution')
  beginConversation(h.agent)
  await h.agent.whenIdle()
  expect(jsonResult(recordedResults(model)[0])).toEqual(expected)
  expect(h.runs.list(h.actor, run.novelId)).toEqual([expected])
})

it('keeps the required-settings bypass out of every tool schema', async () => {
  const h = await setup(new ScriptedModel(() => stop()))
  const names = ['story_write', 'story_update', 'story_revise', 'story_resume']
  for (const name of names) {
    const tool = h.ctx.tools.get(name)
    expect(tool, name).toBeDefined()
    expect(JSON.stringify(tool), name).not.toContain('allowIncompleteSettings')
  }
})

it.each([
  { settingsRoots: ['a4', 'a5', 'e1', 'g1'], missing: 'g2 (主线)', codes: ['g2'] },
  { settingsRoots: ['e1'], missing: 'a3 (受众), a4 (风格基调), a5 (时空设定), g1 (金手指), g2 (主线)', codes: ['a3', 'a4', 'a5', 'g1', 'g2'] },
  { settingsRoots: [], missing: 'a1 (类型 / 题材), a2 (流派 / 子类型), a3 (受众), a4 (风格基调), a5 (时空设定), e1 (主角设定), g1 (金手指), g2 (主线)', codes: ['a1', 'a2', 'a3', 'a4', 'a5', 'e1', 'g1', 'g2'] },
])('refuses story_write with incomplete required settings $settingsRoots as a settings-incomplete tool error', async ({ settingsRoots, missing, codes }) => {
  let input: BeginRunInput
  const model = new ScriptedModel((_request, index) => {
    if (index !== 0) return stop()
    const { executionLimits: _limits, serviceLimits: _serviceLimits, mode: _mode, revision: _revision, ...args } = input
    return call('story_write', { ...args, settingsRoots })
  })
  const h = await setup(model, {})
  input = h.input
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const result = recordedResults(model)[0]
  expect(result).toMatchObject({ isError: true })
  expect(result?.content).toEqual([{ type: 'text', text: `Error: Required novel settings are missing: ${missing}. Complete the settings first: choose settingsRoots whose dependencies cover ${missing.includes(',') ? 'them' : 'it'}; ["a4", "a5", "g2"] covers every required setting.\n${JSON.stringify({ code: 'settings-incomplete', missing: codes })}` }])
  expect(h.agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')?.data).toMatchObject({ error: { name: 'SettingsIncompleteError', code: 'settings-incomplete' } })
  expect(JSON.stringify(result)).not.toContain('allowIncompleteSettings')
  expect(h.runs.list(h.actor, input.novelId)).toEqual([])
})

it('refuses story_resume of a run with incomplete required settings as a settings-incomplete tool error and keeps the run', async () => {
  let run: WritingRun
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_resume', { runId: run.id, retryUnknown: true }) : stop())
  const h = await setup(model, {})
  run = await h.runs.begin(h.actor, h.input)
  const stopped = await h.runs.finish(h.actor, run.id, 'stopped', 'Retained run admitted before the gate.')
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const result = recordedResults(model)[0]
  expect(result).toMatchObject({ isError: true })
  const codes = ['a2', 'a3', 'a4', 'a5', 'e1', 'g1', 'g2']
  expect(result?.content).toEqual([{ type: 'text', text: `Error: ${new SettingsIncompleteError(missingRequiredSettings(['a1'])).message}` }])
  const text = result?.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(JSON.parse(text.split('\n').at(-1) ?? '')).toEqual({ code: 'settings-incomplete', missing: codes })
  expect(h.agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')?.data).toMatchObject({ error: { name: 'SettingsIncompleteError', code: 'settings-incomplete' } })
  expect(JSON.stringify(result)).not.toContain('allowIncompleteSettings')
  expect(h.runs.get(h.actor, run.id)).toEqual(stopped)
  expect(h.runs.list(h.actor, h.novel.id)).toEqual([stopped])
})

it.each([{ fromChapter: 0 }, { fromChapter: 3, throughChapter: 2 }, { throughChapter: 4 }, { settingsRoots: ['e8'] }, { settingsRoots: [] }, { settingsRoots: ['missing'] }])('refuses an invalid writing scope %j before preparing native work', async change => {
  let input: BeginRunInput
  const model = new ScriptedModel((_request, index) => {
    if (index !== 0) return stop()
    const { executionLimits: _limits, serviceLimits: _serviceLimits, mode: _mode, revision: _revision, ...args } = input
    return call('story_write', { ...args, ...change })
  })
  const h = await setup(model)
  input = h.input
  beginConversation(h.agent)
  await h.agent.whenIdle()
  expect(recordedResults(model)[0]).toMatchObject({ isError: true })
  expect(h.ctx.tools.get('story_write')).toBeDefined()
  expect(h.runs.list(h.actor, input.novelId)).toEqual([])
})

it('stops a prepared run and refuses unknown replay without explicit true authorization', async () => {
  let run: WritingRun
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_stop', { runId: run.id })
    : index === 1 ? call('story_resume', { runId: run.id })
    : index === 2 ? call('story_resume', { runId: run.id, retryUnknown: false }, 'resume-false')
    : index === 3 ? call('story_get_run', { runId: run.id }) : stop())
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  const attempt = await h.runs.prepareAttempt(h.actor, run.id, { key: 'not-started', prompt: 'Prepare before native startup.', inputRefs: [{ artifactId: h.novel.brief.id, sha256: h.novel.brief.sha256 }], outputSchema: { type: 'object', properties: {}, additionalProperties: false } })
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const results = recordedResults(model)
  expect(jsonResult(results[0])).toMatchObject({ id: run.id, status: 'stopped', attempts: [{ id: attempt.id, status: 'unknown', childSessionId: null, retryAuthorized: false }] })
  expect(results[1]).toMatchObject({ isError: true })
  expect(JSON.stringify(results[1])).toContain('retryUnknown')
  expect(results[2]).toMatchObject({ isError: true })
  expect(JSON.stringify(results[2])).toContain('Explicit retry permission')
  expect(jsonResult(results[3])).toEqual(jsonResult(results[0]))
})

async function appliedSettings(h: Awaited<ReturnType<typeof setup>>) {
  const plan = await h.service.startResearch(h.actor, { novelId: h.novel.id, requestId: parseRequestId('plan'), briefArtifactId: h.novel.brief.id, questions: [{ id: 'genre', kind: 'creative', question: 'Choose genre.', reason: 'Authorial choice.' }] }, 0)
  await h.service.completeSelectedResearch(h.actor, { novelId: h.novel.id, planId: plan.planId, requestId: parseRequestId('findings'), findings: [{ questionId: 'genre', callIds: [], selections: [], conclusion: 'Mystery.', adequate: true }] }, [])
  const inputRefs = h.service.settingsInputs(h.actor, h.novel.id, 'a1', plan.planId).map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
  const candidate = await h.service.saveSettingsCandidate(h.actor, { novelId: h.novel.id, requestId: parseRequestId('candidate'), dimensionCode: 'a1', researchPlanId: plan.planId, childSessionId: SessionId(randomUUID()), output: { version: 1, dimensionCode: 'a1', inputRefs, facts: [{ id: 'genre', statement: 'Mystery.' }], contentMarkdown: 'Full private setting text: a mystery.' } })
  const evidence = [{ artifactId: candidate.artifact.id, quote: 'a mystery.' }]
  const reviewed = await h.service.saveSettingsReview(h.actor, { novelId: h.novel.id, candidateId: candidate.artifact.id, expectedReviewId: null, requestId: parseRequestId('review'), childSessionId: SessionId(randomUUID()), output: { version: 1, reviewed: { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, inputRefs, checks: [{ category: 'completeness', summary: 'Genre present.', evidence }, { category: 'consistency', summary: 'Genre matches.', evidence }], issues: [] } })
  if (reviewed.review === null) throw new Error('Missing persisted fixture review')
  await h.service.applySettingsCandidate(h.actor, { novelId: h.novel.id, candidateId: candidate.artifact.id, reviewId: reviewed.review.id, expectedAppliedId: null })
  const collection = await h.service.assembleSettings(h.actor, { novelId: h.novel.id, requestId: parseRequestId('assemble'), selectedCodes: ['a1'] })
  return { candidate, collection }
}

it('returns persisted settings candidates and manuscript collections without their long content', async () => {
  let novelId: string
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_get_settings', { novelId }) : index === 1 ? call('story_get_manuscript', { novelId }) : stop())
  const h = await setup(model)
  novelId = h.novel.id
  await appliedSettings(h)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const results = recordedResults(model)
  expect(jsonResult(results[0])).toEqual({ novelId, ...h.service.getSettings(h.actor, h.novel.id) })
  // Host-measured beats feed body reviews only; the read tool does not publish them.
  const manuscript = h.service.getManuscript(h.actor, h.novel.id)
  const published = (items: typeof manuscript.history) => items.map(({ beats: _beats, aiTone: _aiTone, ...item }) => item)
  expect(jsonResult(results[1])).toEqual({ novelId, ...manuscript, history: published(manuscript.history), heads: published(manuscript.heads) })
  expect(JSON.stringify(results)).not.toContain('Full private setting text')
})

it('exposes selectable catalog dependencies without implicitly selecting every dimension', async () => {
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_settings_catalog', {})
    : index === 1 ? call('story_settings_catalog', { settingsRoots: ['e1'] }, 'selected')
    : index === 2 ? call('story_settings_catalog', { settingsRoots: ['e8'] }, 'external') : stop())
  const h = await setup(model)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const results = recordedResults(model)
  const summarySchema = z.object({ code: z.string(), name: z.string(), dependsOn: z.array(z.string()), enabled: z.boolean(), kind: z.string(), requiredFor: z.array(z.string()), pullsIn: z.array(z.string()), closureSize: z.number() })
  const catalog = z.object({ dimensions: z.array(summarySchema), plan: z.null() }).parse(jsonResult(results[0]))
  expect(catalog.dimensions).toHaveLength(60)
  expect(catalog.dimensions.some(dimension => dimension.code === 'e8')).toBe(false)
  expect(catalog.dimensions.find(dimension => dimension.code === 'e1')).toMatchObject({ dependsOn: ['a1', 'a2'], pullsIn: ['a1', 'a2'], closureSize: 3 })
  expect(jsonResult(results[1])).toMatchObject({ plan: { selectedCodes: ['a1', 'a2', 'e1'], layers: [['a1'], ['a2'], ['e1']] } })
  expect(results[2]).toMatchObject({ isError: true })
  expect(JSON.stringify(results[2])).toContain('External settings dimension')
})

it('uses the actual calling Session workspace for every stored run and artifact query', async () => {
  let run: WritingRun
  let attempt: Awaited<ReturnType<typeof saveRawOutput>>
  const names = ['story_get_run', 'story_list_runs', 'story_read_run_output', 'story_get_settings', 'story_get_manuscript', 'story_stop', 'story_resume']
  const model = new ScriptedModel((_request, index) => {
    const name = names[index]
    if (name === undefined) return stop()
    if (name === 'story_read_run_output') return call(name, { runId: run.id, attemptId: attempt.id, offset: 0, limit: 4 })
    if (name === 'story_resume') return call(name, { runId: run.id, retryUnknown: false })
    if (name === 'story_get_run' || name === 'story_stop') return call(name, { runId: run.id })
    return call(name, { novelId: run.novelId })
  })
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  attempt = await saveRawOutput(h, run)
  const before = h.runs.get(h.actor, run.id)
  const foreignCwd = join(h.root, 'other-author')
  await mkdir(foreignCwd)
  const foreign = await h.harness.create(SessionId(randomUUID()), { provider: 'fixture', model: 'deterministic' }, { cwd: foreignCwd })
  beginConversation(foreign)
  await foreign.whenIdle()
  const results = recordedResults(model)
  expect(results).toHaveLength(names.length)
  expect(results.every(result => result.isError === true)).toBe(true)
  for (const name of names) expect(h.ctx.tools.get(name)).toBeDefined()
  expect(JSON.stringify(results)).not.toContain('潮🌊汐城钟楼')
  expect(h.runs.get(h.actor, run.id)).toEqual(before)
})


it('replays the exact upstream-only revision intent without starting downstream work', async () => {
  let input: BeginRunInput
  const model = new ScriptedModel((_request, index) => {
    if (index !== 0) return stop()
    if (input.revision === null) throw new Error('Missing fixture revision')
    const { executionLimits: _limits, serviceLimits: _serviceLimits, mode: _mode, revision, ...args } = input
    return call('story_revise', { ...args, ...revision })
  })
  const h = await setup(model)
  const { candidate } = await appliedSettings(h)
  input = { ...h.input, mode: 'revise', revision: { baseArtifactId: candidate.artifact.id, instructions: 'Keep the genre but make the mystery more intimate.' } }
  const run = await h.runs.begin(h.actor, input)
  const expected = await h.runs.finish(h.actor, run.id, 'stopped', 'Stopped before native execution')
  const before = h.service.getManuscript(h.actor, h.novel.id)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  expect(jsonResult(recordedResults(model)[0])).toEqual(expected)
  expect(h.runs.get(h.actor, run.id).attempts).toEqual([])
  expect(h.service.getManuscript(h.actor, h.novel.id)).toEqual(before)
})

it('requires an exact base version and nonblank instructions for upstream revision', async () => {
  let input: BeginRunInput
  const model = new ScriptedModel((_request, index) => {
    if (index > 1) return stop()
    const { executionLimits: _limits, serviceLimits: _serviceLimits, mode: _mode, revision: _revision, ...args } = input
    return index === 0 ? call('story_revise', { ...args, instructions: 'Change the setting.' })
      : call('story_revise', { ...args, baseArtifactId: input.briefArtifactId, instructions: '  ' }, 'blank-instructions')
  })
  const h = await setup(model)
  input = h.input
  beginConversation(h.agent)
  await h.agent.whenIdle()
  expect(h.ctx.tools.get('story_revise')).toBeDefined()
  const results = recordedResults(model)
  expect(results).toHaveLength(2)
  expect(results.every(result => result.isError)).toBe(true)
  expect(JSON.stringify(results[0])).toContain('baseArtifactId')
  expect(h.runs.list(h.actor, input.novelId)).toEqual([])
})


it('returns explicit missing legacy limits through the native tool schema and refuses resume without mutation', async () => {
  let run: WritingRun
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_get_run', { runId: run.id })
    : index === 1 ? call('story_resume', { runId: run.id, retryUnknown: true }) : stop())
  const h = await setup(model)
  run = await h.runs.begin(h.actor, h.input)
  const attempt = await saveRawOutput(h, run)
  await h.runs.finish(h.actor, run.id, 'stopped', 'Retained pre-snapshot run.')
  await h.registration.dispose()
  await h.runner.close()
  await h.runs.close()
  const file = join(h.root, 'storage', 'story_runs.json')
  const document: { tables: { novels: Record<string, { version: number; runs: (Omit<WritingRun, 'serviceLimits'> & { serviceLimits?: WritingRun['serviceLimits'] })[] }> } } = JSON.parse(await readFile(file, 'utf8'))
  const history = document.tables.novels[h.novel.id]
  if (history === undefined) throw new Error('Native fixture history is missing')
  history.version = 1
  for (const old of history.runs) delete old.serviceLimits
  await writeFile(file, JSON.stringify(document))
  const runs = await openRunStore(h.ctx.storageDomain, h.runs.limits)
  h.ctx.effect(() => () => runs.close())
  const runner = new WritingRunner(h.ctx, h.service, runs, executionLimits, new StageDeliveries(h.ctx, h.service, runs, '.dsh-story'), { allowIncompleteSettings: true })
  h.ctx.effect(() => () => runner.close())
  await h.ctx.plugin({ name: 'legacy-run-tool-registration', inject: ['tools', 'fs'], apply(scope: Context) { registerRunTools(scope, h.service, runner) } })
  const before = runs.get(h.actor, run.id)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const results = recordedResults(model)
  expect(jsonResult(results[0])).toEqual(before)
  expect(jsonResult(results[0])).toMatchObject({ serviceLimits: null, status: 'stopped' })
  expect(results[1]?.isError).toBe(true)
  expect(JSON.stringify(results[1])).toContain('legacy runs without a snapshot cannot resume')
  expect(runs.get(h.actor, run.id)).toEqual(before)
  expect(runs.readOutput(h.actor, run.id, attempt.id).text).toBe('潮🌊汐城钟楼')
})

it('G1: keeps story_settings_import out of the tool schema unless the operator enables allowSettingsImport', async () => {
  const off = await setup(new ScriptedModel(() => stop()))
  expect(off.ctx.tools.get('story_settings_import')).toBeUndefined()
  expect(off.ctx.tools.get('story_get_settings')).toBeDefined()
  const on = await setup(new ScriptedModel(() => stop()), { allowIncompleteSettings: true }, { allowSettingsImport: true })
  expect(on.ctx.tools.get('story_settings_import')).toBeDefined()
})

it('G2: reports an import refused by an unfinished run with a machine-readable last line through the real tool loop', async () => {
  let args: Record<string, unknown> = {}
  const model = new ScriptedModel((_request, index) => index === 0 ? call('story_settings_import', args) : stop())
  const h = await setup(model, { allowIncompleteSettings: true }, { allowSettingsImport: true })
  const held = await h.runs.begin(h.actor, h.input)
  // A well-formed document; this novel has no adopted a1 yet, so the refusal must come from the run-active check that precedes every other check.
  args = { novelId: h.novel.id, requestId: 'import-a1', dimensionCode: 'a1', expectedAppliedId: h.novel.brief.id, output: JSON.stringify({ version: 1, dimensionCode: 'a1', inputRefs: [], facts: [{ id: 'genre', statement: 'A harbor mystery.' }], contentMarkdown: '# Genre\n\nHarbor mystery.' }) }
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const result = recordedResults(model)[0]
  expect(result?.isError).toBe(true)
  const text = result?.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(JSON.parse(text.split('\n').at(-1) ?? '')).toEqual({ code: 'import-refused', reason: 'run-active', runId: held.id })
  expect(text).toContain(`writing run (${held.id}); stop it first`)
})

it('reports story_write refused by an unfinished run with the holding runId on the readable line and the JSON last line', async () => {
  let input: BeginRunInput
  const model = new ScriptedModel((_request, index) => {
    if (index !== 0) return stop()
    const { executionLimits: _limits, serviceLimits: _serviceLimits, mode: _mode, revision: _revision, ...args } = input
    return call('story_write', { ...args, requestId: 'second-write', settingsRoots: ['a4', 'a5', 'g2'] })
  })
  const h = await setup(model, {})
  input = h.input
  const held = await h.runs.begin(h.actor, h.input)
  beginConversation(h.agent)
  await h.agent.whenIdle()
  const result = recordedResults(model)[0]
  expect(result?.isError).toBe(true)
  const text = result?.content[0]?.type === 'text' ? result.content[0].text : ''
  const lines = text.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe(`Error: The novel already has an unfinished writing run (${held.id}); stop it with story_stop or resume it with story_resume first`)
  expect(JSON.parse(lines[1] ?? '')).toEqual({ code: 'active-run', runId: held.id })
  expect(h.runs.list(h.actor, input.novelId).map(run => run.id)).toEqual([held.id])
})
