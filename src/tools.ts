/** Model-facing writing operations use the calling Session's workspace. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { WritingError, type Actor, type ArtifactId, type NovelId, type NovelView, type RequestId } from './contracts.ts'
import { artifactKinds, parseArtifactId, parseNovelId, parseRequestId } from './contracts.ts'
import { parseAttemptId, parseRunId, type AttemptId, type RunId } from './run-store.ts'
import { findingQuestionIdMessage, researchQuestionIdMessage } from './research.ts'
import type { WritingService } from './service.ts'
import { projectArtifact } from './projection.ts'

const uuidValue = (prefix: string) => `${prefix}_ plus a lowercase UUID, copied exactly from a previous tool result`

/** Model-facing novel id. The schema stays a string; admission owns the format error. */
export const novelIdParameter = { type: 'string', required: true, description: uuidValue('novel') } as const
/** Model-facing run id. The schema stays a string; admission owns the format error. */
export const runIdParameter = { type: 'string', required: true, description: uuidValue('run') } as const
/** Model-facing artifact id, also used for plan, brief and base ids. */
export const artifactIdParameter = { type: 'string', required: true, description: uuidValue('artifact') } as const
/** The current applied head being replaced. */
export const expectedAppliedIdParameter = { type: 'string', required: true, description: `${uuidValue('artifact')} (the current head being replaced)` } as const
/** Model-facing attempt id. */
export const attemptIdParameter = { type: 'string', required: true, description: uuidValue('attempt') } as const
/** Caller idempotency key. Blank and overlong values are invalid. */
export const requestIdParameter = { type: 'string', required: true, description: 'nonblank string of at most 256 characters' } as const

/** Readable invalid-input text for each tool id parameter. */
export const idFormatMessage = {
  novelId: 'novelId must look like novel_<lowercase uuid>',
  runId: 'runId must look like run_<lowercase uuid>',
  artifactId: 'artifactId must look like artifact_<lowercase uuid>',
  planId: 'planId must look like artifact_<lowercase uuid>',
  briefArtifactId: 'briefArtifactId must look like artifact_<lowercase uuid>',
  baseArtifactId: 'baseArtifactId must look like artifact_<lowercase uuid>',
  expectedAppliedId: 'expectedAppliedId must look like artifact_<lowercase uuid>',
  attemptId: 'attemptId must look like attempt_<lowercase uuid>',
  requestId: 'requestId must be a nonblank string of at most 256 characters',
} as const

export type ToolIdParam = keyof typeof idFormatMessage

/**
 * Admit one tool id. Zod failures become invalid-input; every other error is unchanged.
 * @param parse - Existing parser. Valid values keep that parser's result.
 * @param param - Parameter whose message names the real format.
 * @param value - Untrusted tool argument.
 * @returns The identity the parser already accepts.
 */
export function admitToolId<T>(parse: (value: unknown) => T, param: ToolIdParam, value: unknown): T {
  try {
    return parse(value)
  } catch (error) {
    if (error instanceof z.ZodError) throw new WritingError('invalid-input', idFormatMessage[param])
    throw error
  }
}

/** @param value - Untrusted tool novelId. @returns A parsed novel id. */
export function parseToolNovelId(value: unknown): NovelId { return admitToolId(parseNovelId, 'novelId', value) }
/** @param value - Untrusted tool runId. @returns A parsed run id. */
export function parseToolRunId(value: unknown): RunId { return admitToolId(parseRunId, 'runId', value) }
/** @param value - Untrusted tool artifactId. @returns A parsed artifact id. */
export function parseToolArtifactId(value: unknown): ArtifactId { return admitToolId(parseArtifactId, 'artifactId', value) }
/** @param value - Untrusted tool planId. @returns A parsed artifact id. */
export function parseToolPlanId(value: unknown): ArtifactId { return admitToolId(parseArtifactId, 'planId', value) }
/** @param value - Untrusted tool briefArtifactId. @returns A parsed artifact id. */
export function parseToolBriefArtifactId(value: unknown): ArtifactId { return admitToolId(parseArtifactId, 'briefArtifactId', value) }
/** @param value - Untrusted tool baseArtifactId. @returns A parsed artifact id. */
export function parseToolBaseArtifactId(value: unknown): ArtifactId { return admitToolId(parseArtifactId, 'baseArtifactId', value) }
/** @param value - Untrusted tool expectedAppliedId. @returns A parsed artifact id. */
export function parseToolExpectedAppliedId(value: unknown): ArtifactId { return admitToolId(parseArtifactId, 'expectedAppliedId', value) }
/** @param value - Untrusted tool attemptId. @returns A parsed attempt id. */
export function parseToolAttemptId(value: unknown): AttemptId { return admitToolId(parseAttemptId, 'attemptId', value) }
/** @param value - Untrusted tool requestId. @returns A parsed request id. */
export function parseToolRequestId(value: unknown): RequestId { return admitToolId(parseRequestId, 'requestId', value) }

