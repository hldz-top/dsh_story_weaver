import { expect, it } from 'vitest'
import { parseRequestId, type ArtifactRef } from '../src/contracts.ts'
import type { WritingRun } from '../src/run-store.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const revisedFact = '灯塔铜印由港务长亲手留下。'

function reviseFiction(stage: WritingFixtureStage, output: object): object {
  const sourceKind = stage.kind === 'settings' ? 'settings-dimension' : stage.kind
  const revising = [...stage.sources.values()].some(source => source.kind === sourceKind)
  const inherited = [...stage.sources.values()].some(source => source.text.includes(revisedFact))
  if (!revising && !inherited) return output
  switch (stage.kind) {
    case 'settings': {
      const settings = StageOutputSchemas.settings.parse(output)
      return { ...settings, contentMarkdown: `${settings.contentMarkdown}\n\n${revisedFact}`, facts: [...settings.facts, { id: 'revised-copper-seal', statement: revisedFact }] }
    }
    case 'book-outline': {
      const book = StageOutputSchemas['book-outline'].parse(output)
      return { ...book, contentMarkdown: `${book.contentMarkdown}\n\n${revisedFact}`, chapters: book.chapters.map(chapter => ({ ...chapter,
        obligations: [...chapter.obligations, { id: 'revised-copper-seal', description: revisedFact }] })) }
    }
    case 'chapter-outline': {
      const outline = StageOutputSchemas['chapter-outline'].parse(output)
      return { ...outline, throughLine: `${outline.throughLine}${revisedFact}`, constraints: [...outline.constraints, revisedFact] }
    }
    case 'body': {
      const body = StageOutputSchemas.body.parse(output)
      return { ...body, scenes: body.scenes.map((scene, index) => index === 0 ? { ...scene, text: `${revisedFact}${scene.text}` } : scene) }
    }
    case 'continuity': {
      const continuity = StageOutputSchemas.continuity.parse(output)
      const body = [...stage.sources.values()].find(source => source.kind === 'body')
      if (body === undefined || !body.text.includes(revisedFact)) throw new Error('Revised continuity requires the actual read body fact')
      return { ...continuity, summary: `${continuity.summary}${revisedFact}`, timeline: [...continuity.timeline,
        { event: revisedFact, evidence: [{ artifactId: body.artifactId, quote: revisedFact }] }] }
    }
    default: return output
  }
}

function completed(result: PromiseSettledResult<WritingRun>, errors: readonly unknown[]): WritingRun {
  if (result.status === 'rejected') throw result.reason
  expect(result.value.error, JSON.stringify({ attempts: result.value.attempts.map(attempt => ({ key: attempt.key, error: attempt.error })), nativeErrors: errors.map(error => String(error)) })).toBeNull()
  expect(result.value.status).toBe('completed')
  return result.value
}

function readVersion(fixture: Awaited<ReturnType<typeof useWritingFixture>>, artifact: ArtifactRef): string {
  let offset = 0
  let text = ''
  for (;;) {
    const page = fixture.service.readArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: artifact.id, offset, limit: fixture.service.limits.maxReadChars })
    expect(page.sha256).toBe(artifact.sha256)
    expect(page.revision).toBe(artifact.revision)
    text += page.text
    if (page.eof) return text
    expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
}

