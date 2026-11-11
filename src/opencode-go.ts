/**
 * OpenCode Go subscription channel for one model.
 *
 * Official contract, read 2026-11-11:
 * - Plan base URL `https://opencode.ai/inference/go` and chat-completions path
 *   `/openai/v1/chat/completions` (https://opencode.ai/docs/console/harnesses).
 * - Model id `deepseek-v4.1-flash` on that Go endpoint
 *   (https://opencode.ai/docs/console/go/).
 * - `Authorization: Bearer` with a Console API key from a Go workspace
 *   (https://opencode.ai/docs/console/harnesses, https://opencode.ai/docs/console/api/inference/).
 * - Codex names the env var `OPENCODE_API_KEY`
 *   (https://opencode.ai/docs/console/harnesses/codex/).
 * - Go requires `x-opencode-session` (https://opencode.ai/docs/console/harnesses).
 *
 * The pay-as-you-go host `https://opencode.ai/inference` is a different product and is never used here.
 */
import { LlmAdapter, LlmError, ToolCallId, assertUsableApiKey, attributionHeaders, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type RequestMessage, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'

/** Provider route selected in DSH. */
export const OPENCODE_GO_PROVIDER = 'opencode-go'
/** Exact Go model id from the official endpoint table. */
export const OPENCODE_GO_MODEL = 'deepseek-v4.1-flash'
/** Env var for the Go workspace Console key. Never a DeepSeek or pay-as-you-go fallback. */
export const OPENCODE_GO_KEY_ENV = 'OPENCODE_API_KEY'
/** Go chat-completions URL. Not the pay-as-you-go host `https://opencode.ai/inference/openai/...`. */
export const OPENCODE_GO_CHAT_URL = 'https://opencode.ai/inference/go/openai/v1/chat/completions'

export interface OpenCodeGoSelection { readonly provider: typeof OPENCODE_GO_PROVIDER; readonly model: typeof OPENCODE_GO_MODEL }

/** The only model this channel selects. */
export const OPENCODE_GO_SELECTION: OpenCodeGoSelection = { provider: OPENCODE_GO_PROVIDER, model: OPENCODE_GO_MODEL }

/** @param writingModel - Deployment channel. @returns Child agent options for Go, or none when the parent route is kept. */
export function stageAgentOptions(writingModel: 'inherit' | 'opencode-go' | undefined): OpenCodeGoSelection | undefined {
  return writingModel === 'opencode-go' ? OPENCODE_GO_SELECTION : undefined
}

interface ChatMessage { role: string; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string }

/** @param raw - Process environment value, possibly absent. @returns A usable key. The value is never copied into the error. */
export function openCodeGoKey(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new LlmError(`OpenCode Go subscription API key is missing. Set ${OPENCODE_GO_KEY_ENV} to a Console key from a workspace subscribed to Go.`, 'MISSING_CREDENTIAL')
  }
  return assertUsableApiKey(raw, 'dsh-story-weaver', OPENCODE_GO_KEY_ENV)
}

function textOf(message: RequestMessage): string {
  return message.content.flatMap(block => block.type === 'text' || block.type === 'reasoning' ? [block.text] : []).join('')
}

function unsupported(message: RequestMessage): void {
  for (const block of message.content) {
    if (block.type === 'image' || block.type === 'file') {
      throw new LlmError('OpenCode Go writing calls accept text only. Remove image and file blocks before this request.', 'UNSUPPORTED_CONTENT')
    }
  }
}

/** @param options - One DSH request. @returns The OpenAI chat-completions JSON body for the Go endpoint. */
export function openCodeGoBody(options: GenerateOptions): { model: string; messages: ChatMessage[]; tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] } {
  if (options.model !== OPENCODE_GO_MODEL) {
    throw new LlmError(`OpenCode Go is pinned to ${OPENCODE_GO_MODEL}. Refusing model ${JSON.stringify(options.model)}.`, 'MODEL_NOT_AVAILABLE')
  }
  if (options.provider !== OPENCODE_GO_PROVIDER) {
    throw new LlmError(`OpenCode Go refuses provider ${JSON.stringify(options.provider)}.`, 'MODEL_NOT_AVAILABLE')
  }
  const messages: ChatMessage[] = []
  if (options.system !== undefined && options.system !== '') messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    unsupported(message)
    if (message.role === 'tool') {
      messages.push({ role: 'tool', content: textOf(message), tool_call_id: message.toolCallId })
      continue
    }
    const calls = message.content.flatMap(block => block.type === 'tool-call' ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: block.arguments } }] : [])
    const content = textOf(message)
    if (message.role === 'assistant') messages.push({ role: 'assistant', content: content === '' ? null : content, ...(calls.length > 0 ? { tool_calls: calls } : {}) })
    else if (content !== '' || message.role === 'user') messages.push({ role: message.role === 'developer' ? 'system' : message.role, content })
  }
  const tools = options.tools?.map((tool: ToolSchema) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  return { model: OPENCODE_GO_MODEL, messages, ...(tools === undefined || tools.length === 0 ? {} : { tools }) }
}

