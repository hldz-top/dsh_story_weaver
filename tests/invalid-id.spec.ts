import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Present from '@deepseek-ai/dsh-tool-present'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import * as Story from '../src/index.ts'
import { WritingError, parseArtifactId, parseNovelId, parseRequestId, type Actor } from '../src/contracts.ts'
import { parseRunId } from '../src/run-store.ts'
import { findingQuestionIdMessage, parseSelectedFindings, researchConclusions, researchQuestionIdMessage, researchQuestions } from '../src/research.ts'
import { admitToolId, artifactIdParameter, attemptIdParameter, defineStoryTool, expectedAppliedIdParameter, idFormatMessage, novelIdParameter, parseToolNovelId, parseToolRunId, requestIdParameter, runIdParameter, type ToolIdParam } from '../src/tools.ts'
import { mountPluginRuntime } from './support/plugin-runtime.ts'
import { executeRegisteredTool } from './support/tool-batch.ts'
import { call, ScriptedModel, stop } from './support/model.ts'
import { testResearchLimits } from './support/storage.ts'

const uuid = '00c38d7c-50d8-4a1b-93f0-188daf5a9859'
const novelMessage = idFormatMessage.novelId
const runMessage = idFormatMessage.runId
const artifactId = `artifact_${uuid}`
const attemptId = `attempt_${uuid}`
const zodDump = /invalid_format|invalid_type|ZodError|"origin"|"pattern"/

/** Malformed values the tool must reject. Negative rows, then boundary rows. */
function malformed(prefix: 'novel' | 'run'): readonly (readonly [string, unknown])[] {
  const other = prefix === 'novel' ? 'run' : 'novel'
  return [
    ['garbage string', 'not-an-id'],
    ['wrong prefix', `${other}_${uuid}`],
    ['empty string', ''],
    ['non-string', 1],
    ['non-string null', null],
    ['prefix only', `${prefix}_`],
    ['wrong length', `${prefix}_${uuid.slice(0, -1)}`],
    ['uppercase', `${prefix}_${uuid.toUpperCase()}`],
    ['surrounding whitespace', ` ${prefix}_${uuid} `],
  ]
}

const novelTools = [
  'story_complete_research', 'story_get_manuscript', 'story_get_novel', 'story_get_research', 'story_get_settings',
  'story_list_research', 'story_list_runs', 'story_preview', 'story_read_artifact', 'story_read_research_source',
  'story_research_results', 'story_revise', 'story_save_brief', 'story_select_novel', 'story_settings_import',
  'story_start_research', 'story_update', 'story_write',
]
const runTools = ['story_get_run', 'story_read_run_output', 'story_resume', 'story_stop']

function novelCall(name: string, novelId: unknown): Record<string, unknown> {
  const scope = { novelId, briefArtifactId: artifactId, requestId: 'request-1', settingsRoots: ['e1'], chapterCount: 1, fromChapter: 1, throughChapter: 1 }
  switch (name) {
    case 'story_save_brief':
      return { novelId, requestId: 'request-1', expectedRevision: 1, text: '下一版。' }
    case 'story_read_artifact':
      return { novelId, artifactId, offset: 0, limit: 8 }
    case 'story_get_novel':
    case 'story_select_novel':
    case 'story_get_settings':
    case 'story_get_manuscript':
    case 'story_list_runs':
    case 'story_list_research':
      return { novelId }
    case 'story_preview':
      return { novelId, artifactId }
    case 'story_write':
    case 'story_update':
      return scope
    case 'story_revise':
      return { ...scope, baseArtifactId: artifactId, instructions: '改开场。' }
    case 'story_settings_import':
      return { novelId, requestId: 'request-1', dimensionCode: 'a1', expectedAppliedId: artifactId, output: '{}' }
    case 'story_start_research':
      return { novelId, requestId: 'request-1', briefArtifactId: artifactId, questions: [{ id: 'genre', kind: 'creative', question: '体裁？', reason: '作者决定。' }] }
    case 'story_get_research':
    case 'story_research_results':
      return { novelId, planId: artifactId }
    case 'story_read_research_source':
      return { novelId, planId: artifactId, callId: 'call-1', sourceIndex: 0, offset: 0, limit: 1 }
    case 'story_complete_research':
      return { novelId, planId: artifactId, requestId: 'request-1', findings: [{ questionId: 'genre', callIds: [], conclusion: '悬疑。', adequate: true, selections: [] }] }
    default:
      throw new Error(`unexpected novel tool ${name}`)
  }
}

function runCall(name: string, runId: unknown): Record<string, unknown> {
  switch (name) {
    case 'story_resume':
      return { runId, retryUnknown: false }
    case 'story_stop':
    case 'story_get_run':
      return { runId }
    case 'story_read_run_output':
      return { runId, attemptId, offset: 0, limit: 1 }
    default:
      throw new Error(`unexpected run tool ${name}`)
  }
}

function parameterNames(schema: { readonly parameters: Record<string, unknown> }): string[] {
  const properties = schema.parameters.properties
  return typeof properties === 'object' && properties !== null ? Object.keys(properties) : []
}

