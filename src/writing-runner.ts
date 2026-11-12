/** Native writing orchestration with durable attempts and reviewed version publication. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { nativeStageOutputSchema } from './native-stage-schema.ts'
import { AiToneReviewBlockedError, aiToneRepairInstruction, ImportRefusedError, ImportReviewBlockedError, SettingsIncompleteError, WritingError, parseArtifactId, parseRequestId, type Actor, type ArtifactRef, type ImportItem } from './contracts.ts'
import type { WritingService } from './service.ts'
import { RunLimitsError, RunStoreError, type AiToneBlockRecord, type AttemptFailureKind, type RunLimitMismatch, type RunStore, type BeginRunInput, type RunExecutionLimits, type RunServiceLimits, type RunId, type WritingRun, type WritingAttempt } from './run-store.ts'
import { executeStage, StageExecutionError, type StageRequest, type StageResult } from './stage-executor.ts'
import { AI_TONE_ISSUE_PREFIX, buildStagePrompt, type PromptVersion, type StagePromptKind } from './stage-prompts.ts'
import { proseView } from './prose-view.ts'
import { aiToneHits } from './ai-tone.ts'
import { buildResearchPrompt, validateResearchStageResult, RESEARCH_STAGE_OUTPUT_SCHEMA, researchStageTools, researchToolAuthorization } from './research-stage.ts'
import { buildResearchPlanningPrompt, researchNecessity, RESEARCH_PLANNING_OUTPUT_SCHEMA, type ResearchNecessity } from './research-planning.ts'
import { StageValidationRejection } from './stage-rejection.ts'
import { missingRequiredSettings, planSettings } from './settings-plan.ts'
import { settingsCatalog, type SettingsDimensionKind } from './settings-catalog.ts'
import { EvidenceRejection, StageOutputSchemas, type BodyOutput, type ReviewCategory, type StageInputRef } from './stage-output.ts'
import { countStoryWords } from './body-text.ts'
import { buildCitationRepairPrompt, CITATION_REPAIR_OUTPUT_SCHEMA, mergeCitationRepair } from './citation-repair.ts'
import { collectQuoteRepairs } from './evidence-quote.ts'
import type { GeneratedManuscriptTarget, ManuscriptCandidateView, ManuscriptTarget } from './manuscript.ts'
import type { ImportSettingsRequest, SettingsCandidateView } from './settings.ts'
import { writingActor } from './tools.ts'
import type { StageDeliveries } from './stage-deliveries.ts'

/** Author-selected scope; deployment execution limits are captured by the runner. */
export type StartWritingInput = Omit<BeginRunInput, 'executionLimits' | 'serviceLimits' | 'revision' | 'mode'> & { readonly mode: 'write' | 'update' }
/** Operator-side runner settings; never reachable through tool arguments. */
export interface WritingRunnerOptions {
  /** Skip the required-settings gate. Plugin config only, default false; for smoke and unit tests. Not stored with runs. */
  readonly allowIncompleteSettings?: boolean
}
interface Invocation { readonly actor: Actor; readonly exec: ToolExecution; readonly run: WritingRun; readonly controller: AbortController }
interface CapturedStage extends StageResult { readonly attempt: WritingAttempt }
interface ActiveRun { readonly controller: AbortController; readonly done: Promise<WritingRun> }
/** Why a candidate is regenerated: a host length finding asks for every scene to be rescaled, a blocked review or unmet obligation for its documented defects to be repaired. */
type RepairMode = 'length' | 'review'

/** Owns in-process execution; durable stores own versions and recovery receipts. */
export class WritingRunner {
  private readonly active = new Map<RunId, ActiveRun>()
  private readonly admissions = new Set<Promise<WritingRun>>()
  private readonly replayControllers = new Set<AbortController>()
  private readonly replayShutdown = new Error('Writing preview replay was cancelled by plugin shutdown.')
  private closed = false
  /** @param ctx - Existing DSH capabilities. @param service - Version owner. @param runs - Durable run owner. @param limits - Explicit deployment limits copied into new runs. @param deliveries - Awaited native document publisher. */
  constructor(private readonly ctx: Context, private readonly service: WritingService, readonly runs: RunStore, readonly limits: RunExecutionLimits, private readonly deliveries: StageDeliveries, private readonly options: WritingRunnerOptions = {}) {}

  /** @param exec - Calling native tool. @param input - Explicit novel, brief and chapter scope. @returns Terminal progress after all native work has stopped. */
  async start(exec: ToolExecution, input: StartWritingInput): Promise<WritingRun> {
    const actor = await writingActor(this.ctx, exec)
    this.admit(actor, input)
    this.requirePresentation(exec)
    return this.admission(async () => {
      const run = await this.runs.begin(actor, { ...input, revision: null, executionLimits: this.limits, serviceLimits: this.serviceLimits() })
      return this.launchAdmitted(exec, actor, run)
    })
  }

  /** @param exec - Native author tool. @param input - Exact applied base and requested revision. @returns After only that upstream version is reviewed and adopted. */
  async revise(exec: ToolExecution, input: Omit<BeginRunInput, 'executionLimits' | 'serviceLimits'>): Promise<WritingRun> {
    const actor = await writingActor(this.ctx, exec)
    this.admit(actor, input)
    this.requirePresentation(exec)
    if (input.mode !== 'revise' || input.revision === null) throw new RunStoreError('invalid-input', 'An upstream revision needs an exact base and instructions')
    return this.admission(async () => {
      const run = await this.runs.begin(actor, { ...input, executionLimits: this.limits, serviceLimits: this.serviceLimits() })
      return this.launchAdmitted(exec, actor, run)
    })
  }

  /** @param exec - Current calling tool in the owning workspace. @param runId - Retained run. @param retryUnknown - Explicit permission to retry calls without durable output. @returns Terminal progress using the original execution limits. */
  async resume(exec: ToolExecution, runId: RunId, retryUnknown: boolean): Promise<WritingRun> {
    const actor = await writingActor(this.ctx, exec)
    const stored = this.runs.get(actor, runId)
    // A completed run cannot resume at all, so it skips only the settings gate. Resume still
    // compares the run's stored brief with the current one; the caller does not pass briefArtifactId.
    // It still goes through the brief, present and limit checks and is then refused with run-state by RunStore.resume.
    // Pass the run id so a settings-incomplete resume can name that run and its pending imports (T4).
    this.admit(actor, stored, stored.id, stored.status !== 'completed')
    this.requirePresentation(exec)
    this.requireRunLimits(stored)
    const active = this.active.get(runId)
    if (active !== undefined) return active.done
    if (stored.status !== 'completed') this.requirePendingImportsReviewed(actor, stored)
    return this.admission(async () => {
      const run = await this.runs.resume(actor, runId, { retryUnknown })
      return this.launchAdmitted(exec, actor, run)
    })
  }

  /**
   * Adopt author text for one dimension without a model call. Refused while the novel has a running or interrupted run,
   * checked again inside the publishing update so no unfinished run can have its settings replaced underneath it.
   * @param exec - Importing native tool. @param request - Exact head to replace and the complete document. @returns The adopted, pendingReview import.
   */
  async importSettings(exec: ToolExecution, request: Omit<ImportSettingsRequest, 'childSessionId'>): Promise<SettingsCandidateView> {
    const actor = await writingActor(this.ctx, exec)
    if (this.closed) throw new RunStoreError('runner-closed', 'The writing runner is closed')
    const unfinished = () => {
      const holder = this.runs.list(actor, request.novelId).find(run => run.status === 'running' || run.status === 'interrupted')
      if (holder !== undefined) {
        throw new ImportRefusedError('run-active', `Settings cannot be imported while the novel has a running or interrupted writing run (${holder.id}); stop it first`, [], holder.id)
      }
    }
    unfinished()
    return this.service.importSettings(actor, { ...request, childSessionId: actor.sessionId }, unfinished)
  }

