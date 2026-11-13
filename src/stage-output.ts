/** Model-output admission for versioned novel-writing stages. */
import { z } from 'zod'
import { artifactIdSchema, type ArtifactId } from './contracts.ts'
import type { SettingsDimensionKind } from './settings-catalog.ts'
import { echo, parseModelOutput, StageValidationRejection } from './stage-rejection.ts'
import { reportQuoteRepair, resolveEvidenceQuote, type QuoteRepair } from './evidence-quote.ts'

/** A catalog classification dimension records a label and its grounds, not world-building detail. The single source for this set; stage-prompts.ts imports it rather than declaring its own copy. */
export const ENUM_SETTINGS_KINDS: ReadonlySet<SettingsDimensionKind> = new Set(['enum_single', 'enum_multi'])
/** Maximum facts a classification (enum) settings dimension may declare; llm_free dimensions are unbounded. */
export const MAX_ENUM_SETTINGS_FACTS = 10
/** Maximum Unicode code points of contentMarkdown for a classification (enum) settings dimension. */
export const MAX_ENUM_SETTINGS_CONTENT_CHARS = 2500

/** Former name of {@link StageValidationRejection}, kept as the same class so existing imports and instanceof checks keep working. */
export const StageOutputError = StageValidationRejection
/** Former name of {@link StageValidationRejection}. */
export type StageOutputError = StageValidationRejection

