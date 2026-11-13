/** Fixed checklists for open settings dimensions whose review would otherwise stay an open questionnaire. */
import { z } from 'zod'
import { artifactIdSchema } from './contracts.ts'

/** Settings dimensions scored by a fixed checklist instead of free-form issues. */
export const OPEN_CHECKLIST_CODES = ['g4', 'g7'] as const
/** One open dimension that uses a checklist review. */
export type OpenChecklistCode = (typeof OPEN_CHECKLIST_CODES)[number]

const G4_ITEMS = [
  ['g4-payoff-shown', 'The prose shows one concrete reader payoff, not only a promise that a later chapter will be gratifying.'],
  ['g4-payoff-earned', 'That payoff follows from a want or pressure this dimension already states, not from a new unexplained advantage.'],
  ['g4-cost-named', 'The payoff names a cost, limit, or risk that is paid or risked to obtain it.'],
  ['g4-audience', 'The payoff fits the accepted audience, rather than a different genre\'s reward.'],
  ['g4-not-chapter-locked', 'The text does not schedule the payoff onto a fixed later chapter number.'],
  ['g4-not-repeated', 'Two payoffs are not the same reward repeated under different names.'],
  ['g4-opening', 'At least one payoff can land before the ending, not only as a final reward.'],
] as const

const G7_ITEMS = [
  ['g7-plant-concrete', 'A plant is a concrete object, line, or absence a later chapter can reuse.'],
  ['g7-plant-unspent', 'That plant is not explained away in the same passage that introduces it.'],
  ['g7-hook-open', 'At least one hook is still unresolved at the end of this text.'],
  ['g7-not-false-plant', 'A detail this text already spends is not labeled as a plant.'],
  ['g7-no-contradiction', 'No plant contradicts an accepted setting or the main plot.'],
  ['g7-not-theme-only', 'A theme word by itself is not treated as a plant.'],
  ['g7-hook-specific', 'The closing hook names one specific unanswered fact.'],
] as const

const ITEMS = { g4: G4_ITEMS, g7: G7_ITEMS } as const

/** @param code - Dimension code. @returns Whether its review is a fixed checklist. */
export function isOpenChecklistCode(code: string): code is OpenChecklistCode {
  return (OPEN_CHECKLIST_CODES as readonly string[]).includes(code)
}

/** @param code - g4 or g7. @returns The fixed items, in the order the model must return. */
export function openChecklistItems(code: OpenChecklistCode): readonly { readonly id: string; readonly statement: string }[] {
  return ITEMS[code].map(([id, statement]) => ({ id, statement }))
}

const inputRefSchema = z.strictObject({ artifactId: artifactIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const paragraphIdSchema = z.string().regex(/^p[1-9][0-9]*$/u)

/**
 * Model schema for one open-dimension checklist. The host still rejects a fail that omits `paragraphId`.
 * @param code - g4 or g7. @returns The strict object the native child must return.
 */
export function openChecklistModelSchema(code: OpenChecklistCode) {
  const ids = ITEMS[code].map(([id]) => id) as unknown as [string, ...string[]]
  return z.strictObject({
    version: z.literal(1),
    inputRefs: z.array(inputRefSchema).nonempty(),
    reviewed: inputRefSchema,
    items: z.array(z.strictObject({
      id: z.enum(ids),
      status: z.enum(['pass', 'fail', 'na']),
      paragraphId: paragraphIdSchema.optional(),
    })).nonempty(),
  })
}

/** When a positive fail count stops the repair. `rises` is the g4/g7 rule. `does-not-decrease` also stops when the count stays the same. */
export type ChecklistRepairStop = 'rises' | 'does-not-decrease'

/**
 * Whether another repair is allowed.
 * A fail count of zero adopts the candidate just reviewed. `rises` (g4/g7) adopts the held version only when the new
 * count is higher, and may repair again while the count stays level. `does-not-decrease` (outline and manuscript
 * reviews) adopts the held version whenever the new count is not strictly lower, so a non-improving round does not
 * spend the rest of the attempt budget.
 * @param previousFails - Fail count of the version already held, or null before the first review.
 * @param fails - Fail count of the candidate just reviewed.
 * @param stop - Which non-zero comparison adopts the held candidate. Defaults to the g4/g7 rule.
 * @returns `apply-next` adopts the new candidate, `apply-previous` adopts the held one, `continue` may repair.
 */
export function checklistRepairDecision(previousFails: number | null, fails: number, stop: ChecklistRepairStop = 'rises'): 'apply-next' | 'apply-previous' | 'continue' {
  if (fails === 0) return 'apply-next'
  if (previousFails !== null && (stop === 'does-not-decrease' ? fails >= previousFails : fails > previousFails)) return 'apply-previous'
  return 'continue'
}
