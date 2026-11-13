import { createHash } from 'node:crypto'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writingDomain, type NovelRecord, type ArtifactRecord } from '../src/records.ts'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { artifactIdSchema, novelIdSchema, requestIdSchema, parseRequestId, parseNovelId, parseArtifactId, type Actor, type NovelId } from '../src/contracts.ts'
import type { ManuscriptCandidateView } from '../src/manuscript.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useStorage, type StorageKind } from './support/storage.ts'

const limits = { maxArtifactBytes: 131072, maxReadChars: 4096 }
const child = brandString<SessionId>('native-writer')
const reviewer = brandString<SessionId>('native-reviewer')

async function preparedSettings(backend: StorageKind) { return populateSettings(await useStorage(backend, limits)) }

async function populateSettings(h: Awaited<ReturnType<typeof useStorage>>) {
  const actor: Actor = { workspace: h.root, sessionId: brandString<SessionId>('parent') }
  const novel = await h.service.createNovel(actor, { requestId: parseRequestId('create'), title: 'Harbor', brief: 'A harbor mystery.' })
  const research = await h.service.startResearch(actor, { novelId: novel.id, requestId: parseRequestId('research'), briefArtifactId: novel.brief.id,
    questions: [{ id: 'genre', kind: 'creative', question: 'Choose the genre.', reason: 'An authorial decision.' }] }, 0)
  await h.service.completeSelectedResearch(actor, { novelId: novel.id, planId: research.planId, requestId: parseRequestId('evidence'),
    findings: [{ questionId: 'genre', callIds: [], selections: [], conclusion: 'A mystery.', adequate: true }] }, [])
  const inputRefs = h.service.settingsInputs(actor, novel.id, 'a1', research.planId).map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
  const output = { version: 1, dimensionCode: 'a1', inputRefs, facts: [{ id: 'genre', statement: 'A mystery.' }], contentMarkdown: 'Mystery.' }
  const dimension = await h.service.saveSettingsCandidate(actor, { novelId: novel.id, requestId: parseRequestId('dimension'), dimensionCode: 'a1',
    researchPlanId: research.planId, childSessionId: child, output })
  const evidence = [{ artifactId: dimension.artifact.id, quote: 'Mystery.' }]
  const reviewed = await h.service.saveSettingsReview(actor, { novelId: novel.id, candidateId: dimension.artifact.id, expectedReviewId: null,
    requestId: parseRequestId('dimension-review'), childSessionId: reviewer, output: {
      version: 1, reviewed: { artifactId: dimension.artifact.id, sha256: dimension.artifact.sha256 }, inputRefs,
      checks: [{ category: 'completeness', summary: 'Genre supplied.', evidence }, { category: 'consistency', summary: 'Matches the brief.', evidence }], issues: [],
    } })
  if (reviewed.review === null) throw new Error('Missing fixture review')
  await h.service.applySettingsCandidate(actor, { novelId: novel.id, candidateId: dimension.artifact.id, reviewId: reviewed.review.id, expectedAppliedId: null })
  return { h, actor, novel, dimension, output, researchPlanId: research.planId }
}

describe.each(['json', 'sqlite'] as const)('%s manuscript persistence', backend => {
  it('assembles only selected applied dimensions and reopens the exact unreviewed collection', async () => {
    const { h, actor, novel, dimension, output } = await preparedSettings(backend)
    const request = { novelId: novel.id, requestId: parseRequestId('assemble'), selectedCodes: ['a1'] }
    const assembled = await h.service.assembleSettings(actor, request)
    expect(assembled).toMatchObject({ target: { kind: 'settings', selectedCodes: ['a1'] }, status: 'candidate', review: null, stale: false })
    const artifact = h.service.getArtifact(actor, { novelId: novel.id, artifactId: assembled.artifact.id })
    expect(JSON.parse(artifact.text)).toEqual({ version: 1, selectedCodes: ['a1'],
      inputRefs: [novel.brief, dimension.artifact].map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), dimensions: [output] })
    await h.restart()
    expect(await h.service.assembleSettings(actor, request)).toEqual(assembled)
    expect(h.service.getArtifact(actor, { novelId: novel.id, artifactId: assembled.artifact.id })).toEqual(artifact)
    await expect(h.service.assembleSettings(actor, { ...request, requestId: parseRequestId('missing'), selectedCodes: ['a2'] })).rejects.toThrow()
  })
})

it.each(['json', 'sqlite'] as const)('%s adopts a settings collection only after exact cross-dimension review', async backend => {
  const { h, actor, novel } = await preparedSettings(backend)
  const candidate = await h.service.assembleSettings(actor, { novelId: novel.id, requestId: parseRequestId('assemble'), selectedCodes: ['a1'] })
  expect(h.service.getManuscript(actor, novel.id).heads).toEqual([])
  await expect(h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: candidate.artifact.id,
    reviewId: novel.brief.id, expectedAppliedId: null })).rejects.toMatchObject({ code: 'review-blocked' })
  const evidence = [{ artifactId: candidate.artifact.id, quote: 'Mystery.' }]
  const output = { version: 1, reviewed: { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, inputRefs: candidate.inputRefs,
    checks: [{ category: 'completeness', summary: 'All selected dimensions are present.', evidence }, { category: 'consistency', summary: 'Dimensions agree.', evidence }], issues: [] }
  const reviewed = await h.service.saveManuscriptReview(actor, { novelId: novel.id, candidateId: candidate.artifact.id, expectedReviewId: null,
    requestId: parseRequestId('collection-review'), childSessionId: reviewer, output })
  if (reviewed.review === null) throw new Error('Missing collection review')
  const request = { novelId: novel.id, candidateId: candidate.artifact.id, reviewId: reviewed.review.id, expectedAppliedId: null }
  const applied = await h.service.applyManuscriptCandidate(actor, request)
  expect(applied.status).toBe('applied')
  await h.restart()
  expect(await h.service.applyManuscriptCandidate(actor, request)).toEqual(applied)
  expect(h.service.getManuscript(actor, novel.id)).toEqual({ heads: [applied], history: [applied], appliedChapters: [] })
})

