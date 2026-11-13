import { expect, it, vi } from 'vitest'
import * as Story from '../src/index.ts'
import { BODY_STAGE_TIMEOUT_MS, CANDIDATE_STAGE_TIMEOUT_MS, PLANNING_STAGE_TIMEOUT_MS, REPAIR_STAGE_TIMEOUT_MS, REVIEW_STAGE_TIMEOUT_MS, dimensionWidth, gradedStageOf, settingsCandidatesPerDimension, stageDeadlineMs } from '../src/writing-runner.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const OTHER_STAGE_TIMEOUT_MS = 54_321

function dimensionOf(stage: WritingFixtureStage): string | undefined {
  if (stage.task?.dimensionCode !== undefined) return stage.task.dimensionCode
  if (stage.data.kind === 'research' || stage.data.kind === 'research-planning') return /settings dimension ([a-z][a-z0-9]*)/.exec(stage.data.purpose)?.[1]
  return undefined
}

async function until(ready: () => boolean): Promise<void> {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > 20_000) throw new Error('The fixture did not reach the expected stage')
    await new Promise(resolve => { setImmediate(resolve) })
  }
}

it('keeps one candidate per dimension and sizes the layer by maxParallelStages alone', () => {
  const config = new Story.Config()
  expect(config.settingsCandidateCount).toBe(1)
  expect(config.stageTimeoutMs).toBe(600_000)
  expect(config.maxParallelStages).toBe(3)
  expect(PLANNING_STAGE_TIMEOUT_MS).toBe(600_000)
  expect(CANDIDATE_STAGE_TIMEOUT_MS).toBe(600_000)
  expect(REVIEW_STAGE_TIMEOUT_MS).toBe(1_200_000)
  expect(BODY_STAGE_TIMEOUT_MS).toBe(1_800_000)
  expect(REPAIR_STAGE_TIMEOUT_MS).toBe(900_000)
  const limits = { maxParallelStages: 3, settingsCandidateCount: 1 }
  expect(dimensionWidth(limits)).toBe(3)
  expect(dimensionWidth({ maxParallelStages: 2 })).toBe(2)
  expect(settingsCandidatesPerDimension(limits)).toBe(1)
  expect(settingsCandidatesPerDimension({})).toBe(1)
  expect(settingsCandidatesPerDimension({ settingsCandidateCount: 4 })).toBe(4)
  expect(gradedStageOf('settings/0/a1/research/planning')).toBe('planning')
  expect(gradedStageOf('settings/0/a1/research/planning/1')).toBe('planning')
  expect(gradedStageOf('book-outline/book/research')).toBeUndefined()
  expect(gradedStageOf('settings/0/a1/research/repair/1')).toBe('repair')
  expect(gradedStageOf('settings/0/a1/candidate/0')).toBe('candidate')
  expect(gradedStageOf('settings/0/a1/candidate/0/n/1')).toBe('candidate')
  expect(gradedStageOf('chapter-outline/1/candidate/1')).toBe('repair')
  expect(gradedStageOf('body/1/candidate/0')).toBe('body')
  expect(gradedStageOf('body/1/candidate/1')).toBe('body')
  expect(gradedStageOf('body/1/candidate/0/review/0')).toBe('review')
  expect(gradedStageOf('body/1/candidate/0/review/1/citations')).toBe('repair')
  expect(stageDeadlineMs('body/1/candidate/0', OTHER_STAGE_TIMEOUT_MS)).toBe(BODY_STAGE_TIMEOUT_MS)
  expect(stageDeadlineMs('book-outline/book/research', OTHER_STAGE_TIMEOUT_MS)).toBe(OTHER_STAGE_TIMEOUT_MS)
  expect(stageDeadlineMs('settings/0/a1/candidate/1', OTHER_STAGE_TIMEOUT_MS)).toBe(REPAIR_STAGE_TIMEOUT_MS)
})

it('starts every dimension in a layer up to maxParallelStages when the candidate count stays 1', async () => {
  let release = () => {}
  let heldA2 = false
  const fixture = await useWritingFixture({
    pauseChild: stage => {
      if (dimensionOf(stage) !== 'a2' || heldA2) return undefined
      heldA2 = true
      return new Promise<void>(resolve => { release = resolve })
    },
  })
  const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a2', 'a3'], chapterCount: 1, throughChapter: 1 }))
  try {
    await until(() => heldA2)
    await until(() => [...fixture.stages.values()].some(stage => dimensionOf(stage) === 'a3'))
    expect(fixture.runner.limits.settingsCandidateCount).toBe(1)
    expect(fixture.runner.limits.maxParallelStages).toBe(2)
    expect(dimensionWidth(fixture.runner.limits)).toBe(2)
  } finally { release() }
  const outcome = await pending
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.executionLimits.settingsCandidateCount).toBe(1)
  expect(outcome.value.executionLimits.maxParallelStages).toBe(2)
  expect(outcome.value.attempts.some(item => item.key === 'settings/0/a1/candidate/0')).toBe(true)
  expect(outcome.value.attempts.some(item => item.key.includes('/candidate/0/n/'))).toBe(false)
}, 120_000)