/** @param sessionId - DSH session id. @returns The required Go session header value. */
export function openCodeGoSession(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId.trim() === '' || sessionId.includes('\n') || sessionId.includes('\r') || sessionId.includes('\u0000')) {
    throw new LlmError('OpenCode Go requires the x-opencode-session header. This request has no single-line session id.', 'MISSING_SESSION')
  }
  return sessionId
}

/** @param key - Already checked key. @param options - Request whose session id becomes the Go header. @returns Headers that do not include any other provider key. */
export function openCodeGoHeaders(key: string, options: GenerateOptions): Record<string, string> {
  return { ...attributionHeaders(), authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-opencode-session': openCodeGoSession(options.sessionId) }
}

interface ChatResponse { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: { message?: string } }

function chunks(body: ChatResponse): StreamChunk[] {
  const choice = body.choices?.[0]
  const message = choice?.message
  const out: StreamChunk[] = []
  let index = 0
  if (typeof message?.content === 'string' && message.content !== '') {
    out.push({ type: 'block-start', index, blockType: 'text' }, { type: 'text-delta', index, text: message.content }, { type: 'block-end', index, block: { type: 'text', text: message.content } })
    index += 1
  }
  for (const call of message?.tool_calls ?? []) {
    const id = ToolCallId(call.id ?? `tool-${index}`)
    const name = call.function?.name ?? ''
    const args = call.function?.arguments ?? ''
    out.push({ type: 'block-start', index, blockType: 'tool-call' }, { type: 'tool-call-delta', index, id, name, argumentsDelta: args }, { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } })
    index += 1
  }
  if (body.usage !== undefined) {
    out.push({ type: 'usage', usage: { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0, ...(body.usage.total_tokens === undefined ? {} : { totalTokens: body.usage.total_tokens }) } })
  }
  const reason = choice?.finish_reason
  out.push({ type: 'finish', reason: reason === 'length' ? { kind: 'max-tokens' } : reason === 'tool_calls' || (message?.tool_calls?.length ?? 0) > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } })
  return out
}

function failureMessage(status: number, body: string, key: string): string {
  const redacted = body.split(key).join('[redacted]')
  const brief = [...redacted].slice(0, 180).join('')
  return `OpenCode Go returned HTTP ${status}. ${brief}`
}

/** Chat-completions adapter for the pinned Go model. */
export class OpenCodeGoAdapter extends LlmAdapter {
  /** @param fetchImpl - HTTP implementation. Tests pass a fake; production uses the runtime fetch. */
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly env: NodeJS.ProcessEnv = process.env) { super() }
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode Go' }
  }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: OPENCODE_GO_MODEL, name: 'DeepSeek V4.1 Flash', inputModalities: ['text'] }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model !== OPENCODE_GO_MODEL) return Promise.reject(new LlmError(`OpenCode Go is pinned to ${OPENCODE_GO_MODEL}.`, 'MODEL_NOT_AVAILABLE'))
    return Promise.resolve({ provider, id: model, name: 'DeepSeek V4.1 Flash', inputModalities: ['text'] })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const key = openCodeGoKey(this.env[OPENCODE_GO_KEY_ENV])
    const headers = openCodeGoHeaders(key, options)
    const body = openCodeGoBody(options)
    const response = await this.fetchImpl(OPENCODE_GO_CHAT_URL, { method: 'POST', headers, body: JSON.stringify(body), ...(options.signal === undefined ? {} : { signal: options.signal }) })
    const raw = await response.text()
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR'
      throw new LlmError(failureMessage(response.status, raw, key), code, { status: response.status })
    }
    let parsed: ChatResponse
    try { parsed = JSON.parse(raw) as ChatResponse }
    catch { throw new LlmError('OpenCode Go returned a response that is not JSON.', 'MALFORMED_RESPONSE') }
    yield* chunks(parsed)
  }
}
