/**
 * Shared injections and driver for the offline end-to-end proof for the unified output-validation repair loop.
 *
 * The fake stage provider runs the live prompt: settings roots a4, a5 and e1 (closure a1–a5 and e1) as one batch draft
 * and one consistency review, then one book outline, then three chapters. Outlines are written before bodies. Each
 * chapter has research and review for its outline, body and continuity, plus a reviewed continuity snapshot after the
 * body is applied. One violation of every kind is injected into the first attempt of at least one stage of every stage
 * kind that the injections name. With maxRepairAttempts 1 each is repaired by exactly one replacement and the run
 * completes; with maxRepairAttempts 0 each fails the run with its specific message.
 */
import { expect, it } from 'vitest'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { StageOutputSchemas } from '../../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureStage } from './writing-fixture.ts'

export type Output = Record<string, any>
export interface Injection {
  readonly id: string
  /** Stage kind as counted in the live plan. */
  readonly stage: string
  readonly violation: string
  /** Highest chapter the run must reach for this stage to execute (0 = before any chapter). */
  readonly chapter: number
  readonly match: (stage: WritingFixtureStage) => boolean
  readonly mutate?: (output: Output, stage: WritingFixtureStage) => object
  readonly finish?: FinishReason
  /** Specific failure the run reports when the replacement is not allowed. */
  readonly message: RegExp
  /** Replacement attempt key derived from the injected attempt key. */
  readonly replacement: (key: string) => string
  /**
   * Proven in its own run: a business repair rewrites the candidate, so it shares that candidate loop's maxRepairAttempts
   * with any output rejection of the same candidate, and every candidate loop already carries an injection in the combined run.
   */
  readonly solo?: true
}

export const LIVE_ROOTS = ['a4', 'a5', 'e1']
/** Logical stage keys after stripping planning captures and repair indices: one settings draft, one consistency review, book-outline research/candidate/review, and for each of three chapters outline, body and continuity research/candidate/review plus a snapshot candidate and review. */
export const PIPELINE_STAGES = 38

const planningTarget = (stage: WritingFixtureStage): Record<string, unknown> | undefined => stage.data.kind === 'research-planning' ? stage.data.outputTarget : undefined
const reviewed = (stage: WritingFixtureStage) => stage.kind === 'review' && stage.task?.reviewed !== undefined ? stage.sources.get(stage.task.reviewed.artifactId) : undefined
const reviewedJson = (stage: WritingFixtureStage): Output => JSON.parse(reviewed(stage)!.stored ?? reviewed(stage)!.text)
const isPlanning = (stage: WritingFixtureStage, target: string) => {
  const value = planningTarget(stage)
  return value !== undefined && (value.kind === 'settings' ? value.dimensionCode === target : value.kind === target)
}
const isManuscriptResearch = (stage: WritingFixtureStage, kind: string, chapter?: number) => {
  if (stage.data.kind !== 'research' || !stage.data.purpose.startsWith('Resolve evidence needed for')) return false
  return stage.data.purpose.includes(`"kind":"${kind}"`) && (chapter === undefined || stage.data.purpose.includes(`"chapterNumber":${chapter}`))
}
const isBatch = (stage: WritingFixtureStage, batch: 'draft' | 'consistency' | 'repair') => stage.kind === 'settings' && stage.task?.batch === batch
export const isSettings = (stage: WritingFixtureStage, code: string) => stage.kind === 'settings' && (stage.task?.dimensionCode === code || stage.task?.codes?.includes(code) === true)
const isReviewOf = (stage: WritingFixtureStage, kind: string, chapter?: number) => reviewed(stage)?.kind === kind && (chapter === undefined || reviewedJson(stage).chapterNumber === chapter)
export const isChapterStage = (stage: WritingFixtureStage, kind: string, chapter: number) => stage.kind === kind && stage.task?.chapterNumber === chapter
const misquote = (output: Output) => ({ ...output, checks: output.checks.map((check: Output, index: number) => {
  if (index !== 0) return check
  const evidence = check.evidence[0]
  if (evidence.paragraphId !== undefined) return { ...check, evidence: [{ paragraphId: 'p99', problem: `进一步确认${evidence.problem}` }] }
  return { ...check, evidence: [{ ...evidence, quote: `进一步确认${evidence.quote}` }] }
}) })
const dropCheck = (category: string) => (output: Output) => ({ ...output, checks: output.checks.filter((check: Output) => check.category !== category) })
export const next = (key: string) => key.replace(/\/(\d+)(\/citations)?$/u, (_, n: string, citations?: string) => `/${Number(n) + 1}${citations ?? ''}`)
/** An evidence-only review rejection is repaired by a citation-only stage rather than a whole new review. */
const citationNext = (key: string) => `${next(key)}/citations`
const same = (key: string) => key
const planningNext = (key: string) => `${key}/1`
const researchNext = (key: string) => `${key}/repair/1`
const creative = (id: string) => ({ id, kind: 'creative', question: `虚构设定问题 ${id}`, reason: 'A deliberate fictional choice grounded in the brief.' })