it.each(['json', 'sqlite'] as const)('%s adopts a settings collection whose review holds only an advisory completeness note', async backend => {
  const { h, actor, novel } = await preparedSettings(backend)
  const candidate = await h.service.assembleSettings(actor, { novelId: novel.id, requestId: parseRequestId('assemble'), selectedCodes: ['a1'] })
  const evidence = [{ artifactId: candidate.artifact.id, quote: 'Mystery.' }]
  const output = { version: 1, reviewed: { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, inputRefs: candidate.inputRefs,
    checks: [{ category: 'completeness', summary: 'All selected dimensions are present.', evidence }, { category: 'consistency', summary: 'Dimensions agree.', evidence }],
    issues: [{ id: 'trace', category: 'completeness', severity: 'advisory', location: 'a1', message: 'Traceability note only.', evidence }] }
  const reviewed = await h.service.saveManuscriptReview(actor, { novelId: novel.id, candidateId: candidate.artifact.id, expectedReviewId: null,
    requestId: parseRequestId('collection-review'), childSessionId: reviewer, output })
  expect(reviewed.status).toBe('reviewed')
  if (reviewed.review === null) throw new Error('Missing collection review')
  expect(await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: candidate.artifact.id, reviewId: reviewed.review.id, expectedAppliedId: null })).toMatchObject({ status: 'applied' })
  await h.restart()
  expect(h.service.getManuscript(actor, novel.id).heads).toHaveLength(1)
  await expect(h.service.saveManuscriptReview(actor, { novelId: novel.id, candidateId: candidate.artifact.id, expectedReviewId: reviewed.review.id, requestId: parseRequestId('consistency-review'), childSessionId: reviewer,
    output: { ...output, issues: [{ ...output.issues[0]!, id: 'drift', category: 'consistency' }] } })).rejects.toThrow(/consistency issues must be blocking/)
})

async function reviewVersion(h: Awaited<ReturnType<typeof useStorage>>, actor: Actor, novelId: NovelId,
  candidate: ManuscriptCandidateView, requestId: string, quote: string) {
  const evidence = [{ artifactId: candidate.artifact.id, quote }]
  const reviewed = await h.service.saveManuscriptReview(actor, { novelId, candidateId: candidate.artifact.id, expectedReviewId: candidate.review?.id ?? null,
    requestId: parseRequestId(requestId), childSessionId: reviewer, output: { version: 1,
      reviewed: { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, inputRefs: candidate.inputRefs,
      checks: ['completeness', 'consistency', 'obligations', 'continuity', 'length'].map(category => ({ category, summary: 'The relevant requirement is met.', evidence })), issues: [] } })
  if (reviewed.review === null) throw new Error('Missing review fixture')
  return { candidate: reviewed, reviewId: reviewed.review.id }
}

async function appliedCollection(backend: StorageKind) {
  const fixture = await preparedSettings(backend)
  const { h, actor, novel } = fixture
  const collection = await h.service.assembleSettings(actor, { novelId: novel.id, requestId: parseRequestId('assemble'), selectedCodes: ['a1'] })
  const review = await reviewVersion(h, actor, novel.id, collection, 'collection-review', 'Mystery.')
  const settings = await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: collection.artifact.id, reviewId: review.reviewId, expectedAppliedId: null })
  return { ...fixture, settings }
}

it.each(['json', 'sqlite'] as const)('%s persists a reviewed book plan with exact applied settings and chapter obligations', async backend => {
  const { h, actor, novel, settings, researchPlanId } = await appliedCollection(backend)
  const target = { kind: 'book-outline' as const, chapterCount: 2 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  expect(context.inputRefs.some(ref => ref.id === settings.artifact.id)).toBe(true)
  expect(context.continuitySnapshots).toEqual([])
  const output = { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })),
    contentMarkdown: 'The keeper solves the mystery.', ending: 'The key is recovered.', characterArcs: [{ character: 'Keeper', development: 'Faces the truth.' }],
    chapters: [{ chapterNumber: 1, title: 'The log', purpose: 'Recover the log.', targetWords: 3000, obligations: [{ id: 'log', description: 'The log is recovered.' }] },
      { chapterNumber: 2, title: 'The key', purpose: 'Recover the key.', targetWords: 3000, obligations: [{ id: 'key', description: 'The key is recovered.' }] }] }
  const request = { novelId: novel.id, requestId: parseRequestId('book'), researchPlanId, target, childSessionId: child, output }
  const book = await h.service.saveManuscriptCandidate(actor, request)
  const reviewed = await reviewVersion(h, actor, novel.id, book, 'book-review', 'The keeper solves the mystery.')
  const applied = await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: book.artifact.id, reviewId: reviewed.reviewId, expectedAppliedId: null })
  await h.restart()
  expect((await h.service.saveManuscriptCandidate(actor, request)).artifact).toEqual(applied.artifact)
  expect(h.service.getManuscript(actor, novel.id).heads.map(item => item.artifact.id)).toEqual([settings.artifact.id, book.artifact.id])
  expect(() => h.service.manuscriptInputs(actor, { novelId: novel.id, target: { kind: 'chapter-outline', chapterNumber: 2 }, researchPlanId })).toThrow()
})

