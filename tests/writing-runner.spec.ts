import { readFile } from 'node:fs/promises'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { artifactMarkdown } from '../src/artifact-markdown.ts'
import { countStoryWords } from '../src/body-text.ts'
import { parseArtifactId } from '../src/contracts.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { WritingRunner } from '../src/writing-runner.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const countingSentence = 'Story counting: each Chinese character counts as one word, each ASCII word or number counts as one word, and punctuation and whitespace count as zero.'
/** The range requirement per stage kind, computed from the configured bounds: only a body writing stage is given an aim, and only a review is told a host-measured count inside the range is not a length defect. */
function rangeLines(min: number, max: number) {
  return {
    body: `The accepted chapter-total range is ${min}–${max} Story-counted words; aim for about ${Math.round((min + max) / 2)}. ${countingSentence}`,
    outline: `The accepted chapter-total range is ${min}–${max} Story-counted words. ${countingSentence}`,
    review: `The accepted chapter-total range is ${min}–${max} Story-counted words. ${countingSentence} A host-measured count inside this range is not a length defect.`,
  }
}
const reviewRepairLine = 'Repair the defects documented in the supplied prior candidate and review. Preserve unaffected facts and passages and return the entire candidate.'
const lengthRepairLine = 'Condense or expand across all scenes to reach the aim; preserve required events, established facts and scene identities rather than passage wording.'

async function loggedPrompt(fixture: Awaited<ReturnType<typeof useWritingFixture>>, sessionId: SessionId): Promise<string> {
  const handle = await fixture.ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read()
    const block = events.find(event => event.type === 'user/message')?.data.content.find(item => item.type === 'text')
    if (block?.type !== 'text') throw new Error(`Child ${sessionId} has no logged prompt text`)
    return block.text
  } finally { await handle.close() }
}

function loggedRequirements(prompt: string): string[] {
  const data: { requirements: string[] } = JSON.parse(prompt.split('\n\nTASK_DATA\n\n')[1]!)
  return data.requirements
}

/** A three-scene chapter outline and a first body whose scene word counts are exactly `sceneCounts`; later attempts keep the fixture's default prose. */
function scaledFirstBody(sceneCounts: readonly number[]): (stage: WritingFixtureStage, output: object) => object {
  return (stage, output) => {
    if (stage.kind === 'chapter-outline') {
      const outline = StageOutputSchemas['chapter-outline'].parse(output)
      return { ...outline, scenes: [...outline.scenes, ...[2, 3].map(number => ({ id: `chapter-${outline.chapterNumber}-scene-${number}`, purpose: `Scene ${number} advances the chapter.`, action: `The keeper acts in scene ${number}.`, obligationIds: [] }))] }
    }
    if (stage.kind !== 'body' || (stage.task?.validationError ?? null) !== null) return output
    const body = StageOutputSchemas.body.parse(output)
    // Every scene mixes CJK characters, ASCII words, a number and punctuation, so only the Story counter's own rules produce its count.
    return { ...body, scenes: body.scenes.map((scene, index) => ({ ...scene, text: `${'光'.repeat(sceneCounts[index]! - 4)} The lamp, 3 times.` })) }
  }
}

it('writes three reviewed chapters through native research and stages before completing the run', async () => {
  const fixture = await useWritingFixture({ maxReadChars: 4096 })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, fixture.input))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error, JSON.stringify(outcome.value.attempts.map(({ key, error }) => ({ key, error })))).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  expect(manuscript.heads.map(head => head.target.kind)).toEqual(['settings', 'book-outline', 'chapter-outline', 'chapter-outline', 'chapter-outline'])
  expect(manuscript.appliedChapters).toHaveLength(3)
  for (const chapter of manuscript.appliedChapters) {
    expect(chapter.wordCount).toBeGreaterThanOrEqual(3000)
    expect(chapter.wordCount).toBeLessThanOrEqual(5000)
    expect(chapter.stale).toBe(false)
  }
  expect(outcome.value.attempts.every(attempt => attempt.status === 'succeeded' && attempt.output !== null)).toBe(true)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  expect(fixture.childRequests.every(request => request.provider === 'stage-fixture' && request.model === 'inherited-model')).toBe(true)
  expect(outcome.value.attempts.some(attempt => attempt.key.includes('research/planning'))).toBe(true)
  expect(outcome.value.attempts.some(attempt => attempt.key.includes('/candidate/'))).toBe(true)
  expect(outcome.value.attempts.some(attempt => attempt.key.includes('/review'))).toBe(true)
  expect(JSON.stringify(fixture.parent.session.ownEvents())).not.toContain('subagent-settled')
  expect(WritingRunner).toBeDefined()
  const delivered = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.flatMap(call => call.deliveries)
  const expected = manuscript.history.filter(candidate => ['settings', 'book-outline', 'chapter-outline', 'body'].includes(candidate.artifact.kind)).map(candidate => candidate.artifact)
  expect(expected).toHaveLength(8)
  expect(delivered).toHaveLength(8)
  const events = fixture.parent.session.ownEvents().filter(event => event.type === 'deliverables/presented')
  expect(events.flatMap(event => event.data.files.map(file => file.path)).sort()).toEqual(delivered.map(item => item.path).sort())
  expect(fixture.service.listResearch(fixture.actor, fixture.novel.id)).toHaveLength(11)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).history).toHaveLength(1)
  expect(manuscript.history).toHaveLength(11)
  expect(manuscript.history.every(candidate => candidate.review !== null)).toBe(true)
  expect(delivered.map(item => item.source.kind === 'artifact' ? item.source.artifactId : item.source.attemptId).sort()).toEqual(expected.map(item => item.id).sort())
  for (const item of delivered) {
    if (item.source.kind !== 'artifact') throw new Error('Successful fixture unexpectedly produced rejected output')
    const artifact = fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: parseArtifactId(item.source.artifactId) })
    expect(await readFile(item.path)).toEqual(Buffer.from(artifactMarkdown(artifact), 'utf8'))
  }
})

