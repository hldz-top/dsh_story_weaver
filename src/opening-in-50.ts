/**
 * Chapter-1 opening hard check.
 *
 * The creative brief is the only source. A heading that names the chapter-1 opening states the requirement.
 * For chapter 1, every keyword of that requirement must occur inside the first 50 Story-counted words.
 * A later mention does not pass. Other chapters are not checked. A brief that states no opening requirement
 * adds nothing: the check does not invent one.
 */
import { prefixByStoryWords } from './body-text.ts'
import { requiredEventKeywords } from './required-events.ts'

/** Story-counted words at the start of chapter 1 that must contain the approved opening. */
export const OPENING_IN_50_UNITS = 50

/** The brief's chapter-1 opening requirement, and the keywords that must occur in the opening window. */
export interface OpeningRequirement {
  readonly text: string
  readonly keywords: readonly string[]
}

/** A chapter-1 opening that missed the first {@link OPENING_IN_50_UNITS} Story-counted words. */
export interface OpeningIn50Miss {
  readonly check: 'openingIn50'
  readonly requirement: string
  readonly absentKeywords: readonly string[]
  readonly units: typeof OPENING_IN_50_UNITS
}

/** Longer markers first, so 开篇钩子 is not read as a bare 开篇. */
const MARKERS = [
  '第1章开篇', '第一章开篇', '开篇钩子', '开场钩子', '开篇要求', '开场要求',
  'openingin50', 'chapter 1 opening', 'opening hook', '开篇',
] as const

function clean(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().replace(/[。！？!?;；]+$/u, '').trim()
}

function compact(value: string): string {
  return value.replace(/\s+/gu, '')
}

/**
 * @param line - One brief line.
 * @returns The text after the opening marker, when the marker begins within the first six Han or Latin characters and ends the heading or a colon.
 */
function matchOpening(line: string): { tail: string } | null {
  const trimmed = line.trim()
  const lower = trimmed.toLowerCase()
  for (const marker of MARKERS) {
    const at = lower.indexOf(marker)
    if (at < 0) continue
    const before = trimmed.slice(0, at).trim()
    if ([...before].length > 6) continue
    if (before.length > 0 && !/^[\p{Script=Han}A-Za-z]+$/u.test(before)) continue
    let tail = trimmed.slice(at + marker.length).trim()
    if (tail.startsWith(':') || tail.startsWith('：')) tail = tail.slice(1).trim()
    else if (tail.length > 0) continue
    return { tail }
  }
  return null
}

/**
 * @param briefText - The creative brief.
 * @returns The first opening requirement the brief states, or null when it states none.
 */
export function extractOpeningRequirement(briefText: string): OpeningRequirement | null {
  const lines = briefText.replace(/\r\n/gu, '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const marker = matchOpening(lines[index] ?? '')
    if (marker === null) continue
    let text = clean(marker.tail)
    if (text.length === 0) {
      const nextLine = lines[index + 1] ?? ''
      if (matchOpening(nextLine) === null) text = clean(nextLine)
    }
    if ([...text].length < 2) continue
    const keywords = requiredEventKeywords(text)
    if (keywords.length === 0) continue
    return { text, keywords }
  }
  return null
}

/**
 * @param input - Chapter number, assembled prose, and the creative brief.
 * @returns The openingIn50 miss, or null when this is not chapter 1, the brief states no opening, or the opening window hits it.
 */
export function openingIn50Miss(input: {
  readonly chapterNumber: number
  readonly bodyText: string
  readonly briefText: string
}): OpeningIn50Miss | null {
  if (input.chapterNumber !== 1) return null
  const requirement = extractOpeningRequirement(input.briefText)
  if (requirement === null) return null
  const window = compact(prefixByStoryWords(input.bodyText, OPENING_IN_50_UNITS))
  const absentKeywords = requirement.keywords.filter(keyword => !window.includes(compact(keyword)))
  if (absentKeywords.length === 0) return null
  return { check: 'openingIn50', requirement: requirement.text, absentKeywords, units: OPENING_IN_50_UNITS }
}

/**
 * @param miss - The chapter-1 opening the first 50 Story-counted words did not hit.
 * @returns The repair instruction. A later mention is not accepted.
 */
export function openingIn50RepairInstruction(miss: OpeningIn50Miss): string {
  return `Host openingIn50 check: chapter 1 must satisfy 「${miss.requirement}」 inside the first ${miss.units} Story-counted words (absent: ${miss.absentKeywords.join('、')}). A later mention does not pass. The creative brief is the only source of this opening requirement.`
}
