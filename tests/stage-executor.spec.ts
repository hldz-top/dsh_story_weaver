import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FinishReason, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeStage, MAX_UNMOUNTED_TOOL_CALLS, type StageExecutionConfig } from '../src/stage-executor.ts'
import { call } from './support/model.ts'
import { attachWaitingStageTool, useStageFixture } from './support/stage-fixture.ts'

const config: StageExecutionConfig = {
  stageProvider: 'stage-spawn', maxDelegationDepth: 2, allowedTools: [], maxStageRequests: 3, stageTimeoutMs: 5000,
}
const outputSchema = { type: 'object', properties: { prose: { type: 'string' } }, required: ['prose'], additionalProperties: false }

it('returns native structured output after persisting its child Session and disposing the child', async () => {
  let started: string | undefined
  const fixture = await useStageFixture(request => {
    expect(started).toBe(request.sessionId)
    expect(request.provider).toBe('stage-fixture')
    expect(request.model).toBe('inherited-model')
    expect(request.tools?.map(tool => tool.name)).toEqual(['structured_output'])
    return call('structured_output', { prose: 'The lighthouse keeper returned.' })
  })
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-structured', prompt: 'Write the lighthouse scene.', outputSchema,
    onStarted: async childSessionId => { started = childSessionId },
  }, config))
  expect(outcome).toEqual({ status: 'fulfilled', value: { childSessionId: started, structured: { prose: 'The lighthouse keeper returned.' } } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.childRequests[0]?.provider).toBe('stage-fixture')
  expect(fixture.childRequests[0]?.model).toBe('inherited-model')
  const parentEvents = fixture.parent.session.ownEvents()
  expect(parentEvents.some(event => event.type === 'subagent/catalog')).toBe(true)
  expect(JSON.stringify(parentEvents)).not.toContain('subagent-settled')
  expect(started === undefined ? undefined : fixture.ctx.agents.get(SessionId(started))).toBeUndefined()
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('admits the first child request only after its durable association completes', async () => {
  let persisted = false
  const fixture = await useStageFixture(() => {
    expect(persisted).toBe(true)
    return call('structured_output', { prose: 'Recorded after association.' })
  })
  const path = join(fixture.root, 'stage-association.json')
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-association', prompt: 'Use the exact stage inputs.', outputSchema,
    onStarted: async childSessionId => {
      await writeFile(path, JSON.stringify({ childSessionId }))
      persisted = true
    },
  }, config))
  expect(outcome.status).toBe('fulfilled')
  const association: { childSessionId: string } = JSON.parse(await readFile(path, 'utf8'))
  const handle = await fixture.ctx.sessionPersistence.open(SessionId(association.childSessionId), 'read')
  try {
    expect(handle.header.parentSession).toBe(fixture.parent.session.id)
    const { events } = await handle.read()
    expect(events.find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({ mode: 'continuable', label: 'attempt-association', provider: 'stage-spawn' })
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === 'Use the exact stage inputs.'))).toBe(true)
  } finally { await handle.close() }
})

