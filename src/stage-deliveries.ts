/** Native file delivery and replayable projection of completed writing stages. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { parseArtifactId, type Actor, type Artifact, type ArtifactId, type NovelId } from './contracts.ts'
import { parseAttemptId, parseRunId, type RunId, type RunStore } from './run-store.ts'
import type { WritingService } from './service.ts'
import { projectArtifact, projectDocument } from './projection.ts'
import { StageOutputSchemas } from './stage-output.ts'
import { writingActor } from './tools.ts'
import { parseStoryStageDeliveries, type StoryStageDeliverySource, type StoryStageDeliveries } from './stage-delivery.ts'

interface DeliveryIdentity { readonly callId: string; readonly runId: string; readonly source: StoryStageDeliverySource }
const projectionKey = 'story-stage-deliveries'
const projectionSchema = z.custom<StoryStageDeliveries>(value => parseStoryStageDeliveries(value) !== undefined, 'Invalid writing-stage delivery projection')

function sourceId(source: StoryStageDeliverySource): string { return source.kind === 'artifact' ? source.artifactId : source.attemptId }
function sameSource(left: StoryStageDeliverySource, right: StoryStageDeliverySource): boolean { return left.kind === right.kind && sourceId(left) === sourceId(right) }
function invocationId(identity: DeliveryIdentity): ToolCallId {
  return brandString<ToolCallId>(['dsh-story-present', 'v1', identity.callId, identity.runId, identity.source.kind, sourceId(identity.source), randomUUID()].map(encodeURIComponent).join('/'))
}
function readIdentity(callId: string): DeliveryIdentity | undefined {
  const parts = callId.split('/')
  if (parts.length !== 7 || parts[0] !== 'dsh-story-present' || parts[1] !== 'v1') return undefined
  try {
    const owner = decodeURIComponent(parts[2]!)
    const runId = parseRunId(decodeURIComponent(parts[3]!))
    const id = decodeURIComponent(parts[5]!)
    if (owner.trim().length === 0 || !z.uuid().safeParse(parts[6]).success) return undefined
    let source: StoryStageDeliverySource
    if (parts[4] === 'artifact') source = { kind: 'artifact', artifactId: parseArtifactId(id) }
    else if (parts[4] === 'rejected-output') source = { kind: 'rejected-output', attemptId: parseAttemptId(id) }
    else return undefined
    return { callId: owner, runId, source }
  } catch (error) {
    if (error instanceof URIError || error instanceof z.ZodError) return undefined
    throw error
  }
}
function deliveryEvent(event: SessionEvent) {
  if (event.type !== 'deliverables/presented') return undefined
  const identity = readIdentity(event.data.callId)
  if (identity === undefined) return undefined
  const file = event.data.files[0]
  if (event.data.files.length !== 1 || file === undefined || file.path.trim().length === 0 || file.description === undefined || file.description.trim().length === 0) {
    throw new Error('Writing-stage delivery requires exactly one described file')
  }
  return { identity, path: file.path, description: file.description, eventSeq: event.seq }
}

/**
 * Register the pure built-in delivery-event fold and its complete Client value.
 * @param ctx - Plugin scope owning the Session projection registration.
 */
export function registerStageDeliveryProjection(ctx: Context): Promise<ProjectionHandle<StoryStageDeliveries>> {
  return ctx.sessionProjections.register({
    key: projectionKey, stateSchema: projectionSchema, stateVersion: 1,
    init: (): StoryStageDeliveries => ({ version: 1, calls: [] }),
    apply(state, event): StoryStageDeliveries {
      const delivery = deliveryEvent(event)
      if (delivery === undefined) return state
      const { identity, ...file } = delivery
      const owner = state.calls.find(call => call.callId === identity.callId)
      const previous = owner?.deliveries.find(entry => entry.runId === identity.runId && sameSource(entry.source, identity.source))
      if (previous !== undefined) {
        if (previous.path !== file.path || previous.description !== file.description) throw new Error('Repeated writing-stage delivery changed its document')
        return state
      }
      const entry = { runId: identity.runId, source: identity.source, ...file }
      return { version: 1, calls: owner === undefined
        ? [...state.calls, { callId: identity.callId, deliveries: [entry] }]
        : state.calls.map(call => call === owner ? { callId: call.callId, deliveries: [...call.deliveries, entry] } : call) }
    },
    wire: { viewSchema: projectionSchema, view: state => state },
  })
}

function artifactDescription(service: WritingService, actor: Actor, artifact: Artifact): string {
  let label: string
  switch (artifact.kind) {
    case 'creative-brief': label = 'Creative brief'; break
    case 'research-plan': label = 'Research plan'; break
    case 'research-evidence': label = 'Research evidence'; break
    case 'settings-dimension': label = `Settings dimension ${StageOutputSchemas.settings.parse(JSON.parse(artifact.text)).dimensionCode}`; break
    case 'settings': label = 'Settings collection'; break
    case 'book-outline': label = 'Book outline'; break
    case 'chapter-outline': label = `Chapter ${StageOutputSchemas['chapter-outline'].parse(JSON.parse(artifact.text)).chapterNumber} outline`; break
    case 'body': label = `Chapter ${StageOutputSchemas.body.parse(JSON.parse(artifact.text)).chapterNumber} body`; break
    case 'continuity': label = `Chapter ${StageOutputSchemas.continuity.parse(JSON.parse(artifact.text)).chapterNumber} continuity`; break
    case 'review': {
      const review = StageOutputSchemas.review.parse(JSON.parse(artifact.text))
      const reviewed = service.getArtifact(actor, { novelId: artifact.novelId, artifactId: review.reviewed.artifactId })
      if (reviewed.kind === 'review') throw new Error('A writing-stage review cannot review another review')
      label = `Review of ${artifactDescription(service, actor, reviewed)}`
      break
    }
    default: { const unsupported: never = artifact.kind; throw new Error(`Unsupported writing artifact: ${unsupported}`) }
  }
  return `${label} · v${artifact.revision}`
}

