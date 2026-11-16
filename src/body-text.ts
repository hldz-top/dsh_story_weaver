/** Deterministic chapter assembly and Story-compatible word counting. */
import type { BodyOutput } from './stage-output.ts'

/** Inclusive chapter-total bounds supplied by the host configuration. */
export interface BodyWordBounds { readonly minChapterWords: number; readonly maxChapterWords: number }
/** Program-owned chapter length finding; a violation blocks application. */
export type BodyLengthResult = { readonly status: 'within-range'; readonly blocking: false }
  | { readonly status: 'too-short' | 'too-long'; readonly blocking: true }
/**
 * Host-measured positions handed to a body review. Offsets count Unicode code points of the assembled chapter (scenes
 * joined with "\n\n", no title; punctuation and whitespace included); percent = offset / totalChars × 100, one decimal.
 */
export interface BodyBeats {
  readonly totalChars: number
  readonly scenes: readonly { readonly sceneId: string; readonly offset: number; readonly percent: number }[]
  /** Standalone 【…】 lines (a whole line from 【 to 】), in order. */
  readonly panels: readonly { readonly index: number; readonly offset: number; readonly percent: number; readonly text: string }[]
}
/** Exact assembled text and its deterministic length finding. */
export interface BodyInspection { readonly text: string; readonly wordCount: number; readonly length: BodyLengthResult }

/** @param output - Validated scenes in chapter order. @returns Exact scene text separated by two line feeds. */
export function assembleBody(output: BodyOutput): string {
  return output.scenes.map(scene => scene.text).join('\n\n')
}

/** @param output - Validated scenes in chapter order. @returns Scene and panel-line positions in code points of the assembled chapter. */
export function measureBeats(output: BodyOutput): BodyBeats {
  const text = assembleBody(output)
  const totalChars = [...text].length
  const percent = (offset: number) => totalChars === 0 ? 0 : Math.round(offset / totalChars * 1000) / 10
  const scenes: { sceneId: string; offset: number; percent: number }[] = []
  let offset = 0
  for (const scene of output.scenes) {
    scenes.push({ sceneId: scene.sceneId, offset, percent: percent(offset) })
    offset += [...scene.text].length + 2
  }
  const panels = [...text.matchAll(/^【[^\n]*】$/gmu)].map((match, index) => {
    const at = [...text.slice(0, match.index)].length
    return { index: index + 1, offset: at, percent: percent(at), text: match[0] }
  })
  return { totalChars, scenes, panels }
}

/** One Story word: a Han character, or one ASCII word or number. A new pattern each call, so a global regex cannot keep `lastIndex`. */
function storyWordPattern(): RegExp {
  return /[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu
}

/** @param text - Reader-facing chapter prose. @returns The Story word count. */
export function countStoryWords(text: string): number {
  let count = 0
  for (const _match of text.matchAll(storyWordPattern())) count += 1
  return count
}

/**
 * Prefix that contains the first `words` Story words.
 * @param text - Reader-facing prose.
 * @param words - Positive count. The same counter as {@link countStoryWords}.
 * @returns The text through the end of that word, or the whole text when it has fewer words.
 */
export function prefixByStoryWords(text: string, words: number): string {
  if (!Number.isSafeInteger(words) || words < 1) throw new RangeError('words must be a positive safe integer')
  let count = 0
  for (const match of text.matchAll(storyWordPattern())) {
    count += 1
    if (count === words) return text.slice(0, (match.index ?? 0) + match[0].length)
  }
  return text
}

/** @param output - Validated scene text in planned order. @param bounds - Positive safe integer inclusive chapter bounds; invalid or reversed limits throw RangeError. @returns Unmodified prose, measured words, and a blocking finding when outside the range. */
export function inspectBody(output: BodyOutput, bounds: BodyWordBounds): BodyInspection {
  for (const name of ['minChapterWords', 'maxChapterWords'] as const) {
    if (!Number.isSafeInteger(bounds[name]) || bounds[name] <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  }
  if (bounds.minChapterWords > bounds.maxChapterWords) throw new RangeError('minChapterWords must not exceed maxChapterWords')
  const text = assembleBody(output)
  const wordCount = countStoryWords(text)
  const length: BodyLengthResult = wordCount < bounds.minChapterWords
    ? { status: 'too-short', blocking: true }
    : wordCount > bounds.maxChapterWords
      ? { status: 'too-long', blocking: true }
      : { status: 'within-range', blocking: false }
  return { text, wordCount, length }
}
