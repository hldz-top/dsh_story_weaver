/** Native end-to-end writing fixture; generated prose is deterministic test data, not a quality sample. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as SqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WebRuntime, { type WebSearchProvider } from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as Present from '@deepseek-ai/dsh-tool-present'
import { StageDeliveries, registerStageDeliveryProjection } from '../../src/stage-deliveries.ts'
import { z } from 'zod'
import { artifactIdSchema, artifactKinds, novelIdSchema, parseRequestId, requestIdSchema, type Actor, type ArtifactId } from '../../src/contracts.ts'
import { openWritingService } from '../../src/service.ts'
import { openRunStore, type RunExecutionLimits } from '../../src/run-store.ts'
import { WritingRunner, type StartWritingInput } from '../../src/writing-runner.ts'
import { registerWritingTools } from '../../src/tools.ts'
import { registerResearchTools } from '../../src/research-tools.ts'
import { researchNecessitySchema } from '../../src/research-planning.ts'
import { StageOutputSchemas } from '../../src/stage-output.ts'
import { settingsCollectionSchema } from '../../src/manuscript-records.ts'
import { call } from './model.ts'
import { useStageFixture } from './stage-fixture.ts'

const inputRef = z.object({ artifactId: artifactIdSchema, sha256: z.string() })
const promptInput = inputRef.extend({ kind: z.enum(artifactKinds), chars: z.number().int().nonnegative(), view: z.enum(['prose', 'feed']).optional() })
const artifactRef = z.strictObject({ id: artifactIdSchema, kind: z.enum(artifactKinds), revision: z.number().int().positive(), sha256: z.string(), chars: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
const promptData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('research'), novelId: novelIdSchema, briefArtifactId: artifactIdSchema, purpose: z.string(), inputs: z.array(artifactRef), requestId: requestIdSchema, necessity: researchNecessitySchema.optional() }),
  z.object({ kind: z.literal('research-planning'), novelId: novelIdSchema, briefArtifactId: artifactIdSchema, purpose: z.string(), inputs: z.array(artifactRef), requestId: requestIdSchema, outputTarget: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.enum(['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']), novelId: novelIdSchema, inputs: z.array(promptInput), task: z.string(), requirements: z.array(z.string()) }),
  z.object({ kind: z.literal('review-citation-repair'), novelId: novelIdSchema, inputs: z.array(promptInput), items: z.array(z.object({ location: z.string(), claim: z.record(z.string(), z.unknown()), rejected: z.array(z.object({ artifactId: z.string(), quote: z.string(), hostReason: z.string() })) })) }),
])
const taskSchema = z.object({
  revisionInstructions: z.string().optional(), validationError: z.string().nullable().optional(),
  inputRefs: z.array(inputRef), dimensionCode: z.string().optional(), chapterNumber: z.number().int().positive().optional(),
  chapterCount: z.number().int().positive().optional(), sceneIds: z.array(z.string()).optional(),
  obligations: z.array(z.object({ id: z.string(), description: z.string() })).optional(),
  requiredChecks: z.array(z.enum(['completeness', 'consistency', 'obligations', 'continuity', 'length', 'style'])).optional(),
  reviewed: inputRef.optional(), bodyId: artifactIdSchema.optional(),
  measuredWordCount: z.number().nullable().optional(),
  measuredLength: z.object({ status: z.enum(['within-range', 'too-short', 'too-long']), blocking: z.boolean() }).nullable().optional(),
  paragraphs: z.array(z.object({ id: z.string(), sha256: z.string(), text: z.string() })).optional(),
  checklistItems: z.array(z.object({ id: z.string(), statement: z.string() })).optional(),
})
const pageSchema = z.object({
  novelId: novelIdSchema, artifactId: artifactIdSchema, kind: z.enum(artifactKinds), revision: z.number(), sha256: z.string(),
  offset: z.number(), nextOffset: z.number(), totalChars: z.number(), text: z.string(), eof: z.boolean(), view: z.enum(['stored', 'prose', 'feed']),
})

/** Exact source text accumulated only from completed native reader pages. */
export interface WritingFixtureSource { readonly artifactId: ArtifactId; readonly sha256: string; readonly kind: (typeof artifactKinds)[number]; readonly text: string; readonly view?: 'stored' | 'prose' | 'feed'
  /** For a prose read, the exact stored text, looked up by the harness (not visible to the child) so tests can identify the source. */
  readonly stored?: string }
