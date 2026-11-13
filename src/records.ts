/** Schema-validated authoritative records; long text is stored before novel references. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { artifactKinds, artifactIdSchema, novelIdSchema, requestIdSchema } from './contracts.ts'
import type { ArtifactId, NovelId } from './contracts.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { researchCallSchema, researchOutcomeSchema, researchQuestionSchema } from './research.ts'
import { manuscriptRecordSchema, manuscriptHeadSchema, appliedChapterSchema } from './manuscript-records.ts'

const artifactRefSchema = z.strictObject({
  id: artifactIdSchema,
  kind: z.literal('creative-brief'),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chars: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
const artifactSchema = artifactRefSchema.extend({ kind: z.enum(artifactKinds), novelId: novelIdSchema, text: z.string() })
const requestReceiptSchema = z.strictObject({ requestId: requestIdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) })
const researchRecordSchema = z.strictObject({
  plan: artifactRefSchema.extend({ kind: z.literal('research-plan') }),
  result: artifactRefSchema.extend({ kind: z.literal('research-evidence') }).nullable(),
  briefArtifactId: artifactIdSchema, sessionId: z.string().min(1).transform(brandString<SessionId>),
  startSeq: z.number().int().nonnegative(), questions: z.array(researchQuestionSchema).nonempty(),
  reservedCalls: z.array(researchCallSchema), outcome: researchOutcomeSchema.nullable(),
  startRequest: requestReceiptSchema, completeRequest: requestReceiptSchema.nullable(),
}).refine(record => (record.result === null) === (record.outcome === null)
  && (record.result === null) === (record.completeRequest === null), 'Research result, outcome and completion receipt must agree')
const legacyNovelSchema = z.strictObject({
  id: novelIdSchema,
  workspace: z.string().min(1),
  title: z.string().min(1),
  briefHistory: z.array(artifactRefSchema).nonempty(),
  createRequest: requestReceiptSchema,
  briefRequests: z.array(z.strictObject({ requestId: requestIdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive() })),
})
const legacySettingsRecordSchema = z.strictObject({
  artifact: artifactRefSchema.extend({ kind: z.literal('settings-dimension') }),
  dimensionCode: z.string().min(1), researchPlanId: artifactIdSchema,
  inputRefs: z.array(z.strictObject({ artifactId: artifactIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })).nonempty(),
  childSessionId: z.string().min(1).transform(brandString<SessionId>),
  request: requestReceiptSchema,
  reviewHistory: z.array(z.strictObject({ artifact: artifactRefSchema.extend({ kind: z.literal('review') }), request: requestReceiptSchema, childSessionId: z.string().min(1).transform(brandString<SessionId>), blocking: z.boolean() })),
  applied: z.boolean(),
})
/** `origin` is absent on every record written before author import existed and means 'stage'; an 'import' record is author text adopted without its own review. */
const settingsRecordSchema = legacySettingsRecordSchema.extend({ revisionOf: artifactIdSchema.nullable(), origin: z.enum(['stage', 'import']).optional() })
const researchNovelSchema = legacyNovelSchema.extend({ recordVersion: z.literal(2), researchHistory: z.array(researchRecordSchema) })
const settingsNovelSchema = researchNovelSchema.extend({ recordVersion: z.literal(3), settingsHistory: z.array(legacySettingsRecordSchema), settingsHeads: z.array(z.strictObject({ dimensionCode: z.string().min(1), artifactId: artifactIdSchema })) }).refine(record => new Set(record.settingsHeads.map(head => head.dimensionCode)).size === record.settingsHeads.length, 'Each settings dimension has at most one current head')
const manuscriptFields = { manuscriptHistory: z.array(manuscriptRecordSchema), manuscriptHeads: z.array(manuscriptHeadSchema), appliedChapters: z.array(appliedChapterSchema) }
const { revisionOf: _lineage, ...legacyManuscriptFields } = manuscriptRecordSchema.shape
const legacyManuscriptRecordSchema = z.strictObject(legacyManuscriptFields).refine(record => record.artifact.kind === record.target.kind, 'Manuscript target and artifact kind must agree')
const manuscriptNovelSchema = z.strictObject({ ...settingsNovelSchema.shape, recordVersion: z.literal(4), ...manuscriptFields, manuscriptHistory: z.array(legacyManuscriptRecordSchema) })
/** Written after a settings layer passes. Absent on novels saved before snapshot reuse. */
const settingsSnapshotSchema = z.strictObject({
  briefSha256: z.string().regex(/^[a-f0-9]{64}$/),
  roots: z.array(z.string().regex(/^[a-z][a-z0-9]*$/)).nonempty(),
  artifactId: artifactIdSchema,
})
const currentNovelSchema = z.strictObject({
  ...settingsNovelSchema.shape, recordVersion: z.literal(5), ...manuscriptFields, settingsHistory: z.array(settingsRecordSchema),
  settingsSnapshots: z.array(settingsSnapshotSchema).optional(),
})
  .refine(record => new Set(record.settingsHeads.map(head => head.dimensionCode)).size === record.settingsHeads.length, 'Each settings dimension has at most one current head')
  .refine(record => new Set(record.manuscriptHeads.map(head => `${head.kind}:${head.chapterNumber}`)).size === record.manuscriptHeads.length, 'Manuscript head slots must be unique')
  .refine(record => new Set(record.appliedChapters.map(chapter => `${chapter.body.id}:${chapter.continuity.id}`)).size === record.appliedChapters.length, 'Applied chapter pairs must be unique')