function errorText(outcome: ToolExecutionResult, label: string): string {
  expect(outcome.isError, label).toBe(true)
  if (!outcome.isError) throw new Error(`${label} succeeded`)
  expect(outcome.content, label).toEqual([{ type: 'text', text: expect.any(String) }])
  const block = outcome.content[0]
  if (block?.type !== 'text') throw new Error(`${label} has no text`)
  expect(block.text, label).not.toMatch(zodDump)
  expect(outcome.error.message, label).not.toMatch(zodDump)
  expect(block.text, label).toBe(`Error: ${outcome.error.message}`)
  return block.text
}

function expectWritingError(value: unknown, message: string): void {
  try {
    if (message === novelMessage) parseToolNovelId(value)
    else parseToolRunId(value)
    throw new Error('expected WritingError')
  } catch (error) {
    expect(error).toBeInstanceOf(WritingError)
    if (!(error instanceof WritingError)) throw error
    expect(error.code).toBe('invalid-input')
    expect(error.message).toBe(message)
    expect(error.message).not.toMatch(zodDump)
    expect(error).not.toBeInstanceOf(z.ZodError)
  }
}

async function setup(model = new ScriptedModel(() => stop()), allowIncompleteSettings = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-invalid-id-'))
  const cwd = join(root, 'novel-workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await mountPluginRuntime(ctx, root)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(Present, new Present.Config())
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model))
  await ctx.plugin(Story, new Story.Config({ ...new Story.Config(), maxArtifactBytes: 100_000, maxReadChars: 1024, previewDirectory: '.dsh-story', allowSettingsImport: true, allowIncompleteSettings }))
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(randomUUID()), { provider: 'fixture', model: 'deterministic' }, { cwd })
  const execute = (name: string, args: Record<string, unknown>) => executeRegisteredTool(ctx, {
    name, arguments: args, agent, signal: new AbortController().signal,
  })
  const workspace = agent.session.header.cwd
  if (workspace === undefined) throw new Error('Session has no workspace')
  const actor: Actor = { sessionId: agent.session.id, workspace: (await ctx.fs.resolve('.', { cwd: workspace })).displayPath }
  return { ctx, agent, actor, execute }
}

it('keeps valid novel and run ids and turns malformed ones into WritingError invalid-input', () => {
  const novelId = `novel_${uuid}`
  const runId = `run_${uuid}`
  expect(parseToolNovelId(novelId)).toBe(novelId)
  expect(parseToolRunId(runId)).toBe(runId)
  const generated = randomUUID()
  expect(parseToolNovelId(`novel_${generated}`)).toBe(`novel_${generated}`)
  expect(parseToolRunId(`run_${generated}`)).toBe(`run_${generated}`)
  expect(() => parseNovelId('not-an-id')).toThrow(z.ZodError)
  expect(() => parseRunId('not-an-id')).toThrow(z.ZodError)
  for (const [, value] of malformed('novel')) expectWritingError(value, novelMessage)
  for (const [, value] of malformed('run')) expectWritingError(value, runMessage)
})

it('rejects a malformed novelId or runId from every tool without a zod dump', async () => {
  const { ctx, execute } = await setup()
  const names = (key: 'novelId' | 'runId') => ctx.tools.schemas().flatMap(schema => parameterNames(schema).includes(key) ? [schema.name] : []).sort()
  expect(names('novelId')).toEqual([...novelTools].sort())
  expect(names('runId')).toEqual([...runTools].sort())
  const propertiesOf = (name: string) => {
    const schema = ctx.tools.schemas().find(item => item.name === name)
    if (schema === undefined) throw new Error(`missing tool ${name}`)
    const properties = schema.parameters.properties
    if (typeof properties !== 'object' || properties === null) throw new Error(`${name} has no properties`)
    return properties as Record<string, unknown>
  }
  expect(propertiesOf('story_get_novel').novelId).toEqual({ type: 'string', description: novelIdParameter.description })
  expect(propertiesOf('story_get_run').runId).toEqual({ type: 'string', description: runIdParameter.description })
  expect(propertiesOf('story_read_artifact').artifactId).toEqual({ type: 'string', description: artifactIdParameter.description })
  expect(propertiesOf('story_read_run_output').attemptId).toEqual({ type: 'string', description: attemptIdParameter.description })
  expect(propertiesOf('story_save_brief').requestId).toEqual({ type: 'string', description: requestIdParameter.description })
  expect(propertiesOf('story_get_research').planId).toEqual({ type: 'string', description: artifactIdParameter.description })
  expect(propertiesOf('story_write').briefArtifactId).toEqual({ type: 'string', description: artifactIdParameter.description })
  expect(propertiesOf('story_revise').baseArtifactId).toEqual({ type: 'string', description: artifactIdParameter.description })
  expect(propertiesOf('story_settings_import').expectedAppliedId).toEqual({ type: 'string', description: expectedAppliedIdParameter.description })
  expect(expectedAppliedIdParameter.description).toContain('current head being replaced')
  for (const description of [novelIdParameter.description, runIdParameter.description, artifactIdParameter.description, attemptIdParameter.description]) {
    expect(description).toContain('lowercase UUID')
  }
  for (const [label, value] of malformed('novel')) {
    for (const name of novelTools) {
      const text = errorText(await execute(name, novelCall(name, value)), `${name} ${label}`)
      expect(text, `${name} ${label}`).toBe(`Error: ${novelMessage}`)
    }
  }
  for (const [label, value] of malformed('run')) {
    for (const name of runTools) {
      const text = errorText(await execute(name, runCall(name, value)), `${name} ${label}`)
      expect(text, `${name} ${label}`).toBe(`Error: ${runMessage}`)
    }
  }
})

