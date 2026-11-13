/** Call one registered tool through the DSH 0.2.2-rc.3 batch executor. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** @param ctx - Host that owns the tool registry. @param input - One root tool call. @returns That call's settled result. */
export async function executeRegisteredTool(ctx: Context, input: { name: string; arguments: unknown; agent?: Agent; signal: AbortSignal }): Promise<ToolExecutionResult> {
  const callId = ToolCallId(randomUUID())
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    signal: input.signal,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  })
  const found = batch.results.find(item => item.callId === callId)
  if (found === undefined) throw new Error(`Tool batch omitted ${input.name}`)
  return found.result
}