it.each(['a1', 'book-outline', 'chapter-outline'] as const)('revises %s without downstream writing, then applies an explicit chapter update', async target => {
  const stagePrompts: string[] = []
  const fixture = await useWritingFixture({ intervene: reviseFiction, onChildRequest(_stage, request) {
    const text = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    if (text.includes('You perform one novel-writing stage')) stagePrompts.push(text)
  } })
  const nativeErrors: unknown[] = []
  fixture.ctx.on('agent/error', event => { nativeErrors.push(event.error) }, { global: true })
  const scope = { ...fixture.input, chapterCount: 1, throughChapter: 1 }
  completed(await fixture.run(exec => fixture.runner.start(exec, scope)), nativeErrors)
  const initial = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const oldChapter = initial.appliedChapters[0]
  if (oldChapter === undefined) throw new Error('Initial native run did not publish the chapter')
  const base = target === 'a1' ? fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(dimension => dimension.dimensionCode === 'a1')
    : initial.heads.find(head => head.target.kind === target)
  if (base === undefined) throw new Error('Requested upstream version is not applied')
  const oldBody = readVersion(fixture, oldChapter.body)
  const oldBase = readVersion(fixture, base.artifact)
  expect(oldBody).not.toContain(revisedFact)
  const beforeChildren = new Set(fixture.stages.keys())
  const revision = { ...scope, mode: 'revise' as const, requestId: parseRequestId(`revision-${target}`), revision: { baseArtifactId: base.artifact.id, instructions: revisedFact } }
  const revised = completed(await fixture.run(exec => fixture.runner.revise(exec, revision)), nativeErrors)
  const revisedStages = [...fixture.stages.values()].filter(stage => !beforeChildren.has(stage.sessionId))
  expect(revisedStages.map(stage => stage.kind).sort()).toEqual(['research-planning', 'research', 'review', target === 'a1' ? 'settings' : target].sort())
  const revising = stagePrompts.filter(prompt => prompt.includes(`revisionInstructions\\":\\"${revisedFact}`))
  expect(revising.length).toBeGreaterThan(0)
  for (const prompt of revising) {
    expect(prompt).toContain('Do not expand the revision into a new plot')
    expect(prompt).not.toContain('one present want')
  }
  if (target === 'a1') expect(revising.every(prompt => prompt.includes('Do not expand this classification into motives'))).toBe(true)
  expect(stagePrompts.some(prompt => prompt.includes('"kind": "review"') && prompt.includes('one repair step'))).toBe(true)
  expect(revised.attempts.every(attempt => attempt.status === 'succeeded')).toBe(true)
  const impacted = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const newBase = target === 'a1' ? fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(dimension => dimension.dimensionCode === 'a1')
    : impacted.heads.find(head => head.target.kind === target)
  if (newBase === undefined) throw new Error('Revised upstream version was not adopted')
  expect(newBase).toMatchObject({ revisionOf: base.artifact.id, status: 'applied', stale: false })
  expect(newBase.artifact.id).not.toBe(base.artifact.id)
  expect(newBase.artifact.revision).toBe(1)
  expect(newBase.artifact.sha256).not.toBe(base.artifact.sha256)
  expect(readVersion(fixture, newBase.artifact)).toContain(revisedFact)
  expect(impacted.appliedChapters[0]).toMatchObject({ body: { id: oldChapter.body.id }, continuity: { id: oldChapter.continuity.id }, stale: true })
  expect(impacted.appliedChapters[0]?.changedInputs.length).toBeGreaterThan(0)
  expect(impacted.history.filter(candidate => candidate.artifact.kind === 'body')).toHaveLength(1)
  expect(readVersion(fixture, oldChapter.body)).toBe(oldBody)
  expect(readVersion(fixture, base.artifact)).toBe(oldBase)
  const revisionRequests = fixture.childRequests.length
  expect(completed(await fixture.run(exec => fixture.runner.revise(exec, revision)), nativeErrors)).toEqual(revised)
  expect(fixture.childRequests).toHaveLength(revisionRequests)
  const updated = completed(await fixture.run(exec => fixture.runner.start(exec, { ...scope, mode: 'update', requestId: parseRequestId(`update-${target}`) })), nativeErrors)
  expect(updated.id).not.toBe(revised.id)
  const current = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const chapter = current.appliedChapters[0]
  if (chapter === undefined) throw new Error('Updated chapter is missing')
  expect(chapter.body.id).not.toBe(oldChapter.body.id)
  expect(chapter.continuity.id).not.toBe(oldChapter.continuity.id)
  expect(chapter.stale).toBe(false)
  expect(chapter.wordCount).toBeGreaterThanOrEqual(3000)
  expect(chapter.wordCount).toBeLessThanOrEqual(5000)
  expect(current.heads.every(head => !head.stale)).toBe(true)
  expect(current.history.filter(candidate => candidate.artifact.kind === 'body')).toHaveLength(2)
  expect(readVersion(fixture, chapter.body)).toContain(revisedFact)
  expect(readVersion(fixture, oldChapter.body)).toBe(oldBody)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
  expect(nativeErrors).toEqual([])
}, 30_000)
