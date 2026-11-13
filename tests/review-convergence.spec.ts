/** Outline and manuscript reviews apply the previous candidate when the blocking-issue count does not fall. */
import { expect, it } from 'vitest'
import { checklistRepairDecision } from '../src/open-dimension-checklist.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

it('stops a non-decreasing outline or manuscript fail count and keeps the g4 rise rule', () => {
  expect(checklistRepairDecision(1, 1, 'does-not-decrease')).toBe('apply-previous')
  expect(checklistRepairDecision(2, 3, 'does-not-decrease')).toBe('apply-previous')
  expect(checklistRepairDecision(2, 1, 'does-not-decrease')).toBe('continue')
  expect(checklistRepairDecision(null, 2, 'does-not-decrease')).toBe('continue')
  expect(checklistRepairDecision(1, 0, 'does-not-decrease')).toBe('apply-next')
  expect(checklistRepairDecision(2, 2)).toBe('continue')
  expect(checklistRepairDecision(2, 3)).toBe('apply-previous')
})

it('applies the previous book outline when the next review does not reduce the blocking-issue count', async () => {
  let reviews = 0
  const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 2 }, intervene(stage, output) {
    if (stage.kind !== 'review' || stage.task?.reviewed === undefined || stage.sources.get(stage.task.reviewed.artifactId)?.kind !== 'book-outline') return output
    reviews += 1
    if (reviews > 2) return output
    const review = output as { checks: { evidence: unknown[] }[] }
    return { ...review, issues: [{ id: reviews === 1 ? 'arc-a' : 'arc-b', category: 'consistency', severity: 'blocking', location: '人物弧', message: reviews === 1 ? '人物关系与已接受设定矛盾。' : '另一处人物关系与已接受设定矛盾。', evidence: review.checks[0]!.evidence }] }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(reviews).toBe(2)
  const keys = outcome.value.attempts.map(item => item.key)
  expect(keys).toContain('book-outline/book/candidate/0')
  expect(keys).toContain('book-outline/book/candidate/1')
  expect(keys.some(key => key.startsWith('book-outline/book/candidate/2'))).toBe(false)
  const head = fixture.service.getManuscript(fixture.actor, fixture.novel.id).heads.find(item => item.target.kind === 'book-outline')
  const first = outcome.value.attempts.find(item => item.key === 'book-outline/book/candidate/0' && item.status === 'succeeded')
  expect(head?.childSessionId).toBe(first?.childSessionId)
}, 180_000)
