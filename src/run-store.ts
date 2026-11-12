/** Durable writing-run progress in the host's existing storage domain facility. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { QuoteRepair } from './evidence-quote.ts'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { StageInputRef } from './stage-output.ts'
import { CURRENT_PROMPT_VERSION, type PromptVersion } from './stage-prompts.ts'
import { artifactIdSchema, novelIdSchema, requestIdSchema, type Actor, type NovelId } from './contracts.ts'

/** Opaque identity of one durable writing request. */
export type RunId = Branded<'story-run'>
const runIdSchema = z.string().regex(/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(brandString<RunId>)
/** Opaque identity of one prepared native stage invocation. */
export type AttemptId = Branded<'story-attempt'>
const attemptIdSchema = z.string().regex(/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(brandString<AttemptId>)
/** @param value - Tool or wire run identifier. @returns An admitted opaque run identifier. */
export function parseRunId(value: unknown): RunId { return runIdSchema.parse(value) }
/** @param value - Tool or wire attempt identifier. @returns An admitted opaque attempt identifier. */
export function parseAttemptId(value: unknown): AttemptId { return attemptIdSchema.parse(value) }
const sessionIdSchema = z.string().min(1).transform(brandString<SessionId>)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const limitsSchema = z.strictObject({ maxAttempts: positive, maxOutputBytes: positive })
const executionLimitsSchema = z.strictObject({
  maxRepairAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), maxParallelStages: positive,
  // How many settings dimensions in one dependency layer may start together. Absent on runs stored before the field
  // existed; the runner then uses 1. A present value is still capped by maxParallelStages.
  settingsCandidateCount: positive.exactOptional(),
  maxStageRequests: positive, stageTimeoutMs: positive.max(2_147_483_647), maxDelegationDepth: positive,
  minChapterWords: positive, maxChapterWords: positive, stageProvider: z.string().min(1).refine(value => value.trim().length > 0),
  // Prompt version 5 and later only: whether AI-tone findings in a body review block. Recorded on every such run (begin fills
  // the default, on); absent on runs created before version 5, which keep advisory AI tone whatever the current config says.
  aiToneBlocking: z.boolean().exactOptional(),
}).refine(value => value.minChapterWords <= value.maxChapterWords, 'Invalid chapter word range')
/** Native execution and writing limits captured before a run; model selection stays with DSH. */
export type RunExecutionLimits = z.infer<typeof executionLimitsSchema>
const serviceLimitsSchema = z.strictObject({
  maxArtifactBytes: positive, maxReadChars: positive, maxResearchQuestions: positive, maxResearchCalls: positive,
  maxResearchSources: positive, maxEvidenceChars: positive, maxResearchLogEvents: positive,
})
/** Exact writing and research admission limits captured for one run. */
export type RunServiceLimits = z.infer<typeof serviceLimitsSchema>
const legacyBeginSchema = z.strictObject({
  executionLimits: executionLimitsSchema,
  novelId: novelIdSchema, requestId: requestIdSchema, briefArtifactId: artifactIdSchema,
  settingsRoots: z.array(z.string().regex(/^[a-z][a-z0-9]*$/)).nonempty(),
  chapterCount: positive, fromChapter: positive, throughChapter: positive, mode: z.enum(['write', 'update', 'revise']),
  revision: z.strictObject({ baseArtifactId: artifactIdSchema, instructions: z.string().refine(value => value.trim().length > 0 && value.isWellFormed(), 'Revision instructions must be nonblank, well-formed Unicode') }).nullable(),
}).refine(value => value.fromChapter <= value.throughChapter && value.throughChapter <= value.chapterCount, 'Invalid chapter range')
  .refine(value => new Set(value.settingsRoots).size === value.settingsRoots.length, 'Duplicate settings root')
  .refine(value => (value.mode === 'revise') === (value.revision !== null), 'Only revise runs require revision instructions')

const beginSchema = legacyBeginSchema.safeExtend({ serviceLimits: serviceLimitsSchema })

/** Immutable requested source and chapter range; catalog admission belongs to the caller. */
export type BeginRunInput = z.infer<typeof beginSchema>
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const stageRefSchema = z.strictObject({ artifactId: artifactIdSchema, sha256: digestSchema })
const attemptRequestSchema = z.strictObject({
  key: z.string().min(1).max(256), prompt: z.string().min(1), inputRefs: z.array(stageRefSchema).nonempty(),
  outputSchema: z.record(z.string(), z.json()),
}).refine(value => new Set(value.inputRefs.map(ref => ref.artifactId)).size === value.inputRefs.length, 'Duplicate stage input')
/** Stage identity and immutable native request persisted before execution. */
export interface PrepareAttemptInput {
  readonly key: string
  readonly prompt: string
  readonly inputRefs: readonly StageInputRef[]
  readonly outputSchema: object
}
const outputRefSchema = z.strictObject({ attemptId: attemptIdSchema, sha256: digestSchema, bytes: z.number().int().nonnegative(), chars: z.number().int().nonnegative() })
/** Durable raw text identity; the default progress view contains no text. */
export type RunOutputRef = z.infer<typeof outputRefSchema>
/** Explicit classification of a known failed attempt whose model response arrived but was declined or cut off. */
const attemptFailureKindSchema = z.enum(['refused', 'truncated'])
/** Why a failed attempt's model response is unusable: the provider refused it, or output stopped at the length limit. */
export type AttemptFailureKind = z.infer<typeof attemptFailureKindSchema>
const citedQuoteSchema = z.strictObject({ artifactId: z.string(), quote: z.string() })
const evidenceEventSchema = z.strictObject({
  kind: z.enum(['reattributed', 'segmented', 'snapped', 'dropped', 'downgraded']), location: z.string().optional(),
  declared: citedQuoteSchema, admitted: z.array(citedQuoteSchema), distance: z.number().int().nonnegative(), reason: z.string().optional(),
})
/** One host evidence repair or drop applied while admitting an attempt's output. */
export type EvidenceEvent = z.infer<typeof evidenceEventSchema>
/** Code points kept per recorded quote or reason; events are diagnostics, the admitted value itself is stored in full. */
const EVENT_TEXT_CHARS = 400
const MAX_EVIDENCE_EVENTS = 200
const aiToneBlockSchema = z.strictObject({ reason: z.enum(['ai-tone', 'ai-tone-repeat', 'ai-tone-exhausted']), spans: z.array(z.string()).max(20) })
/** Why the host blocked the body a review attempt judged: the stop or repair reason and the blocking body excerpts. */
export type AiToneBlockRecord = z.infer<typeof aiToneBlockSchema>
const attemptSchema = z.strictObject({
  id: attemptIdSchema, parentSessionId: sessionIdSchema, request: attemptRequestSchema,
  status: z.enum(['prepared', 'running', 'succeeded', 'failed', 'unknown']), childSessionId: sessionIdSchema.nullable(),
  output: outputRefSchema.nullable(), error: z.string().nullable(), retryAuthorized: z.boolean(),
  // Absent for every other attempt, so records written before this field existed remain valid unchanged.
  failureKind: attemptFailureKindSchema.optional(),
  // Host evidence repairs and drops from admitting this attempt's output; absent when none (and on older records).
  evidenceEvents: z.array(evidenceEventSchema).max(MAX_EVIDENCE_EVENTS).optional(),
  // Prompt version 5 or later body reviews: set on a review whose body the host blocked for AI tone. The review artifact itself
  // stays as the reviewer wrote it (its AI-tone issues are advisory), so this marker is what shows the block before any
  // manual use of that body. Absent on every other attempt and on older records.
  aiToneBlock: aiToneBlockSchema.exactOptional(),
})
type AttemptRecord = z.infer<typeof attemptSchema>
/** Detached execution progress, excluding the stored prompt and response schema. */
export type WritingAttempt = Omit<AttemptRecord, 'request'> & { readonly key: string; readonly inputRefs: readonly StageInputRef[] }
const runSchema = z.strictObject({
  ...beginSchema.shape, serviceLimits: serviceLimitsSchema.nullable(), id: runIdSchema, limits: limitsSchema,
  status: z.enum(['running', 'interrupted', 'completed', 'failed', 'stopped']),
  startedBy: sessionIdSchema, lastResumedBy: sessionIdSchema,
  attempts: z.array(attemptSchema), error: z.string().nullable(),
  // Prompt text version fixed at creation so a resume rebuilds identical prompts; absent on runs created before versioning (= 1).
  promptVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional(),
})
/** Detached progress metadata; raw stage outputs are read explicitly. */
export type WritingRun = Omit<RunRecord, 'attempts'> & { readonly attempts: readonly WritingAttempt[] }
type RunRecord = z.infer<typeof runSchema>
const currentNovelRunsSchema = z.strictObject({ version: z.literal(2), novelId: novelIdSchema, workspace: z.string().min(1), runs: z.array(runSchema) })
// Version one never recorded these limits; null preserves that absence without guessing a deployment policy.
const legacyNovelRunsSchema = z.strictObject({ version: z.literal(1), novelId: novelIdSchema, workspace: z.string().min(1), runs: z.array(runSchema.omit({ serviceLimits: true })) })
  .transform(record => ({ ...record, runs: record.runs.map(run => ({ ...run, serviceLimits: null })) }))
const novelRunsSchema = z.union([currentNovelRunsSchema, legacyNovelRunsSchema])
type NovelRuns = z.infer<typeof novelRunsSchema>
const outputSchema = outputRefSchema.extend({ runId: runIdSchema, text: z.string() })
/** Explicit bounded raw output read; content admission belongs to the stage parser. */
export type RunOutput = z.infer<typeof outputSchema>
const runDomain = defineDomain({ name: 'story_runs', version: 1, layout: 'single', tables: {
  novels: domainTable<NovelId, NovelRuns>(novelRunsSchema), outputs: domainTable<AttemptId, RunOutput>(outputSchema),
} })

/** Finite deployment bounds fixed before the run store opens. */
export interface RunStoreLimits { readonly maxAttempts: number; readonly maxOutputBytes: number }
/** Run admission and ownership failures; persistence errors retain their original cause. */
export class RunStoreError extends Error {
  /** @param code - Stable failure category. @param message - Human-readable failed precondition. */
  constructor(readonly code: string, message: string) { super(message); this.name = 'RunStoreError' }
}
function fail(code: string, message: string): never { throw new RunStoreError(code, message) }
/** One resume-compared limit whose captured value differs from the current deployment's. */
export interface RunLimitMismatch { readonly key: string; readonly saved: number | boolean | null; readonly current: number | boolean }
/**
 * A resume refused because captured limits differ from the current config. Readable text first, then one JSON line
 * `{"code":"run-limits","mismatched":[{"key":...,"saved":...,"current":...}]}` naming every differing key.
 * Keeps the name RunStoreError, so existing handlers that match on it still apply.
 */
export class RunLimitsError extends RunStoreError {
  constructor(readonly mismatched: readonly RunLimitMismatch[]) {
    super('run-limits', `Restore the captured writing and research limits before resuming; legacy runs without a snapshot cannot resume. Differing: ${mismatched.map(item => `${item.key} (saved ${String(item.saved)}, current ${String(item.current)})`).join(', ')}.\n${JSON.stringify({ code: 'run-limits', mismatched })}`)
  }
}
/**
 * The novel is held by another unfinished (running or interrupted) run. The readable sentence names it and the message ends with
 * one JSON line `{"code":"active-run","runId":...}`, so a caller can stop or resume exactly that run.
 */
export class ActiveRunError extends RunStoreError {
  constructor(message: string, readonly runId: RunId) {
    super('active-run', `${message} (${runId}); stop it with story_stop or resume it with story_resume first\n${JSON.stringify({ code: 'active-run', runId })}`)
    this.name = 'ActiveRunError'
  }
}
function active(run: { readonly status: WritingRun['status'] }): boolean { return run.status === 'running' || run.status === 'interrupted' }

/** Per-novel histories; native model execution and cancellation quiescence belong to the caller. */
export class RunStore {
  private readonly outputWrites = new Map<AttemptId, { text: string; result: Promise<WritingAttempt> }>()
  private readonly initializations = new Map<NovelId, Promise<void>>()
  /** @param domain - Exclusively opened host domain. @param limits - Validated immutable bounds. */
  constructor(private readonly domain: Domain<typeof runDomain>, readonly limits: Readonly<RunStoreLimits>) {}

  /** @param actor - Workspace owner and initiating Session. @param input - Immutable run request. @returns The original idempotent request or a newly persisted run. */
  async begin(actor: Actor, input: BeginRunInput, promptVersion: PromptVersion = CURRENT_PROMPT_VERSION): Promise<WritingRun> {
    actor.signal?.throwIfAborted()
    const parsed = beginSchema.safeParse(input)
    if (!parsed.success) fail('invalid-input', parsed.error.message)
    const request = withAiToneBlocking(parsed.data, promptVersion)
    await this.ensureNovel(actor, parsed.data.novelId)
    let result: RunRecord | undefined
    await this.domain.table('novels').update(parsed.data.novelId, current => {
      actor.signal?.throwIfAborted()
      this.own(actor, current)
      const existing = current.runs.find(run => run.requestId === parsed.data.requestId)
      if (existing !== undefined) {
        requireServiceLimits(existing)
        if (!isDeepStrictEqual(beginSchema.parse(pickRequest(existing)), withAiToneBlocking(parsed.data, existing.promptVersion ?? 1))) fail('request-conflict', 'Request ID already names different writing inputs')
        result = existing
        return current
      }
      validateRevisionBudget(parsed.data, this.limits)
      const holder = current.runs.find(active)
      if (holder !== undefined) throw new ActiveRunError('The novel already has an unfinished writing run', holder.id)
      result = { ...request, limits: { ...this.limits }, id: brandString<RunId>(`run_${randomUUID()}`), status: 'running', startedBy: actor.sessionId, lastResumedBy: actor.sessionId, attempts: [], error: null, promptVersion }
      return { ...current, version: 2, runs: [...current.runs, result] }
    })
    if (result === undefined) fail('corrupt-run', 'Run creation did not produce a record')
    return runView(result)
  }

  /** @param actor - Workspace owner. @param runId - Exact durable run. @returns Detached progress metadata. */
  get(actor: Actor, runId: RunId): WritingRun {
    for (const [, record] of this.domain.table('novels').entries()) {
      const run = record.runs.find(item => item.id === runId)
      if (run !== undefined) { this.own(actor, record); return runView(run) }
    }
    return fail('run-not-found', 'runId does not exist')
  }

  /** @param actor - Workspace owner. @param novelId - Novel whose history is requested. @returns Detached runs in creation order. */
  list(actor: Actor, novelId: NovelId): WritingRun[] {
    const record = this.domain.table('novels').get(novelId)
    if (record === undefined) return []
    this.own(actor, record)
    return record.runs.map(runView)
  }

  /** @param actor - Workspace owner. @param runId - Interrupted or terminal run. @param options - Explicit permission to replace outcome-unknown attempts. @returns Persisted resumed metadata. */
  async resume(actor: Actor, runId: RunId, options: { retryUnknown: boolean }): Promise<WritingRun> {
    return runView(await this.change(actor, runId, (original, record) => {
      requireServiceLimits(original)
      const run = recoverOutputs(original, this.domain)
      if (run.status === 'completed') fail('run-state', 'Completed runs cannot resume')
      const holder = record.runs.find(other => other.id !== run.id && active(other))
      if (holder !== undefined) throw new ActiveRunError('Another unfinished run owns the novel', holder.id)
      if (latestAttempts(run).some(attempt => attempt.status === 'unknown') && !options.retryUnknown) fail('unknown-outcome', 'Explicit retry permission is required for unknown stage outcomes')
      return { ...run, status: 'running', lastResumedBy: actor.sessionId, error: null,
        attempts: run.attempts.map(attempt => attempt.status === 'unknown' && latestAttempts(run).some(latest => latest.id === attempt.id) ? { ...attempt, retryAuthorized: options.retryUnknown } : attempt) }
    }))
  }

  /** @param actor - Workspace owner. @param runId - Running writing request. @param input - Exact stage request. @returns An existing matching attempt or a newly durable prepared attempt. */
  async prepareAttempt(actor: Actor, runId: RunId, input: PrepareAttemptInput): Promise<WritingAttempt> {
    actor.signal?.throwIfAborted()
    const request = attemptRequestSchema.parse(input)
    assertObjectJsonSchema(request.outputSchema)
    const run = await this.change(actor, runId, current => {
      requireServiceLimits(current)
      this.requireRunning(current)
      const previous = current.attempts.findLast(attempt => attempt.request.key === request.key)
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous.request, request)) fail('attempt-conflict', 'Stage key already names a different prompt, source version or output schema')
        if (previous.status === 'unknown' && !previous.retryAuthorized) fail('unknown-outcome', 'Explicit retry permission is required before replacing this attempt')
        if (previous.status !== 'failed' && previous.status !== 'unknown') return current
      }
      if (current.attempts.length >= current.limits.maxAttempts) fail('attempt-budget', 'Writing run exhausted its prepared attempt budget')
      const next: AttemptRecord = { id: brandString<AttemptId>(`attempt_${randomUUID()}`), parentSessionId: actor.sessionId, request, status: 'prepared', childSessionId: null, output: null, error: null, retryAuthorized: false }
      return { ...current, attempts: [...current.attempts.map(attempt => attempt.id === previous?.id ? { ...attempt, retryAuthorized: false } : attempt), next] }
    })
    const attempt = run.attempts.findLast(item => item.request.key === request.key)
    if (attempt === undefined) fail('corrupt-run', 'Prepared attempt is missing')
    return attemptView(attempt)
  }

  /** @param actor - Workspace owner. @param runId - Running request. @param attemptId - Prepared attempt. @param childSessionId - Actual native child, stored before streaming. @returns The associated attempt. */
  async associateChild(actor: Actor, runId: RunId, attemptId: AttemptId, childSessionId: SessionId): Promise<WritingAttempt> {
    const run = await this.change(actor, runId, current => {
      this.requireRunning(current)
      for (const [, history] of this.domain.table('novels').entries()) {
        if (history.runs.some(run => run.attempts.some(attempt => attempt.id !== attemptId && attempt.childSessionId === childSessionId))) fail('attempt-conflict', 'Native child is already associated with another stage attempt')
      }
      return replaceAttempt(current, attemptId, attempt => {
        if (attempt.childSessionId === childSessionId && attempt.status === 'running') return attempt
        if (attempt.status !== 'prepared') fail('attempt-state', 'Only a prepared attempt can associate a new native child')
        return { ...attempt, childSessionId, status: 'running' }
      })
    })
    return attemptView(findAttempt(run, attemptId))
  }

  /** @param actor - Workspace owner and cancellation signal. @param runId - Running request. @param attemptId - Native stage attempt. @param text - Exact raw stage output. @returns Metadata after content is durable and its reference is published. */
  async saveOutput(actor: Actor, runId: RunId, attemptId: AttemptId, text: string): Promise<WritingAttempt> {
    actor.signal?.throwIfAborted()
    const run = this.get(actor, runId)
    if (!run.attempts.some(attempt => attempt.id === attemptId)) fail('attempt-not-found', 'attemptId does not belong to this run')
    const pending = this.outputWrites.get(attemptId)
    if (pending !== undefined) {
      if (pending.text !== text) fail('output-conflict', 'Attempt output is immutable')
      return pending.result
    }
    const result = this.persistOutput(actor, runId, attemptId, text)
    this.outputWrites.set(attemptId, { text, result })
    try { return await result } finally { this.outputWrites.delete(attemptId) }
  }

  /** @param actor - Workspace owner. @param runId - Exact request. @param attemptId - Successful attempt. @returns Its full raw text within the run's captured UTF-8 bound, after digest and reference validation. */
  readOutput(actor: Actor, runId: RunId, attemptId: AttemptId): RunOutput {
    const run = this.get(actor, runId)
    const attempt = run.attempts.find(item => item.id === attemptId)
    if (attempt === undefined) fail('attempt-not-found', 'attemptId does not belong to this run')
    if (attempt.output === null) fail('output-not-found', 'Attempt has no published raw output')
    const output = this.domain.table('outputs').get(attemptId)
    if (output === undefined || output.runId !== runId || !isDeepStrictEqual(outputRef(output), attempt.output)) fail('corrupt-run', 'Saved output does not match its attempt reference')
    validateOutput(output, run.limits)
    return structuredClone(output)
  }

  /** @param actor - Workspace owner after native work settles. @param runId - Running request. @param attemptId - Exact active attempt. @param failure - Known failure or explicitly uncertain outcome; `kind` classifies a known refusal or length cut-off. `retryAuthorized` may be set only with `outcome: 'unknown'`. @returns Persisted failure metadata without discarding prior attempts. */
  async failAttempt(actor: Actor, runId: RunId, attemptId: AttemptId, failure: { outcome: 'failed' | 'unknown'; message: string; kind?: AttemptFailureKind; retryAuthorized?: boolean }): Promise<WritingAttempt> {
    if (failure.message.trim().length === 0) fail('invalid-input', 'Failed or unknown attempts require a nonblank failure reason')
    if (failure.kind !== undefined && failure.outcome !== 'failed') fail('invalid-input', 'Only a known failed attempt can be classified as refused or truncated')
    if (failure.kind !== undefined && !attemptFailureKindSchema.safeParse(failure.kind).success) fail('invalid-input', 'Unknown attempt failure classification')
    if (failure.retryAuthorized === true && failure.outcome !== 'unknown') fail('invalid-input', 'Retry permission belongs only to an unknown attempt')
    const retryAuthorized = failure.outcome === 'unknown' && failure.retryAuthorized === true
    const run = await this.change(actor, runId, current => {
      this.requireRunning(current)
      return replaceAttempt(current, attemptId, attempt => {
        if (attempt.status === failure.outcome && attempt.error === failure.message && attempt.failureKind === failure.kind && attempt.retryAuthorized === retryAuthorized) return attempt
        if (attempt.status !== 'prepared' && attempt.status !== 'running') fail('attempt-state', 'Terminal attempt outcomes cannot be rewritten')
        return { ...attempt, status: failure.outcome, error: failure.message, retryAuthorized, ...(failure.kind === undefined ? {} : { failureKind: failure.kind }) }
      })
    })
    return attemptView(findAttempt(run, attemptId))
  }

  /** @param actor - Workspace owner after awaiting native quiescence. @param runId - Request to finish. @param status - Explicit final result. @param message - Optional failure or stop reason. @returns Durable terminal progress. */
  async finish(actor: Actor, runId: RunId, status: 'completed' | 'failed' | 'stopped', message?: string): Promise<WritingRun> {
    return runView(await this.change(actor, runId, run => {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
        if (status !== run.status || (message ?? null) !== run.error) fail('run-state', 'Terminal run results require explicit resume before changing')
        return run
      }
      if (status === 'completed' && latestAttempts(run).some(attempt => attempt.status !== 'succeeded')) fail('attempt-state', 'Unfinished stages cannot complete a run')
      return { ...run, status, error: message ?? null, attempts: run.attempts.map(attempt => attempt.status === 'prepared' || attempt.status === 'running' ? unknownAttempt(attempt) : attempt) }
    }))
  }

  /**
   * @param actor - Workspace owner. @param runId - Running request. @param attemptId - Attempt whose saved output was just admitted (or rejected).
   * @param events - Host evidence repairs and drops reported during that admission; recording the same events again is a no-op.
   * @returns The attempt with its durable events.
   */
  async recordEvidenceEvents(actor: Actor, runId: RunId, attemptId: AttemptId, events: readonly QuoteRepair[]): Promise<WritingAttempt> {
    const clip = (value: string) => { const chars = [...value]; return chars.length <= EVENT_TEXT_CHARS ? value : `${chars.slice(0, EVENT_TEXT_CHARS).join('')}…` }
    const quote = (item: { artifactId: string; quote: string }) => ({ artifactId: item.artifactId, quote: clip(item.quote) })
    const bounded = events.slice(0, MAX_EVIDENCE_EVENTS).map(event => evidenceEventSchema.parse({
      kind: event.kind, ...(event.location === undefined ? {} : { location: event.location }), declared: quote(event.declared),
      admitted: event.admitted.map(quote), distance: event.distance, ...(event.reason === undefined ? {} : { reason: clip(event.reason) }) }))
    const run = await this.change(actor, runId, current => {
      this.requireRunning(current)
      return replaceAttempt(current, attemptId, attempt => {
        if (attempt.status !== 'succeeded') fail('attempt-state', 'Evidence events belong to an attempt with saved output')
        if (isDeepStrictEqual(attempt.evidenceEvents ?? [], bounded)) return attempt
        const { evidenceEvents: _previous, ...rest } = attempt
        return bounded.length === 0 ? rest : { ...rest, evidenceEvents: bounded }
      })
    })
    return attemptView(findAttempt(run, attemptId))
  }

  /**
   * @param actor - Workspace owner. @param runId - Running request. @param attemptId - Succeeded body-review attempt.
   * @param block - The host's AI-tone block of the reviewed body; recording the same block again is a no-op.
   * @returns The attempt with its durable marker.
   */
  async recordAiToneBlock(actor: Actor, runId: RunId, attemptId: AttemptId, block: AiToneBlockRecord): Promise<WritingAttempt> {
    const parsed = aiToneBlockSchema.parse(block)
    const run = await this.change(actor, runId, current => {
      this.requireRunning(current)
      return replaceAttempt(current, attemptId, attempt => {
        if (attempt.status !== 'succeeded') fail('attempt-state', 'An AI-tone block belongs to a review attempt with saved output')
        return isDeepStrictEqual(attempt.aiToneBlock, parsed) ? attempt : { ...attempt, aiToneBlock: parsed }
      })
    })
    return attemptView(findAttempt(run, attemptId))
  }

  private async persistOutput(actor: Actor, runId: RunId, attemptId: AttemptId, text: string): Promise<WritingAttempt> {
    const run = this.get(actor, runId)
    const attempt = run.attempts.find(item => item.id === attemptId)
    if (attempt === undefined) fail('attempt-not-found', 'attemptId does not belong to this run')
    const existing = this.domain.table('outputs').get(attemptId)
    if (existing !== undefined && (existing.text !== text || existing.runId !== runId)) fail('output-conflict', 'Attempt output is immutable')
    if (attempt.status === 'succeeded') { this.readOutput(actor, runId, attemptId); return attempt }
    this.requireRunning(run)
    if (attempt.status !== 'running') fail('attempt-state', 'Raw output requires an associated active child')
    const output: RunOutput = { attemptId, runId, text, sha256: hash(text), bytes: Buffer.byteLength(text, 'utf8'), chars: [...text].length }
    validateOutput(output, run.limits)
    actor.signal?.throwIfAborted()
    if (existing === undefined) await this.domain.table('outputs').put(attemptId, output)
    const saved = await this.change(actor, runId, current => {
      this.requireRunning(current)
      return replaceAttempt(current, attemptId, latest => {
        if (latest.status !== 'running') fail('attempt-state', 'Attempt is no longer accepting output')
        return { ...latest, status: 'succeeded', output: outputRef(output), error: null, retryAuthorized: false }
      })
    })
    return attemptView(findAttempt(saved, attemptId))
  }
  private requireRunning(run: { readonly status: WritingRun['status'] }): void {
    if (run.status !== 'running') fail('run-state', 'Run must be explicitly resumed before new stage work')
  }
  private async change(actor: Actor, runId: RunId, transform: (run: RunRecord, novel: NovelRuns) => RunRecord): Promise<RunRecord> {
    actor.signal?.throwIfAborted()
    const initial = this.get(actor, runId)
    const record = await this.domain.table('novels').update(initial.novelId, current => {
      actor.signal?.throwIfAborted()
      this.own(actor, current)
      return { ...current, version: 2, runs: current.runs.map(run => run.id === runId ? transform(run, current) : run) }
    })
    const run = record.runs.find(item => item.id === runId)
    if (run === undefined) fail('run-not-found', 'Writing run disappeared during update')
    return run
  }

  /** @returns Resolution after the host domain drains its accepted writes. Callers first await native execution quiescence. */
  close(): Promise<void> { return this.domain.close() }

  private own(actor: Actor, record: NovelRuns): void {
    if (actor.workspace !== record.workspace) fail('workspace-mismatch', 'Writing run belongs to another workspace')
  }
  private async ensureNovel(actor: Actor, novelId: NovelId): Promise<void> {
    if (this.domain.table('novels').get(novelId) !== undefined) return
    const pending = this.initializations.get(novelId)
    if (pending !== undefined) return pending
    actor.signal?.throwIfAborted()
    const write = this.domain.table('novels').put(novelId, { version: 2, novelId, workspace: actor.workspace, runs: [] })
    this.initializations.set(novelId, write)
    try { await write } finally { this.initializations.delete(novelId) }
  }
}
function pickRequest(run: RunRecord) {
  return { serviceLimits: run.serviceLimits, executionLimits: run.executionLimits, novelId: run.novelId, requestId: run.requestId, briefArtifactId: run.briefArtifactId, settingsRoots: run.settingsRoots, chapterCount: run.chapterCount, fromChapter: run.fromChapter, throughChapter: run.throughChapter, mode: run.mode, revision: run.revision }
}