const text = z.string().min(1).refine(value => value.trim().length > 0, 'Text must not be blank')
const inputRefSchema = z.strictObject({ artifactId: artifactIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const inputsSchema = z.strictObject({ version: z.literal(1), inputRefs: z.array(inputRefSchema).nonempty() })
const factSchema = z.strictObject({ id: text, statement: text })
const settingsSchema = inputsSchema.extend({
  dimensionCode: z.string().regex(/^[a-z][a-z0-9]*$/), facts: z.array(factSchema).nonempty(), contentMarkdown: text,
})
const citationSchema = z.strictObject({ artifactId: artifactIdSchema, quote: text })
const reviewCategorySchema = z.enum(['completeness', 'consistency', 'obligations', 'continuity', 'length', 'style'])
const issueShape = {
  id: text, severity: z.enum(['blocking', 'advisory']).describe('Style issues must be advisory; every other category must be blocking.'), category: reviewCategorySchema,
  location: text, message: text, evidence: z.array(citationSchema).nonempty(),
}
/** The schema a model review must satisfy (also published to the native child). */
const reviewSchema = inputsSchema.extend({
  reviewed: inputRefSchema,
  checks: z.array(z.strictObject({ category: reviewCategorySchema, summary: text, evidence: z.array(citationSchema).nonempty() })).nonempty(),
  issues: z.array(z.strictObject(issueShape)),
})
/**
 * Host marker on an issue none of whose evidence can be found in any admitted input: the issue is kept, made advisory,
 * and keeps its original citations so the marker can be re-verified on every readback. Never part of the model schema.
 */
const hostDowngradeSchema = z.strictObject({ from: z.enum(['blocking', 'advisory']), reason: text })
/** The admitted (stored) review: the model schema plus host downgrade markers. */
const admittedReviewSchema = reviewSchema.extend({ issues: z.array(z.strictObject({ ...issueShape, hostDowngrade: hostDowngradeSchema.optional() })) })
const obligationSchema = z.strictObject({ id: text, description: text })
const targetWords = z.number().int().positive()
const bookArc = z.array(z.strictObject({ character: text, development: text })).nonempty()
const bookChapter = {
  chapterNumber: z.number().int().positive(), title: text, purpose: text, obligations: z.array(obligationSchema),
}
/**
 * Prompt versions before 7 publish this schema. Property order matches the frozen schema: `targetWords` sits between
 * `purpose` and `obligations`. Admission and version 7 publication do not use it.
 */
export const bookOutlineSchemaLegacy = inputsSchema.extend({
  contentMarkdown: text, ending: text, characterArcs: bookArc,
  chapters: z.array(z.strictObject({
    chapterNumber: bookChapter.chapterNumber, title: bookChapter.title, purpose: bookChapter.purpose, targetWords, obligations: bookChapter.obligations,
  })).nonempty(),
})
/** Version 7 publication: no `targetWords`. The host counts the body; the outline does not plan a word number. */
export const bookOutlineSchemaV7 = inputsSchema.extend({
  contentMarkdown: text, ending: text, characterArcs: bookArc,
  chapters: z.array(z.strictObject(bookChapter)).nonempty(),
})
/** Admission accepts a historical `targetWords` and a version-7 outline that omits it. */
const bookOutlineSchema = inputsSchema.extend({
  contentMarkdown: text, ending: text, characterArcs: bookArc,
  chapters: z.array(z.strictObject({
    chapterNumber: bookChapter.chapterNumber, title: bookChapter.title, purpose: bookChapter.purpose, targetWords: targetWords.optional(), obligations: bookChapter.obligations,
  })).nonempty(),
})
const sceneCard = z.array(z.strictObject({ id: text, purpose: text, action: text, obligationIds: z.array(text) })).nonempty()
/** Optional free-text state list (prompt version 2). No enums, so a loose note never costs a repair attempt. */
const stateNotes = z.array(text).optional()
/** Prompt versions 2–6 publish this schema. `targetWords` stays between `title` and `throughLine`, as in the frozen schema. */
export const chapterOutlineSchemaLegacy = inputsSchema.extend({
  chapterNumber: z.number().int().positive(), title: text, targetWords, throughLine: text,
  constraints: z.array(text), obligations: z.array(obligationSchema), scenes: sceneCard, stateNotes,
})
/** Version 7 publication: no `targetWords`. Scene plans stay; the host does not ask for a chapter word number. */
export const chapterOutlineSchemaV7 = inputsSchema.extend({
  chapterNumber: z.number().int().positive(), title: text, throughLine: text,
  constraints: z.array(text), obligations: z.array(obligationSchema), scenes: sceneCard, stateNotes,
})
/** Admission accepts a historical `targetWords` and a version-7 outline that omits it. */
const chapterOutlineSchema = inputsSchema.extend({
  chapterNumber: z.number().int().positive(), title: text, targetWords: targetWords.optional(), throughLine: text,
  constraints: z.array(text), obligations: z.array(obligationSchema), scenes: sceneCard, stateNotes,
})
const bodySchema = inputsSchema.extend({
  chapterNumber: z.number().int().positive(), scenes: z.array(z.strictObject({ sceneId: text, text })).nonempty(),
})
const continuitySchema = inputsSchema.extend({
  chapterNumber: z.number().int().positive(), summary: text,
  characters: z.array(z.strictObject({ name: text, state: text })),
  timeline: z.array(z.strictObject({ event: text, evidence: z.array(citationSchema).nonempty() })),
  obligations: z.array(z.strictObject({
    id: text, status: z.enum(['open', 'fulfilled']), explanation: text, evidence: z.array(citationSchema),
  })),
})

/** Exact immutable source identity declared by a stage output. */
export type StageInputRef = z.infer<typeof inputRefSchema>
/** Generated candidate for one selected settings dimension; application is host-owned. */
export type SettingsDimensionOutput = z.infer<typeof settingsSchema>
/** Substantive review categories; the host specifies those required for the stage. */
export type ReviewCategory = z.infer<typeof reviewCategorySchema>
/** Review findings tied to an exact candidate and quoted source versions. */
export type ReviewOutput = z.infer<typeof admittedReviewSchema>
/** Ordered book structure, character development, ending, and chapter obligations. */
export type BookOutlineOutput = z.infer<typeof bookOutlineSchema>
/** Ordered chapter scenes and the required obligations they execute. */
export type ChapterOutlineOutput = z.infer<typeof chapterOutlineSchema>
/** Reader-facing scene text; assembly and chapter-total counting belong to the host. */
export type BodyOutput = z.infer<typeof bodySchema>
/** Proposed actual continuity; fulfilled obligations cite the reviewed body. */
export type ContinuityOutput = z.infer<typeof continuitySchema>
const snapshotNote = z.strictObject({ note: text })
/**
 * Compact facts extracted after a chapter is applied. Counts and note length are host limits, checked by
 * {@link parseContinuitySnapshot}, so the published schema stays inside the native keyword subset.
 */
const continuitySnapshotSchema = inputsSchema.extend({
  chapterNumber: z.number().int().positive(),
  characterStatus: z.array(z.strictObject({ name: text, status: text })),
  unrecoveredForeshadowing: z.array(snapshotNote),
  usedPlotBridges: z.array(snapshotNote),
})
/** One reviewed chapter's compact continuity snapshot. */
export type ContinuitySnapshotOutput = z.infer<typeof continuitySnapshotSchema>
/** Host cap on character rows in one snapshot. */
export const MAX_SNAPSHOT_CHARACTERS = 8
/** Host cap on unrecovered notes and on used bridges. */
export const MAX_SNAPSHOT_NOTES = 6
/** Host cap on a character name, in Unicode code points. */
export const MAX_SNAPSHOT_NAME_CHARS = 40
/** Host cap on one status or note, in Unicode code points. */
export const MAX_SNAPSHOT_NOTE_CHARS = 160
/** An exact excerpt cited by a model output. */
export type EvidenceCitation = z.infer<typeof citationSchema>
/** Host-verified text available for exact quotation checks. */
export interface EvidenceSource { readonly artifactId: ArtifactId; readonly text: string }

/** The chapter-outline schema published to runs on prompt version 1, before stateNotes existed. `targetWords` stays required there. */
export const chapterOutlineSchemaV1 = chapterOutlineSchemaLegacy.omit({ stateNotes: true })

/** Model response schemas; use z.toJSONSchema(schema, { io: 'input' }) for the branded identifier parsers. */
export const StageOutputSchemas = {
  settings: settingsSchema, review: reviewSchema, 'book-outline': bookOutlineSchema, 'chapter-outline': chapterOutlineSchema,
  body: bodySchema, continuity: continuitySchema, 'continuity-snapshot': continuitySnapshotSchema,
} as const

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new StageValidationRejection(`Duplicate ${label}: ${echo(value)} appears more than once; each must be unique`)
    seen.add(value)
  }
}