function advisoryCompletenessReview(h: Awaited<ReturnType<typeof useStorage>>, actor: Actor, novelId: NovelId, candidate: ManuscriptCandidateView, requestId: string, quote: string) {
  const evidence = [{ artifactId: candidate.artifact.id, quote }]
  return h.service.saveManuscriptReview(actor, { novelId, candidateId: candidate.artifact.id, expectedReviewId: candidate.review?.id ?? null,
    requestId: parseRequestId(requestId), childSessionId: reviewer, output: { version: 1,
      reviewed: { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, inputRefs: candidate.inputRefs,
      checks: ['completeness', 'consistency', 'obligations', 'continuity', 'length'].map(category => ({ category, summary: 'The relevant requirement is met.', evidence })),
      issues: [{ id: 'trace', category: 'completeness', severity: 'advisory', location: 'Plan', message: 'Traceability note only.', evidence }] } })
}

it.each(['json', 'sqlite'] as const)('%s still rejects an advisory completeness note in a book-outline review', async backend => {
  const { h, actor, novel, researchPlanId } = await appliedCollection(backend)
  const target = { kind: 'book-outline' as const, chapterCount: 2 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const output = { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), contentMarkdown: 'Solve the mystery.', ending: 'Find the key.',
    characterArcs: [{ character: 'Keeper', development: 'Faces the truth.' }], chapters: [1, 2].map(chapterNumber => ({ chapterNumber,
      title: `Chapter ${chapterNumber}`, purpose: 'Find the log.', targetWords: 3000, obligations: [{ id: `o${chapterNumber}`, description: 'The log is recovered.' }] })) }
  const book = await h.service.saveManuscriptCandidate(actor, { novelId: novel.id, requestId: parseRequestId('book'), target, researchPlanId, childSessionId: child, output })
  await expect(advisoryCompletenessReview(h, actor, novel.id, book, 'book-review', 'Solve the mystery.')).rejects.toThrow(/^completeness issues must be blocking/)
  expect(h.service.getManuscript(actor, novel.id).history.find(item => item.artifact.id === book.artifact.id)?.review).toBeNull()
})

async function appliedBook(backend: StorageKind) {
  const fixture = await appliedCollection(backend)
  const { h, actor, novel, researchPlanId } = fixture
  const target = { kind: 'book-outline' as const, chapterCount: 2 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const output = { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), contentMarkdown: 'Solve the mystery.', ending: 'Find the key.',
    characterArcs: [{ character: 'Keeper', development: 'Faces the truth.' }], chapters: [1, 2].map(chapterNumber => ({ chapterNumber,
      title: `Chapter ${chapterNumber}`, purpose: chapterNumber === 1 ? 'Find the log.' : 'Find the key.', targetWords: 3000,
      obligations: [{ id: chapterNumber === 1 ? 'log' : 'key', description: chapterNumber === 1 ? 'The log is recovered.' : 'The key is recovered.' }] })) }
  const book = await h.service.saveManuscriptCandidate(actor, { novelId: novel.id, requestId: parseRequestId('book'), target, researchPlanId, childSessionId: child, output })
  const review = await reviewVersion(h, actor, novel.id, book, 'book-review', 'Solve the mystery.')
  await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: book.artifact.id, reviewId: review.reviewId, expectedAppliedId: null })
  return { ...fixture, book }
}

it.each(['json', 'sqlite'] as const)('%s admits chapter one from an exact book obligation and rejects missing scene coverage', async backend => {
  const { h, actor, novel, book, researchPlanId } = await appliedBook(backend)
  const target = { kind: 'chapter-outline' as const, chapterNumber: 1 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  expect(context.continuitySnapshots).toEqual([])
  expect(context.obligations).toEqual([{ id: 'log', description: 'The log is recovered.' }])
  expect(context.inputRefs.some(ref => ref.id === book.artifact.id)).toBe(true)
  expect(h.service.manuscriptResearchInputs(actor, { novelId: novel.id, target }).map(ref => ref.kind)).toEqual(['creative-brief', 'settings', 'book-outline'])
  const output = { version: 1, inputRefs: [...context.inputRefs].reverse().map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1,
    title: 'The log', targetWords: 3000, throughLine: 'Find the log.', constraints: ['The keeper is alone.'], obligations: context.obligations,
    scenes: [{ id: 'discovery', purpose: 'Recover the log.', action: 'The keeper finds it.', obligationIds: ['log'] }] }
  const request = { novelId: novel.id, requestId: parseRequestId('chapter-outline'), target, researchPlanId, childSessionId: child, output }
  const candidate = await h.service.saveManuscriptCandidate(actor, request)
  const review = await reviewVersion(h, actor, novel.id, candidate, 'chapter-review', 'Find the log.')
  const applied = await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: candidate.artifact.id, reviewId: review.reviewId, expectedAppliedId: null })
  await h.restart()
  expect(h.service.getManuscript(actor, novel.id).heads.at(-1)).toEqual(applied)
  await expect(h.service.saveManuscriptCandidate(actor, { ...request, requestId: parseRequestId('omitted'), output: { ...output, scenes: [{ ...output.scenes[0], obligationIds: [] }] } })).rejects.toThrow(/obligation/i)
})

async function appliedOutline(backend: StorageKind) {
  const fixture = await appliedBook(backend)
  const { h, actor, novel, researchPlanId } = fixture
  const target = { kind: 'chapter-outline' as const, chapterNumber: 1 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const outline = await h.service.saveManuscriptCandidate(actor, { novelId: novel.id, requestId: parseRequestId('outline'), target, researchPlanId, childSessionId: child,
    output: { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1, title: 'The log', targetWords: 3000,
      throughLine: 'Find the log.', constraints: [], obligations: context.obligations,
      scenes: [{ id: 'discovery', purpose: 'Recover the log.', action: 'The keeper finds it.', obligationIds: ['log'] }] } })
  const review = await reviewVersion(h, actor, novel.id, outline, 'outline-review', 'Find the log.')
  await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: outline.artifact.id, reviewId: review.reviewId, expectedAppliedId: null })
  return { ...fixture, outline }
}