it('stops invalid structured-output retries at the configured native request budget', async () => {
  const fixture = await useStageFixture((_request, index) => call('structured_output', { prose: index < 3 ? 42 : 'Must not reach this retry.' }))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-budget', prompt: 'Write the exact structured result.', outputSchema, onStarted: async () => {},
  }, { ...config, maxStageRequests: 2 }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-budget' } })
  expect(fixture.childRequests).toHaveLength(2)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('counts native provider retries within a single loop step against the same stage budget', async () => {
  let childId: string | undefined
  const fixture = await useStageFixture(() => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Deterministic transient failure' } } }], { retry: true })
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-provider-retry', prompt: 'Produce a structured result.', outputSchema,
    onStarted: async id => { childId = id },
  }, { ...config, maxStageRequests: 2 }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-budget' } })
  expect(fixture.childRequests).toHaveLength(2)
  if (childId === undefined) throw new Error('Missing child association')
  const handle = await fixture.ctx.sessionPersistence.open(SessionId(childId), 'read')
  try {
    const { events } = await handle.read()
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'assistant/attempt').length).toBeGreaterThanOrEqual(2)
  } finally { await handle.close() }
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('rejects plain text as a missing structured result instead of claiming a structured stage result', async () => {
  const fixture = await useStageFixture(() => [{ type: 'finish', reason: { kind: 'stop' } }])
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-missing', prompt: 'Produce structured prose.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-missing-result', message: 'Writing stage turn ended without returning its structured result' } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('refuses an already cancelled parent without publishing a child', async () => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  let starts = 0
  const outcome = await fixture.run(exec => {
    fixture.parent.cancel({ kind: 'user' })
    return executeStage(fixture.ctx, exec, { attemptId: 'attempt-cancelled', prompt: 'Cancelled.', outputSchema,
      onStarted: async () => { starts += 1 },
    }, config)
  })
  expect(outcome.status).toBe('rejected')
  expect(starts).toBe(0)
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('propagates parent cancellation and waits until the native child tool has stopped', async () => {
  const fixture = await useStageFixture(() => call('stage_wait', {}))
  const waiting = attachWaitingStageTool(fixture.ctx)
  const pending = fixture.run(exec => executeStage(fixture.ctx, exec, { attemptId: 'attempt-stop', prompt: 'Wait for cancellation.', outputSchema,
    onStarted: async () => {},
  }, { ...config, allowedTools: ['stage_wait'] }))
  await waiting.entered
  fixture.parent.cancel({ kind: 'user' })
  const outcome = await pending
  expect(outcome.status).toBe('rejected')
  expect(waiting.hasStopped()).toBe(true)
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('rejects a result cancelled while its child is being disposed', async () => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'A late result.' }))
  fixture.ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.parentSession === fixture.parent.session.id) fixture.parent.cancel({ kind: 'user' })
  }, { global: true })
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, { attemptId: 'attempt-late', prompt: 'Return a result.', outputSchema,
    onStarted: async () => {},
  }, config))
  expect(outcome.status).toBe('rejected')
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('expires its deadline and awaits the cancelled native tool', async () => {
  const fixture = await useStageFixture(() => call('stage_wait', {}))
  const waiting = attachWaitingStageTool(fixture.ctx)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = fixture.run(exec => executeStage(fixture.ctx, exec, { attemptId: 'attempt-deadline', prompt: 'Wait for the deadline.', outputSchema,
    onStarted: async () => {},
  }, { ...config, allowedTools: ['stage_wait'], stageTimeoutMs: 1000 }))
  try {
    await waiting.entered
    await vi.advanceTimersByTimeAsync(1000)
    expect(waiting.hasStopped()).toBe(true)
  } finally {
    fixture.parent.cancel({ kind: 'user' })
    vi.useRealTimers()
  }
  const outcome = await pending
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-timeout' } })
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it.each([
  { maxStageRequests: 0 },
  { maxStageRequests: Number.NaN },
  { stageTimeoutMs: 0 },
  { stageTimeoutMs: 2_147_483_648 },
  { maxDelegationDepth: -1 },
  { maxDelegationDepth: 1.5 },
  { stageProvider: ' ' },
])('rejects invalid finite limits before child publication: %j', async invalid => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  let starts = 0
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-invalid-config', prompt: 'No invalid limits.', outputSchema,
    onStarted: async () => { starts += 1 },
  }, { ...config, ...invalid }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-config' } })
  expect(starts).toBe(0)
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('rejects a published run without its local Agent and still disposes the native child', async () => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  const native = fixture.ctx.subagents.getProvider('stage-spawn')
  if (native === undefined) throw new Error('Missing native fixture provider')
  fixture.ctx.effect(() => fixture.ctx.subagents.registerProvider({
    name: 'missing-local-agent', capabilities: native.capabilities, inheritsParentContext: false,
    async start() {
      let settle = (_result: { output: readonly []; stopReason: 'aborted' }): void => {}
      const result = new Promise<{ output: readonly []; stopReason: 'aborted' }>(resolve => { settle = resolve })
      return { id: SessionId(randomUUID()), result, dispose: () => { settle({ output: [], stopReason: 'aborted' }); return Promise.resolve() } }
    },
  }))
  let starts = 0
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-local-agent', prompt: 'Require in-process execution.', outputSchema,
    onStarted: async () => { starts += 1 },
  }, { ...config, stageProvider: 'missing-local-agent' }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-provider' } })
  expect(starts).toBe(0)
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it.each(['outputSchema', 'depthLimit'] as const)('rejects providers without %s before starting native work', async capability => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  const native = fixture.ctx.subagents.getProvider('stage-spawn')
  if (native === undefined) throw new Error('Missing native fixture provider')
  let providerStarts = 0
  fixture.ctx.effect(() => fixture.ctx.subagents.registerProvider({
    name: 'unsupported', capabilities: { ...native.capabilities, [capability]: false }, inheritsParentContext: native.inheritsParentContext,
    prepareContinuable() { providerStarts += 1; return Promise.resolve({}) },
  }))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-unsupported', prompt: 'Require native capabilities.', outputSchema, onStarted: async () => {},
  }, { ...config, stageProvider: 'unsupported' }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'UNSUPPORTED_CAPABILITY' } })
  expect(providerStarts).toBe(0)
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it.each([
  { config: { stageProvider: 'not-registered' }, schema: outputSchema },
  { config: { allowedTools: ['not-registered'] }, schema: outputSchema },
  { config: {}, schema: { type: 'string' } },
])('rejects invalid native provider, tool or schema references before model dispatch: %j', async invalid => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-invalid-native', prompt: 'Require valid native inputs.', outputSchema: invalid.schema, onStarted: async () => {},
  }, { ...config, ...invalid.config }))
  expect(outcome.status).toBe('rejected')
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('keeps simultaneous child admissions and budgets independent within one parent tool', async () => {
  const byChild = new Map<string, number>()
  const fixture = await useStageFixture(request => {
    if (request.sessionId === undefined) throw new Error('Missing native child Session identity')
    const count = (byChild.get(request.sessionId) ?? 0) + 1
    byChild.set(request.sessionId, count)
    return call('structured_output', { prose: count === 1 ? 42 : 'The second request succeeds.' })
  })
  const bothAssociated = Promise.withResolvers<void>()
  const children: string[] = []
  const outcome = await fixture.run(exec => Promise.allSettled([1, 2].map(budget => executeStage(fixture.ctx, exec, {
    attemptId: `attempt-concurrent-${budget}`, prompt: `Use at most ${budget} requests.`, outputSchema,
    onStarted: async id => {
      children.push(id)
      if (children.length === 2) bothAssociated.resolve()
      await bothAssociated.promise
    },
  }, { ...config, maxStageRequests: budget }))))
  expect(outcome.status).toBe('fulfilled')
  if (outcome.status !== 'fulfilled') throw new Error('Expected settled child outcomes')
  expect(outcome.value[0]).toMatchObject({ status: 'rejected', reason: { code: 'stage-budget' } })
  expect(outcome.value[1]).toMatchObject({ status: 'fulfilled', value: { structured: { prose: 'The second request succeeds.' } } })
  expect(new Set(children).size).toBe(2)
  expect([...byChild.values()].sort()).toEqual([1, 2])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it.each<FinishReason>([
  { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture model failure' } },
])('rejects incomplete native model finishes without publishing partial prose: %j', async reason => {
  const fixture = await useStageFixture(() => [{ type: 'finish', reason }])
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-incomplete-model', prompt: 'Require a complete result.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-incomplete' } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('classifies a malformed structured_output call distinctly from other incomplete native finishes', async () => {
  const fixture = await useStageFixture(() => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } } }])
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-malformed', prompt: 'Require a complete result.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-malformed', message: expect.stringContaining('DeepSeek Messages stream: tool input is invalid JSON') } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('preserves a durable association rejection after the actual child is disposed', async () => {
  const failure = new Error('Durable association could not be committed')
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-association-failure', prompt: 'Require an association.', outputSchema, onStarted: async () => { throw failure },
  }, config))
  expect(outcome).toEqual({ status: 'rejected', reason: failure })
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('applies child tool admission before side effects and removes it after child disposal', async () => {
  const effects: string[] = []
  const fixture = await useStageFixture((request, index) => {
    if (index % 2 === 0) return call('guarded_stage_effect', { value: index === 0 ? 'denied' : 'allowed' })
    const result = request.messages.findLast((message): message is ToolResultMessage => message.role === 'tool')
    expect(result !== undefined && result.isError).toBe(index === 1)
    return call('structured_output', { prose: 'Finished after observing the tool outcome.' })
  })
  fixture.ctx.effect(() => fixture.ctx.tools.register(defineTool({
    name: 'guarded_stage_effect', description: 'Record an observable fixture effect.',
    parameters: { value: { type: 'string', required: true } }, isConcurrencySafe: () => true,
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Recorded.' }] },
    execute: async args => { effects.push(args.value); return true },
  })))
  const restricted = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'guarded-stage', prompt: 'Observe the denied tool result.', outputSchema, onStarted: async () => {},
    authorizeTool: async execution => { if (execution.name === 'guarded_stage_effect') throw new Error('This frozen stage does not authorize the effect.') },
  }, { ...config, allowedTools: ['guarded_stage_effect'] }))
  expect(restricted.status).toBe('fulfilled')
  expect(effects).toEqual([])
  const unrestricted = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'unrestricted-stage', prompt: 'Perform the newly authorized effect.', outputSchema, onStarted: async () => {},
  }, { ...config, allowedTools: ['guarded_stage_effect'] }))
  expect(unrestricted.status).toBe('fulfilled')
  expect(effects).toEqual(['allowed'])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