/** One child has independent task, paging and model-request observations. */
export interface WritingFixtureStage {
  readonly sessionId: SessionId
  readonly kind: z.infer<typeof promptData>['kind']
  /** Parsed TASK_DATA envelope, e.g. the research purpose or planning outputTarget. */
  readonly data: z.infer<typeof promptData>
  readonly task: z.infer<typeof taskSchema> | null
  readonly sources: ReadonlyMap<ArtifactId, WritingFixtureSource>
  readonly requestCount: number
  readonly readPages: number
  /** structured_output calls the native tool rejected in this child (schema-level), each followed by an in-turn corrected call. */
  readonly nativeRejections: number
  /** Exact model-visible prompt, including inlined inputs when the stage calls ctx.llm directly. */
  readonly prompt: string
}
/** Optional deterministic interventions affect model output, never bypass native tools or stores. */
export interface WritingFixtureOptions {
  /** Operator-side required-settings bypass (plugin config allowIncompleteSettings). Default true: most fixtures run partial settings. */
  readonly allowIncompleteSettings?: boolean
  readonly backend?: 'json' | 'sqlite'
  readonly maxReadChars?: number
  readonly executionLimits?: Partial<RunExecutionLimits>
  readonly intervene?: (stage: WritingFixtureStage, output: object) => object
  readonly onChildRequest?: (stage: WritingFixtureStage, request: GenerateOptions) => void
  /** Replace a generated candidate/review call with a native model finish, e.g. a malformed structured_output attempt. */
  readonly injectFinish?: (stage: WritingFixtureStage) => FinishReason | undefined
  /** Like a model reading the tool error, resubmit the unmodified value after the native structured_output tool rejects an intervened one. Default: the child fails. */
  readonly correctNativeRejections?: boolean
  /** Awaited before this child's next tool or structured reply. The model signal still aborts the wait. */
  readonly pauseChild?: (stage: WritingFixtureStage) => Promise<void> | void
  /** Replace the offline search provider. Default returns no sources. */
  readonly webSearch?: WebSearchProvider['search']
  /** When false, the host has no web_search or web_fetch registration. Default true. */
  readonly registerWebTools?: boolean
}
interface ChildState extends WritingFixtureStage {
  nativeRejections: number
  readonly sources: Map<ArtifactId, WritingFixtureSource>
  requestCount: number
  readPages: number
  inputIndex: number
  offset: number
  text: string
  researchPhase: number
  planId: ArtifactId | null
  pending: { readonly callId: string; readonly name: string } | null
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Writing fixture task is missing ${label}`)
  return value
}

function promptText(request: GenerateOptions): string {
  const marker = '\n\nTASK_DATA\n\n'
  const prompts = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' && block.text.includes(marker) ? [block.text] : []))
  if (prompts.length !== 1) throw new Error('Native writing child must have exactly one logged TASK_DATA prompt')
  return prompts[0]!
}

function taskBody(prompt: string): string {
  const marker = '\n\nTASK_DATA\n\n'
  const body = prompt.slice(prompt.indexOf(marker) + marker.length)
  const end = body.indexOf('\n\nHOST_INPUTS\n\n')
  return end < 0 ? body : body.slice(0, end)
}

function readTask(request: GenerateOptions): z.infer<typeof promptData> {
  return promptData.parse(JSON.parse(taskBody(promptText(request))))
}

function pendingResult(request: GenerateOptions, callId: string): unknown {
  const result = request.messages.findLast(message => message.role === 'tool' && message.toolCallId === callId)
  if (result?.role !== 'tool' || result.isError !== false || result.content.length !== 1 || result.content[0]?.type !== 'text') {
    const reason = result?.role === 'tool' ? result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : 'Missing logged result'
    throw new Error(`Native writing fixture call ${callId} failed: ${reason}`)
  }
  return JSON.parse(result.content[0].text) as unknown
}

function inputs(state: ChildState) {
  return (state.data.kind === 'research' || state.data.kind === 'research-planning')
    ? state.data.inputs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256, kind: ref.kind, chars: ref.chars, revision: ref.revision, view: undefined as 'prose' | undefined }))
    : state.data.inputs.map(ref => ({ ...ref, revision: null, view: ref.view }))
}

function consume(state: ChildState, request: GenerateOptions, correctNativeRejections: boolean, storedText: (id: ArtifactId) => string): void {
  if (state.pending === null) return
  if (state.pending.name === 'structured_output' && correctNativeRejections) {
    // Only a native rejection continues the turn; like a model reading the tool error, resubmit the unmodified value in the same turn.
    const result = request.messages.findLast(message => message.role === 'tool' && message.toolCallId === state.pending?.callId)
    if (result?.role !== 'tool' || result.isError !== true) throw new Error('Structured output continued without a native rejection')
    state.nativeRejections += 1
    state.pending = null
    return
  }
  const value = pendingResult(request, state.pending.callId)
  if (state.pending.name === 'story_read_artifact') {
    const page = pageSchema.parse(value)
    const ref = required(inputs(state)[state.inputIndex], 'current input')
    if (page.novelId !== state.data.novelId || page.artifactId !== ref.artifactId || page.sha256 !== ref.sha256 || page.kind !== ref.kind
      || page.totalChars !== ref.chars || (ref.revision !== null && page.revision !== ref.revision) || page.offset !== state.offset
      || page.nextOffset !== page.offset + [...page.text].length || page.nextOffset > page.totalChars
      || page.eof !== (page.nextOffset === page.totalChars) || (!page.eof && page.nextOffset <= page.offset)) throw new Error('Native artifact page differs from the exact requested source')
    state.readPages += 1
    state.text += page.text
    state.offset = page.nextOffset
    if (page.view !== (ref.view ?? 'stored')) throw new Error(`Native artifact page view ${page.view} differs from the announced input view`)
    if (page.eof) {
      // A prose view is derived text: sha256 identifies the stored version it was derived from, not the served text.
      if (page.view === 'stored' && createHash('sha256').update(state.text).digest('hex') !== ref.sha256) throw new Error('Completed native input pages do not match the source digest')
      state.sources.set(ref.artifactId, { artifactId: ref.artifactId, sha256: ref.sha256, kind: ref.kind, text: state.text, view: page.view, ...(page.view === 'prose' ? { stored: storedText(ref.artifactId) } : {}) })
      state.inputIndex += 1
      state.offset = 0
      state.text = ''
    }
  } else if (state.pending.name === 'story_start_research') {
    state.planId = z.object({ planId: artifactIdSchema }).parse(value).planId
    state.researchPhase = 1
  } else if (state.pending.name === 'story_research_results') {
    z.array(z.unknown()).length(0).parse(value)
    state.researchPhase = 2
  } else if (state.pending.name === 'story_complete_research') {
    z.object({ outcome: z.literal('not-needed'), result: artifactRef }).parse(value)
    state.researchPhase = 3
  } else if (state.pending.name === 'story_get_research') {
    const plan = z.object({ planId: artifactIdSchema, outcome: z.literal('not-needed'), stale: z.literal(false), result: artifactRef }).parse(value)
    if (plan.planId !== state.planId) throw new Error('Research readback selected a different plan')
    state.researchPhase = 4
  }
  state.pending = null
}

function source(state: ChildState, id: ArtifactId): WritingFixtureSource {
  const result = state.sources.get(id)
  if (result === undefined) throw new Error('Fixture generation attempted to use an unread input')
  return result
}

function quoteCandidate(candidate: WritingFixtureSource): string {
  // Served as reader-facing prose: quote the start of its first prose line, as a model reading plain text would.
  if (candidate.view === 'prose') return candidate.text.split('\n').find(line => line.trim().length > 0)!.slice(0, 100)
  const value: unknown = JSON.parse(candidate.text)
  switch (candidate.kind) {
    case 'settings-dimension': return StageOutputSchemas.settings.parse(value).facts[0]!.statement
    case 'settings': return settingsCollectionSchema.parse(value).dimensions[0]!.facts[0]!.statement
    case 'book-outline': return StageOutputSchemas['book-outline'].parse(value).ending
    case 'chapter-outline': return StageOutputSchemas['chapter-outline'].parse(value).throughLine
    case 'body': return StageOutputSchemas.body.parse(value).scenes[0]!.text.slice(0, 100)
    case 'continuity': return StageOutputSchemas.continuity.parse(value).summary
    case 'continuity-snapshot': return StageOutputSchemas['continuity-snapshot'].parse(value).characterStatus[0]?.status ?? StageOutputSchemas['continuity-snapshot'].parse(value).usedPlotBridges[0]?.note ?? 'snapshot'
    default: throw new Error(`Unsupported fixture review target: ${candidate.kind}`)
  }
}

function generate(state: ChildState): object {
  const task = state.task
  if (task === null || (state.data.kind === 'research' || state.data.kind === 'research-planning' || state.data.kind === 'review-citation-repair')) throw new Error('Research output uses its actual native plan')
  for (const ref of task.inputRefs) if (source(state, ref.artifactId).sha256 !== ref.sha256) throw new Error('Fixture stage task references unread or changed input')
  const base = { version: 1, inputRefs: task.inputRefs }
  const revision = task.revisionInstructions === undefined ? '' : `修订要求：${task.revisionInstructions}`
  switch (state.data.kind) {
    case 'settings': {
      const dimensionCode = required(task.dimensionCode, 'dimensionCode')
      return { ...base, dimensionCode, facts: [{ id: `fixture-${dimensionCode}`, statement: `本书是一部发生在虚构雾港的悬疑冒险小说。${revision}` }], contentMarkdown: `# 雾港故事设定\n\n守灯人林澜在雾港追查失踪船只，以已知的航标信号寻找线索。${revision}` }
    }
    case 'book-outline': {
      // Versions before 7 publish a schema that requires targetWords and inject the acceptance range as a planning budget.
      const planWords = state.data.requirements.some(item => item.includes('chapter-total range'))
      return { ...base, contentMarkdown: `# 雾港航标\n\n林澜逐章查明航标的秘密，最终护送船队返航。${revision}`, ending: '林澜重燃港口灯塔，让船队安全返航。', characterArcs: [{ character: '林澜', development: '从独自怀疑转向依据证据与同伴合作。' }],
        chapters: Array.from({ length: required(task.chapterCount, 'chapterCount') }, (_, index) => ({ chapterNumber: index + 1, title: `第${index + 1}章 雾港航标`, purpose: `林澜查明第${index + 1}处航标并记录证据。`, ...(planWords ? { targetWords: 4000 } : {}), obligations: [{ id: `signal-${index + 1}`, description: `林澜查明第${index + 1}处航标并记录证据。` }] })) }
    }
    case 'chapter-outline': {
      const chapterNumber = required(task.chapterNumber, 'chapterNumber')
      const obligations = required(task.obligations, 'obligations')
      const planWords = state.data.requirements.some(item => item.includes('chapter-total range'))
      return { ...base, chapterNumber, title: `第${chapterNumber}章 雾港航标`, ...(planWords ? { targetWords: 4000 } : {}), throughLine: `林澜走向第${chapterNumber}处航标，确认灯光信号并帮助船只返航。${revision}`, constraints: ['保持林澜已知的信息边界。'], obligations,
        scenes: [{ id: `chapter-${chapterNumber}-scene-1`, purpose: '在雾中确认航道并记录证据。', action: obligations.map(item => item.description).join(''), obligationIds: obligations.map(item => item.id) }] }
    }
    case 'body': {
      const chapterNumber = required(task.chapterNumber, 'chapterNumber')
      const sceneIds = required(task.sceneIds, 'sceneIds')
      if (sceneIds.length === 0) throw new Error('Body fixture requires an actual scene plan')
      const sentence = '林澜沿着潮湿的石阶走向灯塔，仔细辨认海面上的每一道光，确认航道安全后才向岸边的同伴发出信号。'
      return { ...base, chapterNumber, scenes: sceneIds.map((sceneId, index) => ({ sceneId, text: `林澜在第${chapterNumber}章继续调查雾港。${index === 0 ? required(task.obligations, 'obligations').map(item => item.description).join('') : ''}${sentence.repeat(Math.floor(80 / sceneIds.length) + (index < 80 % sceneIds.length ? 1 : 0))}林澜把确认过的航标记入日志，与同伴一起守住归航的灯光。` })) }
    }
    case 'review': {
      const reviewed = required(task.reviewed, 'reviewed')
      if (task.checklistItems !== undefined) return { ...base, reviewed, items: task.checklistItems.map(item => ({ id: item.id, status: 'pass' as const })) }
      const evidence = task.paragraphs !== undefined && task.paragraphs.length > 0
        ? [{ paragraphId: task.paragraphs[0]!.id, problem: 'The cited paragraph is the candidate passage this check covers.' }]
        : [{ artifactId: reviewed.artifactId, quote: quoteCandidate(source(state, reviewed.artifactId)) }]
      const checks = required(task.requiredChecks, 'requiredChecks').map(category => ({ category, summary: category === 'length' ? `Host word count ${task.measuredWordCount}; ${task.measuredLength?.status}.` : `The exact candidate was read for the required ${category} check.`, evidence }))
      const issues = task.measuredLength?.blocking === true ? [{ id: 'fixture-length', severity: 'blocking', category: 'length', location: 'Complete chapter', message: 'The host measured this body outside the required chapter-total range.', evidence }] : []
      return { ...base, reviewed, checks, issues }
    }
    case 'continuity': {
      const bodyId = required(task.bodyId, 'bodyId')
      const body = StageOutputSchemas.body.parse(JSON.parse(source(state, bodyId).text))
      const chapterNumber = required(task.chapterNumber, 'chapterNumber')
      if (body.chapterNumber !== chapterNumber) throw new Error('Continuity fixture must read this chapter body')
      const evidence = [{ artifactId: bodyId, quote: body.scenes[0]!.text.slice(0, 100) }]
      const priorSource = [...state.sources.values()].find(item => item.kind === 'continuity')
      const prior = priorSource === undefined ? null : StageOutputSchemas.continuity.parse(JSON.parse(priorSource.text))
      const inheritedTimeline = prior === null || priorSource === undefined ? [] : prior.timeline.map(event => ({ event: event.event, evidence: [{ artifactId: priorSource.artifactId, quote: event.event }] }))
      const characters = prior === null ? [] : prior.characters.filter(character => character.name !== '林澜')
      return { ...base, chapterNumber, summary: `第${chapterNumber}章结束时，林澜已核实航标并把证据写入日志。`, characters: [...characters, { name: '林澜', state: `已完成第${chapterNumber}处航标的核查，仍在雾港与同伴守灯。` }],
        timeline: [...inheritedTimeline, { event: `林澜完成第${chapterNumber}处航标调查。`, evidence }], obligations: required(task.obligations, 'obligations').map(item => ({ id: item.id, status: 'fulfilled', explanation: item.description, evidence })) }
    }
    case 'continuity-snapshot': {
      const chapterNumber = required(task.chapterNumber, 'chapterNumber')
      return { ...base, chapterNumber, characterStatus: [{ name: '林澜', status: `已完成第${chapterNumber}处航标核查。` }], unrecoveredForeshadowing: [], usedPlotBridges: [{ note: `第${chapterNumber}章使用了航标信号。` }] }
    }
  }
}