it.each(['json', 'sqlite'] as const)('%s preserves short body candidates and recounts exact scene text after restart', async backend => {
  const { h, actor, novel, researchPlanId } = await appliedOutline(backend)
  const target = { kind: 'body' as const, chapterNumber: 1 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  expect(context.sceneIds).toEqual(['discovery'])
  const text = '文'.repeat(2999)
  const request = { novelId: novel.id, requestId: parseRequestId('short-body'), target, researchPlanId, childSessionId: child,
    output: { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1, scenes: [{ sceneId: 'discovery', text }] } }
  const candidate = await h.service.saveManuscriptCandidate(actor, request)
  expect(candidate).toMatchObject({ status: 'blocked', wordCount: 2999, length: { status: 'too-short', blocking: true } })
  await h.restart()
  expect((await h.service.saveManuscriptCandidate(actor, request))).toEqual(candidate)
  const stored = h.service.getArtifact(actor, { novelId: novel.id, artifactId: candidate.artifact.id })
  expect(JSON.parse(stored.text).scenes[0].text).toBe(text)
  await expect(h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: candidate.artifact.id, reviewId: novel.brief.id, expectedAppliedId: null })).rejects.toMatchObject({ code: 'review-blocked' })
  await expect(h.service.saveManuscriptCandidate(actor, { ...request, requestId: parseRequestId('wrong-scene'), output: { ...request.output, scenes: [{ sceneId: 'invented', text }] } })).rejects.toThrow(/scene/i)
})

async function reviewedBody(backend: StorageKind, text = `The keeper found the log.\n${'文'.repeat(2995)}`) {
  const fixture = await appliedOutline(backend)
  const { h, actor, novel, researchPlanId } = fixture
  const target = { kind: 'body' as const, chapterNumber: 1 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const body = await h.service.saveManuscriptCandidate(actor, { novelId: novel.id, requestId: parseRequestId('body'), target, researchPlanId, childSessionId: child,
    output: { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1, scenes: [{ sceneId: 'discovery', text }] } })
  const bodyReview = await reviewVersion(h, actor, novel.id, body, 'body-review', 'found the log')
  return { ...fixture, body, bodyReview, text }
}

it.each(['json', 'sqlite'] as const)('%s still rejects an advisory completeness note in a body review', async backend => {
  const { h, actor, novel, body, bodyReview } = await reviewedBody(backend)
  await expect(advisoryCompletenessReview(h, actor, novel.id, { ...body, review: bodyReview.candidate.review }, 'body-review-2', 'found the log')).rejects.toThrow(/^completeness issues must be blocking/)
})

it.each(['json', 'sqlite'] as const)('%s applies body, actual continuity and obligation outcomes together before chapter two', async backend => {
  const { h, actor, novel, body, bodyReview, researchPlanId } = await reviewedBody(backend)
  const target = { kind: 'continuity' as const, chapterNumber: 1, bodyId: body.artifact.id }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const evidence = [{ artifactId: body.artifact.id, quote: 'found the log' }]
  const output = { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1,
    summary: 'The log is recovered.', characters: [{ name: 'Keeper', state: 'Has the log.' }], timeline: [{ event: 'The log is recovered.', evidence }],
    obligations: [{ id: 'log', status: 'fulfilled', explanation: 'The body records recovery.', evidence }] }
  const continuity = await h.service.saveManuscriptCandidate(actor, { novelId: novel.id, requestId: parseRequestId('continuity'), target, researchPlanId, childSessionId: child, output })
  const request = { novelId: novel.id, bodyId: body.artifact.id, bodyReviewId: bodyReview.reviewId, continuityId: continuity.artifact.id,
    continuityReviewId: novel.brief.id, expectedBodyId: null, expectedContinuityId: null }
  await expect(h.service.applyChapter(actor, request)).rejects.toMatchObject({ code: 'review-blocked' })
  expect(h.service.getManuscript(actor, novel.id).appliedChapters).toEqual([])
  const review = await reviewVersion(h, actor, novel.id, continuity, 'continuity-review', 'The log is recovered.')
  const applied = await h.service.applyChapter(actor, { ...request, continuityReviewId: review.reviewId })
  expect(applied).toMatchObject({ chapterNumber: 1, body: body.artifact, continuity: continuity.artifact, wordCount: 3000, stale: false, obligations: output.obligations })
  await h.restart()
  expect(await h.service.applyChapter(actor, { ...request, continuityReviewId: review.reviewId })).toEqual(applied)
  const view = h.service.getManuscript(actor, novel.id)
  expect(view.appliedChapters).toEqual([applied])
  expect(view.history.filter(item => item.artifact.id === body.artifact.id || item.artifact.id === continuity.artifact.id).map(item => item.status)).toEqual(['applied', 'applied'])
  const snapshotRefs = [body.artifact, continuity.artifact].map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
  const snapshot = await h.service.saveContinuitySnapshot(actor, { novelId: novel.id, requestId: parseRequestId('snapshot'), chapterNumber: 1,
    bodyId: body.artifact.id, continuityId: continuity.artifact.id, childSessionId: child, snapshotThrough: 0,
    output: { version: 1, inputRefs: snapshotRefs, chapterNumber: 1, characterStatus: [{ name: 'Keeper', status: 'Has the log.' }], unrecoveredForeshadowing: [], usedPlotBridges: [{ note: 'The log was recovered.' }] } })
  const snapshotReview = await reviewVersion(h, actor, novel.id, snapshot, 'snapshot-review', 'Has the log.')
  await h.service.attachContinuitySnapshot(actor, { novelId: novel.id, chapterNumber: 1, bodyId: body.artifact.id, continuityId: continuity.artifact.id, snapshotId: snapshot.artifact.id, reviewId: snapshotReview.reviewId })
  const next = h.service.manuscriptInputs(actor, { novelId: novel.id, researchPlanId, target: { kind: 'chapter-outline', chapterNumber: 2 } })
  expect(next.continuitySnapshots.map(ref => ref.id)).toEqual([snapshot.artifact.id])
  expect(next.obligations).toEqual([{ id: 'key', description: 'The key is recovered.' }])
})

async function completedPair(backend: StorageKind, status: 'open' | 'fulfilled' = 'fulfilled') {
  const fixture = await reviewedBody(backend)
  const { h, actor, novel, body, researchPlanId } = fixture
  const target = { kind: 'continuity' as const, chapterNumber: 1, bodyId: body.artifact.id }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const evidence = [{ artifactId: body.artifact.id, quote: 'found the log' }]
  const output = { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1,
    summary: 'The log is recovered.', characters: [{ name: 'Keeper', state: 'Has the log.' }], timeline: [{ event: 'The log is recovered.', evidence }],
    obligations: [{ id: 'log', status, explanation: status === 'open' ? 'The obligation remains unresolved.' : 'The body records recovery.', evidence: status === 'open' ? [] : evidence }] }
  const request = { novelId: novel.id, requestId: parseRequestId('continuity'), target, researchPlanId, childSessionId: child, output }
  const continuity = await h.service.saveManuscriptCandidate(actor, request)
  const continuityReview = await reviewVersion(h, actor, novel.id, continuity, 'continuity-review', 'The log is recovered.')
  const apply = { novelId: novel.id, bodyId: body.artifact.id, bodyReviewId: fixture.bodyReview.reviewId, continuityId: continuity.artifact.id,
    continuityReviewId: continuityReview.reviewId, expectedBodyId: null, expectedContinuityId: null }
  return { ...fixture, continuity, continuityReview, request, apply }
}

it.each(['json', 'sqlite'] as const)('%s refuses reviewed continuity with an open required obligation', async backend => {
  const { h, actor, novel, apply } = await completedPair(backend, 'open')
  await expect(h.service.applyChapter(actor, apply)).rejects.toMatchObject({ code: 'review-blocked' })
  expect(h.service.getManuscript(actor, novel.id).appliedChapters).toEqual([])
})

it.each(['json', 'sqlite'] as const)('%s retains stale applied history while refusing downstream generation after a brief edit', async backend => {
  const { h, actor, novel, researchPlanId, request, apply, continuity } = await completedPair(backend)
  await h.service.applyChapter(actor, apply)
  await h.service.saveBrief(actor, { novelId: novel.id, requestId: parseRequestId('edit-brief'), expectedRevision: 1, text: 'Set the story on a mountain.' })
  await h.restart()
  const history = h.service.getManuscript(actor, novel.id)
  expect(history.appliedChapters[0]).toMatchObject({ stale: true, body: { id: apply.bodyId } })
  expect(history.history.every(item => item.stale)).toBe(true)
  expect((await h.service.saveManuscriptCandidate(actor, request))).toMatchObject({ artifact: continuity.artifact, stale: true })
  expect(() => h.service.manuscriptInputs(actor, { novelId: novel.id, researchPlanId, target: { kind: 'chapter-outline', chapterNumber: 2 } })).toThrow(/changed|stale/i)
})

it.each(['json', 'sqlite'] as const)('%s cancels content-first publication before any novel reference is saved', async backend => {
  const { h, actor, novel, researchPlanId } = await appliedOutline(backend)
  const target = { kind: 'body' as const, chapterNumber: 1 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const before = h.service.getManuscript(actor, novel.id)
  const stop = new AbortController()
  h.onArtifactStored(() => stop.abort(new Error('Stop before publication')))
  await expect(h.service.saveManuscriptCandidate({ ...actor, signal: stop.signal }, { novelId: novel.id, requestId: parseRequestId('cancelled'), target, researchPlanId, childSessionId: child,
    output: { version: 1, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })), chapterNumber: 1, scenes: [{ sceneId: 'discovery', text: '文'.repeat(3000) }] } })).rejects.toThrow('Stop before publication')
  expect(h.service.getManuscript(actor, novel.id)).toEqual(before)
  await h.restart()
  expect(h.service.getManuscript(actor, novel.id)).toEqual(before)
})