/**
 * Mount a model-facing delegation tool the way a per-Agent composition does (for example DSH tool-subagent with a
 * standing `modelSelectionSettings` composition): registered in each new child's OWN scope on `agent/created`. The
 * child's inherited-tool allow list cannot filter an Agent's own registrations, so only the stage boundary can.
 */
function attachChildScopedDispatchTool(fixture: Awaited<ReturnType<typeof useStageFixture>>, timing: 'created' | 'first-request' = 'created') {
  const dispatched: string[] = []
  const register = (agent: { readonly ctx: typeof fixture.ctx }) => agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: 'subagent', description: 'Delegate a self-contained task to a subagent.',
    parameters: { prompt: { type: 'string', required: true } }, isConcurrencySafe: () => true,
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Delegated.' }] },
    execute: async args => { dispatched.push(args.prompt); return true },
  })))
  const children = new Map<string, { readonly ctx: typeof fixture.ctx }>()
  fixture.ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== fixture.parent.session.id) return
    children.set(agent.session.id, agent)
    if (timing === 'created') register(agent)
  }, { global: true })
  return { dispatched, registerFor: (sessionId: string) => { const agent = children.get(sessionId); if (agent === undefined) throw new Error('Unknown child'); register(agent) } }
}

it('refuses a writing stage whose child can see a dispatch tool outside its allow list before any model request', async () => {
  const fixture = await useStageFixture(() => call('subagent', { prompt: 'Draft the chapter for me.' }))
  const dispatch = attachChildScopedDispatchTool(fixture)
  let started: string | undefined
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-hidden-dispatch', prompt: 'Write the chapter yourself.', outputSchema, onStarted: async id => { started = id },
  }, { ...config, allowedTools: [] }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-tool-scope', message: expect.stringContaining('subagent') } })
  expect(started).toBeDefined()
  expect(fixture.childRequests).toHaveLength(0)
  expect(dispatch.dispatched).toEqual([])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('denies a dispatch tool that appears in the child scope after its first model request', async () => {
  let fixture: Awaited<ReturnType<typeof useStageFixture>> | undefined
  let dispatch: ReturnType<typeof attachChildScopedDispatchTool> | undefined
  fixture = await useStageFixture((request, index) => {
    if (index > 0) return call('structured_output', { prose: 'Must not be requested.' })
    // Register while the first response streams, so the call reaches execution with the tool already in the child scope.
    dispatch!.registerFor(request.sessionId!)
    return call('subagent', { prompt: 'Draft the chapter for me.' })
  })
  dispatch = attachChildScopedDispatchTool(fixture, 'first-request')
  const outcome = await fixture.run(exec => executeStage(fixture!.ctx, exec, {
    attemptId: 'attempt-late-dispatch', prompt: 'Write the chapter yourself.', outputSchema, onStarted: async () => {},
  }, { ...config, allowedTools: [] }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-tool-scope' } })
  expect(dispatch.dispatched).toEqual([])
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.childRequests[0]!.tools?.map(tool => tool.name)).toEqual(['structured_output'])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('keeps the allowed artifact tools and structured capture visible to a writing stage', async () => {
  const fixture = await useStageFixture((request, index) => {
    if (index === 0) {
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['guarded_read', 'structured_output'])
      return call('guarded_read', {})
    }
    return call('structured_output', { prose: 'Read, then wrote.' })
  })
  fixture.ctx.effect(() => fixture.ctx.tools.register(defineTool({
    name: 'guarded_read', description: 'Read a fixture artifact.', parameters: {}, isConcurrencySafe: () => true,
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Read.' }] }, execute: async () => true,
  })))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-allowed-tools', prompt: 'Read and write.', outputSchema, onStarted: async () => {},
  }, { ...config, allowedTools: ['guarded_read'] }))
  expect(outcome).toMatchObject({ status: 'fulfilled', value: { structured: { prose: 'Read, then wrote.' } } })
})