it('retains a semantically invalid book output and repairs it within the fixed budget', async () => {
  let shortened = false
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'book-outline' || shortened) return output
    shortened = true
    const book = StageOutputSchemas['book-outline'].parse(output)
    return { ...book, chapters: book.chapters.slice(0, 2) }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const attempts = outcome.value.attempts.filter(item => item.key.startsWith('book-outline/book/candidate/') && !item.key.includes('/review'))
  expect(attempts).toHaveLength(2)
  expect(attempts.every(item => item.output !== null)).toBe(true)
  const original = fixture.runs.readOutput(fixture.actor, outcome.value.id, attempts[0]!.id)
  expect(StageOutputSchemas['book-outline'].parse(JSON.parse(original.text)).chapters).toHaveLength(2)
  const delivered = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.flatMap(call => call.deliveries)
  expect(delivered.every(item => item.source.kind === 'artifact')).toBe(true)
  expect(fixture.parent.session.ownEvents().filter(event => event.type === 'deliverables/presented').flatMap(event => event.data.files).some(file => file.path.includes('/rejected/'))).toBe(false)
})

it('shows full body repair versions while never applying the mechanically short version', async () => {
  let short = false
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'body' || short) return output
    short = true
    const body = StageOutputSchemas.body.parse(output)
    return { ...body, scenes: body.scenes.map(scene => ({ ...scene, text: '林澜发出了信号。' })) }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const rejected = manuscript.history.find(item => item.artifact.kind === 'body' && item.length?.blocking)
  expect(rejected).toMatchObject({ status: 'blocked' })
  expect(manuscript.appliedChapters).toHaveLength(1)
  expect(manuscript.appliedChapters[0]!.body.id).not.toBe(rejected!.artifact.id)
  const delivered = fixture.ctx.sessionProjections.snapshot(fixture.parent.session).values['story-stage-deliveries']!.calls.flatMap(call => call.deliveries)
  const bodyIds = manuscript.history.filter(item => item.artifact.kind === 'body').map(item => item.artifact.id)
  expect(bodyIds).toHaveLength(2)
  expect(delivered.filter(item => item.source.kind === 'artifact' && bodyIds.includes(parseArtifactId(item.source.artifactId)))).toHaveLength(2)
})

it('stops after repeated blocking body reviews without starting continuity or the next chapter', async () => {
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'review' || stage.task?.reviewed === undefined || stage.sources.get(stage.task.reviewed.artifactId)?.kind !== 'body') return output
    const review = StageOutputSchemas.review.parse(output)
    return { ...review, issues: [{ id: 'conflict', category: 'consistency', severity: 'blocking', location: 'First scene', message: 'A required character constraint is contradicted.', evidence: review.checks[0]!.evidence }] }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, fixture.input))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('Repair limit was exhausted')
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toEqual([])
  expect([...fixture.stages.values()].some(stage => stage.kind === 'continuity' || stage.task?.chapterNumber === 2)).toBe(false)
})

it('retries a malformed chapter body response under the same key and completes the run', async () => {
  let injected = false
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'body' || injected) return undefined
    injected = true
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const bodyKey = 'body/1/candidate/0'
  const attempts = outcome.value.attempts.filter(item => item.key === bodyKey)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({ status: 'failed', output: null })
  expect(attempts[0]!.error).toContain('could not be decoded (MALFORMED_RESPONSE)')
  expect(attempts[1]).toMatchObject({ status: 'succeeded' })
  expect(outcome.value.attempts.some(item => item.key === 'body/1/candidate/1')).toBe(false)
  const bodyChildren = [...fixture.stages.values()].filter(stage => stage.kind === 'body')
  expect(bodyChildren).toHaveLength(2)
  expect(bodyChildren.every(stage => (stage.task?.validationError ?? null) === null)).toBe(true)
})

it('fails the run once repeated malformed settings responses exhaust the repair budget under the same key', async () => {
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'settings') return undefined
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('could not be decoded (MALFORMED_RESPONSE)')
  const settingsKey = 'settings/0/a1/candidate/0'
  const attempts = outcome.value.attempts.filter(item => item.key === settingsKey)
  expect(attempts).toHaveLength(2)
  expect(attempts.every(item => item.status === 'failed')).toBe(true)
  expect(attempts.every(item => item.error?.includes('could not be decoded (MALFORMED_RESPONSE)'))).toBe(true)
  expect(outcome.value.attempts.some(item => item.key === 'settings/0/a1/candidate/1')).toBe(false)
})

it('fails the run on the first malformed settings response when the repair budget is zero', async () => {
  const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 0 }, injectFinish(stage) {
    if (stage.kind !== 'settings') return undefined
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  const attempts = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({ status: 'failed' })
})

