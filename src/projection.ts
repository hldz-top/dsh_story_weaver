/** Version-specific Markdown files are projections of immutable writing artifacts. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { FsError, type FsPathInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Actor, Artifact, NovelView } from './contracts.ts'
import type { StoryArtifactPreview } from './preview-result.ts'
import { artifactMarkdown, legacyArtifactMarkdown, referencedContentDigests } from './artifact-markdown.ts'
import type { WritingService } from './service.ts'

const previewAttempts = 8
const previewSidecars = 32

function sameBytes(bytes: Buffer, accepted: readonly Buffer[]): boolean {
  return accepted.some(candidate => candidate.equals(bytes))
}

function sidecarPath(relativePath: string, index: number): string {
  const slash = relativePath.lastIndexOf('/')
  const directory = slash < 0 ? '' : relativePath.slice(0, slash + 1)
  const name = slash < 0 ? relativePath : relativePath.slice(slash + 1)
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name
  return `${directory}${stem}${index === 1 ? '.current.md' : `.current-${index}.md`}`
}

async function readProjection(ctx: Context, exec: ToolExecution, target: FsTarget, knownBytes: number): Promise<{ readonly info: FsPathInfo; readonly bytes: Buffer | null }> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error('Preview file disappeared before it could be read')
  if (info.type !== 'file') throw new Error('Preview is not a regular file')
  const cap = info.size ?? knownBytes
  try {
    const bytes = Buffer.from(await ctx.fs.readBytes(target, exec.signal, cap))
    if (info.size !== undefined && bytes.byteLength !== info.size) throw new Error('Preview read did not return the complete file')
    return { info, bytes }
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_TOO_LARGE') return { info, bytes: null }
    throw error
  }
}

/**
 * Current projection and the exact derived renderings an unmodified older file may still hold.
 * Those older strings are recognized only so a faithful preview can be replaced. They are not returned to the user.
 * @param artifact - Exact stored version.
 * @param imported - Settings dimension adopted through author import.
 * @param specIds - Allocated project specification ids, keyed by content digest.
 * @returns The text to publish and the earlier derived texts that may be replaced.
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
  const path = await projectDocument(ctx, exec, actor, `${directory}/${novel.id}/${artifact.id}.md`, texts.current, { derivedPredecessors: texts.previous, upgradeDerived: true })
  return {
    kind: 'story-artifact-preview', version: 1,
    novelId: novel.id, artifactId: artifact.id, revision: artifact.revision,
    title: `${novel.title} · v${artifact.revision}`, path,
  }
}

/**
 * Materialize complete Markdown with the same Session filesystem safeguards.
 * A missing file is created. A file that already equals `markdown` is reused.
 * With `upgradeDerived`, a file that exactly equals a known earlier derived rendering is replaced by `markdown`.
 * Any other existing bytes are left untouched and the current text is written to an independent path.
 * @param ctx - Existing filesystem and sandbox-policy owner.
 * @param exec - Calling Session and cancellation owner.
 * @param actor - Canonical Session workspace.
 * @param relativePath - Version-specific path within the configured preview directory.
 * @param markdown - Complete authoritative projection text, without truncation; a new file always receives it.
 * @param options - Earlier derived renderings that may be replaced, and whether an edited file gets a separate path.
 * @returns The display path of the current projection.
 */
export async function projectDocument(
  ctx: Context, exec: ToolExecution, actor: Actor, relativePath: string, markdown: string,
  options: { readonly derivedPredecessors?: readonly string[]; readonly upgradeDerived?: boolean } = {},
): Promise<string> {
  const session = exec.agent?.session
  if (session === undefined) throw new Error('Preview requires a Session')
  const current = Buffer.from(markdown, 'utf8')
  const predecessors = (options.derivedPredecessors ?? []).map(text => Buffer.from(text, 'utf8')).filter(bytes => !bytes.equals(current))
  const upgradeDerived = options.upgradeDerived === true
  const workspace = await ctx.fs.resolve('.', { cwd: actor.workspace, signal: exec.signal })
  const policyOwner = ctx.get('sandboxPolicy')
  if (ctx.fs.sandboxMode !== undefined && policyOwner === undefined) {
    throw new Error('The enforcing filesystem requires sandboxPolicy')
  }
  const policy = policyOwner?.resolve({ session })
  const knownBytes = Math.max(current.byteLength, ...predecessors.map(bytes => bytes.byteLength), 1)

  const place = async (path: string, sidecar: number, attempt: number): Promise<string> => {
    if (attempt > previewAttempts) throw new Error('Preview changed repeatedly before it could be published')
    exec.signal.throwIfAborted()
    const target = await ctx.fs.resolve(path, { cwd: actor.workspace, signal: exec.signal })
    if (!ctx.fs.contains(workspace, target)) throw new Error('Preview path must remain inside the Session workspace')
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) {
      try {
        const outcome = await ctx.fs.writeText(target, markdown, { kind: 'createIfAbsent' }, exec.signal, policy)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        return target.displayPath
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_NOT_OBSERVED') return place(path, sidecar, attempt + 1)
        throw error
      }
    }
    const read = await readProjection(ctx, exec, target, knownBytes)
    if (read.bytes !== null && read.bytes.equals(current)) {
      ctx.emit('fs/observed', target, { kind: 'present', version: read.info.version }, exec)
      return target.displayPath
    }
    if (read.bytes !== null && sameBytes(read.bytes, predecessors)) {
      try {
        const outcome = await ctx.fs.writeText(target, markdown, { kind: 'replaceIfVersion', version: read.info.version }, exec.signal, policy)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        return target.displayPath
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_STALE_VERSION') return place(path, sidecar, attempt + 1)
        throw error
      }
    }
    if (!upgradeDerived) throw new Error('Preview differs from the stored artifact; the authoritative version is unchanged')
    if (sidecar >= previewSidecars) throw new Error('Edited preview files fill the independent projection names')
    return place(sidecarPath(relativePath, sidecar + 1), sidecar + 1, 0)
  }
  return place(relativePath, 0, 0)
}
