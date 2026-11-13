/** Manuscript version publication and reviewed adoption over one writing domain. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { planSettings } from './settings-plan.ts'
import { manuscriptTargetSchema, settingsCollectionSchema, type ManuscriptRecord } from './manuscript-records.ts'
import { paragraphsOfStoredCandidate } from './candidate-paragraphs.ts'
import { hasParagraphCitation } from './paragraphs.ts'
import { parseBodyOutput, parseBookOutlineOutput, parseChapterOutlineOutput, parseContinuityOutput, parseContinuitySnapshot, parseReviewOutput, StageOutputSchemas, type ReviewAdmission } from './stage-output.ts'
import { WritingError } from './contracts.ts'
import { checkModelArtifactBytes, parseModelOutput } from './stage-rejection.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { z } from 'zod'
import type { Actor, Artifact, ArtifactId, ArtifactRef, NovelId, RequestId } from './contracts.ts'
import { assembleBody, inspectBody, measureBeats } from './body-text.ts'
import { detectAiTone, type AiToneReport } from './ai-tone.ts'
import type { BodyBeats, BodyLengthResult, BodyWordBounds } from './body-text.ts'
import type { ReviewCategory, StageInputRef } from './stage-output.ts'
import type { AppliedChapterRecord } from './manuscript-records.ts'
import type { writingDomain, NovelRecord } from './records.ts'
import type { WritingService } from './service.ts'

/** Explicit chapter-total acceptance bounds owned by host configuration. */
export type ManuscriptLimits = BodyWordBounds
/** Exact stage scope; settings collections are assembled by the program. */
export type ManuscriptTarget = z.infer<typeof manuscriptTargetSchema>
/** Model-generated manuscript stage scope. */
export type GeneratedManuscriptTarget = Exclude<ManuscriptTarget, { kind: 'settings' }>
/** Versioned manuscript document kind. */
export type ManuscriptKind = ManuscriptTarget['kind']
/** Explicit selected roots for one deterministic settings collection. */
export interface AssembleSettingsRequest { readonly novelId: NovelId; readonly requestId: RequestId; readonly selectedCodes: readonly string[] }
/** Current inputs and mechanical expectations for one native stage invocation. */
export interface ManuscriptContext {
  readonly target: GeneratedManuscriptTarget
  readonly researchPlanId: ArtifactId
  readonly revisionOf: ArtifactId | null
  readonly inputRefs: readonly ArtifactRef[]
  readonly requiredChecks: readonly ReviewCategory[]
  readonly obligations: readonly { id: string; description: string }[]
  readonly sceneIds: readonly string[]
  /** Reviewed snapshots of applied chapters this stage may use. Empty when none are in scope. */
  readonly continuitySnapshots: readonly ArtifactRef<'continuity-snapshot'>[]
}
/** Exact applied chapter a snapshot is extracted from. `snapshotThrough` is the highest earlier chapter whose snapshot may be read. */
export interface SaveContinuitySnapshotRequest {
  readonly novelId: NovelId; readonly requestId: RequestId; readonly chapterNumber: number
  readonly bodyId: ArtifactId; readonly continuityId: ArtifactId; readonly childSessionId: SessionId
  readonly output: unknown; readonly snapshotThrough?: number
}
/** Attach one passing snapshot to the applied chapter pair it describes. */
export interface AttachContinuitySnapshotRequest {
  readonly novelId: NovelId; readonly chapterNumber: number; readonly bodyId: ArtifactId; readonly continuityId: ArtifactId
  readonly snapshotId: ArtifactId; readonly reviewId: ArtifactId
}
/** Exact generated version submitted by a native child run. */
export interface SaveManuscriptCandidateRequest {
  readonly novelId: NovelId; readonly requestId: RequestId; readonly target: GeneratedManuscriptTarget
  readonly childSessionId: SessionId; readonly output: unknown; readonly researchPlanId: ArtifactId; readonly revisionOf?: ArtifactId
  /** Highest earlier chapter whose reviewed snapshot may be an input. Omit to use every applied chapter before this one. */
  readonly snapshotThrough?: number
}
/** One candidate, its latest review, and validity of its original inputs. */
export interface ManuscriptCandidateView {
  readonly target: ManuscriptTarget; readonly artifact: ArtifactRef<ManuscriptKind>; readonly inputRefs: readonly StageInputRef[]
  readonly childSessionId: SessionId | null; readonly revisionOf: ArtifactId | null; readonly status: 'candidate' | 'reviewed' | 'blocked' | 'applied'
  readonly review: ArtifactRef<'review'> | null; readonly stale: boolean; readonly changedInputs: readonly StageInputRef[]
  readonly wordCount: number | null; readonly length: BodyLengthResult | null
  /** Host-measured scene and panel positions of a body candidate; null for every other kind. */
  readonly beats: BodyBeats | null
  /** Host-detected AI-tone markers in body narration (src/ai-tone.ts); null for other kinds. */
  readonly aiTone: AiToneReport | null
}
/** Exact candidate review with a latest-review compare-and-set precondition. */
export interface SaveManuscriptReviewRequest {
  readonly novelId: NovelId; readonly candidateId: ArtifactId; readonly requestId: RequestId; readonly expectedReviewId: ArtifactId | null
  readonly childSessionId: SessionId; readonly output: unknown
  /** Prompt version 8 model reviews. Readback and earlier prompt versions omit it. */
  readonly admission?: ReviewAdmission
}
/** Standalone settings or outline adoption with a current-head precondition. */
export interface ApplyManuscriptCandidateRequest {
  readonly novelId: NovelId; readonly candidateId: ArtifactId; readonly reviewId: ArtifactId; readonly expectedAppliedId: ArtifactId | null
  /** Adopt this review even though it still has this many blocking issues, because a later round did not reduce that count. */
  readonly convergence?: { readonly failCount: number }
}
/** Atomic publication of one reviewed body and its reviewed actual continuity. */
export interface ApplyChapterRequest {
  readonly novelId: NovelId; readonly bodyId: ArtifactId; readonly bodyReviewId: ArtifactId
  readonly continuityId: ArtifactId; readonly continuityReviewId: ArtifactId; readonly expectedBodyId: ArtifactId | null; readonly expectedContinuityId: ArtifactId | null
  /** Body review adopted because a later round did not reduce its blocking-issue count. */
  readonly bodyConvergence?: { readonly failCount: number }
  /** Continuity review adopted because a later round did not reduce its blocking-issue count. */
  readonly continuityConvergence?: { readonly failCount: number }
}
/** Current chapter application with mechanically recomputed count and source validity. */
export interface AppliedChapterView extends AppliedChapterRecord { readonly wordCount: number; readonly stale: boolean; readonly changedInputs: readonly StageInputRef[] }
/** Retained candidates, current standalone heads, and atomic chapter applications. */
export interface ManuscriptView {
  readonly history: readonly ManuscriptCandidateView[]; readonly heads: readonly ManuscriptCandidateView[]; readonly appliedChapters: readonly AppliedChapterView[]
}

/** Uses the writing service's existing domain and lifecycle; never opens another provider. */
export class ManuscriptStore {
  constructor(private readonly domain: Domain<typeof writingDomain>, private readonly owner: WritingService) {}

