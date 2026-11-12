/** Deterministic model responses exercise the real loop without network access. */
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

export class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly reply: (request: GenerateOptions, index: number) => StreamChunk[] | Promise<StreamChunk[]>) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.push(options) - 1
    const chunks = await abortable(this.reply(options, index), options.signal)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** @param value - A reply, which may wait. @param signal - The model request signal. @returns The reply, or a rejection of the abort reason if the signal fires first. */
function abortable<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const promise = Promise.resolve(value)
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('The model request was aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(signal.reason ?? new Error('The model request was aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      result => { signal.removeEventListener('abort', onAbort); resolve(result) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

export function call(name: string, args: object, id = name): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export function stop(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed the requested fixture operation.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