it('does not repeat a same-key malformed retry on resume after a later unrelated failure', async () => {
  let settingsInjected = false
  let reviewInjected = false
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind === 'settings' && !settingsInjected) {
      settingsInjected = true
      return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
    }
    if (!reviewInjected && stage.kind === 'review' && stage.task?.reviewed !== undefined
      && stage.sources.get(stage.task.reviewed.artifactId)?.kind === 'settings-dimension') {
      reviewInjected = true
      return { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture-injected later stage failure.' } }
    }
    return undefined
  } })
  const settingsKey = 'settings/0/a1/candidate/0'
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  expect(first.value.status).toBe('failed')
  const attemptsBefore = first.value.attempts.filter(item => item.key === settingsKey)
  expect(attemptsBefore.map(item => item.status)).toEqual(['failed', 'succeeded'])
  const settingsChildrenBefore = [...fixture.stages.values()].filter(stage => stage.kind === 'settings').length
  expect(settingsChildrenBefore).toBe(2)
  const requestsBefore = fixture.childRequests.length
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, first.value.id, true))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.status).toBe('completed')
  expect(resumed.value.attempts.filter(item => item.key === settingsKey)).toEqual(attemptsBefore)
  const settingsChildrenAfter = [...fixture.stages.values()].filter(stage => stage.kind === 'settings').length
  expect(settingsChildrenAfter).toBe(settingsChildrenBefore)
  expect(fixture.childRequests.length).toBeGreaterThan(requestsBefore)
})

it('stops cleanly when cancelled right after a malformed settings response is durably recorded, preparing no replacement attempt', async () => {
  let injected = 0
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'settings') return undefined
    injected += 1
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  // Cancel exactly when the malformed attempt's own failure write durably lands, not merely when the child's
  // turn ends: the executor still has cleanup (dispose, admission settling) between those two points, and
  // cancelling at turn/end races ahead of the malformed classification itself (recorded 'unknown', not 'failed').
  const originalFailAttempt = fixture.runs.failAttempt.bind(fixture.runs)
  fixture.runs.failAttempt = async (actor, runId, attemptId, failure) => {
    const result = await originalFailAttempt(actor, runId, attemptId, failure)
    if (failure.outcome === 'failed' && failure.message.includes('could not be decoded (MALFORMED_RESPONSE)')) fixture.parent.cancel({ kind: 'user' })
    return result
  }
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('stopped')
  const attempts = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({ status: 'failed' })
  expect(attempts[0]!.error).toContain('could not be decoded (MALFORMED_RESPONSE)')
  expect(injected).toBe(1)
  expect([...fixture.stages.values()].filter(stage => stage.kind === 'settings')).toHaveLength(1)
})

it('still fails the run and records an unknown (not failed) attempt for a non-malformed native stage error', async () => {
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'settings') return undefined
    return { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture-injected non-malformed stage failure.' } }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  const attempts = outcome.value.attempts.filter(item => /^settings\/0\/a1\/candidate\/\d+$/.test(item.key))
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({ status: 'unknown' })
  expect(attempts[0]!.error).toContain('Writing stage ended without a complete structured result')
})

it('threads the host chapter-total range and settings kind-awareness correctly across every real logged child prompt', async () => {
  const fixture = await useWritingFixture({})
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const rangedKinds = new Set(['book-outline', 'chapter-outline', 'body'])
  const lines = rangeLines(3000, 5000)
  let checked = 0
  const seen = { counting: 0, aim: 0, notDefect: 0 }
  for (const [sessionId, stage] of fixture.stages) {
    if (stage.kind === 'research' || stage.kind === 'research-planning') continue
    const reviewedKind = stage.task?.reviewed === undefined ? null : stage.sources.get(stage.task.reviewed.artifactId)?.kind ?? null
    const handle = await fixture.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      const message = events.find(event => event.type === 'user/message')
      const block = message?.data.content.find(item => item.type === 'text')
      if (block?.type !== 'text') throw new Error(`Child ${stage.kind} (${sessionId}) has no logged prompt text`)
      // H1: the range applies only to stages that assemble chapter prose it measures, and reviews of those stages.
      const expectChapterRange = rangedKinds.has(stage.kind)
        || (stage.kind === 'review' && (reviewedKind === 'book-outline' || reviewedKind === 'chapter-outline' || reviewedKind === 'body'))
      const label = `kind=${stage.kind} reviewedKind=${String(reviewedKind)}`
      expect(block.text.includes('chapter-total range is 3000–5000'), label).toBe(expectChapterRange)
      // Fix 5 and N1: every range-bearing prompt states how the host counts, but only the body writing stage is given an aim (outlines keep their own per-chapter targets and reviews judge against them), and only a review is told a host-measured count inside the range is not a length defect. Settings and continuity prompts have none of it.
      const isReview = stage.kind === 'review'
      expect(block.text.includes('Story counting:'), label).toBe(expectChapterRange)
      expect(block.text.includes('aim for about'), label).toBe(stage.kind === 'body')
      expect(block.text.includes('is not a length defect'), label).toBe(expectChapterRange && isReview)
      if (expectChapterRange) expect(loggedRequirements(block.text), label).toContain(stage.kind === 'body' ? lines.body : isReview ? lines.review : lines.outline)
      seen.counting += Number(block.text.includes('Story counting:'))
      seen.aim += Number(block.text.includes('aim for about'))
      seen.notDefect += Number(block.text.includes('is not a length defect'))
      if (stage.kind === 'settings') {
        expect(block.text).toContain('catalog classification, not a world-building dimension')
        expect(block.text).toContain('Refer to research only by the question IDs')
      }
      if (stage.kind === 'review' && reviewedKind === 'settings-dimension') {
        expect(block.text).toContain('For a classification dimension, completeness')
        expect(block.text).toContain('dimensionKind')
      }
      if (stage.kind === 'review' && reviewedKind === 'settings') {
        expect(block.text).toContain('Completeness for the assembled settings collection means each selected dimension')
        expect(block.text).toContain('dimensionKinds')
        expect(block.text).toContain('enum_single')
      }
      checked += 1
    } finally { await handle.close() }
  }
  // settings, its review, the collection review, book-outline/chapter-outline/body/continuity and each of their reviews.
  expect(checked).toBe(11)
  // The counting rule reached all six range-bearing prompts (three writing stages, three reviews), the aim only the body, the not-a-defect sentence only the three reviews.
  expect(seen).toEqual({ counting: 6, aim: 1, notDefect: 3 })
})

