/** Native reader-document failure preserves internal reviews and repair history on resume. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import type { ArtifactId } from '../src/contracts.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

function fulfilled<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}

it('replays the complete blocked collection and retains its internal review after repair presentation was denied', async () => {
  let blockedCollection = false
  let denied = false
  let resuming = false
  let retainedReviewId: ArtifactId | undefined
  let retainedCollectionId: ArtifactId | undefined
  let collectionPresentations = 0
  let deliveredBeforeRepair: boolean | undefined
  const fixture = await useWritingFixture({ maxReadChars: 8192,
    intervene(stage, output) {
      if (blockedCollection || stage.task?.batch !== 'consistency') return output
      blockedCollection = true
      return { issues: [{ dimension: 'a1', kind: 'conflict', quote: '本书是一部发生在虚构雾港的悬疑冒险小说。' }] }
    },
    onChildRequest() {
      if (!resuming || deliveredBeforeRepair !== undefined) return
      const projection = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']
      deliveredBeforeRepair = projection?.calls.find(call => call.callId === 'stage-fixture-2')?.deliveries.some(delivery =>
        delivery.source.kind === 'artifact' && delivery.source.artifactId === retainedCollectionId) === true
    },
  })
  const presentArgs = z.object({ files: z.array(z.object({ path: z.string(), description: z.string().optional() })) })
  fixture.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'present' || denied) return next()
    const args = presentArgs.parse(exec.arguments)
    if (!args.files.some(file => file.description?.startsWith('Settings collection'))) return next()
    collectionPresentations++
    if (collectionPresentations !== 2) return next()
    denied = true
    return { kind: 'deny', reason: 'Fixture denied the repaired collection delivery.' }
  })
  const failed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 })))
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('Fixture denied the repaired collection delivery.')
  const retained = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.find(candidate => candidate.target.kind === 'settings' && candidate.status === 'blocked')
  if (retained?.review === null || retained?.review === undefined) throw new Error('The blocked collection review was not retained')
  retainedReviewId = retained.review.id
  retainedCollectionId = retained.artifact.id
  const before = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']
  expect(before?.calls.flatMap(call => call.deliveries).some(delivery => delivery.source.kind === 'artifact' && delivery.source.artifactId === retainedReviewId)).toBe(false)
  const reviewAttempt = failed.attempts.find(attempt => attempt.key === 'settings/collection/0/review/0')
  expect(reviewAttempt?.status).toBe('succeeded')
  const requestsAtFailure = fixture.childRequests.length
  resuming = true
  const completed = fulfilled(await fixture.run(exec => fixture.runner.resume(exec, failed.id, false)))
  expect(completed.error).toBeNull()
  expect(completed.status).toBe('completed')
  const after = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']
  const deliveredIds = after?.calls.flatMap(call => call.deliveries.flatMap(delivery => delivery.source.kind === 'artifact' ? [delivery.source.artifactId] : []))
  expect(deliveredIds).toContain(retainedCollectionId)
  expect(deliveredIds).not.toContain(retainedReviewId)
  expect(deliveredBeforeRepair).toBe(true)
  expect(completed.attempts.find(attempt => attempt.id === reviewAttempt?.id)).toEqual(reviewAttempt)
  expect(fixture.childRequests.slice(requestsAtFailure).some(request => request.sessionId === reviewAttempt?.childSessionId)).toBe(false)
})

it('replays rejected review admission after a native repair interruption without presenting raw output', async () => {
  let malformedCollection = false
  let interruptedRepair = false
  let rawPresentationRequested = false
  const fixture = await useWritingFixture({ maxReadChars: 8192, intervene(stage, output) {
    if (stage.task?.batch !== 'consistency') return output
    if (malformedCollection) {
      if (!interruptedRepair && typeof stage.task.validationError === 'string') {
        interruptedRepair = true
        throw new Error('Fixture interrupted native review repair.')
      }
      return output
    }
    malformedCollection = true
    return { issues: [{ dimension: 'a1', kind: 'conflict', quote: '这句话从未出现。' }] }
  } })
  const presentArgs = z.object({ files: z.array(z.object({ path: z.string(), description: z.string().optional() })) })
  fixture.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'present') return next()
    const args = presentArgs.parse(exec.arguments)
    if (!args.files.some(file => file.description === 'Rejected stage output: settings/collection/0/review/0')) return next()
    rawPresentationRequested = true
    return { kind: 'deny', reason: 'Fixture does not allow raw-output presentation.' }
  })
  const failed = fulfilled(await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 })))
  expect(failed.status).toBe('failed')
  expect(interruptedRepair).toBe(true)
  expect(failed.error).toContain('Writing stage ended without a complete structured result: error')
  expect(failed.attempts.find(attempt => attempt.key === 'settings/collection/0/review/1')?.status).toBe('unknown')
  expect(rawPresentationRequested).toBe(false)
  const candidate = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.find(item => item.target.kind === 'settings')
  if (candidate === undefined) throw new Error('The reviewed collection candidate was not retained')
  expect(candidate).toMatchObject({ status: 'candidate', review: null })
  const firstReview = failed.attempts.find(attempt => attempt.key === 'settings/collection/0/review/0')
  if (firstReview === undefined) throw new Error('The raw review attempt was not retained')
  expect(firstReview.status).toBe('succeeded')
  const raw = fixture.runs.readOutput(fixture.actor, failed.id, firstReview.id)
  expect(JSON.parse(raw.text).issues[0].quote).toBe('这句话从未出现。')
  const requestsAtFailure = fixture.childRequests.length
  const completed = fulfilled(await fixture.run(exec => fixture.runner.resume(exec, failed.id, true)))
  expect(completed.error).toBeNull()
  expect(completed.status).toBe('completed')
  expect(completed.attempts.find(attempt => attempt.id === firstReview.id)).toEqual(firstReview)
  expect(completed.attempts.findLast(attempt => attempt.key === 'settings/collection/0/review/1')?.status).toBe('succeeded')
  expect(fixture.runs.readOutput(fixture.actor, failed.id, firstReview.id)).toEqual(raw)
  expect(fixture.childRequests.slice(requestsAtFailure).some(request => request.sessionId === firstReview.childSessionId)).toBe(false)
  const recovered = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.find(item => item.artifact.id === candidate.artifact.id)
  expect(recovered?.status).toBe('applied')
  expect(recovered?.review).not.toBeNull()
  const projection = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']
  expect(projection?.calls.flatMap(call => call.deliveries).some(delivery => delivery.source.kind === 'rejected-output')).toBe(false)
  expect(rawPresentationRequested).toBe(false)
})