const batchRepair = (key: string) => key.includes('/repair/') ? key : `${key}/repair/1`
const QUOTE = '本书是一部发生在虚构雾港的悬疑冒险小说。'
export const injections: readonly Injection[] = [
  // Research planning now starts at the book outline; settings no longer spend a planning child.
  { id: 'planning-question-count', stage: 'research planning', violation: 'over-limit question count (13 > 12)', chapter: 0, match: stage => isPlanning(stage, 'chapter-outline'),
    mutate: output => ({ ...output, questions: Array.from({ length: 13 }, (_, index) => creative(`q${index + 1}`)) }), replacement: planningNext,
    message: /Research planning repair limit was exhausted: Research questions exceed the configured limits: 13 questions, at most 12 per plan/ },
  { id: 'planning-schema', stage: 'research planning', violation: 'schema beyond native JSON Schema (blank reason)', chapter: 0, match: stage => isPlanning(stage, 'body'),
    mutate: output => ({ ...output, questions: output.questions.map((question: Output) => ({ ...question, reason: '   ' })) }), replacement: planningNext,
    message: /Research planning decision does not match its output schema: questions\.0\.reason: / },
  { id: 'planning-scope', stage: 'research planning', violation: 'cross-reference (mode vs external questions)', chapter: 0, match: stage => isPlanning(stage, 'continuity'),
    mutate: output => ({ ...output, mode: 'external-required' }), replacement: planningNext,
    message: /Research scope must identify one required output decision and missing fact for every external question: mode is external-required but there are 0 external questions/ },
  { id: 'planning-duplicate-id', stage: 'research planning', violation: 'duplicate question id', chapter: 0, match: stage => isPlanning(stage, 'book-outline'),
    mutate: output => ({ ...output, questions: [creative('dup'), creative('dup')] }), replacement: planningNext,
    message: /Research question ids must be unique: "dup" appears more than once/ },
  // Research stage (native child) for manuscript targets. Settings use host official retrieval, not a research child.
  { id: 'research-schema', stage: 'research', violation: 'schema (malformed planId)', chapter: 0, match: stage => isManuscriptResearch(stage, 'book-outline'),
    mutate: () => ({ planId: 'not-a-plan' }), replacement: researchNext, message: /Research stage repair limit was exhausted: Research stage output does not match its output schema: planId: / },
  { id: 'research-unknown-plan', stage: 'research', violation: 'cross-reference (invented planId)', chapter: 1, match: stage => isManuscriptResearch(stage, 'chapter-outline', 1),
    mutate: () => ({ planId: 'artifact_00000000-0000-4000-8000-000000000001' }), replacement: researchNext,
    message: /Research stage output names no research plan of this novel: artifact_00000000-0000-4000-8000-000000000001/ },
  // Settings batch draft. Only one of these can ride the combined run; the rest are solo because they share the draft stage.
  { id: 'settings-schema', stage: 'settings batch', violation: 'blank dimension body', chapter: 0, match: stage => isBatch(stage, 'draft'),
    mutate: output => ({ ...output, dimensions: output.dimensions.map((item: Output, index: number) => index === 0 ? { ...item, body: ' \n ' } : item) }), replacement: batchRepair,
    message: /Settings batch repair limit was exhausted: Settings batch body for .+ must not be blank/ },
  { id: 'settings-fact-count', stage: 'settings batch', violation: 'duplicate dimension code', chapter: 0, match: stage => isBatch(stage, 'draft'), solo: true,
    mutate: output => ({ ...output, dimensions: [output.dimensions[0], output.dimensions[0]] }), replacement: batchRepair,
    message: /Settings batch repair limit was exhausted: Settings batch repeats dimension / },
  { id: 'settings-content-length', stage: 'settings batch', violation: 'over-limit contentMarkdown (2501 > 2500)', chapter: 0, match: stage => isBatch(stage, 'draft'), solo: true,
    mutate: output => ({ ...output, dimensions: output.dimensions.map((item: Output) => item.code === 'a1' ? { ...item, body: '雾'.repeat(2501) } : item) }), replacement: batchRepair,
    message: /A classification dimension allows at most 2500 characters of contentMarkdown; this candidate has 2501/ },
  { id: 'settings-dimension-code', stage: 'settings batch', violation: 'unrequested dimension code', chapter: 0, match: stage => isBatch(stage, 'draft'), solo: true,
    mutate: output => ({ ...output, dimensions: output.dimensions.map((item: Output, index: number) => index === 0 ? { ...item, code: 'z9' } : item) }), replacement: batchRepair,
    message: /Settings batch repair limit was exhausted: Settings batch names an unrequested dimension z9/ },
  { id: 'settings-input-refs', stage: 'settings batch', violation: 'missing requested dimension', chapter: 0, match: stage => isBatch(stage, 'draft'), solo: true,
    mutate: output => ({ ...output, dimensions: output.dimensions.slice(1) }), replacement: batchRepair,
    message: /Settings batch repair limit was exhausted: Settings batch is missing / },
  // Cross-dimension consistency review. One rides the combined run; the others are solo on the same stage.
  { id: 'settings-review-misquote', stage: 'settings consistency', violation: 'quote that does not occur in the dimension', chapter: 0, match: stage => isBatch(stage, 'consistency'),
    mutate: () => ({ issues: [{ dimension: 'a1', kind: 'conflict', quote: '进一步确认这句话不在正文里' }] }), replacement: next,
    message: /Settings consistency repair limit was exhausted: Consistency quote does not occur in a1/ },
  { id: 'settings-review-missing-check', stage: 'settings consistency', violation: 'quote the native schema accepts but the dimension body does not contain', chapter: 0, match: stage => isBatch(stage, 'consistency'), solo: true,
    mutate: () => ({ issues: [{ dimension: 'a1', kind: 'gap', quote: '这段引文不在维度正文里' }] }), replacement: next,
    message: /Settings consistency repair limit was exhausted: Consistency quote does not occur in a1/ },
  { id: 'settings-review-style-severity', stage: 'settings consistency', violation: 'dimension outside the batch', chapter: 0, match: stage => isBatch(stage, 'consistency'), solo: true,
    mutate: () => ({ issues: [{ dimension: 'z9', kind: 'gap', quote: QUOTE }] }), replacement: next,
    message: /Settings consistency repair limit was exhausted: Consistency issue names a dimension outside this batch: z9/ },
  { id: 'settings-review-blocking', stage: 'settings consistency', violation: 'business: blocking conflict with no repair budget', chapter: 0, match: stage => isBatch(stage, 'consistency'),
    mutate: () => ({ issues: [{ dimension: 'a5', kind: 'conflict', quote: QUOTE }] }),
    replacement: key => key, message: /Settings repair limit was exhausted for a5/, solo: true },
  { id: 'collection-review-misquote', stage: 'settings consistency', violation: 'quote that does not occur in the named dimension', chapter: 0, match: stage => isBatch(stage, 'consistency'), solo: true,
    mutate: () => ({ issues: [{ dimension: 'e1', kind: 'gap', quote: '并不存在的缺口' }] }), replacement: next,
    message: /Settings consistency repair limit was exhausted: Consistency quote does not occur in e1/ },
  // Book outline
  { id: 'book-chapter-count', stage: 'book outline', violation: 'count (2 of 3 chapters)', chapter: 0, match: stage => stage.kind === 'book-outline',
    mutate: output => ({ ...output, chapters: output.chapters.slice(0, 2) }), replacement: next,
    message: /Book chapters must cover the requested count in order from chapter 1: expected chapters 1–3, got \[1, 2\]/ },
  { id: 'book-review-target', stage: 'book outline review', violation: 'cross-reference (wrong reviewed version)', chapter: 0, match: stage => isReviewOf(stage, 'book-outline'),
    mutate: output => ({ ...output, reviewed: { ...output.reviewed, sha256: '0'.repeat(64) } }), replacement: next,
    message: /Reviewed artifact differs from the requested candidate version: got artifact_\S+@000000000000, expected/ },
  // Chapter outlines
  { id: 'outline-unknown-obligation', stage: 'chapter outline', violation: 'cross-reference (unknown obligation)', chapter: 1, match: stage => isChapterStage(stage, 'chapter-outline', 1),
    mutate: output => ({ ...output, scenes: output.scenes.map((scene: Output) => ({ ...scene, obligationIds: [...scene.obligationIds, 'ghost'] })) }), replacement: next,
    message: /Scene names an unknown obligation: scene "chapter-1-scene-1" cites "ghost"; known obligations are "signal-1"/ },
  { id: 'outline-chapter-number', stage: 'chapter outline', violation: 'cross-reference (wrong chapterNumber)', chapter: 2, match: stage => isChapterStage(stage, 'chapter-outline', 2),
    mutate: output => ({ ...output, chapterNumber: 9 }), replacement: next, message: /Chapter outline does not match the requested chapter: got 9, expected 2/ },
  { id: 'outline-uncovered-obligation', stage: 'chapter outline', violation: 'coverage (obligation without scene)', chapter: 3, match: stage => isChapterStage(stage, 'chapter-outline', 3),
    mutate: output => ({ ...output, scenes: output.scenes.map((scene: Output) => ({ ...scene, obligationIds: [] })) }), replacement: next,
    message: /A required obligation has no assigned scene: "signal-3"/ },
  { id: 'outline-review-missing-check', stage: 'chapter outline review', violation: 'missing required check', chapter: 3, match: stage => isReviewOf(stage, 'chapter-outline', 3),
    mutate: dropCheck('obligations'), replacement: next, message: /Review is missing a required check: obligations/ },
  // Bodies
  { id: 'body-scene-order', stage: 'body', violation: 'cross-reference (unplanned scene id)', chapter: 1, match: stage => isChapterStage(stage, 'body', 1),
    mutate: output => ({ ...output, scenes: output.scenes.map((scene: Output) => ({ ...scene, sceneId: 'extra-scene' })) }), replacement: next,
    message: /Body must contain every planned scene in the requested order: expected \["chapter-1-scene-1"\], got \["extra-scene"\]/ },
  { id: 'body-too-short', stage: 'body', violation: 'chapter too short (business: length repair)', chapter: 2, match: stage => isChapterStage(stage, 'body', 2),
    mutate: output => ({ ...output, scenes: output.scenes.map((scene: Output) => ({ ...scene, text: [...scene.text].slice(0, 300).join('') })) }), replacement: next,
    message: /Repair limit was exhausted for body\/2: The host counted \d+ Story-counted words \(accepted 3000–5000\): \d+ under the minimum/ },
  { id: 'body-too-long', stage: 'body', violation: 'chapter too long (business: length repair)', chapter: 3, match: stage => isChapterStage(stage, 'body', 3),
    mutate: output => ({ ...output, scenes: output.scenes.map((scene: Output) => ({ ...scene, text: scene.text.repeat(2) })) }), replacement: next,
    message: /Repair limit was exhausted for body\/3: The host counted \d+ Story-counted words \(accepted 3000–5000\): \d+ over the maximum/ },
  { id: 'body-review-misquote', stage: 'body review', violation: 'misquote (invented lead-in)', chapter: 1, match: stage => isReviewOf(stage, 'body', 1),
    mutate: misquote, replacement: citationNext, message: /Review output repair limit was exhausted: Evidence quote does not occur in its declared source/ },
  { id: 'body-review-malformed', stage: 'body review', violation: 'malformed JSON from the provider (same-key capture retry)', chapter: 2, match: stage => isReviewOf(stage, 'body', 2),
    finish: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }, replacement: same,
    message: /could not be decoded \(MALFORMED_RESPONSE\)/ },
  // Continuity
  { id: 'continuity-misquote', stage: 'continuity', violation: 'misquote (timeline evidence)', chapter: 1, match: stage => isChapterStage(stage, 'continuity', 1),
    mutate: output => ({ ...output, timeline: output.timeline.map((event: Output) => ({ ...event, evidence: event.evidence.map((item: Output) => ({ ...item, quote: `进一步确认${item.quote}` })) })) }), replacement: next,
    message: /Repair limit was exhausted for continuity\/1: Evidence quote does not occur in its declared source/ },
  { id: 'continuity-obligation-evidence', stage: 'continuity', violation: 'cross-reference (fulfilled without body evidence)', chapter: 2, match: stage => isChapterStage(stage, 'continuity', 2),
    mutate: output => ({ ...output, obligations: output.obligations.map((item: Output) => ({ ...item, evidence: output.timeline[0].evidence.filter((citation: Output) => citation.artifactId !== output.timeline.at(-1).evidence[0].artifactId) })) }),
    replacement: next, message: /A fulfilled obligation requires evidence from the actual reviewed body: obligation "signal-2" cites no quote from artifact_/ },
  { id: 'continuity-incomplete', stage: 'continuity', violation: 'business: obligation left open', chapter: 3, match: stage => isChapterStage(stage, 'continuity', 3),
    mutate: output => ({ ...output, obligations: output.obligations.map((item: Output) => ({ ...item, status: 'open' })) }), replacement: next,
    message: /Repair limit was exhausted for continuity\/3: Every required event for this chapter must be fulfilled by the actual reviewed prose: not fulfilled signal-3 \(open\)/ },
  { id: 'continuity-review-missing-check', stage: 'continuity review', violation: 'missing required check', chapter: 2, match: stage => isReviewOf(stage, 'continuity', 2),
    mutate: dropCheck('continuity'), replacement: next, message: /Review is missing a required check: continuity/ },
]