const emptyManuscript = () => ({ manuscriptHistory: [] as z.infer<typeof manuscriptRecordSchema>[], manuscriptHeads: [] as z.infer<typeof manuscriptHeadSchema>[], appliedChapters: [] as z.infer<typeof appliedChapterSchema>[] })
const novelSchema = z.union([
  currentNovelSchema,
  manuscriptNovelSchema.transform<z.input<typeof currentNovelSchema>>(record => ({ ...record, recordVersion: 5 as const,
    settingsHistory: record.settingsHistory.map(item => ({ ...item, revisionOf: null })), manuscriptHistory: record.manuscriptHistory.map(item => ({ ...item, revisionOf: null })) })).pipe(currentNovelSchema),
  settingsNovelSchema.transform<z.input<typeof currentNovelSchema>>(record => ({ ...record, recordVersion: 5 as const, ...emptyManuscript(), settingsHistory: record.settingsHistory.map(item => ({ ...item, revisionOf: null })) })).pipe(currentNovelSchema),
  researchNovelSchema.transform<z.input<typeof currentNovelSchema>>(record => ({ ...record, recordVersion: 5 as const, ...emptyManuscript(), settingsHistory: [] as z.infer<typeof settingsRecordSchema>[], settingsHeads: [] as { dimensionCode: string; artifactId: ArtifactId }[] })).pipe(currentNovelSchema),
  legacyNovelSchema.transform<z.input<typeof currentNovelSchema>>(record => ({ ...record, recordVersion: 5 as const, ...emptyManuscript(), researchHistory: [] as z.infer<typeof researchRecordSchema>[], settingsHistory: [] as z.infer<typeof settingsRecordSchema>[], settingsHeads: [] as { dimensionCode: string; artifactId: ArtifactId }[] })).pipe(currentNovelSchema),
])

/** Stored novel metadata; text belongs to immutable artifact records. */
export type NovelRecord = z.infer<typeof novelSchema>
/** Stored immutable writing content. */
export type ArtifactRecord = z.infer<typeof artifactSchema>
/** Persisted settings version and retained review history. */
export type SettingsRecord = z.infer<typeof settingsRecordSchema>
/** A published plan and its optional completed evidence version. */
export type ResearchRecord = z.infer<typeof researchRecordSchema>

/** One owning writing domain; single rejects damaged JSON instead of dropping novels. */
export const writingDomain = defineDomain({
  name: 'story_writing', version: 1, layout: 'single',
  tables: {
    novels: domainTable<NovelId, NovelRecord>(novelSchema),
    artifacts: domainTable<ArtifactId, ArtifactRecord>(artifactSchema),
    research_reads: domainTable<ArtifactId, { reads: { readCallId: ToolCallId; callId: ToolCallId; sourceIndex: number; offset: number; limit: number }[] }>(z.strictObject({ reads: z.array(z.strictObject({
      readCallId: researchCallSchema.shape.callId, callId: researchCallSchema.shape.callId, sourceIndex: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(),
    })) })),
    selections: domainTable(z.strictObject({ workspace: z.string(), sessionId: z.string(), novelId: novelIdSchema })),
  },
})