it.each(['json', 'sqlite'] as const)('%s admits only one competing review against an observed review head', async backend => {
  const { h, actor, novel } = await preparedSettings(backend)
  const candidate = await h.service.assembleSettings(actor, { novelId: novel.id, requestId: parseRequestId('assemble'), selectedCodes: ['a1'] })
  const evidence = [{ artifactId: candidate.artifact.id, quote: 'Mystery.' }]
  const output = { version: 1, reviewed: { artifactId: candidate.artifact.id, sha256: candidate.artifact.sha256 }, inputRefs: candidate.inputRefs,
    checks: [{ category: 'completeness', summary: 'Dimensions present.', evidence }, { category: 'consistency', summary: 'Conflict detected.', evidence }],
    issues: [{ id: 'conflict', category: 'consistency', severity: 'blocking', location: 'Genre', message: 'Conflicting genres.', evidence }] }
  const request = { novelId: novel.id, candidateId: candidate.artifact.id, expectedReviewId: null, childSessionId: reviewer, output }
  const results = await Promise.allSettled([
    h.service.saveManuscriptReview(actor, { ...request, requestId: parseRequestId('review-a') }),
    h.service.saveManuscriptReview(actor, { ...request, requestId: parseRequestId('review-b') }),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  const saved = h.service.getManuscript(actor, novel.id).history[0]
  if (saved?.review === null || saved?.review === undefined) throw new Error('Missing winning review')
  expect(saved.status).toBe('blocked')
  await expect(h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: saved.artifact.id, reviewId: saved.review.id, expectedAppliedId: null })).rejects.toMatchObject({ code: 'review-blocked' })
})

it('refuses a mismatched body identity and a stale paired-head precondition', async () => {
  const { h, actor, novel, apply, outline } = await completedPair('json')
  await expect(h.service.applyChapter(actor, { ...apply, bodyId: outline.artifact.id })).rejects.toMatchObject({ code: 'review-blocked' })
  await expect(h.service.applyChapter(actor, { ...apply, expectedContinuityId: novel.brief.id })).rejects.toMatchObject({ code: 'revision-conflict' })
  expect(h.service.getManuscript(actor, novel.id).appliedChapters).toEqual([])
})