it('does not widen a layer when settingsCandidateCount is larger than maxParallelStages', async () => {
  let release = () => {}
  let heldA2 = false
  const fixture = await useWritingFixture({
    executionLimits: { maxParallelStages: 1, settingsCandidateCount: 2 },
    pauseChild: stage => {
      if (dimensionOf(stage) !== 'a2' || heldA2) return undefined
      heldA2 = true
      return new Promise<void>(resolve => { release = resolve })
    },
  })
  const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a2', 'a3'], chapterCount: 1, throughChapter: 1 }))
  try {
    await until(() => heldA2)
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(dimensionWidth(fixture.runner.limits)).toBe(1)
    expect(settingsCandidatesPerDimension(fixture.runner.limits)).toBe(2)
    expect([...fixture.stages.values()].some(stage => dimensionOf(stage) === 'a3')).toBe(false)
  } finally { release() }
  const outcome = await pending
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const a2Slots = outcome.value.attempts.filter(item => /^settings\/0\/a2\/candidate\/0\/n\/\d+$/.test(item.key)).map(item => item.key).sort()
  expect(a2Slots).toEqual(['settings/0/a2/candidate/0/n/0', 'settings/0/a2/candidate/0/n/1'])
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.filter(item => item.dimensionCode === 'a2')).toHaveLength(1)
  const a2History = fixture.service.getSettings(fixture.actor, fixture.novel.id).history.filter(item => item.dimensionCode === 'a2')
  expect(a2History.map(item => item.status).sort()).toEqual(['applied', 'reviewed'])
}, 120_000)

it('schedules each graded deadline and leaves research execution on its configured timeout', async () => {
  const delays: number[] = []
  const original = globalThis.setTimeout
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof timeout === 'number') delays.push(timeout)
    return original(handler, timeout, ...args)
  }) as typeof setTimeout)
  try {
    const fixture = await useWritingFixture({ executionLimits: { stageTimeoutMs: OTHER_STAGE_TIMEOUT_MS } })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.executionLimits.stageTimeoutMs).toBe(OTHER_STAGE_TIMEOUT_MS)
    const expected = outcome.value.attempts.filter(item => item.status === 'succeeded').map(item => stageDeadlineMs(item.key, OTHER_STAGE_TIMEOUT_MS))
    for (const deadline of [PLANNING_STAGE_TIMEOUT_MS, CANDIDATE_STAGE_TIMEOUT_MS, REVIEW_STAGE_TIMEOUT_MS, BODY_STAGE_TIMEOUT_MS, REPAIR_STAGE_TIMEOUT_MS, OTHER_STAGE_TIMEOUT_MS]) {
      expect(delays.filter(delay => delay === deadline)).toHaveLength(expected.filter(delay => delay === deadline).length)
    }
    expect(expected.filter(delay => delay === BODY_STAGE_TIMEOUT_MS).length).toBeGreaterThan(0)
    expect(expected.filter(delay => delay === REVIEW_STAGE_TIMEOUT_MS).length).toBeGreaterThan(0)
    expect(expected.filter(delay => delay === OTHER_STAGE_TIMEOUT_MS).length).toBeGreaterThan(0)
    expect(expected).not.toContain(REPAIR_STAGE_TIMEOUT_MS)
  } finally { spy.mockRestore() }
}, 120_000)

