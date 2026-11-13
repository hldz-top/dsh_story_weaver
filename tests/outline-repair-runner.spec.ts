/** A version-8 run still patches an admitted outline instead of rewriting it. Version 7 uses the same rule. */
import { expect, it } from 'vitest'
import type { ArtifactId } from '../src/contracts.ts'
import { applyOutlinePatch } from '../src/outline-repair.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import type { WritingFixtureStage } from './support/writing-fixture.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const REPLACED_PARAGRAPH = '林澜只改这一段，其余航标计划不动。'
const REPLACED_ACTION = '林澜改写这一场的行动，义务不变。'

function reviewedKind(stage: WritingFixtureStage): string | undefined {
  const id = stage.task?.reviewed?.artifactId
  return id === undefined ? undefined : stage.sources.get(id)?.kind
}

function blockReview(output: object, stage: WritingFixtureStage): object {
  const paragraphId = stage.task?.paragraphs?.[0]?.id
  if (paragraphId === undefined) throw new Error('Outline review has no paragraph to cite')
  return {
    ...output,
    issues: [{
      id: 'outline-conflict', severity: 'blocking', category: 'consistency', location: 'opening',
      message: '只改被点名的部分，使它与已采纳的设定一致。',
      evidence: [{ paragraphId, problem: '这一段与已采纳的设定矛盾。' }],
    }],
  }
}

function storedOutline(stage: WritingFixtureStage, kind: 'book-outline' | 'chapter-outline'): unknown {
  const source = [...stage.sources.values()].find(item => item.kind === kind)
  if (source === undefined) throw new Error(`Repair stage has no stored ${kind}`)
  return JSON.parse(source.text) as unknown
}

it('stores a patched book and chapter outline when a repair is requested, and the model reply is only the patch', async () => {
  let bookReviews = 0
  let chapterReviews = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'book-outline') {
        bookReviews += 1
        if (bookReviews === 1) return blockReview(output, stage)
      }
      if (stage.kind === 'review' && reviewedKind(stage) === 'chapter-outline') {
        chapterReviews += 1
        if (chapterReviews === 1) return blockReview(output, stage)
      }
      if (stage.kind === 'book-outline' && stage.task?.validationError != null) {
        return { version: 1, changes: [{ op: 'paragraph', path: 'contentMarkdown', paragraphId: 'p2', value: REPLACED_PARAGRAPH }] }
      }
      if (stage.kind === 'chapter-outline' && stage.task?.validationError != null) {
        const prior = StageOutputSchemas['chapter-outline'].parse(storedOutline(stage, 'chapter-outline'))
        expect(prior.scenes[0]?.action).not.toBe(REPLACED_ACTION)
        return { version: 1, changes: [{ op: 'set', path: 'scenes[0].action', value: REPLACED_ACTION }] }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.error).toBeNull()
  expect(outcome.value.status).toBe('completed')
  expect(outcome.value.promptVersion).toBe(8)

  const bookDraft = [...fixture.stages.values()].find(stage => stage.kind === 'book-outline' && stage.task?.validationError == null)
  const bookRepair = [...fixture.stages.values()].find(stage => stage.kind === 'book-outline' && stage.task?.validationError != null)
  expect(bookDraft?.prompt).toContain('Plan the whole book')
  expect(bookDraft?.prompt).not.toContain('Return an outline patch')
  expect(bookRepair?.prompt).toContain('Return an outline patch')
  expect(bookRepair?.prompt).toContain('Do not return the complete outline')
  expect(bookRepair?.prompt).not.toContain('return the entire candidate')
  const published = (prompt: string | undefined) => prompt?.split('\n\nOUTPUT_SCHEMA\n\n')[1] ?? ''
  expect(published(bookDraft?.prompt)).toContain('contentMarkdown')
  expect(published(bookDraft?.prompt)).not.toContain('"changes"')
  expect(published(bookRepair?.prompt)).toContain('"changes"')
  expect(published(bookRepair?.prompt)).not.toContain('contentMarkdown')

  const repairAttempt = outcome.value.attempts.find(item => item.key === 'book-outline/book/candidate/1' && item.status === 'succeeded')
  const repairOutput = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, repairAttempt!.id).text) as { changes: unknown[] }
  expect(repairOutput).toEqual({ version: 1, changes: [{ op: 'paragraph', path: 'contentMarkdown', paragraphId: 'p2', value: REPLACED_PARAGRAPH }] })
  expect(JSON.stringify(repairOutput)).not.toContain('characterArcs')

  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const books = manuscript.history.filter(item => item.target.kind === 'book-outline')
  expect(books.map(item => item.status)).toEqual(['blocked', 'applied'])
  const read = (id: ArtifactId) => JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: id }).text) as unknown
  const originalBook = read(books[0]!.artifact.id)
  const storedBook = read(books[1]!.artifact.id)
  expect(storedBook).toEqual(applyOutlinePatch('book-outline', originalBook, repairOutput))
  const originalText = StageOutputSchemas['book-outline'].parse(originalBook).contentMarkdown
  const storedText = StageOutputSchemas['book-outline'].parse(storedBook).contentMarkdown
  expect(originalText).toContain('林澜逐章查明航标的秘密')
  expect(storedText).toBe(originalText.replace('林澜逐章查明航标的秘密，最终护送船队返航。', REPLACED_PARAGRAPH))
  expect(storedText.startsWith('# 雾港航标\n\n')).toBe(true)

  const chapterRepair = [...fixture.stages.values()].find(stage => stage.kind === 'chapter-outline' && stage.task?.validationError != null)
  expect(published(chapterRepair?.prompt)).toContain('"changes"')
  expect(published(chapterRepair?.prompt)).not.toContain('throughLine')
  const chapterAttempt = outcome.value.attempts.find(item => item.key === 'chapter-outline/1/candidate/1' && item.status === 'succeeded')
  const chapterOutput = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, chapterAttempt!.id).text) as unknown
  expect(chapterOutput).toEqual({ version: 1, changes: [{ op: 'set', path: 'scenes[0].action', value: REPLACED_ACTION }] })
  const chapters = manuscript.history.filter(item => item.target.kind === 'chapter-outline')
  expect(chapters.map(item => item.status)).toEqual(['blocked', 'applied'])
  const originalChapter = StageOutputSchemas['chapter-outline'].parse(read(chapters[0]!.artifact.id))
  const storedChapter = StageOutputSchemas['chapter-outline'].parse(read(chapters[1]!.artifact.id))
  expect(storedChapter).toEqual(applyOutlinePatch('chapter-outline', originalChapter, chapterOutput))
  expect(storedChapter.scenes[0]!.action).toBe(REPLACED_ACTION)
  expect(storedChapter.scenes[0]!.purpose).toBe(originalChapter.scenes[0]!.purpose)
  expect(storedChapter.scenes[0]!.obligationIds).toEqual(originalChapter.scenes[0]!.obligationIds)
  expect(storedChapter.throughLine).toBe(originalChapter.throughLine)
  expect(storedChapter.constraints).toEqual(originalChapter.constraints)
  expect(storedChapter.obligations).toEqual(originalChapter.obligations)
  expect(storedChapter.inputRefs).toEqual(originalChapter.inputRefs)
}, 120_000)

