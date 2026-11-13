import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { WebError } from '@deepseek-ai/dsh-web'
import { parseArtifactId, parseNovelId, parseRequestId } from '../src/contracts.ts'
import { buildResearchPlanningPrompt } from '../src/research-planning.ts'
import { buildResearchPrompt, researchStageTools, researchToolAuthorization, type ResearchStageRequest } from '../src/research-stage.ts'
import type { WritingService } from '../src/service.ts'
import { officialRetrievalFailureKind, settingsLocalNecessity } from '../src/settings-retrieval.ts'
import { testResearchLimits } from './support/storage.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const base: ResearchStageRequest = {
  parentSessionId: SessionId('settings-retrieval-parent'),
  novelId: parseNovelId('novel_00000000-0000-4000-8000-0000000000a1'),
  briefArtifactId: parseArtifactId('artifact_00000000-0000-4000-8000-0000000000a1'),
  purpose: 'Establish the evidence needed for settings dimension a1.',
  requestId: parseRequestId('settings-retrieval-request'),
  inputs: [{ id: parseArtifactId('artifact_00000000-0000-4000-8000-0000000000a1'), kind: 'creative-brief', revision: 1, sha256: 'b'.repeat(64), chars: 40, bytes: 80 }],
}
const inputOnly = { mode: 'input-only' as const, reason: 'The supplied premise defines this fictional output.', questions: [{ id: 'local', kind: 'creative' as const, question: 'Which fictional label fits?', reason: 'The brief already chooses it.' }], externalRequirements: [] }
const external = { mode: 'external-required' as const, reason: 'A real place name is missing.', questions: [{ id: 'place', kind: 'external' as const, question: 'Which harbor is this?', reason: 'The scene needs a real coast.' }], externalRequirements: [{ questionId: 'place', outputDecision: 'Name the harbor.', missingFact: 'The real harbor name.' }] }

it('asks settings planning for official retrieval and leaves outline planning unchanged', () => {
  const settings = buildResearchPlanningPrompt({ ...base, outputTarget: { kind: 'settings', dimensionCode: 'a1' } }, testResearchLimits)
  const outline = buildResearchPlanningPrompt({ ...base, outputTarget: { kind: 'book-outline', chapterCount: 3 } }, testResearchLimits)
  expect(settings).toContain('Do not prefer mode=input-only merely to avoid official retrieval.')
  expect(settings).toContain('web_search')
  expect(settings).toContain('web_fetch')
  expect(settings).not.toContain('A useful but optional reference is not a required question.')
  expect(outline).toContain('A useful but optional reference is not a required question.')
  expect(outline).not.toContain('Do not prefer mode=input-only merely to avoid official retrieval.')
})

it('authorizes settings research to keep official web tools after the host has invoked them', async () => {
  const settings = { ...base, necessity: inputOnly, settingsRetrieval: true as const }
  const outline = { ...base, necessity: inputOnly, purpose: 'Resolve evidence needed for a book outline.' }
  expect(researchStageTools(settings)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  expect(researchStageTools(outline)).not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  expect(researchStageTools({ ...base, necessity: inputOnly })).not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  expect(buildResearchPrompt(settings)).toContain('Official web_search and web_fetch are authorized for this settings stage.')
  expect(buildResearchPrompt(settings)).not.toContain('without web calls')
  expect(buildResearchPrompt(outline)).toContain('without web calls')
  const webCall = { name: 'web_search', arguments: { queries: ['harbor'] } } as ToolExecution
  await expect(researchToolAuthorization({} as Context, {} as WritingService, settings)(webCall)).resolves.toBeUndefined()
  await expect(researchToolAuthorization({} as Context, {} as WritingService, outline)(webCall)).rejects.toThrow('Input-only research does not authorize web calls')
})

it('classifies unavailable and quota or billing failures separately from other retrieval failures', () => {
  expect(officialRetrievalFailureKind({ code: 'WEB_PROVIDER_UNAVAILABLE', message: 'no usable web provider is registered' })).toBe('unavailable')
  expect(officialRetrievalFailureKind({ code: 'UNKNOWN_TOOL', message: 'unknown tool "web_search"' })).toBe('unavailable')
  expect(officialRetrievalFailureKind({ message: 'search failed: WEB_PROVIDER_UNAVAILABLE' })).toBe('unavailable')
  expect(officialRetrievalFailureKind({ statusCode: 402, message: 'payment rejected' })).toBe('quota')
  expect(officialRetrievalFailureKind({ message: 'HTTP 402' })).toBe('quota')
  expect(officialRetrievalFailureKind({ code: 'ACCOUNT_QUOTA', message: 'account exhausted' })).toBe('quota')
  expect(officialRetrievalFailureKind({ message: 'provider billing account is inactive' })).toBe('quota')
  expect(officialRetrievalFailureKind({ message: 'socket hang up' })).toBe('other')
})

it('reclassifies an external settings decision as local without changing an input-only decision', () => {
  expect(settingsLocalNecessity(inputOnly)).toBe(inputOnly)
  expect(settingsLocalNecessity(external)).toEqual({ mode: 'input-only', reason: external.reason, externalRequirements: [], questions: [{ ...external.questions[0], kind: 'creative' }] })
})

async function writeSettings(options: Parameters<typeof useWritingFixture>[0] = {}) {
  const official: string[] = []
  const fixture = await useWritingFixture({ maxReadChars: 8192, ...options, onChildRequest(stage, request) {
    options.onChildRequest?.(stage, request)
  } })
  fixture.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'web_search' || exec.name === 'web_fetch') official.push(`${exec.name}:${JSON.stringify(exec.arguments)}`)
    return next()
  })
  const result = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (result.status === 'rejected') throw result.reason
  return { fixture, run: result.value, official }
}

