/**
 * Fixed chapter-outline hook types.
 *
 * The list is closed, in the same way {@link import('./open-dimension-checklist.ts').openChecklistItems}
 * fixes the items a review must return. The model picks one id. A repeat of the previous chapter's
 * `continuity.hookType` fails that outline round and uses the existing outline repair budget.
 */
import { StageValidationRejection } from './stage-rejection.ts'

/** Closing hook types, in checklist order. */
export const HOOK_TYPES = ['suspense', 'danger', 'gain', 'misread', 'promise'] as const
/** One closing hook type. */
export type HookType = (typeof HOOK_TYPES)[number]

const HOOK_STATEMENTS = {
  suspense: 'The chapter ends on a question the next chapter can answer.',
  danger: 'The chapter ends on a threat that is already in motion.',
  gain: 'The chapter ends on something won, at a cost the reader can see.',
  misread: 'The chapter ends on a fact the viewpoint character has read wrong.',
  promise: 'The chapter ends on a commitment that a later chapter must keep.',
} as const

/** @returns The fixed hook checklist, in the order the outline must choose from. */
export function hookTypeItems(): readonly { readonly id: HookType; readonly statement: string }[] {
  return HOOK_TYPES.map(id => ({ id, statement: HOOK_STATEMENTS[id] }))
}

/** @param value - A model field. @returns Whether it is one of the five hook types. */
export function isHookType(value: string): value is HookType {
  return (HOOK_TYPES as readonly string[]).includes(value)
}

/**
 * Reject a hook type outside the fixed list. The runner does not use this to fail a round by itself:
 * the published schema already limits the field, and this is the unit-test boundary.
 * @param value - The field to check.
 */
export function assertHookType(value: string): asserts value is HookType {
  if (!isHookType(value)) throw new StageValidationRejection(`hookType is ${value}; expected one of ${HOOK_TYPES.join(', ')}`)
}

/**
 * Same type as the previous chapter's continuity hook.
 * @param current - This chapter outline's hookType.
 * @param previous - The previous chapter continuity or snapshot hookType.
 * @returns The repair sentence, or null when there is no repeat to fail.
 */
export function repeatedHookInstruction(current: string | undefined, previous: string | undefined): string | null {
  if (current === undefined || previous === undefined || current !== previous || !isHookType(current)) return null
  return `Host hook-type check: hookType ${current} repeats the previous chapter's continuity.hookType. Choose a different one of ${HOOK_TYPES.join(', ')}. This outline round fails until the type changes.`
}

/**
 * Copy the admitted outline hook onto a host snapshot only for prompt version 15, and only when rotation is on.
 * @param promptVersion - The run's prompt version.
 * @param enabled - The hook-rotation switch.
 * @param projected - The snapshot already built.
 * @param hookType - The continuity hook, when the outline set one.
 */
export function attachContinuityHook<T extends object>(promptVersion: number, enabled: boolean, projected: T, hookType: string | undefined): T {
  if (promptVersion < 15 || !enabled || hookType === undefined || !isHookType(hookType)) return projected
  return { ...projected, hookType }
}

/** @returns The version-15 chapter-outline sentence. It names every fixed type. */
export function hookTypePromptLine(): string {
  const items = hookTypeItems().map(item => `${item.id}: ${item.statement}`).join(' ')
  return `Set hookType to exactly one of this fixed checklist: ${HOOK_TYPES.join(', ')}. ${items} Do not repeat the previous chapter's continuity.hookType. A repeat fails this outline round.`
}