function isIdParam(name: string): name is ToolIdParam {
  return Object.hasOwn(idFormatMessage, name)
}

function admittedIdMessage(name: string): string | undefined {
  if (isIdParam(name)) return idFormatMessage[name]
  if (/^questions\[\d+\]\.id$/.test(name)) return researchQuestionIdMessage
  if (/^findings\[\d+\]\.questionId$/.test(name)) return findingQuestionIdMessage
  return undefined
}

function idTypeError(error: unknown): WritingError | undefined {
  if (!(error instanceof ToolArgsError)) return undefined
  const messages: string[] = []
  for (const violation of error.violations) {
    const name = /^"([^"]+)" must be a string$/.exec(violation)?.[1]
    if (name === undefined) return undefined
    const message = admittedIdMessage(name)
    if (message === undefined) return undefined
    messages.push(message)
  }
  const message = messages[0]
  return message === undefined ? undefined : new WritingError('invalid-input', message)
}

/**
 * defineTool, plus a translation of wrong-type id arguments into the same invalid-input text.
 * Nested questions[].id and findings[].questionId use that rule too.
 * The published schema stays type string. Other failures, including non-Zod errors, are unchanged.
 * @param options - Tool definition.
 * @returns The registered tool definition.
 */
function buildStoryTool(options: never): ToolDefinition {
  const tool = defineTool(options)
  const run = tool.execute.bind(tool)
  tool.execute = async (args, exec) => {
    try {
      return await run(args, exec)
    } catch (error) {
      const translated = idTypeError(error)
      if (translated !== undefined) throw translated
      throw error
    }
  }
  return tool
}

/** Same call-site inference as defineTool, with id type errors translated after schema validation. */
export const defineStoryTool = buildStoryTool as typeof defineTool

/** Shared public metadata for an exact stored artifact version. */
export const artifactProperties = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, enum: artifactKinds },
  revision: { type: 'integer', required: true },
  sha256: { type: 'string', required: true },
  chars: { type: 'integer', required: true },
  bytes: { type: 'integer', required: true },
} as const

function novelValue(novel: NovelView) {
  return { ...novel, briefHistory: [...novel.briefHistory] }
}

const novelOutput = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      title: { type: 'string', required: true },
      workspace: { type: 'string', required: true },
      revision: { type: 'integer', required: true },
      brief: { type: 'object', required: true, additionalProperties: false, properties: artifactProperties },
      briefHistory: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: artifactProperties } },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/**
 * Resolve the actor from the actual Session, never from model arguments.
 * @param ctx - Composed filesystem owner.
 * @param exec - Tool execution with its cancellation signal and admitted agent.
 * @returns Session identity and its canonical workspace display path.
 */
export async function writingActor(ctx: Context, exec: ToolExecution): Promise<Actor> {
  exec.signal.throwIfAborted()
  const session = exec.agent?.session
  if (session === undefined || session.header.cwd === undefined) {
    throw new Error('Writing tools require a Session workspace')
  }
  const workspace = await ctx.fs.resolve('.', { cwd: session.header.cwd, signal: exec.signal })
  return { sessionId: session.id, workspace: workspace.displayPath, signal: exec.signal }
}

/**
 * Register public novel tools; their canonical results enter the normal Session log.
 * @param ctx - Plugin scope owning the tool registrations.
 * @param service - Single writing-service owner for this host.
 * @param previewDirectory - Configured Session-relative version directory.
 */