it('retains the adoption bounds needed to verify an old chapter after deployment bounds change', async () => {
  const { h, actor, novel, apply } = await completedPair('json')
  const original = await h.service.applyChapter(actor, apply)
  expect(original.wordBounds).toEqual({ minChapterWords: 3000, maxChapterWords: 5000 })
  await h.restart(limits, { minChapterWords: 3500, maxChapterWords: 5000 })
  expect(h.service.getManuscript(actor, novel.id).appliedChapters).toEqual([original])
  expect(await h.service.applyChapter(actor, apply)).toEqual(original)
})

it.each(['candidate-child', 'review-child', 'body-adopted-without-pair'] as const)('rejects corrupted manuscript provenance or adoption status: %s', async change => {
  const { h, actor, novel, body } = await reviewedBody('json')
  await h.service.close()
  const path = join(h.root, 'data', 'story_writing.json')
  const stored: { tables: { novels: Record<string, NovelRecord>; artifacts: Record<string, ArtifactRecord> } } = JSON.parse(await readFile(path, 'utf8'))
  const candidate = stored.tables.novels[novel.id]?.manuscriptHistory.find(item => item.artifact.id === body.artifact.id)
  if (candidate === undefined || candidate.reviewHistory[0] === undefined) throw new Error('Missing corruption fixture')
  if (change === 'candidate-child') candidate.childSessionId = brandString<SessionId>('other-child')
  if (change === 'review-child') candidate.reviewHistory[0].childSessionId = brandString<SessionId>('other-reviewer')
  if (change === 'body-adopted-without-pair') candidate.applied = true
  await writeFile(path, JSON.stringify(stored))
  await h.restart()
  expect(() => h.service.getManuscript(actor, novel.id)).toThrow()
})

it('rejects planned content substituted for a reviewed continuity snapshot', async () => {
  const { h, actor, novel, researchPlanId, apply, outline, body, continuity } = await completedPair('json')
  await h.service.applyChapter(actor, apply)
  const snapshotRefs = [body.artifact, continuity.artifact].map(ref => ({ artifactId: ref.id, sha256: ref.sha256 }))
  const snapshot = await h.service.saveContinuitySnapshot(actor, { novelId: novel.id, requestId: parseRequestId('snapshot'), chapterNumber: 1,
    bodyId: body.artifact.id, continuityId: continuity.artifact.id, childSessionId: child, snapshotThrough: 0,
    output: { version: 1, inputRefs: snapshotRefs, chapterNumber: 1, characterStatus: [{ name: 'Keeper', status: 'Has the log.' }], unrecoveredForeshadowing: [], usedPlotBridges: [{ note: 'The log was recovered.' }] } })
  const snapshotReview = await reviewVersion(h, actor, novel.id, snapshot, 'snapshot-review', 'Has the log.')
  await h.service.attachContinuitySnapshot(actor, { novelId: novel.id, chapterNumber: 1, bodyId: body.artifact.id, continuityId: continuity.artifact.id, snapshotId: snapshot.artifact.id, reviewId: snapshotReview.reviewId })
  const target = { kind: 'chapter-outline' as const, chapterNumber: 2 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId })
  const inputRefs = context.inputRefs.map(ref => ref.id === snapshot.artifact.id
    ? { artifactId: outline.artifact.id, sha256: outline.artifact.sha256 } : { artifactId: ref.id, sha256: ref.sha256 })
  await expect(h.service.saveManuscriptCandidate(actor, { novelId: novel.id, requestId: parseRequestId('wrong-prior'), target, researchPlanId, childSessionId: child,
    output: { version: 1, inputRefs, chapterNumber: 2, title: 'The key', targetWords: 3000, throughLine: 'Find the key.', constraints: [], obligations: context.obligations,
      scenes: [{ id: 'key', purpose: 'Find the key.', action: 'The keeper searches.', obligationIds: ['key'] }] } })).rejects.toThrow(/input/i)
})

it('rejects invalid chapter bounds without opening a writing domain', async () => {
  for (const bounds of [{ minChapterWords: 0, maxChapterWords: 5000 }, { minChapterWords: 3000, maxChapterWords: Infinity }, { minChapterWords: 5000, maxChapterWords: 3000 }]) {
    await expect(useStorage('json', limits, undefined, undefined, bounds)).rejects.toMatchObject({ code: 'invalid-input' })
  }
})