it('still runs every id-taking tool when the novelId or runId is valid', async () => {
  const { ctx, actor, execute } = await setup()
  const brief = '守塔人找到了失踪日志。'
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('create-id'), title: '潮汐城', brief })
  const novelId = created.id
  const read = async (name: string, args: Record<string, unknown>) => {
    const outcome = await execute(name, args)
    if (outcome.isError) throw new Error(`${name} failed: ${outcome.error.message}`)
    return outcome.value
  }
  const refused = async (name: string, args: Record<string, unknown>) => errorText(await execute(name, args), name)
  expect(await read('story_get_novel', { novelId })).toMatchObject({ id: novelId, title: '潮汐城', revision: 1 })
  expect(await read('story_select_novel', { novelId })).toMatchObject({ id: novelId })
  expect(await read('story_read_artifact', { novelId, artifactId: created.brief.id, offset: 0, limit: 1024 })).toMatchObject({ text: brief, eof: true, view: 'stored' })
  expect(await read('story_preview', { novelId, artifactId: created.brief.id })).toMatchObject({ kind: 'story-artifact-preview', novelId, artifactId: created.brief.id })
  expect(await read('story_get_settings', { novelId })).toEqual({ novelId, applied: [], history: [] })
  expect(await read('story_get_manuscript', { novelId })).toEqual({ novelId, history: [], heads: [], appliedChapters: [] })
  expect(await read('story_list_runs', { novelId })).toEqual([])
  expect(await read('story_list_research', { novelId })).toEqual([])
  const scope = { novelId, briefArtifactId: created.brief.id, requestId: 'write-id', settingsRoots: ['e1'], chapterCount: 1, fromChapter: 1, throughChapter: 1 }
  for (const name of ['story_write', 'story_update'] as const) {
    const text = await refused(name, scope)
    expect(text).toContain('settings-incomplete')
    expect(text).not.toContain(novelMessage)
  }
  const revised = await refused('story_revise', { ...scope, requestId: 'revise-id', baseArtifactId: created.brief.id, instructions: '改开场。' })
  expect(revised).toContain('settings-incomplete')
  expect(revised).not.toContain(novelMessage)
  const imported = await refused('story_settings_import', { novelId, requestId: 'import-id', dimensionCode: 'missing', expectedAppliedId: created.brief.id, output: '{}' })
  expect(imported).toContain('Settings dimension is not available for import')
  expect(imported).not.toContain(novelMessage)
  const saved = z.object({ id: z.string(), revision: z.number(), brief: z.object({ id: z.string() }) }).parse(await read('story_save_brief', { novelId, requestId: 'save-id', expectedRevision: created.revision, text: '第二版创作要求。' }))
  expect(saved).toMatchObject({ id: novelId, revision: 2 })
  const question = { id: 'genre', kind: 'creative', question: '体裁？', reason: '作者决定。' }
  const plan = z.object({ planId: z.string() }).parse(await read('story_start_research', { novelId, requestId: 'research-id', briefArtifactId: saved.brief.id, questions: [question] }))
  expect(await read('story_get_research', { novelId, planId: plan.planId })).toMatchObject({ novelId, planId: plan.planId })
  expect(await read('story_list_research', { novelId })).toMatchObject([{ planId: plan.planId }])
  expect(await read('story_research_results', { novelId, planId: plan.planId })).toEqual([])
  const source = await refused('story_read_research_source', { novelId, planId: plan.planId, callId: 'call-1', sourceIndex: 0, offset: 0, limit: 1 })
  expect(source).not.toContain(novelMessage)
  expect(await read('story_complete_research', { novelId, planId: plan.planId, requestId: 'complete-id', findings: [{ questionId: 'genre', callIds: [], conclusion: '悬疑。', adequate: true, selections: [] }] })).toMatchObject({ novelId, planId: plan.planId, outcome: 'not-needed' })
  const runner = ctx.storyRunner
  const service = ctx.story
  const run = await runner.runs.begin(actor, {
    novelId, briefArtifactId: parseArtifactId(saved.brief.id), requestId: parseRequestId('run-id'), settingsRoots: ['a1'],
    chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write', revision: null, executionLimits: runner.limits,
    serviceLimits: { ...service.limits, ...service.researchLimits },
  })
  const completed = await runner.runs.finish(actor, run.id, 'completed')
  expect(await read('story_get_run', { runId: completed.id })).toMatchObject({ id: completed.id, status: 'completed' })
  expect(await read('story_stop', { runId: completed.id })).toMatchObject({ id: completed.id, status: 'completed' })
  expect(await read('story_list_runs', { novelId })).toMatchObject([{ id: completed.id }])
  const page = await refused('story_read_run_output', { runId: completed.id, attemptId, offset: 0, limit: 1 })
  expect(page).toContain('attemptId does not belong to this run')
  expect(page).not.toContain(runMessage)
  const resume = await refused('story_resume', { runId: completed.id, retryUnknown: false })
  expect(resume).toContain('Completed runs cannot resume')
  expect(resume).not.toContain(runMessage)
})

