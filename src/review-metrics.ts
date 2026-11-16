/**
 * Advisory measurements of one assembled chapter.
 *
 * The inputs are the assembled prose, the previous chapter's continuity snapshot, and the brief and settings
 * texts the required-event words are read from. The same inputs always return the same value. Nothing here is
 * written into a book outline or a chapter outline, and nothing here decides whether a draft is applied.
 * A keyword miss is a row in `eventHits`. The host required-event check still splices its own misses into the
 * repair instruction; this table does not.
 */
import { countHanChars } from './body-text.ts'
import { CharacterSheetRejection, parseCharacterSheet, type CharacterSheet } from './character-sheet.ts'
import { splitParagraphTexts } from './paragraphs.ts'
import { extractRequiredEvents, missingRequiredEvents } from './required-events.ts'
import { mergeCharacterSheets } from './scene-cast.ts'
import type { PromptVersion } from './stage-prompts.ts'

/** Code points taken from the end of the assembled chapter. */
export const HOOK_WINDOW_CHARS = 300
/** Plugin default. A later change can read the recorded flag; this module never turns a metric into a veto. */
export const METRICS_BLOCKING_DEFAULT = false

/** Unrecovered notes from the previous chapter snapshot. Null when this is the first chapter. */
export interface PreviousChapterSnapshot {
  readonly unrecoveredForeshadowing: readonly { readonly note: string }[]
}
/** Texts the measurement reads. Settings are reader-facing prose, one document each. */
export interface ChapterMetricsInput {
  readonly text: string
  readonly previousSnapshot: PreviousChapterSnapshot | null
  readonly briefText: string
  readonly settingsTexts: readonly string[]
}
/** One sentence in the closing window that is still open, or that still carries an unrecovered snapshot note. */
export interface HookWindow {
  readonly chars: typeof HOOK_WINDOW_CHARS
  readonly fragments: readonly string[]
}
/** A narration paragraph and where it starts in the assembled chapter, as a ratio of code points. */
export interface BeatPosition {
  readonly paragraph: string
  readonly ratio: number
}
/** One required-event line from the brief or from settings, and whether every keyword occurs in the chapter. */
export interface EventHit {
  readonly index: number
  readonly source: 'brief' | 'settings'
  readonly text: string
  readonly keywords: readonly string[]
  readonly hit: boolean
}
/** Five host measurements. There is no pass flag. */
export interface ChapterMetrics {
  readonly wordCount: number
  readonly dialogueRatio: number
  readonly hookWindow: HookWindow
  readonly beatPositions: readonly BeatPosition[]
  readonly eventHits: readonly EventHit[]
}

/** 「」 and “” that do not cross a line. Half-width quotes and full-width ＂ are not these pairs. A fresh pattern, so lastIndex cannot leak between paragraphs. */
function dialoguePattern(): RegExp {
  return /「[^」\n]*」|“[^”\n]*”/gu
}
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/u
/** Sentence ends. A full-width or half-width stop, question, exclamation, or semicolon; an ellipsis; a dash. A period between digits is not an end. Commas are not ends. */
const SENTENCE_END = /(……+|\.{3,}|——+|—+|[。！？；!?;\n]|．|(?<!\d)\.(?!\d))/gu
const SUSPENSE_END = /(?:……|\.{3,}|——|—|[？?])$/u

function hanIn(text: string): number {
  return countHanChars(text)
}

function sentencesOf(text: string): string[] {
  const sentences: string[] = []
  let last = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    const sentence = text.slice(last, end).trim()
    if (sentence.length > 0) sentences.push(sentence)
    last = end
  }
  const tail = text.slice(last).trim()
  if (tail.length > 0) sentences.push(tail)
  return sentences
}

function closingWindow(text: string): string {
  const chars = [...text]
  return chars.slice(Math.max(0, chars.length - HOOK_WINDOW_CHARS)).join('')
}

function unresolved(sentence: string, notes: readonly string[]): boolean {
  if (notes.some(note => note.length > 0 && sentence.includes(note))) return true
  return SUSPENSE_END.test(sentence)
}

function hookWindow(text: string, snapshot: PreviousChapterSnapshot | null): HookWindow {
  const notes = (snapshot?.unrecoveredForeshadowing ?? []).map(item => item.note.trim()).filter(note => note.length > 0)
  return { chars: HOOK_WINDOW_CHARS, fragments: sentencesOf(closingWindow(text)).filter(sentence => unresolved(sentence, notes)) }
}

function beatPositions(text: string): BeatPosition[] {
  const total = [...text].length
  if (total === 0) return []
  const positions: BeatPosition[] = []
  let searchFrom = 0
  for (const paragraph of splitParagraphTexts(text)) {
    const narration = paragraph.replace(dialoguePattern(), '')
    if (!HAN.test(narration)) continue
    const at = text.indexOf(paragraph, searchFrom)
    if (at < 0) continue
    const offset = Array.from(text.slice(0, at)).length
    searchFrom = at + paragraph.length
    positions.push({ paragraph, ratio: Math.round(offset / total * 1000) / 1000 })
  }
  return positions
}

