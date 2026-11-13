/** Per-stage writing model route. `inherit` uses the parent Agent's provider and model. */
import type { StagePromptKind } from './stage-prompts.ts'

/** Stages that can name a route. Every other stage stays on the parent model. */
export const writingModelRoles = ['planning', 'review', 'body'] as const
/** One configurable writing-model role. */
export type WritingModelRole = typeof writingModelRoles[number]
/** An explicit host provider and model. This plugin does not choose a channel on its own. */
export interface WritingModelRoute { readonly provider: string; readonly model: string }
/** `inherit` keeps the parent route. A route names both provider and model. */
export type WritingModelChoice = 'inherit' | WritingModelRoute
/** Planning, review and body each inherit unless a deployment names a route. */
export interface WritingModelMap {
  readonly planning: WritingModelChoice
  readonly review: WritingModelChoice
  readonly body: WritingModelChoice
}

/** Every role inherits the parent Agent. */
export const inheritedWritingModel: WritingModelMap = { planning: 'inherit', review: 'inherit', body: 'inherit' }

const OPENCODE = 'writingModel opencode-go is not provided by this plugin. OpenCode Go is a host subscription. Set writingModel to inherit so writing stages use the parent model and subscription.'
const INHERIT = 'writingModel must be inherit so writing stages use the configured parent model and subscription'

/**
 * Admit a plugin `writingModel` value.
 * @param value - `'inherit'`, or a map of planning, review and body.
 * @returns A complete map. Omitted roles inherit.
 */
export function normalizeWritingModel(value: unknown): WritingModelMap {
  if (value === undefined || value === 'inherit') return inheritedWritingModel
  if (value === 'opencode-go') throw new Error(OPENCODE)
  if (typeof value === 'string') throw new Error(INHERIT)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('writingModel must be inherit or a per-stage map of planning, review and body')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!writingModelRoles.includes(key as WritingModelRole)) throw new Error(`writingModel has an unknown stage role: ${key}`)
  }
  return { planning: choice(record.planning, 'planning'), review: choice(record.review, 'review'), body: choice(record.body, 'body') }
}

/**
 * Which configured role executes a stage. Research execution stays on the parent route.
 * @param kind - Stage or the local research-planning / citation-repair step.
 * @returns A map role, or `inherit` when the stage has no faster-or-stronger split.
 */
export function stageWritingRole(kind: StagePromptKind | 'research-planning' | 'research' | 'citation-repair'): WritingModelRole | 'inherit' {
  if (kind === 'review' || kind === 'citation-repair') return 'review'
  if (kind === 'body') return 'body'
  if (kind === 'book-outline' || kind === 'chapter-outline' || kind === 'continuity-snapshot' || kind === 'research-planning') return 'planning'
  return 'inherit'
}

/**
 * Resolve one role against a map.
 * @param map - Normalized stage routes.
 * @param role - The stage's role, or `inherit` when the stage has none.
 * @returns The explicit route, or undefined when the child inherits the parent.
 */
export function writingModelFor(map: WritingModelMap, role: WritingModelRole | 'inherit'): WritingModelRoute | undefined {
  if (role === 'inherit') return undefined
  const selected = map[role]
  return selected === 'inherit' ? undefined : selected
}

function choice(value: unknown, role: string): WritingModelChoice {
  if (value === undefined || value === 'inherit') return 'inherit'
  if (value === 'opencode-go') throw new Error(OPENCODE)
  if (typeof value === 'string') throw new Error(`writingModel.${role} must be inherit or { provider, model }`)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`writingModel.${role} must be inherit or { provider, model }`)
  const route = value as Record<string, unknown>
  const extra = Object.keys(route).filter(key => key !== 'provider' && key !== 'model')
  if (extra.length > 0) throw new Error(`writingModel.${role} only accepts provider and model`)
  if (typeof route.provider !== 'string' || route.provider.trim().length === 0 || typeof route.model !== 'string' || route.model.trim().length === 0) {
    throw new Error(`writingModel.${role} needs a nonblank provider and model`)
  }
  if (route.provider === 'opencode-go' || route.model === 'opencode-go') throw new Error(OPENCODE)
  return { provider: route.provider, model: route.model }
}