  /** @param actor - Owning workspace. @param request - Explicit selected settings roots. @returns An unreviewed immutable settings collection. */
  async assembleSettings(actor: Actor, request: AssembleSettingsRequest): Promise<ManuscriptCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const target = { kind: 'settings' as const, selectedCodes: [...planSettings(request.selectedCodes).selectedCodes] }
    const hash = digest(target)
    const replay = novel.manuscriptHistory.find(item => item.request.requestId === request.requestId)
    if (replay !== undefined) { sameRequest(replay.request.hash, hash); return this.view(actor, novel, replay) }
    const output = this.collection(actor, novel, target.selectedCodes)
    const artifact = this.artifact(novel.id, 'settings', JSON.stringify(output))
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const duplicate = current.manuscriptHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { sameRequest(duplicate.request.hash, hash); return current }
      const actual = this.collection(actor, current, target.selectedCodes)
      if (!isDeepStrictEqual(actual, output)) throw new WritingError('revision-conflict', 'Selected settings changed before collection publication')
      return { ...current, manuscriptHistory: [...current.manuscriptHistory, { artifact: reference(artifact), target,
        inputRefs: output.inputRefs, childSessionId: null, researchPlanId: null, request: { requestId: request.requestId, hash }, reviewHistory: [], applied: false, revisionOf: null }] }
    })
    const saved = updated.manuscriptHistory.find(item => item.request.requestId === request.requestId)
    if (saved === undefined) throw new WritingError('corrupt-artifact', 'Settings collection receipt is missing')
    return this.view(actor, updated, saved)
  }

  /** @param actor - Owning workspace. @param novelId - Exact novel. @returns Current heads and retained versions. */
  getManuscript(actor: Actor, novelId: NovelId): ManuscriptView {
    const novel = this.record(actor, novelId)
    const history = novel.manuscriptHistory.map(candidate => this.view(actor, novel, candidate))
    const heads = novel.manuscriptHeads.map(head => {
      const candidate = history.find(item => item.artifact.id === head.artifactId)
      if (candidate === undefined || candidate.status !== 'applied' || slot(candidate.target) !== `${head.kind}:${head.chapterNumber}`) throw new WritingError('corrupt-artifact', 'Manuscript head does not identify its adopted document')
      return candidate
    })
    const chapters = new Map<number, AppliedChapterRecord>()
    for (const chapter of novel.appliedChapters) chapters.set(chapter.chapterNumber, chapter)
    return { history, heads, appliedChapters: [...chapters.values()].sort((a, b) => a.chapterNumber - b.chapterNumber).map(chapter => this.chapterView(actor, novel, chapter)) }
  }

  /** @param actor - Owning workspace. @param request - Exact candidate review. @returns The reviewed candidate. */
  async saveManuscriptReview(actor: Actor, request: SaveManuscriptReviewRequest): Promise<ManuscriptCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const candidate = this.candidate(novel, request.candidateId)
    this.validateCandidate(actor, novel, candidate)
    const output = this.reviewOutput(actor, novel, candidate, request.output, request.admission)
    const hash = digest([request.childSessionId, request.expectedReviewId, output])
    const replay = candidate.reviewHistory.find(item => item.request.requestId === request.requestId)
    if (replay !== undefined) { sameRequest(replay.request.hash, hash); return this.view(actor, novel, candidate) }
    this.admitReview(actor, novel, candidate, request.expectedReviewId)
    checkModelArtifactBytes(JSON.stringify(output), this.owner.limits.maxArtifactBytes, 'Review output')
    const artifact = this.artifact(novel.id, 'review', JSON.stringify(output))
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const active = this.candidate(current, candidate.artifact.id)
      const duplicate = active.reviewHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { sameRequest(duplicate.request.hash, hash); return current }
      this.admitReview(actor, current, active, request.expectedReviewId)
      return { ...current, manuscriptHistory: current.manuscriptHistory.map(item => item.artifact.id === active.artifact.id
        ? { ...item, reviewHistory: [...item.reviewHistory, { artifact: reference(artifact), childSessionId: request.childSessionId,
          request: { requestId: request.requestId, hash }, blocking: output.issues.some(issue => issue.severity === 'blocking') }] } : item) }
    })
    return this.view(actor, updated, this.candidate(updated, candidate.artifact.id))
  }

  /** @param actor - Owning workspace. @param request - Exact passing review and expected head. @returns The adopted version. */
  async applyManuscriptCandidate(actor: Actor, request: ApplyManuscriptCandidateRequest): Promise<ManuscriptCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const candidate = this.candidate(novel, request.candidateId)
    if (candidate.target.kind === 'body' || candidate.target.kind === 'continuity' || candidate.target.kind === 'continuity-snapshot') throw new WritingError('review-blocked', 'Body and continuity must apply together')
    this.passingReview(actor, novel, candidate, request.reviewId, request.convergence)
    if (candidate.applied) return this.view(actor, novel, candidate)
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const active = this.candidate(current, candidate.artifact.id)
      this.passingReview(actor, current, active, request.reviewId, request.convergence)
      if (active.applied) return current
      this.currentInputs(actor, current, active)
      const head = current.manuscriptHeads.find(item => `${item.kind}:${item.chapterNumber}` === slot(active.target))
      if ((head?.artifactId ?? null) !== request.expectedAppliedId || (active.revisionOf !== null && request.expectedAppliedId !== active.revisionOf)) throw new WritingError('revision-conflict', 'A different manuscript version is the current head')
      if (active.target.kind === 'body' || active.target.kind === 'continuity' || active.target.kind === 'continuity-snapshot') throw new WritingError('review-blocked', 'Body and continuity must apply together')
      const convergence = request.convergence === undefined ? {} : { convergence: { reviewId: request.reviewId, failCount: request.convergence.failCount } }
      return { ...current, manuscriptHistory: current.manuscriptHistory.map(item => item.artifact.id === active.artifact.id ? { ...item, applied: true, ...convergence } : item),
        manuscriptHeads: [...current.manuscriptHeads.filter(item => `${item.kind}:${item.chapterNumber}` !== slot(active.target)),
          { kind: active.target.kind, chapterNumber: 'chapterNumber' in active.target ? active.target.chapterNumber : null, artifactId: active.artifact.id }] }
    })
    return this.view(actor, updated, this.candidate(updated, candidate.artifact.id))
  }

  /** @param actor - Owning workspace. @param request - Target before research planning. @returns Current source references without research evidence. */
  manuscriptResearchInputs(actor: Actor, request: { novelId: NovelId; target: GeneratedManuscriptTarget; revisionOf?: ArtifactId; snapshotThrough?: number }): readonly ArtifactRef[] {
    return this.context(actor, this.record(actor, request.novelId), request.target, request.revisionOf, request.snapshotThrough).inputRefs
  }

  /** @param actor - Owning workspace. @param request - Exact novel and requested stage. @returns Admissible source versions and mechanical requirements. */
  manuscriptInputs(actor: Actor, request: { novelId: NovelId; target: GeneratedManuscriptTarget; researchPlanId: ArtifactId; revisionOf?: ArtifactId; snapshotThrough?: number }): ManuscriptContext {
    const novel = this.record(actor, request.novelId)
    const context = this.context(actor, novel, request.target, request.revisionOf, request.snapshotThrough)
    const research = this.owner.getResearch(actor, { novelId: novel.id, planId: request.researchPlanId })
    if (research.stale || research.result === null || (research.outcome !== 'succeeded' && research.outcome !== 'not-needed')) throw new WritingError('research-incomplete', 'Manuscript generation requires adequate research for the current creative brief')
    const [brief, ...rest] = context.inputRefs
    if (brief === undefined) throw new WritingError('corrupt-artifact', 'Manuscript context has no creative brief')
    return { ...context, researchPlanId: request.researchPlanId, inputRefs: [brief, research.result, ...rest] }
  }

  /** @param actor - Owning workspace. @param request - Native stage JSON for exact input versions. @returns An immutable candidate without implicit application. */
  async saveManuscriptCandidate(actor: Actor, request: SaveManuscriptCandidateRequest): Promise<ManuscriptCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const target = manuscriptTargetSchema.parse(request.target)
    if (target.kind === 'settings') throw new WritingError('invalid-input', 'This manuscript stage output is not yet available')
    const parsed = parseModelOutput(StageOutputSchemas[target.kind], request.output, `${target.kind} output`)
    // The receipt covers the admitted output (after host evidence repair), which is exactly what is stored and re-verified on readback.
    const receipt = (output: typeof parsed) => digest([target, request.researchPlanId, request.childSessionId, { ...output, inputRefs: [...output.inputRefs].sort((a, b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0) }, ...(request.revisionOf === undefined ? [] : [request.revisionOf])])
    const replay = novel.manuscriptHistory.find(item => item.request.requestId === request.requestId)
    if (replay !== undefined) {
      let replayHash: string | null = null
      try { replayHash = receipt(this.generatedOutput(actor, novel, target, replay.inputRefs, request.researchPlanId, parsed, request.revisionOf ?? null).output) } catch { /* not the same admitted request */ }
      sameRequest(replay.request.hash, replayHash ?? '')
      return this.view(actor, novel, replay)
    }
    const context = this.manuscriptInputs(actor, request)
    const refs = context.inputRefs.map(inputRef)
    const { output } = this.generatedOutput(actor, novel, target, refs, request.researchPlanId, parsed, request.revisionOf ?? null)
    const hash = receipt(output)
    checkModelArtifactBytes(JSON.stringify(output), this.owner.limits.maxArtifactBytes, `${target.kind} output`)
    const artifact = this.artifact(novel.id, target.kind, JSON.stringify(output))
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const duplicate = current.manuscriptHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { sameRequest(duplicate.request.hash, hash); return current }
      const actual = this.manuscriptInputs(actor, request)
      if (!sameRefs(actual.inputRefs.map(inputRef), output.inputRefs)) throw new WritingError('revision-conflict', 'Manuscript inputs changed before candidate publication')
      return { ...current, manuscriptHistory: [...current.manuscriptHistory, { artifact: reference(artifact), target, inputRefs: refs,
        childSessionId: request.childSessionId, researchPlanId: request.researchPlanId, request: { requestId: request.requestId, hash }, reviewHistory: [], applied: false, revisionOf: request.revisionOf ?? null }] }
    })
    const saved = updated.manuscriptHistory.find(item => item.request.requestId === request.requestId)
    if (saved === undefined) throw new WritingError('corrupt-artifact', 'Manuscript publication receipt is missing')
    return this.view(actor, updated, saved)
  }

  /** @param actor - Owning workspace. @param request - Exact reviewed body/continuity pair and expected current pair. @returns One atomically applied chapter. */
  async applyChapter(actor: Actor, request: ApplyChapterRequest): Promise<AppliedChapterView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const replay = novel.appliedChapters.find(item => item.body.id === request.bodyId && item.continuity.id === request.continuityId)
    if (replay !== undefined) {
      if (replay.bodyReview.id !== request.bodyReviewId || replay.continuityReview.id !== request.continuityReviewId) throw new WritingError('review-blocked', 'Applied chapter review identities differ from this request')
      return this.chapterView(actor, novel, replay)
    }
    this.checkedPair(actor, novel, request, this.owner.manuscriptLimits, chapterConvergence(request))
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const duplicate = current.appliedChapters.find(item => item.body.id === request.bodyId && item.continuity.id === request.continuityId)
      if (duplicate !== undefined) {
        if (duplicate.bodyReview.id !== request.bodyReviewId || duplicate.continuityReview.id !== request.continuityReviewId) throw new WritingError('review-blocked', 'Applied chapter review identities differ from this request')
        return current
      }
      const pair = this.checkedPair(actor, current, request, this.owner.manuscriptLimits, chapterConvergence(request))
      this.currentInputs(actor, current, pair.body)
      this.currentInputs(actor, current, pair.continuity)
      const previous = current.appliedChapters.findLast(item => item.chapterNumber === pair.chapterNumber)
      if ((previous?.body.id ?? null) !== request.expectedBodyId || (previous?.continuity.id ?? null) !== request.expectedContinuityId) throw new WritingError('revision-conflict', 'A different body or continuity version is already applied')
      const bodyReview = pair.body.reviewHistory.at(-1)
      const continuityReview = pair.continuity.reviewHistory.at(-1)
      if (bodyReview === undefined || continuityReview === undefined || pair.body.artifact.kind !== 'body' || pair.continuity.artifact.kind !== 'continuity') throw new WritingError('corrupt-artifact', 'Reviewed chapter pair is incomplete')
      return { ...current, manuscriptHistory: current.manuscriptHistory.map(item => {
        if (item.artifact.id === pair.body.artifact.id) return { ...item, applied: true, ...convergenceOf(request.bodyReviewId, request.bodyConvergence) }
        if (item.artifact.id === pair.continuity.artifact.id) return { ...item, applied: true, ...convergenceOf(request.continuityReviewId, request.continuityConvergence) }
        return item
      }),
        appliedChapters: [...current.appliedChapters, { chapterNumber: pair.chapterNumber,
          body: { ...pair.body.artifact, kind: 'body' as const }, bodyReview: bodyReview.artifact,
          continuity: { ...pair.continuity.artifact, kind: 'continuity' as const }, continuityReview: continuityReview.artifact, obligations: pair.output.obligations, wordBounds: { ...this.owner.manuscriptLimits }, snapshot: null }] }
    })
    const saved = updated.appliedChapters.find(item => item.body.id === request.bodyId && item.continuity.id === request.continuityId)
    if (saved === undefined) throw new WritingError('corrupt-artifact', 'Applied chapter receipt is missing')
    return this.chapterView(actor, updated, saved)
  }

  /**
   * Inputs for one snapshot extraction: reviewed snapshots through `snapshotThrough`, then this chapter's applied body and continuity.
   * @param actor - Owning workspace.
   * @param request - Applied pair and the earlier-chapter ceiling.
   * @returns Exact artifact references, with no research evidence.
   */
  continuitySnapshotInputs(actor: Actor, request: { novelId: NovelId; chapterNumber: number; bodyId: ArtifactId; continuityId: ArtifactId; snapshotThrough?: number }): ArtifactRef[] {
    const novel = this.record(actor, request.novelId)
    const through = request.snapshotThrough ?? request.chapterNumber - 1
    const pair = this.appliedPair(novel, request.chapterNumber, request.bodyId, request.continuityId)
    return [...this.leadingSnapshots(actor, novel, through, request.chapterNumber), pair.body, pair.continuity]
  }

  /** @param actor - Owning workspace. @param request - Native snapshot JSON for the exact applied chapter. @returns An unreviewed snapshot candidate. */
  async saveContinuitySnapshot(actor: Actor, request: SaveContinuitySnapshotRequest): Promise<ManuscriptCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const target = { kind: 'continuity-snapshot' as const, chapterNumber: request.chapterNumber, bodyId: request.bodyId, continuityId: request.continuityId }
    const receipt = (output: ReturnType<typeof parseContinuitySnapshot>) => digest([target, null, request.childSessionId, { ...output, inputRefs: [...output.inputRefs].sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0) }])
    const replay = novel.manuscriptHistory.find(item => item.request.requestId === request.requestId)
    if (replay !== undefined) {
      let replayHash = ''
      try { replayHash = receipt(parseContinuitySnapshot(request.output, { inputRefs: replay.inputRefs, chapterNumber: request.chapterNumber })) } catch { /* different admission */ }
      sameRequest(replay.request.hash, replayHash)
      return this.view(actor, novel, replay)
    }
    const refs = this.continuitySnapshotInputs(actor, request).map(inputRef)
    const output = parseContinuitySnapshot(request.output, { inputRefs: refs, chapterNumber: request.chapterNumber })
    const hash = receipt(output)
    checkModelArtifactBytes(JSON.stringify(output), this.owner.limits.maxArtifactBytes, 'continuity-snapshot output')
    const artifact = this.artifact(novel.id, 'continuity-snapshot', JSON.stringify(output))
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const duplicate = current.manuscriptHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { sameRequest(duplicate.request.hash, hash); return current }
      const actual = this.continuitySnapshotInputs(actor, request).map(inputRef)
      if (!sameRefs(actual, output.inputRefs)) throw new WritingError('revision-conflict', 'Continuity snapshot inputs changed before candidate publication')
      return { ...current, manuscriptHistory: [...current.manuscriptHistory, { artifact: reference(artifact), target, inputRefs: refs,
        childSessionId: request.childSessionId, researchPlanId: null, request: { requestId: request.requestId, hash }, reviewHistory: [], applied: false, revisionOf: null }] }
    })
    const saved = updated.manuscriptHistory.find(item => item.request.requestId === request.requestId)
    if (saved === undefined) throw new WritingError('corrupt-artifact', 'Continuity snapshot receipt is missing')
    return this.view(actor, updated, saved)
  }

  /** @param actor - Owning workspace. @param request - Passing review of the snapshot for the exact applied pair. @returns The chapter with that snapshot attached. */
  async attachContinuitySnapshot(actor: Actor, request: AttachContinuitySnapshotRequest): Promise<AppliedChapterView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const existing = novel.appliedChapters.find(item => item.body.id === request.bodyId && item.continuity.id === request.continuityId && item.snapshot?.id === request.snapshotId)
    if (existing !== undefined) {
      if (existing.chapterNumber !== request.chapterNumber) throw new WritingError('review-blocked', 'Applied chapter snapshot belongs to another chapter')
      return this.chapterView(actor, novel, existing)
    }
    const snapshot = this.candidate(novel, request.snapshotId)
    this.readySnapshot(actor, novel, snapshot, request)
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const already = current.appliedChapters.find(item => item.body.id === request.bodyId && item.continuity.id === request.continuityId && item.snapshot?.id === request.snapshotId)
      if (already !== undefined) return current
      const active = this.candidate(current, request.snapshotId)
      this.readySnapshot(actor, current, active, request)
      const pair = this.appliedPair(current, request.chapterNumber, request.bodyId, request.continuityId)
      if (pair.snapshot != null) throw new WritingError('revision-conflict', 'This applied chapter already has a reviewed continuity snapshot')
      return { ...current, manuscriptHistory: current.manuscriptHistory.map(item => item.artifact.id === active.artifact.id ? { ...item, applied: true } : item),
        appliedChapters: current.appliedChapters.map(item => item.body.id === pair.body.id && item.continuity.id === pair.continuity.id ? { ...item, snapshot: { ...active.artifact, kind: 'continuity-snapshot' as const } } : item) }
    })
    const saved = updated.appliedChapters.find(item => item.body.id === request.bodyId && item.continuity.id === request.continuityId)
    if (saved?.snapshot?.id !== request.snapshotId) throw new WritingError('corrupt-artifact', 'Continuity snapshot was not attached')
    return this.chapterView(actor, updated, saved)
  }

  private checkedPair(actor: Actor, novel: NovelRecord, request: ApplyChapterRequest, bounds: ManuscriptLimits, convergence?: ChapterConvergence) {
    const body = this.candidate(novel, request.bodyId)
    const continuity = this.candidate(novel, request.continuityId)
    if (body.target.kind !== 'body' || continuity.target.kind !== 'continuity' || continuity.target.bodyId !== body.artifact.id
      || continuity.target.chapterNumber !== body.target.chapterNumber) throw new WritingError('review-blocked', 'Body and continuity must identify the same chapter and exact body version')
    this.passingReview(actor, novel, body, request.bodyReviewId, convergence?.body)
    this.passingReview(actor, novel, continuity, request.continuityReviewId, convergence?.continuity)
    const prose = this.validateCandidate(actor, novel, body)
    const actual = this.validateCandidate(actor, novel, continuity)
    if (prose.kind !== 'body' || actual.kind !== 'continuity') throw new WritingError('corrupt-artifact', 'Chapter pair has incorrect document kinds')
    const inspection = inspectBody(prose.output, bounds)
    if (inspection.length.blocking) throw new WritingError('review-blocked', 'Chapter word count is outside configured limits')
    if (actual.output.obligations.some(item => item.status !== 'fulfilled')) throw new WritingError('review-blocked', 'Every required chapter obligation must be fulfilled')
    return { body, continuity, chapterNumber: body.target.chapterNumber, output: actual.output, wordCount: inspection.wordCount }
  }

  private chapterView(actor: Actor, novel: NovelRecord, chapter: AppliedChapterRecord): AppliedChapterView {
    const pair = this.checkedPair(actor, novel, { novelId: novel.id, bodyId: chapter.body.id, bodyReviewId: chapter.bodyReview.id,
      continuityId: chapter.continuity.id, continuityReviewId: chapter.continuityReview.id, expectedBodyId: null, expectedContinuityId: null }, chapter.wordBounds)
    if (!pair.body.applied || !pair.continuity.applied || chapter.chapterNumber !== pair.chapterNumber
      || !isDeepStrictEqual(chapter.body, pair.body.artifact) || !isDeepStrictEqual(chapter.continuity, pair.continuity.artifact)
      || !isDeepStrictEqual(chapter.bodyReview, pair.body.reviewHistory.at(-1)?.artifact) || !isDeepStrictEqual(chapter.continuityReview, pair.continuity.reviewHistory.at(-1)?.artifact)
      || !isDeepStrictEqual(chapter.obligations, pair.output.obligations)) throw new WritingError('corrupt-artifact', 'Applied chapter record differs from its reviewed immutable versions')
    const changes = [...this.changedInputs(actor, novel, pair.body), ...this.changedInputs(actor, novel, pair.continuity)]
    const changedInputs = [...new Map(changes.map(ref => [ref.artifactId, ref])).values()]
    return structuredClone({ ...chapter, snapshot: chapter.snapshot ?? null, wordCount: pair.wordCount, stale: changedInputs.length > 0, changedInputs })
  }

  private context(actor: Actor, novel: NovelRecord, requested: GeneratedManuscriptTarget, revisionOf?: ArtifactId, snapshotThrough?: number): Omit<ManuscriptContext, 'researchPlanId'> {
    const target = manuscriptTargetSchema.parse(requested)
    if (target.kind === 'settings' || target.kind === 'continuity-snapshot') throw new WritingError('invalid-input', 'This manuscript stage context is not yet available')
    const lineage = revisionOf === undefined ? [] : [this.revisionBase(actor, novel, target, revisionOf).artifact]
    const settings = this.head(actor, novel, 'settings', null)
    const brief = this.owner.getNovel(actor, novel.id).brief
    const refs: ArtifactRef[] = [brief, settings.artifact]
    this.owner.getArtifact(actor, { novelId: novel.id, artifactId: brief.id })
    const empty = { target, revisionOf: revisionOf ?? null, inputRefs: [...refs, ...lineage], requiredChecks: requiredChecks(target.kind), obligations: [], sceneIds: [], continuitySnapshots: [] as ArtifactRef<'continuity-snapshot'>[] }
    if (target.kind === 'book-outline') return empty
    const book = this.head(actor, novel, 'book-outline', null)
    refs.push(book.artifact)
    const plan = StageOutputSchemas['book-outline'].parse(JSON.parse(this.owner.getArtifact(actor, { novelId: novel.id, artifactId: book.artifact.id }).text))
    const chapter = plan.chapters.find(item => item.chapterNumber === target.chapterNumber)
    if (chapter === undefined) throw new WritingError('invalid-input', 'Requested chapter is outside the applied book plan')
    let sceneIds: string[] = []
    if (target.kind === 'body' || target.kind === 'continuity') {
      const outline = this.head(actor, novel, 'chapter-outline', target.chapterNumber)
      refs.push(outline.artifact)
      const parsed = StageOutputSchemas['chapter-outline'].parse(JSON.parse(this.owner.getArtifact(actor, { novelId: novel.id, artifactId: outline.artifact.id }).text))
      sceneIds = parsed.scenes.map(scene => scene.id)
    }
    const through = snapshotThrough ?? target.chapterNumber - 1
    const continuitySnapshots = this.leadingSnapshots(actor, novel, through, target.chapterNumber)
    refs.push(...continuitySnapshots)
    if (target.kind === 'continuity') {
      const body = this.candidate(novel, target.bodyId)
      if (body.target.kind !== 'body' || body.target.chapterNumber !== target.chapterNumber) throw new WritingError('invalid-input', 'Continuity must identify the reviewed body of this chapter')
      const review = body.reviewHistory.at(-1)
      if (review === undefined) throw new WritingError('review-blocked', 'Review the exact body before deriving continuity')
      this.passingReview(actor, novel, body, review.artifact.id)
      this.currentInputs(actor, novel, body)
      const checked = this.validateCandidate(actor, novel, body)
      if (checked.kind !== 'body' || inspectBody(checked.output, this.owner.manuscriptLimits).length.blocking) throw new WritingError('review-blocked', 'Body length blocks continuity generation')
      const bodyInputs = body.inputRefs.filter(ref => this.owner.getArtifact(actor, { novelId: novel.id, artifactId: ref.artifactId }).kind !== 'research-evidence')
      if (!sameRefs(bodyInputs, refs.map(inputRef))) throw new WritingError('revision-conflict', 'Reviewed body uses different current chapter sources')
      refs.push(body.artifact, review.artifact)
    }
    return { target, revisionOf: revisionOf ?? null, inputRefs: [...refs, ...lineage], requiredChecks: requiredChecks(target.kind), obligations: chapter.obligations, sceneIds, continuitySnapshots }
  }

  private generatedOutput(actor: Actor, novel: NovelRecord, target: GeneratedManuscriptTarget, refs: readonly StageInputRef[], researchPlanId: ArtifactId, value: unknown, revisionOf: ArtifactId | null) {
    const allSources = refs.map(ref => {
      const source = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: ref.artifactId })
      if (source.sha256 !== ref.sha256) throw new WritingError('corrupt-artifact', 'Manuscript input hash differs from saved content')
      return source
    })
    if (revisionOf !== null) {
      const base = this.candidate(novel, revisionOf)
      if ((target.kind !== 'book-outline' && target.kind !== 'chapter-outline') || !base.applied || !isDeepStrictEqual(base.target, target) || allSources.at(-1)?.id !== revisionOf) throw new WritingError('corrupt-artifact', 'Revision lineage differs from the exact applied target')
    }
    const sources = revisionOf === null ? allSources : allSources.slice(0, -1)
    const research = this.owner.getResearch(actor, { novelId: novel.id, planId: researchPlanId })
    if (research.result === null || (research.outcome !== 'succeeded' && research.outcome !== 'not-needed')
      || sources[0]?.id !== research.briefArtifactId || sources[1]?.id !== research.result.id) throw new WritingError('corrupt-artifact', 'Manuscript research provenance differs from its inputs')
    if (sources[0]?.kind !== 'creative-brief' || sources[1]?.kind !== 'research-evidence' || sources[2]?.kind !== 'settings') throw new WritingError('corrupt-artifact', 'Manuscript base source roles are incomplete')
    const settings = settingsCollectionSchema.parse(JSON.parse(sources[2].text))
    if (!settings.inputRefs.some(ref => ref.artifactId === sources[0]?.id)) throw new WritingError('corrupt-artifact', 'Settings belong to a different brief version')
    if (target.kind === 'book-outline') {
      if (sources.length !== 3) throw new WritingError('corrupt-artifact', 'Book source roles are incomplete')
      return { kind: 'book-outline' as const, output: parseBookOutlineOutput(value, { inputRefs: refs, chapterCount: target.chapterCount }) }
    }
    if (target.kind !== 'chapter-outline' && target.kind !== 'body' && target.kind !== 'continuity') throw new WritingError('invalid-input', 'This manuscript output is not available')
    const book = sources[3]
    if (book?.kind !== 'book-outline') throw new WritingError('corrupt-artifact', 'Chapter requires its exact book outline')
    const plan = StageOutputSchemas['book-outline'].parse(JSON.parse(book.text))
    if (!plan.inputRefs.some(ref => ref.artifactId === sources[2]?.id)) throw new WritingError('corrupt-artifact', 'Book outline uses different settings')
    const chapter = plan.chapters.find(item => item.chapterNumber === target.chapterNumber)
    if (chapter === undefined) throw new WritingError('invalid-input', 'Requested chapter is outside its book plan')
    let sceneIds: string[] = []
    let index = 4
    if (target.kind === 'body' || target.kind === 'continuity') {
      const outline = sources[4]
      if (outline?.kind !== 'chapter-outline') throw new WritingError('corrupt-artifact', 'Body requires its exact chapter outline')
      const chapterPlan = StageOutputSchemas['chapter-outline'].parse(JSON.parse(outline.text))
      if (chapterPlan.chapterNumber !== target.chapterNumber || !chapterPlan.inputRefs.some(ref => ref.artifactId === book.id)) throw new WritingError('corrupt-artifact', 'Body chapter outline belongs to a different chapter or book')
      sceneIds = chapterPlan.scenes.map(scene => scene.id)
      index = 5
    }
    const snapshots: typeof sources = []
    let previousSnapshot = 0
    while (index < sources.length && sources[index]?.kind === 'continuity-snapshot') {
      const snapshot = sources[index]!
      const recorded = this.appliedSnapshot(novel, snapshot, target.chapterNumber)
      if (recorded <= previousSnapshot) throw new WritingError('corrupt-artifact', 'Continuity snapshots are not in applied chapter order')
      previousSnapshot = recorded
      snapshots.push(snapshot)
      index += 1
    }
    if (target.kind === 'continuity') {
      const body = sources[index]
      const review = sources[index + 1]
      if (body?.kind !== 'body' || body.id !== target.bodyId || review?.kind !== 'review') throw new WritingError('corrupt-artifact', 'Continuity requires the exact reviewed body and its review')
      const bodyRecord = this.candidate(novel, body.id)
      if (bodyRecord.target.kind !== 'body' || bodyRecord.target.chapterNumber !== target.chapterNumber || !bodyRecord.reviewHistory.some(item => item.artifact.id === review.id)) throw new WritingError('corrupt-artifact', 'Continuity review does not belong to the requested chapter body')
      const bodyOutput = StageOutputSchemas.body.parse(JSON.parse(body.text))
      const bodyReview = this.reviewOutput(actor, novel, bodyRecord, JSON.parse(review.text))
      const blocking = bodyReview.issues.filter(issue => issue.severity === 'blocking')
      const converged = bodyRecord.convergence?.reviewId === review.id && bodyRecord.convergence.failCount === blocking.length
      if (blocking.length > 0 && !converged) throw new WritingError('review-blocked', 'Continuity body still has blocking issues')
      const expectedBodySources = sources.slice(0, index).filter(source => source.kind !== 'research-evidence').map(inputRef)
      const actualBodySources = bodyRecord.inputRefs.filter(ref => this.owner.getArtifact(actor, { novelId: novel.id, artifactId: ref.artifactId }).kind !== 'research-evidence')
      if (!sameRefs(actualBodySources, expectedBodySources)) throw new WritingError('corrupt-artifact', 'Continuity and body use different chapter source versions')
      if (index + 2 !== sources.length) throw new WritingError('corrupt-artifact', 'Chapter input roles are incomplete')
      const evidenceSources = [{ artifactId: body.id, text: assembleBody(bodyOutput) }, ...snapshots.map(snapshot => ({ artifactId: snapshot.id, text: snapshot.text }))]
      return { kind: 'continuity' as const, output: parseContinuityOutput(value, { inputRefs: refs, chapterNumber: target.chapterNumber,
        obligationIds: chapter.obligations.map(item => item.id), reviewedBodyId: body.id, evidenceSources }) }
    }
    if (index !== sources.length) throw new WritingError('corrupt-artifact', 'Chapter input roles are incomplete')
    if (target.kind === 'body') return { kind: 'body' as const, output: parseBodyOutput(value, { inputRefs: refs, chapterNumber: target.chapterNumber, sceneIds }) }
    return { kind: 'chapter-outline' as const, output: parseChapterOutlineOutput(value, { inputRefs: refs, chapterNumber: target.chapterNumber, obligationIds: chapter.obligations.map(item => item.id) }) }
  }

  private leadingSnapshots(actor: Actor, novel: NovelRecord, through: number, chapterNumber: number): ArtifactRef<'continuity-snapshot'>[] {
    if (!Number.isSafeInteger(through) || through < 0) throw new WritingError('invalid-input', 'snapshotThrough must be a nonnegative integer')
    if (through >= chapterNumber) throw new WritingError('invalid-input', 'snapshotThrough must name an earlier chapter')
    const refs: ArtifactRef<'continuity-snapshot'>[] = []
    for (let number = 1; number <= through; number += 1) {
      const applied = novel.appliedChapters.findLast(item => item.chapterNumber === number)
      if (applied === undefined) throw new WritingError('revision-conflict', 'The previous chapter must be applied before continuing')
      const view = this.chapterView(actor, novel, applied)
      if (view.stale || view.snapshot == null) throw new WritingError('revision-conflict', `Applied chapter ${number} has no current reviewed continuity snapshot`)
      refs.push(view.snapshot)
    }
    return refs
  }

  private appliedPair(novel: NovelRecord, chapterNumber: number, bodyId: ArtifactId, continuityId: ArtifactId) {
    const pair = novel.appliedChapters.find(item => item.chapterNumber === chapterNumber && item.body.id === bodyId && item.continuity.id === continuityId)
    if (pair === undefined) throw new WritingError('revision-conflict', 'Continuity snapshot requires the applied body and continuity of this chapter')
    return pair
  }

  private readySnapshot(actor: Actor, novel: NovelRecord, snapshot: ManuscriptRecord, request: AttachContinuitySnapshotRequest): void {
    if (snapshot.target.kind !== 'continuity-snapshot' || snapshot.target.chapterNumber !== request.chapterNumber
      || snapshot.target.bodyId !== request.bodyId || snapshot.target.continuityId !== request.continuityId) {
      throw new WritingError('review-blocked', 'Continuity snapshot does not describe this applied chapter')
    }
    const body = snapshot.inputRefs.at(-2)
    const continuity = snapshot.inputRefs.at(-1)
    if (body?.artifactId !== request.bodyId || continuity?.artifactId !== request.continuityId) throw new WritingError('review-blocked', 'Continuity snapshot inputs are not the applied chapter pair')
    this.passingReview(actor, novel, snapshot, request.reviewId)
    this.currentInputs(actor, novel, snapshot)
    this.appliedPair(novel, request.chapterNumber, request.bodyId, request.continuityId)
  }

  private appliedSnapshot(novel: NovelRecord, source: { id: ArtifactId; text: string }, beforeChapter: number): number {
    const record = this.candidate(novel, source.id)
    if (record.target.kind !== 'continuity-snapshot' || !record.applied || record.target.chapterNumber >= beforeChapter) {
      throw new WritingError('corrupt-artifact', 'Continuity snapshot is not from an earlier applied chapter')
    }
    const parsed = StageOutputSchemas['continuity-snapshot'].parse(JSON.parse(source.text))
    if (parsed.chapterNumber !== record.target.chapterNumber) throw new WritingError('corrupt-artifact', 'Continuity snapshot chapter does not match its record')
    return record.target.chapterNumber
  }

  private revisionBase(actor: Actor, novel: NovelRecord, target: GeneratedManuscriptTarget, revisionOf: ArtifactId): ManuscriptRecord {
    const base = this.candidate(novel, revisionOf)
    if ((target.kind !== 'book-outline' && target.kind !== 'chapter-outline') || !base.applied || !isDeepStrictEqual(base.target, target)) throw new WritingError('invalid-input', 'Revision base must be an applied outline with the same target scope')
    this.validateCandidate(actor, novel, base)
    this.validateReviews(actor, novel, base)
    if (!novel.manuscriptHeads.some(head => head.artifactId === base.artifact.id)) throw new WritingError('revision-conflict', 'Manuscript revision base is no longer the current head')
    return base
  }

  private head(actor: Actor, novel: NovelRecord, kind: 'settings' | 'book-outline' | 'chapter-outline', chapterNumber: number | null): ManuscriptRecord {
    const head = novel.manuscriptHeads.find(item => item.kind === kind && item.chapterNumber === chapterNumber)
    if (head === undefined) throw new WritingError('revision-conflict', `An applied ${kind} is required`)
    const candidate = this.candidate(novel, head.artifactId)
    if (!candidate.applied || slot(candidate.target) !== `${kind}:${chapterNumber}`) throw new WritingError('corrupt-artifact', 'Manuscript head has the wrong scope or status')
    this.validateCandidate(actor, novel, candidate)
    this.validateReviews(actor, novel, candidate)
    this.currentInputs(actor, novel, candidate)
    return candidate
  }

  private candidate(novel: NovelRecord, id: ArtifactId): ManuscriptRecord {
    const candidate = novel.manuscriptHistory.find(item => item.artifact.id === id)
    if (candidate === undefined) throw new WritingError('artifact-not-found', 'Manuscript candidate is not published in this novel')
    return candidate
  }

  private currentInputs(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord): void {
    if (this.changedInputs(actor, novel, candidate).length > 0) throw new WritingError('revision-conflict', 'Manuscript inputs have changed')
  }

  private admitReview(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord, expectedReviewId: ArtifactId | null): void {
    if ((candidate.reviewHistory.at(-1)?.artifact.id ?? null) !== expectedReviewId) throw new WritingError('revision-conflict', 'A newer manuscript review already exists')
    if (candidate.applied) throw new WritingError('review-blocked', 'Create a new candidate to revise an applied manuscript')
    this.currentInputs(actor, novel, candidate)
  }

  private reviewOutput(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord, value: unknown, admission?: ReviewAdmission) {
    const refs = [inputRef(candidate.artifact), ...candidate.inputRefs]
    const evidenceSources = refs.map(ref => {
      const source = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: ref.artifactId })
      if (source.sha256 !== ref.sha256) throw new WritingError('corrupt-artifact', 'Manuscript review input hash differs from saved content')
      return { artifactId: source.id, text: source.kind === 'body' ? assembleBody(StageOutputSchemas.body.parse(JSON.parse(source.text))) : source.text }
    })
    const stored = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: candidate.artifact.id })
    return parseReviewOutput(value, { reviewed: inputRef(candidate.artifact), inputRefs: candidate.inputRefs, requiredChecks: requiredChecks(candidate.target.kind), evidenceSources,
      acceptAdvisoryCompleteness: candidate.target.kind === 'settings',
      ...(admission === undefined ? {} : { admission }),
      ...(hasParagraphCitation(value) ? { paragraphs: paragraphsOfStoredCandidate(stored.kind, stored.text) } : {}) })
  }

  /**
   * Remember that this candidate's latest review is the one to keep because a later round did not reduce its blocking-issue count.
   * Application still checks length and, for a chapter, fulfilled obligations. Continuity may then read this body.
   */
  async recordManuscriptConvergence(actor: Actor, request: { novelId: NovelId; candidateId: ArtifactId; reviewId: ArtifactId; failCount: number }): Promise<ManuscriptCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const candidate = this.candidate(novel, request.candidateId)
    this.passingReview(actor, novel, candidate, request.reviewId, { failCount: request.failCount })
    if (candidate.convergence?.reviewId === request.reviewId && candidate.convergence.failCount === request.failCount) return this.view(actor, novel, candidate)
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const active = this.candidate(current, candidate.artifact.id)
      this.passingReview(actor, current, active, request.reviewId, { failCount: request.failCount })
      if (active.convergence?.reviewId === request.reviewId && active.convergence.failCount === request.failCount) return current
      return { ...current, manuscriptHistory: current.manuscriptHistory.map(item => item.artifact.id === active.artifact.id
        ? { ...item, convergence: { reviewId: request.reviewId, failCount: request.failCount } } : item) }
    })
    return this.view(actor, updated, this.candidate(updated, candidate.artifact.id))
  }

  private passingReview(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord, reviewId: ArtifactId, requested?: { readonly failCount: number }): void {
    this.validateCandidate(actor, novel, candidate)
    const latest = candidate.reviewHistory.at(-1)
    if (latest === undefined || latest.artifact.id !== reviewId) throw new WritingError('review-blocked', 'The latest exact manuscript review is required')
    const artifact = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: reviewId })
    const output = this.reviewOutput(actor, novel, candidate, JSON.parse(artifact.text))
    const blocking = output.issues.filter(issue => issue.severity === 'blocking')
    if (blocking.length === 0) return
    const stored = candidate.convergence?.reviewId === reviewId && candidate.convergence.failCount === blocking.length
    const asked = requested !== undefined && requested.failCount === blocking.length
    if (!stored && !asked) throw new WritingError('review-blocked', 'Manuscript review still has blocking issues')
  }

  private validateReviews(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord): void {
    try {
      for (const [index, review] of candidate.reviewHistory.entries()) {
        const artifact = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: review.artifact.id })
        const parsed = this.reviewOutput(actor, novel, candidate, JSON.parse(artifact.text))
        if (review.blocking !== parsed.issues.some(issue => issue.severity === 'blocking')) throw new Error('Review index differs from immutable issues')
        if (candidate.convergence?.reviewId === review.artifact.id && candidate.convergence.failCount !== parsed.issues.filter(issue => issue.severity === 'blocking').length) throw new Error('Convergence fail count differs from the review')
        if (review.request.hash !== digest([review.childSessionId, candidate.reviewHistory[index - 1]?.artifact.id ?? null, parsed])) throw new Error('Review provenance differs from its publication receipt')
      }
      const latestReview = candidate.reviewHistory.at(-1)
      if (candidate.convergence !== undefined && candidate.convergence.reviewId !== latestReview?.artifact.id) throw new Error('Convergence does not name the latest review')
      if (candidate.applied && (candidate.reviewHistory.length === 0 || (latestReview?.blocking === true && candidate.convergence?.reviewId !== latestReview.artifact.id))) throw new Error('Applied manuscript has no passing review')
      if (candidate.applied && (candidate.target.kind === 'body' || candidate.target.kind === 'continuity')
        && !novel.appliedChapters.some(chapter => chapter.body.id === candidate.artifact.id || chapter.continuity.id === candidate.artifact.id)) throw new Error('Applied body or continuity has no atomic chapter application')
      if (candidate.applied && candidate.target.kind === 'continuity-snapshot'
        && !novel.appliedChapters.some(chapter => chapter.snapshot?.id === candidate.artifact.id)) throw new Error('Applied continuity snapshot is not attached to its chapter')
    } catch (cause) { throw new WritingError('corrupt-artifact', 'Manuscript review or adoption status cannot be verified', { cause }) }
  }

  private record(actor: Actor, novelId: NovelId): NovelRecord {
    this.owner.getNovel(actor, novelId)
    const novel = this.domain.table('novels').get(novelId)
    if (novel === undefined) throw new WritingError('novel-not-found', 'novelId does not exist')
    return novel
  }

  private collection(actor: Actor, novel: NovelRecord, selectedCodes: readonly string[]) {
    const settings = this.owner.getSettings(actor, novel.id)
    const dimensions = selectedCodes.map(code => {
      const item = settings.applied.find(candidate => candidate.dimensionCode === code)
      if (item === undefined || item.stale) throw new WritingError('revision-conflict', `Selected settings dimension is missing or stale: ${code}`)
      return item
    })
    const brief = this.owner.getNovel(actor, novel.id).brief
    this.owner.getArtifact(actor, { novelId: novel.id, artifactId: brief.id })
    return settingsCollectionSchema.parse({ version: 1, selectedCodes: [...selectedCodes], inputRefs: [brief, ...dimensions.map(item => item.artifact)].map(inputRef),
      dimensions: dimensions.map(item => StageOutputSchemas.settings.parse(JSON.parse(this.owner.getArtifact(actor, { novelId: novel.id, artifactId: item.artifact.id }).text))) })
  }

  private validateCandidate(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord, seen = new Set<ArtifactId>()) {
    try {
      if (seen.has(candidate.artifact.id)) throw new Error('Manuscript inputs contain a cycle')
      const path = new Set(seen).add(candidate.artifact.id)
      const stored = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: candidate.artifact.id })
      const value: unknown = JSON.parse(stored.text)
      const sources = candidate.inputRefs.map(ref => {
        const artifact = this.owner.getArtifact(actor, { novelId: novel.id, artifactId: ref.artifactId })
        if (artifact.sha256 !== ref.sha256) throw new Error('Input hash differs from immutable content')
        const upstream = novel.manuscriptHistory.find(item => item.artifact.id === ref.artifactId)
        if (upstream !== undefined) this.validateCandidate(actor, novel, upstream, path)
        return artifact
      })
      if (candidate.target.kind === 'settings') {
        const output = settingsCollectionSchema.parse(value)
        if (candidate.researchPlanId !== null || candidate.childSessionId !== null || candidate.revisionOf !== null || !isDeepStrictEqual(candidate.target.selectedCodes, output.selectedCodes)
          || !sameRefs(candidate.inputRefs, output.inputRefs)) throw new Error('Settings collection index differs from immutable content')
        if (sources[0]?.kind !== 'creative-brief' || sources.slice(1).some(source => source.kind !== 'settings-dimension')) throw new Error('Settings collection sources have incorrect kinds')
        const dimensions = sources.slice(1).map(source => StageOutputSchemas.settings.parse(JSON.parse(source.text)))
        if (!isDeepStrictEqual(dimensions, output.dimensions) || !isDeepStrictEqual(dimensions.map(item => item.dimensionCode), output.selectedCodes)
          || !isDeepStrictEqual(planSettings(output.selectedCodes).selectedCodes, output.selectedCodes)) throw new Error('Selected settings coverage differs from its sources')
        if (candidate.request.hash !== digest(candidate.target)) throw new Error('Settings collection receipt differs from its selected dimensions')
        return { kind: 'settings' as const, output }
      }
      if (candidate.target.kind === 'continuity-snapshot') {
        if (candidate.researchPlanId !== null || candidate.childSessionId === null || candidate.revisionOf !== null) throw new Error('Continuity snapshot provenance is incomplete')
        const output = parseContinuitySnapshot(value, { inputRefs: candidate.inputRefs, chapterNumber: candidate.target.chapterNumber })
        const body = sources.at(-2)
        const continuity = sources.at(-1)
        if (body?.kind !== 'body' || body.id !== candidate.target.bodyId || continuity?.kind !== 'continuity' || continuity.id !== candidate.target.continuityId) throw new Error('Continuity snapshot sources are not its applied chapter')
        if (!novel.appliedChapters.some(item => item.body.id === body.id && item.continuity.id === continuity.id)) throw new Error('Continuity snapshot chapter pair is not applied')
        let previous = 0
        for (const source of sources.slice(0, -2)) {
          if (source.kind !== 'continuity-snapshot') throw new Error('Continuity snapshot inputs must be earlier snapshots, then the chapter pair')
          const earlier = this.candidate(novel, source.id)
          if (earlier.target.kind !== 'continuity-snapshot' || !earlier.applied || earlier.target.chapterNumber <= previous || earlier.target.chapterNumber >= candidate.target.chapterNumber) throw new Error('Continuity snapshot cites an unapplied or later snapshot')
          previous = earlier.target.chapterNumber
        }
        const expectedHash = digest([candidate.target, null, candidate.childSessionId, { ...output, inputRefs: [...output.inputRefs].sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0) }])
        if (candidate.request.hash !== expectedHash) throw new Error('Continuity snapshot receipt differs from its publication')
        return { kind: 'continuity-snapshot' as const, output }
      }
      if (candidate.researchPlanId === null || candidate.childSessionId === null) throw new Error('Generated manuscript requires research and child-run provenance')
      if (candidate.revisionOf !== null && novel.manuscriptHistory.findIndex(item => item.artifact.id === candidate.revisionOf) >= novel.manuscriptHistory.indexOf(candidate)) throw new Error('Revision lineage must identify an earlier publication')
      const parsed = this.generatedOutput(actor, novel, candidate.target, candidate.inputRefs, candidate.researchPlanId, value, candidate.revisionOf)
      const expectedHash = digest([candidate.target, candidate.researchPlanId, candidate.childSessionId,
        { ...parsed.output, inputRefs: [...parsed.output.inputRefs].sort((a, b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0) }, ...(candidate.revisionOf === null ? [] : [candidate.revisionOf])])
      if (candidate.request.hash !== expectedHash) throw new Error('Generated manuscript provenance differs from its publication receipt')
      return parsed
    } catch (cause) { throw new WritingError('corrupt-artifact', 'Manuscript content or input references cannot be verified', { cause }) }
  }

  private changedInputs(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord, seen = new Set<ArtifactId>()): StageInputRef[] {
    if (seen.has(candidate.artifact.id)) throw new WritingError('corrupt-artifact', 'Manuscript source references contain a cycle')
    const path = new Set(seen).add(candidate.artifact.id)
    const settings = this.owner.getSettings(actor, novel.id)
    return candidate.inputRefs.filter(ref => {
      if (ref.artifactId === candidate.revisionOf) return !candidate.applied && !novel.manuscriptHeads.some(head => head.artifactId === candidate.revisionOf)
      if (novel.briefHistory.some(brief => brief.id === ref.artifactId)) return novel.briefHistory.at(-1)?.id !== ref.artifactId
      const dimension = settings.history.find(item => item.artifact.id === ref.artifactId)
      if (dimension !== undefined) return dimension.stale || !settings.applied.some(item => item.artifact.id === ref.artifactId)
      const upstream = novel.manuscriptHistory.find(item => item.artifact.id === ref.artifactId)
      if (upstream !== undefined) {
        if (this.changedInputs(actor, novel, upstream, path).length > 0) return true
        const target = upstream.target
        const owner = candidate.target
        if (target.kind === 'continuity-snapshot') {
          const current = novel.appliedChapters.findLast(item => item.chapterNumber === target.chapterNumber)
          return (current?.snapshot?.id ?? null) !== upstream.artifact.id
        }
        if (target.kind === 'body' || target.kind === 'continuity') {
          if (owner.kind === 'continuity' && upstream.artifact.id === owner.bodyId && !upstream.applied) return false
          if (owner.kind === 'continuity-snapshot' && (upstream.artifact.id === owner.bodyId || upstream.artifact.id === owner.continuityId) && !upstream.applied) return false
          const current = novel.appliedChapters.findLast(item => item.chapterNumber === target.chapterNumber)
          return (target.kind === 'body' ? current?.body.id : current?.continuity.id) !== upstream.artifact.id
        }
        return !novel.manuscriptHeads.some(head => head.artifactId === upstream.artifact.id)
      }
      const reviewerOf = novel.manuscriptHistory.find(item => item.reviewHistory.some(review => review.artifact.id === ref.artifactId))
      if (reviewerOf !== undefined) return reviewerOf.reviewHistory.at(-1)?.artifact.id !== ref.artifactId || this.changedInputs(actor, novel, reviewerOf, path).length > 0
      return false
    })
  }

  private view(actor: Actor, novel: NovelRecord, candidate: ManuscriptRecord): ManuscriptCandidateView {
    const validated = this.validateCandidate(actor, novel, candidate)
    this.validateReviews(actor, novel, candidate)
    const inspection = validated.kind === 'body' ? inspectBody(validated.output, this.owner.manuscriptLimits) : null
    const changedInputs = this.changedInputs(actor, novel, candidate)
    const review = candidate.reviewHistory.at(-1)
    return structuredClone({ target: candidate.target, artifact: candidate.artifact, inputRefs: candidate.inputRefs, childSessionId: candidate.childSessionId, revisionOf: candidate.revisionOf,
      status: candidate.applied ? 'applied' : inspection?.length.blocking ? 'blocked' : review === undefined ? 'candidate' : review.blocking ? 'blocked' : 'reviewed',
      review: review?.artifact ?? null, stale: changedInputs.length > 0, changedInputs, wordCount: inspection?.wordCount ?? null, length: inspection?.length ?? null, beats: validated.kind === 'body' ? measureBeats(validated.output) : null, aiTone: validated.kind === 'body' ? detectAiTone(assembleBody(validated.output)) : null })
  }

  private artifact<K extends ManuscriptKind | 'review'>(novelId: NovelId, kind: K, text: string): Artifact<K> {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.owner.limits.maxArtifactBytes) throw new WritingError('artifact-too-large', 'Artifact exceeds the configured UTF-8 byte limit')
    return { id: brandString<ArtifactId>(`artifact_${randomUUID()}`), novelId, kind, revision: 1, text, sha256: createHash('sha256').update(text).digest('hex'), chars: [...text].length, bytes }
  }
}