export function registerWritingTools(ctx: Context, service: WritingService, previewDirectory: string): void {
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_create_novel',
    description: 'Create a novel and save its initial creative brief. Reuse the same requestId only for the same request. Creation does not change the selected novel.',
    parameters: {
      requestId: requestIdParameter,
      title: { type: 'string', required: true },
      brief: { type: 'string', required: true },
    },
    output: novelOutput,
    async execute(args, exec) {
      const actor = await writingActor(ctx, exec)
      exec.signal.throwIfAborted()
      return novelValue(await service.createNovel(actor, { ...args, requestId: parseToolRequestId(args.requestId) }))
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_save_brief',
    description: 'Save a new immutable creative-brief version. Supply the current novel revision as expectedRevision; revision conflicts require rereading before deciding another change. Reuse requestId only for the same request.',
    parameters: {
      novelId: novelIdParameter,
      requestId: requestIdParameter,
      expectedRevision: { type: 'integer', required: true, description: 'Positive current novel revision.' },
      text: { type: 'string', required: true },
    },
    output: novelOutput,
    async execute(args, exec) {
      return novelValue(await service.saveBrief(await writingActor(ctx, exec), {
        ...args, novelId: parseToolNovelId(args.novelId), requestId: parseToolRequestId(args.requestId),
      }))
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_read_artifact',
    description: `Read an exact artifact version in Unicode code-point pages. Follow nextOffset until eof. Explicit limit must be between 1 and ${service.limits.maxReadChars}.`,
    parameters: {
      novelId: novelIdParameter,
      artifactId: artifactIdParameter,
      offset: { type: 'integer', required: true, description: 'Nonnegative Unicode code-point offset.' },
      limit: { type: 'integer', required: true, description: `Positive page length up to ${service.limits.maxReadChars} code points.` },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          novelId: { type: 'string', required: true },
          artifactId: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: artifactKinds },
          revision: { type: 'integer', required: true },
          sha256: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          nextOffset: { type: 'integer', required: true },
          totalChars: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          eof: { type: 'boolean', required: true },
          view: { type: 'string', required: true, enum: ['stored', 'prose', 'feed'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // The host decides the view, not the child. Reviews read prose. A body child on prompt version 7 reads book and
      // chapter outlines as the thin feed and every other artifact as stored text.
      const sessionId = exec.agent?.session.id
      const actor = await writingActor(ctx, exec)
      const novelId = parseToolNovelId(args.novelId)
      const artifactId = parseToolArtifactId(args.artifactId)
      const feedChapter = service.bodyFeedChapter(sessionId)
      const kind = feedChapter === undefined ? undefined : service.getArtifact(actor, { novelId, artifactId }).kind
      const view = service.readsProse(sessionId) ? 'prose'
        : feedChapter !== undefined && (kind === 'book-outline' || kind === 'chapter-outline') ? 'feed' : 'stored'
      return service.readArtifact(actor, {
        ...args, novelId, artifactId, view, ...(view === 'feed' && feedChapter !== undefined ? { feedChapter } : {}),
      })
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_get_novel',
    description: 'Read an owned novel, its current revision and immutable creative-brief history without embedding document text.',
    parameters: { novelId: novelIdParameter },
    output: novelOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return novelValue(service.getNovel(await writingActor(ctx, exec), parseToolNovelId(args.novelId)))
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_list_novels',
    description: 'List novels owned by the current Session workspace. Text remains available through exact artifact reads.',
    parameters: {},
    output: {
      schema: { type: 'array', items: novelOutput.schema },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return service.listNovels(await writingActor(ctx, exec)).map(novelValue)
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_select_novel',
    description: 'Select an existing novel for this Session. Other Sessions retain their selections.',
    parameters: { novelId: novelIdParameter },
    output: novelOutput,
    async execute(args, exec) {
      return novelValue(await service.selectNovel(await writingActor(ctx, exec), parseToolNovelId(args.novelId)))
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_get_selection',
    description: 'Read the novel selected in this Session. Null means no selection; creation does not select a novel.',
    parameters: {},
    output: {
      schema: { oneOf: [novelOutput.schema, { type: 'null' }] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const selected = service.getSelection(await writingActor(ctx, exec))
      return selected === null ? null : novelValue(selected)
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_preview',
    description: 'Open a complete immutable artifact version in the current Session document preview. Requires an exact novelId and artifactId from writing tool results.',
    parameters: {
      novelId: novelIdParameter,
      artifactId: artifactIdParameter,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['story-artifact-preview'] },
          version: { type: 'integer', required: true, enum: [1] },
          novelId: { type: 'string', required: true },
          artifactId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const actor = await writingActor(ctx, exec)
      const novelId = parseToolNovelId(args.novelId)
      const novel = service.getNovel(actor, novelId)
      const artifact = service.getArtifact(actor, { novelId, artifactId: parseToolArtifactId(args.artifactId) })
      const imported = artifact.kind === 'settings-dimension' && service.getSettings(actor, novelId).history.some(item => item.artifact.id === artifact.id && item.origin === 'import')
      return projectArtifact(ctx, exec, actor, novel, artifact, previewDirectory, imported)
    },
  })))
}
