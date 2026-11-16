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
import { splitParagraphTexts } from './paragraphs.ts'
import { extractRequiredEvents, missingRequiredEvents } from './required-events.ts'
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