/** Stage publication awaits native policy, its committed event, and Session durability. */
export class StageDeliveries {
  private readonly pending = new Map<string, Promise<void>>()
  /** @param ctx - Existing native tools, Session store, projection and filesystem services. @param service - Artifact authority. @param runs - Run and raw-output authority. @param directory - Validated relative preview directory. */
  constructor(private readonly ctx: Context, private readonly service: WritingService, private readonly runs: RunStore, private readonly directory: string) {}

  /**
   * Write one direct-generation prompt or raw output into the current Session workspace.
   * @param exec - Owning Story tool execution and cancellation.
   * @param actor - Workspace resolved for that Session.
   * @param runId - Durable writing run.
   * @param attemptId - Prepared attempt that owns this text.
   * @param role - `prompt` is the model-visible request; `output` is the aggregated reply.
   * @param text - Exact UTF-8 text. A second write of the same bytes is accepted.
   * @returns The verified file's display path.
   */
  async writeGenerationAudit(exec: ToolExecution, actor: Actor, runId: RunId, attemptId: string, role: 'prompt' | 'output', text: string): Promise<string> {
    return projectDocument(this.ctx, exec, actor, `${this.directory}/generation-audit/${runId}/${attemptId}/${role}.txt`, text)
  }

  /** @param exec - Actual owning Story tool execution. @param runId - Durable writing run. @param novelId - Run-owned novel. @param artifactId - Exact published version. @returns After its full preview and native delivery are durable. */
  async publishArtifact(exec: ToolExecution, runId: RunId, novelId: NovelId, artifactId: ArtifactId): Promise<void> {
    const identity: DeliveryIdentity = { callId: exec.callId, runId, source: { kind: 'artifact', artifactId } }
    return this.once(exec, identity, async () => {
      const actor = await writingActor(this.ctx, exec)
      if (this.runs.get(actor, runId).novelId !== novelId) throw new Error('Artifact novel does not belong to the writing run')
      const novel = this.service.getNovel(actor, novelId)
      const artifact = this.service.getArtifact(actor, { novelId, artifactId })
      const preview = await projectArtifact(this.ctx, exec, actor, novel, artifact, this.directory)
      await this.present(exec, identity, preview.path, artifactDescription(this.service, actor, artifact))
    })
  }

  private async once(exec: ToolExecution, identity: DeliveryIdentity, publish: () => Promise<void>): Promise<void> {
    exec.signal.throwIfAborted()
    const key = JSON.stringify([exec.agent?.session.id, identity.callId, identity.runId, identity.source.kind, sourceId(identity.source)])
    const previous = this.pending.get(key)
    if (previous !== undefined) return previous
    const result = publish()
    this.pending.set(key, result)
    try { await result } finally { this.pending.delete(key) }
  }

  private async present(exec: ToolExecution, identity: DeliveryIdentity, path: string, description: string): Promise<void> {
    const agent = exec.agent
    if (agent === undefined) throw new Error('Stage delivery requires a Session')
    const session = agent.session
    exec.signal.throwIfAborted()
    if (this.ctx.sessionProjections.snapshot(session).values[projectionKey] === undefined) throw new Error('Writing-stage delivery projection is unavailable')
    const previous = session.ownEvents().map(deliveryEvent).find(entry => entry !== undefined && entry.identity.callId === identity.callId
      && entry.identity.runId === identity.runId && sameSource(entry.identity.source, identity.source))
    if (previous !== undefined) {
      if (previous.path !== path || previous.description !== description) throw new Error('Recorded writing-stage delivery differs from the exact preview')
    } else {
      if (this.ctx.tools.get('present', agent) === undefined) throw new Error('Writing requires the native present tool in this Agent scope')
      const agents = this.ctx.get('agents')
      if (agents === undefined) throw new Error('Stage delivery requires the host agents service')
      const turn = agents.turnBoundaryOf(session)
      if (turn.openTurnStartSeq === null) throw new Error('Stage delivery requires an open turn')
      const callId = invocationId(identity)
      const fromSeq = session.seq
      const presented = await this.ctx.tools.execute({
        calls: [{ type: 'tool-call', id: callId, name: 'present', arguments: JSON.stringify({ files: [{ path, description }] }) }],
        agent, signal: exec.signal,
      })
      const result = presented.results.find(item => item.callId === callId)?.result
      if (result === undefined) throw new Error('Native present returned without its batch result')
      if (result.isError) throw new Error(`Writing-stage presentation failed: ${result.error.message}`, { cause: result.error })
      const events = session.snapshotEvents(fromSeq).filter(event => event.type === 'deliverables/presented' && event.data.callId === callId)
      if (events.length !== 1) throw new Error('Native present returned without its exact committed delivery event')
      const event = events[0]!
      if (event.type !== 'deliverables/presented' || event.data.turn !== turn.lastTurn) throw new Error('Native present recorded a different writing turn')
      const recorded = deliveryEvent(event)
      if (recorded === undefined || recorded.path !== path || recorded.description !== description) throw new Error('Native present recorded a different writing-stage document')
    }
    await this.ctx.sessions.flush(session)
    exec.signal.throwIfAborted()
  }
}
