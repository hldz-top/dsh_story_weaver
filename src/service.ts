/** Novel creation and exact creative-brief versions over the host storage domain. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { researchSelectedConclusions, type ResearchSelection, type ResearchSelectedFinding, type SelectedResearchObservation } from './research-selection.ts'
import type { Actor, Artifact, ArtifactId, ArtifactKind, ArtifactRef, ArtifactRequest, ArtifactSlice, CreateNovelRequest, NovelId, NovelView, ReadArtifactRequest, RequestId, ResearchCall, ResearchLimits, ResearchObservation, ResearchRequest, ResearchView, SaveBriefRequest, StartResearchRequest, WritingLimits } from './contracts.ts'
import { WritingError } from './contracts.ts'
import { checkModelArtifactBytes } from './stage-rejection.ts'
import { writingDomain, type NovelRecord, type ResearchRecord, type SettingsRecord } from './records.ts'
import { parseSelectedFindings, researchEvidenceContentSchema, researchPlanContentSchema, researchQuestions } from './research.ts'

import { settingsCatalog } from './settings-catalog.ts'
import { canonicalSettingsRoots, sameSettingsRoots } from './settings-batch.ts'
import { bodyFeed, proseView } from './prose-view.ts'
import { paragraphsOfStoredCandidate } from './candidate-paragraphs.ts'
import { isOpenChecklistCode } from './open-dimension-checklist.ts'
import { hasParagraphCitation } from './paragraphs.ts'
import { admitOpenDimensionChecklist, parseSettingsDimensionOutput, parseReviewOutput, checkSettingsDimensionScope } from './stage-output.ts'
import type { ApplySettingsCandidateRequest, ImportSettingsRequest, SaveSettingsReviewRequest, SaveSettingsCandidateRequest, SettingsCandidateView, SettingsView } from './settings.ts'
import { ManuscriptStore, type AssembleSettingsRequest, type ManuscriptCandidateView, type ManuscriptView, type SaveManuscriptReviewRequest, type ApplyManuscriptCandidateRequest, type ManuscriptLimits, type ManuscriptContext, type GeneratedManuscriptTarget, type SaveManuscriptCandidateRequest, type ApplyChapterRequest, type AppliedChapterView, type SaveContinuitySnapshotRequest, type AttachContinuitySnapshotRequest } from './manuscript.ts'

function isRawChecklist(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'items' in value && !('checks' in value)
}

function researchContent<T>(schema: z.ZodType<T>, text: string): T {
  try { return schema.parse(JSON.parse(text)) }
  catch (cause) { throw new WritingError('corrupt-artifact', 'Research artifact JSON does not match its declared fields', { cause }) }
}

function reference<K extends ArtifactKind>(artifact: Artifact<K>): ArtifactRef<K> {
  const { id, kind, revision, sha256, chars, bytes } = artifact
  return { id, kind, revision, sha256, chars, bytes }
}

function view(record: NovelRecord, revision = record.briefHistory.length): NovelView {
  const briefHistory = record.briefHistory.slice(0, revision).map(ref => ({ ...ref }))
  const brief = briefHistory.at(-1)
  if (!brief) throw new WritingError('corrupt-artifact', 'Novel has no creative brief')
  return { id: record.id, title: record.title, workspace: record.workspace, revision: brief.revision, brief, briefHistory }
}

/** Owns one domain handle; mount one service per storage facility. */
export class WritingService {
  private readonly creations = new Map<string, { hash: string; result: Promise<NovelView> }>()
  private readonly manuscripts: ManuscriptStore
  constructor(private readonly domain: Domain<typeof writingDomain>, readonly limits: WritingLimits, readonly researchLimits: ResearchLimits, readonly manuscriptLimits: ManuscriptLimits) {
    this.manuscripts = new ManuscriptStore(domain, this)
  }

  /** @param actor - Owning workspace. @param request - Explicit selected dimension roots. @returns An immutable unreviewed settings collection. */
  assembleSettings(actor: Actor, request: AssembleSettingsRequest): Promise<ManuscriptCandidateView> { return this.manuscripts.assembleSettings(actor, request) }

  /** @param actor - Owning workspace. @param novelId - Exact novel. @returns Retained manuscript versions and current heads. */
  getManuscript(actor: Actor, novelId: NovelId): ManuscriptView { return this.manuscripts.getManuscript(actor, novelId) }
  /** @param actor - Owning workspace. @param request - Independent exact-version review. @returns The candidate with its review. */
  saveManuscriptReview(actor: Actor, request: SaveManuscriptReviewRequest): Promise<ManuscriptCandidateView> { return this.manuscripts.saveManuscriptReview(actor, request) }
  /** @param actor - Owning workspace. @param request - Exact review and expected current head. @returns The adopted standalone document. */
  applyManuscriptCandidate(actor: Actor, request: ApplyManuscriptCandidateRequest): Promise<ManuscriptCandidateView> { return this.manuscripts.applyManuscriptCandidate(actor, request) }

  /** @param actor - Owning workspace. @param request - Target requiring a research decision. @returns Current source versions before new research is planned. */
  manuscriptResearchInputs(actor: Actor, request: { novelId: NovelId; target: GeneratedManuscriptTarget; revisionOf?: ArtifactId; snapshotThrough?: number }): readonly ArtifactRef[] { return this.manuscripts.manuscriptResearchInputs(actor, request) }
  /** @param actor - Owning workspace. @param request - Target stage and exact novel. @returns Current admissible input versions and mechanical requirements. */
  manuscriptInputs(actor: Actor, request: { novelId: NovelId; target: GeneratedManuscriptTarget; researchPlanId: ArtifactId; revisionOf?: ArtifactId; snapshotThrough?: number }): ManuscriptContext { return this.manuscripts.manuscriptInputs(actor, request) }
  /** @param actor - Owning workspace. @param request - Native generated output with exact source versions. @returns A persisted unreviewed candidate. */
  saveManuscriptCandidate(actor: Actor, request: SaveManuscriptCandidateRequest): Promise<ManuscriptCandidateView> { return this.manuscripts.saveManuscriptCandidate(actor, request) }

  /** @param actor - Owning workspace. @param request - Exact reviewed body/continuity pair and expected prior pair. @returns The atomically applied chapter. */
  applyChapter(actor: Actor, request: ApplyChapterRequest): Promise<AppliedChapterView> { return this.manuscripts.applyChapter(actor, request) }
  /** @param actor - Owning workspace. @param request - Applied chapter and earlier-snapshot ceiling. @returns Snapshot inputs, with no research evidence. */
  continuitySnapshotInputs(actor: Actor, request: { novelId: NovelId; chapterNumber: number; bodyId: ArtifactId; continuityId: ArtifactId; snapshotThrough?: number }): ArtifactRef[] { return this.manuscripts.continuitySnapshotInputs(actor, request) }
  /** @param actor - Owning workspace. @param request - Native snapshot for one applied chapter. @returns The unreviewed snapshot candidate. */
  saveContinuitySnapshot(actor: Actor, request: SaveContinuitySnapshotRequest): Promise<ManuscriptCandidateView> { return this.manuscripts.saveContinuitySnapshot(actor, request) }
  /** @param actor - Owning workspace. @param request - Passing snapshot review for the applied pair. @returns The chapter with the snapshot attached. */
  attachContinuitySnapshot(actor: Actor, request: AttachContinuitySnapshotRequest): Promise<AppliedChapterView> { return this.manuscripts.attachContinuitySnapshot(actor, request) }

  /** @param actor - Host-admitted workspace. @param request - Initial title and brief. @returns The initial committed novel. */
  async createNovel(actor: Actor, request: CreateNovelRequest): Promise<NovelView> {
    actor.signal?.throwIfAborted()
    if (request.title.trim().length === 0 || request.brief.trim().length === 0) {
      throw new WritingError('invalid-input', 'Novel title and creative brief must contain text')
    }
    const hash = createHash('sha256').update(JSON.stringify([request.title, request.brief])).digest('hex')
    const key = JSON.stringify([actor.workspace, request.requestId])
    const pending = this.creations.get(key)
    if (pending) {
      this.sameRequest(pending.hash, hash)
      return pending.result
    }
    const existing = [...this.domain.table('novels').entries()].find(([, record]) =>
      record.workspace === actor.workspace && record.createRequest.requestId === request.requestId)
    if (existing) {
      this.sameRequest(existing[1].createRequest.hash, hash)
      return view(existing[1], 1)
    }
    const result = this.persistNovel(actor, request, hash)
    this.creations.set(key, { hash, result })
    try { return await result } finally { this.creations.delete(key) }
  }