function hitsFrom(text: string, sourceText: string, source: EventHit['source']): EventHit[] {
  const events = extractRequiredEvents({ briefText: sourceText })
  const missing = new Set(missingRequiredEvents(text, events).map(item => `${item.index}\u0000${item.text}`))
  return events.map(event => ({
    index: event.index, source, text: event.text, keywords: [...event.keywords], hit: !missing.has(`${event.index}\u0000${event.text}`),
  }))
}

/**
 * Measure one assembled chapter.
 * @param input - Assembled prose, the previous snapshot, and the brief and settings the event words are read from.
 */
export function measureChapterMetrics(input: ChapterMetricsInput): ChapterMetrics {
  const wordCount = hanIn(input.text)
  const dialogueWords = hanIn([...input.text.matchAll(dialoguePattern())].map(match => match[0]).join(''))
  const dialogueRatio = wordCount === 0 ? 0 : Math.round((dialogueWords * 1000) / wordCount) / 1000
  const eventHits = [
    ...hitsFrom(input.text, input.briefText, 'brief'),
    ...input.settingsTexts.flatMap(settings => hitsFrom(input.text, settings, 'settings')),
  ]
  return { wordCount, dialogueRatio, hookWindow: hookWindow(input.text, input.previousSnapshot), beatPositions: beatPositions(input.text), eventHits }
}

/**
 * Review-task fields for a body. Versions before 11 omit them, so a resumed run rebuilds its previous task bytes.
 * @param promptVersion - The run's recorded prompt version.
 * @param input - The measurement inputs, or null when this review is not a body.
 * @param metricsBlocking - The flag recorded for this run. It is not a veto in this version.
 */
export function advisoryReviewMetrics(promptVersion: PromptVersion, input: ChapterMetricsInput | null, metricsBlocking: boolean): { readonly metrics: ChapterMetrics; readonly metricsBlocking: boolean } | undefined {
  if (promptVersion < 11 || input === null) return undefined
  return { metrics: measureChapterMetrics(input), metricsBlocking }
}

/**
 * Character measurements for one chapter. These are new fields. {@link measureChapterMetrics} is unchanged.
 * Nothing here admits a draft, changes an issue's severity, or joins a failure signature.
 */

/** The three body-review checks. `character-voice` and `character-function` are blocking. `character-arc` is advisory. */
export const CHARACTER_REVIEW_CHECKS = ['character-voice', 'character-function', 'character-arc'] as const
/** Checks that must be blocking. */
export const CHARACTER_REVIEW_BLOCKING = ['character-voice', 'character-function'] as const
/** Fixed advisory check. A blocking issue with this id is rejected. */
export const CHARACTER_REVIEW_ADVISORY = 'character-arc' as const
/** How many present cast names, together with a single address form, produce one warning. */
export const ADDRESS_COLLAPSE_PRESENT = 3
/** Cast names missing from the character card are a warning above this count. */
export const UNCAST_NAME_LIMIT = 2
/** Consecutive chapters whose cast always includes the protagonist. */
export const PROTAGONIST_PRESENT_STREAK = 3

/** One id of {@link CHARACTER_REVIEW_CHECKS}. */
export type CharacterReviewCheck = (typeof CHARACTER_REVIEW_CHECKS)[number]
/** One character's `称呼主角` counted in the chapter text. */
export interface AddressCount { readonly name: string; readonly address: string; readonly count: number }
/** Whether one cast name occurs in the chapter text. */
export interface CastPresence { readonly name: string; readonly present: boolean }
/**
 * Host measurement. `warnings` are advisory sentences. They do not admit, repair, or block a chapter by themselves.
 */
export interface CharacterMetrics {
  readonly addressVariety: readonly AddressCount[]
  readonly castPresence: readonly CastPresence[]
  readonly protagonistFreeScenes: number | null
  readonly quoteP50: number
  readonly quoteP90: number
  readonly uncastNames: number
  readonly warnings: readonly string[]
}
/** One scene's cast. A scene without `cast` contributes no names. */
export interface CharacterMetricsScene { readonly cast?: readonly string[] | undefined }
/** Inputs for {@link measureCharacterMetrics}. A missing sheet never reaches this function. */
export interface CharacterMetricsInput {
  readonly bodyText: string
  readonly scenes: readonly CharacterMetricsScene[]
  readonly sheet: CharacterSheet
  readonly protagonistName: string | null
  /** Free-scene counts of the immediately previous chapters, oldest first, with no gap. */
  readonly recentProtagonistFreeScenes: readonly number[]
}