/**
 * A run on prompt version 5 or later always records aiToneBlocking (default on when the caller passed none); an older run
 * never does, so its body reviews stay advisory regardless of the deployment's current switch.
 */
function withAiToneBlocking(input: BeginRunInput, promptVersion: PromptVersion): BeginRunInput {
  const { aiToneBlocking, ...limits } = input.executionLimits
  return { ...input, executionLimits: promptVersion >= 5 ? { ...limits, aiToneBlocking: aiToneBlocking ?? true } : limits }
}

function requireServiceLimits(run: RunRecord): void {
  if (run.serviceLimits === null) fail('run-limits', 'Legacy run has no recorded service limits; read or stop it and begin a new request')
}

function attemptView(attempt: AttemptRecord): WritingAttempt {
  const { request, ...metadata } = attempt
  return structuredClone({ ...metadata, key: request.key, inputRefs: request.inputRefs })
}
function runView(run: RunRecord): WritingRun { return structuredClone({ ...run, attempts: run.attempts.map(attemptView) }) }
function findAttempt(run: RunRecord, id: AttemptId): AttemptRecord {
  const attempt = run.attempts.find(item => item.id === id)
  if (attempt === undefined) fail('attempt-not-found', 'attemptId does not belong to this run')
  return attempt
}
function replaceAttempt(run: RunRecord, id: AttemptId, transform: (attempt: AttemptRecord) => AttemptRecord): RunRecord {
  findAttempt(run, id)
  return { ...run, attempts: run.attempts.map(attempt => attempt.id === id ? transform(attempt) : attempt) }
}
function latestAttempts(run: RunRecord): AttemptRecord[] { return [...new Map(run.attempts.map(attempt => [attempt.request.key, attempt])).values()] }
function unknownAttempt(attempt: AttemptRecord): AttemptRecord {
  return { ...attempt, status: 'unknown', retryAuthorized: false, error: 'Stage outcome was not durably recorded' }
}
function admitDomain(domain: Domain<typeof runDomain>): void {
  const runIds = new Set<RunId>()
  const children = new Set<SessionId>()
  const attempts = new Map<AttemptId, { run: RunRecord; attempt: AttemptRecord }>()
  for (const [key, record] of domain.table('novels').entries()) {
    if (key !== record.novelId) fail('corrupt-run', 'Novel key does not match its run history')
    if (record.runs.filter(active).length > 1) fail('corrupt-run', 'Novel has multiple unfinished writing runs')
    const requests = new Set<string>()
    for (const run of record.runs) {
      const { serviceLimits, ...legacyRequest } = pickRequest(run)
      legacyBeginSchema.parse(legacyRequest)
      if (serviceLimits !== null) beginSchema.parse(pickRequest(run))
      validateRevisionBudget(run, run.limits)
      if (run.novelId !== record.novelId || runIds.has(run.id) || requests.has(run.requestId)) fail('corrupt-run', 'Run identity or request ownership is inconsistent')
      runIds.add(run.id)
      requests.add(run.requestId)
      if (run.attempts.length > run.limits.maxAttempts) fail('corrupt-run', 'Persisted attempts exceed the run budget')
      const latest = latestAttempts(run)
      if (run.status === 'completed' && latest.some(attempt => attempt.status !== 'succeeded')) fail('corrupt-run', 'Completed run has unfinished stage work')
      for (const attempt of run.attempts) {
        assertObjectJsonSchema(attempt.request.outputSchema)
        if (attempts.has(attempt.id)) fail('corrupt-run', 'Stage attempt identity occurs more than once')
        attempts.set(attempt.id, { run, attempt })
        if (attempt.childSessionId !== null) {
          if (children.has(attempt.childSessionId)) fail('corrupt-run', 'Native child identity belongs to multiple attempts')
          children.add(attempt.childSessionId)
        }
        const last = latest.find(item => item.request.key === attempt.request.key)
        if (last === undefined || !isDeepStrictEqual(last.request, attempt.request)) fail('corrupt-run', 'Stage key has conflicting immutable requests')
        if (last.id !== attempt.id && (attempt.status !== 'failed' && attempt.status !== 'unknown' || attempt.retryAuthorized)) fail('corrupt-run', 'Replaced stage attempt is still active or successful')
        if ((attempt.status === 'succeeded') !== (attempt.output !== null)) fail('corrupt-run', 'Stage success and saved output reference disagree')
        if (attempt.status === 'prepared' && attempt.childSessionId !== null || (attempt.status === 'running' || attempt.status === 'succeeded') && attempt.childSessionId === null) fail('corrupt-run', 'Native child identity disagrees with attempt status')
        if (attempt.status === 'failed' || attempt.status === 'unknown') {
          if (attempt.error === null || attempt.error.trim().length === 0) fail('corrupt-run', 'Unsuccessful attempt lacks its failure reason')
        } else if (attempt.error !== null) fail('corrupt-run', 'Successful or active attempt carries a failure reason')
        if (attempt.retryAuthorized && attempt.status !== 'unknown') fail('corrupt-run', 'Retry permission does not belong to an unknown attempt')
        if (attempt.failureKind !== undefined && attempt.status !== 'failed') fail('corrupt-run', 'Only a failed attempt can be classified as refused or truncated')
        if (run.status !== 'running' && (attempt.status === 'prepared' || attempt.status === 'running')) fail('corrupt-run', 'Non-running run contains an active attempt')
        if (attempt.output !== null) {
          const output = domain.table('outputs').get(attempt.id)
          if (output === undefined || output.runId !== run.id || !isDeepStrictEqual(attempt.output, outputRef(output))) fail('corrupt-run', 'Output reference has no matching immutable content')
        }
      }
    }
  }
  for (const [key, output] of domain.table('outputs').entries()) {
    const owner = attempts.get(key)
    if (owner === undefined || output.attemptId !== key || output.runId !== owner.run.id || owner.attempt.childSessionId === null) fail('corrupt-run', 'Raw output has no exact associated stage attempt')
    validateOutput(output, owner.run.limits)
    if (owner.attempt.output === null && (owner.attempt.status === 'prepared' || !latestAttempts(owner.run).some(attempt => attempt.id === key))) fail('corrupt-run', 'Unpublished raw output belongs to an unassociated or replaced attempt')
  }
}
function recoverOutputs(run: RunRecord, domain: Domain<typeof runDomain>): RunRecord {
  return { ...run, attempts: run.attempts.map(attempt => {
    const output = domain.table('outputs').get(attempt.id)
    if (output === undefined) return attempt
    if (output.runId !== run.id || output.attemptId !== attempt.id || attempt.childSessionId === null) fail('corrupt-run', 'Raw output does not name its exact associated stage attempt')
    return { ...attempt, status: 'succeeded', output: outputRef(output), error: null, retryAuthorized: false }
  }) }
}
function validateRevisionBudget(input: Pick<BeginRunInput, 'revision'>, limits: RunStoreLimits): void {
  if (input.revision !== null && Buffer.byteLength(input.revision.instructions, 'utf8') > limits.maxOutputBytes) fail('revision-budget', 'Revision instructions exceed the run UTF-8 byte limit')
}
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
function outputRef(output: RunOutput): RunOutputRef { return { attemptId: output.attemptId, sha256: output.sha256, bytes: output.bytes, chars: output.chars } }
function validateOutput(output: RunOutput, limits: RunStoreLimits): void {
  if (!output.text.isWellFormed() || output.bytes !== Buffer.byteLength(output.text, 'utf8') || output.chars !== [...output.text].length || output.sha256 !== hash(output.text)) fail('corrupt-run', 'Raw output digest or UTF-8 counts do not match its text')
  if (output.bytes > limits.maxOutputBytes) fail('output-budget', 'Raw stage output exceeds the configured UTF-8 byte limit')
}

/** @param facility - Existing DSH domain facility. @param limits - Finite run and output bounds. @returns An independently owned run store with interrupted work recovered. */
export async function openRunStore(facility: DomainFacility, limits: RunStoreLimits): Promise<RunStore> {
  if (![limits.maxAttempts, limits.maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)) fail('invalid-input', 'Run limits must be positive safe integers')
  const domain = await facility.open(runDomain)
  try {
    admitDomain(domain)
    for (const [novelId, record] of domain.table('novels').entries()) {
      if (record.novelId !== novelId) fail('corrupt-run', 'Novel run table key does not match its record')
      const runs = record.runs.map(original => {
        const run = recoverOutputs(original, domain)
        return { ...run, status: run.status === 'running' ? 'interrupted' as const : run.status,
          attempts: run.attempts.map(attempt => attempt.status === 'prepared' || attempt.status === 'running' ? unknownAttempt(attempt) : attempt) }
      })
      if (record.version === 1 || !isDeepStrictEqual(runs, record.runs)) await domain.table('novels').update(novelId, current => ({ ...current, version: 2, runs }))
    }
    return new RunStore(domain, Object.freeze({ ...limits }))
  } catch (error) { await domain.close(); throw error }
}