function nonempty<T>(values: T[]): [T, ...T[]] {
  if (values.length === 0) throw new StageValidationRejection('Evidence must cite at least one quote')
  return values as [T, ...T[]]
}

function list(values: readonly string[]): string { return values.length === 0 ? 'none' : values.map(value => echo(value)).join(', ') }

function matchingInputs(actual: readonly StageInputRef[], expected: readonly StageInputRef[]): void {
  unique(actual.map(ref => ref.artifactId), 'input artifact')
  unique(expected.map(ref => ref.artifactId), 'expected input artifact')
  const matches = (ref: StageInputRef, refs: readonly StageInputRef[]) => refs.some(input => input.artifactId === ref.artifactId && input.sha256 === ref.sha256)
  const unexpected = actual.filter(ref => !matches(ref, expected)).map(ref => `${ref.artifactId}@${ref.sha256.slice(0, 12)}`)
  const missing = expected.filter(ref => !matches(ref, actual)).map(ref => `${ref.artifactId}@${ref.sha256.slice(0, 12)}`)
  if (unexpected.length > 0 || missing.length > 0) {
    throw new StageValidationRejection(`Stage input references do not match the requested versions: missing ${list(missing)}; unexpected ${list(unexpected)}. Copy TASK_DATA inputRefs exactly (artifactId and sha256)`)
  }
}