/**
 * Compose native children, real stores and deterministic model replies for the complete writing run.
 * @param options - Storage variant, page size and explicit model-response interventions.
 * @returns The parent driver, runner, service, stores, exact initial request and per-child observations.
 */
export async function useWritingFixture(options: WritingFixtureOptions = {}) {
  const stages = new Map<SessionId, ChildState>()
  // Bound once the service and novel exist; children only run after that.
  let storedText: ((id: ArtifactId) => string) | undefined
  const maxReadChars = options.maxReadChars ?? 512
  const fixture = await useStageFixture(async request => {
    if (request.purpose === 'story-writing-stage') {
      const sessionId = required(request.sessionId, 'direct generation id')
      const prompt = promptText(request)
      const data = readTask(request)
      const hostedJson = prompt.split('\n\nHOST_INPUTS\n\n')[1]?.split('\n\nOUTPUT_SCHEMA\n\n')[0]
      if (hostedJson === undefined) throw new Error('Direct writing request has no HOST_INPUTS')
      const hosted = z.array(z.object({
        artifactId: artifactIdSchema, sha256: z.string(), kind: z.enum(artifactKinds), view: z.enum(['stored', 'prose', 'feed']), text: z.string(),
      })).parse(JSON.parse(hostedJson))
      const state: ChildState = {
        sessionId, data, kind: data.kind, prompt,
        task: data.kind === 'research' || data.kind === 'research-planning' || data.kind === 'review-citation-repair' ? null : taskSchema.parse(JSON.parse(data.task)),
        sources: new Map(), requestCount: 1, readPages: 0, inputIndex: hosted.length, offset: 0, text: '', researchPhase: 0, planId: null, pending: null, nativeRejections: 0,
      }
      for (const input of hosted) {
        state.sources.set(input.artifactId, { artifactId: input.artifactId, sha256: input.sha256, kind: input.kind, text: input.text, view: input.view, ...(input.view === 'prose' ? { stored: required(storedText, 'stored text lookup')(input.artifactId) } : {}) })
      }
      stages.set(sessionId, state)
      options.onChildRequest?.(state, request)
      if (options.pauseChild !== undefined) await options.pauseChild(state)
      const injected = options.injectFinish?.(state)
      if (injected !== undefined) return [{ type: 'finish' as const, reason: injected }]
      let output: object
      if (state.data.kind === 'research-planning') {
        output = { mode: 'input-only', reason: 'The supplied premise defines this fictional output.', questions: [{ id: 'fixture-fiction', kind: 'creative', question: state.data.purpose, reason: 'This fixture is wholly fictional; its supplied story rules are authorial choices.' }], externalRequirements: [] }
      } else if (state.data.kind === 'research' || state.data.kind === 'review-citation-repair') {
        throw new Error('A tool stage cannot use the direct model path')
      } else output = generate(state)
      if (options.intervene !== undefined && state.nativeRejections === 0) output = options.intervene(state, output)
      const json = JSON.stringify(output)
      const mid = Math.max(1, Math.ceil(json.length / 2))
      return [
        { type: 'block-start' as const, index: 0, blockType: 'text' as const },
        { type: 'text-delta' as const, index: 0, text: json.slice(0, mid) },
        { type: 'text-delta' as const, index: 0, text: json.slice(mid) },
        { type: 'finish' as const, reason: { kind: 'stop' as const } },
      ]
    }
    const sessionId = required(request.sessionId, 'native child Session ID')
    let state = stages.get(sessionId)
    if (state === undefined) {
      const data = readTask(request)
      state = { sessionId, data, kind: data.kind, task: data.kind === 'research' || data.kind === 'research-planning' || data.kind === 'review-citation-repair' ? null : taskSchema.parse(JSON.parse(data.task)), sources: new Map(), requestCount: 0, readPages: 0, inputIndex: 0, offset: 0, text: '', researchPhase: 0, planId: null, pending: null, nativeRejections: 0, prompt: promptText(request) }
      stages.set(sessionId, state)
    }
    state.requestCount += 1
    consume(state, request, options.correctNativeRejections === true, id => required(storedText, 'stored text lookup')(id))
    options.onChildRequest?.(state, request)
    if (options.pauseChild !== undefined) await options.pauseChild(state)
    const emit = (name: string, args: object) => {
      const callId = `${name}-${state.requestCount}`
      state.pending = { callId, name }
      return call(name, args, callId)
    }
    const ref = inputs(state)[state.inputIndex]
    if (ref !== undefined) return emit('story_read_artifact', { novelId: state.data.novelId, artifactId: ref.artifactId, offset: state.offset, limit: maxReadChars })
    if (state.data.kind === 'research-planning') {
      const output = { mode: 'input-only', reason: 'The supplied premise defines this fictional output.', questions: [{ id: 'fixture-fiction', kind: 'creative', question: state.data.purpose, reason: 'This fixture is wholly fictional; its supplied story rules are authorial choices.' }], externalRequirements: [] }
      return emit('structured_output', options.intervene === undefined || state.nativeRejections > 0 ? output : options.intervene(state, output))
    }
    if (state.data.kind === 'research') {
      const data = state.data
      if (state.researchPhase === 0) return emit('story_start_research', { novelId: data.novelId, briefArtifactId: data.briefArtifactId, requestId: data.requestId, questions: data.necessity?.questions ?? [{ id: 'fixture-fiction', kind: 'creative', question: data.purpose, reason: 'This fixture is wholly fictional; its supplied story rules are authorial choices.' }] })
      if (state.planId === null) throw new Error('Research stage has no actual native plan')
      if (state.researchPhase === 1) return emit('story_research_results', { novelId: data.novelId, planId: state.planId })
      if (state.researchPhase === 2) return emit('story_complete_research', { novelId: data.novelId, planId: state.planId, requestId: data.requestId, findings: [{ questionId: 'fixture-fiction', callIds: [], selections: [], conclusion: `Preserve the fictional premise: ${source(state, data.briefArtifactId).text}`, adequate: true }] })
      if (state.researchPhase === 3) return emit('story_get_research', { novelId: data.novelId, planId: state.planId })
      const output = { planId: state.planId }
      return emit('structured_output', options.intervene === undefined || state.nativeRejections > 0 ? output : options.intervene(state, output))
    }
    if (state.data.kind === 'review-citation-repair') {
      // Like a model copying from the reviewed candidate (the last listed input): one exact excerpt per listed item.
      const reviewed = required(state.data.inputs.at(-1), 'reviewed candidate input')
      const output = { version: 1, items: state.data.items.map(item => ({ location: item.location, evidence: [{ artifactId: reviewed.artifactId, quote: quoteCandidate(source(state, reviewed.artifactId)) }] })) }
      return emit('structured_output', options.intervene === undefined || state.nativeRejections > 0 ? output : options.intervene(state, output))
    }
    const injected = options.injectFinish?.(state)
    if (injected !== undefined) return [{ type: 'finish', reason: injected }]
    const output = generate(state)
    return emit('structured_output', options.intervene === undefined || state.nativeRejections > 0 ? output : options.intervene(state, output))
  })
  const backend = options.backend ?? 'json'
  await fixture.ctx.plugin(Storage)
  if (backend === 'json') await fixture.ctx.plugin(JsonStorage, { root: join(fixture.root, 'storage') })
  else await fixture.ctx.plugin(SqliteStorage, { path: join(fixture.root, 'storage.sqlite'), journalMode: 'wal' })
  await fixture.ctx.plugin(DomainStorage, { backend })
  await fixture.ctx.plugin(LocalFileSystem, { cwd: fixture.root })
  if (options.registerWebTools !== false) {
    await fixture.ctx.plugin(WebRuntime, { searchProvider: 'writing-fixture-search', fetchProvider: 'writing-fixture-fetch' })
    fixture.ctx.effect(() => fixture.ctx.web.registerSearchProvider({ id: 'writing-fixture-search', available: () => true, search: options.webSearch ?? (async () => ({ sources: [], truncated: false })) }))
    fixture.ctx.effect(() => fixture.ctx.web.registerFetchProvider({ id: 'writing-fixture-fetch', available: () => true, fetch: async request => ({ url: request.url, statusCode: 200, body: { kind: 'text', content: 'Offline fixture reference.' }, truncated: false }) }))
    await fixture.ctx.plugin(ToolWeb, { searchMaxQueries: 4, searchMaxResults: 8, searchTimeoutMs: 5000, fetchTimeoutMs: 5000, fetchMaxOutputChars: 10000 })
  }
  await fixture.ctx.plugin(Present, new Present.Config())
  await registerStageDeliveryProjection(fixture.ctx)
  const executionLimits: RunExecutionLimits = { stageProvider: 'stage-spawn', maxDelegationDepth: 2, maxStageRequests: 100, stageTimeoutMs: 10_000, maxParallelStages: 2, settingsCandidateCount: 1, maxRepairAttempts: 1, minChapterWords: 3000, maxChapterWords: 5000, researchEnabled: true, researchBudgetFloor: 1, ...options.executionLimits }
  const service = await openWritingService(fixture.ctx.storageDomain, { maxArtifactBytes: 262_144, maxReadChars }, { maxResearchQuestions: 12, maxResearchCalls: 4, maxResearchSources: 8, maxEvidenceChars: 8192, maxResearchLogEvents: 2048 }, executionLimits)
  fixture.ctx.effect(() => () => service.close())
  const runs = await openRunStore(fixture.ctx.storageDomain, { maxAttempts: 256, maxOutputBytes: 262_144 })
  fixture.ctx.effect(() => () => runs.close())
  registerWritingTools(fixture.ctx, service, '.dsh-story')
  registerResearchTools(fixture.ctx, service)
  const runner = new WritingRunner(fixture.ctx, service, runs, executionLimits, new StageDeliveries(fixture.ctx, service, runs, '.dsh-story'), { allowIncompleteSettings: options.allowIncompleteSettings ?? true })
  fixture.ctx.effect(() => () => runner.close())
  const workspace = await fixture.ctx.fs.resolve('.', { cwd: fixture.root })
  const actor: Actor = { sessionId: fixture.parent.session.id, workspace: workspace.displayPath }
  const novel = await service.createNovel(actor, { requestId: parseRequestId('writing-fixture-novel'), title: '雾港航标', brief: '守灯人林澜在虚构雾港追查失踪船只。请完成三章故事，每章三千至五千字。' })
  storedText = id => service.getArtifact(actor, { novelId: novel.id, artifactId: id }).text
  const input: StartWritingInput = { novelId: novel.id, briefArtifactId: novel.brief.id, requestId: parseRequestId('writing-fixture-run'), settingsRoots: ['a1'], chapterCount: 3, fromChapter: 1, throughChapter: 3, mode: 'write' }
  return { ...fixture, service, runs, runner, actor, novel, input, stages: stages as ReadonlyMap<SessionId, WritingFixtureStage> }
}
