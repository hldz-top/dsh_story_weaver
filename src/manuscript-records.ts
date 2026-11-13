/** Durable manuscript candidates, review receipts, and atomic chapter applications. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { artifactIdSchema, requestIdSchema } from './contracts.ts'
import { StageOutputSchemas } from './stage-output.ts'

const inputRef = z.strictObject({ artifactId: artifactIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const chapterNumber = z.number().int().positive()
/** Generated stage request identifying its scope and mechanical expectations. */
export const manuscriptTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('settings'), selectedCodes: z.array(z.string().min(1)).nonempty() }),
  z.strictObject({ kind: z.literal('book-outline'), chapterCount: chapterNumber }),
  z.strictObject({ kind: z.literal('chapter-outline'), chapterNumber }),
  z.strictObject({ kind: z.literal('body'), chapterNumber }),
  z.strictObject({ kind: z.literal('continuity'), chapterNumber, bodyId: artifactIdSchema }),
  z.strictObject({ kind: z.literal('continuity-snapshot'), chapterNumber, bodyId: artifactIdSchema, continuityId: artifactIdSchema }),
])
/** Program-assembled selected dimensions, retaining their exact source content. */
export const settingsCollectionSchema = z.strictObject({
  version: z.literal(1), inputRefs: z.array(inputRef).nonempty(), selectedCodes: z.array(z.string().min(1)).nonempty(),
  dimensions: z.array(StageOutputSchemas.settings).nonempty(),
})
const reference = z.strictObject({
  id: artifactIdSchema, kind: z.enum(['settings', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']),
  revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chars: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
})
const receipt = z.strictObject({ requestId: requestIdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) })
const sessionId = z.string().min(1).transform(brandString<SessionId>)
const reviewReference = reference.extend({ kind: z.literal('review') })
/** A candidate and all immutable reviews; current heads live separately. */
export const manuscriptRecordSchema = z.strictObject({
  artifact: reference, target: manuscriptTargetSchema, inputRefs: z.array(inputRef).nonempty(), childSessionId: sessionId.nullable(), researchPlanId: artifactIdSchema.nullable(),
  request: receipt, reviewHistory: z.array(z.strictObject({ artifact: reviewReference, request: receipt, childSessionId: sessionId, blocking: z.boolean() })),
  applied: z.boolean(), revisionOf: artifactIdSchema.nullable(),
}).refine(record => record.artifact.kind === record.target.kind, 'Manuscript target and artifact kind must agree')
/** Current standalone applied document slots; bodies and continuity apply as a pair. */
export const manuscriptHeadSchema = z.strictObject({
  kind: z.enum(['settings', 'book-outline', 'chapter-outline']), chapterNumber: chapterNumber.nullable(), artifactId: artifactIdSchema,
}).refine(head => (head.kind === 'chapter-outline') === (head.chapterNumber !== null), 'Only chapter outlines have numbered heads')
/** One atomic publication of actual prose, reviewed continuity, and obligation outcomes. */
export const appliedChapterSchema = z.strictObject({
  chapterNumber, body: reference.extend({ kind: z.literal('body') }), bodyReview: reviewReference,
  continuity: reference.extend({ kind: z.literal('continuity') }), continuityReview: reviewReference,
  obligations: StageOutputSchemas.continuity.shape.obligations,
  wordBounds: z.strictObject({ minChapterWords: z.number().int().positive(), maxChapterWords: z.number().int().positive() })
    .refine(bounds => bounds.minChapterWords <= bounds.maxChapterWords, 'Chapter word bounds must be ordered'),
  /** Reviewed compact snapshot for this applied pair. Absent on records written before snapshots; null until review attaches one. */
  snapshot: reference.extend({ kind: z.literal('continuity-snapshot') }).nullable().optional(),
})
/** One retained candidate record. */
export type ManuscriptRecord = z.infer<typeof manuscriptRecordSchema>
/** One current applied document slot. */
export type ManuscriptHead = z.infer<typeof manuscriptHeadSchema>
/** Durable chapter application fields. */
export type AppliedChapterRecord = z.infer<typeof appliedChapterSchema>
