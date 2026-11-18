import { once } from 'node:events'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolPresent from '@deepseek-ai/dsh-tool-present'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { artifactMarkdown } from '../src/artifact-markdown.ts'
import { parseRequestId } from '../src/contracts.ts'
import { openWritingService } from '../src/service.ts'
import { openRunStore } from '../src/run-store.ts'
import { StageDeliveries, registerStageDeliveryProjection } from '../src/stage-deliveries.ts'
import { useStageFixture } from './support/stage-fixture.ts'
import { testManuscriptLimits, testResearchLimits } from './support/storage.ts'
import { stop } from './support/model.ts'

async function setup(reply = () => stop()) {
  const fixture = await useStageFixture(reply)
  const { ctx, root } = fixture
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const presentPlugin = await ctx.plugin(ToolPresent, { maxFiles: 1 })
  const service = await openWritingService(ctx.storageDomain, { maxArtifactBytes: 200_000, maxReadChars: 512 }, testResearchLimits, testManuscriptLimits)
  ctx.effect(() => () => service.close())
  const runs = await openRunStore(ctx.storageDomain, { maxAttempts: 40, maxOutputBytes: 200_000 })
  ctx.effect(() => () => runs.close())
  await registerStageDeliveryProjection(ctx)
  const publisher = new StageDeliveries(ctx, service, runs, '.dsh-story')
  const workspace = await ctx.fs.resolve('.', { cwd: root })
  const actor = { sessionId: fixture.parent.session.id, workspace: workspace.displayPath }
  const novel = await service.createNovel(actor, { requestId: parseRequestId('delivery-novel'), title: 'Lighthouse', brief: 'Full chapter source.\n'.repeat(3000) + 'EXACT END' })
  const run = await runs.begin(actor, {
    novelId: novel.id, briefArtifactId: novel.brief.id, requestId: parseRequestId('delivery-run'),
    settingsRoots: ['a1'], chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write', revision: null,
    serviceLimits: { ...service.limits, ...service.researchLimits },
    executionLimits: { stageProvider: 'stage-spawn', maxDelegationDepth: 2, maxStageRequests: 10, stageTimeoutMs: 5000,
      maxParallelStages: 2, maxRepairAttempts: 1, minChapterWords: 3000, maxChapterWords: 5000 },
  })
  return { ...fixture, service, runs, publisher, actor, novel, writingRun: run, presentPlugin }
}

it('publishes a complete immutable version and durable native delivery before the parent tool settles', async () => {
  const fixture = await setup()
  const { ctx, parent, publisher, writingRun: run, novel, service, actor } = fixture
  const outcome = await fixture.run(async exec => {
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    const projection = ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']
    expect(projection?.calls).toHaveLength(1)
    const delivery = projection!.calls[0]!.deliveries[0]!
    expect(projection!.calls[0]!.callId).toBe(exec.callId)
    expect(delivery).toMatchObject({ runId: run.id, source: { kind: 'artifact', artifactId: novel.brief.id }, description: 'Creative brief · v1' })
    expect(await readFile(delivery.path, 'utf8')).toBe(service.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text)
    const handle = await ctx.sessionPersistence.open(parent.session.id, 'read')
    try {
      const { events } = await handle.read()
      expect(events.some(event => event.type === 'tool/result' && event.data.message.source.callId === exec.callId)).toBe(false)
      expect(events.filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      const replay = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), handle.header, SessionLogOffset(0))
      expect(replay.snapshot.values['story-stage-deliveries']).toEqual(projection)
    } finally { await handle.close() }
  })
  expect(outcome.status).toBe('fulfilled')
  if (outcome.status === 'rejected') throw outcome.reason
})

it('deduplicates concurrent requests and reconstruction while preserving distinct immutable versions', async () => {
  const fixture = await setup()
  const { ctx, parent, publisher, writingRun: run, novel, service, actor, runs } = fixture
  const revised = await service.saveBrief(actor, { novelId: novel.id, requestId: parseRequestId('delivery-revision'), expectedRevision: 1, text: 'Second exact version.' })
  const outcome = await fixture.run(async exec => {
    await Promise.all([
      publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id),
      publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id),
      publisher.publishArtifact(exec, run.id, novel.id, revised.brief.id),
    ])
    const before = ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!
    expect(before.calls[0]!.deliveries).toHaveLength(2)
    const original = before.calls[0]!.deliveries.find(entry => entry.source.kind === 'artifact' && entry.source.artifactId === novel.brief.id)!
    await rm(original.path)
    const reconstructed = new StageDeliveries(ctx, service, runs, '.dsh-story')
    await reconstructed.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    expect(await readFile(original.path, 'utf8')).toContain('EXACT END')
    expect(ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']).toEqual(before)
    expect(parent.session.ownEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(2)
  })
  if (outcome.status === 'rejected') throw outcome.reason
})

