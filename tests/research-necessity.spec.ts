import { expect, it } from 'vitest'
import { useWritingFixture } from './support/writing-fixture.ts'

it('records a local research decision before author-defined fiction research and exposes official web tools only for settings', async () => {
  const advertised = new Map<string, string[]>()
  const official: string[] = []
  const fixture = await useWritingFixture({ maxReadChars: 8192, onChildRequest(stage, request) {
    advertised.set(stage.sessionId, (request.tools ?? []).map(tool => tool.name))
  } })
  fixture.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'web_search' || exec.name === 'web_fetch') official.push(exec.name)
    return next()
  })
  const result = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (result.status === 'rejected') throw result.reason
  expect(result.value.error).toBeNull()
  const decisions = result.value.attempts.filter(attempt => attempt.key.endsWith('/research/planning'))
  expect(decisions.length).toBeGreaterThan(0)
  for (const decision of decisions) {
    expect(decision.status).toBe('succeeded')
    const output = JSON.parse(fixture.runs.readOutput(fixture.actor, result.value.id, decision.id).text)
    expect(output).toMatchObject({ mode: 'input-only', externalRequirements: [] })
    expect(advertised.get(decision.childSessionId!)).toEqual(['story_read_artifact', 'structured_output'])
    const logged = fixture.childRequests.find(request => request.sessionId === decision.childSessionId)
    const prompt = logged?.messages.flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('TASK_DATA'))
    if (prompt?.type !== 'text') throw new Error('Native planner prompt is not logged')
    expect(prompt.text).toContain('Author-declared genre, tone, realism level and fictional rules are authoritative choices.')
    const data = JSON.parse(prompt.text.split('\n\nTASK_DATA\n\n')[1]!)
    expect(data).toMatchObject({ kind: 'research-planning', novelId: fixture.novel.id, briefArtifactId: fixture.novel.brief.id, outputTarget: { kind: expect.any(String) } })
    if (decision === decisions[0]) expect({ taskKind: data.kind, targetKind: data.outputTarget.kind, tools: advertised.get(decision.childSessionId!), mode: output.mode, questionKinds: output.questions.map((question: { kind: string }) => question.kind) }).toMatchInlineSnapshot(`
      {
        "mode": "input-only",
        "questionKinds": [
          "creative",
        ],
        "targetKind": "settings",
        "taskKind": "research-planning",
        "tools": [
          "story_read_artifact",
          "structured_output",
        ],
      }
    `)
  }
  for (const stage of fixture.stages.values()) {
    if (stage.kind !== 'research' || stage.data.kind !== 'research') continue
    const tools = advertised.get(stage.sessionId) ?? []
    if (stage.data.purpose.startsWith('Establish the evidence needed for settings dimension')) expect(tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    else expect(tools).not.toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  }
  expect(official).toEqual(['web_search'])
  expect(fixture.service.listResearch(fixture.actor, fixture.novel.id).every(plan => plan.outcome === 'not-needed' && plan.reservedCalls.length === 0)).toBe(true)
})

it.each(['missing-fact', 'duplicate-question', 'mode-mismatch', 'text-budget'] as const)('stops invalid captured research necessity before retrieval after one replacement planning capture: %s', async defect => {
  const fixture = await useWritingFixture({ maxReadChars: 8192, intervene(stage, output) {
    if (stage.kind !== 'research-planning') return output
    const question = { id: 'real-light', kind: 'external', question: 'What timing identifies the real navigation light?', reason: 'The requested accurate scene relies on this real signal.' }
    const decision = { mode: 'external-required', reason: 'A required navigation fact is absent from the inputs.', questions: [question], externalRequirements: [{ questionId: question.id, outputDecision: 'Describe the actual navigation light used in this scene.', missingFact: 'The real signal timing.' }] }
    if (defect === 'missing-fact') return { ...decision, externalRequirements: [] }
    if (defect === 'duplicate-question') return { ...decision, questions: [question, question] }
    if (defect === 'mode-mismatch') return { ...decision, mode: 'input-only' }
    return { ...decision, reason: 'x'.repeat(8193) }
  } })
  const result = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, throughChapter: 1 }))
  if (result.status === 'rejected') throw result.reason
  expect(result.value.status).toBe('failed')
  expect(result.value.error).toContain(defect === 'duplicate-question' ? 'Research question ids must be unique' : defect === 'text-budget' ? 'Research necessity decision exceeds the configured text limit' : 'Research scope must identify one required output decision and missing fact for every external question')
  expect(result.value.error).toContain('Research planning repair limit was exhausted: ')
  // The fixture allows maxRepairAttempts 1: one replacement planning capture, then the run fails before any retrieval.
  expect(result.value.attempts.map(({ key, status }) => ({ key, status }))).toEqual([
    { key: 'settings/0/a1/research/planning', status: 'succeeded' }, { key: 'settings/0/a1/research/planning/1', status: 'succeeded' }])
  expect(fixture.service.listResearch(fixture.actor, fixture.novel.id)).toEqual([])
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})
