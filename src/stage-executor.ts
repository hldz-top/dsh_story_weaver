/** Native DSH child execution for one durable writing-stage attempt. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One already-provisioned writing attempt and its durable child association. */
export interface StageRequest {
  readonly attemptId: string
  readonly prompt: string
  readonly outputSchema: object
  readonly onStarted: (childSessionId: SessionId) => Promise<void>
  /** Evaluated for this child after durable association and before native tool side effects. */
  readonly authorizeTool?: (execution: ToolExecution) => Promise<void>
}

/** Deployment-owned finite execution limits; the model route remains inherited. */
export interface StageExecutionConfig {
  readonly stageProvider: string
  readonly maxDelegationDepth: number
  readonly allowedTools: readonly string[]
  readonly maxStageRequests: number
  readonly stageTimeoutMs: number
}

/** Validated native structured capture and the Session containing its evidence. */
export interface StageResult {
  readonly childSessionId: SessionId
  readonly structured: unknown
}

// The DSH 0.2.0-rc.2 DeepSeek adapter's LlmError code for a completed model call whose output could not be
// decoded (invalid structured_output JSON, invalid SSE JSON, a stream protocol violation, or bad tool arguments).
const MALFORMED_RESPONSE_CODE = 'MALFORMED_RESPONSE'
// The in-process driver registers the child's structured capture tool under this name in the child's own scope.
const STRUCTURED_OUTPUT_TOOL = 'structured_output'
// ToolRuntime's reserved programmatic-calling transport. It only sub-dispatches tools that are themselves visible to the
// caller, and each nested call passes through the same per-child execution admission below.
const RUN_CODE_TOOL = 'run_code'
/** Calls to tool names the child was never shown that are denied as tool errors before such a call ends the stage. */
export const MAX_UNMOUNTED_TOOL_CALLS = 3
// Provider-neutral failure codes an adapter may use for a declined or safety-filtered response.
const REFUSAL_CODES: ReadonlySet<string> = new Set(['REFUSAL', 'CONTENT_FILTER'])
// The DSH 0.2.0-rc.2 DeepSeek Messages adapter has no refusal finish reason: a provider `refusal` (or `content_filter`)
// stop reason reaches the loop as MALFORMED_RESPONSE "unsupported stop reason <reason>", which is not a decoding defect.
const UNSUPPORTED_REFUSAL_STOP = /\bunsupported stop reason (?:refusal|content_filter)\b/
/** @param failure - The child's terminal turn failure, when any. @returns Whether the provider declined to answer. */
function isProviderRefusal(failure: LlmFailure | undefined): boolean {
  if (failure === undefined) return false
  return REFUSAL_CODES.has(failure.code) || (failure.code === MALFORMED_RESPONSE_CODE && UNSUPPORTED_REFUSAL_STOP.test(failure.message))
}
/** Provider failure text embedded in a stage-malformed message is capped at this many Unicode code points. */
const MAX_MALFORMED_MESSAGE_CHARS = 300

/** @param text - Untrusted provider failure text. @returns The text, truncated to MAX_MALFORMED_MESSAGE_CHARS Unicode code points. */
function boundedProviderMessage(text: string): string {
  const codePoints = [...text]
  return codePoints.length <= MAX_MALFORMED_MESSAGE_CHARS ? text : codePoints.slice(0, MAX_MALFORMED_MESSAGE_CHARS).join('')
}

/** A stage failure that remains distinct from ordinary child output. */
export class StageExecutionError extends Error {
  /** @param code - Stable failure classification. @param message - Failure summary without private task text. @param options - Original failure cause when available. */
  constructor(readonly code: 'stage-budget' | 'stage-timeout' | 'stage-incomplete' | 'stage-config' | 'stage-provider' | 'stage-malformed' | 'stage-tool-scope' | 'stage-missing-result' | 'stage-refused' | 'stage-truncated', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StageExecutionError'
  }
}

/**
 * Execute one stage through the configured native subagent provider.
 * @param ctx - Host capabilities shared with the parent tool.
 * @param exec - Actual parent tool execution and its cancellation signal.
 * @param request - Self-contained prompt, output schema and durable child callback.
 * @param config - Validated deployment limits and inherited-tool allow list.
 * @returns The exact captured value after child execution and disposal settle.
 */
