/** Research is off unless enabled, and a low remaining call budget skips it without failing settings. */
import { expect, it } from 'vitest'
import { useWritingFixture } from './support/writing-fixture.ts'

it('completes a chapter with research disabled and does not call a research child', async () => {
  const fixture = await useWritingFixture({ executionLimits: { researchEnabled: false } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect([...fixture.stages.values()].some(stage => stage.kind === 'research' || stage.kind === 'research-planning')).toBe(false)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.some(item => item.dimensionCode === 'a1' && !item.stale)).toBe(true)
  const research = fixture.service.listResearch(fixture.actor, fixture.novel.id)
  expect(research.length).toBeGreaterThan(0)
  expect(research.every(plan => plan.outcome === 'not-needed' && plan.reservedCalls.length === 0)).toBe(true)
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toHaveLength(1)
})

it('skips research when the remaining call budget is below the floor and still applies settings', async () => {
  const fixture = await useWritingFixture({ executionLimits: { researchEnabled: true, researchBudgetFloor: 5 } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect([...fixture.stages.values()].some(stage => stage.kind === 'research' || stage.kind === 'research-planning')).toBe(false)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.length).toBeGreaterThan(0)
})