function matchingObligations(actual: readonly string[], expected: readonly string[]): void {
  unique(actual, 'obligation ID')
  unique(expected, 'expected obligation ID')
  const missing = expected.filter(id => !actual.includes(id))
  const unexpected = actual.filter(id => !expected.includes(id))
  if (missing.length > 0 || unexpected.length > 0) throw new StageValidationRejection(`Stage obligations do not match the requested obligations: missing ${list(missing)}; unexpected ${list(unexpected)}`)
}

/** Code points of a rejected quote echoed back in the repair message. */
const QUOTE_ECHO_CHARS = 120

export { evidenceQuoteKey, evidenceQuoteOccurs } from './evidence-quote.ts'

function quoteEcho(quote: string): string {
  const chars = [...quote]
  return JSON.stringify(chars.length <= QUOTE_ECHO_CHARS ? quote : `${chars.slice(0, QUOTE_ECHO_CHARS).join('')}…`)
}

/** One evidence item (a check, issue, timeline event or obligation) none of whose citations could be admitted. */
export interface UnresolvedEvidence {
  /** Output path of the item, for example `checks[2]` or `issues[0]`. */
  readonly location: string
  /** The item's citations exactly as the model wrote them. */
  readonly citations: readonly EvidenceCitation[]
  /** The host rejection message for each citation, in order. */
  readonly reasons: readonly string[]
}

/**
 * A review or continuity value whose only defect is evidence: every other admission rule passed, and each listed item has
 * no admissible citation left. The writing runner can repair exactly these items without regenerating the whole value.
 */
export class EvidenceRejection extends StageValidationRejection {
  /** @param unresolved - Every item without admissible evidence, in output order. */
  constructor(readonly unresolved: readonly [UnresolvedEvidence, ...UnresolvedEvidence[]]) {
    const [first] = unresolved
    const more = unresolved.length > 1 ? ` ${unresolved.length - 1} more evidence item(s) also have no admissible quote: ${unresolved.slice(1).map(item => item.location).join(', ')}.` : ''
    super(`${first.reasons[0]!} (evidence item ${first.location})${more}`)
    this.name = 'EvidenceRejection'
  }
}

function rejectionReason(citation: EvidenceCitation, admitted: readonly ArtifactId[], hint: string): string {
  if (!admitted.includes(citation.artifactId as ArtifactId)) return `Evidence names an artifact outside the stage inputs: ${echo(citation.artifactId)}; cite only ${list(admitted)}.${hint}`
  return `Evidence quote does not occur in its declared source ${citation.artifactId}: ${quoteEcho(citation.quote)}. `
    + `Copy each quote character for character as one contiguous excerpt of that artifact; do not add lead-in words, paraphrase, or join separate passages.${hint}`
}

/**
 * Admit one item's citations: exact ones unchanged, deterministic host repairs applied (see evidence-quote.ts). A citation
 * that cannot be admitted is dropped, with a reported `dropped` repair, when the item keeps at least one admitted
 * citation; otherwise the whole item is returned as unresolved and nothing is reported as dropped.
 */
function checkEvidence(location: string, citations: readonly EvidenceCitation[], sources: readonly EvidenceSource[], admitted: readonly ArtifactId[]): { accepted: EvidenceCitation[]; unresolved?: UnresolvedEvidence } {
  const accepted: EvidenceCitation[] = []
  const rejected: Array<{ citation: EvidenceCitation; reason: string }> = []
  const repairs: QuoteRepair[] = []
  for (const citation of citations) {
    const resolution = resolveEvidenceQuote(citation, sources, admitted)
    const resolved = resolution.status === 'admitted' ? resolution.citations.map(item => ({ artifactId: admitted.find(id => id === item.artifactId), quote: item.quote })) : []
    if (resolution.status === 'rejected' || resolved.some(item => item.artifactId === undefined)) {
      rejected.push({ citation, reason: rejectionReason(citation, admitted, resolution.status === 'rejected' ? resolution.hint : '') })
      continue
    }
    if (resolution.repair !== undefined) repairs.push({ ...resolution.repair, location })
    for (const item of resolved) accepted.push({ artifactId: item.artifactId!, quote: item.quote })
  }
  if (rejected.length > 0 && accepted.length === 0) {
    return { accepted, unresolved: { location, citations: rejected.map(item => item.citation), reasons: rejected.map(item => item.reason) } }
  }
  for (const repair of repairs) reportQuoteRepair(repair)
  for (const { citation, reason } of rejected) reportQuoteRepair({ kind: 'dropped', declared: citation, admitted: [], distance: 0, location, reason })
  return { accepted }
}

