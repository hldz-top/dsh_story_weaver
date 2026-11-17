/** A version-10 run patches an admitted body. Version 9 still asks for the complete chapter. */
import { expect, it } from 'vitest'
import { applyBodyPatch, BODY_PATCH_REQUIREMENT } from '../src/body-repair.ts'
import type { ArtifactId } from '../src/contracts.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import type { WritingFixtureStage } from './support/writing-fixture.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const FROM = '确认过的航标'
const TO = '改写过的航标'

function reviewedKind(stage: WritingFixtureStage): string | undefined {
  const id = stage.task?.reviewed?.artifactId
  return id === undefined ? undefined : stage.sources.get(id)?.kind
}

function blockReview(output: object, stage: WritingFixtureStage): object {
  const paragraphId = stage.task?.paragraphs?.[0]?.id
  if (paragraphId === undefined) throw new Error('Body review has no paragraph to cite')
  return {
    ...output,
    issues: [{
      id: 'body-conflict', severity: 'blocking', category: 'consistency', location: 'opening',
      message: '只改被点名的段落，使它与已采纳的设定一致。',
      evidence: [{ paragraphId, problem: '这一段与已采纳的设定矛盾。' }],
    }],
  }
}

function asksForBodyPatch(stage: WritingFixtureStage): boolean {
  return stage.data.kind === 'body' && stage.data.requirements.includes(BODY_PATCH_REQUIREMENT)
}

function storedBody(stage: WritingFixtureStage): unknown {
  const source = [...stage.sources.values()].find(item => item.kind === 'body')
  if (source === undefined) throw new Error('Repair stage has no stored body')
  return JSON.parse(source.text) as unknown
}

it('stores a patched body when a repair is requested, and the model reply is only the patch', async () => {
  let bodyReviews = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') {
        bodyReviews += 1
        if (bodyReviews === 1) return blockReview(output, stage)
      }
      if (asksForBodyPatch(stage)) {
        const prior = StageOutputSchemas.body.parse(storedBody(stage))
        expect(prior.scenes[0]?.text).toContain(FROM)
        return { version: 1, changes: [{ op: 'set', path: 'scenes[0].text', value: prior.scenes[0]!.text.replace(FROM, TO) }] }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.promptVersion).toBe(15)

  const draft = [...fixture.stages.values()].find(stage => stage.kind === 'body' && stage.task?.validationError == null)
  const repair = [...fixture.stages.values()].find(stage => asksForBodyPatch(stage))
  expect(draft?.prompt).toContain('Write the complete assigned chapter')
  expect(draft?.prompt).not.toContain(BODY_PATCH_REQUIREMENT)
  expect(repair?.prompt).toContain(BODY_PATCH_REQUIREMENT)
  expect(repair?.prompt).toContain('Do not return the complete body')
  expect(repair?.prompt).not.toContain('return the entire candidate')
  const published = (prompt: string | undefined) => prompt?.split('\n\nOUTPUT_SCHEMA\n\n')[1] ?? ''
  expect(published(draft?.prompt)).toContain('scenes')
  expect(published(draft?.prompt)).not.toContain('"changes"')
  expect(published(repair?.prompt)).toContain('"changes"')
  expect(published(repair?.prompt)).not.toContain('sceneId')
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)

  const repairAttempt = outcome.value.attempts.find(item => item.key === 'body/1/candidate/1' && item.status === 'succeeded')
  const repairOutput = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, repairAttempt!.id).text) as { changes: unknown[] }
  expect(repairOutput.changes).toEqual([{ op: 'set', path: 'scenes[0].text', value: expect.stringContaining(TO) }])
  expect(JSON.stringify(repairOutput)).not.toContain('sceneId')

  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const bodies = manuscript.history.filter(item => item.target.kind === 'body')
  expect(bodies.map(item => item.status)).toEqual(['blocked', 'applied'])
  const read = (id: ArtifactId) => JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: id }).text) as unknown
  const original = read(bodies[0]!.artifact.id)
  const stored = read(bodies[1]!.artifact.id)
  expect(stored).toEqual(applyBodyPatch(original, repairOutput))
  const originalText = StageOutputSchemas.body.parse(original).scenes[0]!.text
  const storedText = StageOutputSchemas.body.parse(stored).scenes[0]!.text
  expect(originalText).toContain(FROM)
  expect(storedText).toBe(originalText.replace(FROM, TO))
  expect(storedText).toContain('林澜把改写过的航标记入日志')
  expect(StageOutputSchemas.body.parse(stored).scenes[0]!.sceneId).toBe(StageOutputSchemas.body.parse(original).scenes[0]!.sceneId)
  expect(stored).not.toHaveProperty('changes')
}, 120_000)