  /** @param exec - Owning workspace tool. @param runId - Exact run to stop. @returns Persisted stopped state after native child disposal. */
  async stop(exec: ToolExecution, runId: RunId): Promise<WritingRun> {
    const actor = await writingActor(this.ctx, exec)
    const run = this.runs.get(actor, runId)
    const active = this.active.get(runId)
    if (active === undefined) {
      if (run.status !== 'running' && run.status !== 'interrupted') return run
      return this.runs.finish(actor, runId, 'stopped', 'Stopped by the author.')
    }
    active.controller.abort(new Error('Stopped by the author.'))
    await active.done
    return this.runs.get(actor, runId)
  }

  /** @returns After all owned native work has quiesced; stores close separately. */
  async close(): Promise<void> {
    this.closed = true
    const active = [...this.active.values()]
    for (const run of active) run.controller.abort(new Error('Writing plugin is closing.'))
    for (const controller of this.replayControllers) controller.abort(this.replayShutdown)
    const settled = await Promise.allSettled([...this.admissions, ...active.map(run => run.done)])
    const failures = settled.flatMap(result => result.status === 'rejected' && result.reason !== this.replayShutdown ? [result.reason as unknown] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Writing runs could not finish shutdown')
  }

  /**
   * New requests must select every required novel dimension (catalog requiredFor: novel_writing) in their settingsRoots
   * closure before any settings, outline or chapter work starts, unless the operator set allowIncompleteSettings in the plugin config.
   * A resume is re-gated too, so runs admitted with incomplete settings cannot continue unless the operator bypass is set.
   * A completed run is not gated (`gated` false): it cannot resume anyway and keeps the run store's run-state refusal.
   */
  /** @param resuming - The resumed run's id, or null for a new request. */
  private admit(actor: Actor, input: Pick<BeginRunInput, 'novelId' | 'briefArtifactId' | 'settingsRoots' | 'mode'>, resuming: RunId | null = null, gated = true): void {
    if (this.closed) throw new RunStoreError('runner-closed', 'The writing runner is closed')
    const novel = this.service.getNovel(actor, input.novelId)
    // In admit, before the settings gate: a mismatched brief is revision-conflict, the same kind main uses.
    // Resume compares the run's stored brief and does not ask the caller for briefArtifactId.
    // A matching completed run still fails later as run-state.
    if (novel.brief.id !== input.briefArtifactId) {
      throw new WritingError('revision-conflict', resuming
        ? "This run's creative brief is no longer current; start story_update with the current briefArtifactId"
        : 'briefArtifactId must name the current creative brief')
    }
    if (gated && this.options.allowIncompleteSettings !== true) {
      const missing = missingRequiredSettings(input.settingsRoots)
      // T4: a resume refused here would also be refused by requirePendingImportsReviewed; report both in one error. The check order is unchanged.
      if (missing.length > 0) throw new SettingsIncompleteError(missing, resuming === null ? [] : this.pendingImports(actor, input), resuming ?? undefined)
    }
    planSettings(input.settingsRoots)
    if (input.mode === 'write' && resuming === null) {
      const settings = this.service.getSettings(actor, input.novelId)
      const manuscript = this.service.getManuscript(actor, input.novelId)
      if (settings.applied.some(item => item.stale) || manuscript.heads.some(item => item.stale) || manuscript.appliedChapters.some(item => item.stale)) {
        throw new WritingError('revision-conflict', 'Upstream versions changed; request an explicit downstream update')
      }
    }
  }

  /** A resumed run would replay its own earlier settings collection and never review an import; a new story_update reviews it. */
  private requirePendingImportsReviewed(actor: Actor, run: WritingRun): void {
    const pending = this.pendingImports(actor, run)
    if (pending.length > 0) throw new ImportRefusedError('pending-review', `Imported settings await a consistency review (${pending.map(item => item.dimensionCode).join(', ')}); run ${run.id} cannot resume. Stop it if needed and start a new story_update to review them`, pending, run.id)
  }

  /** Current heads in the run's settingsRoots closure that are imports awaiting a collection review. */
  private pendingImports(actor: Actor, run: Pick<WritingRun, 'novelId' | 'settingsRoots'>): readonly ImportItem[] {
    const selected = new Set(planSettings(run.settingsRoots).selectedCodes)
    return this.service.getSettings(actor, run.novelId).applied.filter(item => item.pendingReview && selected.has(item.dimensionCode)).map(importItem)
  }

  /**
   * The single stop rule for imported text: cross-dimension repair regenerates every selected dimension (all-or-nothing), so a
   * blocking collection review stops the run when any selected current head is an import, pending or released. Imported author
   * text is never silently replaced by a model regeneration. Narrowing this to pending imports only is a one-line change here.
   */
  private importsBlockingRegeneration(inv: Invocation): readonly ImportItem[] {
    const selected = new Set(planSettings(inv.run.settingsRoots).selectedCodes)
    return this.service.getSettings(inv.actor, inv.run.novelId).applied.filter(item => item.origin === 'import' && selected.has(item.dimensionCode)).map(importItem)
  }

  /**
   * Round 0 regenerates every selected dimension that is stale or missing, so an import that is stale, or sits downstream of a
   * dimension that would be regenerated, would be replaced by model text before any review. Stop before the first generation.
   */
  private stopOnStaleImport(inv: Invocation): void {
    const plan = planSettings(inv.run.settingsRoots)
    const applied = new Map(this.service.getSettings(inv.actor, inv.run.novelId).applied.map(item => [item.dimensionCode, item]))
    const regenerated = (code: string): boolean => { const item = applied.get(code); return item === undefined || item.stale }
    const items = plan.selectedCodes.flatMap(code => {
      const item = applied.get(code)
      return item?.origin === 'import' && planSettings([code]).selectedCodes.some(regenerated) ? [importItem(item)] : []
    })
    if (items.length > 0) throw new ImportReviewBlockedError(items, 'stale-import')
  }

  private stopOnBlockedImport(inv: Invocation): void {
    const items = this.importsBlockingRegeneration(inv)
    if (items.length > 0) throw new ImportReviewBlockedError(items)
  }

  private serviceLimits(): RunServiceLimits {
    return { ...this.service.limits, ...this.service.researchLimits }
  }

  /**
   * The resume limits comparison: the seven service limits, the two chapter-word bounds and, as the tenth item,
   * aiToneBlocking. Runs before prompt version 5 never recorded the switch and compare as off, so they resume under any
   * current setting and keep advisory AI tone; a version-5 run without the recorded value is corrupt and is refused.
   * A refusal names every differing key ({@link RunLimitsError}).
   */
  private requireRunLimits(run: WritingRun): void {
    const bounds = this.service.manuscriptLimits
    const current = this.serviceLimits()
    const mismatched: RunLimitMismatch[] = []
    for (const key of Object.keys(current) as (keyof RunServiceLimits)[]) {
      const saved = run.serviceLimits?.[key] ?? null
      if (saved !== current[key]) mismatched.push({ key, saved, current: current[key] })
    }
    for (const key of ['minChapterWords', 'maxChapterWords'] as const) if (run.executionLimits[key] !== bounds[key]) mismatched.push({ key, saved: run.executionLimits[key], current: bounds[key] })
    if (promptVersionOf(run) >= 5 && aiToneBlockingOf(run) !== this.aiToneBlocking) mismatched.push({ key: 'aiToneBlocking', saved: aiToneBlockingOf(run), current: this.aiToneBlocking })
    if (mismatched.length > 0) throw new RunLimitsError(mismatched)
  }

  /** The deployment's switch for new runs; the plugin config default is on. */
  private get aiToneBlocking(): boolean { return this.limits.aiToneBlocking ?? true }

  /**
   * The host's AI-tone decision for one reviewed body, made in code (the reviewer files every style issue as advisory, which
   * admission enforces). The same detector as the review's task.aiToneMarkers runs on the body's narration view; a quote of
   * a style issue whose id starts with "ai-tone" blocks only when one of its verbatim occurrences in that narration fully
   * covers a detector hit. Quotes inside dialogue, commentary words that do not open a paragraph and connectives that do not
   * open a sentence therefore never block. An AI-tone issue without such a quote, or one the host downgraded because its
   * evidence was found nowhere, stays a recorded advisory finding. One covered hit is enough for every rule, including a
   * single dash or 、 enumeration (no density threshold; decided by the user 2026-10-20). Inactive unless the run froze aiToneBlocking on (prompt
   * version 5+) and the review received host markers.
   * @returns The blocking spans with the identities of the hits each covers (for repeat detection), and the body's text.
   */
  private aiToneGate(inv: Invocation, candidate: ManuscriptCandidateView): { readonly spans: ReadonlyMap<string, readonly string[]>; readonly body: string } | null {
    if (candidate.target.kind !== 'body' || candidate.review === null || candidate.aiTone === null || !aiToneBlockingOf(inv.run)) return null
    const body = proseView('body', this.service.getArtifact(inv.actor, { novelId: inv.run.novelId, artifactId: candidate.artifact.id }).text)
    const { narration, hits } = aiToneHits(body)
    const review = JSON.parse(this.service.getArtifact(inv.actor, { novelId: inv.run.novelId, artifactId: candidate.review.id }).text) as { issues: readonly { id: string; category: string; evidence: readonly { artifactId: string; quote: string }[]; hostDowngrade?: unknown }[] }
    const spans = new Map<string, string[]>()
    for (const issue of review.issues) {
      if (issue.category !== 'style' || !issue.id.startsWith(AI_TONE_ISSUE_PREFIX) || issue.hostDowngrade !== undefined) continue
      for (const { artifactId, quote } of issue.evidence) {
        if (artifactId !== candidate.artifact.id || quote.trim().length === 0) continue
        const covered = coveredHits(narration, quote, hits)
        if (covered.length === 0) continue
        spans.set(quote, [...new Set([...spans.get(quote) ?? [], ...covered.flatMap(hit => hit.keys)])])
      }
    }
    return { spans, body }
  }

  /** Mark the latest admitted review of this candidate as AI-tone blocked, so the block is visible on the stored run record. */
  private async markAiToneBlock(inv: Invocation, stageKey: string, block: AiToneBlockRecord): Promise<void> {
    const review = this.runs.get(inv.actor, inv.run.id).attempts.findLast(attempt => attempt.key.startsWith(`${stageKey}/review/`) && attempt.status === 'succeeded')
    if (review !== undefined) await this.runs.recordAiToneBlock(inv.actor, inv.run.id, review.id, { reason: block.reason, spans: block.spans.slice(0, 20) })
  }

  private requirePresentation(exec: ToolExecution): void {
    if (this.ctx.tools.get('present', exec.agent) === undefined) throw new Error('Writing requires the native present tool in this Agent scope')
  }

  private admission(work: () => Promise<WritingRun>): Promise<WritingRun> {
    const result = Promise.resolve().then(work).finally(() => { this.admissions.delete(result) })
    this.admissions.add(result)
    return result
  }

  private async launchAdmitted(exec: ToolExecution, actor: Actor, run: WritingRun): Promise<WritingRun> {
    if (this.closed) return run.status === 'running' ? this.runs.finish(withoutSignal(actor), run.id, 'stopped', 'Writing plugin is closing.') : run
    if (run.status !== 'running') {
      if (run.status === 'completed') {
        const controller = new AbortController()
        const signal = AbortSignal.any([exec.signal, controller.signal])
        this.replayControllers.add(controller)
        try { await this.deliverRetained({ ...exec, signal }, { ...actor, signal }, run) }
        catch (cause) { controller.signal.throwIfAborted(); throw cause }
        finally { this.replayControllers.delete(controller) }
      }
      return run
    }
    return this.launch(exec, actor, run)
  }

  private launch(exec: ToolExecution, actor: Actor, run: WritingRun): Promise<WritingRun> {
    const existing = this.active.get(run.id)
    if (existing !== undefined) return existing.done
    const controller = new AbortController()
    const signal = AbortSignal.any([exec.signal, controller.signal])
    const invocation: Invocation = { actor: { ...actor, signal }, exec: { ...exec, signal }, run, controller }
    const done = Promise.resolve().then(() => this.execute(invocation)).finally(() => { this.active.delete(run.id) })
    this.active.set(run.id, { controller, done })
    return done
  }

  private async execute(inv: Invocation): Promise<WritingRun> {
    try {
      if (inv.run.mode === 'revise') {
        await this.revision(inv)
        return await this.runs.finish(inv.actor, inv.run.id, 'completed')
      }
      await this.settings(inv)
      await this.standalone(inv, { kind: 'book-outline', chapterCount: inv.run.chapterCount })
      for (let chapterNumber = inv.run.fromChapter; chapterNumber <= inv.run.throughChapter; chapterNumber++) {
        inv.actor.signal?.throwIfAborted()
        const existing = this.service.getManuscript(inv.actor, inv.run.novelId).appliedChapters.find(item => item.chapterNumber === chapterNumber)
        if (existing !== undefined && !existing.stale) {
          await this.standalone(inv, { kind: 'chapter-outline', chapterNumber })
          await this.deliver(inv, existing.body)
          continue
        }
        await this.standalone(inv, { kind: 'chapter-outline', chapterNumber })
        const body = await this.generated(inv, { kind: 'body', chapterNumber })
        const continuity = await this.generated(inv, { kind: 'continuity', chapterNumber, bodyId: body.artifact.id })
        if (body.review === null || continuity.review === null) throw new WritingError('review-blocked', 'Both chapter documents need exact passing reviews')
        await this.service.applyChapter(inv.actor, { novelId: inv.run.novelId, bodyId: body.artifact.id, bodyReviewId: body.review.id,
          continuityId: continuity.artifact.id, continuityReviewId: continuity.review.id,
          expectedBodyId: existing?.body.id ?? null, expectedContinuityId: existing?.continuity.id ?? null })
      }
      const final = this.service.getManuscript(inv.actor, inv.run.novelId)
      for (let chapter = inv.run.fromChapter; chapter <= inv.run.throughChapter; chapter++) {
        if (!final.appliedChapters.some(item => item.chapterNumber === chapter && !item.stale)) throw new WritingError('review-blocked', 'Requested chapter range is not completely applied')
      }
      return await this.runs.finish(inv.actor, inv.run.id, 'completed')
    } catch (cause) {
      const actor = withoutSignal(inv.actor)
      return this.runs.finish(actor, inv.run.id, inv.exec.signal.aborted ? 'stopped' : 'failed', message(cause))
    }
  }

  private async revision(inv: Invocation): Promise<void> {
    const revision = inv.run.revision
    if (revision === null) throw new RunStoreError('invalid-input', 'Revision run has no author instructions')
    const settings = this.service.getSettings(inv.actor, inv.run.novelId)
    const manuscript = this.service.getManuscript(inv.actor, inv.run.novelId)
    const ownChildren = new Set(this.runs.get(inv.actor, inv.run.id).attempts.map(attempt => attempt.childSessionId))
    const applied = [...settings.applied, ...manuscript.heads].find(item => item.revisionOf === revision.baseArtifactId && ownChildren.has(item.childSessionId) && !item.stale)
    if (applied !== undefined) { await this.deliver(inv, applied.artifact); return }
    const dimension = settings.applied.find(item => item.artifact.id === revision.baseArtifactId)
    if (dimension !== undefined) {
      await this.dimension(inv, dimension.dimensionCode, 0, [], revision)
      return
    }
    const base = manuscript.heads.find(item => item.artifact.id === revision.baseArtifactId)
    if (base === undefined || (base.target.kind !== 'book-outline' && base.target.kind !== 'chapter-outline')) throw new WritingError('revision-conflict', 'baseArtifactId must be the current applied settings dimension or outline')
    const candidate = await this.generated(inv, base.target, revision)
    if (candidate.review === null) throw new WritingError('review-blocked', 'Upstream revision requires a passing review')
    await this.service.applyManuscriptCandidate(inv.actor, { novelId: inv.run.novelId, candidateId: candidate.artifact.id, reviewId: candidate.review.id, expectedAppliedId: revision.baseArtifactId })
  }

  private async settings(inv: Invocation): Promise<void> {
    const plan = planSettings(inv.run.settingsRoots)
    const head = this.head(inv, { kind: 'settings', selectedCodes: [...plan.selectedCodes] })
    if (head !== undefined && !head.stale && head.target.kind === 'settings' && equalCodes(head.target.selectedCodes, plan.selectedCodes)) {
      await this.deliver(inv, head.artifact)
      return
    }
    this.stopOnStaleImport(inv)
    let feedback: ArtifactRef[] = []
    for (let round = 0; round <= inv.run.executionLimits.maxRepairAttempts; round++) {
      const previousReview = this.runs.get(inv.actor, inv.run.id).attempts.findLast(attempt => attempt.key.startsWith(`settings/collection/${round}/review`) && attempt.status === 'succeeded')
      if (previousReview !== undefined) {
        const output = StageOutputSchemas.review.safeParse(JSON.parse(this.runs.readOutput(inv.actor, inv.run.id, previousReview.id).text))
        if (output.success && output.data.issues.some(issue => issue.severity === 'blocking')) {
          const rejected = this.service.getManuscript(inv.actor, inv.run.novelId).history.find(item => item.artifact.id === output.data.reviewed.artifactId)
          if (rejected !== undefined && rejected.review !== null) {
            const saved = this.service.getArtifact(inv.actor, { novelId: inv.run.novelId, artifactId: rejected.review.id })
            if (isDeepStrictEqual(JSON.parse(saved.text), output.data)) {
              this.stopOnBlockedImport(inv)
              await this.deliver(inv, rejected.artifact)
              feedback = this.feedback(rejected)
              continue
            }
          }
        }
      }
      for (const layer of plan.layers) {
        for (let offset = 0; offset < layer.length; offset += inv.run.executionLimits.maxParallelStages) {
          const results = await Promise.allSettled(layer.slice(offset, offset + inv.run.executionLimits.maxParallelStages).map(code => this.dimension(inv, code, round, feedback)))
          const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
          if (failures.length > 0) throw new AggregateError(failures, 'A settings layer could not complete')
        }
      }
      const candidate = await this.service.assembleSettings(inv.actor, { novelId: inv.run.novelId, selectedCodes: inv.run.settingsRoots, requestId: requestId(inv.run, `settings/collection/${round}`) })
      await this.deliver(inv, candidate.artifact)
      const reviewed = await this.reviewManuscript(inv, `settings/collection/${round}`, candidate, ['completeness', 'consistency'])
      if (reviewed.status !== 'blocked' && reviewed.review !== null) {
        await this.service.applyManuscriptCandidate(inv.actor, { novelId: inv.run.novelId, candidateId: reviewed.artifact.id, reviewId: reviewed.review.id, expectedAppliedId: head?.artifact.id ?? null })
        return
      }
      this.stopOnBlockedImport(inv)
      feedback = this.feedback(reviewed)
    }
    throw new WritingError('review-blocked', 'Settings cross-dimension repair limit was exhausted')
  }

  private async dimension(inv: Invocation, code: string, round: number, crossFeedback: ArtifactRef[], revision?: NonNullable<WritingRun['revision']>): Promise<void> {
    const old = this.service.getSettings(inv.actor, inv.run.novelId).applied.find(item => item.dimensionCode === code)
    const key = revision === undefined ? `settings/${round}/${code}` : `revision/${revision.baseArtifactId}/settings/${code}`
    const completed = this.runs.get(inv.actor, inv.run.id).attempts.some(attempt => attempt.key.startsWith(`${key}/candidate/`) && attempt.childSessionId === old?.childSessionId)
    if (old !== undefined && !old.stale && revision === undefined && (round === 0 || completed)) return
    const dimension = settingsCatalog.find(item => item.code === code)
    if (dimension === undefined) throw new Error(`Settings dimension is missing: ${code}`)
    const brief = this.service.getNovel(inv.actor, inv.run.novelId).brief
    const dependencies = this.service.getSettings(inv.actor, inv.run.novelId).applied.filter(item => dimension.dependsOn.includes(item.dimensionCode)).map(item => item.artifact)
    const research = await this.research(inv, `${key}/research`, uniqueRefs([brief, ...dependencies, ...(revision === undefined ? [] : [this.service.getArtifact(inv.actor, { novelId: inv.run.novelId, artifactId: revision.baseArtifactId })])]), `Establish the evidence needed for settings dimension ${code}: ${JSON.stringify(dimension)}`, { kind: 'settings', dimensionCode: code, catalog: dimension, revisionInstructions: revision?.instructions ?? null })
    const refs = this.service.settingsInputs(inv.actor, inv.run.novelId, code, research.planId, revision?.baseArtifactId)
    let feedback = crossFeedback
    let validationError: string | null = null
    for (let repair = 0; repair <= inv.run.executionLimits.maxRepairAttempts; repair++) {
      const stageKey = `${key}/candidate/${repair}`
      const stage = await this.stage(inv, stageKey, 'settings', refs, { dimensionCode: code, catalog: dimension, revisionInstructions: revision?.instructions, validationError }, feedback, dimension.kind)
      let candidate: SettingsCandidateView
      try {
        candidate = await this.service.saveSettingsCandidate(inv.actor, { novelId: inv.run.novelId, requestId: requestId(inv.run, stageKey), dimensionCode: code,
          researchPlanId: research.planId, childSessionId: stage.childSessionId, output: stage.structured, ...(revision === undefined ? {} : { revisionOf: revision.baseArtifactId }) })
      } catch (cause) {
        if (!isOutputError(cause)) throw cause
        validationError = cause.message
        continue
      }
      candidate = await this.reviewLoop(inv, stageKey, candidate, ['completeness', 'consistency'], (review, reviewKey) =>
        this.service.saveSettingsReview(inv.actor, { novelId: inv.run.novelId, candidateId: candidate.artifact.id, requestId: requestId(inv.run, reviewKey),
          expectedReviewId: null, childSessionId: review.childSessionId, output: review.structured }))
      if (candidate.status !== 'blocked' && candidate.review !== null) {
        await this.service.applySettingsCandidate(inv.actor, { novelId: inv.run.novelId, candidateId: candidate.artifact.id, reviewId: candidate.review.id, expectedAppliedId: old?.artifact.id ?? null })
        return
      }
      feedback = [...crossFeedback, ...this.feedback(candidate)]
    }
    throw new WritingError('review-blocked', `Settings repair limit was exhausted for ${code}${validationError === null ? '' : `: ${validationError}`}`)
  }

  private async standalone(inv: Invocation, target: Extract<GeneratedManuscriptTarget, { kind: 'book-outline' | 'chapter-outline' }>): Promise<void> {
    const current = this.head(inv, target)
    if (current !== undefined && !current.stale && (target.kind !== 'book-outline' || (current.target.kind === 'book-outline' && current.target.chapterCount === target.chapterCount))) { await this.deliver(inv, current.artifact); return }
    const candidate = await this.generated(inv, target)
    if (candidate.review === null) throw new WritingError('review-blocked', 'Manuscript needs an exact passing review')
    await this.service.applyManuscriptCandidate(inv.actor, { novelId: inv.run.novelId, candidateId: candidate.artifact.id, reviewId: candidate.review.id, expectedAppliedId: current?.artifact.id ?? null })
  }

  private async generated(inv: Invocation, target: GeneratedManuscriptTarget, revision?: NonNullable<WritingRun['revision']>): Promise<ManuscriptCandidateView> {
    const key = revision === undefined ? targetKey(target) : `revision/${revision.baseArtifactId}/${targetKey(target)}`
    const sourceRefs = this.service.manuscriptResearchInputs(inv.actor, { novelId: inv.run.novelId, target, ...(revision === undefined ? {} : { revisionOf: revision.baseArtifactId }) })
    const research = await this.research(inv, `${key}/research`, sourceRefs, `Resolve evidence needed for ${JSON.stringify(target)}.`, { ...target, revisionInstructions: revision?.instructions ?? null })
    const context = this.service.manuscriptInputs(inv.actor, { novelId: inv.run.novelId, target, researchPlanId: research.planId, ...(revision === undefined ? {} : { revisionOf: revision.baseArtifactId }) })
    let feedback: ArtifactRef[] = []
    let repairMode: RepairMode | undefined
    let validationError: string | null = null
    // AI-tone gate state (body, prompt version 5, aiToneBlocking on): the previous reviewed round's blocking spans and body text.
    let previousAiTone: { readonly hitKeys: ReadonlySet<string>; readonly body: string } | null = null
    let aiToneSpans: string[] = []
    for (let repair = 0; repair <= inv.run.executionLimits.maxRepairAttempts; repair++) {
      const stageKey = `${key}/candidate/${repair}`
      aiToneSpans = []
      const result = await this.stage(inv, stageKey, target.kind, context.inputRefs,
        { ...target, sceneIds: context.sceneIds, obligations: context.obligations, requiredChecks: context.requiredChecks, revisionInstructions: revision?.instructions, validationError }, feedback,
        undefined, undefined, undefined, repairMode)
      let candidate: ManuscriptCandidateView
      try {
        candidate = await this.service.saveManuscriptCandidate(inv.actor, { novelId: inv.run.novelId, target, researchPlanId: research.planId,
          requestId: requestId(inv.run, stageKey), childSessionId: result.childSessionId, output: result.structured, ...(revision === undefined ? {} : { revisionOf: revision.baseArtifactId }) })
      } catch (cause) {
        if (!isOutputError(cause)) throw cause
        validationError = cause.message
        continue
      }
      await this.deliver(inv, candidate.artifact)
      const reviewed = await this.reviewManuscript(inv, stageKey, candidate, context.requiredChecks)
      const unfulfilled = target.kind === 'continuity' ? StageOutputSchemas.continuity.parse(result.structured).obligations.filter(item => item.status !== 'fulfilled') : []
      const incomplete = unfulfilled.length > 0
      const gate = this.aiToneGate(inv, reviewed)
      aiToneSpans = [...gate?.spans.keys() ?? []]
      if (gate !== null && aiToneSpans.length > 0) {
        // A repair that leaves a reported instance in place (the same detector hit, identified by its surrounding narration,
        // whatever span length the reviewer quotes), or returns the body unchanged, would only spend attempts: stop for a human.
        if (previousAiTone !== null) {
          const prior = previousAiTone
          const repeated = gate.body === prior.body ? aiToneSpans : aiToneSpans.filter(span => (gate.spans.get(span) ?? []).some(hitKey => prior.hitKeys.has(hitKey)))
          if (repeated.length > 0) {
            await this.markAiToneBlock(inv, stageKey, { reason: 'ai-tone-repeat', spans: repeated })
            throw new AiToneReviewBlockedError('ai-tone-repeat', repeated, key)
          }
        }
        previousAiTone = { hitKeys: new Set([...gate.spans.values()].flat()), body: gate.body }
        const last = repair === inv.run.executionLimits.maxRepairAttempts
        await this.markAiToneBlock(inv, stageKey, { reason: !last ? 'ai-tone' : repair === 0 ? 'ai-tone' : 'ai-tone-exhausted', spans: aiToneSpans })
      } else previousAiTone = null
      if (reviewed.status !== 'blocked' && reviewed.review !== null && reviewed.length?.blocking !== true && !incomplete && aiToneSpans.length === 0) return reviewed
      if (aiToneSpans.length > 0) { validationError = `${reviewed.status === 'blocked' ? 'Resolve the blocking issues in the exact supplied review. ' : ''}${aiToneRepairInstruction(aiToneSpans)}`; repairMode = 'review' }
      else if (incomplete) { validationError = `Every required event for this chapter must be fulfilled by the actual reviewed prose: not fulfilled ${unfulfilled.map(item => `${item.id} (${item.status})`).join(', ')}.`; repairMode = 'review' }
      else if (reviewed.length?.blocking) { validationError = lengthRepairError(reviewed.wordCount, reviewed.length.status, StageOutputSchemas.body.parse(result.structured), inv.run.executionLimits); repairMode = 'length' }
      else { validationError = 'Resolve the blocking issues in the exact supplied review.'; repairMode = 'review' }
      feedback = this.feedback(reviewed)
    }
    // Never auto-pass: a body still carrying blocking AI tone when repairs run out ends review-blocked and is not applied.
    if (aiToneSpans.length > 0) throw new AiToneReviewBlockedError(inv.run.executionLimits.maxRepairAttempts === 0 ? 'ai-tone' : 'ai-tone-exhausted', aiToneSpans, key)
    throw new WritingError('review-blocked', `Repair limit was exhausted for ${key}${validationError === null ? '' : `: ${validationError}`}`)
  }

  private async reviewManuscript(inv: Invocation, key: string, candidate: ManuscriptCandidateView, requiredChecks: readonly ReviewCategory[]): Promise<ManuscriptCandidateView> {
    return this.reviewLoop(inv, key, candidate, requiredChecks, (result, reviewKey) => this.service.saveManuscriptReview(inv.actor, {
      novelId: inv.run.novelId, candidateId: candidate.artifact.id, expectedReviewId: null,
      requestId: requestId(inv.run, reviewKey), childSessionId: result.childSessionId, output: result.structured }))
  }

  /**
   * Review admission with host repair. A rejection whose only defect is evidence ({@link EvidenceRejection}) is repaired by
   * a citation-only stage that rewrites just the unresolved items' evidence and keeps every accepted item untouched;
   * any other rejection asks for a whole new review. Both share maxRepairAttempts. Each admitted or rejected attempt
   * durably records the host evidence repairs and drops reported during its admission.
   */
  private async reviewLoop<T extends SettingsCandidateView | ManuscriptCandidateView>(inv: Invocation, key: string, candidate: T, requiredChecks: readonly ReviewCategory[], save: (result: CapturedStage, reviewKey: string) => Promise<T>): Promise<T> {
    if (candidate.review !== null) return candidate
    if ('length' in candidate && candidate.length?.blocking) return candidate
    let validationError: string | null = null
    let pending: { prior: unknown; rejection: EvidenceRejection; repairError: string | null } | null = null
    for (let repair = 0; repair <= inv.run.executionLimits.maxRepairAttempts; repair++) {
      const reviewKey = pending === null ? `${key}/review/${repair}` : `${key}/review/${repair}/citations`
      let result: CapturedStage
      if (pending === null) result = await this.reviewStage(inv, reviewKey, candidate, requiredChecks, validationError)
      else {
        const repaired = await this.citationRepairStage(inv, reviewKey, candidate, pending.prior, pending.rejection, pending.repairError)
        try { result = { ...repaired, structured: mergeCitationRepair(pending.prior, pending.rejection.unresolved, repaired.structured) } }
        catch (cause) {
          if (!isOutputError(cause)) throw cause
          pending = { prior: pending.prior, rejection: pending.rejection, repairError: cause.message }
          validationError = cause.message
          continue
        }
      }
      const { result: saved, repairs } = await collectQuoteRepairs(() => save(result, reviewKey))
      await this.runs.recordEvidenceEvents(inv.actor, inv.run.id, result.attempt.id, repairs)
      if (saved.status === 'rejected') {
        const cause: unknown = saved.reason
        if (!isOutputError(cause)) throw cause
        validationError = cause.message
        pending = cause instanceof EvidenceRejection ? { prior: result.structured, rejection: cause, repairError: null } : null
        continue
      }
      const reviewed = saved.value
      if (reviewed.review === null) throw new WritingError('corrupt-artifact', 'Saved stage review has no artifact')
      return reviewed
    }
    throw new WritingError('review-blocked', `Review output repair limit was exhausted: ${validationError}`)
  }

  private async citationRepairStage(inv: Invocation, key: string, candidate: SettingsCandidateView | ManuscriptCandidateView, prior: unknown, rejection: EvidenceRejection, repairError: string | null): Promise<CapturedStage> {
    const refs = uniqueRefs([...candidate.inputRefs.map(ref => this.service.getArtifact(inv.actor, { novelId: inv.run.novelId, artifactId: ref.artifactId })), candidate.artifact])
    const prompt = buildCitationRepairPrompt({ novelId: inv.run.novelId, prior, unresolved: rejection.unresolved,
      inputs: refs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256, kind: ref.kind, chars: this.proseChars(inv, ref), view: 'prose' })) })
    return this.capture(inv, key, repairError === null ? prompt : `${prompt}\n\nThe previous citation repair was rejected: ${repairError}`, refs, CITATION_REPAIR_OUTPUT_SCHEMA, ['story_read_artifact'], undefined, 'prose')
  }

  private async reviewStage(inv: Invocation, key: string, candidate: SettingsCandidateView | ManuscriptCandidateView, requiredChecks: readonly ReviewCategory[], validationError: string | null): Promise<CapturedStage> {
    const refs = candidate.inputRefs.map(ref => this.service.getArtifact(inv.actor, { novelId: inv.run.novelId, artifactId: ref.artifactId }))
    const settingsDimensionKind = 'dimensionCode' in candidate ? settingsCatalog.find(item => item.code === candidate.dimensionCode)?.kind : undefined
    const settingsCollectionKinds = 'target' in candidate && candidate.target.kind === 'settings' ? collectionDimensionKinds(candidate.target.selectedCodes) : undefined
    // The reviewed candidate's own kind, so stage() can limit the host-owned chapter-total range to book-outline/chapter-outline/body and their reviews.
    const reviewedKind: StagePromptKind = 'dimensionCode' in candidate ? 'settings' : candidate.target.kind
    return this.stage(inv, key, 'review', refs, { reviewed: inputRef(candidate.artifact), requiredChecks, validationError,
      ...('length' in candidate ? { measuredWordCount: candidate.wordCount, measuredLength: candidate.length } : {}),
      // Version-1 runs keep their original task text; later runs hand the body review host-measured positions to cite.
      ...('beats' in candidate && candidate.beats !== null && promptVersionOf(inv.run) >= 2 ? { measuredBeats: candidate.beats } : {}),
      // Version 3 body reviews also get host-detected AI-tone markers in narration (advisory evidence only).
      ...('aiTone' in candidate && candidate.aiTone !== null && promptVersionOf(inv.run) >= 3 ? { aiToneMarkers: candidate.aiTone } : {}),
      ...(settingsDimensionKind === undefined ? {} : { dimensionKind: settingsDimensionKind }),
      ...(settingsCollectionKinds === undefined ? {} : { dimensionKinds: settingsCollectionKinds }) },
      [candidate.artifact], settingsDimensionKind, settingsCollectionKinds, reviewedKind)
  }

  private async research(inv: Invocation, key: string, refs: readonly ArtifactRef[], purpose: string, outputTarget: object) {
    const request = { novelId: inv.run.novelId, briefArtifactId: inv.run.briefArtifactId, purpose, inputs: refs,
      requestId: requestId(inv.run, key), parentSessionId: inv.actor.sessionId }
    const attempts = this.runs.get(inv.actor, inv.run.id).attempts
    const legacy = attempts.some(attempt => attempt.key === key) && !attempts.some(attempt => attempt.key === `${key}/planning`)
    const limits = this.service.researchLimits
    const necessity: ResearchNecessity | undefined = legacy ? undefined : await this.admitted(inv, 'Research planning', repair => repair === 0 ? `${key}/planning` : `${key}/planning/${repair}`,
      async (stageKey, validationError) => researchNecessity((await this.capture(inv, stageKey, buildResearchPlanningPrompt({ ...request, outputTarget }, limits, validationError), refs, RESEARCH_PLANNING_OUTPUT_SCHEMA, ['story_read_artifact'])).structured, limits))
    return this.admitted(inv, 'Research stage', repair => repair === 0 ? key : `${key}/repair/${repair}`, async (stageKey, validationError) => {
      const attempt = { ...request, requestId: requestId(inv.run, stageKey) }
      const scoped = necessity === undefined ? attempt : { ...attempt, necessity }
      const result = await this.capture(inv, stageKey, buildResearchPrompt(scoped, validationError), refs, RESEARCH_STAGE_OUTPUT_SCHEMA, researchStageTools(scoped), researchToolAuthorization(this.ctx, this.service, scoped))
      return validateResearchStageResult(this.ctx, inv.exec, this.service, { ...scoped, parentSessionId: result.attempt.parentSessionId }, result)
    })
  }

  /**
   * The output-admission repair loop for a stage with no business review: attempt n runs under keyOf(n) with the previous
   * rejection message, and only a {@link StageValidationRejection} is retried, within maxRepairAttempts. Attempt 0 receives
   * null, so its prompt stays byte-identical to the unrepaired stage and retained runs replay.
   */
  private async admitted<T>(inv: Invocation, label: string, keyOf: (repair: number) => string, attempt: (key: string, validationError: string | null) => Promise<T>): Promise<T> {
    let validationError: string | null = null
    for (let repair = 0; repair <= inv.run.executionLimits.maxRepairAttempts; repair++) {
      try { return await attempt(keyOf(repair), validationError) }
      catch (cause) {
        if (!isOutputError(cause)) throw cause
        validationError = cause.message
      }
    }
    throw new WritingError('review-blocked', `${label} repair limit was exhausted: ${validationError}`)
  }

  private async stage(inv: Invocation, key: string, kind: StagePromptKind, refs: readonly ArtifactRef[], task: object, feedback: readonly ArtifactRef[],
    settingsDimensionKind?: SettingsDimensionKind, settingsCollectionKinds?: Readonly<Record<string, SettingsDimensionKind>>, reviewedKind?: StagePromptKind, repairMode?: RepairMode): Promise<CapturedStage> {
    const allRefs = uniqueRefs([...refs, ...feedback])
    // Chinese counting treats each CJK character as a word: stating the chapter-total range on a settings/continuity stage reads as "write N characters" and contradicts the classification bound. Only book-outline/chapter-outline/body actually assemble chapter prose that range measures, so only those (and reviews of them) get the line.
    const rangedKind = kind === 'review' ? reviewedKind : kind
    const includeChapterRange = rangedKind === 'book-outline' || rangedKind === 'chapter-outline' || rangedKind === 'body'
    // A review reads every input as reader-facing prose, so any quote it copies is checkable plain text, never JSON scaffolding.
    const prose = kind === 'review'
    const prompt = buildStagePrompt({ kind, novelId: inv.run.novelId,
      inputs: allRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256, kind: ref.kind, chars: prose ? this.proseChars(inv, ref) : ref.chars, ...(prose ? { view: 'prose' } : {}) })),
      task: JSON.stringify({ ...task, inputRefs: refs.map(inputRef) }), requirements: [
        ...(includeChapterRange ? [chapterRangeRequirement(kind, inv.run.executionLimits)] : []),
        ...(prose ? ['Every input is served as its reader-facing plain text (view "prose"): chapter text as its assembled scenes, structured documents as their prose values one per line, without field names or identifiers. totalChars refers to that text; sha256 still identifies the stored version. Quote only text exactly as served.'] : []),
        'If task.validationError is present, correct that explicit host validation failure and return the complete value; prior raw outputs remain saved in run history.',
        'Output inputRefs must exactly match TASK_DATA.task.inputRefs in order; additional candidate and review documents are evidence for inspection and repair.',
        // A length repair rescales every scene toward the aim, so it must not be told to keep unaffected passages; other repairs keep the documented-defects wording.
        ...(feedback.length > 0 && kind !== 'review' ? [repairMode === 'length'
          ? 'Condense or expand across all scenes to reach the aim; preserve required events, established facts and scene identities rather than passage wording.'
          : 'Repair the defects documented in the supplied prior candidate and review. Preserve unaffected facts and passages and return the entire candidate.'] : []),
      ], ...(settingsDimensionKind === undefined ? {} : { settingsDimensionKind }), ...(settingsCollectionKinds === undefined ? {} : { settingsCollectionKinds }),
      ...(kind === 'review' && reviewedKind !== undefined ? { reviewedKind } : {}), promptVersion: promptVersionOf(inv.run),
      ...(kind === 'review' && reviewedKind === 'body' && aiToneBlockingOf(inv.run) ? { aiToneBlocking: true } : {}) })
    return this.capture(inv, key, prompt, allRefs, nativeStageOutputSchema(kind, promptVersionOf(inv.run)), ['story_read_artifact'], undefined, prose ? 'prose' : 'stored')
  }

  private proseChars(inv: Invocation, ref: ArtifactRef): number { return this.service.proseChars(inv.actor, { novelId: inv.run.novelId, artifactId: ref.id }) }

  /**
   * A malformed structured_output call, or a child turn that ends without returning its structured result, retries
   * the exact same key and byte-identical prompt, never a successor key: prepareAttempt already permits replacing a
   * latest 'failed' attempt, so this keeps a later resume's replay deterministic (it recomputes the same key first and
   * finds the eventual success, no duplicate paid call). At most maxRepairAttempts automatic retries follow the first
   * execution; then the stage fails with an explicit exhaustion message. Every other stage outcome (success, or any
   * other failure) settles in exactly one prepareAttempt/executeStage pass.
   */
  private async capture(inv: Invocation, key: string, prompt: string, refs: readonly ArtifactRef[], outputSchema: object, allowedTools: readonly string[], authorizeTool?: StageRequest['authorizeTool'], readView: 'stored' | 'prose' = 'stored'): Promise<CapturedStage> {
    for (let retry = 0; ; retry++) {
      inv.actor.signal?.throwIfAborted()
      if (this.service.getNovel(inv.actor, inv.run.novelId).brief.id !== inv.run.briefArtifactId) throw new WritingError('revision-conflict', 'Creative brief changed during writing')
      let attempt = await this.runs.prepareAttempt(inv.actor, inv.run.id, { key, prompt, inputRefs: refs.map(inputRef), outputSchema })
      if (attempt.status === 'succeeded') {
        if (attempt.childSessionId === null) throw new RunStoreError('corrupt-run', 'Saved output has no native child')
        return { attempt, childSessionId: attempt.childSessionId, structured: JSON.parse(this.runs.readOutput(inv.actor, inv.run.id, attempt.id).text) as unknown }
      }
      if (attempt.status !== 'prepared') throw new RunStoreError('attempt-state', 'The native stage is already running or requires explicit recovery')
      let published = false
      let stopProse: (() => void) | undefined
      try {
        const result = await executeStage(this.ctx, inv.exec, { attemptId: attempt.id, prompt, outputSchema, ...(authorizeTool === undefined ? {} : { authorizeTool }),
          onStarted: async childSessionId => {
            published = true
            if (readView === 'prose') stopProse = this.service.serveProseTo(childSessionId)
            attempt = await this.runs.associateChild(inv.actor, inv.run.id, attempt.id, childSessionId)
          },
        }, { ...inv.run.executionLimits, allowedTools }).finally(() => stopProse?.())
        const text = JSON.stringify(result.structured)
        if (text === undefined) throw new Error('Native stage returned no serializable structured output')
        attempt = await this.runs.saveOutput(inv.actor, inv.run.id, attempt.id, text)
        return { ...result, attempt }
      } catch (cause) {
        // A malformed structured_output call, or a turn that ended without structured output, is a completed model call
        // with a known, unusable result, not an uncertain outcome.
        const retryable = cause instanceof StageExecutionError && (cause.code === 'stage-malformed' || cause.code === 'stage-missing-result')
        // A tool-scope refusal is a deterministic stage-boundary decision with no stage output, not an uncertain model outcome.
        const toolScope = cause instanceof StageExecutionError && cause.code === 'stage-tool-scope'
        // A provider refusal or an output-length cut-off is also a completed model call with a known, unusable result.
        // It is recorded with its explicit classification and not retried: an identical request would meet the same limit or policy.
        const kind = cause instanceof StageExecutionError ? failureKind(cause.code) : undefined
        const latest = this.runs.get(withoutSignal(inv.actor), inv.run.id).attempts.find(item => item.id === attempt.id)
        if (latest?.status === 'prepared' || latest?.status === 'running') {
          try { await this.runs.failAttempt(withoutSignal(inv.actor), inv.run.id, attempt.id, { outcome: retryable || toolScope || kind !== undefined || !published ? 'failed' : 'unknown', message: message(cause), ...(kind === undefined ? {} : { kind }) }) }
          catch (storageCause) { throw new AggregateError([cause, storageCause], 'Native stage failed and its outcome could not be recorded', { cause }) }
        }
        if (!retryable) throw cause
        if (retry < inv.run.executionLimits.maxRepairAttempts) continue
        const retries = inv.run.executionLimits.maxRepairAttempts
        throw new StageExecutionError(cause.code, `${cause.message}; stage ${key} failed after ${retries} automatic ${retries === 1 ? 'retry' : 'retries'}`, { cause })
      }
    }
  }

  private async deliver(inv: Invocation, artifact: ArtifactRef): Promise<void> {
    if (isReaderDocument(artifact)) await this.deliveries.publishArtifact(inv.exec, inv.run.id, inv.run.novelId, artifact.id)
  }

  private async deliverRetained(exec: ToolExecution, actor: Actor, run: WritingRun): Promise<void> {
    const children = new Set(run.attempts.map(attempt => attempt.childSessionId))
    const inputs = new Set(run.attempts.flatMap(attempt => attempt.inputRefs.map(ref => ref.artifactId)))
    const manuscript = this.service.getManuscript(actor, run.novelId).history.filter(candidate => candidate.childSessionId !== null && children.has(candidate.childSessionId)
      || candidate.target.kind === 'settings' && inputs.has(candidate.artifact.id))
    const artifacts: ArtifactRef[] = manuscript.map(candidate => candidate.artifact)
    const sessionIds = new Set([actor.sessionId, run.startedBy, run.lastResumedBy, ...run.attempts.map(attempt => attempt.parentSessionId)])
    for (const sessionId of sessionIds) {
      const session = this.ctx.sessions.get(sessionId)
      if (session === undefined) continue
      const projection = this.ctx.sessionProjections.stateOf(session, 'story-stage-deliveries')
      if (projection === undefined) throw new Error('Writing-stage delivery projection is unavailable')
      for (const delivery of projection.calls.flatMap(call => call.deliveries)) {
        if (delivery.runId !== run.id || delivery.source.kind !== 'artifact') continue
        artifacts.push(this.service.getArtifact(actor, { novelId: run.novelId, artifactId: parseArtifactId(delivery.source.artifactId) }))
      }
    }
    for (const artifact of uniqueRefs(artifacts).filter(isReaderDocument)) await this.deliveries.publishArtifact(exec, run.id, run.novelId, artifact.id)
  }

  private head(inv: Invocation, target: ManuscriptTarget): ManuscriptCandidateView | undefined {
    return this.service.getManuscript(inv.actor, inv.run.novelId).heads.find(item => item.target.kind === target.kind
      && (!('chapterNumber' in target) || ('chapterNumber' in item.target && item.target.chapterNumber === target.chapterNumber)))
  }
  private feedback(candidate: SettingsCandidateView | ManuscriptCandidateView): ArtifactRef[] {
    return candidate.review === null ? [candidate.artifact] : [candidate.artifact, candidate.review]
  }
}

