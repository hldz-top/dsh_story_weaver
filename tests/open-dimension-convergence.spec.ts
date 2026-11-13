/** g4 repair stops and applies the held candidate when the fail count rises. */
import { expect, it } from 'vitest'
import { openChecklistItems } from '../src/open-dimension-checklist.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

function g4Review(stage: WritingFixtureStage): boolean {
  return stage.kind === 'review' && stage.task?.checklistItems?.some(item => item.id.startsWith('g4-')) === true
}

it('applies the held g4 candidate when the next checklist has more fails', async () => {
  let reviews = 0
  const fixture = await useWritingFixture({ intervene(stage, output) {
    if (!g4Review(stage)) return output
    reviews += 1
    const paragraphId = stage.task?.paragraphs?.[0]?.id
    if (paragraphId === undefined) throw new Error('g4 review has no paragraph split')
    const failIds = reviews === 1 ? ['g4-payoff-shown', 'g4-cost-named'] : ['g4-payoff-shown', 'g4-cost-named', 'g4-audience']
    const checklist = output as { items: { id: string }[] }
    return { ...checklist, items: checklist.items.map(item => failIds.includes(item.id) ? { id: item.id, status: 'fail', paragraphId } : { id: item.id, status: 'pass' }) }
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['g4'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(reviews).toBe(2)
  const history = fixture.service.getSettings(fixture.actor, fixture.novel.id).history.filter(item => item.dimensionCode === 'g4')
  expect(history.map(item => item.status).sort()).toEqual(['applied', 'reviewed'])
  const applied = history.find(item => item.status === 'applied')!
  const parked = history.find(item => item.status === 'reviewed')!
  const failCount = (id: typeof applied.review) => {
    if (id === null) throw new Error('g4 candidate has no review')
    return (JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: id.id }).text) as { checklist: { failCount: number } }).checklist.failCount
  }
  expect(failCount(applied.review)).toBe(2)
  expect(failCount(parked.review)).toBe(3)
}, 300_000)

/** Fail counts for line 0 and line 1, each `[first review, repair review]`. */
async function runParallelG4(plan: readonly [readonly [number, number], readonly [number, number]], appliedFails: number, parkedFails: number): Promise<void> {
  let fixture!: Awaited<ReturnType<typeof useWritingFixture>>
  fixture = await useWritingFixture({
    executionLimits: { settingsCandidateCount: 2, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (!g4Review(stage)) return output
      const reviewedId = stage.task?.reviewed?.artifactId
      if (reviewedId === undefined) throw new Error('g4 review has no candidate')
      const run = fixture.runs.list(fixture.actor, fixture.novel.id)[0]
      if (run === undefined) throw new Error('writing run is missing')
      const candidate = fixture.service.getSettings(fixture.actor, fixture.novel.id).history.find(item => item.artifact.id === reviewedId)
      if (candidate === undefined) throw new Error('g4 candidate is not stored')
      const attempt = fixture.runs.get(fixture.actor, run.id).attempts.find(item => item.childSessionId === candidate.childSessionId)
      if (attempt === undefined) throw new Error('g4 candidate attempt is missing')
      const slot = /\/n\/(\d+)(?:\/|$)/u.exec(attempt.key)
      const repair = /\/candidate\/(\d+)(?:\/|$)/u.exec(attempt.key)
      if (slot === null || repair === null) throw new Error(`g4 candidate key is not a parallel line: ${attempt.key}`)
      const fails = plan[Number(slot[1])]?.[Number(repair[1])]
      if (fails === undefined) throw new Error(`no fail plan for ${attempt.key}`)
      const paragraphId = stage.task?.paragraphs?.[0]?.id
      if (paragraphId === undefined) throw new Error('g4 review has no paragraph split')
      const failIds = openChecklistItems('g4').slice(0, fails).map(item => item.id)
      const checklist = output as { items: { id: string }[] }
      return { ...checklist, items: checklist.items.map(item => failIds.includes(item.id) ? { id: item.id, status: 'fail', paragraphId } : { id: item.id, status: 'pass' }) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['g4'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const keys = outcome.value.attempts.map(item => item.key)
  expect(keys).toEqual(expect.arrayContaining([
    'settings/0/g4/candidate/0/n/0', 'settings/0/g4/candidate/0/n/1',
    'settings/0/g4/candidate/1/n/0', 'settings/0/g4/candidate/1/n/1',
  ]))
  const history = fixture.service.getSettings(fixture.actor, fixture.novel.id).history.filter(item => item.dimensionCode === 'g4')
  const applied = history.find(item => item.status === 'applied')
  if (applied?.review == null) throw new Error('g4 applied candidate has no review')
  const failCount = (id: typeof applied.review) => (JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: id.id }).text) as { checklist: { failCount: number } }).checklist.failCount
  expect(failCount(applied.review)).toBe(appliedFails)
  expect(history.filter(item => item.review !== null && failCount(item.review) === parkedFails).length).toBeGreaterThan(0)
}

it('applies line 0 when its fail count rises and does not adopt line 1\'s higher count', async () => {
  await runParallelG4([[2, 3], [4, 4]], 2, 4)
}, 300_000)

it('applies line 1\'s own held candidate when only that line\'s fail count rises', async () => {
  await runParallelG4([[1, 1], [2, 3]], 2, 1)
}, 300_000)
