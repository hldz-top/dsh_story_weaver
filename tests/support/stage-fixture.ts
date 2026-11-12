/** Persisted AgentLoop and native spawn fixture; only the model is scripted. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type GenerateOptions, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { onTestFinished } from 'vitest'
import { call, ScriptedModel, stop } from './model.ts'
import { provideStageWorkingDirectory } from './working-directory.ts'

class StageFixtureModel extends ScriptedModel {
  override providerRetryPolicy(): ResolvedRetryPolicy {
    return { mode: 'normal', maxRetries: 10, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  }
}

/**
 * Mount the actual parent/child execution path without external model calls.
 * @param reply - Child model responses, counted separately from parent requests.
 * @param options - Optional real host retry policy execution.
 * @returns The isolated capabilities and a sequential parent tool driver; concurrent drives reject.
 */
export async function useStageFixture(reply: (request: GenerateOptions, index: number) => StreamChunk[] | Promise<StreamChunk[]>, options: { retry?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-stage-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  provideStageWorkingDirectory(ctx, root)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'stage-spawn' })
  if (options.retry) await ctx.plugin(Retry)
  const parentId = SessionId(randomUUID())
  const childRequests: GenerateOptions[] = []
  let parentRequests = 0
  let drive = 0
  const model: ScriptedModel = new StageFixtureModel(request => {
    if (request.sessionId === parentId) return parentRequests++ === 0
      ? call('execute_stage_fixture', {}, `stage-fixture-${drive}`) : stop()
    return reply(request, childRequests.push(request) - 1)
  })
  ctx.effect(() => ctx.llm.registerAdapter(['stage-fixture'], model))
  const harness = await mountAgentLoopTestHarness(ctx)
  const parent = await harness.create(parentId, { provider: 'stage-fixture', model: 'inherited-model' }, { cwd: root })
  let current: ((exec: ToolExecution) => Promise<void>) | undefined
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'execute_stage_fixture', description: 'Run the requested writing stage.', parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Stage completed.' }] },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      if (current === undefined) throw new Error('The parent fixture has no active drive')
      await current(exec)
      return true
    },
  })))
  async function run<T>(execute: (exec: ToolExecution) => Promise<T>): Promise<PromiseSettledResult<T>> {
    if (current !== undefined) throw new Error('Concurrent native parent drives are not supported')
    let outcome: PromiseSettledResult<T> | undefined
    parentRequests = 0
    drive += 1
    current = async exec => {
      const [settled] = await Promise.allSettled([execute(exec)])
      outcome = settled
      if (settled.status === 'rejected') throw settled.reason
    }
    try {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Execute the writing stage.' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      if (outcome === undefined) throw new Error('The parent tool did not settle')
      return outcome
    } finally { current = undefined }
  }
  return { ctx, parent, root, model, childRequests, run }
}

/**
 * Mount a real cancellable tool and expose its entered/stopped observations.
 * @param ctx - The isolated fixture context that owns the registration.
 * @returns Barriers used to place cancellation after tool dispatch.
 */
export function attachWaitingStageTool(ctx: Context) {
  const entered = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  let hasStopped = false
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stage_wait', description: 'Wait for cancellation in the fixture.', parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Stopped waiting.' }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      entered.resolve()
      try {
        exec.signal.throwIfAborted()
        await once(exec.signal, 'abort')
        exec.signal.throwIfAborted()
        return true
      } finally { hasStopped = true; stopped.resolve() }
    },
  })))
  return { entered: entered.promise, stopped: stopped.promise, hasStopped: () => hasStopped }
}