/** Admits evidence item by item, then rejects once with every item that has no admissible quote. */
class EvidenceAudit {
  private readonly unresolved: UnresolvedEvidence[] = []
  constructor(private readonly sources: readonly EvidenceSource[], private readonly admitted: readonly ArtifactId[]) {}
  /** @returns The admitted citations; an unresolved item yields its original citations so later rules still see a value. */
  check(location: string, citations: readonly EvidenceCitation[]): EvidenceCitation[] {
    const result = checkEvidence(location, citations, this.sources, this.admitted)
    if (result.unresolved === undefined) return result.accepted
    this.unresolved.push(result.unresolved)
    return [...citations]
  }
  /** @returns The admitted citations, or the unresolved item without recording it. */
  inspect(location: string, citations: readonly EvidenceCitation[]): { accepted: EvidenceCitation[]; unresolved?: UnresolvedEvidence } {
    return checkEvidence(location, citations, this.sources, this.admitted)
  }
  finish(): void {
    if (this.unresolved.length > 0) throw new EvidenceRejection(this.unresolved as [UnresolvedEvidence, ...UnresolvedEvidence[]])
  }
}

/** @param value - Model JSON value. @param expected - Requested dimension and exact upstream versions. @returns A detached validated settings candidate; structural only — a persisted or replayed candidate must always still parse. */
export function parseSettingsDimensionOutput(value: unknown, expected: { dimensionCode: string; inputRefs: readonly StageInputRef[] }): SettingsDimensionOutput {
  const output = parseModelOutput(settingsSchema, value, 'Settings dimension output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.dimensionCode !== expected.dimensionCode) throw new StageValidationRejection(`Settings dimension differs from the requested dimension: got ${echo(output.dimensionCode)}, expected ${echo(expected.dimensionCode)}`)
  unique(output.facts.map(fact => fact.id), 'settings fact ID')
  return output
}

/**
 * Scope check for a freshly admitted classification (enum) settings candidate; llm_free is unbounded.
 * Callers apply this only when admitting a new model output, never on readback or idempotent replay,
 * so a candidate accepted by an earlier version of this bound remains durably readable.
 * @param output - Already structurally validated settings output. @param kind - The dimension's catalog kind.
 */
export function checkSettingsDimensionScope(output: SettingsDimensionOutput, kind: SettingsDimensionKind): void {
  if (!ENUM_SETTINGS_KINDS.has(kind)) return
  if (output.facts.length > MAX_ENUM_SETTINGS_FACTS) {
    throw new StageValidationRejection(`A classification dimension allows at most ${MAX_ENUM_SETTINGS_FACTS} facts; this candidate has ${output.facts.length}`)
  }
  const contentChars = [...output.contentMarkdown].length
  if (contentChars > MAX_ENUM_SETTINGS_CONTENT_CHARS) {
    throw new StageValidationRejection(`A classification dimension allows at most ${MAX_ENUM_SETTINGS_CONTENT_CHARS} characters of contentMarkdown; this candidate has ${contentChars}`)
  }
}

/** @param value - Model review JSON. @param expected - Exact target, required checks, and host-verified sources. @returns A review with cited evidence; adoption remains host-owned. */
export function parseReviewOutput(value: unknown, expected: {
  reviewed: StageInputRef; inputRefs: readonly StageInputRef[]; requiredChecks: readonly ReviewCategory[]; evidenceSources: readonly EvidenceSource[]
  /** Settings reviews only: keep an advisory completeness note as a recorded, nonblocking finding instead of rejecting the whole review. */
  readonly acceptAdvisoryCompleteness?: boolean
}): ReviewOutput {
  const output = parseModelOutput(admittedReviewSchema, value, 'Review output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.reviewed.artifactId !== expected.reviewed.artifactId || output.reviewed.sha256 !== expected.reviewed.sha256) {
    throw new StageValidationRejection(`Reviewed artifact differs from the requested candidate version: got ${output.reviewed.artifactId}@${output.reviewed.sha256.slice(0, 12)}, expected ${expected.reviewed.artifactId}@${expected.reviewed.sha256.slice(0, 12)}`)
  }
  unique(output.checks.map(check => check.category), 'review check category')
  unique(output.issues.map(issue => issue.id), 'review issue ID')
  unique(expected.evidenceSources.map(source => source.artifactId), 'evidence source')
  const missingChecks = expected.requiredChecks.filter(category => !output.checks.some(check => check.category === category))
  if (missingChecks.length > 0) throw new StageValidationRejection(`Review is missing a required check: ${missingChecks.join(', ')} (required: ${expected.requiredChecks.join(', ')})`)
  for (const issue of output.issues) {
    if (issue.hostDowngrade !== undefined) {
      if (issue.severity !== 'advisory') throw new StageValidationRejection(`A host-downgraded issue must be advisory: issue ${echo(issue.id)} is ${issue.severity}`)
      continue
    }
    if (issue.category === 'style' && issue.severity !== 'advisory') throw new StageValidationRejection(`Style suggestions must remain advisory: issue ${echo(issue.id)} is ${issue.severity}`)
    if (issue.category === 'completeness' && issue.severity === 'advisory' && expected.acceptAdvisoryCompleteness === true) continue
    if (issue.category !== 'style' && issue.severity !== 'blocking') throw new StageValidationRejection(`${issue.category} issues must be blocking: issue ${echo(issue.id)} is ${issue.severity}`)
  }
  // Every non-evidence rule has passed: an evidence rejection below is the value's only defect.
  const admitted = [output.reviewed.artifactId, ...output.inputRefs.map(ref => ref.artifactId)]
  const audit = new EvidenceAudit(expected.evidenceSources, admitted)
  const checks = output.checks.map((check, index) => ({ ...check, evidence: nonempty(audit.check(`checks[${index}]`, check.evidence)) }))
  const issues = output.issues.map((issue, index) => {
    const location = `issues[${index}]`
    const result = audit.inspect(location, issue.evidence)
    if (issue.hostDowngrade !== undefined) {
      // Readback of a stored downgrade: valid only while none of its evidence can be found.
      if (result.unresolved === undefined) throw new StageValidationRejection(`hostDowngrade is host-owned and marks only issues whose evidence occurs in no input: issue ${echo(issue.id)} has admissible evidence`)
      return issue
    }
    if (result.unresolved === undefined) return { ...issue, evidence: nonempty(result.accepted) }
    // No quote of this issue occurs in any admitted input: keep the finding but stop it blocking, instead of spending a repair.
    const reason = result.unresolved.reasons[0]!
    reportQuoteRepair({ kind: 'downgraded', declared: issue.evidence[0]!, admitted: [], distance: 0, location, reason: `${issue.severity} ${issue.category} issue ${echo(issue.id)} made advisory: ${reason}` })
    return { ...issue, severity: 'advisory' as const, hostDowngrade: { from: issue.severity, reason } }
  })
  audit.finish()
  return { ...output, checks: nonempty(checks), issues }
}

/** @param value - Model book outline JSON. @param expected - Exact inputs and requested total chapter count. @returns A complete ordered book plan with unique obligation IDs. */
export function parseBookOutlineOutput(value: unknown, expected: { inputRefs: readonly StageInputRef[]; chapterCount: number }): BookOutlineOutput {
  const output = parseModelOutput(bookOutlineSchema, value, 'Book outline output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.chapters.length !== expected.chapterCount || output.chapters.some((chapter, index) => chapter.chapterNumber !== index + 1)) {
    throw new StageValidationRejection(`Book chapters must cover the requested count in order from chapter 1: expected chapters 1–${expected.chapterCount}, got [${output.chapters.map(chapter => chapter.chapterNumber).join(', ')}]`)
  }
  unique(output.chapters.flatMap(chapter => chapter.obligations.map(obligation => obligation.id)), 'book obligation ID')
  unique(output.characterArcs.map(arc => arc.character), 'character arc')
  return output
}

/** @param value - Model chapter outline JSON. @param expected - Exact inputs, chapter number, and required obligations. @returns A chapter plan covering each obligation through ordered scenes. */
export function parseChapterOutlineOutput(value: unknown, expected: {
  inputRefs: readonly StageInputRef[]; chapterNumber: number; obligationIds: readonly string[]
}): ChapterOutlineOutput {
  const output = parseModelOutput(chapterOutlineSchema, value, 'Chapter outline output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.chapterNumber !== expected.chapterNumber) throw new StageValidationRejection(`Chapter outline does not match the requested chapter: got ${output.chapterNumber}, expected ${expected.chapterNumber}`)
  matchingObligations(output.obligations.map(obligation => obligation.id), expected.obligationIds)
  unique(output.scenes.map(scene => scene.id), 'scene ID')
  const covered = new Set<string>()
  for (const scene of output.scenes) {
    unique(scene.obligationIds, 'scene obligation ID')
    for (const id of scene.obligationIds) {
      if (!expected.obligationIds.includes(id)) throw new StageValidationRejection(`Scene names an unknown obligation: scene ${echo(scene.id)} cites ${echo(id)}; known obligations are ${list(expected.obligationIds)}`)
      covered.add(id)
    }
  }
  const uncovered = expected.obligationIds.filter(id => !covered.has(id))
  if (uncovered.length > 0) throw new StageValidationRejection(`A required obligation has no assigned scene: ${list(uncovered)}; list each in some scene's obligationIds`)
  return output
}

/** @param value - Model body JSON. @param expected - Exact inputs, chapter number, and ordered scene IDs. @returns Complete ordered scene text, including candidates that require length repair. */
export function parseBodyOutput(value: unknown, expected: {
  inputRefs: readonly StageInputRef[]; chapterNumber: number; sceneIds: readonly string[]
}): BodyOutput {
  const output = parseModelOutput(bodySchema, value, 'Body output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.chapterNumber !== expected.chapterNumber) throw new StageValidationRejection(`Body does not match the requested chapter: got ${output.chapterNumber}, expected ${expected.chapterNumber}`)
  unique(output.scenes.map(scene => scene.sceneId), 'body scene ID')
  unique(expected.sceneIds, 'expected scene ID')
  if (output.scenes.length !== expected.sceneIds.length || output.scenes.some((scene, index) => scene.sceneId !== expected.sceneIds[index])) {
    throw new StageValidationRejection(`Body must contain every planned scene in the requested order: expected [${list(expected.sceneIds)}], got [${list(output.scenes.map(scene => scene.sceneId))}]`)
  }
  return output
}

/** @param value - Model continuity JSON. @param expected - Exact inputs, chapter, obligations, and actual reviewed-body source. @returns Proposed continuity with verified quotations; semantic review and application remain host-owned. */
export function parseContinuityOutput(value: unknown, expected: {
  inputRefs: readonly StageInputRef[]; chapterNumber: number; obligationIds: readonly string[];
  evidenceSources: readonly EvidenceSource[]; reviewedBodyId: ArtifactId
}): ContinuityOutput {
  const output = parseModelOutput(continuitySchema, value, 'Continuity output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.chapterNumber !== expected.chapterNumber) throw new StageValidationRejection(`Continuity does not match the requested chapter: got ${output.chapterNumber}, expected ${expected.chapterNumber}`)
  matchingObligations(output.obligations.map(obligation => obligation.id), expected.obligationIds)
  unique(output.characters.map(character => character.name), 'continuity character')
  unique(expected.evidenceSources.map(source => source.artifactId), 'evidence source')
  const admitted = output.inputRefs.map(ref => ref.artifactId)
  if (!admitted.includes(expected.reviewedBodyId) || !expected.evidenceSources.some(source => source.artifactId === expected.reviewedBodyId)) {
    throw new StageValidationRejection(`Reviewed body must be a declared input with source text: include ${expected.reviewedBodyId} in inputRefs`)
  }
  const audit = new EvidenceAudit(expected.evidenceSources, admitted)
  const timeline = output.timeline.map((event, index) => ({ ...event, evidence: nonempty(audit.check(`timeline[${index}]`, event.evidence)) }))
  const checked = output.obligations.map((obligation, index) => ({ ...obligation, evidence: audit.check(`obligations[${index}]`, obligation.evidence) }))
  audit.finish()
  const obligations = checked.map(obligation => {
    if (obligation.status === 'fulfilled' && !obligation.evidence.some(citation => citation.artifactId === expected.reviewedBodyId)) {
      throw new StageValidationRejection(`A fulfilled obligation requires evidence from the actual reviewed body: obligation ${echo(obligation.id)} cites no quote from ${expected.reviewedBodyId}`)
    }
    return obligation
  })
  return { ...output, timeline, obligations }
}

/**
 * Admit one compact snapshot. The published schema stays unbounded; these caps keep the stored note usable.
 * @param value - Model snapshot JSON.
 * @param expected - Exact inputs and chapter number.
 * @returns The detached snapshot.
 */
export function parseContinuitySnapshot(value: unknown, expected: { inputRefs: readonly StageInputRef[]; chapterNumber: number }): ContinuitySnapshotOutput {
  const output = parseModelOutput(continuitySnapshotSchema, value, 'Continuity snapshot output')
  matchingInputs(output.inputRefs, expected.inputRefs)
  if (output.chapterNumber !== expected.chapterNumber) throw new StageValidationRejection(`Continuity snapshot does not match the requested chapter: got ${output.chapterNumber}, expected ${expected.chapterNumber}`)
  if (output.characterStatus.length > MAX_SNAPSHOT_CHARACTERS) throw new StageValidationRejection(`Continuity snapshot lists ${output.characterStatus.length} characters; at most ${MAX_SNAPSHOT_CHARACTERS}`)
  if (output.unrecoveredForeshadowing.length > MAX_SNAPSHOT_NOTES) throw new StageValidationRejection(`Continuity snapshot lists ${output.unrecoveredForeshadowing.length} unrecovered notes; at most ${MAX_SNAPSHOT_NOTES}`)
  if (output.usedPlotBridges.length > MAX_SNAPSHOT_NOTES) throw new StageValidationRejection(`Continuity snapshot lists ${output.usedPlotBridges.length} used bridges; at most ${MAX_SNAPSHOT_NOTES}`)
  unique(output.characterStatus.map(character => character.name), 'snapshot character')
  for (const character of output.characterStatus) {
    boundedNote(character.name, MAX_SNAPSHOT_NAME_CHARS, `character ${echo(character.name)}`)
    boundedNote(character.status, MAX_SNAPSHOT_NOTE_CHARS, `status of ${echo(character.name)}`)
  }
  for (const note of [...output.unrecoveredForeshadowing, ...output.usedPlotBridges]) boundedNote(note.note, MAX_SNAPSHOT_NOTE_CHARS, 'snapshot note')
  return output
}

function boundedNote(value: string, limit: number, label: string): void {
  const chars = [...value].length
  if (chars > limit) throw new StageValidationRejection(`Continuity snapshot ${label} is ${chars} characters; at most ${limit}`)
}
