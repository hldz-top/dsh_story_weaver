/** Native capabilities required by the loaded Story plugin in isolated test workspaces. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { provideStageWorkingDirectory } from './working-directory.ts'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'

/**
 * Mount durable Sessions and the configured local spawn provider after loop dependencies.
 * @param ctx - Test context that owns all capability lifetimes.
 * @param root - Existing isolated test directory containing Session logs.
 * @returns After the real persistence and native spawn capabilities are registered.
 */
export async function mountPluginRuntime(ctx: Context, root: string): Promise<void> {
  provideStageWorkingDirectory(ctx, root)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
}