it('tells every real logged research-planning and research child that a catalog-embedded kind names no predefined option list', async () => {
  const fixture = await useWritingFixture({})
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const expected = [...fixture.stages.values()].filter(stage => stage.kind === 'research' || stage.kind === 'research-planning').length
  let checked = 0
  for (const [sessionId, stage] of fixture.stages) {
    if (stage.kind !== 'research' && stage.kind !== 'research-planning') continue
    const handle = await fixture.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      const message = events.find(event => event.type === 'user/message')
      const block = message?.data.content.find(item => item.type === 'text')
      if (block?.type !== 'text') throw new Error(`Child ${stage.kind} (${sessionId}) has no logged prompt text`)
      if (stage.kind === 'research-planning') {
        expect(block.text).toContain('When TASK_DATA.outputTarget.catalog is present, it is the complete definition of that settings dimension.')
        expect(block.text).toContain('which label or labels to choose is a creative question')
        expect(block.text).toContain('Never ask about the host program\'s internals')
      } else {
        expect(block.text).toContain('When TASK_DATA.purpose includes a settings catalog entry, that entry is the complete dimension definition')
        expect(block.text).toContain('A question asking for the program\'s option list or other host program internals is not missing evidence')
        expect(block.text).toContain('This does not cover supplied story facts, unread inputs or real-world facts')
        expect(block.text).not.toContain('Resolve a question about available options')
      }
      checked += 1
    } finally { await handle.close() }
  }
  expect(checked).toBeGreaterThan(0)
  expect(checked).toBe(expected)
})

it('regenerates an over-bound classification settings candidate and carries its validation error into the repair prompt', async () => {
  let expanded = false
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'settings' || expanded) return output
    expanded = true
    const settings = StageOutputSchemas.settings.parse(output)
    return { ...settings, facts: Array.from({ length: 11 }, (_, index) => ({ id: `${settings.facts[0]!.id}-${index}`, statement: settings.facts[0]!.statement })) }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const attempts = outcome.value.attempts.filter(item => /^settings\/0\/a1\/candidate\/\d+$/.test(item.key))
  expect(attempts).toHaveLength(2)
  // The native call itself succeeded (syntactically valid JSON); saveSettingsCandidate's scope check rejects the content afterward.
  expect(attempts[0]).toMatchObject({ status: 'succeeded' })
  const original = fixture.runs.readOutput(fixture.actor, outcome.value.id, attempts[0]!.id)
  expect(StageOutputSchemas.settings.parse(JSON.parse(original.text)).facts).toHaveLength(11)
  const repairedChild = [...fixture.stages.values()].find(candidateStage => candidateStage.kind === 'settings' && candidateStage.task?.validationError != null)
  expect(repairedChild?.task?.validationError).toContain('A classification dimension allows at most 10 facts')
})

it('repairs a settings review whose quote adds words to its source by rewriting only that citation, not the whole review', async () => {
  // Mirrors live run run_2a372815: the model prefixed "进一步确认" to an exact a4 excerpt.
  let misquoted = false
  let original: ReturnType<typeof StageOutputSchemas.review.parse> | undefined
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'review' || misquoted) return output
    misquoted = true
    const review = StageOutputSchemas.review.parse(output)
    const [check, ...rest] = review.checks
    original = { ...review, checks: [{ ...check!, evidence: [{ ...check!.evidence[0]!, quote: `进一步确认${check!.evidence[0]!.quote}` }] }, ...rest] }
    return original
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const a1Reviews = outcome.value.attempts.filter(item => item.key.startsWith('settings/0/a1/candidate/0/review/'))
  expect(a1Reviews.map(item => [item.key, item.status])).toEqual([['settings/0/a1/candidate/0/review/0', 'succeeded'], ['settings/0/a1/candidate/0/review/1/citations', 'succeeded']])
  // No second whole review was requested: only the citation repair child ran, and it was given exactly the rejected item.
  expect([...fixture.stages.values()].filter(stage => stage.kind === 'review' && stage.task?.validationError != null)).toEqual([])
  const repairStage = [...fixture.stages.values()].find(stage => stage.kind === 'review-citation-repair')!
  expect(repairStage.data.kind === 'review-citation-repair' && repairStage.data.items.map(item => item.location)).toEqual(['checks[0]'])
  const prompt = await loggedPrompt(fixture, repairStage.sessionId)
  expect(prompt).toContain('进一步确认')
  expect(prompt).toMatch(/Evidence quote does not occur in its declared source artifact_[0-9a-f-]+: \\"进一步确认/)
  // The admitted review is the prior value with only checks[0].evidence replaced.
  const a1 = fixture.service.getSettings(fixture.actor, fixture.input.novelId).history.find(item => item.dimensionCode === 'a1' && item.review !== null)!
  const saved = StageOutputSchemas.review.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.input.novelId, artifactId: a1.review!.id }).text))
  expect({ ...saved, checks: saved.checks.slice(1) }).toEqual({ ...original!, checks: original!.checks.slice(1) })
  expect({ ...saved.checks[0], evidence: [] }).toEqual({ ...original!.checks[0], evidence: [] })
  expect(saved.checks[0]!.evidence[0]!.quote).not.toContain('进一步确认')
})

