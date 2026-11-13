/** Versioned settings candidates and their host-owned adoption state. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ArtifactId, ArtifactRef, NovelId, RequestId } from './contracts.ts'
import type { ReviewAdmission, StageInputRef } from './stage-output.ts'

/** Host submission of one completed stage; callers cannot request automatic adoption. */
export interface SaveSettingsCandidateRequest {
  readonly novelId: NovelId
  readonly requestId: RequestId
  readonly dimensionCode: string
  /** Current applied version being revised; omitted for generation without revision lineage. */
  readonly revisionOf?: ArtifactId
  readonly researchPlanId: ArtifactId
  readonly childSessionId: SessionId
  readonly output: unknown
}
/** Exact settings version, review and validity against current source versions. */
export interface SettingsCandidateView {
  readonly dimensionCode: string
  /** Earlier applied version retained as reference material rather than an active dependency. */
  readonly revisionOf: ArtifactId | null
  readonly artifact: ArtifactRef<'settings-dimension'>
  readonly inputRefs: readonly StageInputRef[]
  readonly childSessionId: SessionId
  readonly status: 'candidate' | 'reviewed' | 'blocked' | 'applied'
  readonly stale: boolean
  readonly review: ArtifactRef<'review'> | null
  /** 'import' marks author text adopted through story_settings_import without a per-dimension review. */
  readonly origin: 'stage' | 'import'
  /**
   * Derived, never stored: an imported current head that no settings collection containing it has passed (latest review nonblocking) since the import. Release is sticky.
   * Until it clears, no downstream stage can use the collection, so it does not count as complete settings.
   */
  readonly pendingReview: boolean
}
/** Author text that replaces one adopted dimension without a model stage; the host derives every input reference. */
export interface ImportSettingsRequest {
  readonly novelId: NovelId
  readonly requestId: RequestId
  readonly dimensionCode: string
  /** The current head being replaced; it becomes revisionOf and lends its research plan. */
  readonly expectedAppliedId: ArtifactId
  /** Complete settings-dimension document; its inputRefs are replaced by the host-derived current inputs. */
  readonly output: unknown
  /** The importing Session, recorded as the provenance owner. */
  readonly childSessionId: SessionId
}
/** Current adopted dimensions and all historical candidates. */
export interface SettingsView { readonly applied: readonly SettingsCandidateView[]; readonly history: readonly SettingsCandidateView[] }

/** Exact candidate under its owning novel. */
export interface SettingsCandidateRequest { readonly novelId: NovelId; readonly candidateId: ArtifactId }
/** Review output from an independent native stage; no approval boolean is accepted. */
export interface SaveSettingsReviewRequest extends SettingsCandidateRequest {
  readonly expectedReviewId: ArtifactId | null
  readonly requestId: RequestId
  readonly output: unknown
  readonly childSessionId: SessionId
  /** Prompt version 8 model reviews. Host-synthesized reviews omit it. */
  readonly admission?: ReviewAdmission
}
/** Compare-and-adopt the exact reviewed version without replacing an unexpected head. */
export interface ApplySettingsCandidateRequest extends SettingsCandidateRequest {
  readonly reviewId: ArtifactId
  readonly expectedAppliedId: ArtifactId | null
}
