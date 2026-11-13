/** Chapter outlines are generated before bodies. Bodies in one batch do not read each other's unfinished text. */
import { expect, it } from 'vitest'
import { useWritingFixture } from './support/writing-fixture.ts'

it('writes two chapter bodies from the same applied snapshots and gives the next batch those snapshots', async () => {
  let bodies = 0
  const release = Promise.withResolvers<void>()
  const fixture = await useWritingFixture({ pauseChild(stage) {
    if (stage.kind !== 'body' || stage.requestCount !== 1) return undefined
    bodies += 1
    if (bodies >= 2) release.resolve()
    return release.promise
  } })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, fixture.input))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.error).toBeNull()
  const bodyStages = [...fixture.stages.values()].filter(stage => stage.kind === 'body')
  const chapters = bodyStages.map(stage => stage.task?.chapterNumber).sort()
  expect(chapters).toEqual([1, 2, 3])
  const sourcesOf = (chapter: number) => [...bodyStages.find(stage => stage.task?.chapterNumber === chapter)!.sources.values()].map(source => source.kind)
  expect(sourcesOf(2)).not.toContain('body')
  expect(sourcesOf(2)).not.toContain('continuity')
  expect(sourcesOf(2)).not.toContain('continuity-snapshot')
  expect(sourcesOf(3).filter(kind => kind === 'continuity-snapshot')).toHaveLength(2)
  expect(sourcesOf(3)).not.toContain('body')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters
  expect(applied.map(chapter => chapter.chapterNumber)).toEqual([1, 2, 3])
  expect(applied.every(chapter => chapter.snapshot?.kind === 'continuity-snapshot')).toBe(true)
  const outlineChapters = [...fixture.stages.values()].filter(stage => stage.kind === 'chapter-outline').map(stage => stage.task?.chapterNumber)
  expect(outlineChapters.sort()).toEqual([1, 2, 3])
  const firstBody = bodyStages.find(stage => stage.task?.chapterNumber === 1)
  const firstOutline = [...fixture.stages.values()].find(stage => stage.kind === 'chapter-outline' && stage.task?.chapterNumber === 3)
  expect(firstOutline).toBeDefined()
  expect(firstBody).toBeDefined()
})