it('rejects an unapplicable outline patch and does not store a partial outline', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage, output) {
      if (stage.kind === 'review' && reviewedKind(stage) === 'book-outline') return blockReview(output, stage)
      if (stage.kind === 'book-outline' && stage.task?.validationError != null) {
        return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      }
      return output
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.status).toBe('failed')
  expect(outcome.value.promptVersion).toBe(8)
  expect(outcome.value.error).toContain('no-such-field')
  expect(outcome.value.error).toContain('Repair limit was exhausted for book-outline/book')
  const repairStage = [...fixture.stages.values()].find(stage => stage.kind === 'book-outline' && stage.task?.validationError != null)
  expect(repairStage?.prompt.split('\n\nOUTPUT_SCHEMA\n\n')[1]).toContain('"changes"')
  expect(repairStage?.prompt.split('\n\nOUTPUT_SCHEMA\n\n')[1]).not.toContain('contentMarkdown')
  const repairAttempt = outcome.value.attempts.find(item => item.key === 'book-outline/book/candidate/1' && item.status === 'succeeded')
  const raw = JSON.parse(fixture.runs.readOutput(fixture.actor, outcome.value.id, repairAttempt!.id).text) as object
  expect(raw).toEqual({ version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] })
  const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
  const books = manuscript.history.filter(item => item.target.kind === 'book-outline')
  expect(books).toHaveLength(1)
  expect(books[0]?.status).toBe('blocked')
  expect(manuscript.heads.some(item => item.target.kind === 'book-outline')).toBe(false)
  expect(manuscript.history.some(item => item.target.kind === 'chapter-outline')).toBe(false)
  const stored = StageOutputSchemas['book-outline'].parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: books[0]!.artifact.id }).text))
  expect(stored.contentMarkdown).toContain('林澜逐章查明航标的秘密')
  expect(stored).not.toHaveProperty('changes')
}, 120_000)