/** Repair attempts of continuity receive the rejected same-chapter continuity as feedback, which the fixture generator would otherwise read as a prior chapter; cite the reviewed body instead. */
function cleanContinuityRepair(stage: WritingFixtureStage, output: Output): object {
  if (stage.kind !== 'continuity' || (stage.task?.validationError ?? null) === null) return output
  const bodyId = stage.task!.bodyId!
  const quote = StageOutputSchemas.body.parse(JSON.parse(stage.sources.get(bodyId)!.text)).scenes[0]!.text.slice(0, 100)
  const evidence = [{ artifactId: bodyId, quote }]
  return { ...output, timeline: [{ event: `第${output.chapterNumber}章航标调查完成。`, evidence }], obligations: output.obligations.map((item: Output) => ({ ...item, evidence })) }
}

export async function pipeline(maxRepairAttempts: number, selected: readonly Injection[], throughChapter = 3) {
  const fired = new Map<string, WritingFixtureStage>()
  const pick = (stage: WritingFixtureStage) => selected.find(item => !fired.has(item.id) && item.match(stage))
  const fixture = await useWritingFixture({
    maxReadChars: 2048,
    correctNativeRejections: true,
    executionLimits: { maxRepairAttempts },
    injectFinish(stage) {
      const injection = pick(stage)
      if (injection?.finish === undefined) return undefined
      fired.set(injection.id, stage)
      return injection.finish
    },
    intervene(stage, output) {
      const injection = pick(stage)
      if (injection?.mutate === undefined) return cleanContinuityRepair(stage, output as Output)
      fired.set(injection.id, stage)
      return injection.mutate(output as Output, stage)
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: LIVE_ROOTS, throughChapter }))
  if (outcome.status === 'rejected') throw outcome.reason
  return { fixture, run: outcome.value, fired }
}

/** Stage keys counted by the live plan: every research, candidate and review key, without local planning captures. */
export function stageKeys(attempts: readonly { key: string }[]): string[] {
  return [...new Set(attempts.map(attempt => attempt.key))].filter(key => !/\/planning(\/\d+)?$/u.test(key))
}


/** @param ids - Injection ids whose zero-budget failure this file proves; split across files so vitest runs them in parallel workers. */
export function zeroBudgetCases(ids: readonly string[]): void {
  const selected = ids.map(id => { const found = injections.find(item => item.id === id); if (found === undefined) throw new Error(`Unknown injection ${id}`); return found })
  it.each(selected.map(item => [item.id, item] as const))('fails on %s with its specific message when maxRepairAttempts is 0', async (_id, injection) => {
    const { run, fired } = await pipeline(0, [injection], Math.max(1, injection.chapter))
    expect(fired.has(injection.id)).toBe(true)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(injection.message)
    const stage = fired.get(injection.id)!
    const attempt = run.attempts.find(item => item.childSessionId === stage.sessionId)!
    const replacement = injection.replacement(attempt.key)
    expect(run.attempts.filter(item => item.key === replacement && item.childSessionId !== stage.sessionId)).toEqual([])
  }, 300_000)
}
