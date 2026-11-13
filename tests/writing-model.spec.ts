/** Planning and body can name different host routes. Inherit keeps the parent model. */
import { expect, it } from 'vitest'
import { normalizeWritingModel } from '../src/writing-model.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

it('rejects an OpenCode Go route inside a stage map', () => {
  expect(() => normalizeWritingModel({ review: { provider: 'opencode-go', model: 'fast' } })).toThrow(/opencode-go is not provided by this plugin/)
  expect(normalizeWritingModel('inherit')).toEqual({ planning: 'inherit', review: 'inherit', body: 'inherit' })
  expect(normalizeWritingModel({ body: { provider: 'stage-fixture', model: 'strong-body' } })).toEqual({
    planning: 'inherit', review: 'inherit', body: { provider: 'stage-fixture', model: 'strong-body' },
  })
})

it('sends body text to the named model and leaves planning on the parent route', async () => {
  const fixture = await useWritingFixture({ executionLimits: { writingModel: { planning: 'inherit', review: 'inherit', body: { provider: 'stage-fixture', model: 'strong-body' } } } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  const kindOf = (request: typeof fixture.childRequests[number]) => {
    const marker = '\n\nTASK_DATA\n\n'
    const text = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' && block.text.includes(marker) ? [block.text] : []))[0]
    if (text === undefined) return undefined
    const body = text.slice(text.indexOf(marker) + marker.length)
    const hosted = body.indexOf('\n\nHOST_INPUTS\n\n')
    return (JSON.parse(hosted < 0 ? body : body.slice(0, hosted)) as { kind?: string }).kind
  }
  const body = fixture.childRequests.filter(request => kindOf(request) === 'body')
  expect(body.length).toBeGreaterThan(0)
  expect(body.every(request => request.provider === 'stage-fixture' && request.model === 'strong-body')).toBe(true)
  const outline = fixture.childRequests.filter(request => kindOf(request) === 'book-outline')
  expect(outline.length).toBeGreaterThan(0)
  expect(outline.every(request => request.model === 'inherited-model')).toBe(true)
  expect(fixture.ctx.llm.listProviders().map(provider => provider.id)).not.toContain('opencode-go')
})
