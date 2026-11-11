/** OpenCode Go channel: official URL and model, no paid-host fallback, missing key fails closed. */
import { expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OPENCODE_GO_CHAT_URL, OPENCODE_GO_MODEL, OPENCODE_GO_PROVIDER, OpenCodeGoAdapter, openCodeGoKey, stageAgentOptions } from '../src/opencode-go.ts'

const PAY_AS_YOU_GO = 'https://opencode.ai/inference/openai/v1/chat/completions'
const request = { provider: OPENCODE_GO_PROVIDER, model: OPENCODE_GO_MODEL, sessionId: 'ses_fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] } as unknown as GenerateOptions
async function first(stream: AsyncIterable<unknown>) { return stream[Symbol.asyncIterator]().next() }

it('pins the Go subscription endpoint and model and does not inherit another route', () => {
  expect(OPENCODE_GO_CHAT_URL).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
  expect(OPENCODE_GO_CHAT_URL).not.toBe(PAY_AS_YOU_GO)
  expect(stageAgentOptions(undefined)).toBeUndefined()
  expect(stageAgentOptions('inherit')).toBeUndefined()
  expect(stageAgentOptions('opencode-go')).toEqual({ provider: OPENCODE_GO_PROVIDER, model: OPENCODE_GO_MODEL })
})

it('fails closed when the Go key is missing or unusable and ignores a DeepSeek key', async () => {
  expect(() => openCodeGoKey(undefined)).toThrowError(LlmError)
  expect(() => openCodeGoKey(undefined)).toThrow(/OPENCODE_API_KEY/)
  expect(() => openCodeGoKey('   ')).toThrow(/OPENCODE_API_KEY/)
  expect(() => openCodeGoKey('bad\nkey')).toThrow(LlmError)
  const deepseekOnly = { DEEPSEEK_API_KEY: 'sk-paid-channel' }
  const adapter = new OpenCodeGoAdapter(async () => { throw new Error('fetch must not run') }, deepseekOnly)
  await expect(first(adapter.stream(request))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
})

it('sends the Go chat request and keeps the key out of a provider error', async () => {
  const secret = 'oc_sk_fixture_not_a_real_key'
  let seen: { url: string; headers: Headers; body: string } | undefined
  const adapter = new OpenCodeGoAdapter(async (url, init) => {
    seen = { url: String(url), headers: new Headers(init?.headers), body: String(init?.body) }
    return new Response(JSON.stringify({ error: { message: `rejected ${secret}` } }), { status: 401 })
  }, { OPENCODE_API_KEY: secret })
  await expect(first(adapter.stream(request))).rejects.toMatchObject({ code: 'AUTH', failure: { status: 401 } })
  expect(seen?.url).toBe(OPENCODE_GO_CHAT_URL)
  expect(seen?.headers.get('authorization')).toBe(`Bearer ${secret}`)
  expect(seen?.headers.get('x-opencode-session')).toBe('ses_fixture')
  expect(seen?.headers.get('user-agent')).toBeTruthy()
  expect(JSON.parse(seen?.body ?? '{}')).toMatchObject({ model: OPENCODE_GO_MODEL })
  try { await first(adapter.stream(request)) }
  catch (error) {
    expect(String(error)).not.toContain(secret)
    expect(String(error)).toContain('[redacted]')
  }
})

it('refuses another model or a sessionless request before any HTTP call', async () => {
  const adapter = new OpenCodeGoAdapter(async () => { throw new Error('fetch must not run') }, { OPENCODE_API_KEY: 'oc_sk_fixture' })
  await expect(first(adapter.stream({ ...request, model: 'deepseek-v4-flash' }))).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' })
  const { sessionId: _session, ...sessionless } = request
  await expect(first(adapter.stream(sessionless))).rejects.toMatchObject({ code: 'MISSING_SESSION' })
})

it('maps one chat completion into text chunks', async () => {
  const adapter = new OpenCodeGoAdapter(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '雾港的灯亮着。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }), { status: 200 }), { OPENCODE_API_KEY: 'oc_sk_fixture' })
  const chunks = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '雾港的灯亮着。' })
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
})