/** @returns The hits fully covered by at least one verbatim occurrence of the quote in the narration view. */
function coveredHits<T extends { readonly start: number; readonly end: number }>(narration: string, quote: string, hits: readonly T[]): T[] {
  const covered = new Set<T>()
  for (let at = narration.indexOf(quote); at >= 0; at = narration.indexOf(quote, at + 1)) {
    for (const hit of hits) if (hit.start >= at && hit.end <= at + quote.length) covered.add(hit)
  }
  return [...covered]
}
function requestId(run: WritingRun, key: string) { return parseRequestId(`${run.id}:${createHash('sha256').update(key).digest('hex')}`) }
/** @returns The prompt version a run started with; runs stored before versioning are version 1. */
function promptVersionOf(run: WritingRun): PromptVersion { return run.promptVersion ?? 1 }
/**
 * @returns Whether body reviews of this run block on AI tone. Runs before prompt version 5 never recorded the switch and are
 * always off; a version-5 run without the recorded value is corrupt and is refused rather than treated as off.
 */
function aiToneBlockingOf(run: WritingRun): boolean {
  if (promptVersionOf(run) < 5) return false
  if (run.executionLimits.aiToneBlocking === undefined) throw new RunStoreError('corrupt-run', 'A prompt-version-5 run has no recorded aiToneBlocking setting; it cannot resume. Stop it and begin a new request')
  return run.executionLimits.aiToneBlocking
}
function inputRef(ref: ArtifactRef): StageInputRef { return { artifactId: ref.id, sha256: ref.sha256 } }
function withoutSignal(actor: Actor): Actor { return { sessionId: actor.sessionId, workspace: actor.workspace } }
function message(cause: unknown): string {
  if (cause instanceof AggregateError) return `${cause.message}: ${(cause.errors as unknown[]).map(message).join('; ')}`
  return cause instanceof Error ? cause.message : String(cause)
}
function targetKey(target: GeneratedManuscriptTarget): string { return `${target.kind}/${'chapterNumber' in target ? target.chapterNumber : 'book'}` }
function equalCodes(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((code, index) => right[index] === code) }
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Map(refs.map(({ id, kind, revision, sha256, chars, bytes }) => [id, { id, kind, revision, sha256, chars, bytes }])).values()]
}

