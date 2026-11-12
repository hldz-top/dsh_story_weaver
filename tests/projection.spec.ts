import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeRegisteredTool } from './support/tool-batch.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import * as Story from '../src/index.ts'
import { mountPluginRuntime } from './support/plugin-runtime.ts'
import { parseNovelId, parseRequestId, type NovelView } from '../src/contracts.ts'
import { parseStoryArtifactPreview } from '../src/preview-result.ts'
import { ScriptedModel, stop } from './support/model.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-projection-'))
  const cwd = join(root, 'workspace')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(cwd)
  await mountAgentLoopTestDependencies(ctx)
  await mountPluginRuntime(ctx, root)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new ScriptedModel(() => stop())))
  await ctx.plugin(Story, new Story.Config({ ...new Story.Config(), maxArtifactBytes: 100_000, maxReadChars: 1024, previewDirectory: '.dsh-story' }))
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(randomUUID()), { provider: 'fixture', model: 'deterministic' }, { cwd })
  const actor = { sessionId: agent.session.id, workspace: cwd }
  const execute = (name: string, args: object, signal = new AbortController().signal) => executeRegisteredTool(ctx, {
    name, arguments: args, agent, signal,
  })
  const createNovel = async (brief = '守塔人找到了失踪日志。') => {
    const outcome = await execute('story_create_novel', { requestId: randomUUID(), title: '潮汐城', brief })
    if (outcome.isError) throw new Error(outcome.error.message)
    const { id } = z.object({ id: z.string() }).parse(outcome.value)
    return ctx.story.getNovel(actor, parseNovelId(id))
  }
  const preview = (novel: NovelView, artifactId = novel.brief.id, signal?: AbortSignal) =>
    execute('story_preview', { novelId: novel.id, artifactId }, signal)
  return { ctx, root, cwd, actor, createNovel, preview, execute, fs: ctx.fs as LocalFileSystem }
}

function successfulPreview(outcome: ToolExecutionResult) {
  expect(outcome.isError).toBe(false)
  if (outcome.isError) throw new Error(outcome.error.message)
  const preview = parseStoryArtifactPreview(outcome.value)
  if (preview === undefined) throw new Error('Expected versioned preview metadata')
  return preview
}

it('rebuilds a deleted historical projection from its exact stored version after the brief changes', async () => {
  const { ctx, actor, createNovel, preview } = await setup()
  const first = await createNovel('第一版：守塔人找到了失踪日志。')
  const original = successfulPreview(await preview(first))
  const revised = await ctx.story.saveBrief(actor, {
    novelId: first.id, requestId: parseRequestId('revise-brief'), expectedRevision: 1,
    text: '第二版：修钟师找到了消失的航线。',
  })
  await rm(original.path)
  const rebuilt = successfulPreview(await preview(revised, first.brief.id))
  expect(rebuilt).toEqual(original)
  expect(await readFile(rebuilt.path, 'utf8')).toBe('第一版：守塔人找到了失踪日志。')
  expect(ctx.story.getNovel(actor, first.id)).toEqual(revised)
  expect(ctx.story.getArtifact(actor, { novelId: first.id, artifactId: revised.brief.id }).text)
    .toBe('第二版：修钟师找到了消失的航线。')
})

it('rejects an edited projection without overwriting the file or changing its authoritative version', async () => {
  const { ctx, actor, createNovel, preview } = await setup()
  const novel = await createNovel('守塔人找到了失踪日志。')
  const original = successfulPreview(await preview(novel))
  await writeFile(original.path, '修钟师找到了消失航线。', 'utf8')
  const outcome = await preview(novel)
  expect(outcome.isError).toBe(true)
  if (!outcome.isError) throw new Error('An edited projection must not produce preview metadata')
  expect(outcome.error.message).toContain('Preview differs from the stored artifact')
  expect(outcome.meta).toBeUndefined()
  expect(await readFile(original.path, 'utf8')).toBe('修钟师找到了消失航线。')
  expect(ctx.story.getNovel(actor, novel.id)).toEqual(novel)
  expect(ctx.story.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text)
    .toBe('守塔人找到了失踪日志。')
})

