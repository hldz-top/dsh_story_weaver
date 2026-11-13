/** A prompt-version-7 archive from before stage routing omits writingModel, researchEnabled and researchBudgetFloor. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import * as Story from '../src/index.ts'
import { CURRENT_PROMPT_VERSION } from '../src/stage-prompts.ts'
import { normalizeWritingModel } from '../src/writing-model.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

function stageKind(request: GenerateOptions): string | undefined {
  const marker = '\n\nTASK_DATA\n\n'
  const text = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' && block.text.includes(marker) ? [block.text] : []))[0]
  if (text === undefined) return undefined
  const body = text.slice(text.indexOf(marker) + marker.length)
  const hosted = body.indexOf('\n\nHOST_INPUTS\n\n')
  return (JSON.parse(hosted < 0 ? body : body.slice(0, hosted)) as { kind?: string }).kind
}

it('resumes a pre-stage-routing archive under the default plugin limits without treating a missing research switch as false', { timeout: 120_000 }, async () => {
  const plugin = new Story.Config()
  const writingModel = normalizeWritingModel(plugin.writingModel)
  expect(plugin.writingModel).toBe('inherit')
  expect(writingModel).toEqual({ planning: 'inherit', review: 'inherit', body: 'inherit' })
  expect(plugin.researchEnabled).toBe(false)
  expect(plugin.researchBudgetFloor).toBe(1)
  expect(CURRENT_PROMPT_VERSION).toBe(7)
  // The live comparison target is what apply() stores: the inherit map, researchEnabled false and floor 1.
  // The writing fixture's own default opts research in, so this run overrides that and would mismatch an absent archive.
  const fixture = await useWritingFixture({ executionLimits: { writingModel, researchEnabled: plugin.researchEnabled, researchBudgetFloor: plugin.researchBudgetFloor } })
  expect(fixture.runner.limits.writingModel).toEqual(writingModel)
  expect(fixture.runner.limits.researchEnabled).toBe(false)
  expect(fixture.runner.limits.researchBudgetFloor).toBe(1)
  expect(fixture.service.researchLimits.maxResearchCalls).toBeGreaterThanOrEqual(1)
  const { writingModel: _model, researchEnabled: _enabled, researchBudgetFloor: _floor, ...archived } = fixture.runner.limits
  const begun = await fixture.runs.begin(fixture.actor, {
    ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null, executionLimits: archived,
    serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits },
  })
  expect(begun.promptVersion).toBe(7)
  expect(begun.executionLimits).not.toHaveProperty('writingModel')
  expect(begun.executionLimits).not.toHaveProperty('researchEnabled')
  expect(begun.executionLimits).not.toHaveProperty('researchBudgetFloor')
  const stopped = await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stopped before native work.')
  const outcome = await fixture.run(exec => fixture.runner.resume(exec, stopped.id, false))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = fixture.runs.get(fixture.actor, stopped.id)
  expect(outcome.value).toMatchObject({ status: 'completed', promptVersion: 7, id: stopped.id })
  expect(run.executionLimits).not.toHaveProperty('writingModel')
  expect(run.executionLimits).not.toHaveProperty('researchEnabled')
  expect(run.executionLimits).not.toHaveProperty('researchBudgetFloor')
  expect(run.executionLimits).toEqual(outcome.value.executionLimits)
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toHaveLength(1)
  expect(fixture.childRequests.length).toBeGreaterThan(0)
  expect(fixture.childRequests.every(request => request.provider === 'stage-fixture' && request.model === 'inherited-model')).toBe(true)
  expect(fixture.childRequests.some(request => stageKind(request) === 'body')).toBe(true)
  expect(fixture.childRequests.some(request => stageKind(request) === 'research-planning')).toBe(true)
  expect([...fixture.stages.values()].some(stage => stage.kind === 'research')).toBe(true)
  const plans = fixture.service.listResearch(fixture.actor, fixture.novel.id)
  expect(plans.length).toBeGreaterThan(0)
  expect(plans.every(plan => plan.questions.every(question => question.id !== 'research-skipped' && !question.question.includes('Research is disabled') && !question.question.includes('below the configured floor')))).toBe(true)
})