export async function executeStage(ctx: Context, exec: ToolExecution, request: StageRequest, config: StageExecutionConfig): Promise<StageResult> {
  const parent = exec.agent
  if (parent === undefined) throw new Error('Writing stages require a parent Agent')
  exec.signal.throwIfAborted()
  if (!Number.isSafeInteger(config.maxStageRequests) || config.maxStageRequests < 1) {
    throw new StageExecutionError('stage-config', 'maxStageRequests must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.stageTimeoutMs) || config.stageTimeoutMs < 1 || config.stageTimeoutMs > 2_147_483_647) {
    throw new StageExecutionError('stage-config', 'stageTimeoutMs must be an integer between 1 and 2147483647')
  }
  if (!Number.isSafeInteger(config.maxDelegationDepth) || config.maxDelegationDepth < 0) {
    throw new StageExecutionError('stage-config', 'maxDelegationDepth must be a non-negative safe integer')
  }
  if (config.stageProvider.trim().length === 0) throw new StageExecutionError('stage-config', 'stageProvider must name an in-process spawn provider')
  assertObjectJsonSchema(request.outputSchema)
  const controller = new AbortController()
  const signal = AbortSignal.any([exec.signal, controller.signal])
  const admission = Promise.withResolvers<void>()
  const onAbort = () => { admission.resolve() }
  signal.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(() => controller.abort(new StageExecutionError('stage-timeout', 'Writing stage exceeded its execution deadline')), config.stageTimeoutMs)
  let childId: SessionId | undefined
  let childAgent: ToolExecution['agent']
  let requests = 0
  let unmountedCalls = 0
  // The exact tool surface a stage child may use. The host's inherited-tool restriction cannot filter registrations in
  // the child's OWN scope (for example a per-Agent delegation tool installed when the child is created), so the stage
  // boundary re-checks visibility before every model request and admission before every tool execution.
  const permittedTools = new Set([...config.allowedTools, STRUCTURED_OUTPUT_TOOL])
  // The child's own turn/end reason carries the exact model failure; the run's coarse stopReason discards it.
  let turnFailure: LlmFailure | undefined
  // Whether the child's turn ended normally; the in-process driver reports a normal end without a capture as 'error'.
  let turnCompleted = false
  // An output-token cut-off is recorded on the turn even when a plugin continued the turn afterwards.
  let truncated = false
  // Native spawn publishes its descriptor before the first request, but may run before start() returns.
  const stopObserving = ctx.on('session/event', (session, event) => {
    if (event.type === 'subagent/descriptor' && event.data.mode === 'one-shot'
      && event.data.label === request.attemptId && event.data.provider === config.stageProvider
      && session.header.parentSession === parent.session.id) childId = session.id
    else if (event.type === 'turn/end' && childId !== undefined && session.id === childId) {
      turnCompleted = event.data.reason.kind === 'completed'
      if (event.data.reason.kind === 'error') turnFailure = event.data.reason.error
      if (event.data.reason.kind === 'max-tokens') truncated = true
    }
  }, { global: true })
  // Admission follows durable association; llm/stream includes provider retries within a single loop step.
  const stopAdmission = ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    if (childId !== undefined && options.sessionId === childId) {
      await admission.promise
      signal.throwIfAborted()
      const exposed = childAgent === undefined ? [] : ctx.tools.schemas(childAgent).map(tool => tool.name).filter(name => !permittedTools.has(name) && name !== RUN_CODE_TOOL)
      if (exposed.length > 0) {
        const error = new StageExecutionError('stage-tool-scope', `Writing stage child can see tools outside its allow list (${exposed.join(', ')}); no model request was sent. Writing stages must not see or call tools that dispatch further subagents.`)
        controller.abort(error)
        throw error
      }
      if (requests >= config.maxStageRequests) {
        const error = new StageExecutionError('stage-budget', 'Writing stage exhausted its model request budget')
        controller.abort(error)
        throw error
      }
      requests += 1
    }
    yield* next()
  }, { global: true, prepend: true })
  const stopToolAdmission = ctx.on('tools/execute', async (execution, next) => {
    if (childId !== undefined && execution.agent?.session.id === childId) {
      await admission.promise
      signal.throwIfAborted()
      if (!permittedTools.has(execution.name) && !(execution.name === RUN_CODE_TOOL && execution.parent === undefined)) {
        // A name the child was never shown (for example `bash`, suggested by the harness system prompt) is a model
        // hallucination with nothing behind it: deny just that call as an ordinary tool error so the child can continue,
        // within a small budget. A tool that IS mounted in the child's scope outside the allow list still ends the stage.
        const visible = childAgent !== undefined && ctx.tools.schemas(childAgent).some(tool => tool.name === execution.name)
        if (!visible && unmountedCalls < MAX_UNMOUNTED_TOOL_CALLS) {
          unmountedCalls += 1
          throw new Error(`Tool ${execution.name} is not available in this writing stage. Use only the listed tools (${[...permittedTools].join(', ')}); draft the text yourself and return it with ${STRUCTURED_OUTPUT_TOOL}.`)
        }
        const error = new StageExecutionError('stage-tool-scope', `Writing stage child is not permitted to call ${execution.name}; writing stages must not dispatch further subagents or use tools outside their allow list.`)
        controller.abort(error)
        throw error
      }
      await request.authorizeTool?.(execution)
    }
    return next()
  }, { global: true, prepend: true })
  try {
    const run = await ctx.subagents.start(config.stageProvider, {
      parent, label: request.attemptId, prompt: [{ type: 'text', text: request.prompt }], signal,
      outputSchema: request.outputSchema, toolFilter: { allow: [...config.allowedTools] }, maxDepth: config.maxDelegationDepth,
    })
    childId = run.id
    childAgent = run.localAgent
    const pendingResult = Promise.allSettled([run.result])
    const [execution] = await Promise.allSettled([(async (): Promise<StageResult> => {
      try {
        if (run.localAgent === undefined) throw new StageExecutionError('stage-provider', 'Writing stages require an in-process spawn provider')
        await request.onStarted(run.id)
        admission.resolve()
        const [result] = await pendingResult
        if (result.status === 'rejected') throw result.reason
        signal.throwIfAborted()
        // A refusal or a length cut-off is its own explicit failure, never a success, an empty value or a generic incomplete stage,
        // even when a structured value was captured before the cut-off.
        if (result.value.stopReason === 'refusal' || isProviderRefusal(turnFailure)) {
          const detail = turnFailure === undefined ? result.value.stopReason : `${turnFailure.code}: ${boundedProviderMessage(turnFailure.message)}`
          throw new StageExecutionError('stage-refused', `Writing stage was refused (${detail})`)
        }
        if (result.value.stopReason === 'max-tokens' || truncated) {
          throw new StageExecutionError('stage-truncated', "Writing stage output was truncated at the model's output-token limit before a complete structured result")
        }
        if (result.value.stopReason !== 'completed' || result.value.structured === undefined) {
          // A captured structured value alongside a later-step error is not a malformed response: keep it stage-incomplete/unknown rather than discarding a valid capture to retry.
          if (result.value.stopReason === 'error' && result.value.structured === undefined && turnFailure?.code === MALFORMED_RESPONSE_CODE) {
            throw new StageExecutionError('stage-malformed', `Writing stage's model response could not be decoded (${MALFORMED_RESPONSE_CODE}): ${boundedProviderMessage(turnFailure.message)}`)
          }
          // The child's turn ended normally (for example with plain assistant text) without calling structured_output:
          // a completed model call with a known, unusable result rather than an uncertain outcome.
          if (result.value.structured === undefined && turnCompleted && turnFailure === undefined
            && (result.value.stopReason === 'completed' || result.value.stopReason === 'error')) {
            throw new StageExecutionError('stage-missing-result', 'Writing stage turn ended without returning its structured result')
          }
          throw new StageExecutionError('stage-incomplete', `Writing stage ended without a complete structured result: ${result.value.stopReason}`)
        }
        return { childSessionId: run.id, structured: result.value.structured }
      } catch (error) {
        controller.abort(error)
        throw error
      } finally {
        admission.resolve()
      }
    })()])
    const [cleanup] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
    if (execution.status === 'rejected') {
      if (cleanup.status === 'rejected') throw new AggregateError([execution.reason, cleanup.reason], 'Writing stage execution and disposal failed', { cause: execution.reason })
      throw execution.reason
    }
    if (cleanup.status === 'rejected') throw cleanup.reason
    signal.throwIfAborted()
    return execution.value
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
    stopToolAdmission()
    stopAdmission()
    stopObserving()
  }
}