it('serves every review input as plain prose, never stored JSON, while other stages keep reading stored text', async () => {
  const fixture = await useWritingFixture()
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const reviews = [...fixture.stages.values()].filter(stage => stage.kind === 'review')
  expect(reviews.length).toBeGreaterThan(0)
  for (const stage of reviews) for (const source of stage.sources.values()) {
    expect(source.view, `${stage.sessionId} ${source.kind}`).toBe('prose')
    for (const scaffolding of ['"sceneId"', '"chapterNumber"', '"inputRefs"', '"sha256"']) expect(source.text).not.toContain(scaffolding)
  }
  const bodyReview = reviews.find(stage => [...stage.sources.values()].some(source => source.kind === 'body' && source.artifactId === stage.task?.reviewed?.artifactId))!
  const bodySource = bodyReview.sources.get(bodyReview.task!.reviewed!.artifactId)!
  expect(bodySource.text).toBe(JSON.parse(bodySource.stored!).scenes.map((scene: { text: string }) => scene.text).join('\n\n'))
  for (const stage of fixture.stages.values()) if (stage.kind === 'body' || stage.kind === 'continuity') for (const source of stage.sources.values()) expect(source.view).toBe('stored')
})

it('drops an unresolvable citation from an item that keeps other valid evidence and records the drop on the run attempt', async () => {
  let injected = false
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'review' || injected) return output
    injected = true
    const review = StageOutputSchemas.review.parse(output)
    const [check, ...rest] = review.checks
    return { ...review, checks: [{ ...check!, evidence: [...check!.evidence, { artifactId: check!.evidence[0]!.artifactId, quote: '这句话从未出现在任何输入中。' }] }, ...rest] }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const first = outcome.value.attempts.find(item => item.key === 'settings/0/a1/candidate/0/review/0')!
  expect(outcome.value.attempts.some(item => item.key.startsWith('settings/0/a1/candidate/0/review/1'))).toBe(false)
  expect(first.evidenceEvents).toEqual([expect.objectContaining({ kind: 'dropped', location: 'checks[0]', declared: expect.objectContaining({ quote: '这句话从未出现在任何输入中。' }), admitted: [],
    reason: expect.stringMatching(/^Evidence quote does not occur in its declared source/) })])
  // Durable, not just logged: the stored run carries it.
  expect(fixture.runs.get(fixture.actor, outcome.value.id).attempts.find(item => item.id === first.id)?.evidenceEvents).toHaveLength(1)
})

/** Real e1 planning capture from live run run_dbe969a5: 13 questions against maxResearchQuestions 12. */
const e1Planning = JSON.parse(await readFile(new URL('./fixtures/run-dbe969a5-e1-planning.json', import.meta.url), 'utf8')) as { decision: object }

it('repairs a research planning decision that exceeds the question limit and gives the replacement the count and the limit', async () => {
  let overran = false
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'research-planning' || overran) return output
    overran = true
    return e1Planning.decision
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const planning = outcome.value.attempts.filter(item => item.key.startsWith('settings/0/a1/research/planning'))
  expect(planning.map(item => [item.key, item.status])).toEqual([['settings/0/a1/research/planning', 'succeeded'], ['settings/0/a1/research/planning/1', 'succeeded']])
  const repairStage = [...fixture.stages.values()].filter(stage => stage.kind === 'research-planning')[1]!
  const prompt = await loggedPrompt(fixture, repairStage.sessionId)
  expect(prompt).toContain('The host rejected the previous planning decision for this exact target: Research questions exceed the configured limits: 13 questions, at most 12 per plan counting internal, creative and external questions together')
  const firstPrompt = await loggedPrompt(fixture, [...fixture.stages.values()].find(stage => stage.kind === 'research-planning')!.sessionId)
  expect(firstPrompt).not.toContain('The host rejected the previous planning decision')
})

it('fails with the specific planning overrun once the repair budget is exhausted', async () => {
  const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 0 }, intervene(stage, output) {
    return stage.kind === 'research-planning' ? e1Planning.decision : output
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('Research planning repair limit was exhausted: Research questions exceed the configured limits: 13 questions, at most 12 per plan')
  expect(outcome.value.attempts.filter(item => item.key.includes('/research/planning')).map(item => item.key)).toEqual(['settings/0/a1/research/planning'])
})