it('authorizes exactly one review execution timeout and can succeed on that retry', async () => {
  let held = false
  const entered = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({
    pauseChild: stage => {
      if (stage.kind !== 'review' || held) return undefined
      held = true
      entered.resolve()
      return new Promise(() => {})
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    await entered.promise
    await vi.advanceTimersByTimeAsync(REVIEW_STAGE_TIMEOUT_MS)
    const outcome = await pending
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    const reviews = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0/review/0')
    expect(reviews.map(item => item.status)).toEqual(['unknown', 'succeeded'])
    expect(reviews.map(item => item.retryAuthorized)).toEqual([false, false])
    expect(outcome.value.attempts.some(item => item.key === 'settings/0/a1/candidate/0/review/1')).toBe(false)
    expect(reviews[0]?.error).toContain('Writing stage exceeded its execution deadline')
  } finally { vi.useRealTimers() }
}, 120_000)

it('fails closed when a review execution times out twice', async () => {
  const entered: PromiseWithResolvers<void>[] = []
  const fixture = await useWritingFixture({
    pauseChild: stage => {
      if (stage.kind !== 'review') return undefined
      const gate = Promise.withResolvers<void>()
      entered.push(gate)
      gate.resolve()
      return new Promise(() => {})
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    await until(() => entered.length >= 1)
    await entered[0]?.promise
    await vi.advanceTimersByTimeAsync(REVIEW_STAGE_TIMEOUT_MS)
    await until(() => entered.length >= 2)
    await vi.advanceTimersByTimeAsync(REVIEW_STAGE_TIMEOUT_MS)
    const outcome = await pending
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('failed')
    const reviews = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0/review/0')
    expect(reviews).toHaveLength(2)
    expect(reviews.map(item => item.status)).toEqual(['unknown', 'unknown'])
    expect(reviews.map(item => item.retryAuthorized)).toEqual([false, false])
    expect(outcome.value.attempts.some(item => item.key.startsWith('settings/0/a1/candidate/0/review/1'))).toBe(false)
    expect(entered).toHaveLength(2)
    expect(outcome.value.error).toContain('Writing stage exceeded its execution deadline')
  } finally { vi.useRealTimers() }
}, 120_000)

it('keeps a research execution timeout fail-closed with retryAuthorized false', async () => {
  const entered = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({
    executionLimits: { stageTimeoutMs: 5_000 },
    pauseChild: stage => {
      if (stage.kind !== 'research') return undefined
      entered.resolve()
      return new Promise(() => {})
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    await entered.promise
    await vi.advanceTimersByTimeAsync(5_000)
    const outcome = await pending
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('failed')
    const attempts = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/research')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ status: 'unknown', retryAuthorized: false })
    expect(attempts[0]?.error).toContain('Writing stage exceeded its execution deadline')
    expect(outcome.value.attempts.some(item => item.key.includes('/candidate/'))).toBe(false)
    expect(outcome.value.attempts.some(item => item.retryAuthorized)).toBe(false)
  } finally { vi.useRealTimers() }
}, 120_000)

it('authorizes exactly one settings candidate execution timeout and can succeed on that retry', async () => {
  let held = false
  const entered = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({
    pauseChild: stage => {
      if (stage.kind !== 'settings' || held) return undefined
      held = true
      entered.resolve()
      return new Promise(() => {})
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    await entered.promise
    await vi.advanceTimersByTimeAsync(CANDIDATE_STAGE_TIMEOUT_MS)
    const outcome = await pending
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    const candidates = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
    expect(candidates.map(item => item.status)).toEqual(['unknown', 'succeeded'])
    expect(candidates.map(item => item.retryAuthorized)).toEqual([false, false])
    expect(candidates[0]?.error).toContain('Writing stage exceeded its execution deadline')
  } finally { vi.useRealTimers() }
}, 120_000)

it('fails closed when a settings candidate execution times out twice', async () => {
  const entered: PromiseWithResolvers<void>[] = []
  const fixture = await useWritingFixture({
    pauseChild: stage => {
      if (stage.kind !== 'settings') return undefined
      const gate = Promise.withResolvers<void>()
      entered.push(gate)
      gate.resolve()
      return new Promise(() => {})
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    await until(() => entered.length >= 1)
    await entered[0]?.promise
    await vi.advanceTimersByTimeAsync(CANDIDATE_STAGE_TIMEOUT_MS)
    await until(() => entered.length >= 2)
    await vi.advanceTimersByTimeAsync(CANDIDATE_STAGE_TIMEOUT_MS)
    const outcome = await pending
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('failed')
    const candidates = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
    expect(candidates).toHaveLength(2)
    expect(candidates.map(item => item.status)).toEqual(['unknown', 'unknown'])
    expect(candidates.map(item => item.retryAuthorized)).toEqual([false, false])
    expect(outcome.value.error).toContain('Writing stage exceeded its execution deadline')
  } finally { vi.useRealTimers() }
}, 120_000)

it('cancels a graded stage on story_stop without authorizing its timeout retry', async () => {
  const entered = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({
    pauseChild: stage => {
      if (stage.kind !== 'settings') return undefined
      entered.resolve()
      return new Promise(() => {})
    },
  })
  const outcome = await fixture.run(async exec => {
    const running = fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 })
    await Promise.race([
      entered.promise,
      running.then(result => { throw new Error(`Writing finished before the settings candidate: ${result.error}`) }),
    ])
    const run = fixture.runs.list(fixture.actor, fixture.novel.id)[0]
    if (run === undefined) throw new Error('Writing run was not persisted')
    const stopped = await fixture.runner.stop(exec, run.id)
    expect(await running).toEqual(stopped)
    return stopped
  })
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('stopped')
  const candidates = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
  expect(candidates).toHaveLength(1)
  expect(candidates[0]).toMatchObject({ retryAuthorized: false })
  expect(candidates[0]?.error ?? '').not.toContain('execution deadline')
  expect(outcome.value.attempts.some(item => item.retryAuthorized)).toBe(false)
}, 120_000)

it('keeps a non-timeout review failure fail-closed with retryAuthorized false', async () => {
  const fixture = await useWritingFixture({
    injectFinish(stage) {
      if (stage.kind !== 'review') return undefined
      return { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture review failed without a timeout.' } }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  const reviews = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0/review/0')
  expect(reviews).toHaveLength(1)
  expect(reviews[0]).toMatchObject({ status: 'unknown', retryAuthorized: false })
  expect(reviews[0]?.error).toContain('Writing stage ended without a complete structured result')
  expect(reviews[0]?.error).not.toContain('execution deadline')
  expect(outcome.value.attempts.some(item => item.key.startsWith('settings/0/a1/candidate/0/review/1'))).toBe(false)
  expect(outcome.value.attempts.some(item => item.retryAuthorized)).toBe(false)
}, 120_000)
