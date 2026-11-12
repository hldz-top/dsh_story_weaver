/** Offline native web calls and an inspecting tool run through a real persisted AgentLoop. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId, type StreamChunk, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import WebRuntime, { type WebSearchProvider, type WebFetchProvider } from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { onTestFinished } from 'vitest'
import { parseNovelId, parseArtifactId, type ResearchView } from '../../src/contracts.ts'
import type { NativeResearchObservation } from '../../src/research-selection.ts'
import { call, ScriptedModel, stop } from './model.ts'

/** Native calls supplied by the fixture model, including their actual tool arguments. */
export interface FixtureWebCall { readonly name: 'web_search' | 'web_fetch'; readonly id: string; readonly args: object }
/** Local provider replacements are the only simulated part of the web execution path. */
export interface ResearchLogFixtureOptions {
  readonly calls: readonly FixtureWebCall[]
  readonly search: WebSearchProvider
  readonly fetch: WebFetchProvider
  readonly fetchMaxOutputChars?: number
  readonly inspectionSignal?: AbortSignal
  readonly inspectAlongside?: boolean
  /** Issue `calls` one at a time, each settled before the next is requested, instead of one parallel batch. Required to reuse a call id: the session format rejects one still-open id advertised twice. */
  readonly sequential?: boolean
  readonly inspect: (ctx: Context, exec: ToolExecution, plan: ResearchView) => Promise<NativeResearchObservation[]>
}

/** Captured public model results and their real Session owner. */
export interface ResearchLogFixture {
  readonly ctx: Context
  readonly agent: Agent
  readonly root: string
  readonly plan: ResearchView
  readonly observations: NativeResearchObservation[] | undefined
  readonly result: ToolResultMessage
  readonly nativeResults: ToolResultMessage[]
}

function parallelCalls(calls: readonly { name: string; id: string; args: object }[]): StreamChunk[] {
  return [
    ...calls.flatMap((item, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(item.id), name: item.name, arguments: JSON.stringify(item.args) } },
    ]),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Run one model-owned research interval and return its inspecting tool's recorded result.
 * @param options - Fixed native calls, local providers and the public collector invocation.
 * @returns Results captured inside the inspecting tool, its durable Session and fixture owner.
 */
export async function useResearchLogFixture(options: ResearchLogFixtureOptions): Promise<ResearchLogFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-research-log-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(WebRuntime, { searchProvider: options.search.id, fetchProvider: options.fetch.id })
  ctx.effect(() => ctx.web.registerSearchProvider(options.search))
  ctx.effect(() => ctx.web.registerFetchProvider(options.fetch))
  await ctx.plugin(ToolWeb, { searchMaxQueries: 4, searchMaxResults: 8, searchTimeoutMs: 5000, fetchTimeoutMs: 5000, fetchMaxOutputChars: options.fetchMaxOutputChars ?? 10000 })
  const inspectionSignal = options.inspectionSignal
  if (inspectionSignal !== undefined) {
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'inspect_research_fixture') exec.signal = AbortSignal.any([exec.signal, inspectionSignal])
      return next()
    })
  }
  let plan: ResearchView
  let observations: NativeResearchObservation[] | undefined
  ctx.tools.register(defineTool({
    name: 'inspect_research_fixture', description: 'Inspect the recorded native research results.', parameters: {},
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => options.inspectAlongside === true,
    async execute(_args, exec) { observations = await options.inspect(ctx, exec, plan); return observations.length },
  }))
  const model = new ScriptedModel((_request, index) => {
    if (options.sequential === true) {
      const scripted = options.calls[index]
      if (scripted !== undefined) return call(scripted.name, scripted.args, scripted.id)
      return index === options.calls.length ? call('inspect_research_fixture', {}, 'inspect-research') : stop()
    }
    return index === 0
      ? parallelCalls(options.inspectAlongside === true ? [...options.calls, { name: 'inspect_research_fixture', args: {}, id: 'inspect-research' }] : options.calls)
      : index === 1 && options.inspectAlongside !== true ? call('inspect_research_fixture', {}, 'inspect-research') : stop()
  })
  ctx.effect(() => ctx.llm.registerAdapter(['research-fixture'], model))
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(randomUUID()), { provider: 'research-fixture', model: 'deterministic' }, { cwd: root })
  const planId = parseArtifactId('artifact_00000000-0000-4000-8000-000000000001')
  plan = {
    novelId: parseNovelId('novel_00000000-0000-4000-8000-000000000001'), planId,
    plan: { id: planId, kind: 'research-plan', revision: 1, sha256: '0'.repeat(64), chars: 2, bytes: 2 },
    result: null, briefArtifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'),
    sessionId: agent.session.id, startSeq: agent.session.seq,
    questions: [{ id: 'history', kind: 'external', question: 'What does the lighthouse record?', reason: 'Historical detail needs a source.' }],
    reservedCalls: options.calls.map(item => ({ callId: ToolCallId(item.id), name: item.name })), outcome: null, stale: false,
  }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Research the lighthouse and inspect its recorded sources.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const result = model.requests.flatMap(request => request.messages)
    .findLast((message): message is ToolResultMessage => message.role === 'tool' && message.toolCallId === 'inspect-research')
  if (result === undefined) throw new Error('Fixture inspector did not return through the real model request')
  const finalRequest = model.requests.at(-1)
  if (finalRequest === undefined) throw new Error('Fixture produced no model request')
  const nativeResults = finalRequest.messages
    .filter((message): message is ToolResultMessage => message.role === 'tool' && options.calls.some(call => call.id === message.toolCallId))
  return { ctx, agent, root, plan, observations, result, nativeResults }
}
