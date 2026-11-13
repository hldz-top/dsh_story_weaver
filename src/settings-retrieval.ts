/**
 * Settings-stage use of the host's official web_search and web_fetch tools.
 * Outline and body research do not use this module. The plugin does not choose a provider.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResearchNecessity } from './research-planning.ts'
import type { ResearchStageRequest } from './research-stage.ts'

const OFFICIAL_TOOLS = ['web_search', 'web_fetch'] as const
const EXCERPT_CHARS = 400
const EXCERPT_TOTAL = 1200
/** Selection failures and a tool the step cannot admit. WEB_PROVIDER_ERROR stays a real failure. */
const UNAVAILABLE_CODES = new Set(['UNKNOWN_TOOL', 'WEB_PROVIDER_UNAVAILABLE', 'WEB_PROVIDER_CONFIGURED_MISSING', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', 'WEB_PROVIDER_AMBIGUOUS'])

/** @param target - Stage output target. @returns Whether this research belongs to one settings dimension. */
export function isSettingsOutputTarget(target: object): boolean {
  return 'kind' in target && (target as { kind?: unknown }).kind === 'settings'
}

/**
 * Classify one official-retrieval failure. Unavailable and quota/billing are silent for settings.
 * Every other failure stays fail-close.
 * @param failure - Tool or provider failure text, code, and HTTP status when known.
 */
export function officialRetrievalFailureKind(failure: { readonly message?: string; readonly code?: string; readonly statusCode?: number }): 'unavailable' | 'quota' | 'other' {
  const message = failure.message ?? ''
  const code = failure.code ?? ''
  if (UNAVAILABLE_CODES.has(code) || message.includes('WEB_PROVIDER_UNAVAILABLE')) return 'unavailable'
  if (/quota/i.test(code) || /billing/i.test(code) || failure.statusCode === 402 || /\b402\b/.test(message) || /quota/i.test(message) || /billing/i.test(message)) return 'quota'
  return 'other'
}

/**
 * Continue a settings plan from the inputs when official retrieval cannot run.
 * External questions stay, reclassified as creative, so admission does not require a logged web call.
 * @param decision - Planner decision for this settings dimension.
 */
export function settingsLocalNecessity(decision: ResearchNecessity): ResearchNecessity {
  if (decision.mode === 'input-only') return decision
  return {
    mode: 'input-only', reason: decision.reason, externalRequirements: [],
    questions: decision.questions.map(question => question.kind === 'external' ? { ...question, kind: 'creative' as const } : question),
  }
}

/** Outcome of one settings-stage attempt to invoke the host's official retrieval tools. */
export type SettingsOfficialRetrieval =
  | { readonly kind: 'skipped'; readonly reason: 'unavailable' | 'quota' }
  | { readonly kind: 'used'; readonly excerpts: readonly string[] }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Invoke official web_search, then web_fetch when a result has an HTTP(S) URL.
 * Missing tools and unavailable or quota/billing failures skip. Other failures are returned for fail-close.
 * @param ctx - Host context whose tool registry owns web_search and web_fetch.
 * @param exec - Parent writing-tool execution and its cancellation signal.
 * @param purpose - Settings research purpose, used only as the search query.
 */
export async function attemptSettingsOfficialRetrieval(ctx: Context, exec: ToolExecution, purpose: string): Promise<SettingsOfficialRetrieval> {
  const agent = exec.agent
  if (agent === undefined || OFFICIAL_TOOLS.some(name => ctx.tools.get(name, agent) === undefined)) return { kind: 'skipped', reason: 'unavailable' }
  const selection = modelSelection(agent)
  if (selection === undefined) return { kind: 'skipped', reason: 'unavailable' }
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: selection, signal: exec.signal })
  try {
    if (!OFFICIAL_TOOLS.every(name => toolSet.view(agent).has(name))) return { kind: 'skipped', reason: 'unavailable' }
    const query = [...purpose.trim()].slice(0, 300).join('').trim()
    const search = await callOfficialTool(ctx, exec, toolSet, 'web_search', { queries: [query.length > 0 ? query : 'settings'] })
    if (search.kind !== 'ok') return search.outcome
    const value = search.value
    const sources = sourcesOf(value)
    const excerpts = collectExcerpts(textOf(value.content), ...sources.map(source => source.snippet ?? source.summary ?? ''))
    const url = sources.find(source => source.url.startsWith('https://') || source.url.startsWith('http://'))?.url
    if (url === undefined) return { kind: 'used', excerpts }
    const fetched = await callOfficialTool(ctx, exec, toolSet, 'web_fetch', { url })
    if (fetched.kind !== 'ok') return fetched.outcome
    if (statusOf(fetched.value) === 402) return { kind: 'skipped', reason: 'quota' }
    const body = textOf(fetched.value.body && typeof fetched.value.body === 'object' ? (fetched.value.body as { content?: unknown }).content : undefined)
    return { kind: 'used', excerpts: collectExcerpts(...excerpts, body) }
  } finally { toolSet.dispose() }
}