it('calls official web_search and web_fetch for settings and passes the text to the settings writer', async () => {
  const { fixture, run, official } = await writeSettings({ executionLimits: { researchEnabled: true, researchBudgetFloor: 1 }, webSearch: async () => ({ content: 'A harbor light marks the channel.', sources: [{ url: 'https://example.test/harbor', title: 'Harbor', snippet: 'The stone mole shelters the channel.' }], truncated: false }) })
  expect(run.error).toBeNull()
  expect(official.some(call => call.startsWith('web_search:'))).toBe(true)
  expect(official.some(call => call.startsWith('web_fetch:'))).toBe(true)
  expect(official.filter(call => call.startsWith('web_fetch:')).every(call => call.includes('https://example.test/harbor'))).toBe(true)
  const settings = [...fixture.stages.values()].find(stage => stage.kind === 'settings')
  const prompt = fixture.childRequests.find(request => request.sessionId === settings?.sessionId)?.messages.flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('officialRetrieval'))
  expect(prompt?.type === 'text' ? prompt.text : '').toContain('The stone mole shelters the channel.')
  expect([...fixture.stages.values()].some(stage => stage.kind === 'research-planning')).toBe(true)
  const outline = [...fixture.stages.values()].find(stage => stage.kind === 'research' && stage.data.kind === 'research' && stage.data.purpose.startsWith('Resolve evidence needed for'))
  const outlineTools = fixture.childRequests.find(request => request.sessionId === outline?.sessionId)?.tools?.map(tool => tool.name) ?? []
  expect(outlineTools).not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
})

it.each([
  ['provider unavailable', () => { throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE') }],
  ['quota billing', () => { throw new Error('HTTP 402 quota exceeded for this billing account') }],
] as const)('continues settings when official retrieval is %s', async (_label, search) => {
  const { run, official } = await writeSettings({ webSearch: search })
  expect(run.status).toBe('completed')
  expect(run.error).toBeNull()
  expect(official.some(call => call.startsWith('web_search:'))).toBe(true)
  expect(run.attempts.some(attempt => attempt.key === 'settings/batch/a1/draft' && attempt.status === 'succeeded')).toBe(true)
})

it('continues settings when official web tools are not registered', async () => {
  const { run, official } = await writeSettings({ registerWebTools: false })
  expect(run.status).toBe('completed')
  expect(run.error).toBeNull()
  expect(official).toEqual([])
  expect(run.attempts.some(attempt => attempt.key === 'settings/batch/a1/draft' && attempt.status === 'succeeded')).toBe(true)
})

it('keeps a non-quota retrieval failure fail-close for the settings layer', async () => {
  const { run } = await writeSettings({ webSearch: async () => { throw new Error('socket hang up') } })
  expect(run.status).toBe('failed')
  expect(run.error).toContain('socket hang up')
  expect(run.attempts.some(attempt => attempt.key.startsWith('settings/batch/'))).toBe(false)
})