  private async persistNovel(actor: Actor, request: CreateNovelRequest, hash: string): Promise<NovelView> {
    const id = brandString<NovelId>(`novel_${randomUUID()}`)
    const artifact = this.artifact(id, 1, request.brief, 'creative-brief')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const record: NovelRecord = {
      id, workspace: actor.workspace, title: request.title, briefHistory: [reference(artifact)],
      createRequest: { requestId: request.requestId, hash }, briefRequests: [], recordVersion: 5, researchHistory: [], settingsHistory: [], settingsHeads: [], manuscriptHistory: [], manuscriptHeads: [], appliedChapters: [],
    }
    await this.domain.table('novels').put(id, record)
    return view(record)
  }

  /** @param actor - Host-admitted workspace. @param novelId - Exact novel. @returns Current metadata. */
  getNovel(actor: Actor, novelId: NovelId): NovelView { return view(this.record(actor, novelId)) }

  /** @param actor - Host-admitted workspace. @returns Its novels without changing Session selection. */
  listNovels(actor: Actor): NovelView[] {
    return [...this.domain.table('novels').entries()].filter(([, record]) => record.workspace === actor.workspace).map(([, record]) => view(record))
  }

  /** @param actor - Session and workspace owning the selection. @param novelId - Owned novel. @returns The selected current novel. */
  async selectNovel(actor: Actor, novelId: NovelId): Promise<NovelView> {
    actor.signal?.throwIfAborted()
    const novel = this.getNovel(actor, novelId)
    await this.domain.table('selections').put(this.selectionKey(actor), { workspace: actor.workspace, sessionId: actor.sessionId, novelId })
    return novel
  }

  /** @param actor - Session and workspace owning the selection. @returns Its selected novel, or null before explicit selection. */
  getSelection(actor: Actor): NovelView | null {
    const selection = this.domain.table('selections').get(this.selectionKey(actor))
    if (!selection) return null
    return this.getNovel(actor, selection.novelId)
  }

  /** @param actor - Host-admitted workspace. @param request - Replacement brief and expected version. @returns The newly committed novel version. */
  async saveBrief(actor: Actor, request: SaveBriefRequest): Promise<NovelView> {
    actor.signal?.throwIfAborted()
    if (request.text.trim().length === 0 || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
      throw new WritingError('invalid-input', 'Creative brief requires text and a positive integer revision')
    }
    const current = this.record(actor, request.novelId)
    const hash = createHash('sha256').update(JSON.stringify([request.expectedRevision, request.text])).digest('hex')
    const replay = this.briefRequest(current, request, hash)
    if (replay !== undefined) return view(current, replay)
    const artifact = this.artifact(request.novelId, request.expectedRevision + 1, request.text, 'creative-brief')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const record = await this.domain.table('novels').update(request.novelId, current => {
      actor.signal?.throwIfAborted()
      if (this.briefRequest(current, request, hash) !== undefined) return current
      if (view(current).revision !== request.expectedRevision) {
        throw new WritingError('revision-conflict', 'Creative brief was changed by another request')
      }
      return {
        ...current, briefHistory: [...current.briefHistory, reference(artifact)],
        briefRequests: [...current.briefRequests, { requestId: request.requestId, hash, revision: artifact.revision }],
      }
    })
    const savedRevision = this.briefRequest(record, request, hash)
    if (savedRevision === undefined) throw new WritingError('corrupt-artifact', 'Saved request receipt is missing')
    return view(record, savedRevision)
  }

  /**
   * Verify persisted content against its published reference before returning text.
   * @param actor - Host-admitted workspace.
   * @param request - Exact immutable version.
   * @returns Full verified version for bounded projection; corruption rejects without repair.
   */
  getArtifact(actor: Actor, request: ArtifactRequest): Artifact {
    const novel = this.record(actor, request.novelId)
    const published = [
      ...novel.briefHistory,
      ...novel.settingsHistory.flatMap(candidate => [candidate.artifact, ...candidate.reviewHistory.map(review => review.artifact)]),
      ...novel.manuscriptHistory.flatMap(candidate => [candidate.artifact, ...candidate.reviewHistory.map(review => review.artifact)]),
      ...novel.researchHistory.flatMap(research => research.result === null ? [research.plan] : [research.plan, research.result]),
    ].find(ref => ref.id === request.artifactId)
    if (published === undefined) {
      throw new WritingError('artifact-not-found', 'artifactId is not published in this novel')
    }
    const artifact = this.domain.table('artifacts').get(request.artifactId)
    if (artifact === undefined) throw new WritingError('artifact-not-found', 'Published artifact is missing')
    if (artifact.novelId !== request.novelId
      || artifact.id !== published.id || artifact.kind !== published.kind
      || artifact.revision !== published.revision || artifact.sha256 !== published.sha256
      || artifact.chars !== published.chars || artifact.bytes !== published.bytes
      || createHash('sha256').update(artifact.text).digest('hex') !== published.sha256
      || [...artifact.text].length !== published.chars
      || Buffer.byteLength(artifact.text, 'utf8') !== published.bytes) {
      throw new WritingError('corrupt-artifact', 'Artifact content or metadata differs from its published reference')
    }
    this.artifactSize(artifact.text)
    return { ...artifact }
  }