it('rejects every schema id field without a raw zod error', async () => {
  const { ctx, actor, execute } = await setup()
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('matrix-novel'), title: '潮汐城', brief: '守塔人找到了失踪日志。' })
  const plan = await ctx.story.startResearch(actor, {
    novelId: created.id, requestId: parseRequestId('matrix-plan'), briefArtifactId: created.brief.id,
    questions: [{ id: 'genre', kind: 'creative', question: '体裁？', reason: '作者决定。' }],
  }, 0)
  const base: Record<string, unknown> = {
    novelId: created.id, runId: `run_${uuid}`, artifactId: plan.planId, planId: plan.planId,
    briefArtifactId: created.brief.id, baseArtifactId: created.brief.id, expectedAppliedId: created.brief.id,
    attemptId: `attempt_${uuid}`, requestId: 'request-ok', title: '潮汐城', brief: '守塔人找到了失踪日志。', text: '下一版。',
    expectedRevision: created.revision, offset: 0, limit: 1, settingsRoots: ['e1'], chapterCount: 1, fromChapter: 1, throughChapter: 1,
    instructions: '改开场。', retryUnknown: false, dimensionCode: 'a1', output: '{}',
    questions: [{ id: 'genre', kind: 'creative', question: '体裁？', reason: '作者决定。' }], callId: 'call-1', sourceIndex: 0,
    findings: [{ questionId: 'genre', callIds: [], conclusion: '悬疑。', adequate: true, selections: [] }],
  }
  const kinds = Object.keys(idFormatMessage)
  const pairs = ctx.tools.schemas().flatMap(schema => {
    const properties = schema.parameters.properties
    if (typeof properties !== 'object' || properties === null) return []
    return Object.keys(properties).flatMap(key => kinds.includes(key) ? [[schema.name, key as ToolIdParam] as const] : [])
  })
  expect(pairs).toHaveLength(43)
  expect(new Set(pairs.map(([, key]) => key)).size).toBe(kinds.length)
  for (const [name, key] of pairs) {
    for (const value of ['', 123, null, 'bad'] as const) {
      const label = `${name} ${key} ${String(value)}`
      const outcome = await execute(name, { ...base, [key]: value })
      // 'bad' is a legal requestId (nonblank, at most 256 characters). Every other sample is rejected.
      if (key === 'requestId' && value === 'bad') {
        const rendered = JSON.stringify(outcome)
        expect(rendered, label).not.toMatch(zodDump)
        continue
      }
      expect(errorText(outcome, label), label).toBe(`Error: ${idFormatMessage[key]}`)
    }
  }
})

/** Top-level *Id parameters that are not admitted ids. Nested question ids are admitted separately. */
const idParameterAllowlist = new Set(['callId'])

it('does not treat a wrong-type constructor parameter as an admitted id', async () => {
  const { ctx, execute } = await setup()
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_constructor_probe',
    description: 'Probe that a prototype key is not an admitted id.',
    parameters: { constructor: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: '{}' }],
    },
    async execute() { return {} },
  })))
  const text = errorText(await execute('story_constructor_probe', { constructor: 123 }), 'constructor')
  expect(text).toBe('Error: invalid arguments: "constructor" must be a string')
})

it('requires every top-level *Id parameter to be admitted or explicitly allowed', async () => {
  const { ctx } = await setup()
  const uncovered = ctx.tools.schemas().flatMap(schema => {
    const properties = schema.parameters.properties
    if (typeof properties !== 'object' || properties === null) return []
    return Object.keys(properties).flatMap(key => {
      if (!key.endsWith('Id')) return []
      if (Object.hasOwn(idFormatMessage, key) || idParameterAllowlist.has(key)) return []
      return [`${schema.name}.${key}`]
    })
  })
  expect(uncovered).toEqual([])
})

it.each(['stopped', 'failed'] as const)('refuses to resume a %s run after the brief changes and leaves it unchanged', async status => {
  const model = new ScriptedModel(() => stop())
  const { ctx, actor, execute } = await setup(model)
  const reason = status === 'stopped' ? 'Stopped before the brief changed.' : 'Failed before the brief changed.'
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId(`resume-${status}`), title: '潮汐城', brief: '第一版。' })
  const runner = ctx.storyRunner
  const run = await runner.runs.begin(actor, {
    novelId: created.id, briefArtifactId: created.brief.id, requestId: parseRequestId(`run-${status}`), settingsRoots: ['a1'],
    chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write', revision: null, executionLimits: runner.limits,
    serviceLimits: { ...ctx.story.limits, ...ctx.story.researchLimits },
  })
  const settled = await runner.runs.finish(actor, run.id, status, reason)
  await ctx.story.saveBrief(actor, { novelId: created.id, requestId: parseRequestId(`brief-${status}`), expectedRevision: created.revision, text: '第二版。' })
  const text = errorText(await execute('story_resume', { runId: settled.id, retryUnknown: true }), status)
  expect(text).toBe("Error: This run's creative brief is no longer current; start story_update with the current briefArtifactId")
  expect(text).not.toContain('briefArtifactId must name')
  expect(runner.runs.get(actor, settled.id)).toMatchObject({ status, error: reason })
  expect(model.requests).toHaveLength(0)
})