interface ChapterConvergence { readonly body?: { readonly failCount: number }; readonly continuity?: { readonly failCount: number } }
function chapterConvergence(request: ApplyChapterRequest): ChapterConvergence {
  return { ...(request.bodyConvergence === undefined ? {} : { body: request.bodyConvergence }), ...(request.continuityConvergence === undefined ? {} : { continuity: request.continuityConvergence }) }
}
function convergenceOf(reviewId: ArtifactId, convergence: { readonly failCount: number } | undefined): { convergence?: { reviewId: ArtifactId; failCount: number } } {
  return convergence === undefined ? {} : { convergence: { reviewId, failCount: convergence.failCount } }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function sameRequest(stored: string, received: string): void { if (stored !== received) throw new WritingError('request-conflict', 'Request ID was already used with different input') }
function inputRef(ref: ArtifactRef): StageInputRef { return { artifactId: ref.id, sha256: ref.sha256 } }
function reference<K extends ManuscriptKind | 'review'>(artifact: Artifact<K>): ArtifactRef<K> {
  const { id, kind, revision, sha256, chars, bytes } = artifact
  return { id, kind, revision, sha256, chars, bytes }
}

function slot(target: ManuscriptTarget): string { return `${target.kind}:${'chapterNumber' in target ? target.chapterNumber : null}` }
function requiredChecks(kind: ManuscriptKind): ReviewCategory[] {
  if (kind === 'settings') return ['completeness', 'consistency']
  if (kind === 'book-outline') return ['completeness', 'consistency', 'obligations']
  if (kind === 'body') return ['completeness', 'consistency', 'obligations', 'continuity', 'length']
  if (kind === 'continuity-snapshot') return ['consistency', 'continuity']
  return ['completeness', 'consistency', 'obligations', 'continuity']
}

function sameRefs(left: readonly StageInputRef[], right: readonly StageInputRef[]): boolean {
  return left.length === right.length && new Set(left.map(ref => ref.artifactId)).size === left.length
    && new Set(right.map(ref => ref.artifactId)).size === right.length
    && left.every(ref => right.some(other => ref.artifactId === other.artifactId && ref.sha256 === other.sha256))
}