  /** @param actor - Host-admitted workspace. @param request - Exact version and Unicode interval. @returns A bounded interval with an explicit EOF marker. */
  readArtifact(actor: Actor, request: ReadArtifactRequest): ArtifactSlice {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0
      || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > this.limits.maxReadChars) {
      throw new WritingError('invalid-range', 'Artifact read interval exceeds the configured bounds')
    }
    const artifact = this.getArtifact(actor, request)
    const view = request.view ?? 'stored'
    const served = view === 'prose' ? proseView(artifact.kind, artifact.text)
      : view === 'feed' ? bodyFeed(artifact.kind, artifact.text, request.feedChapter ?? 0) : artifact.text
    const characters = [...served]
    if (request.offset > characters.length) throw new WritingError('invalid-range', 'Artifact offset is past EOF')
    const nextOffset = Math.min(characters.length, request.offset + request.limit)
    return {
      novelId: request.novelId, artifactId: request.artifactId, kind: artifact.kind, revision: artifact.revision,
      sha256: artifact.sha256, offset: request.offset, nextOffset, totalChars: characters.length,
      text: characters.slice(request.offset, nextOffset).join(''), eof: nextOffset === characters.length, view,
    }
  }

  /** @param actor - Host-admitted workspace. @param request - Exact version. @returns Code points of its reader-facing plain-text view. */
  proseChars(actor: Actor, request: ArtifactRequest): number {
    const artifact = this.getArtifact(actor, request)
    return [...proseView(artifact.kind, artifact.text)].length
  }

  /**
   * Sessions whose artifact reads are always served as plain prose (review and citation-repair children). Host-owned:
   * the child cannot opt out, so a reviewer never sees JSON scaffolding it could quote.
   */
  private readonly proseReaders = new Set<string>()
  /** @param sessionId - Native child Session. @returns A function ending its prose-only reads. */
  serveProseTo(sessionId: string): () => void {
    this.proseReaders.add(sessionId)
    return () => { this.proseReaders.delete(sessionId) }
  }
  /** @param sessionId - Reading Session. @returns Whether its reads must use the prose view. */
  readsProse(sessionId: string | undefined): boolean { return sessionId !== undefined && this.proseReaders.has(sessionId) }

  /** Body-stage sessions whose book and chapter outlines are served as {@link bodyFeed}. The value is the chapter being written. */
  private readonly feedReaders = new Map<string, number>()
  /** @param sessionId - Native body child. @param chapterNumber - The chapter that child is writing. @returns A function ending its outline feed. */
  serveBodyFeedTo(sessionId: string, chapterNumber: number): () => void {
    this.feedReaders.set(sessionId, chapterNumber)
    return () => { this.feedReaders.delete(sessionId) }
  }
  /** @param sessionId - Reading Session. @returns The chapter number when this session's outlines are served as the body feed. */
  bodyFeedChapter(sessionId: string | undefined): number | undefined { return sessionId === undefined ? undefined : this.feedReaders.get(sessionId) }

  /** Code points of the body-stage outline feed. Other kinds match the stored text. */
  feedChars(actor: Actor, request: ArtifactRequest, chapterNumber: number): number {
    const artifact = this.getArtifact(actor, request)
    return [...bodyFeed(artifact.kind, artifact.text, chapterNumber)].length
  }

  /** @param actor - Plan-owning Session and workspace. @param request - Questions and exact current brief. @param startSeq - First admitted Session log position. @returns The published immutable plan or its idempotent replay. */
  async startResearch(actor: Actor, request: StartResearchRequest, startSeq: number): Promise<ResearchView> {
    actor.signal?.throwIfAborted()
    if (!Number.isSafeInteger(startSeq) || startSeq < 0) throw new WritingError('invalid-input', 'Research start sequence must be a nonnegative safe integer')
    const questions = researchQuestions(request.questions, this.researchLimits)
    const current = this.record(actor, request.novelId)
    const hash = createHash('sha256').update(JSON.stringify([request.briefArtifactId, questions])).digest('hex')
    const replay = current.researchHistory.find(item => item.sessionId === actor.sessionId && item.startRequest.requestId === request.requestId)
    if (replay !== undefined) {
      this.sameRequest(replay.startRequest.hash, hash)
      return this.getResearch(actor, { novelId: current.id, planId: replay.plan.id })
    }
    this.currentResearchBrief(current, request.briefArtifactId)
    this.getArtifact(actor, { novelId: current.id, artifactId: request.briefArtifactId })
    const artifact = this.artifact(current.id, 1,
      JSON.stringify({ version: 1, novelId: current.id, briefArtifactId: request.briefArtifactId, sessionId: actor.sessionId, startSeq, questions }), 'research-plan')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    await this.domain.table('research_reads').put(artifact.id, { reads: [] })
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(current.id, record => {
      actor.signal?.throwIfAborted()
      const duplicate = record.researchHistory.find(item => item.sessionId === actor.sessionId && item.startRequest.requestId === request.requestId)
      if (duplicate !== undefined) { this.sameRequest(duplicate.startRequest.hash, hash); return record }
      this.currentResearchBrief(record, request.briefArtifactId)
      if (this.activeResearch(actor) !== null) throw new WritingError('research-active', 'This Session already has an active research plan')
      const entry: ResearchRecord = {
        plan: reference(artifact), result: null, briefArtifactId: request.briefArtifactId, sessionId: actor.sessionId,
        startSeq, questions, reservedCalls: [], outcome: null,
        startRequest: { requestId: request.requestId, hash }, completeRequest: null,
      }
      return { ...record, researchHistory: [...record.researchHistory, entry] }
    })
    const stored = updated.researchHistory.find(item => item.sessionId === actor.sessionId && item.startRequest.requestId === request.requestId)
    if (stored === undefined) throw new WritingError('corrupt-artifact', 'Published research plan receipt is missing')
    return this.researchView(updated, stored)
  }

  /** @param actor - Workspace authorized to read the novel. @param request - Exact plan. @returns Its current reservations and immutable version references. */
  getResearch(actor: Actor, request: ResearchRequest): ResearchView {
    const novel = this.record(actor, request.novelId)
    const research = this.researchRecord(novel, request.planId)
    const plan = this.getArtifact(actor, { novelId: novel.id, artifactId: research.plan.id })
    const input = { novelId: novel.id, briefArtifactId: research.briefArtifactId, sessionId: research.sessionId, startSeq: research.startSeq }
    if (!isDeepStrictEqual(researchContent(researchPlanContentSchema, plan.text), { version: 1, ...input, questions: research.questions })) {
      throw new WritingError('corrupt-artifact', 'Research index differs from its immutable plan')
    }
    if (research.result !== null) {
      const result = this.getArtifact(actor, { novelId: novel.id, artifactId: research.result.id })
      const { version: _version, findings: _findings, observations, ...recorded } = researchContent(researchEvidenceContentSchema, result.text)
      if (!isDeepStrictEqual(recorded, { ...input, planId: research.plan.id, outcome: research.outcome })
        || observations.length !== research.reservedCalls.length
        || new Set(observations.map(item => item.callId)).size !== observations.length
        || observations.some(item => !research.reservedCalls.some(call => call.callId === item.callId && call.name === item.name))) {
        throw new WritingError('corrupt-artifact', 'Research index differs from its immutable evidence')
      }
    }
    return this.researchView(novel, research)
  }

  /** @param actor - Workspace authorized to read the novel. @param novelId - Owned novel. @returns All published research plans, preserving earlier outcomes. */
  listResearch(actor: Actor, novelId: NovelId): ResearchView[] {
    return this.record(actor, novelId).researchHistory.map(item => this.getResearch(actor, { novelId, planId: item.plan.id }))
  }

  /** @param actor - Session about to invoke native web. @param call - Exact logged call identity. @returns The reserved active plan, or null when no current plan applies. */
  async reserveResearchCall(actor: Actor, call: ResearchCall): Promise<ResearchView | null> {
    actor.signal?.throwIfAborted()
    const active = this.activeResearch(actor)
    if (active === null) return null
    this.getResearch(actor, active)
    const updated = await this.domain.table('novels').update(active.novelId, novel => {
      actor.signal?.throwIfAborted()
      const plan = this.researchRecord(novel, active.planId)
      this.currentResearchBrief(novel, plan.briefArtifactId)
      if (plan.outcome !== null) throw new WritingError('research-incomplete', 'Research plan completed before the native call was reserved')
      if (!plan.questions.some(question => question.kind === 'external')) throw new WritingError('research-incomplete', 'Input-only research cannot reserve native web calls')
      const duplicate = plan.reservedCalls.find(item => item.callId === call.callId)
      if (duplicate !== undefined) {
        if (duplicate.name !== call.name) throw new WritingError('request-conflict', 'Native call id was already reserved for another tool')
        return novel
      }
      if (plan.reservedCalls.length >= this.researchLimits.maxResearchCalls) throw new WritingError('research-budget', 'Research native web call limit was reached')
      return { ...novel, researchHistory: novel.researchHistory.map(item => item.plan.id === active.planId
        ? { ...item, reservedCalls: [...item.reservedCalls, { ...call }] } : item) }
    })
    return this.researchView(updated, this.researchRecord(updated, active.planId))
  }

  /** @param actor - Plan-owning Session. @param request - Verified page range. @param readCallId - Native paging invocation identity. @returns Remaining per-plan character allowance after durable reservation. */
  async reserveResearchRead(actor: Actor, request: ResearchRequest & ResearchSelection, readCallId: ToolCallId): Promise<number> {
    actor.signal?.throwIfAborted()
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > this.limits.maxReadChars
      || !Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.sourceIndex) || request.sourceIndex < 0) {
      throw new WritingError('invalid-range', 'Research page requires a bounded Unicode range')
    }
    const assertReadable = () => {
      const plan = this.researchRecord(this.record(actor, request.novelId), request.planId)
      this.researchOwner(actor, plan)
      const view = this.getResearch(actor, request)
      if (view.stale || view.result !== null) throw new WritingError('research-incomplete', 'Source paging requires an active current-brief plan; read completed evidence as an artifact')
      if (!plan.reservedCalls.some(call => call.callId === request.callId)) throw new WritingError('research-incomplete', 'Source paging requires a reserved native call')
    }
    assertReadable()
    if (this.domain.table('research_reads').get(request.planId) === undefined) throw new WritingError('research-incomplete', 'This historical plan has no source-read allowance')
    const read = { readCallId, callId: request.callId, sourceIndex: request.sourceIndex, offset: request.offset, limit: request.limit }
    const saved = await this.domain.table('research_reads').update(request.planId, current => {
      actor.signal?.throwIfAborted()
      assertReadable()
      const previous = current.reads.find(item => item.readCallId === readCallId)
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous, read)) throw new WritingError('request-conflict', 'Source-read call identity already reserved another range')
        return current
      }
      if (current.reads.reduce((sum, item) => sum + item.limit, 0) + request.limit > this.researchLimits.maxEvidenceChars) {
        throw new WritingError('research-budget', 'Research source reads exhausted the per-plan character allowance')
      }
      return { reads: [...current.reads, read] }
    })
    actor.signal?.throwIfAborted()
    return this.researchLimits.maxEvidenceChars - saved.reads.reduce((sum, item) => sum + item.limit, 0)
  }

  /** @param actor - Plan-owning Session. @param request - Conclusions and exact selected source ranges. @param observations - Literal excerpts verified against native logs. @returns Immutable version-3 evidence. */
  async completeSelectedResearch(actor: Actor, request: ResearchRequest & { requestId: StartResearchRequest['requestId']; findings: readonly ResearchSelectedFinding[] }, observations: readonly SelectedResearchObservation[]): Promise<ResearchView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const plan = this.researchRecord(novel, request.planId)
    this.researchOwner(actor, plan)
    this.getResearch(actor, request)
    const findings = parseSelectedFindings(request.findings)
    const hash = createHash('sha256').update(JSON.stringify(findings)).digest('hex')
    if (plan.completeRequest !== null) {
      if (plan.completeRequest.requestId !== request.requestId) throw new WritingError('request-conflict', 'Research plan is already completed')
      this.sameRequest(plan.completeRequest.hash, hash)
      return this.researchView(novel, plan)
    }
    this.currentResearchBrief(novel, plan.briefArtifactId)
    this.researchObservations(plan, observations)
    const classified = researchSelectedConclusions(plan.questions, findings, observations, this.researchLimits)
    const artifact = this.artifact(novel.id, 1, JSON.stringify({
      version: 3, novelId: novel.id, planId: plan.plan.id, briefArtifactId: plan.briefArtifactId,
      sessionId: plan.sessionId, startSeq: plan.startSeq, ...classified, observations,
    }), 'research-evidence')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, record => {
      actor.signal?.throwIfAborted()
      const current = this.researchRecord(record, request.planId)
      this.researchOwner(actor, current)
      if (current.completeRequest !== null) {
        if (current.completeRequest.requestId !== request.requestId) throw new WritingError('request-conflict', 'Research plan is already completed')
        this.sameRequest(current.completeRequest.hash, hash)
        return record
      }
      this.currentResearchBrief(record, current.briefArtifactId)
      this.researchObservations(current, observations)
      return { ...record, researchHistory: record.researchHistory.map(item => item.plan.id === request.planId
        ? { ...item, result: reference(artifact), outcome: classified.outcome, completeRequest: { requestId: request.requestId, hash } }
        : item) }
    })
    return this.researchView(updated, this.researchRecord(updated, request.planId))
  }

  /**
   * Record a not-needed research plan without a model call or a web tool.
   * Used when research is disabled or the remaining call budget is below the floor.
   * @param actor - Owning workspace. The plan is owned by this Session.
   * @param request - Current brief, idempotency key and the skip reason stored as the creative question.
   * @returns The completed not-needed plan.
   */
  async recordInputOnlyResearch(actor: Actor, request: { novelId: NovelId; briefArtifactId: ArtifactId; requestId: StartResearchRequest['requestId']; reason: string }): Promise<ResearchView> {
    actor.signal?.throwIfAborted()
    const questions = researchQuestions([{ id: 'research-skipped', kind: 'creative', question: request.reason, reason: request.reason }], this.researchLimits)
    const findings = [{ questionId: 'research-skipped', callIds: [] as string[], selections: [] as [], conclusion: request.reason, adequate: true }]
    const startHash = createHash('sha256').update(JSON.stringify([request.briefArtifactId, questions])).digest('hex')
    const completeHash = createHash('sha256').update(JSON.stringify(findings)).digest('hex')
    const current = this.record(actor, request.novelId)
    const replay = current.researchHistory.find(item => item.sessionId === actor.sessionId && item.startRequest.requestId === request.requestId)
    if (replay !== undefined) {
      this.sameRequest(replay.startRequest.hash, startHash)
      if (replay.completeRequest === null || replay.outcome !== 'not-needed') throw new WritingError('request-conflict', 'Request id already started a different research plan')
      this.sameRequest(replay.completeRequest.hash, completeHash)
      return this.getResearch(actor, { novelId: current.id, planId: replay.plan.id })
    }
    this.currentResearchBrief(current, request.briefArtifactId)
    this.getArtifact(actor, { novelId: current.id, artifactId: request.briefArtifactId })
    if (this.activeResearch(actor) !== null) throw new WritingError('research-active', 'This Session already has an active research plan')
    const startSeq = 0
    const plan = this.artifact(current.id, 1, JSON.stringify({ version: 1, novelId: current.id, briefArtifactId: request.briefArtifactId, sessionId: actor.sessionId, startSeq, questions }), 'research-plan')
    const evidence = this.artifact(current.id, 1, JSON.stringify({
      version: 3, novelId: current.id, planId: plan.id, briefArtifactId: request.briefArtifactId, sessionId: actor.sessionId, startSeq,
      outcome: 'not-needed', observations: [], findings: findings.map(finding => ({ ...finding, outcome: 'not-needed' as const })),
    }), 'research-evidence')
    researchContent(researchPlanContentSchema, plan.text)
    researchContent(researchEvidenceContentSchema, evidence.text)
    await this.domain.table('artifacts').put(plan.id, plan)
    await this.domain.table('artifacts').put(evidence.id, evidence)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(current.id, record => {
      actor.signal?.throwIfAborted()
      const duplicate = record.researchHistory.find(item => item.sessionId === actor.sessionId && item.startRequest.requestId === request.requestId)
      if (duplicate !== undefined) {
        this.sameRequest(duplicate.startRequest.hash, startHash)
        if (duplicate.completeRequest === null || duplicate.outcome !== 'not-needed') throw new WritingError('request-conflict', 'Request id already started a different research plan')
        this.sameRequest(duplicate.completeRequest.hash, completeHash)
        return record
      }
      this.currentResearchBrief(record, request.briefArtifactId)
      if (record.researchHistory.some(item => item.sessionId === actor.sessionId && item.outcome === null && item.briefArtifactId === view(record).brief.id)) {
        throw new WritingError('research-active', 'This Session already has an active research plan')
      }
      const entry: ResearchRecord = {
        plan: reference(plan), result: reference(evidence), briefArtifactId: request.briefArtifactId, sessionId: actor.sessionId,
        startSeq, questions, reservedCalls: [], outcome: 'not-needed',
        startRequest: { requestId: request.requestId, hash: startHash }, completeRequest: { requestId: request.requestId, hash: completeHash },
      }
      return { ...record, researchHistory: [...record.researchHistory, entry] }
    })
    const stored = updated.researchHistory.find(item => item.sessionId === actor.sessionId && item.startRequest.requestId === request.requestId)
    if (stored === undefined) throw new WritingError('corrupt-artifact', 'Skipped research plan receipt is missing')
    return this.getResearch(actor, { novelId: updated.id, planId: stored.plan.id })
  }

  private researchView(novel: NovelRecord, record: ResearchRecord): ResearchView {
    const { startRequest: _start, completeRequest: _complete, ...state } = record
    return structuredClone({ novelId: novel.id, planId: record.plan.id, stale: view(novel).brief.id !== record.briefArtifactId, ...state })
  }

  private researchRecord(novel: NovelRecord, planId: ArtifactId): ResearchRecord {
    const research = novel.researchHistory.find(item => item.plan.id === planId)
    if (research === undefined) throw new WritingError('research-not-found', 'planId is not published in this novel')
    return research
  }

  private activeResearch(actor: Actor): ResearchView | null {
    for (const [, novel] of this.domain.table('novels').entries()) {
      if (novel.workspace !== actor.workspace) continue
      const research = novel.researchHistory.find(item => item.sessionId === actor.sessionId && item.outcome === null && item.briefArtifactId === view(novel).brief.id)
      if (research !== undefined) return this.researchView(novel, research)
    }
    return null
  }

  private researchOwner(actor: Actor, plan: ResearchRecord): void {
    if (plan.sessionId !== actor.sessionId) throw new WritingError('session-mismatch', 'Research calls and completion belong to the plan Session')
  }

  private currentResearchBrief(novel: NovelRecord, briefArtifactId: ArtifactId): void {
    if (view(novel).brief.id !== briefArtifactId) throw new WritingError('revision-conflict', 'Research plan does not match the current creative brief')
  }

  private researchObservations(plan: ResearchRecord, observations: readonly Pick<ResearchObservation, 'callId' | 'name' | 'callSeq' | 'resultSeq'>[]): void {
    if (new Set(observations.map(item => item.callId)).size !== observations.length
      || observations.length !== plan.reservedCalls.length
      || observations.some(item => !plan.reservedCalls.some(call => call.callId === item.callId && call.name === item.name))) {
      throw new WritingError('research-incomplete', 'Every reserved native web call requires its own settled observation')
    }
    if (observations.some(item => item.callSeq < plan.startSeq || item.resultSeq <= item.callSeq)) {
      throw new WritingError('research-incomplete', 'Research observations must follow their plan and native call')
    }
  }

  /** @param actor - Authorized workspace. @param novelId - Exact novel. @param dimensionCode - Catalog dimension. @param researchPlanId - Completed current research. @param revisionOf - Current applied dimension retained as revision lineage. @returns Exact current inputs for one dimension. */
  settingsInputs(actor: Actor, novelId: NovelId, dimensionCode: string, researchPlanId: ArtifactId, revisionOf?: ArtifactId): ArtifactRef[] {
    const novel = this.record(actor, novelId)
    const dimension = settingsCatalog.find(item => item.code === dimensionCode)
    if (dimension === undefined || !dimension.enabled || dimension.kind === 'edit_external') throw new WritingError('invalid-input', 'Settings dimension is not available for generation')
    const research = this.getResearch(actor, { novelId, planId: researchPlanId })
    if (research.stale || research.result === null || !['succeeded', 'not-needed'].includes(research.outcome ?? '')) {
      throw new WritingError('research-incomplete', 'Settings require completed adequate research for the current creative brief')
    }
    const dependencies = dimension.dependsOn.map(code => {
      const candidate = novel.settingsHistory.find(item => item.artifact.id === novel.settingsHeads.find(head => head.dimensionCode === code)?.artifactId)
      if (candidate === undefined || this.settingsStale(novel, candidate)) throw new WritingError('revision-conflict', `Settings prerequisite is missing or stale: ${code}`)
      this.validateSettings(actor, novel, candidate)
      return candidate.artifact
    })
    const inputs = [view(novel).brief, research.result, ...dependencies]
    if (revisionOf !== undefined) inputs.push(this.settingsRevisionBase(actor, novel, dimensionCode, revisionOf, true).artifact)
    for (const input of inputs) this.getArtifact(actor, { novelId, artifactId: input.id })
    return inputs
  }

  /** @param actor - Authorized workspace. @param request - Native stage output for exact current inputs. @returns A durable candidate; review and adoption are separate commands. */
  async saveSettingsCandidate(actor: Actor, request: SaveSettingsCandidateRequest): Promise<SettingsCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const replay = novel.settingsHistory.find(item => item.request.requestId === request.requestId)
    const inputRefs = replay === undefined
      ? this.settingsInputs(actor, novel.id, request.dimensionCode, request.researchPlanId, request.revisionOf).map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
      : replay.inputRefs
    const output = parseSettingsDimensionOutput(request.output, { dimensionCode: request.dimensionCode, inputRefs })
    // The scope bound applies only to a freshly admitted model output; readback and idempotent replay stay structural so an earlier-admitted candidate remains durably readable.
    if (replay === undefined) {
      const dimension = settingsCatalog.find(item => item.code === request.dimensionCode)
      if (dimension === undefined) throw new WritingError('invalid-input', 'Settings dimension is not available for generation')
      checkSettingsDimensionScope(output, dimension.kind)
    }
    const text = JSON.stringify(output)
    const hash = settingsHash({ researchPlanId: request.researchPlanId, childSessionId: request.childSessionId, revisionOf: request.revisionOf ?? null }, output)
    if (replay !== undefined) {
      this.sameRequest(replay.request.hash, hash)
      this.validateSettings(actor, novel, replay)
      return this.settingsView(novel, replay)
    }
    checkModelArtifactBytes(text, this.limits.maxArtifactBytes, 'Settings dimension output')
    const artifact = this.artifact(novel.id, 1, text, 'settings-dimension')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const duplicate = current.settingsHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { this.sameRequest(duplicate.request.hash, hash); return current }
      const actual = this.settingsInputs(actor, current.id, request.dimensionCode, request.researchPlanId, request.revisionOf).map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
      if (!isDeepStrictEqual(actual, inputRefs)) throw new WritingError('revision-conflict', 'Settings inputs changed before candidate publication')
      return { ...current, settingsHistory: [...current.settingsHistory, {
        artifact: reference(artifact), dimensionCode: request.dimensionCode, researchPlanId: request.researchPlanId,
        inputRefs, revisionOf: request.revisionOf ?? null, childSessionId: request.childSessionId, request: { requestId: request.requestId, hash }, reviewHistory: [], applied: false,
      }] }
    })
    const saved = updated.settingsHistory.find(item => item.request.requestId === request.requestId)
    if (saved === undefined) throw new WritingError('corrupt-artifact', 'Settings candidate receipt is missing')
    return this.settingsView(updated, saved)
  }

  /**
   * Adopt author text for one dimension in place of its current head, without a model stage or per-dimension review.
   * The record reuses the replaced head's research plan, keeps it as revisionOf, and is marked origin 'import'; it stays
   * pendingReview until a settings collection containing it passes review. The writing runner refuses this while a run is unfinished.
   * @param actor - Importing Session. @param request - Exact head to replace and the complete document.
   * @param assertAdmissible - Checked synchronously inside the novel update, immediately before publication.
   * @returns The adopted import.
   */
  async importSettings(actor: Actor, request: ImportSettingsRequest, assertAdmissible: () => void = () => {}): Promise<SettingsCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const dimension = settingsCatalog.find(item => item.code === request.dimensionCode)
    if (dimension === undefined || !dimension.enabled || dimension.kind === 'edit_external') throw new WritingError('invalid-input', 'Settings dimension is not available for import')
    if (typeof request.output !== 'object' || request.output === null || Array.isArray(request.output)) throw new WritingError('invalid-input', 'Imported settings must be one settings-dimension JSON object')
    const replay = novel.settingsHistory.find(item => item.request.requestId === request.requestId)
    if (replay !== undefined) {
      if (replay.origin !== 'import' || replay.dimensionCode !== request.dimensionCode || replay.revisionOf !== request.expectedAppliedId) throw new WritingError('request-conflict', 'Request id was already used with different input')
      const output = parseSettingsDimensionOutput({ ...request.output, inputRefs: replay.inputRefs }, { dimensionCode: request.dimensionCode, inputRefs: replay.inputRefs })
      // The importing Session is record metadata, not request input: a retry from a new process or Session replays the same import.
      if (!settingsReceiptMatches(replay.request.hash, replay, output)) throw new WritingError('request-conflict', 'Request id was already used with different input')
      this.validateSettings(actor, novel, replay)
      return this.settingsView(novel, replay)
    }
    const headId = novel.settingsHeads.find(head => head.dimensionCode === request.dimensionCode)?.artifactId
    if (headId === undefined) throw new WritingError('invalid-input', 'expectedAppliedId does not match an adopted settings head; this dimension has none yet')
    if (headId !== request.expectedAppliedId) throw new WritingError('revision-conflict', 'expectedAppliedId is not the current settings head')
    const base = this.settingsCandidate(novel, headId)
    const inputRefs = this.settingsInputs(actor, novel.id, request.dimensionCode, base.researchPlanId, base.artifact.id).map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
    const output = parseSettingsDimensionOutput({ ...request.output, inputRefs }, { dimensionCode: request.dimensionCode, inputRefs })
    checkSettingsDimensionScope(output, dimension.kind)
    const text = JSON.stringify(output)
    checkModelArtifactBytes(text, this.limits.maxArtifactBytes, 'Imported settings')
    const hash = settingsHash({ origin: 'import', researchPlanId: base.researchPlanId, childSessionId: request.childSessionId, revisionOf: base.artifact.id }, output)
    const artifact = this.artifact(novel.id, 1, text, 'settings-dimension')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const duplicate = current.settingsHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { if (!settingsReceiptMatches(duplicate.request.hash, { ...duplicate, origin: 'import' }, output)) throw new WritingError('request-conflict', 'Request id was already used with different input'); return current }
      if (current.settingsHeads.find(head => head.dimensionCode === request.dimensionCode)?.artifactId !== base.artifact.id) throw new WritingError('revision-conflict', 'Another settings version was adopted before this import')
      const actual = this.settingsInputs(actor, current.id, request.dimensionCode, base.researchPlanId, base.artifact.id).map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
      if (!isDeepStrictEqual(actual, inputRefs)) throw new WritingError('revision-conflict', 'Settings inputs changed before import')
      assertAdmissible()
      return { ...current,
        settingsHistory: [...current.settingsHistory, { artifact: reference(artifact), dimensionCode: request.dimensionCode, researchPlanId: base.researchPlanId, inputRefs,
          revisionOf: base.artifact.id, childSessionId: request.childSessionId, request: { requestId: request.requestId, hash }, reviewHistory: [], applied: true, origin: 'import' as const }],
        settingsHeads: [...current.settingsHeads.filter(head => head.dimensionCode !== request.dimensionCode), { dimensionCode: request.dimensionCode, artifactId: artifact.id }],
      }
    })
    const saved = updated.settingsHistory.find(item => item.request.requestId === request.requestId)
    if (saved === undefined) throw new WritingError('corrupt-artifact', 'Settings import receipt is missing')
    return this.settingsView(updated, saved)
  }

  /** @param actor - Authorized workspace. @param novelId - Exact novel. @returns Retained candidates and the latest adopted version of each dimension. */
  getSettings(actor: Actor, novelId: NovelId): SettingsView {
    const novel = this.record(actor, novelId)
    for (const candidate of novel.settingsHistory) this.validateSettings(actor, novel, candidate)
    for (const candidate of novel.settingsHistory) this.validateSettingsReviews(actor, novel, candidate)
    const history = novel.settingsHistory.map(candidate => this.settingsView(novel, candidate))
    const applied = novel.settingsHeads.map(head => {
      const candidate = history.find(item => item.artifact.id === head.artifactId && item.dimensionCode === head.dimensionCode && item.status === 'applied')
      if (candidate === undefined) throw new WritingError('corrupt-artifact', 'Settings head is not an adopted version')
      return candidate
    })
    return { history, applied }
  }

  /** @param actor - Authorized workspace. @param request - Exact candidate and independent review output. @returns The candidate with its immutable review attached. */
  async saveSettingsReview(actor: Actor, request: SaveSettingsReviewRequest): Promise<SettingsCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const candidate = this.settingsCandidate(novel, request.candidateId)
    const output = this.settingsReviewOutput(actor, novel, candidate, request.output)
    const hash = createHash('sha256').update(JSON.stringify([request.childSessionId, request.expectedReviewId, output])).digest('hex')
    const replay = candidate.reviewHistory.find(item => item.request.requestId === request.requestId)
    if (replay !== undefined) { this.sameRequest(replay.request.hash, hash); return this.settingsView(novel, candidate) }
    if ((candidate.reviewHistory.at(-1)?.artifact.id ?? null) !== request.expectedReviewId) throw new WritingError('revision-conflict', 'A newer settings review already exists')
    if (candidate.applied) throw new WritingError('review-blocked', 'Create a new candidate before changing an applied settings review')
    if (this.settingsStale(novel, candidate)) throw new WritingError('revision-conflict', 'Settings candidate has stale inputs')
    checkModelArtifactBytes(JSON.stringify(output), this.limits.maxArtifactBytes, 'Review output')
    const artifact = this.artifact(novel.id, 1, JSON.stringify(output), 'review')
    await this.domain.table('artifacts').put(artifact.id, artifact)
    actor.signal?.throwIfAborted()
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const active = this.settingsCandidate(current, candidate.artifact.id)
      const duplicate = active.reviewHistory.find(item => item.request.requestId === request.requestId)
      if (duplicate !== undefined) { this.sameRequest(duplicate.request.hash, hash); return current }
      if ((active.reviewHistory.at(-1)?.artifact.id ?? null) !== request.expectedReviewId) throw new WritingError('revision-conflict', 'Settings review changed before publication')
      if (active.applied) throw new WritingError('review-blocked', 'Settings were adopted before this review completed')
      if (this.settingsStale(current, active)) throw new WritingError('revision-conflict', 'Settings inputs changed before review publication')
      return { ...current, settingsHistory: current.settingsHistory.map(item => item.artifact.id === active.artifact.id
        ? { ...item, reviewHistory: [...item.reviewHistory, { artifact: reference(artifact), request: { requestId: request.requestId, hash }, childSessionId: request.childSessionId, blocking: output.issues.some(issue => issue.severity === 'blocking') }] }
        : item) }
    })
    return this.settingsView(updated, this.settingsCandidate(updated, candidate.artifact.id))
  }

  /** @param actor - Authorized workspace. @param request - Exact review and expected adopted head. @returns The adopted version after one queued update, or an idempotent replay. */
  async applySettingsCandidate(actor: Actor, request: ApplySettingsCandidateRequest): Promise<SettingsCandidateView> {
    actor.signal?.throwIfAborted()
    const novel = this.record(actor, request.novelId)
    const candidate = this.settingsCandidate(novel, request.candidateId)
    const review = candidate.reviewHistory.at(-1)
    if (review === undefined || review.artifact.id !== request.reviewId) throw new WritingError('review-blocked', 'Adoption requires the latest exact review of this candidate')
    const stored = this.getArtifact(actor, { novelId: novel.id, artifactId: review.artifact.id })
    const outcome = this.settingsReviewOutput(actor, novel, candidate, JSON.parse(stored.text))
    if (outcome.issues.some(issue => issue.severity === 'blocking')) throw new WritingError('review-blocked', 'Settings still have blocking review issues')
    if (candidate.applied) return this.settingsView(novel, candidate)
    const updated = await this.domain.table('novels').update(novel.id, current => {
      actor.signal?.throwIfAborted()
      const active = this.settingsCandidate(current, candidate.artifact.id)
      if (active.applied) return current
      if (this.settingsStale(current, active)) throw new WritingError('revision-conflict', 'Settings inputs changed before adoption')
      if (active.reviewHistory.at(-1)?.artifact.id !== request.reviewId) throw new WritingError('review-blocked', 'Settings review changed before adoption')
      const head = current.settingsHeads.find(item => item.dimensionCode === active.dimensionCode)
      if ((head?.artifactId ?? null) !== request.expectedAppliedId || (active.revisionOf !== null && request.expectedAppliedId !== active.revisionOf)) throw new WritingError('revision-conflict', 'Another settings version was adopted before this request')
      return { ...current,
        settingsHistory: current.settingsHistory.map(item => item.artifact.id === active.artifact.id ? { ...item, applied: true } : item),
        settingsHeads: [...current.settingsHeads.filter(item => item.dimensionCode !== active.dimensionCode), { dimensionCode: active.dimensionCode, artifactId: active.artifact.id }],
      }
    })
    return this.settingsView(updated, this.settingsCandidate(updated, candidate.artifact.id))
  }

  private validateSettingsReviews(actor: Actor, novel: NovelRecord, candidate: SettingsRecord): void {
    try {
      for (const review of candidate.reviewHistory) {
        const artifact = this.getArtifact(actor, { novelId: novel.id, artifactId: review.artifact.id })
        const parsed = this.settingsReviewOutput(actor, novel, candidate, JSON.parse(artifact.text))
        if (parsed.issues.some(issue => issue.severity === 'blocking') !== review.blocking) throw new Error('Review status differs from immutable findings')
      }
      const latest = candidate.reviewHistory.at(-1)
      if (candidate.applied && candidate.origin !== 'import' && (latest === undefined || latest.blocking)) throw new Error('An applied settings candidate requires a nonblocking review')
    } catch (cause) { throw new WritingError('corrupt-artifact', 'Settings review or adoption status cannot be verified', { cause }) }
  }

  private settingsCandidate(novel: NovelRecord, id: ArtifactId): SettingsRecord {
    const candidate = novel.settingsHistory.find(item => item.artifact.id === id)
    if (candidate === undefined) throw new WritingError('settings-not-found', 'Settings candidate is not published in this novel')
    return candidate
  }

  private settingsReviewOutput(actor: Actor, novel: NovelRecord, candidate: SettingsRecord, output: unknown) {
    const refs = [{ artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, ...candidate.inputRefs]
    const sources = refs.map(ref => {
      const artifact = this.getArtifact(actor, { novelId: novel.id, artifactId: ref.artifactId })
      if (artifact.sha256 !== ref.sha256) throw new WritingError('corrupt-artifact', 'Review source differs from its saved hash')
      return { artifactId: artifact.id, text: artifact.text }
    })
    const reviewed = { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }
    const stored = this.getArtifact(actor, { novelId: novel.id, artifactId: candidate.artifact.id })
    if (isOpenChecklistCode(candidate.dimensionCode) && isRawChecklist(output)) {
      return admitOpenDimensionChecklist(output, { dimensionCode: candidate.dimensionCode, reviewed, inputRefs: candidate.inputRefs,
        paragraphs: paragraphsOfStoredCandidate(stored.kind, stored.text), evidenceSources: sources })
    }
    return parseReviewOutput(output, { reviewed, inputRefs: candidate.inputRefs, requiredChecks: ['completeness', 'consistency'], evidenceSources: sources,
      acceptAdvisoryCompleteness: true, ...(hasParagraphCitation(output) ? { paragraphs: paragraphsOfStoredCandidate(stored.kind, stored.text) } : {}) })
  }

  private validateSettings(actor: Actor, novel: NovelRecord, candidate: SettingsRecord, seen = new Set<ArtifactId>()): void {
    if (seen.has(candidate.artifact.id)) throw new WritingError('corrupt-artifact', 'Settings input references contain a cycle')
    const path = new Set([...seen, candidate.artifact.id])
    try {
      const artifact = this.getArtifact(actor, { novelId: novel.id, artifactId: candidate.artifact.id })
      const output = parseSettingsDimensionOutput(JSON.parse(artifact.text), { dimensionCode: candidate.dimensionCode, inputRefs: candidate.inputRefs })
      const dimension = settingsCatalog.find(item => item.code === candidate.dimensionCode)
      if (dimension === undefined) throw new Error('Unknown indexed settings dimension')
      const research = this.getResearch(actor, { novelId: novel.id, planId: candidate.researchPlanId })
      if (research.result === null || (research.outcome !== 'succeeded' && research.outcome !== 'not-needed')) throw new Error('Settings evidence is not complete')
      const expected = [research.briefArtifactId, research.result.id]
      for (const code of dimension.dependsOn) {
        const dependency = novel.settingsHistory.find(item => item.dimensionCode === code && candidate.inputRefs.some(ref => ref.artifactId === item.artifact.id))
        if (dependency === undefined || !dependency.applied) throw new Error('Settings input is not an adopted prerequisite')
        this.validateSettings(actor, novel, dependency, path)
        expected.push(dependency.artifact.id)
      }
      if (candidate.revisionOf !== null) {
        if (candidate.inputRefs.at(-1)?.artifactId !== candidate.revisionOf) throw new Error('Settings revision lineage must be the final indexed source')
        const base = this.settingsCandidate(novel, candidate.revisionOf)
        if (!base.applied || base.dimensionCode !== candidate.dimensionCode || novel.settingsHistory.indexOf(base) >= novel.settingsHistory.indexOf(candidate)) throw new Error('Settings revision must retain an earlier applied version of this dimension')
        this.validateSettings(actor, novel, base, path)
        expected.push(base.artifact.id)
      }
      if (candidate.origin === 'import' && (candidate.revisionOf === null || !candidate.applied || candidate.reviewHistory.length > 0)) throw new Error('An imported settings version must be an adopted, unreviewed replacement of an earlier version')
      if (!settingsReceiptMatches(candidate.request.hash, candidate, output)) throw new Error('Settings provenance differs from its publication receipt')
      if (candidate.inputRefs.length !== expected.length || candidate.inputRefs.some(ref => !expected.includes(ref.artifactId))) throw new Error('Settings index differs from its required source versions')
      for (const input of candidate.inputRefs) {
        const source = this.getArtifact(actor, { novelId: novel.id, artifactId: input.artifactId })
        if (source.sha256 !== input.sha256) throw new Error('Settings input hash differs from its stored source')
      }
    } catch (cause) {
      throw new WritingError('corrupt-artifact', 'Settings metadata or source content cannot be verified', { cause })
    }
  }

  private settingsRevisionBase(actor: Actor, novel: NovelRecord, dimensionCode: string, revisionOf: ArtifactId, current: boolean): SettingsRecord {
    const base = this.settingsCandidate(novel, revisionOf)
    if (!base.applied || base.dimensionCode !== dimensionCode) throw new WritingError('invalid-input', 'Revision base must be an applied version of the same settings dimension')
    this.validateSettings(actor, novel, base)
    this.validateSettingsReviews(actor, novel, base)
    if (current && novel.settingsHeads.find(head => head.dimensionCode === dimensionCode)?.artifactId !== base.artifact.id) throw new WritingError('revision-conflict', 'Settings revision base is no longer the current head')
    return base
  }

  private settingsStale(novel: NovelRecord, candidate: SettingsRecord): boolean {
    if (!candidate.applied && candidate.revisionOf !== null && novel.settingsHeads.find(head => head.dimensionCode === candidate.dimensionCode)?.artifactId !== candidate.revisionOf) return true
    for (const input of candidate.inputRefs) {
      if (input.artifactId === candidate.revisionOf) continue
      if (novel.briefHistory.some(ref => ref.id === input.artifactId) && view(novel).brief.id !== input.artifactId) return true
      const dependency = novel.settingsHistory.find(item => item.artifact.id === input.artifactId)
      if (dependency !== undefined) {
        const head = novel.settingsHistory.find(item => item.artifact.id === novel.settingsHeads.find(head => head.dimensionCode === dependency.dimensionCode)?.artifactId)
        if (head?.artifact.id !== input.artifactId || this.settingsStale(novel, dependency)) return true
      }
    }
    return false
  }

  private settingsView(novel: NovelRecord, candidate: SettingsRecord): SettingsCandidateView {
    const review = candidate.reviewHistory.at(-1)
    return structuredClone({ dimensionCode: candidate.dimensionCode, artifact: candidate.artifact,
      inputRefs: candidate.inputRefs, revisionOf: candidate.revisionOf, childSessionId: candidate.childSessionId, stale: this.settingsStale(novel, candidate),
      status: candidate.applied ? 'applied' : review === undefined ? 'candidate' : review.blocking ? 'blocked' : 'reviewed',
      review: review?.artifact ?? null, origin: candidate.origin ?? 'stage', pendingReview: this.importPending(novel, candidate) })
  }

  /**
   * Pending import: an imported current head with no passing settings-collection review since it was imported. Any collection
   * containing the import was assembled after it, and a review is admitted only while that collection's inputs are current, so a
   * collection whose latest review is nonblocking releases the import for good; later roots or upstream changes do not undo that.
   */
  private importPending(novel: NovelRecord, candidate: SettingsRecord): boolean {
    if (candidate.origin !== 'import') return false
    if (novel.settingsHeads.find(head => head.dimensionCode === candidate.dimensionCode)?.artifactId !== candidate.artifact.id) return false
    return !novel.manuscriptHistory.some(item => item.target.kind === 'settings' && item.inputRefs.some(ref => ref.artifactId === candidate.artifact.id)
      && item.reviewHistory.length > 0 && item.reviewHistory.at(-1)?.blocking === false)
  }

  /**
   * Remember a passed settings collection for a later run with the same brief text and roots.
   * @param actor - Owning workspace. @param novelId - Novel that holds the collection. @param snapshot - Content hash, requested roots, and the applied collection.
   */
  async saveSettingsSnapshot(actor: Actor, novelId: NovelId, snapshot: { readonly briefSha256: string; readonly roots: readonly string[]; readonly artifactId: ArtifactId }): Promise<void> {
    actor.signal?.throwIfAborted()
    const artifact = this.getArtifact(actor, { novelId, artifactId: snapshot.artifactId })
    if (artifact.kind !== 'settings') throw new WritingError('invalid-input', 'Settings snapshot must name a settings collection')
    const stored = { briefSha256: snapshot.briefSha256, roots: canonicalSettingsRoots(snapshot.roots), artifactId: snapshot.artifactId }
    await this.domain.table('novels').update(novelId, current => {
      actor.signal?.throwIfAborted()
      const existing = current.settingsSnapshots ?? []
      const rest = existing.filter(item => !(item.briefSha256 === stored.briefSha256 && sameSettingsRoots(item.roots, stored.roots)))
      if (rest.length === existing.length - 1 && existing.some(item => item.briefSha256 === stored.briefSha256 && sameSettingsRoots(item.roots, stored.roots) && item.artifactId === stored.artifactId)) return current
      return { ...current, settingsSnapshots: [...rest, stored] }
    })
  }

  /**
   * @param actor - Owning workspace. @param novelId - Novel to read. @param briefSha256 - Current brief content hash.
   * @param roots - Requested roots; order does not matter. @returns The matching snapshot whose collection is still published, if any.
   */
  /** @param actor - Owning workspace. @param novelId - Novel. @param requestId - Candidate publication id. @returns The stored candidate when that request was already saved. */
  findSettingsByRequest(actor: Actor, novelId: NovelId, requestId: RequestId): SettingsCandidateView | undefined {
    const novel = this.record(actor, novelId)
    const record = novel.settingsHistory.find(item => item.request.requestId === requestId)
    return record === undefined ? undefined : this.settingsView(novel, record)
  }

  findSettingsSnapshot(actor: Actor, novelId: NovelId, briefSha256: string, roots: readonly string[]): { readonly briefSha256: string; readonly roots: readonly string[]; readonly artifactId: ArtifactId } | undefined {
    const wanted = canonicalSettingsRoots(roots)
    const found = (this.record(actor, novelId).settingsSnapshots ?? []).find(item => item.briefSha256 === briefSha256 && sameSettingsRoots(item.roots, wanted))
    if (found === undefined) return undefined
    try {
      const artifact = this.getArtifact(actor, { novelId, artifactId: found.artifactId })
      if (artifact.kind !== 'settings') return undefined
    } catch { return undefined }
    return found
  }

  /** @returns Completion after the domain has drained its queued writes. */
  close(): Promise<void> { return this.domain.close() }

  private sameRequest(stored: string, received: string): void {
    if (stored !== received) throw new WritingError('request-conflict', 'Request id was already used with different input')
  }

  private briefRequest(record: NovelRecord, request: SaveBriefRequest, hash: string): number | undefined {
    if (record.createRequest.requestId === request.requestId) {
      throw new WritingError('request-conflict', 'Request id already created this novel')
    }
    const receipt = record.briefRequests.find(receipt => receipt.requestId === request.requestId)
    if (!receipt) return undefined
    this.sameRequest(receipt.hash, hash)
    return receipt.revision
  }

  private selectionKey(actor: Actor): string {
    return createHash('sha256').update(JSON.stringify([actor.workspace, actor.sessionId])).digest('hex')
  }

  private record(actor: Actor, novelId: NovelId): NovelRecord {
    const record = this.domain.table('novels').get(novelId)
    if (!record) throw new WritingError('novel-not-found', 'novelId does not exist')
    if (record.workspace !== actor.workspace) throw new WritingError('workspace-mismatch', 'Novel belongs to another workspace')
    return record
  }

  private artifact<K extends ArtifactKind>(novelId: NovelId, revision: number, text: string, kind: K): Artifact<K> {
    const bytes = this.artifactSize(text)
    return {
      id: brandString<ArtifactId>(`artifact_${randomUUID()}`), novelId, kind, revision, text,
      sha256: createHash('sha256').update(text).digest('hex'), chars: [...text].length, bytes,
    }
  }

  private artifactSize(text: string): number {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.limits.maxArtifactBytes) throw new WritingError('artifact-too-large', 'Artifact exceeds the configured UTF-8 byte limit')
    return bytes
  }
}

