/**
 * Deterministic character measurements for one chapter. No model calls and no I/O.
 *
 * These functions are written to move verbatim into `src/review-metrics.ts` (PR #55, head 51d64751).
 * At rebase, call {@link measureCharacterMetrics} from `advisoryReviewMetrics` and store the result on
 * `ReviewMetrics.character`. Keep `metricsBlocking` false. Do not throw when the sheet is missing or a
 * table fails to parse: {@link sheetForCharacterMetrics} returns null and the caller omits the field.
 * Warnings are repair-instruction text only. They do not change `issue.severity` and they are not a gate.
 */
import { CharacterSheetRejection, parseCharacterSheet, type CharacterSheet } from './character-sheet.ts'
import { mergeCharacterSheets } from './scene-cast.ts'

/** Prompt version that publishes the character review category and may attach these measurements. */
export const CHARACTER_REVIEW_PROMPT_VERSION = 12
/** The three body-review checks. `character-arc` is fixed advisory. The other two may block. */
export const CHARACTER_REVIEW_CHECKS = ['character-voice', 'character-function', 'character-arc'] as const
/** Checks that may be blocking. `character-arc` is not in this list. */
export const CHARACTER_REVIEW_BLOCKING = ['character-voice', 'character-function'] as const
/** Fixed advisory check. A blocking issue with this id is rejected and is not downgraded. */
export const CHARACTER_REVIEW_ADVISORY = 'character-arc' as const
/** Host flag stored next to {@link CharacterMetrics}. It is false for every chapter. */
export const CHARACTER_METRICS_BLOCKING = false
/** How many present cast names, together with a single address form, produce one warning. */
export const ADDRESS_COLLAPSE_PRESENT = 3
/** Cast names missing from the character card are a warning above this count. */
export const UNCAST_NAME_LIMIT = 2
/** Consecutive chapters whose cast always includes the protagonist. */
export const PROTAGONIST_PRESENT_STREAK = 3

/** One id of {@link CHARACTER_REVIEW_CHECKS}. */
export type CharacterReviewCheck = (typeof CHARACTER_REVIEW_CHECKS)[number]
/** One character's `称呼主角` counted in the chapter text. The same string may be counted for more than one character. */
export interface AddressCount {
  readonly name: string
  readonly address: string
  readonly count: number
}
/** Whether one cast name occurs in the chapter text. */
export interface CastPresence { readonly name: string; readonly present: boolean }
/**
 * Host measurement of address forms, cast presence, protagonist-free scenes, quote lengths and uncast names.
 * `warnings` are advisory sentences. Nothing here admits, repairs, or blocks a chapter by itself.
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
/** Inputs for {@link measureCharacterMetrics}. The sheet is already parsed; a missing sheet never reaches this function. */
export interface CharacterMetricsInput {
  readonly bodyText: string
  readonly scenes: readonly CharacterMetricsScene[]
  readonly sheet: CharacterSheet
  readonly protagonistName: string | null
  /** Free-scene counts of the immediately previous chapters, oldest first, with no gap. */
  readonly recentProtagonistFreeScenes: readonly number[]
}

/**
 * 「」 and “” spans that do not cross a line. Same pattern as `DIALOGUE` in review-metrics.ts (PR #55).
 * At rebase, delete this constant and use that one. Panels are not dialogue. An unclosed quote is not counted.
 * Lengths are the inside of the span. Quotes are not assigned to a speaker.
 */
const QUOTED_LINE = /「[^」\n]*」|“[^”\n]*”/gu

/** @param summary - A character check summary. @returns The check id when the summary starts with that id and a colon. */
export function characterCheckIdFromSummary(summary: string): CharacterReviewCheck | undefined {
  return CHARACTER_REVIEW_CHECKS.find(id => summary.startsWith(`${id}:`) || summary.startsWith(`${id}：`))
}

/** @param issueId - A review issue id. @returns The check when the id is that check, or starts with the check plus `:` or `-`. */
export function characterCheckIdFromIssue(issueId: string): CharacterReviewCheck | undefined {
  return CHARACTER_REVIEW_CHECKS.find(id => issueId === id || issueId.startsWith(`${id}:`) || issueId.startsWith(`${id}-`))
}

/**
 * Parse every e5/e6 body. An empty list, a table the parser rejects, or a merge with no shared names returns null.
 * The caller then skips metrics. This does not raise a chapter failure.
 * @param markdowns - e5 and e6 contentMarkdown values that are present. @param maxCharacters - Per-dimension cap.
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
 * @param input - Already parsed inputs. A missing card is the caller's null, not an argument here.
 */
export function measureCharacterMetrics(input: CharacterMetricsInput): CharacterMetrics {
  const castNames = uniqueCast(input.scenes)
  const known = new Set(input.sheet.core.map(row => row.name))
  const addressVariety = input.sheet.voice.map(row => ({ name: row.name, address: row.addressForProtagonist, count: occurrences(input.bodyText, row.addressForProtagonist) }))
  const castPresence = castNames.map(name => ({ name, present: input.bodyText.includes(name) }))
  const protagonistFreeScenes = protagonistFreeSceneCount(input.scenes, input.protagonistName)
  const quoteLengths = [...input.bodyText.matchAll(QUOTED_LINE)].map(match => codePointLength(match[0].slice(1, -1))).sort((left, right) => left - right)
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
  return {
    addressVariety, castPresence, protagonistFreeScenes,
    quoteP50: percentile(quoteLengths, 50), quoteP90: percentile(quoteLengths, 90),
    uncastNames, warnings,
  }
}

/**
 * Append advisory metric warnings to a repair instruction. An empty warning list returns the instruction unchanged.
 * The function does not read or write review issues.
 * @param instruction - The repair text already chosen for a blocking finding. @param metrics - Measurements of the chapter being repaired.
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
