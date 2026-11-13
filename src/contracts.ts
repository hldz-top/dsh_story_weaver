/** Public identifiers, requests, and immutable writing-service results. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessError, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

/** Server-generated novel identity, independent of a Session or filesystem path. */
export type NovelId = Branded<'story-novel'>
/** Server-generated immutable artifact identity. */
export type ArtifactId = Branded<'story-artifact'>
/** Caller-supplied idempotency identity; at most 256 characters. */
export type RequestId = Branded<'story-request'>

/** Durable and tool-boundary novel identifier parser. */
export const novelIdSchema = z.string().regex(/^novel_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(brandString<NovelId>)
/** Durable and tool-boundary artifact identifier parser. */
export const artifactIdSchema = z.string().regex(/^artifact_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(brandString<ArtifactId>)
/** Requests preserve exact caller bytes; blank values are invalid. */
export const requestIdSchema = z.string().min(1).max(256).refine(value => value.trim().length > 0).transform(brandString<RequestId>)

/** @param value - Untrusted tool identifier. @returns Validated novel identity. */
export function parseNovelId(value: unknown): NovelId { return novelIdSchema.parse(value) }
/** @param value - Untrusted tool identifier. @returns Validated artifact identity. */
export function parseArtifactId(value: unknown): ArtifactId { return artifactIdSchema.parse(value) }
/** @param value - Untrusted idempotency key. @returns Validated request identity. */
export function parseRequestId(value: unknown): RequestId { return requestIdSchema.parse(value) }

/** Host-admitted Session and its resolved workspace display path. */
export interface Actor {
  readonly sessionId: SessionId
  readonly workspace: string
  /** Invocation-only cancellation; never included in durable records. */
  readonly signal?: AbortSignal
}
/** Explicit deployment limits; byte sizes are UTF-8, read offsets count Unicode code points. */
export interface WritingLimits { readonly maxArtifactBytes: number; readonly maxReadChars: number }
/** Explicit per-plan evidence and native web-call limits. */
export interface ResearchLimits {
  readonly maxResearchQuestions: number
  readonly maxResearchCalls: number
  readonly maxResearchSources: number
  readonly maxEvidenceChars: number
  readonly maxResearchLogEvents: number
}
/** Immutable documents published by the writing service. */
export const artifactKinds = ['creative-brief', 'research-plan', 'research-evidence', 'settings-dimension', 'review', 'settings', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'] as const
/** Stored artifact discriminator shared by tool and storage JSON validation. */
export type ArtifactKind = typeof artifactKinds[number]
/** Exact immutable document version. */
export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  readonly id: ArtifactId
  readonly kind: K
  readonly revision: number
  readonly sha256: string
  readonly chars: number
  readonly bytes: number
}
/** Full stored version, available only through bounded, ownership-checked reads. */
export interface Artifact<K extends ArtifactKind = ArtifactKind> extends ArtifactRef<K> { readonly novelId: NovelId; readonly text: string }
/** Novel metadata at one committed revision, without embedding long text. */
export interface NovelView {
  readonly id: NovelId
  readonly title: string
  readonly workspace: string
  readonly revision: number
  readonly brief: ArtifactRef<'creative-brief'>
  readonly briefHistory: readonly ArtifactRef<'creative-brief'>[]
}
/** Creation is workspace-idempotent and does not change Session selection. */
export interface CreateNovelRequest { readonly requestId: RequestId; readonly title: string; readonly brief: string }
/** Brief saves compare the current revision inside the durable update queue. */
export interface SaveBriefRequest {
  readonly novelId: NovelId
  readonly requestId: RequestId
  readonly expectedRevision: number
  readonly text: string
}
/** An exact version under an owned novel; no current-version substitution occurs. */
export interface ArtifactRequest { readonly novelId: NovelId; readonly artifactId: ArtifactId }
/** Requested character interval; limit must not exceed the configured maximum. */
export interface ReadArtifactRequest extends ArtifactRequest {
  readonly offset: number; readonly limit: number
  /** `prose` serves the reader-facing plain text (see prose-view.ts) instead of the stored text. `feed` serves the body-stage outline feed. Default `stored`. */
  readonly view?: ArtifactView
  /** Chapter whose outline feed is served. Used only when `view` is `feed`. */
  readonly feedChapter?: number
}
/** Which text of an artifact a read serves: the exact stored text, its reader-facing plain text, or the body-stage outline feed. */
export type ArtifactView = 'stored' | 'prose' | 'feed'
/** A Unicode code-point interval that can be continued until eof. */
export interface ArtifactSlice extends ArtifactRequest {
  readonly kind: ArtifactKind
  readonly revision: number
  readonly sha256: string
  readonly offset: number
  readonly nextOffset: number
  readonly totalChars: number
  readonly text: string
  readonly eof: boolean
  /** The served text; offsets, totalChars and text refer to it. sha256 always identifies the stored version. */
  readonly view: ArtifactView
}

/** A planning question; internal and creative questions require no external facts. */
export interface ResearchQuestion {
  readonly id: string
  readonly kind: 'internal' | 'creative' | 'external'
  readonly question: string
  readonly reason: string
}
/** A native web call reserved against one plan before execution. */
export interface ResearchCall { readonly callId: ToolCallId; readonly name: 'web_search' | 'web_fetch' }
/** An excerpt of a recorded source; sha256 covers the entire recorded source string. */
export interface ResearchSource {
  readonly sourceIndex: number
  readonly url: string
  readonly title: string | null
  readonly excerpt: string
  readonly offset: number
  readonly totalChars: number
  readonly sha256: string
  readonly truncated: boolean
}
/** Original native reference that cannot supply a usable HTTP(S) evidence source. */
export interface ResearchRejectedSource {
  readonly sourceIndex: number
  readonly reference: string
  readonly title: string | null
  readonly reason: 'unsupported-reference'
}
/** Host-verified call/result pair; rejected references retain original source indexes. */
export interface ResearchObservation extends ResearchCall {
  readonly input: { readonly queries: readonly string[] } | { readonly url: string }
  readonly callSeq: number
  readonly resultSeq: number
  readonly status: 'succeeded' | 'failed'
  readonly sources: readonly ResearchSource[]
  readonly rejectedSources: readonly ResearchRejectedSource[]
  readonly error: string | null
}
/** Model-authored interpretation of evidence; it cannot declare an execution successful. */
export interface ResearchFinding {
  readonly questionId: string
  readonly callIds: readonly ToolCallId[]
  readonly conclusion: string
  readonly adequate: boolean
}
/** Program-derived research completion classification, preserving every failed question. */
export type ResearchOutcome = 'not-needed' | 'succeeded' | 'insufficient' | 'failed'
/** Immutable plan input anchored to the current creative brief. */
export interface StartResearchRequest {
  readonly novelId: NovelId
  readonly requestId: RequestId
  readonly briefArtifactId: ArtifactId
  readonly questions: readonly ResearchQuestion[]
}
/** Exact research plan under its owning novel. */
export interface ResearchRequest { readonly novelId: NovelId; readonly planId: ArtifactId }
/** Readable research state; plan and result are independent immutable documents at revision 1, identified by id and hash. */
export interface ResearchView extends ResearchRequest {
  readonly stale: boolean
  readonly plan: ArtifactRef<'research-plan'>
  readonly result: ArtifactRef<'research-evidence'> | null
  readonly briefArtifactId: ArtifactId
  readonly sessionId: SessionId
  readonly startSeq: number
  readonly questions: readonly ResearchQuestion[]
  readonly reservedCalls: readonly ResearchCall[]
  readonly outcome: ResearchOutcome | null
}

/** Stable service errors for tool-facing failure reporting. */
export type WritingErrorCode = 'novel-not-found' | 'workspace-mismatch' | 'artifact-not-found' | 'request-conflict' | 'revision-conflict' | 'invalid-range' | 'artifact-too-large' | 'invalid-input' | 'corrupt-artifact' | 'closed' | 'research-not-found' | 'research-active' | 'research-budget' | 'research-incomplete' | 'session-mismatch' | 'settings-not-found' | 'review-blocked'
/** A rejected writing command; no success result is substituted. */
export class WritingError extends Error {
  constructor(readonly code: WritingErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'WritingError' }
}
/** Stable failure code for a new writing request whose settingsRoots closure lacks required novel settings. */
export const SETTINGS_INCOMPLETE = 'settings-incomplete'
/**
 * A refused new writing request or resume. It extends HarnessError so the host records `error: { name, code: 'settings-incomplete' }`
 * on the tool result outside model content. The message keeps the human sentence and ends with one JSON line
 * `{"code":"settings-incomplete","missing":[...]}`, because tool error text is the only channel that carries the missing codes.
 * A refused resume whose selected settings also hold imports awaiting review adds `"runId"` (the run to stop) and
 * `"importItems":[...]` (the same key and {@link ImportItem} format as `import-refused` and `review-blocked`); both are
 * omitted when no import is pending.
 */
export class SettingsIncompleteError extends HarnessError {
  /** Missing required codes in catalog order. */
  readonly missing: readonly string[]
  /** Selected imports still awaiting a collection review (resume only); empty when none, and then absent from the JSON line. */
  readonly importItems: readonly ImportItem[]
  /** @param runId - The refused resume's run, named in the stop hint and (with importItems) in the JSON line: while interrupted it holds the novel and a new story_update fails with active-run. */
  constructor(missing: readonly { readonly code: string; readonly name: string }[], importItems: readonly ImportItem[] = [], runId?: string) {
    const codes = missing.map(item => item.code)
    const pending = importItems.length === 0 ? '' : ` Imported settings also await a consistency review (${importItems.map(item => item.dimensionCode).join(', ')}); ${runId === undefined ? 'this run' : `run ${runId}`} cannot resume. Stop it if needed and start a new story_update to review them.`
    super(`Required novel settings are missing: ${missing.map(item => `${item.code} (${item.name})`).join(', ')}. Complete the settings first: choose settingsRoots whose dependencies cover ${missing.length === 1 ? 'it' : 'them'}; ["a4", "a5", "g2"] covers every required setting.${pending}\n${JSON.stringify({ code: SETTINGS_INCOMPLETE, missing: codes, ...(importItems.length === 0 ? {} : { ...(runId === undefined ? {} : { runId }), importItems }) })}`, SETTINGS_INCOMPLETE)
    this.name = 'SettingsIncompleteError'
    this.missing = Object.freeze(codes)
    this.importItems = Object.freeze([...importItems])
  }
}

/** One imported settings head named by an import refusal or an import-aware stop. */
export interface ImportItem { readonly dimensionCode: string; readonly artifactId: ArtifactId; readonly pendingReview: boolean }
/** Stable failure code for an author import, or a resume, refused because of writing-run state. */
export const IMPORT_REFUSED = 'import-refused'
/** run-active: the novel has a running or interrupted run; pending-review: a resumed run would skip the review an import awaits. */
export type ImportRefusalReason = 'run-active' | 'pending-review'
/**
 * A refused import or resume; like {@link SettingsIncompleteError} its message ends with one JSON line `{"code":"import-refused","reason":...}`.
 * `runId` names the unfinished run to stop (run-active) or the refused resume's run (pending-review) when known.
 */
export class ImportRefusedError extends HarnessError {
  constructor(readonly reason: ImportRefusalReason, message: string, readonly importItems: readonly ImportItem[] = [], readonly runId?: string) {
    super(`${message}\n${JSON.stringify({ code: IMPORT_REFUSED, reason, ...(runId === undefined ? {} : { runId }), ...(importItems.length === 0 ? {} : { importItems }) })}`, IMPORT_REFUSED)
    this.name = 'ImportRefusedError'
  }
}
/** ai-tone: blocked with no repair attempt configured; ai-tone-repeat: a repair left a reported span (or the whole body) unchanged; ai-tone-exhausted: repair attempts ran out. */
export type AiToneBlockReason = 'ai-tone' | 'ai-tone-repeat' | 'ai-tone-exhausted'
/**
 * The structured last line of every `review-blocked` stop, one discriminated union on `reason`: an import-aware settings
 * stop (no reason, or `stale-import`) names `importItems`; an AI-tone body stop names the blocking body `spans` and never
 * `importItems`.
 */
export type ReviewBlockedLine =
  | { readonly code: 'review-blocked'; readonly reason?: 'stale-import'; readonly importItems: readonly ImportItem[] }
  | { readonly code: 'review-blocked'; readonly reason: AiToneBlockReason; readonly spans: readonly string[] }
/** @param line - One member of {@link ReviewBlockedLine}. @returns Its JSON text, the last line of the error message. */
function reviewBlockedLine(line: ReviewBlockedLine): string { return JSON.stringify(line) }

/** A blocking settings-collection review that would regenerate imported author text; the run stops instead. Ends with `{"code":"review-blocked","importItems":[...]}`. */
export class ImportReviewBlockedError extends HarnessError {
  constructor(readonly importItems: readonly ImportItem[], readonly reason?: 'stale-import') {
    const codes = importItems.map(item => item.dimensionCode).join(', ')
    super(`${reason === 'stale-import'
      ? `Imported settings are out of date with their inputs (${codes}); stopped before regenerating any dimension, so imported text is not replaced. Import them again in dependency order (upstream first), then start a new story_update.`
      : `The settings collection review is blocking and repair would regenerate imported settings (${codes}); stopped without regenerating any dimension. Correct the imported text and import it again, then start a new story_update.`}\n${reviewBlockedLine(reason === undefined ? { code: 'review-blocked', importItems } : { code: 'review-blocked', reason, importItems })}`, 'review-blocked')
    this.name = 'ImportReviewBlockedError'
  }
}

/** Exact body excerpts kept per stop line: at most this many spans of at most AI_TONE_SPAN_CHARS code points each. */
const AI_TONE_MAX_SPANS = 20
const AI_TONE_SPAN_CHARS = 200
/**
 * A body whose review keeps reporting AI tone while aiToneBlocking is on (prompt version 5). The chapter is not applied.
 * Like the other stops its message ends with one JSON line `{"code":"review-blocked","reason":...,"spans":[...]}`.
 */
export class AiToneReviewBlockedError extends HarnessError {
  readonly spans: readonly string[]
  constructor(readonly reason: AiToneBlockReason, spans: readonly string[], key: string) {
    const kept = spans.slice(0, AI_TONE_MAX_SPANS).map(span => [...span].slice(0, AI_TONE_SPAN_CHARS).join(''))
    super(`${reason === 'ai-tone-repeat'
      ? `The body review for ${key} reported AI tone again after a repair left the same text in place; stopped for human review without further repair attempts. The chapter was not applied.`
      : reason === 'ai-tone-exhausted'
        ? `The body review for ${key} still reports AI tone after every allowed repair attempt; stopped with the chapter unapplied.`
        : `The body review for ${key} reports AI tone and no repair attempt is configured (maxRepairAttempts 0); stopped with the chapter unapplied.`} Revise the quoted passages, or turn aiToneBlocking off for new runs.\n${reviewBlockedLine({ code: 'review-blocked', reason, spans: kept })}`, 'review-blocked')
    this.name = 'AiToneReviewBlockedError'
    this.spans = Object.freeze(kept)
  }
}

/** @param spans - Blocking AI-tone excerpts of one body review. @returns The repair instruction handed to the next body attempt, ending with the same structured line (reason ai-tone). */
export function aiToneRepairInstruction(spans: readonly string[]): string {
  const kept = spans.slice(0, AI_TONE_MAX_SPANS).map(span => [...span].slice(0, AI_TONE_SPAN_CHARS).join(''))
  return `The body review reported AI tone in these exact passages of the narration; rewrite each one so that it no longer reads as AI tone, keeping the facts, events and voice, and return the complete chapter. Repeating a quoted passage unchanged stops the run for human review.\n${reviewBlockedLine({ code: 'review-blocked', reason: 'ai-tone', spans: kept })}`
}