it.each(['json', 'sqlite'] as const)('%s decodes an exact T03 record and retains its brief through a new write', async backend => {
  const novelId = parseNovelId('novel_10000000-0000-4000-8000-000000000001')
  const artifactId = parseArtifactId('artifact_10000000-0000-4000-8000-000000000001')
  const text = 'An existing T03 brief.'
  const ref = { id: artifactId, kind: 'creative-brief' as const, revision: 1, sha256: createHash('sha256').update(text).digest('hex'), chars: text.length, bytes: Buffer.byteLength(text) }
  const oldReference = z.strictObject({ id: artifactIdSchema, kind: z.literal('creative-brief'), revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), chars: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
  const oldDomain = defineDomain({ name: 'story_writing', version: 1, layout: 'single', tables: {
    novels: domainTable(z.strictObject({ id: novelIdSchema, workspace: z.string().min(1), title: z.string().min(1), briefHistory: z.array(oldReference).nonempty(),
      createRequest: z.strictObject({ requestId: requestIdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }), briefRequests: z.tuple([]), recordVersion: z.literal(3),
      researchHistory: z.tuple([]), settingsHistory: z.tuple([]), settingsHeads: z.tuple([]) })),
    artifacts: domainTable(oldReference.extend({ novelId: novelIdSchema, text: z.string() })), selections: domainTable(z.strictObject({ workspace: z.string(), sessionId: z.string(), novelId: z.string() })),
  } })
  const h = await useStorage(backend, limits, undefined, async (facility, root) => {
    const old = await facility.open(oldDomain)
    try {
      await old.table('artifacts').put(artifactId, { ...ref, novelId, text })
      await old.table('novels').put(novelId, { id: novelId, workspace: root, title: 'Existing', briefHistory: [ref],
        createRequest: { requestId: parseRequestId('old-create'), hash: createHash('sha256').update(JSON.stringify(['Existing', text])).digest('hex') }, briefRequests: [],
        recordVersion: 3, researchHistory: [], settingsHistory: [], settingsHeads: [] })
    } finally { await old.close() }
  })
  const actor: Actor = { workspace: h.root, sessionId: child }
  expect(h.service.getManuscript(actor, novelId)).toEqual({ history: [], heads: [], appliedChapters: [] })
  await h.service.saveBrief(actor, { novelId, requestId: parseRequestId('new-brief'), expectedRevision: 1, text: 'A revised brief.' })
  await h.restart()
  expect(h.service.getArtifact(actor, { novelId, artifactId }).text).toBe(text)
  expect(h.service.getNovel(actor, novelId).revision).toBe(2)
})


it.each([
  ['json', 'book-outline'], ['sqlite', 'book-outline'], ['json', 'chapter-outline'], ['sqlite', 'chapter-outline'],
] as const)('%s revises the exact applied %s while preserving its former version', async (backend, kind) => {
  const { h, actor, novel, book, outline, researchPlanId } = await appliedOutline(backend)
  const base = kind === 'book-outline' ? book : outline
  const target = kind === 'book-outline' ? { kind, chapterCount: 2 } : { kind, chapterNumber: 1 }
  const researchInputs = h.service.manuscriptResearchInputs(actor, { novelId: novel.id, target, revisionOf: base.artifact.id })
  expect(researchInputs.at(-1)).toEqual(base.artifact)
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId, revisionOf: base.artifact.id })
  expect(context.inputRefs.at(-1)).toEqual(base.artifact)
  expect(context.revisionOf).toBe(base.artifact.id)
  const old = h.service.getArtifact(actor, { novelId: novel.id, artifactId: base.artifact.id })
  const parsed = StageOutputSchemas[kind].parse(JSON.parse(old.text))
  const output = { ...parsed, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })),
    ...(kind === 'book-outline' ? { contentMarkdown: 'Revised mystery.' } : { throughLine: 'Revised log discovery.' }) }
  const request = { novelId: novel.id, requestId: parseRequestId('revision'), target, researchPlanId, childSessionId: child, revisionOf: base.artifact.id, output }
  const revised = await h.service.saveManuscriptCandidate(actor, request)
  expect(revised).toMatchObject({ revisionOf: base.artifact.id, status: 'candidate', stale: false })
  const reviewed = await reviewVersion(h, actor, novel.id, revised, 'revision-review', 'Revised')
  await expect(h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: revised.artifact.id, reviewId: reviewed.reviewId, expectedAppliedId: null })).rejects.toMatchObject({ code: 'revision-conflict' })
  const applied = await h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: revised.artifact.id, reviewId: reviewed.reviewId, expectedAppliedId: base.artifact.id })
  expect(applied).toMatchObject({ status: 'applied', stale: false })
  if (kind === 'book-outline') expect(h.service.getManuscript(actor, novel.id).history.find(item => item.artifact.id === outline.artifact.id)?.stale).toBe(true)
  await h.restart()
  expect(await h.service.saveManuscriptCandidate(actor, request)).toEqual(applied)
  expect(h.service.getArtifact(actor, { novelId: novel.id, artifactId: base.artifact.id })).toEqual(old)
  expect(h.service.getManuscript(actor, novel.id).heads.some(item => item.artifact.id === applied.artifact.id)).toBe(true)
  expect(() => h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId, revisionOf: base.artifact.id })).toThrow()
})


it.each(['json', 'sqlite'] as const)('%s rejects competing outline revisions after their exact base is replaced', async backend => {
  const { h, actor, novel, book, researchPlanId } = await appliedBook(backend)
  const target = { kind: 'book-outline' as const, chapterCount: 2 }
  const context = h.service.manuscriptInputs(actor, { novelId: novel.id, target, researchPlanId, revisionOf: book.artifact.id })
  const parsed = StageOutputSchemas['book-outline'].parse(JSON.parse(h.service.getArtifact(actor, { novelId: novel.id, artifactId: book.artifact.id }).text))
  const request = { novelId: novel.id, target, researchPlanId, childSessionId: child, revisionOf: book.artifact.id,
    output: { ...parsed, inputRefs: context.inputRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })) } }
  const candidates = await Promise.all(['a', 'b', 'unreviewed'].map(id => h.service.saveManuscriptCandidate(actor, { ...request, requestId: parseRequestId(id) })))
  const a = candidates[0]!, b = candidates[1]!, unreviewed = candidates[2]!
  const reviews = await Promise.all([a, b].map((candidate, i) => reviewVersion(h, actor, novel.id, candidate, `review-${i}`, 'Solve the mystery.')))
  const outcomes = await Promise.allSettled([a, b].map((candidate, i) => h.service.applyManuscriptCandidate(actor, {
    novelId: novel.id, candidateId: candidate.artifact.id, reviewId: reviews[i]!.reviewId, expectedAppliedId: book.artifact.id })))
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
  const applied = h.service.getManuscript(actor, novel.id).heads.find(item => item.target.kind === 'book-outline')!
  const loser = applied.artifact.id === a.artifact.id ? b : a
  expect(h.service.getManuscript(actor, novel.id).history.find(item => item.artifact.id === loser.artifact.id)).toMatchObject({ stale: true, changedInputs: [{ artifactId: book.artifact.id, sha256: book.artifact.sha256 }] })
  await expect(h.service.applyManuscriptCandidate(actor, { novelId: novel.id, candidateId: loser.artifact.id,
    reviewId: reviews[applied.artifact.id === a.artifact.id ? 1 : 0]!.reviewId, expectedAppliedId: applied.artifact.id })).rejects.toMatchObject({ code: 'revision-conflict' })
  await expect(reviewVersion(h, actor, novel.id, unreviewed, 'late-review', 'Solve the mystery.')).rejects.toMatchObject({ code: 'revision-conflict' })
  await expect(h.service.saveManuscriptCandidate(actor, { ...request, requestId: parseRequestId('late-publication') })).rejects.toMatchObject({ code: 'revision-conflict' })
  const brief = await h.service.saveBrief(actor, { novelId: novel.id, requestId: parseRequestId('changed-brief'), expectedRevision: 1, text: 'A mountain mystery.' })
  expect(brief.revision).toBe(2)
  expect(h.service.getManuscript(actor, novel.id).heads.find(item => item.artifact.id === applied.artifact.id)?.stale).toBe(true)
})

