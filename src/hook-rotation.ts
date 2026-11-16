/**
 * Deterministic closing-hook rotation.
 *
 * Chapter 1 is 悬念, then 反转, 情绪悬崖, and 信息炸弹, and the same order repeats.
 * The host checks the label in the book-outline purpose or the chapter-outline throughLine.
 * It does not add a schema field, a percentage position, or a per-beat word quota.
 */

/** Closing hook types, in rotation order. Chapter 1 is the first. */
export const HOOK_TYPES = ['悬念', '反转', '情绪悬崖', '信息炸弹'] as const
/** One closing hook type from {@link HOOK_TYPES}. */
export type HookType = (typeof HOOK_TYPES)[number]

const LABELED_HOOK = /章末钩子\s*[:：]\s*(情绪悬崖|信息炸弹|悬念|反转)/u

/**
 * @param chapterNumber - 1-based chapter index.
 * @returns The hook type assigned to that chapter. The assignment depends only on the chapter number.
 */
export function hookTypeForChapter(chapterNumber: number): HookType {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new RangeError('chapterNumber must be a positive safe integer')
  }
  return HOOK_TYPES[(chapterNumber - 1) % HOOK_TYPES.length]!
}

/** @param type - An assigned hook type. @returns The label the outline must contain. */
export function hookLabel(type: HookType): string {
  return `章末钩子：${type}`
}

/**
 * @param text - The field that must name the hook: a book chapter purpose, or a chapter throughLine.
 * @returns The first labeled type, or null when the field has no hook label.
 */
export function labeledHookType(text: string): HookType | null {
  const match = LABELED_HOOK.exec(text)
  if (match?.[1] === undefined) return null
  return match[1] as HookType
}

/** A chapter whose labeled hook is missing or is not the type assigned to that chapter number. */
export interface HookTypeMiss {
  readonly chapterNumber: number
  readonly expected: HookType
  readonly found: HookType | null
}

/**
 * @param chapters - Chapter number and the field that must carry the label.
 * @returns Chapters that do not name their assigned type. An empty list means the rotation holds.
 */
export function missingHookTypes(chapters: readonly { readonly chapterNumber: number; readonly text: string }[]): HookTypeMiss[] {
  const missing: HookTypeMiss[] = []
  for (const chapter of chapters) {
    const expected = hookTypeForChapter(chapter.chapterNumber)
    const found = labeledHookType(chapter.text)
    if (found !== expected) missing.push({ chapterNumber: chapter.chapterNumber, expected, found })
  }
  return missing
}

/**
 * @param missing - Chapters that missed their assigned type.
 * @returns The repair instruction. It names the assigned label and does not ask for a position or a word quota.
 */
export function hookRotationRepairInstruction(missing: readonly HookTypeMiss[]): string {
  const items = missing.map(item => item.found === null
    ? `chapter ${item.chapterNumber} must name ${hookLabel(item.expected)}`
    : `chapter ${item.chapterNumber} names ${hookLabel(item.found)}; the assigned type is ${hookLabel(item.expected)}`)
  return `Host hook-type check: ${items.join('; ')}. Rotate ${HOOK_TYPES.join('、')} from chapter 1 and repeat that order. Name the assigned type in the book-outline chapter purpose or the chapter-outline throughLine. Do not add a percentage position or a per-beat word quota.`
}