it('classifies an output-length cut-off as an explicit truncation, never as a missing or empty result', async () => {
  const fixture = await useStageFixture(() => [{ type: 'finish', reason: { kind: 'max-tokens' } }])
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-truncated', prompt: 'Require a complete result.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-truncated', message: "Writing stage output was truncated at the model's output-token limit before a complete structured result" } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('rejects a structured value captured in a response that was cut off at the output-token limit', async () => {
  const fixture = await useStageFixture(() => [...call('structured_output', { prose: 'A cut-off chapter' }).slice(0, 2), { type: 'finish', reason: { kind: 'max-tokens' } }])
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-truncated-capture', prompt: 'Require a complete result.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-truncated' } })
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it.each([
  { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: unsupported stop reason refusal' },
  { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: unsupported stop reason content_filter' },
  { code: 'REFUSAL', message: 'The provider declined this request.' },
  { code: 'CONTENT_FILTER', message: 'The response was withheld by a content filter.' },
])('classifies a provider refusal as an explicit refused stage, not a decoding failure: %j', async failure => {
  const fixture = await useStageFixture(() => [{ type: 'finish', reason: { kind: 'error', failure } }])
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-refused', prompt: 'Require a complete result.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-refused', message: `Writing stage was refused (${failure.code}: ${failure.message})` } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('classifies a turn blocked before its model step as an explicit refused stage', async () => {
  const fixture = await useStageFixture(() => call('structured_output', { prose: 'Must not run.' }))
  fixture.ctx.on('agent/pre-step', async (payload, next) => payload.agent.session.header.parentSession === fixture.parent.session.id ? { kind: 'reject' } : next(), { global: true })
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-blocked', prompt: 'Require a complete result.', outputSchema, onStarted: async () => {},
  }, config))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-refused', message: 'Writing stage was refused (refusal)' } })
  expect(fixture.childRequests).toHaveLength(0)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('denies a hallucinated, never-mounted tool call as a tool error and lets the stage finish (run_d3fc3046 body candidate called bash)', async () => {
  const fixture = await useStageFixture((_request, index) => index === 0
    ? call('bash', { command: 'mkdir -p /workspace/dsh-run/ws3 && echo ok' })
    : call('structured_output', { prose: 'Drafted without a shell.' }))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-hallucinated-bash', prompt: 'Write the chapter yourself.', outputSchema, onStarted: async () => {},
  }, { ...config, allowedTools: [] }))
  expect(outcome).toMatchObject({ status: 'fulfilled', value: { structured: { prose: 'Drafted without a shell.' } } })
  expect(fixture.childRequests).toHaveLength(2)
  expect(JSON.stringify(fixture.childRequests[1])).toContain('Tool bash is not available in this writing stage')
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it(`ends the stage once a child keeps calling never-mounted tools beyond ${MAX_UNMOUNTED_TOOL_CALLS} denials`, async () => {
  const fixture = await useStageFixture(() => call('bash', { command: 'wc -m chapter.md' }))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'attempt-repeated-bash', prompt: 'Write the chapter yourself.', outputSchema, onStarted: async () => {},
  }, { ...config, allowedTools: [], maxStageRequests: 10 }))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'stage-tool-scope', message: expect.stringContaining('bash') } })
  expect(fixture.childRequests).toHaveLength(MAX_UNMOUNTED_TOOL_CALLS + 1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})