it.each(['json', 'sqlite'] as const)('%s restricts revisions to the same outline scope', async backend => {
  const { h, actor, novel, book, outline, researchPlanId } = await appliedOutline(backend)
  expect(() => h.service.manuscriptInputs(actor, { novelId: novel.id, target: { kind: 'book-outline', chapterCount: 3 }, researchPlanId, revisionOf: book.artifact.id })).toThrow()
  expect(() => h.service.manuscriptInputs(actor, { novelId: novel.id, target: { kind: 'chapter-outline', chapterNumber: 2 }, researchPlanId, revisionOf: outline.artifact.id })).toThrow()
  expect(() => h.service.manuscriptInputs(actor, { novelId: novel.id, target: { kind: 'body', chapterNumber: 1 }, researchPlanId, revisionOf: outline.artifact.id })).toThrow()
  expect(() => h.service.settingsInputs(actor, novel.id, 'a1', researchPlanId, book.artifact.id)).toThrow()
})

it.each(['json', 'sqlite'] as const)('%s decodes retained version-four settings and manuscripts with explicit null lineage', async backend => {
  let facility: DomainFacility | undefined
  const h = await useStorage(backend, limits, undefined, async source => { facility = source })
  const { actor, novel, dimension } = await populateSettings(h)
  const collection = await h.service.assembleSettings(actor, { novelId: novel.id, requestId: parseRequestId('collection'), selectedCodes: ['a1'] })
  const original = h.service.getArtifact(actor, { novelId: novel.id, artifactId: collection.artifact.id })
  await h.service.close()
  if (facility === undefined) throw new Error('Missing fixture facility')
  const current = await facility.open(writingDomain)
  const saved = current.table('novels').get(novel.id)
  if (saved === undefined) throw new Error('Missing fixture novel')
  const legacy = { ...saved, recordVersion: 4,
    settingsHistory: saved.settingsHistory.map(({ revisionOf: _lineage, ...record }) => record),
    manuscriptHistory: saved.manuscriptHistory.map(({ revisionOf: _lineage, ...record }) => record) }
  await current.close()
  // This writer transports a complete historical JSON record; the reopened writing service owns schema validation.
  const transport = defineDomain({ ...writingDomain, tables: { ...writingDomain.tables, novels: domainTable(z.json()) } })
  const old = await facility.open(transport)
  try { await old.table('novels').put(novel.id, z.json().parse(legacy)) } finally { await old.close() }
  await h.restart()
  expect(h.service.getSettings(actor, novel.id).applied).toEqual([{ ...dimension, status: 'applied', revisionOf: null,
    review: h.service.getSettings(actor, novel.id).applied[0]!.review }])
  expect(h.service.getManuscript(actor, novel.id).history).toEqual([{ ...collection, revisionOf: null }])
  expect(h.service.getArtifact(actor, { novelId: novel.id, artifactId: collection.artifact.id })).toEqual(original)
  await h.service.saveBrief(actor, { novelId: novel.id, requestId: parseRequestId('after-migration'), expectedRevision: 1, text: 'Changed after migration.' })
  await h.restart()
  expect(h.service.getManuscript(actor, novel.id).history[0]).toMatchObject({ revisionOf: null, stale: true })
})


it.each(['settings', 'manuscript'] as const)('rejects a forged durable %s lineage edge', async kind => {
  const { h, actor, novel, book } = await appliedBook('json')
  await h.service.close()
  const path = join(h.root, 'data', 'story_writing.json')
  const document: { tables: { novels: Record<string, NovelRecord> } } = JSON.parse(await readFile(path, 'utf8'))
  const novelRecord = document.tables.novels[novel.id]!
  const record = kind === 'settings' ? novelRecord.settingsHistory[0]! : novelRecord.manuscriptHistory.find(item => item.artifact.id === book.artifact.id)!
  record.revisionOf = record.artifact.id
  await writeFile(path, JSON.stringify(document))
  await h.restart()
  expect(() => kind === 'settings' ? h.service.getSettings(actor, novel.id) : h.service.getManuscript(actor, novel.id)).toThrow(/verif/i)
})


it('rejects a reordered settings lineage index on durable readback', async () => {
  const { h, actor, novel, dimension, output, researchPlanId } = await preparedSettings('json')
  const refs = h.service.settingsInputs(actor, novel.id, 'a1', researchPlanId, dimension.artifact.id)
  const candidate = await h.service.saveSettingsCandidate(actor, { novelId: novel.id, requestId: parseRequestId('revision'), dimensionCode: 'a1', researchPlanId,
    childSessionId: child, revisionOf: dimension.artifact.id, output: { ...output, inputRefs: refs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })) } })
  await h.service.close()
  const path = join(h.root, 'data', 'story_writing.json')
  const document: { tables: { novels: Record<string, NovelRecord> } } = JSON.parse(await readFile(path, 'utf8'))
  const record = document.tables.novels[novel.id]!.settingsHistory.find(item => item.artifact.id === candidate.artifact.id)!
  record.inputRefs.reverse()
  await writeFile(path, JSON.stringify(document))
  await h.restart()
  expect(() => h.service.getSettings(actor, novel.id)).toThrow(/verif/i)
})
