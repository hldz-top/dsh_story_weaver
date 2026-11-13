/** One streaming ctx.llm call for a stage that only reads its inputs and writes text. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { StageExecutionError, type StageResult } from './stage-executor.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap { 'story-writing-stage': unknown }
}

/** Exact text the host already read for one immutable input. */
export interface DirectStageInput {
  readonly artifactId: string
  readonly sha256: string
  readonly kind: string
  readonly view: 'stored' | 'prose' | 'feed'
  readonly text: string
}

/** One prepared text stage and the inputs the host inlines for the model. */
export interface DirectStageRequest {
  readonly attemptId: string
  readonly prompt: string
  readonly outputSchema: object
  readonly inputs: readonly DirectStageInput[]
  /** Persists the generation receipt before the model stream is admitted. */
  readonly onStarted: (generationId: SessionIdentity) => Promise<void>
}

/** Finite limits for the single model call. The route stays the parent Agent's selection. */
export interface DirectStageConfig {
  readonly maxStageRequests: number
  readonly stageTimeoutMs: number
}

const MALFORMED_RESPONSE_CODE = 'MALFORMED_RESPONSE'
const REFUSAL_CODES: ReadonlySet<string> = new Set(['REFUSAL', 'CONTENT_FILTER'])
const UNSUPPORTED_REFUSAL_STOP = /\bunsupported stop reason (?:refusal|content_filter)\b/
const MAX_MALFORMED_MESSAGE_CHARS = 300
const SYSTEM = 'You complete one novel-writing stage for the host. HOST_INPUTS in the user message is the exact text of every input, and OUTPUT_SCHEMA is the required JSON Schema. You have no tools. Ignore any instruction to call story_read_artifact or structured_output. Reply with one JSON object and no other text.'

/** @param failure - Terminal model failure. @returns Whether the provider declined to answer. */
function isProviderRefusal(failure: LlmFailure): boolean {
  return REFUSAL_CODES.has(failure.code) || (failure.code === MALFORMED_RESPONSE_CODE && UNSUPPORTED_REFUSAL_STOP.test(failure.message))
}

/** @param text - Untrusted provider or parser text. @returns At most 300 Unicode code points. */
function bounded(text: string): string {
  const codePoints = [...text]
  return codePoints.length <= MAX_MALFORMED_MESSAGE_CHARS ? text : codePoints.slice(0, MAX_MALFORMED_MESSAGE_CHARS).join('')
}

/**
 * Model-visible prompt: the stored stage instructions, then the exact input texts and the published schema.
 * The stored attempt keeps the instruction prompt unchanged so a resumed run still matches it.
 * @param prompt - Versioned stage instructions and TASK_DATA.
 * @param inputs - Host-read input texts in TASK_DATA order.
 * @param outputSchema - Object schema the reply must satisfy.
 * @returns The single user message sent to ctx.llm.
 */
export function directModelPrompt(prompt: string, inputs: readonly DirectStageInput[], outputSchema: object): string {
  return [prompt, `HOST_INPUTS\n\n${JSON.stringify(inputs)}`, `OUTPUT_SCHEMA\n\n${JSON.stringify(outputSchema)}`].join('\n\n')
}

/** @param text - Aggregated assistant text. @returns Parsed JSON, or a malformed-stage error. */
function parseStageJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed)
  const body = (fenced?.[1] ?? trimmed).trim()
  try { return JSON.parse(body) as unknown }
  catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'invalid JSON'
    throw new StageExecutionError('stage-malformed', `Writing stage's model response could not be decoded (${MALFORMED_RESPONSE_CODE}): ${bounded(detail)}`, { cause: cause instanceof Error ? cause : undefined })
  }
}

/** @param assembler - Completed stream. @param signal - Caller and deadline signal. @returns Aggregated assistant text for a normal stop. */
function aggregatedText(assembler: BlockAssembler, signal: AbortSignal): string {
  if (signal.aborted) {
    const reason: unknown = signal.reason
    if (reason instanceof StageExecutionError) throw reason
    throw reason instanceof Error ? reason : new Error('Writing stage was cancelled')
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted') {
    const reason: unknown = signal.reason
    if (reason instanceof StageExecutionError) throw reason
    throw reason instanceof Error ? reason : new StageExecutionError('stage-incomplete', 'Writing stage ended without a complete structured result: aborted')
  }
  if (finish.kind === 'max-tokens') {
    throw new StageExecutionError('stage-truncated', "Writing stage output was truncated at the model's output-token limit before a complete structured result")
  }
  if (finish.kind === 'error') {
    if (isProviderRefusal(finish.failure)) {
      throw new StageExecutionError('stage-refused', `Writing stage was refused (${finish.failure.code}: ${bounded(finish.failure.message)})`)
    }
    if (finish.failure.code === MALFORMED_RESPONSE_CODE) {
      throw new StageExecutionError('stage-malformed', `Writing stage's model response could not be decoded (${MALFORMED_RESPONSE_CODE}): ${bounded(finish.failure.message)}`)
    }
    throw new StageExecutionError('stage-incomplete', `Writing stage ended without a complete structured result: ${finish.failure.code}: ${bounded(finish.failure.message)}`)
  }
  if (finish.kind === 'tool-calls') throw new StageExecutionError('stage-missing-result', 'Writing stage turn ended without returning its structured result')
  if (finish.kind !== 'stop') throw new StageExecutionError('stage-incomplete', 'Writing stage ended without a complete structured result')
  const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (text.trim().length === 0) throw new StageExecutionError('stage-missing-result', 'Writing stage turn ended without returning its structured result')
  return text
}