/** @param code - Stage execution failure code. @returns The durable attempt classification for a refusal or a length cut-off. */
function failureKind(code: StageExecutionError['code']): AttemptFailureKind | undefined {
  if (code === 'stage-refused') return 'refused'
  if (code === 'stage-truncated') return 'truncated'
  return undefined
}
/** Only a host rejection of a model-produced value is repairable; provider, refusal, truncation, cancellation, store and integrity failures are not. */
function isOutputError(cause: unknown): cause is StageValidationRejection { return cause instanceof StageValidationRejection }
/** Every selected dimension's catalog kind, in catalog (code) order, for the assembled settings collection review. */
function collectionDimensionKinds(selectedCodes: readonly string[]): Readonly<Record<string, SettingsDimensionKind>> {
  return Object.fromEntries(selectedCodes.map(code => [code, settingsCatalog.find(item => item.code === code)?.kind]).filter((entry): entry is [string, SettingsDimensionKind] => entry[1] !== undefined))
}
/** The chapter-total range requirement. Only a body writing stage is given an aim: outlines plan their own per-chapter targets and reviews judge against the applied plan, so an aim there would contradict it. A review is told a host-measured count inside the range is not a length defect, since the host alone owns length findings. */
function chapterRangeRequirement(kind: StagePromptKind, limits: Pick<RunExecutionLimits, 'minChapterWords' | 'maxChapterWords'>): string {
  return `The accepted chapter-total range is ${limits.minChapterWords}–${limits.maxChapterWords} Story-counted words${kind === 'body' ? `; aim for about ${chapterAim(limits)}` : ''}. Story counting: each Chinese character counts as one word, each ASCII word or number counts as one word, and punctuation and whitespace count as zero.${kind === 'review' ? ' A host-measured count inside this range is not a length defect.' : ''}`
}
/** The midpoint of the accepted chapter-total range: the aim stated to a body stage and in a length repair. */
function chapterAim(limits: Pick<RunExecutionLimits, 'minChapterWords' | 'maxChapterWords'>): number { return Math.round((limits.minChapterWords + limits.maxChapterWords) / 2) }
/** Length repair guidance from the host's own measurement: the exact count, the accepted range, the overage, every scene's count from the same Story counter (separators add no words, so they sum to the count) and the aim. */
function lengthRepairError(wordCount: number | null, status: 'too-short' | 'too-long', body: BodyOutput, limits: Pick<RunExecutionLimits, 'minChapterWords' | 'maxChapterWords'>): string {
  if (wordCount === null) throw new WritingError('corrupt-artifact', 'A length-blocked body has no measured word count')
  const over = status === 'too-long'
  const scenes = body.scenes.map(scene => `${scene.sceneId} ${countStoryWords(scene.text)}`).join(', ')
  return `The host counted ${wordCount} Story-counted words (accepted ${limits.minChapterWords}–${limits.maxChapterWords}): ${over ? `${wordCount - limits.maxChapterWords} over the maximum` : `${limits.minChapterWords - wordCount} under the minimum`}. Scene counts: ${scenes}. Return the complete chapter at about ${chapterAim(limits)} words by ${over ? 'condensing' : 'expanding'} every scene proportionally; keep every required event, scene identity and the chapter's actual outcome.`
}

function isReaderDocument(artifact: ArtifactRef): boolean {
  return artifact.kind === 'settings' || artifact.kind === 'book-outline' || artifact.kind === 'chapter-outline' || artifact.kind === 'body'
}

function importItem(item: SettingsCandidateView): ImportItem { return { dimensionCode: item.dimensionCode, artifactId: item.artifact.id, pendingReview: item.pendingReview } }
