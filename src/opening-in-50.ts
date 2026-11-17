/**
 * Chapter-1 opening check.
 *
 * The first 50 Story-counted words must show a person, an event, and a conflict. The window is
 * {@link prefixByStoryWords}, the same language-side counter as the chapter length. A later mention
 * does not pass. A miss on an otherwise clean chapter is an advisory reminder. It does not
 * start a repair round, fail the chapter, or add a failure signature. When a repair is already
 * running for another reason, the miss is merged into that repair text.
 */
import { prefixByStoryWords } from './body-text.ts'

/** Story-counted words at the start of chapter 1. */
export const OPENING_IN_50_UNITS = 50

/** A chapter-1 opening that missed one of the three required showings. */
export interface OpeningIn50Miss {
  readonly check: 'openingIn50'
  readonly absent: readonly ('person' | 'event' | 'conflict')[]
  readonly units: typeof OPENING_IN_50_UNITS
}

/** A pronoun, or two to four Han characters immediately before an action. */
const PERSON = /他|她|我|你|(?:[\u4e00-\u9fff]{2,4})(?=[推拉开走站坐看说问答笑怒打杀进冲跑])/u
/** An action inside the opening window. */
const EVENT = /[推拉开走站坐看说问答笑怒打杀进冲跑]/u
/** A turn, a threat, or a refusal inside the opening window. */
const CONFLICT = /但|却|可是|然而|不过|不料|突然|冲突|刀|杀|拦|抢|逼|怒/u

/**
 * @param input - Chapter number and assembled prose.
 * @returns The miss, or null when this is not chapter 1 or the opening window shows all three.
 */
export function openingIn50Miss(input: { readonly chapterNumber: number; readonly bodyText: string }): OpeningIn50Miss | null {
  if (input.chapterNumber !== 1) return null
  const window = prefixByStoryWords(input.bodyText, OPENING_IN_50_UNITS)
  const absent: OpeningIn50Miss['absent'][number][] = []
  if (!PERSON.test(window)) absent.push('person')
  if (!EVENT.test(window)) absent.push('event')
  if (!CONFLICT.test(window)) absent.push('conflict')
  if (absent.length === 0) return null
  return { check: 'openingIn50', absent, units: OPENING_IN_50_UNITS }
}

/** @param miss - What the first 50 Story-counted words did not show. @returns The repair instruction. */
export function openingIn50RepairInstruction(miss: OpeningIn50Miss): string {
  return `Host openingIn50 check: chapter 1 must show a person, an event, and a conflict inside the first ${miss.units} Story-counted words (missing: ${miss.absent.join(', ')}). A later mention does not pass.`
}
