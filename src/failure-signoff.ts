/**
 * Failure sign-off for a version-14 body repair.
 *
 * The signature comes from absent required-event keywords and from pov-limited issues that name a paragraph.
 * Missed metric event keywords are included only when the caller already has a failed round. They do not create one.
 * Style issues, AI-tone issues, and poison repair rounds are not a signature. Versions before 14 do not call this.
 */

/** One consecutive run of the same signature inside one body stage. */
export interface FailureStreak { readonly signature: string; readonly rounds: number }

/** What the next repair should do after the round that just finished. */
export interface FailureRepairDecision {
  readonly stop: boolean
  readonly streak: FailureStreak | null
  /** Appended to the next repair prompt after the first signed-off failure. Null when that signature repeats, or when it differs. */
  readonly note: string | null
}

const POV_PARAGRAPH = /^p[1-9][0-9]*$/u

/** @returns The version-14 repair sentence. It does not name a round count. */
export function sameDefectNote(): string {
  return `The same defect was not fixed in the previous round; only change the related paragraphs, don't rewrite the whole text.`
}

function pushKeyword(keywords: string[], keyword: string): void {
  const text = keyword.trim()
  if (text.length > 0 && !keywords.includes(text)) keywords.push(text)
}

/**
 * @param input - Absent required-event keywords, missed metric event keywords, and review issues.
 * Style, AI-tone, and poison issues are ignored. A pov issue counts only when it has a paragraph id.
 * @returns `missing:落石|雷击`, `pov:p1|p3`, both joined by `;`, or null when nothing tracked failed.
 */
export function failureSignature(input: {
  readonly missingKeywords?: readonly string[]
  readonly eventHits?: readonly { readonly keywords: readonly string[]; readonly hit: boolean }[]
  readonly issues?: readonly { readonly category?: string; readonly id?: string; readonly paragraphId?: string; readonly poison?: string }[]
}): string | null {
  const missing: string[] = []
  for (const keyword of input.missingKeywords ?? []) pushKeyword(missing, keyword)
  for (const hit of input.eventHits ?? []) if (!hit.hit) for (const keyword of hit.keywords) pushKeyword(missing, keyword)
  const pov = [...new Set((input.issues ?? []).flatMap(issue => {
    if (issue.category !== 'pov' || issue.poison !== undefined) return []
    if (typeof issue.id === 'string' && issue.id.startsWith('ai-tone')) return []
    return issue.paragraphId !== undefined && POV_PARAGRAPH.test(issue.paragraphId) ? [issue.paragraphId] : []
  }))].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
  const parts: string[] = []
  if (missing.length > 0) parts.push(`missing:${missing.join('|')}`)
  if (pov.length > 0) parts.push(`pov:${pov.join('|')}`)
  return parts.length === 0 ? null : parts.join(';')
}

/**
 * An AI-tone, style, or poison round. It does not record a signature, does not inject, and leaves the streak unchanged.
 * @param previous - The streak from the last counted round.
 */
export function skipFailureRound(previous: FailureStreak | null): FailureRepairDecision {
  return { stop: false, streak: previous, note: null }
}

/**
 * The first signed-off failure injects the repair sentence into the next round.
 * The same signature on the next counted round stops before another repair and does not inject.
 * A changed signature does not inject the note and resets the count. A null signature clears the streak.
 * @param previous - The signature streak before this counted round, or null when there is none.
 * @param signature - This counted round's signature, or null when it has no required-event, metric, or pov defect.
 */
export function nextFailureRepair(previous: FailureStreak | null, signature: string | null): FailureRepairDecision {
  if (signature === null) return { stop: false, streak: null, note: null }
  if (previous !== null && previous.signature === signature) return { stop: true, streak: { signature, rounds: previous.rounds + 1 }, note: null }
  if (previous === null) return { stop: false, streak: { signature, rounds: 1 }, note: sameDefectNote() }
  return { stop: false, streak: { signature, rounds: 1 }, note: null }
}