/** Read official excerpts frozen into a settings research prompt. @param prompt - Stored research prompt. */
export function officialExcerptsFromPrompt(prompt: string): readonly string[] {
  const data = taskData(prompt)
  if (!Array.isArray(data?.officialExcerpts)) return []
  return data.officialExcerpts.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** @param prompt - Stored research prompt. @returns The frozen request fields the child actually received, without parentSessionId. */
export function storedResearchTask(prompt: string): Partial<ResearchStageRequest> & { readonly officialExcerpts?: readonly string[] } {
  const data = taskData(prompt)
  if (data === undefined || data.kind !== 'research') return {}
  const { kind: _kind, ...task } = data
  return task as Partial<ResearchStageRequest> & { readonly officialExcerpts?: readonly string[] }
}

function taskData(prompt: string): { kind?: string; officialExcerpts?: unknown } & Record<string, unknown> | undefined {
  const marker = '\n\nTASK_DATA\n\n'
  const index = prompt.lastIndexOf(marker)
  if (index < 0) return undefined
  try {
    const value: unknown = JSON.parse(prompt.slice(index + marker.length))
    return value !== null && typeof value === 'object' ? value as { kind?: string; officialExcerpts?: unknown } : undefined
  } catch { return undefined }
}

function modelSelection(agent: NonNullable<ToolExecution['agent']>): ModelSelection | undefined {
  const config = agent.session.requestHeader()?.config
  if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
  }
  const current = (agent as { model?: { current(): Readonly<ModelSelection> | undefined } }).model?.current()
  return current === undefined ? undefined : { provider: current.provider, model: current.model, ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }) }
}

type OfficialCall = { readonly kind: 'ok'; readonly value: Record<string, unknown> } | { readonly kind: 'stop'; readonly outcome: SettingsOfficialRetrieval }

async function callOfficialTool(ctx: Context, exec: ToolExecution, toolSet: Awaited<ReturnType<Context['tools']['resolve']>>, name: 'web_search' | 'web_fetch', args: object): Promise<OfficialCall> {
  exec.signal.throwIfAborted()
  const agent = exec.agent
  if (agent === undefined) return { kind: 'stop', outcome: { kind: 'skipped', reason: 'unavailable' } }
  let batch: Awaited<ReturnType<Context['tools']['execute']>>
  try {
    batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>(`settings-official-${randomUUID()}`), name, arguments: JSON.stringify(args) }],
      agent, signal: exec.signal, toolSet,
    })
  } catch (cause) {
    exec.signal.throwIfAborted()
    return stopFor(cause)
  }
  exec.signal.throwIfAborted()
  const result = batch.results[0]?.result
  if (result === undefined) return { kind: 'stop', outcome: { kind: 'failed', error: new Error(`Official ${name} returned no result`) } }
  if (result.isError) {
    if (result.error.info?.code === 'ABORTED' || result.error.info?.code === 'ABORTED_BEFORE_DISPATCH') exec.signal.throwIfAborted()
    return stopFor({ message: result.error.message, code: result.error.info?.code })
  }
  const value = result.value
  return { kind: 'ok', value: value !== null && typeof value === 'object' ? value as Record<string, unknown> : {} }
}

function stopFor(failure: unknown): OfficialCall {
  const described = describe(failure)
  const kind = officialRetrievalFailureKind(described)
  if (kind === 'other') return { kind: 'stop', outcome: { kind: 'failed', error: failure instanceof Error ? failure : new Error(described.message ?? 'Official retrieval failed') } }
  return { kind: 'stop', outcome: { kind: 'skipped', reason: kind } }
}

function describe(failure: unknown): { message?: string; code?: string; statusCode?: number } {
  if (typeof failure === 'string') return { message: failure }
  if (failure === null || typeof failure !== 'object') return {}
  const record = failure as { message?: unknown; code?: unknown; statusCode?: unknown; status?: unknown; info?: { code?: unknown }; cause?: unknown }
  const message = typeof record.message === 'string' ? record.message : undefined
  const code = typeof record.code === 'string' ? record.code : typeof record.info?.code === 'string' ? record.info.code : undefined
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : typeof record.status === 'number' ? record.status : undefined
  if (message !== undefined || code !== undefined || statusCode !== undefined) return { ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { code }), ...(statusCode === undefined ? {} : { statusCode }) }
  return record.cause === undefined ? {} : describe(record.cause)
}

function sourcesOf(value: Record<string, unknown>): { url: string; snippet?: string; summary?: string }[] {
  if (!Array.isArray(value.sources)) return []
  return value.sources.flatMap(source => {
    if (source === null || typeof source !== 'object' || typeof (source as { url?: unknown }).url !== 'string') return []
    const item = source as { url: string; snippet?: unknown; summary?: unknown }
    return [{ url: item.url, ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}), ...(typeof item.summary === 'string' ? { summary: item.summary } : {}) }]
  })
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function statusOf(value: Record<string, unknown>): number | undefined {
  return typeof value.statusCode === 'number' ? value.statusCode : undefined
}

function collectExcerpts(...parts: readonly string[]): string[] {
  const excerpts: string[] = []
  let total = 0
  for (const part of parts) {
    const text = [...part.trim()].slice(0, EXCERPT_CHARS).join('')
    if (text.length === 0 || total >= EXCERPT_TOTAL) continue
    const room = EXCERPT_TOTAL - total
    const excerpt = [...text].slice(0, room).join('')
    excerpts.push(excerpt)
    total += [...excerpt].length
  }
  return excerpts
}
