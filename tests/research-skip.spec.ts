/** Research is off unless enabled, and a low remaining call budget skips it without failing settings. Settings official retrieval still runs. */
import { expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { WebError } from '@deepseek-ai/dsh-web'
import { useWritingFixture } from './support/writing-fixture.ts'

const harborSearch = async () => ({
  content: 'A harbor light marks the channel.',
  sources: [{ url: 'https://example.test/harbor', title: 'Harbor', snippet: 'The stone mole shelters the channel.' }],
  truncated: false,
})

async function runSkipped(options: Parameters<typeof useWritingFixture>[0] = {}) {
  const official: string[] = []
  const fixture = await useWritingFixture(options)
  fixture.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'web_search' || exec.name === 'web_fetch') official.push(`${exec.name}:${JSON.stringify(exec.arguments)}`)
    return next()
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  return { fixture, run: outcome.value, official }
}

function promptText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}

function settingsPrompt(fixture: Awaited<ReturnType<typeof useWritingFixture>>): string {
  const settings = [...fixture.stages.values()].find(stage => stage.kind === 'settings')
  const request = fixture.childRequests.find(item => item.sessionId === settings?.sessionId)
  return request === undefined ? '' : promptText(request)
}

function expectNoResearchChildren(fixture: Awaited<ReturnType<typeof useWritingFixture>>): void {
  expect([...fixture.stages.values()].some(stage => stage.kind === 'research' || stage.kind === 'research-planning')).toBe(false)
}

function expectSettingsOnlyRetrieval(fixture: Awaited<ReturnType<typeof useWritingFixture>>, official: readonly string[]): void {
  const searches = official.filter(call => call.startsWith('web_search:'))
  expect(searches.length).toBeGreaterThan(0)
  expect(searches.every(call => call.includes('Settings for'))).toBe(true)
  for (const request of fixture.childRequests) {
    const text = promptText(request)
    if (text.includes('officialRetrieval')) expect(text).toContain('"kind": "settings"')
  }
}

it('completes a chapter with research disabled and still passes official settings text to the candidate', async () => {
  const { fixture, run, official } = await runSkipped({ executionLimits: { researchEnabled: false }, webSearch: harborSearch })
  expect(run.status).toBe('completed')
  expectNoResearchChildren(fixture)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.some(item => item.dimensionCode === 'a1' && !item.stale)).toBe(true)
  const research = fixture.service.listResearch(fixture.actor, fixture.novel.id)
  expect(research.length).toBeGreaterThan(0)
  expect(research.every(plan => plan.outcome === 'not-needed' && plan.reservedCalls.length === 0)).toBe(true)
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toHaveLength(1)
  expectSettingsOnlyRetrieval(fixture, official)
  expect(official.some(call => call.startsWith('web_fetch:') && call.includes('https://example.test/harbor'))).toBe(true)
  expect(settingsPrompt(fixture)).toContain('officialRetrieval')
  expect(settingsPrompt(fixture)).toContain('The stone mole shelters the channel.')
  expect([...fixture.stages.values()].some(stage => stage.kind === 'book-outline')).toBe(true)
  expect([...fixture.stages.values()].some(stage => stage.kind === 'chapter-outline')).toBe(true)
  expect([...fixture.stages.values()].some(stage => stage.kind === 'body')).toBe(true)
})

it('skips research below the call-budget floor and still passes official settings text to the candidate', async () => {
  const { fixture, run, official } = await runSkipped({ executionLimits: { researchEnabled: true, researchBudgetFloor: 5 }, webSearch: harborSearch })
  expect(run.status).toBe('completed')
  expectNoResearchChildren(fixture)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.length).toBeGreaterThan(0)
  expectSettingsOnlyRetrieval(fixture, official)
  expect(settingsPrompt(fixture)).toContain('The stone mole shelters the channel.')
})

it.each([
  ['provider unavailable', () => { throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE') }],
  ['quota billing', () => { throw new Error('HTTP 402 quota exceeded for this billing account') }],
] as const)('continues settings when research is disabled and official retrieval is %s', async (_label, search) => {
  const { fixture, run, official } = await runSkipped({ executionLimits: { researchEnabled: false }, webSearch: search })
  expect(run.status).toBe('completed')
  expect(run.error).toBeNull()
  expectNoResearchChildren(fixture)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.some(item => item.dimensionCode === 'a1' && !item.stale)).toBe(true)
  expect(official.some(call => call.startsWith('web_search:') && call.includes('Settings for'))).toBe(true)
  expect(settingsPrompt(fixture)).not.toContain('officialRetrieval')
})

it('continues settings when research is disabled and official web tools are not registered', async () => {
  const { fixture, run, official } = await runSkipped({ executionLimits: { researchEnabled: false }, registerWebTools: false })
  expect(run.status).toBe('completed')
  expect(run.error).toBeNull()
  expectNoResearchChildren(fixture)
  expect(official).toEqual([])
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.some(item => item.dimensionCode === 'a1' && !item.stale)).toBe(true)
  expect(settingsPrompt(fixture)).not.toContain('officialRetrieval')
})

it('keeps a non-quota retrieval failure fail-close when research is disabled', async () => {
  const { fixture, run } = await runSkipped({ executionLimits: { researchEnabled: false }, webSearch: async () => { throw new Error('socket hang up') } })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('socket hang up')
  expect(run.attempts.some(attempt => attempt.key.startsWith('settings/batch/'))).toBe(false)
  expect(run.attempts.some(attempt => attempt.key.startsWith('settings/0/a1/candidate'))).toBe(false)
  expectNoResearchChildren(fixture)
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied).toEqual([])
})
