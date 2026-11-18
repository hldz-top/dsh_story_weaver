/** Version-specific Markdown files are projections of immutable writing artifacts. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Actor, Artifact, NovelView } from './contracts.ts'
import type { StoryArtifactPreview } from './preview-result.ts'
import { artifactMarkdown, legacyArtifactMarkdown, referencedContentDigests } from './artifact-markdown.ts'
import type { WritingService } from './service.ts'

async function verifyProjection(ctx: Context, exec: ToolExecution, target: FsTarget, accepted: readonly Buffer[]): Promise<void> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') throw new Error('Preview is not a regular file')
  const bytes = Buffer.from(await ctx.fs.readBytes(target, exec.signal, Math.max(...accepted.map(candidate => candidate.byteLength))))
  if (!accepted.some(candidate => bytes.equals(candidate))) {
    throw new Error('Preview differs from the stored artifact; the authoritative version is unchanged')
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
}

/**
 * Current projection and the earlier byte strings an existing unmodified file may still hold.
 * The previous readable rendering keeps full SHA-256 reference labels from before specification ids.
 * @param artifact - Exact stored version.
 * @param imported - Settings dimension adopted through author import.
 * @param specIds - Allocated project specification ids, keyed by content digest.
 * @returns The text to write and the exact earlier texts that still verify.
 */
export function projectionTexts(artifact: Artifact, imported = false, specIds?: ReadonlyMap<string, string>): { readonly current: string; readonly previous: readonly string[] } {
  const current = artifactMarkdown(artifact, specIds === undefined ? { imported } : { imported, specIds })
  const previousReadable = artifactMarkdown(artifact, { imported })
  const legacy = legacyArtifactMarkdown(artifact)
  return { current, previous: previousReadable === current ? [legacy] : [previousReadable, legacy] }
}

/**
 * Allocate specification ids for this document's references, then project it.
 * @param ctx - Composed filesystem and optional sandbox policy services.
 * @param exec - Calling Session and cancellation owner.
 * @param actor - Workspace resolved by the tool from that Session.
 * @param novel - Ownership-checked novel metadata.
 * @param artifact - Ownership-checked exact stored version.
 * @param directory - Configured relative projection directory.
 * @param service - Writing service that owns specification identities.
 * @param imported - The artifact is a settings dimension adopted through author import.
 * @returns Persistable metadata used by the existing document preview.
 */
export async function projectPublishedArtifact(
  ctx: Context, exec: ToolExecution, actor: Actor, novel: NovelView, artifact: Artifact, directory: string, service: WritingService, imported = false,
): Promise<StoryArtifactPreview> {
  await service.allocateSpecIdentities(actor, novel.id, referencedContentDigests(artifact))
  return projectArtifact(ctx, exec, actor, novel, artifact, directory, imported, service.specIdentityMap(actor, novel.id))
}

/**
 * Materialize one version in the calling Session filesystem without changing authority.
 * @param ctx - Composed filesystem and optional sandbox policy services.
 * @param exec - Calling Session and cancellation owner.
 * @param actor - Workspace resolved by the tool from that Session.
 * @param novel - Ownership-checked novel metadata.
 * @param artifact - Ownership-checked exact stored version.
 * @param directory - Configured relative projection directory.
 * @param imported - The artifact is a settings dimension adopted through author import.
 * @param specIds - Allocated project specification ids. Omitted, the readable labels stay the stored digests.
 * @returns Persistable metadata used by the existing document preview.
 */
export async function projectArtifact(
  ctx: Context, exec: ToolExecution, actor: Actor, novel: NovelView, artifact: Artifact, directory: string, imported = false,
  specIds?: ReadonlyMap<string, string>,
): Promise<StoryArtifactPreview> {
  const texts = projectionTexts(artifact, imported, specIds)
  const path = await projectDocument(ctx, exec, actor, `${directory}/${novel.id}/${artifact.id}.md`, texts.current, texts.previous)
  return {
    kind: 'story-artifact-preview', version: 1,
    novelId: novel.id, artifactId: artifact.id, revision: artifact.revision,
    title: `${novel.title} · v${artifact.revision}`, path,
  }
}

/**
 * Materialize complete immutable Markdown with the same Session filesystem safeguards.
 * @param ctx - Existing filesystem and sandbox-policy owner.
 * @param exec - Calling Session and cancellation owner.
 * @param actor - Canonical Session workspace.
 * @param relativePath - Version-specific path within the configured preview directory.
 * @param markdown - Complete authoritative projection text, without truncation; a new file always receives it.
 * @param previous - Exact earlier renderings of the same content that an existing, unmodified file may still hold.
 * @returns The verified existing or newly created file's display path.
 */
export async function projectDocument(
  ctx: Context, exec: ToolExecution, actor: Actor, relativePath: string, markdown: string, previous: readonly string[] = [],
): Promise<string> {
  const session = exec.agent?.session
  if (session === undefined) throw new Error('Preview requires a Session')
  const accepted = [markdown, ...previous].map(text => Buffer.from(text, 'utf8'))
  const workspace = await ctx.fs.resolve('.', { cwd: actor.workspace, signal: exec.signal })
  const target = await ctx.fs.resolve(relativePath, { cwd: actor.workspace, signal: exec.signal })
  if (!ctx.fs.contains(workspace, target)) throw new Error('Preview path must remain inside the Session workspace')
  const policyOwner = ctx.get('sandboxPolicy')
  if (ctx.fs.sandboxMode !== undefined && policyOwner === undefined) {
    throw new Error('The enforcing filesystem requires sandboxPolicy')
  }
  const policy = policyOwner?.resolve({ session })
  exec.signal.throwIfAborted()
  if (await ctx.fs.stat(target, exec.signal) !== undefined) {
    await verifyProjection(ctx, exec, target, accepted)
  } else {
    try {
      const outcome = await ctx.fs.writeText(target, markdown, { kind: 'createIfAbsent' }, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
    } catch (error) {
      if (!(error instanceof FsError) || error.code !== 'FS_NOT_OBSERVED') throw error
      await verifyProjection(ctx, exec, target, accepted)
    }
  }
  return target.displayPath
}
