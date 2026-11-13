/** Direct ctx.llm generation: one inherited stream, aggregated text, and session-workspace audit files. */
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { executeDirectStage } from '../src/direct-stage.ts'
import { StageExecutionError } from '../src/stage-executor.ts'
import { useStageFixture } from './support/stage-fixture.ts'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } as const
const brief = '守灯人林澜。'
const input = { artifactId: 'artifact_00000000-0000-4000-8000-000000000002', sha256: createHash('sha256').update(brief).digest('hex'), kind: 'creative-brief', view: 'stored' as const, text: brief }

function jsonChunks(json: string): StreamChunk[] {
  const mid = Math.max(1, Math.ceil(json.length / 2))
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: json.slice(0, mid) },
    { type: 'text-delta', index: 0, text: json.slice(mid) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function runDirect(reply: (request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>, timeoutMs = 5_000) {
  const audits = new Map<string, string>()
  const fixture = await useStageFixture(request => reply(request))
  const outcome = await fixture.run(async exec => executeDirectStage(fixture.ctx, exec, {
    attemptId: 'attempt_00000000-0000-4000-8000-000000000001',
    prompt: 'Decide the stage.\n\nTASK_DATA\n\n{"kind":"body"}',
    outputSchema: schema, inputs: [input],
    onStarted: async () => undefined,
  }, { maxStageRequests: 2, stageTimeoutMs: timeoutMs }, async (role, text) => { audits.set(role, text) }))
  return { fixture, outcome, audits }
}

it('sends one inherited stream, aggregates the text, and records the prompt and output', async () => {
  const seen: GenerateOptions[] = []
  const { outcome, audits } = await runDirect(request => {
    seen.push(request)
    return jsonChunks(JSON.stringify({ ok: true }))
  })
  expect(outcome.status).toBe('fulfilled')
  if (outcome.status !== 'fulfilled') return
  expect(outcome.value.structured).toEqual({ ok: true })
  expect(outcome.value.childSessionId).not.toHaveLength(0)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ provider: 'stage-fixture', model: 'inherited-model', purpose: 'story-writing-stage' })
  expect(seen[0]!.tools ?? []).toEqual([])
  expect(seen[0]!.messages).toHaveLength(1)
  const prompt = audits.get('prompt')
  const output = audits.get('output')
  if (prompt === undefined || output === undefined) throw new Error('Direct stage did not store its prompt and output')
  expect(prompt).toContain('HOST_INPUTS')
  expect(prompt).toContain(brief)
  expect(prompt).toContain('OUTPUT_SCHEMA')
  expect(JSON.parse(output)).toEqual({ ok: true })
  expect(seen[0]!.messages[0]?.content).toEqual([{ type: 'text', text: prompt }])
})

it('rejects a non-object reply as malformed and a refusal or cut-off as its own failure', async () => {
  const malformed = await runDirect(() => jsonChunks('not-json'))
  expect(malformed.outcome.status).toBe('rejected')
  if (malformed.outcome.status === 'rejected') expect(malformed.outcome.reason).toMatchObject({ code: 'stage-malformed' })
  const refused = await runDirect(() => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'REFUSAL', message: 'declined' } } }])
  expect(refused.outcome.status).toBe('rejected')
  if (refused.outcome.status === 'rejected') {
    expect(refused.outcome.reason).toBeInstanceOf(StageExecutionError)
    expect((refused.outcome.reason as StageExecutionError).code).toBe('stage-refused')
  }
  const truncated = await runDirect(() => [{ type: 'finish', reason: { kind: 'max-tokens' } satisfies FinishReason }])
  expect(truncated.outcome.status).toBe('rejected')
  if (truncated.outcome.status === 'rejected') expect((truncated.outcome.reason as StageExecutionError).code).toBe('stage-truncated')
})

it('stops a direct stage at its deadline without a second request', async () => {
  let calls = 0
  const { fixture, outcome } = await runDirect(request => new Promise((_resolve, reject) => {
    calls += 1
    const onAbort = () => reject(request.signal?.reason ?? new Error('aborted'))
    request.signal?.addEventListener('abort', onAbort, { once: true })
  }), 30)
  expect(outcome.status).toBe('rejected')
  if (outcome.status === 'rejected') expect((outcome.reason as StageExecutionError).code).toBe('stage-timeout')
  expect(calls).toBe(1)
  expect(fixture.childRequests).toHaveLength(1)
})