it('falls back to a complete body when the patch does not apply and bodyPatchFallback is true', async () => {
  let bodyReviews = 0
  const fixture = await useWritingFixture({
    bodyPatchFallback: true,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') {
        bodyReviews += 1
        if (bodyReviews === 1) return blockReview(output, stage)
      }
      if (asksForBodyPatch(stage)) {
        return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const retried = outcome.value.attempts.find(item => item.key === 'body/1/candidate/1/schema' && item.status === 'succeeded')
  expect(retried).toBeDefined()
  const retryPrompt = fixture.runs.storedPrompt(fixture.actor, outcome.value.id, 'body/1/candidate/1/schema') ?? ''
  expect(retryPrompt).toContain('no-such-field')
  const fallback = outcome.value.attempts.find(item => item.key === 'body/1/candidate/1/full' && item.status === 'succeeded')
  expect(fallback).toBeDefined()
  const fallbackBody = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, fallback!.id).text) as { scenes?: unknown; changes?: unknown }
  expect(fallbackBody.scenes).toBeDefined()
  expect(fallbackBody).not.toHaveProperty('changes')
  const patchAttempt = outcome.value.attempts.find(item => item.key === 'body/1/candidate/1' && item.status === 'succeeded')
  expect(JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, patchAttempt!.id).text)).toEqual({ version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] })
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const bodies = manuscript.history.filter(item => item.target.kind === 'body')
  expect(bodies.map(item => item.status)).toEqual(['blocked', 'applied'])
  for (const item of bodies) {
    const stored = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: item.artifact.id }).text) as { scenes: unknown; changes?: unknown }
    expect(stored.scenes).toBeDefined()
    expect(stored).not.toHaveProperty('changes')
  }
  expect(StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: bodies[1]!.artifact.id }).text)).scenes[0]?.text).toContain(FROM)
}, 120_000)

it('rejects the candidate when the patch and the full-body fallback are both invalid', async () => {
  const fixture = await useWritingFixture({
    bodyPatchFallback: true,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') return blockReview(output, stage)
      if (asksForBodyPatch(stage)) {
        return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      }
      if (stage.kind === 'body' && stage.task?.validationError != null) {
        const body = StageOutputSchemas.body.parse(output)
        return { ...body, chapterNumber: 9 }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('Repair limit was exhausted for body/1')
  expect(outcome.value.attempts.some(item => item.key === 'body/1/candidate/1/full')).toBe(true)
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const bodies = manuscript.history.filter(item => item.target.kind === 'body')
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.status).toBe('blocked')
  const stored = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: bodies[0]!.artifact.id }).text))
  expect(stored.chapterNumber).toBe(1)
  expect(stored).not.toHaveProperty('changes')
  expect(manuscript.appliedChapters).toEqual([])
}, 120_000)

it('does not ask for a full body when bodyPatchFallback is false', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    bodyPatchFallback: false,
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') return blockReview(output, stage)
      if (asksForBodyPatch(stage)) {
        return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('no-such-field')
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  expect(manuscript.history.filter(item => item.target.kind === 'body')).toHaveLength(1)
  expect(manuscript.appliedChapters).toEqual([])
}, 120_000)

function completeBody(): object {
  return { version: 1, inputRefs: [], chapterNumber: 1, scenes: [{ sceneId: 'scene-1', text: '完整正文不是补丁。' }] }
}

it('retries a schema-invalid complete body once with feedback, then admits the full-body fallback', async () => {
  let bodyReviews = 0
  const fixture = await useWritingFixture({
    bodyPatchFallback: true,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') {
        bodyReviews += 1
        if (bodyReviews === 1) return blockReview(output, stage)
      }
      if (asksForBodyPatch(stage)) return completeBody()
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const first = outcome.value.attempts.filter(item => item.key === 'body/1/candidate/1')
  const retried = outcome.value.attempts.filter(item => item.key === 'body/1/candidate/1/schema')
  expect(first).toEqual([expect.objectContaining({ status: 'succeeded' })])
  expect(retried).toEqual([expect.objectContaining({ status: 'succeeded' })])
  expect(JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, first[0]!.id).text)).toEqual(completeBody())
  expect(JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, retried[0]!.id).text)).toEqual(completeBody())
  const patches = [...fixture.stages.values()].filter(asksForBodyPatch)
  expect(patches).toHaveLength(2)
  expect(patches[0]?.task?.validationError ?? '').not.toContain('could not be decoded')
  expect(patches[1]?.task?.validationError).toContain('could not be decoded')
  expect(patches[1]?.prompt).toContain('could not be decoded')
  const full = outcome.value.attempts.find(item => item.key === 'body/1/candidate/1/full' && item.status === 'succeeded')
  expect(full).toBeDefined()
  const admitted = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, full!.id).text) as { scenes?: unknown; changes?: unknown }
  expect(admitted.scenes).toBeDefined()
  expect(admitted).not.toHaveProperty('changes')
  const bodies = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.filter(item => item.target.kind === 'body')
  expect(bodies.map(item => item.status)).toEqual(['blocked', 'applied'])
  const applied = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: bodies[1]!.artifact.id }).text))
  expect(applied.scenes[0]?.text).toContain(FROM)
  expect(applied).not.toHaveProperty('changes')
}, 120_000)