type SettingsReceiptRecord = { readonly origin?: 'stage' | 'import' | undefined; readonly researchPlanId: ArtifactId; readonly childSessionId: string; readonly revisionOf: ArtifactId | null }

/**
 * Publication receipt: an import is prefixed so it can never pass as, or be passed off as, a model-stage record.
 * A stage receipt binds its native child Session; an import receipt does not, because the importing Session is only
 * record metadata (childSessionId) and a retry of the same requestId from another process must replay, not conflict.
 */
function settingsHash(record: SettingsReceiptRecord, output: unknown): string {
  const lineage = record.revisionOf === null ? [] : [record.revisionOf]
  const body = record.origin === 'import' ? ['import', record.researchPlanId, output, ...lineage] : [record.researchPlanId, record.childSessionId, output, ...lineage]
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/** @returns Whether a stored receipt matches; import receipts written before the importing Session left the hash (#18, 8675246) still verify against their own recorded Session. */
function settingsReceiptMatches(stored: string, record: SettingsReceiptRecord, output: unknown): boolean {
  if (stored === settingsHash(record, output)) return true
  if (record.origin !== 'import') return false
  const lineage = record.revisionOf === null ? [] : [record.revisionOf]
  return stored === createHash('sha256').update(JSON.stringify(['import', record.researchPlanId, record.childSessionId, output, ...lineage])).digest('hex')
}

/** @param facility - The host's mounted storage domain service. @param limits - Explicit size limits. @param researchLimits - Explicit research limits. @param manuscriptLimits - Explicit inclusive chapter word bounds. @returns One domain-owning writing service. */
export async function openWritingService(facility: DomainFacility, limits: WritingLimits, researchLimits: ResearchLimits, manuscriptLimits: ManuscriptLimits): Promise<WritingService> {
  if (!Number.isSafeInteger(limits.maxArtifactBytes) || limits.maxArtifactBytes < 1
    || !Number.isSafeInteger(limits.maxReadChars) || limits.maxReadChars < 1) {
    throw new WritingError('invalid-input', 'Writing limits must be finite positive integers')
  }
  if ([researchLimits.maxResearchQuestions, researchLimits.maxResearchCalls, researchLimits.maxResearchSources,
    researchLimits.maxEvidenceChars, researchLimits.maxResearchLogEvents].some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new WritingError('invalid-input', 'Research limits must be finite positive integers')
  }
  if (!Number.isSafeInteger(manuscriptLimits.minChapterWords) || manuscriptLimits.minChapterWords < 1
    || !Number.isSafeInteger(manuscriptLimits.maxChapterWords) || manuscriptLimits.maxChapterWords < manuscriptLimits.minChapterWords) {
    throw new WritingError('invalid-input', 'Manuscript chapter bounds must be positive safe integers with minimum no greater than maximum')
  }
  return new WritingService(await facility.open(writingDomain), Object.freeze({ ...limits }), Object.freeze({ ...researchLimits }), Object.freeze({ ...manuscriptLimits }))
}