it('rejects an artifact belonging to another novel before creating any projection', async () => {
  const { ctx, cwd, actor, createNovel, preview } = await setup()
  const first = await createNovel('第一部小说的创作要求。')
  const second = await createNovel('第二部小说的创作要求。')
  const outcome = await preview(first, second.brief.id)
  expect(outcome.isError).toBe(true)
  if (!outcome.isError) throw new Error('An unrelated artifact must not produce preview metadata')
  expect(outcome.error.message).toContain('artifactId is not published in this novel')
  expect(outcome.meta).toBeUndefined()
  expect(await readdir(cwd)).toEqual([])
  expect(ctx.story.getNovel(actor, first.id)).toEqual(first)
  expect(ctx.story.getNovel(actor, second.id)).toEqual(second)
})

it('cancels a staged preview write before publication without a success result or authoritative changes', async () => {
  const { ctx, cwd, actor, createNovel, preview, fs } = await setup()
  const novel = await createNovel()
  const controller = new AbortController()
  const staged = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const previousInternals = fs.internals
  fs.internals = {
    ...previousInternals,
    inspectTemp: async () => {
      staged.resolve()
      await release.promise
    },
  }
  const pending = preview(novel, novel.brief.id, controller.signal)
  try {
    await Promise.race([
      staged.promise,
      pending.then(() => { throw new Error('Preview settled before its file reached the publication barrier') }),
    ])
    controller.abort()
    release.resolve()
    const outcome = await pending
    expect(outcome.isError).toBe(true)
    if (!outcome.isError) throw new Error('A cancelled preview must not produce preview metadata')
    expect(outcome.error.info?.code).toBe('FS_ABORTED')
    expect(outcome.meta).toBeUndefined()
    expect(await readdir(join(cwd, '.dsh-story', novel.id))).toEqual([])
    expect(ctx.story.getNovel(actor, novel.id)).toEqual(novel)
    expect(ctx.story.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text)
      .toBe('守塔人找到了失踪日志。')
  } finally {
    controller.abort()
    release.resolve()
    await pending
    fs.internals = previousInternals
  }
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a POSIX permission denial without a preview or authoritative changes', async () => {
  const { ctx, cwd, actor, createNovel, preview } = await setup()
  const novel = await createNovel()
  const directory = join(cwd, '.dsh-story')
  await mkdir(directory)
  await chmod(directory, 0o500)
  try {
    const outcome = await preview(novel)
    expect(outcome.isError).toBe(true)
    if (!outcome.isError) throw new Error('A denied write must not produce preview metadata')
    expect(outcome.error.message).toMatch(/permission denied|EACCES/i)
    expect(outcome.meta).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
    expect(ctx.story.getNovel(actor, novel.id)).toEqual(novel)
    expect(ctx.story.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text)
      .toBe('守塔人找到了失踪日志。')
  } finally { await chmod(directory, 0o700) }
})

it('rejects a preview directory linked outside the Session workspace without changing the linked directory', async () => {
  const { ctx, root, cwd, actor, createNovel, preview } = await setup()
  const novel = await createNovel()
  const outside = join(root, 'outside-workspace')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'existing outside content', 'utf8')
  await symlink(outside, join(cwd, '.dsh-story'), process.platform === 'win32' ? 'junction' : 'dir')
  const outcome = await preview(novel)
  expect(outcome.isError).toBe(true)
  if (!outcome.isError) throw new Error('An escaped preview must not produce preview metadata')
  expect(outcome.error.message).toContain('Preview path must remain inside the Session workspace')
  expect(outcome.meta).toBeUndefined()
  expect(await readdir(outside)).toEqual(['keep.txt'])
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('existing outside content')
  expect(ctx.story.getNovel(actor, novel.id)).toEqual(novel)
})
