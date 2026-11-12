import { expect, it, vi } from 'vitest'
import * as Story from '../src/index.ts'
import { REVIEW_STAGE_TIMEOUT_MS, settingsLayerWidth } from '../src/writing-runner.ts'
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

it('publishes a settings candidate count of 1 and keeps the non-review stage deadline', () => {
  const config = new Story.Config()
  expect(config.settingsCandidateCount).toBe(1)
  expect(config.stageTimeoutMs).toBe(600_000)
  expect(config.maxParallelStages).toBe(3)
  expect(REVIEW_STAGE_TIMEOUT_MS).toBe(1_200_000)
  expect(settingsLayerWidth({ maxParallelStages: 3, settingsCandidateCount: 1 })).toBe(1)
  expect(settingsLayerWidth({ maxParallelStages: 3 })).toBe(1)
  expect(settingsLayerWidth({ maxParallelStages: 2, settingsCandidateCount: 2 })).toBe(2)
})

it('starts one settings dimension at a time when the run records the default candidate count', async () => {
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
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(fixture.runner.limits.settingsCandidateCount).toBe(1)
    expect(fixture.runner.limits.maxParallelStages).toBe(2)
    expect([...fixture.stages.values()].some(stage => dimensionOf(stage) === 'a3')).toBe(false)
  } finally { release() }
  const outcome = await pending
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.executionLimits.settingsCandidateCount).toBe(1)
  expect(outcome.value.executionLimits.maxParallelStages).toBe(2)
  expect([...fixture.stages.values()].some(stage => dimensionOf(stage) === 'a3')).toBe(true)
}, 120_000)

it('schedules a 1200s review deadline and leaves every other stage on its configured timeout', async () => {
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
    const reviews = [...fixture.stages.values()].filter(stage => stage.kind === 'review')
    const others = [...fixture.stages.values()].filter(stage => stage.kind !== 'review')
    expect(reviews.length).toBeGreaterThan(0)
    expect(others.length).toBeGreaterThan(0)
    expect(delays.filter(delay => delay === REVIEW_STAGE_TIMEOUT_MS)).toHaveLength(reviews.length)
    expect(delays.filter(delay => delay === OTHER_STAGE_TIMEOUT_MS)).toHaveLength(others.length)
    expect(delays).not.toContain(600_000)
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

it('keeps a non-review stage timeout fail-closed with retryAuthorized false', async () => {
  const entered = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({
    executionLimits: { stageTimeoutMs: 5_000 },
    pauseChild: stage => {
      if (stage.kind !== 'settings') return undefined
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
    const attempts = outcome.value.attempts.filter(item => item.key === 'settings/0/a1/candidate/0')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ status: 'unknown', retryAuthorized: false })
    expect(attempts[0]?.error).toContain('Writing stage exceeded its execution deadline')
    expect(outcome.value.attempts.some(item => item.key.includes('/review/'))).toBe(false)
    expect(outcome.value.attempts.some(item => item.retryAuthorized)).toBe(false)
  } finally { vi.useRealTimers() }
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