it('keeps a user-edited stage file and presents a separate current projection', async () => {
  const fixture = await setup()
  const { ctx, parent, publisher, writingRun: run, novel, service, actor } = fixture
  const outcome = await fixture.run(async exec => {
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    const initial = ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!
    const path = initial.calls[0]!.deliveries[0]!.path
    await writeFile(path, 'User edit.', 'utf8')
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    expect(await readFile(path, 'utf8')).toBe('User edit.')
    const delivered = ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!
    const current = delivered.calls[0]!.deliveries[0]!
    expect(current.path).not.toBe(path)
    expect(await readFile(current.path, 'utf8')).toBe(service.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text)
    expect(service.getNovel(actor, novel.id)).toEqual(novel)
    expect(service.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).sha256).toBe(novel.brief.sha256)
    const handle = await ctx.sessionPersistence.open(parent.session.id, 'read')
    try {
      const { events } = await handle.read()
      const replay = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), handle.header, SessionLogOffset(0))
      expect(replay.snapshot.values['story-stage-deliveries']).toEqual(delivered)
    } finally { await handle.close() }
  })
  if (outcome.status === 'rejected') throw outcome.reason
})

it('does not present again after the current path is recorded, and keeps both edited preview files', async () => {
  const fixture = await setup()
  const { parent, publisher, writingRun: run, novel, service, actor } = fixture
  const brief = service.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text
  const activity = () => {
    const events = parent.session.ownEvents()
    return {
      events: events.length,
      presented: events.filter(event => event.type === 'deliverables/presented').length,
      // Nested present is recorded as deliverables/presented (dsh-tool-present tools/result), not as a parent tool/call named present.
      presentCalls: events.filter(event => event.type === 'tool/call' && event.data.name === 'present').length,
    }
  }
  const outcome = await fixture.run(async exec => {
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    const original = fixture.ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!.calls[0]!.deliveries[0]!.path
    await writeFile(original, 'User edit.', 'utf8')
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    const current = fixture.ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!.calls[0]!.deliveries[0]!.path
    expect(current).toMatch(/\.current\.md$/)
    await writeFile(current, 'Edited current.', 'utf8')
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    const moved = fixture.ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!.calls[0]!.deliveries[0]!.path
    expect(moved).toMatch(/\.current-2\.md$/)
    expect(await readFile(original, 'utf8')).toBe('User edit.')
    expect(await readFile(current, 'utf8')).toBe('Edited current.')
    expect(await readFile(moved, 'utf8')).toBe(brief)
    const afterMove = activity()
    expect(afterMove.presented).toBe(3)
    expect(afterMove.presentCalls).toBe(0)
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    await publisher.publishArtifact(exec, run.id, novel.id, novel.brief.id)
    expect(activity()).toEqual(afterMove)
    expect(fixture.ctx.sessionProjections.snapshot(parent.session).values['story-stage-deliveries']!.calls[0]!.deliveries[0]!.path).toBe(moved)
    expect(service.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).text).toBe(brief)
    expect(service.getArtifact(actor, { novelId: novel.id, artifactId: novel.brief.id }).sha256).toBe(novel.brief.sha256)
  })
  if (outcome.status === 'rejected') throw outcome.reason
})

