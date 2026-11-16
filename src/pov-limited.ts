/**
 * Advisory limited-POV hints for a version-12 body review.
 *
 * The fixed review check is `pov-limited` (category `pov`). This module does not decide that check. It only
 * names narration the reviewer may confirm. A hint never blocks, rejects, or returns a chapter for repair.
 * The check itself runs for every version-12 body, whether or not the brief mentions a limited point of view.
 *
 * The viewpoint is a name written after `视角人物`, `限知视角`, `pov-limited`, or `POV` in the chapter outline
 * or settings. When none is named, `viewpoint` is null and the host adds no hint: the reviewer infers the
 * viewpoint from the body, and a missing name is not a failure. Narration is the assembled chapter after
 * {@link narrationOf} removes 「」 / “” dialogue and standalone 【】 lines. A Han piece after `的`, `地`, or `得`
 * immediately before an interior verb is another person's mind when it is not the viewpoint and not a pronoun.
 * The viewpoint's own `心想` or `觉得` is not a hint.
 */
import { narrationOf } from './ai-tone.ts'

/** Fixed review check. Issues that fail it use this id and category `pov`. */
export const POV_LIMITED_CHECK = 'pov-limited'

/** One advisory hint. `paragraphId` is set when the excerpt sits in a host paragraph. */
export interface PovHeuristicHint {
  readonly check: typeof POV_LIMITED_CHECK
  readonly excerpt: string
  /** Paragraph of the reviewed body that contains the excerpt, when the host split has one. */
  readonly paragraphId: string | null
}

/** Advisory host report passed to the reviewer as `task.povHeuristic`. Empty hints are omitted by the runner. */
export interface PovHeuristicReport {
  readonly viewpoint: string | null
  readonly hints: readonly PovHeuristicHint[]
}

const NAME_MARK = /(?:限知视角|视角人物|pov-limited|POV)\s*[:：]\s*([^\s，。,.；;：:、！!？?"'\]}）)]{1,30})/giu
const PRONOUNS = ['他们', '她们', '它们', '咱们', '我们', '你们', '自己', '他', '她', '它', '我', '你', '您', '咱'] as const
/** Interior verbs and unspoken judgments. Longer phrases stay ahead of their prefixes. `知道` is intentionally absent. */
const VERBS = ['心中暗道', '心里想', '心中想', '意识到', '心想', '腹诽', '暗道', '暗想', '心道', '心里', '内心', '觉得', '感到', '想起'] as const
const OMNISCIENT = ['上帝视角', '全知视角', '全知叙述', 'omniscient narrator', 'omniscient'] as const
const MAX_HINTS = 8

function isHan(char: string): boolean {
  return /\p{Script=Han}/u.test(char)
}

/**
 * @param texts - Chapter-outline and settings text. The brief is not a gate.
 * @returns The first named viewpoint, or null when the outline and settings do not name one.
 */
export function viewpointName(texts: readonly string[]): string | null {
  for (const text of texts) {
    NAME_MARK.lastIndex = 0
    const name = NAME_MARK.exec(text)?.[1]
    if (name !== undefined && name.length > 0) return name
  }
  return null
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function hanPieceBefore(text: string, index: number): string {
  let start = index
  while (start > 0 && isHan(text[start - 1]!)) start -= 1
  const run = text.slice(start, index)
  return run.split(/[的地得]/u).at(-1) ?? run
}

function subjectKind(piece: string, viewpoint: string): 'viewpoint' | 'pronoun' | 'other' | 'none' {
  if (piece.length === 0) return 'none'
  if (PRONOUNS.some(item => piece === item || piece.endsWith(item))) return 'pronoun'
  if (piece === viewpoint || (viewpoint.length >= 2 && piece.endsWith(viewpoint) && piece.length > viewpoint.length)) return 'viewpoint'
  return 'other'
}

function verbAt(text: string, index: number): string | null {
  return VERBS.find(verb => text.startsWith(verb, index)) ?? null
}

function paragraphIdFor(excerpt: string, paragraphs: readonly { readonly id: string; readonly text: string }[] | undefined): string | null {
  if (paragraphs === undefined) return null
  return paragraphs.find(paragraph => paragraph.text.includes(excerpt))?.id ?? null
}

/**
 * @param input - Assembled narration, the named viewpoint if the outline or settings provide one, and the host paragraph split.
 * @returns Advisory hints. A null viewpoint yields no hints and is not a failure.
 */
export function povHeuristicReport(input: {
  readonly prose: string
  readonly viewpoint: string | null
  readonly paragraphs?: readonly { readonly id: string; readonly text: string }[]
}): PovHeuristicReport {
  const narration = narrationOf(input.prose)
  const hints: PovHeuristicHint[] = []
  const push = (excerpt: string) => {
    if (hints.length >= MAX_HINTS || hints.some(hint => hint.excerpt === excerpt)) return
    hints.push({ check: POV_LIMITED_CHECK, excerpt, paragraphId: paragraphIdFor(excerpt, input.paragraphs) })
  }
  const lower = narration.toLowerCase()
  for (const phrase of OMNISCIENT) {
    const at = lower.indexOf(phrase.toLowerCase())
    if (at >= 0) push(narration.slice(at, at + phrase.length))
  }
  const viewpoint = input.viewpoint
  if (viewpoint !== null) {
    for (let index = 0; index < narration.length && hints.length < MAX_HINTS; index += 1) {
      const verb = verbAt(narration, index)
      if (verb === null) continue
      const piece = hanPieceBefore(narration, index)
      if (subjectKind(piece, viewpoint) === 'other' && piece.length >= 2 && !sameName(piece, viewpoint)) push(`${piece}${verb}`)
      index += verb.length - 1
    }
  }
  return { viewpoint, hints }
}