it('refuses a completed run after the brief changes and leaves it unchanged', async () => {
  const model = new ScriptedModel(() => stop())
  const { ctx, actor, execute } = await setup(model)
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('resume-completed-changed'), title: '潮汐城', brief: '第一版。' })
  const runner = ctx.storyRunner
  const run = await runner.runs.begin(actor, {
    novelId: created.id, briefArtifactId: created.brief.id, requestId: parseRequestId('run-completed-changed'), settingsRoots: ['a1'],
    chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write', revision: null, executionLimits: runner.limits,
    serviceLimits: { ...ctx.story.limits, ...ctx.story.researchLimits },
  })
  const completed = await runner.runs.finish(actor, run.id, 'completed')
  await ctx.story.saveBrief(actor, { novelId: created.id, requestId: parseRequestId('brief-completed-changed'), expectedRevision: created.revision, text: '第二版。' })
  const text = errorText(await execute('story_resume', { runId: completed.id, retryUnknown: false }), 'completed')
  expect(text).toBe("Error: This run's creative brief is no longer current; start story_update with the current briefArtifactId")
  expect(runner.runs.get(actor, completed.id)).toMatchObject({ status: 'completed', error: null })
  expect(model.requests).toHaveLength(0)
})

it('keeps the completed-run refusal when its creative brief is still current', async () => {
  const model = new ScriptedModel(() => stop())
  const { ctx, actor, execute } = await setup(model)
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('resume-novel'), title: '潮汐城', brief: '第一版。' })
  const runner = ctx.storyRunner
  const run = await runner.runs.begin(actor, {
    novelId: created.id, briefArtifactId: created.brief.id, requestId: parseRequestId('resume-run'), settingsRoots: ['a1'],
    chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write', revision: null, executionLimits: runner.limits,
    serviceLimits: { ...ctx.story.limits, ...ctx.story.researchLimits },
  })
  const completed = await runner.runs.finish(actor, run.id, 'completed')
  const text = errorText(await execute('story_resume', { runId: completed.id, retryUnknown: false }), 'resume')
  expect(text).toContain('Completed runs cannot resume')
  expect(runner.runs.get(actor, completed.id)).toMatchObject({ status: 'completed', error: null })
  expect(model.requests).toHaveLength(0)
})

it('keeps the research brief mismatch wording when briefArtifactId is not current', async () => {
  const { ctx, actor, execute } = await setup()
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('brief-novel'), title: '潮汐城', brief: '第一版。' })
  await ctx.story.saveBrief(actor, { novelId: created.id, requestId: parseRequestId('brief-next'), expectedRevision: created.revision, text: '第二版。' })
  const text = errorText(await execute('story_start_research', {
    novelId: created.id, requestId: 'research-old-brief', briefArtifactId: created.brief.id,
    questions: [{ id: 'genre', kind: 'creative', question: '体裁？', reason: '作者决定。' }],
  }), 'old brief')
  expect(text).toBe('Error: Research plan does not match the current creative brief')
  expect(text).not.toContain('briefArtifactId')
})

it('records the friendly id error in the model-visible tool result', async () => {
  const model = new ScriptedModel((_request, index) => {
    if (index === 0) return call('story_get_novel', { novelId: 'not-an-id' })
    if (index === 1) return call('story_resume', { runId: 'not-a-run', retryUnknown: false })
    if (index === 2) return call('story_select_novel', { novelId: 1 }, 'select-number')
    if (index === 3) return call('story_get_run', { runId: ` ${`run_${uuid}`} ` }, 'get-padded')
    return stop()
  })
  const { agent } = await setup(model)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '读取不存在的标识。' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const request = model.requests.at(-1)
  if (request === undefined) throw new Error('The loop did not record a model request')
  const results = request.messages.filter((message): message is ToolResultMessage => message.role === 'tool')
  const texts = results.flatMap(result => result.content.flatMap(block => block.type === 'text' ? [block.text] : []))
  expect(texts).toEqual([
    `Error: ${novelMessage}`,
    `Error: ${runMessage}`,
    `Error: ${novelMessage}`,
    `Error: ${runMessage}`,
  ])
  expect(texts.join('\n')).not.toMatch(zodDump)
  const logged = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
  expect(logged).toEqual(texts)
  expect(texts.join('\n')).not.toContain('invalid-input')
})