it('rejects the round when a schema-invalid patch and its retry both fail and fallback is off', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    bodyPatchFallback: false,
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') return blockReview(output, stage)
      if (asksForBodyPatch(stage)) return completeBody()
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('Repair limit was exhausted for body/1')
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)
  expect(outcome.value.attempts.filter(item => item.key === 'body/1/candidate/1')).toEqual([expect.objectContaining({ status: 'succeeded' })])
  expect(outcome.value.attempts.filter(item => item.key === 'body/1/candidate/1/schema')).toEqual([expect.objectContaining({ status: 'succeeded' })])
  const bodies = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.filter(item => item.target.kind === 'body')
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.status).toBe('blocked')
  const kept = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: bodies[0]!.artifact.id }).text))
  expect(kept.chapterNumber).toBe(1)
  expect(kept.scenes.length).toBeGreaterThan(0)
}, 120_000)

it('retries an apply failure once and puts the error in the next patch', async () => {
  let patches = 0
  let bodyReviews = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') {
        bodyReviews += 1
        if (bodyReviews === 1) return blockReview(output, stage)
      }
      if (!asksForBodyPatch(stage)) return output
      patches += 1
      if (patches === 1) return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      const prior = StageOutputSchemas.body.parse(storedBody(stage))
      return { version: 1, changes: [{ op: 'set', path: 'scenes[0].text', value: prior.scenes[0]!.text.replace(FROM, TO) }] }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const retry = [...fixture.stages.values()].filter(asksForBodyPatch)
  expect(retry).toHaveLength(2)
  expect(retry[1]?.task?.validationError).toContain('no-such-field')
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.find(item => item.target.kind === 'body' && item.status === 'applied')
  const text = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: applied!.artifact.id }).text)).scenes[0]?.text
  expect(text).toContain(TO)
}, 120_000)

it('keeps the admitted body when the patch apply fails twice', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') return blockReview(output, stage)
      if (asksForBodyPatch(stage)) return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('no-such-field')
  const bodies = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.filter(item => item.target.kind === 'body')
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.status).toBe('blocked')
  const kept = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: bodies[0]!.artifact.id }).text))
  expect(kept.scenes[0]?.text).toContain(FROM)
  expect(kept).not.toHaveProperty('changes')
}, 120_000)

it('does not produce a full-body attempt when bodyPatchFallback is left at its default', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') return blockReview(output, stage)
      if (asksForBodyPatch(stage)) return { version: 1, changes: [{ op: 'set', path: 'scenes[99].text', value: '改' }] }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)
  expect(new Set(outcome.value.attempts.map(item => item.key)).has('body/1/candidate/1/full')).toBe(false)
}, 120_000)

it('propagates a non-schema patch capture failure without a retry or a full-body fallback', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') return blockReview(output, stage)
      return output
    },
    injectFinish(stage) {
      return asksForBodyPatch(stage) ? { kind: 'max-tokens' } : undefined
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toBe("Writing stage output was truncated at the model's output-token limit before a complete structured result")
  expect(outcome.value.attempts.filter(item => item.key === 'body/1/candidate/1')).toEqual([expect.objectContaining({ status: 'failed', failureKind: 'truncated' })])
  expect(outcome.value.attempts.some(item => item.key.includes('/schema'))).toBe(false)
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)
  const bodies = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.filter(item => item.target.kind === 'body')
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.status).toBe('blocked')
}, 120_000)

it('replays a version-9 body repair as a complete chapter', async () => {
  let reviews = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'body') {
        reviews += 1
        if (reviews === 1) return blockReview(output, stage)
      }
      return output
    },
  })
  const begun = await fixture.runs.begin(fixture.actor, {
    ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
    executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits },
  }, 9)
  await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stored on prompt version 9.')
  const outcome = await fixture.run(exec => fixture.runner.resume(exec, begun.id, false))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.promptVersion).toBe(9)
  const repair = [...fixture.stages.values()].find(stage => stage.kind === 'body' && stage.task?.validationError != null)
  expect(repair?.prompt).not.toContain(BODY_PATCH_REQUIREMENT)
  expect(repair?.prompt).toContain('return the entire candidate')
  const repairAttempt = outcome.value.attempts.find(item => item.key === 'body/1/candidate/1' && item.status === 'succeeded')
  const raw = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, repairAttempt!.id).text) as { scenes?: unknown; changes?: unknown }
  expect(raw.scenes).toBeDefined()
  expect(raw).not.toHaveProperty('changes')
  expect(outcome.value.attempts.some(item => item.key.includes('/full'))).toBe(false)
}, 120_000)
