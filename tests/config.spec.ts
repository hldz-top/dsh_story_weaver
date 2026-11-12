import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import * as Story from '../src/index.ts'
import { mountPluginRuntime } from './support/plugin-runtime.ts'

/** Host-owned OpenCode Go route. The plugin must leave this registration untouched. */
class HostOpenCodeGo extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'Host OpenCode Go' } }
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('Plugin startup must not call the host OpenCode Go adapter')
  }
}

const unsafeDirectories = [
  '', ' ', '/preview', 'C:/preview', 'C:preview', '\\\\server\\share', '//server/share',
  '.', '..', 'preview/../versions', 'preview/./versions', 'preview//versions', 'preview/',
  'preview\\versions', 'preview\0versions', ' preview', 'preview ',
]

it.each(unsafeDirectories)('rejects unsafe previewDirectory %j before accessing host services', async (previewDirectory) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = new Story.Config({ ...new Story.Config(), previewDirectory })
  await expect(Story.apply(ctx, config)).rejects.toThrow('previewDirectory must be a normalized relative directory')
  expect(ctx.get('story')).toBeUndefined()
})

it('keeps the default preview directory relative to the Session workspace', () => {
  expect(new Story.Config().previewDirectory).toBe('.dsh-story')
  expect(new Story.Config().allowIncompleteSettings).toBe(false)
  expect(new Story.Config().allowSettingsImport).toBe(false)
})

it.each(['.dsh-story', 'novels/versions', '小说/预览'])('loads the plugin with relative previewDirectory %j', async (previewDirectory) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-config-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'workspace'))
  await mountAgentLoopTestDependencies(ctx)
  await mountPluginRuntime(ctx, root)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const config = new Story.Config({ ...new Story.Config(), previewDirectory, maxRepairAttempts: 0 })
  await ctx.plugin(Story, config)
  expect(ctx.get('story')).toBeDefined()
  for (const tool of ['story_preview', 'story_write', 'story_update', 'story_revise', 'story_resume', 'story_stop',
    'story_get_settings', 'story_get_manuscript', 'story_settings_catalog', 'story_read_run_output', 'story_get_run', 'story_list_runs']) {
    expect(ctx.tools.get(tool), `Loaded plugin must register ${tool}`).toBeDefined()
  }
  expect(ctx.subagents.getProvider('spawn')).toBeDefined()
  expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('opencode-go')
})

it('keeps a host OpenCode Go registration and adds no plugin adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-config-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'workspace'))
  await mountAgentLoopTestDependencies(ctx)
  await mountPluginRuntime(ctx, root)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.effect(() => ctx.llm.registerAdapter(['opencode-go'], new HostOpenCodeGo()))
  await ctx.plugin(Story, new Story.Config())
  expect(ctx.llm.listProviders().filter(provider => provider.id === 'opencode-go')).toEqual([{ id: 'opencode-go', name: 'Host OpenCode Go' }])
})

it('publishes the bounded native run defaults without overriding the model route', () => {
  const config = new Story.Config()
  expect(config).toMatchObject({ stageProvider: 'spawn', maxDelegationDepth: 2, maxStageRequests: 96,
    stageTimeoutMs: 600_000, maxRepairAttempts: 2, maxParallelStages: 3, maxRunAttempts: 512,
    minChapterWords: 3000, maxChapterWords: 5000 })
  expect(Object.hasOwn(config, 'provider')).toBe(false)
  expect(Object.hasOwn(config, 'model')).toBe(false)
  expect(config.writingModel).toBe('inherit')
})

const positiveRunFields = ['maxDelegationDepth', 'maxStageRequests', 'stageTimeoutMs', 'maxParallelStages', 'maxRunAttempts'] as const
it.each(positiveRunFields.flatMap(field => [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map(value => ({ field, value }))))(
  'rejects $field=$value before opening storage', async ({ field, value }) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await expect(Story.apply(ctx, { ...new Story.Config(), [field]: value })).rejects.toThrow(`${field} must be a finite positive integer`)
    expect(ctx.get('story')).toBeUndefined()
    expect(ctx.get('storyRunner')).toBeUndefined()
  },
)

it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid repair limit %s before opening storage', async value => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await expect(Story.apply(ctx, { ...new Story.Config(), maxRepairAttempts: value })).rejects.toThrow('maxRepairAttempts must be a finite nonnegative integer')
})

it.each([
  { override: { stageTimeoutMs: 2_147_483_648 }, message: 'stageTimeoutMs exceeds the supported timer range' },
  { override: { stageProvider: '  ' }, message: 'stageProvider must name a configured native in-process spawn provider' },
  { override: { writingModel: 'opencode-go' }, message: 'writingModel opencode-go is not provided by this plugin. OpenCode Go is a host subscription. Set writingModel to inherit so writing stages use the parent model and subscription.' },
  { override: { writingModel: 'pi-ai' }, message: 'writingModel must be inherit so writing stages use the configured parent model and subscription' },
])('rejects an unsupported native runtime setting: $message', async ({ override, message }) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await expect(Story.apply(ctx, { ...new Story.Config(), ...override })).rejects.toThrow(message)
  expect(ctx.get('story')).toBeUndefined()
  expect(ctx.get('storyRunner')).toBeUndefined()
})