it('rethrows a non-Zod error from id parsing or the tool handler unchanged', async () => {
  const boom = new Error('storage exploded')
  expect(() => admitToolId(() => { throw boom }, 'novelId', 'x')).toThrow(boom)
  try {
    admitToolId(() => { throw boom }, 'novelId', 'x')
  } catch (error) {
    expect(error).toBe(boom)
    expect(error).not.toBeInstanceOf(WritingError)
  }
  const { ctx } = await setup()
  const outcome = await executeRegisteredTool(ctx, {
    name: 'story_get_novel', arguments: { novelId: `novel_${uuid}` }, signal: new AbortController().signal,
  })
  expect(outcome.isError).toBe(true)
  if (!outcome.isError) throw new Error('expected a handler error')
  expect(outcome.error.message).toBe('Writing tools require a Session workspace')
  expect(outcome.error.message).not.toContain('invalid-input')
  expect(outcome.content).toEqual([{ type: 'text', text: 'Error: Writing tools require a Session workspace' }])
})

it('rejects every other id kind and names a missing id', async () => {
  const { ctx, actor, execute } = await setup()
  const brief = '守塔人找到了失踪日志。'
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('create-other-ids'), title: '潮汐城', brief })
  const novelId = created.id
  const missingArtifact = `artifact_${uuid}`
  const refused = async (name: string, args: Record<string, unknown>) => errorText(await execute(name, args), name)
  const scope = { novelId, briefArtifactId: created.brief.id, settingsRoots: ['e1'], chapterCount: 1, fromChapter: 1, throughChapter: 1 }
  for (const [name, args, message] of [
    ['story_read_artifact', { novelId, artifactId: 'nope', offset: 0, limit: 1 }, idFormatMessage.artifactId],
    ['story_read_artifact', { novelId, artifactId: '', offset: 0, limit: 1 }, idFormatMessage.artifactId],
    ['story_read_artifact', { novelId, artifactId: 1, offset: 0, limit: 1 }, idFormatMessage.artifactId],
    ['story_save_brief', { novelId, requestId: '', expectedRevision: 1, text: '下一版。' }, idFormatMessage.requestId],
    ['story_save_brief', { novelId, requestId: '   ', expectedRevision: 1, text: '下一版。' }, idFormatMessage.requestId],
    ['story_save_brief', { novelId, requestId: null, expectedRevision: 1, text: '下一版。' }, idFormatMessage.requestId],
    ['story_create_novel', { requestId: '', title: '潮汐城', brief }, idFormatMessage.requestId],
    ['story_get_research', { novelId, planId: 'nope' }, idFormatMessage.planId],
    ['story_get_research', { novelId, planId: '' }, idFormatMessage.planId],
    ['story_get_research', { novelId, planId: null }, idFormatMessage.planId],
    ['story_write', { ...scope, requestId: 'write-bad-brief', briefArtifactId: '' }, idFormatMessage.briefArtifactId],
    ['story_write', { ...scope, requestId: 'write-bad-brief-type', briefArtifactId: 1 }, idFormatMessage.briefArtifactId],
    ['story_revise', { ...scope, requestId: 'revise-bad-base', baseArtifactId: '', instructions: '改。' }, idFormatMessage.baseArtifactId],
    ['story_revise', { ...scope, requestId: 'revise-bad-base-type', baseArtifactId: null, instructions: '改。' }, idFormatMessage.baseArtifactId],
    ['story_settings_import', { novelId, requestId: 'import-bad-head', dimensionCode: 'a1', expectedAppliedId: '', output: '{}' }, idFormatMessage.expectedAppliedId],
    ['story_settings_import', { novelId, requestId: 'import-bad-head-type', dimensionCode: 'a1', expectedAppliedId: 1, output: '{}' }, idFormatMessage.expectedAppliedId],
    ['story_read_run_output', { runId: `run_${uuid}`, attemptId: 'bad', offset: 0, limit: 1 }, idFormatMessage.attemptId],
    ['story_read_run_output', { runId: `run_${uuid}`, attemptId: '', offset: 0, limit: 1 }, idFormatMessage.attemptId],
    ['story_read_run_output', { runId: `run_${uuid}`, attemptId: null, offset: 0, limit: 1 }, idFormatMessage.attemptId],
  ] as const) {
    expect(await refused(name, { ...args }), `${name} ${message}`).toBe(`Error: ${message}`)
  }
  expect(await refused('story_get_novel', { novelId: `novel_${uuid}` })).toContain('novelId does not exist')
  expect(await refused('story_read_artifact', { novelId, artifactId: missingArtifact, offset: 0, limit: 1 })).toContain('artifactId is not published in this novel')
  expect(await refused('story_get_run', { runId: `run_${uuid}` })).toContain('runId does not exist')
  expect(await refused('story_get_research', { novelId, planId: missingArtifact })).toContain('planId is not published in this novel')
  expect(await refused('story_write', { ...scope, requestId: 'write-missing-brief', briefArtifactId: missingArtifact })).toContain('briefArtifactId')
  const saved = z.object({ brief: z.object({ id: z.string() }) }).parse(await (async () => {
    const outcome = await execute('story_save_brief', { novelId, requestId: 'fresh-request-id', expectedRevision: created.revision, text: '第二版。' })
    if (outcome.isError) throw new Error(outcome.error.message)
    return outcome.value
  })())
  expect(saved.brief.id).not.toBe(created.brief.id)
  expect(await refused('story_settings_import', { novelId, requestId: 'import-missing-head', dimensionCode: 'a1', expectedAppliedId: missingArtifact, output: '{}' })).toContain('expectedAppliedId')
  const runner = ctx.storyRunner
  const run = await runner.runs.begin(actor, {
    novelId, briefArtifactId: parseArtifactId(saved.brief.id), requestId: parseRequestId('run-for-attempt'), settingsRoots: ['a1'],
    chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write', revision: null, executionLimits: runner.limits,
    serviceLimits: { ...ctx.story.limits, ...ctx.story.researchLimits },
  })
  expect(await refused('story_read_run_output', { runId: run.id, attemptId, offset: 0, limit: 1 })).toContain('attemptId does not belong to this run')
})