it('retries a malformed settings-dimension review response under the same review key and completes the run', async () => {
  let injected = false
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (injected || stage.kind !== 'review' || stage.task?.reviewed === undefined
      || stage.sources.get(stage.task.reviewed.artifactId)?.kind !== 'settings-dimension') return undefined
    injected = true
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const reviewKey = 'settings/0/a1/candidate/0/review/0'
  const attempts = outcome.value.attempts.filter(item => item.key === reviewKey)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({ status: 'failed', output: null })
  expect(attempts[0]!.error).toContain('could not be decoded (MALFORMED_RESPONSE)')
  expect(attempts[1]).toMatchObject({ status: 'succeeded' })
})

it('resumes past an exhausted same-key malformed settings failure without retryUnknown, since the exhausted attempt is failed, not unknown', async () => {
  let malformedLeft = 2
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'settings' || malformedLeft === 0) return undefined
    malformedLeft -= 1
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  const settingsKey = 'settings/0/a1/candidate/0'
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  expect(first.value.status).toBe('failed')
  const beforeAttempts = first.value.attempts.filter(item => item.key === settingsKey)
  expect(beforeAttempts).toHaveLength(2)
  expect(beforeAttempts.every(item => item.status === 'failed')).toBe(true)
  const settingsChildrenBefore = [...fixture.stages.values()].filter(stage => stage.kind === 'settings').length
  expect(settingsChildrenBefore).toBe(2)
  // retryUnknown=false: the exhausted attempt is 'failed', not 'unknown', so prepareAttempt already permits a fresh one for the same key.
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, first.value.id, false))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.status).toBe('completed')
  const afterAttempts = resumed.value.attempts.filter(item => item.key === settingsKey)
  expect(afterAttempts).toHaveLength(3)
  expect(afterAttempts[2]).toMatchObject({ status: 'succeeded' })
  expect([...fixture.stages.values()].filter(stage => stage.kind === 'settings')).toHaveLength(3)
})

it('bounds each resume to exactly one more maxRepairAttempts-sized round of same-key malformed retries, not unlimited replay', async () => {
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'settings') return undefined
    return { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' } }
  } })
  const settingsKey = 'settings/0/a1/candidate/0'
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  expect(first.value.status).toBe('failed')
  expect(first.value.attempts.filter(item => item.key === settingsKey)).toHaveLength(2)
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, first.value.id, false))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.status).toBe('failed')
  const afterAttempts = resumed.value.attempts.filter(item => item.key === settingsKey)
  expect(afterAttempts).toHaveLength(4)
  expect(afterAttempts.every(item => item.status === 'failed')).toBe(true)
})

it('replays a rejected over-bound settings candidate deterministically on resume, spawning no new child for either key', async () => {
  let expanded = false
  let reviewInjected = false
  const fixture = await useWritingFixture({
    intervene(stage, output) {
      if (stage.kind !== 'settings' || expanded) return output
      expanded = true
      const settings = StageOutputSchemas.settings.parse(output)
      return { ...settings, contentMarkdown: 'x'.repeat(2501) }
    },
    injectFinish(stage) {
      if (!reviewInjected && stage.kind === 'review' && stage.task?.reviewed !== undefined
        && stage.sources.get(stage.task.reviewed.artifactId)?.kind === 'settings-dimension') {
        reviewInjected = true
        return { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture-injected later stage failure.' } }
      }
      return undefined
    },
  })
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  expect(first.value.status).toBe('failed')
  const settingsChildrenBefore = [...fixture.stages.values()].filter(stage => stage.kind === 'settings').length
  const before = first.value.attempts.filter(item => /^settings\/0\/a1\/candidate\/\d+$/.test(item.key))
  expect(before).toHaveLength(2)
  // Both native captures succeeded (syntactically valid JSON); saveSettingsCandidate's scope check rejected candidate/0's content, advancing to a fresh key.
  expect(before.every(item => item.status === 'succeeded')).toBe(true)
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, first.value.id, true))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.status).toBe('completed')
  const after = resumed.value.attempts.filter(item => /^settings\/0\/a1\/candidate\/\d+$/.test(item.key))
  expect(after).toEqual(before)
  expect([...fixture.stages.values()].filter(stage => stage.kind === 'settings')).toHaveLength(settingsChildrenBefore)
})