it('replaces an unmodified 0.2.1 stage preview with specification ids', async () => {
  const fixture = await setup()
  const { publisher, writingRun: run, novel, service, actor } = fixture
  const plan = await service.startResearch(actor, { novelId: novel.id, requestId: parseRequestId('stage-research'), briefArtifactId: novel.brief.id,
    questions: [{ id: 'genre', kind: 'creative', question: 'Choose a genre', reason: 'An authorial decision' }] }, 0)
  const evidence = await service.completeSelectedResearch(actor, { novelId: novel.id, planId: plan.planId, requestId: parseRequestId('stage-evidence'),
    findings: [{ questionId: 'genre', callIds: [], selections: [], conclusion: 'Use a fictional mystery', adequate: true }] }, [])
  if (evidence.result === null) throw new Error('Expected completed research')
  const inputRefs = [novel.brief, evidence.result].map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
  const output = { version: 1 as const, dimensionCode: 'a1', inputRefs, facts: [{ id: 'genre-main', statement: 'The story is a mystery.' }], contentMarkdown: '# Genre\nMystery.' }
  const candidate = await service.saveSettingsCandidate(actor, { novelId: novel.id, requestId: parseRequestId('stage-candidate'),
    dimensionCode: 'a1', researchPlanId: plan.planId, output, childSessionId: brandString<SessionId>('stage-child') })
  const stored = service.getArtifact(actor, { novelId: novel.id, artifactId: candidate.artifact.id })
  const file = join(actor.workspace, '.dsh-story', novel.id, `${stored.id}.md`)
  await mkdir(join(actor.workspace, '.dsh-story', novel.id), { recursive: true })
  await writeFile(file, artifactMarkdown(stored), 'utf8')
  const outcome = await fixture.run(async exec => {
    await publisher.publishArtifact(exec, run.id, novel.id, stored.id)
    expect(await readFile(file, 'utf8')).toContain('Input 1 ID:')
    expect(await readFile(file, 'utf8')).not.toContain('Input 1 SHA-256:')
    expect(await readFile(file, 'utf8')).toContain(`Artifact SHA-256: ${stored.sha256}`)
    expect(service.getArtifact(actor, { novelId: novel.id, artifactId: stored.id })).toEqual(stored)
  })
  if (outcome.status === 'rejected') throw outcome.reason
})

it('preserves a native policy refusal without publishing a delivery', async () => {
  const fixture = await setup()
  fixture.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'present') throw new Error('Fixture presentation denied.')
    return next()
  })
  const outcome = await fixture.run(exec => fixture.publisher.publishArtifact(exec, fixture.writingRun.id, fixture.novel.id, fixture.novel.brief.id))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { message: 'Writing-stage presentation failed: Fixture presentation denied.' } })
  expect(fixture.parent.session.ownEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
})

it('propagates cancellation through nested native dispatch and waits until it settles', async () => {
  const fixture = await setup()
  const entered = Promise.withResolvers<void>()
  let stopped = false
  fixture.ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'present') return next()
    entered.resolve()
    try {
      exec.signal.throwIfAborted()
      await once(exec.signal, 'abort')
      exec.signal.throwIfAborted()
      return next()
    } finally { stopped = true }
  })
  const pending = fixture.run(exec => fixture.publisher.publishArtifact(exec, fixture.writingRun.id, fixture.novel.id, fixture.novel.brief.id))
  await entered.promise
  fixture.parent.cancel({ kind: 'user' })
  const outcome = await pending
  expect(outcome.status).toBe('rejected')
  expect(stopped).toBe(true)
  expect(fixture.parent.session.ownEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
})

it('requires the actual native event even when a replaced named capability returns success', async () => {
  const fixture = await setup()
  await fixture.presentPlugin.dispose()
  fixture.ctx.effect(() => fixture.ctx.tools.register(defineTool({
    name: 'present', description: 'Non-native capability used to verify the required delivery receipt.',
    parameters: { files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, description: { type: 'string', required: true } } } } },
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Reported success without a delivery event.' }] },
    execute: async () => true,
  })))
  const outcome = await fixture.run(exec => fixture.publisher.publishArtifact(exec, fixture.writingRun.id, fixture.novel.id, fixture.novel.brief.id))
  expect(outcome).toMatchObject({ status: 'rejected', reason: { message: 'Native present returned without its exact committed delivery event' } })
  expect(fixture.parent.session.ownEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
})

it('makes an existing version available to a new owning tool call without reusing invocation IDs', async () => {
  const fixture = await setup()
  for (let count = 0; count < 2; count += 1) {
    const outcome = await fixture.run(exec => fixture.publisher.publishArtifact(exec, fixture.writingRun.id, fixture.novel.id, fixture.novel.brief.id))
    if (outcome.status === 'rejected') throw outcome.reason
  }
  const projection = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!
  expect(projection.calls.map(call => call.callId)).toEqual(['stage-fixture-1', 'stage-fixture-2'])
  expect(projection.calls[0]!.deliveries[0]!.path).toBe(projection.calls[1]!.deliveries[0]!.path)
  const deliveries = fixture.parent.session.ownEvents().filter(event => event.type === 'deliverables/presented')
  expect(deliveries).toHaveLength(2)
  expect(deliveries[0]!.data.callId).not.toBe(deliveries[1]!.data.callId)
})