const question = { kind: 'creative' as const, question: '体裁？', reason: '作者决定。' }
const legacyFinding = { callIds: [] as string[], conclusion: '悬疑。', adequate: true }
const findingBody = { ...legacyFinding, selections: [] as [] }
const rawZod = /"code":|ZodError/

function expectIdentifierError(run: () => unknown, message: string, label: string): void {
  try {
    run()
    throw new Error(`${label} succeeded`)
  } catch (error) {
    expect(error, label).toBeInstanceOf(WritingError)
    if (!(error instanceof WritingError)) throw error
    expect(error.code, label).toBe('invalid-input')
    expect(error.message, label).toBe(message)
    expect(error.message, label).not.toMatch(zodDump)
    expect(error.message, label).not.toMatch(rawZod)
    expect(error, label).not.toBeInstanceOf(z.ZodError)
  }
}

it('admits bounded research question ids and rejects malformed ones without a zod dump', () => {
  expect(researchQuestionIdMessage).toBe('questions[].id must be a nonblank string of at most 256 characters')
  expect(findingQuestionIdMessage).toBe('findings[].questionId must be a nonblank string of at most 256 characters')
  expect(Object.hasOwn(idFormatMessage, 'questionId')).toBe(false)
  const id = 'q'.repeat(256)
  expect(researchQuestions([{ id, ...question }], testResearchLimits)).toEqual([{ id, ...question }])
  expect(researchConclusions([{ id, ...question }], [{ questionId: id, ...legacyFinding }] as never, [], testResearchLimits)).toMatchObject({ outcome: 'not-needed', findings: [{ questionId: id }] })
  expect(parseSelectedFindings([{ questionId: id, ...findingBody }])).toMatchObject([{ questionId: id }])
  for (const value of ['', '   ', 'x'.repeat(257), 1, null]) {
    expectIdentifierError(() => researchQuestions([{ id: value, ...question } as never], testResearchLimits), researchQuestionIdMessage, `question ${String(value)}`)
    expectIdentifierError(() => researchQuestions([{ id: 'genre', ...question }, { id: value, ...question } as never], testResearchLimits), researchQuestionIdMessage, `second question ${String(value)}`)
    expectIdentifierError(() => researchConclusions([{ id: 'genre', ...question }], [{ questionId: value, ...legacyFinding } as never], [], testResearchLimits), findingQuestionIdMessage, `finding ${String(value)}`)
    expectIdentifierError(() => parseSelectedFindings([{ questionId: 'genre', ...findingBody }, { questionId: value, ...findingBody }]), findingQuestionIdMessage, `second finding ${String(value)}`)
  }
  expect(() => researchQuestions([], testResearchLimits)).toThrow(z.ZodError)
  expect(() => researchQuestions([{ id: 'genre', ...question, question: '   ' }], testResearchLimits)).toThrow(z.ZodError)
  expect(() => researchConclusions([{ id: 'genre', ...question }], [{ questionId: 'genre', ...legacyFinding, conclusion: '   ' }] as never, [], testResearchLimits)).toThrow(z.ZodError)
})