it.each([
  { label: 'too long', limits: { minChapterWords: 3000, maxChapterWords: 4501 }, sceneCounts: [2200, 1899, 1500], direction: 'over' },
  { label: 'too short', limits: { minChapterWords: 3000, maxChapterWords: 5000 }, sceneCounts: [900, 700, 500], direction: 'under' },
] as const)('tells a $label first body its exact count, the range, every scene count and a proportional rescale, with the length repair line', async ({ limits, sceneCounts, direction }) => {
  const fixture = await useWritingFixture({ executionLimits: limits, intervene: scaledFirstBody(sceneCounts) })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const { minChapterWords: min, maxChapterWords: max } = limits
  const total = sceneCounts.reduce((sum, count) => sum + count, 0)
  // The host's own measurement of the rejected first body and its scene counts from the same Story counter agree exactly: separators add no words.
  const rejected = fixture.service.getManuscript(fixture.actor, fixture.novel.id).history.find(item => item.artifact.kind === 'body' && item.length?.blocking)
  if (rejected === undefined) throw new Error('Expected a length-blocked first body')
  const saved = StageOutputSchemas.body.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: rejected.artifact.id }).text))
  expect(saved.scenes.map(scene => countStoryWords(scene.text))).toEqual(sceneCounts)
  expect(saved.scenes.reduce((sum, scene) => sum + countStoryWords(scene.text), 0)).toBe(rejected.wordCount)
  expect(rejected.wordCount).toBe(total)
  const bodies = [...fixture.stages.entries()].filter(([, stage]) => stage.kind === 'body')
  expect(bodies).toHaveLength(2)
  const [firstId, first] = bodies[0]!
  const [repairId, repair] = bodies[1]!
  const line = rangeLines(min, max).body
  const firstRequirements = loggedRequirements(await loggedPrompt(fixture, firstId))
  expect(firstRequirements).toContain(line)
  expect(firstRequirements).not.toContain(lengthRepairLine)
  expect(firstRequirements).not.toContain(reviewRepairLine)
  expect(first.task?.validationError ?? null).toBeNull()
  const gap = direction === 'over' ? `${total - max} over the maximum` : `${min - total} under the minimum`
  expect(repair.task?.validationError).toBe(`The host counted ${total} Story-counted words (accepted ${min}–${max}): ${gap}. Scene counts: chapter-1-scene-1 ${sceneCounts[0]}, chapter-1-scene-2 ${sceneCounts[1]}, chapter-1-scene-3 ${sceneCounts[2]}. Return the complete chapter at about ${Math.round((min + max) / 2)} words by ${direction === 'over' ? 'condensing' : 'expanding'} every scene proportionally; keep every required event, scene identity and the chapter's actual outcome.`)
  const repairRequirements = loggedRequirements(await loggedPrompt(fixture, repairId))
  expect(repairRequirements).toContain(line)
  expect(repairRequirements).toContain(lengthRepairLine)
  expect(repairRequirements.some(item => item.includes('Preserve unaffected facts and passages'))).toBe(false)
})

it.each(['settings-dimension', 'book-outline', 'body'] as const)('keeps the review repair line, and for generated stages the review message, when a %s review blocks', async reviewedKind => {
  let blocked = false
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (blocked || stage.kind !== 'review' || stage.task?.reviewed === undefined || stage.sources.get(stage.task.reviewed.artifactId)?.kind !== reviewedKind) return output
    blocked = true
    const review = StageOutputSchemas.review.parse(output)
    return { ...review, issues: [{ id: 'conflict', category: review.checks[0]!.category, severity: 'blocking', location: 'First scene', message: 'A required character constraint is contradicted.', evidence: review.checks[0]!.evidence }] }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const generatedKind = reviewedKind === 'settings-dimension' ? 'settings' : reviewedKind
  const generated = [...fixture.stages.entries()].filter(([, stage]) => stage.kind === generatedKind)
  expect(generated).toHaveLength(2)
  const [repairId, repair] = generated[1]!
  const requirements = loggedRequirements(await loggedPrompt(fixture, repairId))
  expect(requirements).toContain(reviewRepairLine)
  expect(requirements).not.toContain(lengthRepairLine)
  if (generatedKind !== 'settings') expect(repair.task?.validationError).toBe('Resolve the blocking issues in the exact supplied review.')
})

it('keeps the unmet-obligation message and the review repair line for a continuity repair', async () => {
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (stage.kind !== 'continuity') return output
    const continuity = StageOutputSchemas.continuity.parse(output)
    if ((stage.task?.validationError ?? null) === null) return { ...continuity, obligations: continuity.obligations.map(item => ({ ...item, status: 'open' as const })) }
    // The fixture's generator reads the attached same-chapter feedback as a prior chapter's continuity and cites it; the repair cites the body instead.
    const bodyId = stage.task!.bodyId!
    const evidence = [{ artifactId: bodyId, quote: StageOutputSchemas.body.parse(JSON.parse(stage.sources.get(bodyId)!.text)).scenes[0]!.text.slice(0, 100) }]
    return { ...continuity, timeline: [{ event: `Chapter ${continuity.chapterNumber} is investigated.`, evidence }] }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const continuities = [...fixture.stages.entries()].filter(([, stage]) => stage.kind === 'continuity')
  expect(continuities).toHaveLength(2)
  const [repairId, repair] = continuities[1]!
  expect(repair.task?.validationError).toBe('Every required event for this chapter must be fulfilled by the actual reviewed prose: not fulfilled signal-1 (open).')
  const requirements = loggedRequirements(await loggedPrompt(fixture, repairId))
  expect(requirements).toContain(reviewRepairLine)
  expect(requirements).not.toContain(lengthRepairLine)
})

it('replays a length repair on resume from the saved counts, preparing no different request for the saved repair attempt', async () => {
  let failed = false
  const fixture = await useWritingFixture({ intervene: scaledFirstBody([2200, 1899, 1500]), injectFinish(stage) {
    if (failed || stage.kind !== 'review' || stage.task?.reviewed === undefined || stage.sources.get(stage.task.reviewed.artifactId)?.kind !== 'body') return undefined
    failed = true
    return { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture-injected later stage failure.' } }
  } })
  const first = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (first.status === 'rejected') throw first.reason
  expect(first.value.status).toBe('failed')
  const bodiesBefore = [...fixture.stages.values()].filter(stage => stage.kind === 'body').length
  expect(bodiesBefore).toBe(2)
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, first.value.id, true))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.error).toBeNull()
  expect(resumed.value.status).toBe('completed')
  expect([...fixture.stages.values()].filter(stage => stage.kind === 'body')).toHaveLength(bodiesBefore)
})

