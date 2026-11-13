/** Directory collaborator required by DSH 0.2.2-rc.3 local subagents. */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Provide get/ensure/set without mounting the filesystem-backed service.
 * Spawn calls `set` while the child is still unpublished.
 * @param ctx - Test context that owns the collaborator.
 * @param root - Absolute fallback directory.
 */
export function provideStageWorkingDirectory(ctx: Context, root: string): void {
  const read = (session: { header: { cwd?: string } }) => session.header.cwd ?? root
  ctx.provide('workingDirectory', {
    defaultDirectory: root,
    get: read,
    ensure: (agent: { session: { header: { cwd?: string } } }) => Promise.resolve(read(agent.session)),
    set: (_agent: unknown, path: string) => {
      if (path.trim().length === 0) return Promise.reject(new Error('WORKING_DIRECTORY_INVALID'))
      return Promise.resolve(path)
    },
  })
}