it('rejects malformed nested research ids from the tools without a raw zod error', async () => {
  const { ctx, actor, execute } = await setup()
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('nested-id-novel'), title: '潮汐城', brief: '守塔人找到了失踪日志。' })
  const novelId = created.id
  const startSchema = ctx.tools.schemas().find(schema => schema.name === 'story_start_research')
  const completeSchema = ctx.tools.schemas().find(schema => schema.name === 'story_complete_research')
  const questions = startSchema?.parameters.properties
  const findings = completeSchema?.parameters.properties
  const questionIdSchema = questions !== null && typeof questions === 'object' && 'questions' in questions ? questions.questions : undefined
  const findingSchema = findings !== null && typeof findings === 'object' && 'findings' in findings ? findings.findings : undefined
  expect(questionIdSchema).toMatchObject({ items: { properties: { id: { type: 'string', description: 'nonblank string of at most 256 characters' } } } })
  expect(findingSchema).toMatchObject({ items: { properties: { questionId: { type: 'string', description: 'nonblank string of at most 256 characters' } } } })
  const read = async (name: string, args: Record<string, unknown>) => {
    const outcome = await execute(name, args)
    if (outcome.isError) throw new Error(`${name} failed: ${outcome.error.message}`)
    return outcome.value
  }
  const refused = async (name: string, args: Record<string, unknown>, label: string) => {
    const text = errorText(await execute(name, args), label)
    expect(text, label).not.toMatch(rawZod)
    return text
  }
  const short = await read('story_start_research', { novelId, requestId: 'nested-short', briefArtifactId: created.brief.id, questions: [{ id: 'genre', ...question }] })
  const plan = z.object({ planId: z.string(), questions: z.array(z.object({ id: z.string() })), result: z.null() }).parse(short)
  expect(plan.questions[0]?.id).toBe('genre')
  for (const [index, value] of (['', '   ', 'x'.repeat(257), 1, null] as const).entries()) {
    const label = `start ${index} ${typeof value === 'string' ? value.length : String(value)}`
    expect(await refused('story_start_research', {
      novelId, requestId: `nested-bad-${index}`, briefArtifactId: created.brief.id,
      questions: [{ id: 'kept', ...question }, { id: value, ...question }],
    }, label)).toBe(`Error: ${researchQuestionIdMessage}`)
    expect(await refused('story_complete_research', {
      novelId, planId: plan.planId, requestId: `nested-finding-${index}`,
      findings: [{ questionId: 'genre', ...findingBody }, { questionId: value, ...findingBody }],
    }, `complete ${index}`)).toBe(`Error: ${findingQuestionIdMessage}`)
  }
  expect(await read('story_get_research', { novelId, planId: plan.planId })).toMatchObject({ planId: plan.planId, result: null })
  expect(await read('story_complete_research', {
    novelId, planId: plan.planId, requestId: 'nested-complete-short', findings: [{ questionId: 'genre', ...findingBody }],
  })).toMatchObject({ planId: plan.planId, outcome: 'not-needed' })
  const longId = 'q'.repeat(256)
  const long = z.object({ planId: z.string(), questions: z.array(z.object({ id: z.string() })) }).parse(await read('story_start_research', {
    novelId, requestId: 'nested-boundary', briefArtifactId: created.brief.id, questions: [{ id: longId, ...question }],
  }))
  expect(long.questions[0]?.id).toBe(longId)
  expect(await read('story_complete_research', {
    novelId, planId: long.planId, requestId: 'nested-complete-boundary', findings: [{ questionId: longId, ...findingBody }],
  })).toMatchObject({ planId: long.planId, outcome: 'not-needed' })
})

it('records friendly nested research id errors in the model-visible tool result', async () => {
  const model = new ScriptedModel((_request, index) => {
    if (index === 0) return call('story_start_research', {
      novelId: `novel_${uuid}`, requestId: 'visible-question', briefArtifactId: artifactId,
      questions: [{ id: '', ...question }, { id: '   ', ...question }],
    })
    if (index === 1) return call('story_complete_research', {
      novelId: `novel_${uuid}`, planId: artifactId, requestId: 'visible-finding',
      findings: [{ questionId: 'x'.repeat(257), ...findingBody }],
    }, 'complete-long')
    if (index === 2) return call('story_start_research', {
      novelId: `novel_${uuid}`, requestId: 'visible-type', briefArtifactId: artifactId,
      questions: [{ id: 1, ...question }],
    }, 'start-number')
    return stop()
  })
  const { agent } = await setup(model)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '记录一个空的研究问题。' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const request = model.requests.at(-1)
  if (request === undefined) throw new Error('The loop did not record a model request')
  const results = request.messages.filter((message): message is ToolResultMessage => message.role === 'tool')
  const texts = results.flatMap(result => result.content.flatMap(block => block.type === 'text' ? [block.text] : []))
  expect(texts).toEqual([
    `Error: ${researchQuestionIdMessage}`,
    `Error: ${findingQuestionIdMessage}`,
    `Error: ${researchQuestionIdMessage}`,
  ])
  expect(texts.join('\n')).not.toMatch(zodDump)
  expect(texts.join('\n')).not.toMatch(rawZod)
  const logged = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
  expect(logged).toEqual(texts)
})

it('names a missing baseArtifactId without treating a valid id as malformed', async () => {
  const { ctx, actor, execute } = await setup(new ScriptedModel(() => stop()), true)
  const created = await ctx.story.createNovel(actor, { requestId: parseRequestId('create-base'), title: '潮汐城', brief: '守塔人。' })
  const outcome = await execute('story_revise', {
    novelId: created.id, briefArtifactId: created.brief.id, requestId: 'revise-missing-base', settingsRoots: ['a1'],
    chapterCount: 1, fromChapter: 1, throughChapter: 1, baseArtifactId: `artifact_${uuid}`, instructions: '改开场。',
  })
  expect(outcome.isError).toBe(false)
  if (outcome.isError) throw new Error(outcome.error.message)
  expect(outcome.value).toMatchObject({ status: 'failed', error: expect.stringContaining('baseArtifactId') })
  const valid = await execute('story_get_novel', { novelId: created.id })
  expect(valid.isError).toBe(false)
})