it('fails a writing run clearly when a stage child could see a subagent dispatch tool, without dispatching it', async () => {
  const fixture = await useWritingFixture()
  const dispatched: string[] = []
  fixture.ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== fixture.parent.session.id) return
    // A per-Agent delegation tool lands in the child's own scope, where the inherited-tool allow list cannot remove it.
    agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
      name: 'subagent', description: 'Delegate a self-contained task to a subagent.',
      parameters: { prompt: { type: 'string', required: true } }, isConcurrencySafe: () => true,
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Delegated.' }] },
      execute: async args => { dispatched.push(args.prompt); return true },
    })))
  }, { global: true })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('can see tools outside its allow list (subagent)')
  expect(outcome.value.attempts).toHaveLength(1)
  expect(outcome.value.attempts[0]).toMatchObject({ status: 'failed', output: null })
  expect(fixture.childRequests).toHaveLength(0)
  expect(dispatched).toEqual([])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('retries a chapter body turn that ended without its structured result under the same key and completes the run', async () => {
  let injected = false
  const fixture = await useWritingFixture({ injectFinish(stage) {
    if (stage.kind !== 'body' || injected) return undefined
    injected = true
    return { kind: 'stop' }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  const attempts = outcome.value.attempts.filter(item => item.key === 'body/1/candidate/0')
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({ status: 'failed', output: null, error: 'Writing stage turn ended without returning its structured result' })
  expect(attempts[1]).toMatchObject({ status: 'succeeded' })
  expect(outcome.value.attempts.some(item => item.key === 'body/1/candidate/1')).toBe(false)
  const bodyChildren = [...fixture.stages.values()].filter(stage => stage.kind === 'body')
  expect(bodyChildren).toHaveLength(2)
  expect(bodyChildren.every(stage => (stage.task?.validationError ?? null) === null)).toBe(true)
})

it('fails the run clearly once review turns without a structured result exhaust their automatic retries', async () => {
  const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 2 }, injectFinish(stage) {
    return stage.kind === 'review' ? { kind: 'stop' } : undefined
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('Writing stage turn ended without returning its structured result; stage settings/0/a1/candidate/0/review/0 failed after 2 automatic retries')
  const attempts = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0/review/0')
  expect(attempts).toHaveLength(3)
  expect(attempts.every(item => item.status === 'failed' && item.output === null)).toBe(true)
  expect(outcome.value.attempts.some(item => item.key === 'settings/0/a1/candidate/0/review/1')).toBe(false)
  expect(outcome.value.attempts.every(item => item.status !== 'unknown')).toBe(true)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied).toEqual([])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  // The failure is a known outcome, so an explicit resume needs no permission to resend an uncertain call.
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, outcome.value.id, false))
  if (resumed.status === 'rejected') throw resumed.reason
  expect(resumed.value.status).toBe('failed')
  expect(resumed.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0/review/0')).toHaveLength(6)
})

it('does not retry a missing structured result when the repair budget is zero', async () => {
  const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 0 }, injectFinish(stage) {
    return stage.kind === 'settings' ? { kind: 'stop' } : undefined
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('failed after 0 automatic retries')
  expect(outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')).toEqual([expect.objectContaining({ status: 'failed' })])
})

it('fails the run with an explicit truncated attempt when a chapter body is cut off at the output-token limit', async () => {
  const fixture = await useWritingFixture({ injectFinish(stage) {
    return stage.kind === 'body' ? { kind: 'max-tokens' } : undefined
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toBe("Writing stage output was truncated at the model's output-token limit before a complete structured result")
  const attempts = outcome.value.attempts.filter(item => item.key === 'body/1/candidate/0')
  expect(attempts).toEqual([expect.objectContaining({ status: 'failed', output: null, failureKind: 'truncated' })])
  expect(outcome.value.attempts.filter(item => item.failureKind !== undefined)).toHaveLength(1)
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  expect(manuscript.history.some(candidate => candidate.target.kind === 'body')).toBe(false)
  expect(manuscript.appliedChapters).toEqual([])
  // Durable readback from the reopened run store keeps the explicit classification.
  const reopened = await fixture.run(exec => fixture.runner.resume(exec, outcome.value.id, false))
  if (reopened.status === 'rejected') throw reopened.reason
  expect(reopened.value.attempts.filter(item => item.key === 'body/1/candidate/0').map(item => item.failureKind)).toEqual(['truncated', 'truncated'])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('records a provider refusal as an explicit refused attempt instead of retrying it as a malformed response', async () => {
  const fixture = await useWritingFixture({ injectFinish(stage) {
    return stage.kind === 'settings' ? { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: unsupported stop reason refusal' } } : undefined
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.error).toContain('Writing stage was refused (MALFORMED_RESPONSE: DeepSeek Messages stream: unsupported stop reason refusal)')
  const attempts = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
  expect(attempts).toEqual([expect.objectContaining({ status: 'failed', output: null, failureKind: 'refused' })])
  expect(attempts[0]!.error).not.toContain('could not be decoded')
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).history).toEqual([])
})