/** @param summary - A character check summary. @returns The check id when the summary starts with that id and a colon. */
export function characterCheckIdFromSummary(summary: string): CharacterReviewCheck | undefined {
  return CHARACTER_REVIEW_CHECKS.find(id => summary.startsWith(`${id}:`) || summary.startsWith(`${id}：`))
}

/** @param issueId - A review issue id. @returns The check when the id is that check, or starts with the check plus `:` or `-`. */
export function characterCheckIdFromIssue(issueId: string): CharacterReviewCheck | undefined {
  return CHARACTER_REVIEW_CHECKS.find(id => issueId === id || issueId.startsWith(`${id}:`) || issueId.startsWith(`${id}-`))
}

/**
 * Parse every e5/e6 body. An empty list, a rejected table, or a merge with no shared names returns null.
 * The caller then omits character metrics. This does not raise a chapter failure.
 * @param markdowns - e5 and e6 contentMarkdown values. @param maxCharacters - Per-dimension cap.
 */
export function sheetForCharacterMetrics(markdowns: readonly string[], maxCharacters: number): CharacterSheet | null {
  if (markdowns.length === 0) return null
  const sheets: CharacterSheet[] = []
  for (const markdown of markdowns) {
    try { sheets.push(parseCharacterSheet(markdown, { maxCharacters })) }
    catch (cause) {
      if (cause instanceof CharacterSheetRejection) return null
      throw cause
    }
  }
  return mergeCharacterSheets(sheets)
}

/** @param scenes - Chapter scenes. @param protagonistName - Blank or null leaves the count unknown. @returns Scenes whose cast does not include the protagonist. */
export function protagonistFreeSceneCount(scenes: readonly CharacterMetricsScene[], protagonistName: string | null): number | null {
  if (protagonistName === null || protagonistName.trim().length === 0) return null
  return scenes.filter(scene => !(scene.cast ?? []).includes(protagonistName)).length
}

/**
 * Measure one chapter from its text, outline cast and character card.
 * @param input - Already parsed inputs.
 */
export function measureCharacterMetrics(input: CharacterMetricsInput): CharacterMetrics {
  const castNames = uniqueCast(input.scenes)
  const known = new Set(input.sheet.core.map(row => row.name))
  const addressVariety = input.sheet.voice.map(row => ({ name: row.name, address: row.addressForProtagonist, count: occurrences(input.bodyText, row.addressForProtagonist) }))
  const castPresence = castNames.map(name => ({ name, present: input.bodyText.includes(name) }))
  const protagonistFreeScenes = protagonistFreeSceneCount(input.scenes, input.protagonistName)
  const quoteLengths = [...input.bodyText.matchAll(dialoguePattern())].map(match => codePointLength(match[0].slice(1, -1))).sort((left, right) => left - right)
  const uncastNames = castNames.filter(name => !known.has(name)).length
  const present = castPresence.filter(row => row.present).length
  const usedAddresses = new Set(addressVariety.filter(row => row.count > 0).map(row => row.address))
  const warnings: string[] = []
  if (present >= ADDRESS_COLLAPSE_PRESENT && usedAddresses.size === 1) warnings.push(`${present} characters are present and only 1 address form is used.`)
  for (const row of castPresence) if (!row.present) warnings.push(`Cast name ${row.name} does not appear in the chapter.`)
  if (uncastNames > UNCAST_NAME_LIMIT) warnings.push(`Cast names not on the character card: ${uncastNames}. More than ${UNCAST_NAME_LIMIT}.`)
  if (protagonistFreeScenes === 0 && input.recentProtagonistFreeScenes.length >= PROTAGONIST_PRESENT_STREAK - 1
    && input.recentProtagonistFreeScenes.slice(-(PROTAGONIST_PRESENT_STREAK - 1)).every(count => count === 0)) {
    warnings.push(`The protagonist is in every scene for ${PROTAGONIST_PRESENT_STREAK} consecutive chapters.`)
  }
  return { addressVariety, castPresence, protagonistFreeScenes, quoteP50: percentile(quoteLengths, 50), quoteP90: percentile(quoteLengths, 90), uncastNames, warnings }
}

/**
 * Append advisory metric warnings to a repair instruction. An empty warning list returns the instruction unchanged.
 * The function does not read or write review issues.
 * @param instruction - The repair text already chosen. @param metrics - Measurements of the chapter being repaired.
 */
export function appendCharacterMetricWarnings(instruction: string, metrics: CharacterMetrics | undefined): string {
  if (metrics === undefined || metrics.warnings.length === 0) return instruction
  return `${instruction} Advisory character metrics (not a gate; do not change issue severity): ${metrics.warnings.join(' ')}`
}

function uniqueCast(scenes: readonly CharacterMetricsScene[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const scene of scenes) for (const name of scene.cast ?? []) {
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function occurrences(text: string, term: string): number {
  if (term.length === 0) return 0
  let count = 0
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(term, from)
    if (at < 0) break
    count += 1
    from = at + term.length
  }
  return count
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}