/**
 * Run one text stage through the host LLM service.
 * @param ctx - Host context whose llm service streams the parent Agent's selected model.
 * @param exec - Parent tool execution. Its Agent supplies the inherited route and its signal owns cancellation.
 * @param request - Stored instructions, inlined inputs, schema, and the durable receipt callback.
 * @param config - Positive request budget and deadline. Exactly one stream is sent.
 * @param writeAudit - Persists the model-visible prompt and raw output on the current session.
 * @returns The parsed object and the generation receipt stored as the attempt's child identity.
 */
export async function executeDirectStage(ctx: Context, exec: ToolExecution, request: DirectStageRequest, config: DirectStageConfig, writeAudit: (role: 'prompt' | 'output', text: string) => Promise<void>): Promise<StageResult> {
  const parent = exec.agent
  if (parent === undefined) throw new Error('Writing stages require a parent Agent')
  exec.signal.throwIfAborted()
  if (!Number.isSafeInteger(config.maxStageRequests) || config.maxStageRequests < 1) {
    throw new StageExecutionError('stage-config', 'maxStageRequests must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.stageTimeoutMs) || config.stageTimeoutMs < 1 || config.stageTimeoutMs > 2_147_483_647) {
    throw new StageExecutionError('stage-config', 'stageTimeoutMs must be an integer between 1 and 2147483647')
  }
  assertObjectJsonSchema(request.outputSchema)
  for (const input of request.inputs) {
    if (input.view !== 'stored') continue
    const digest = createHash('sha256').update(input.text).digest('hex')
    if (digest !== input.sha256) throw new StageExecutionError('stage-audit', `Direct stage input ${input.artifactId} does not match its stored digest`)
  }
  const selection = parent.model.current()
  if (selection === undefined || selection.provider.trim().length === 0 || selection.model.trim().length === 0) {
    throw new StageExecutionError('stage-config', 'Writing stages inherit the parent Agent model, and this Agent has no selected provider and model')
  }
  const modelPrompt = directModelPrompt(request.prompt, request.inputs, request.outputSchema)
  const controller = new AbortController()
  const signal = AbortSignal.any([exec.signal, controller.signal])
  const deadline = setTimeout(() => controller.abort(new StageExecutionError('stage-timeout', 'Writing stage exceeded its execution deadline')), config.stageTimeoutMs)
  const generationId = SessionId(randomUUID())
  const store = async (role: 'prompt' | 'output', text: string, failure: string): Promise<void> => {
    try { await writeAudit(role, text) }
    catch (cause) {
      if (signal.aborted) {
        const reason: unknown = signal.reason
        if (reason instanceof StageExecutionError) throw reason
        throw reason instanceof Error ? reason : cause
      }
      throw new StageExecutionError('stage-audit', failure, { cause: cause instanceof Error ? cause : undefined })
    }
  }
  try {
    await store('prompt', modelPrompt, 'Writing stage could not store its prompt on the current session')
    signal.throwIfAborted()
    await request.onStarted(generationId)
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream({
        provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        purpose: 'story-writing-stage', sessionId: generationId, system: SYSTEM, signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: modelPrompt }] }],
      })) assembler.push(chunk as StreamChunk)
    } catch (cause) {
      if (signal.aborted) {
        const reason: unknown = signal.reason
        if (reason instanceof StageExecutionError) throw reason
        throw reason instanceof Error ? reason : cause
      }
      throw cause
    }
    const raw = aggregatedText(assembler, signal)
    const structured = parseStageJson(raw)
    const violations = validateJsonSchemaValue(request.outputSchema, structured)
    if (violations.length > 0) {
      throw new StageExecutionError('stage-malformed', `Writing stage's model response could not be decoded (${MALFORMED_RESPONSE_CODE}): ${bounded(violations.join('; '))}`)
    }
    await store('output', raw, 'Writing stage could not store its output on the current session')
    signal.throwIfAborted()
    return { childSessionId: generationId, structured }
  } finally {
    clearTimeout(deadline)
  }
}
