import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { artifactMarkdown, referencedContentDigests } from '../src/artifact-markdown.ts'
import { parseArtifactId, parseNovelId, parseRequestId, type Actor, type Artifact, type ArtifactKind, type RequestId } from '../src/contracts.ts'
import { projectionTexts } from '../src/projection.ts'
import { allocateSpecIdentity, resolveSpecIdentity, snapshotMatchesSpec } from '../src/spec-identity.ts'
import { buildStagePrompt, CURRENT_PROMPT_VERSION } from '../src/stage-prompts.ts'
import type { NovelRecord } from '../src/records.ts'
import { useStorage, type StorageKind } from './support/storage.ts'
import { useRunStorage } from './support/run-storage.ts'

const requestId = (value: string): RequestId => brandString<RequestId>(value)

const limits = { maxArtifactBytes: 4096, maxReadChars: 64 }
const actor = (workspace: string): Actor => ({ workspace, sessionId: brandString<SessionId>('author-session') })
const occupied = `aaaaaaaa${'00'.repeat(28)}`
const colliding = `aaaaaaaa${'11'.repeat(28)}`
const example = `1d387317${'ab'.repeat(28)}`

function digestOf(text: string): string { return createHash('sha256').update(text).digest('hex') }

it('allocates eight lowercase hex characters and refuses to alias a collided prefix', () => {
  expect(allocateSpecIdentity([], example)).toMatchObject({ id: '1d387317' })
  const first = allocateSpecIdentity([], occupied)
  expect(first.id).toBe('aaaaaaaa')
  const second = allocateSpecIdentity(first.entries, colliding)
  expect(second.id).toBe('aaaaaaab')
  expect(second.id).not.toBe(colliding.slice(0, 8))
  const repeated = allocateSpecIdentity(second.entries, colliding)
  expect(repeated).toEqual({ entries: second.entries, id: second.id })
  expect(resolveSpecIdentity(second.entries, second.id)).toEqual({ kind: 'allocated', digest: colliding, id: 'aaaaaaab' })
  expect(resolveSpecIdentity(second.entries, 'aaaaaaaa')).toEqual({ kind: 'allocated', digest: occupied, id: 'aaaaaaaa' })
  expect(resolveSpecIdentity([], colliding.slice(0, 8))).toBeUndefined()
  expect(resolveSpecIdentity([], colliding)).toEqual({ kind: 'legacy-digest', digest: colliding })
  expect(snapshotMatchesSpec({ briefSha256: colliding }, colliding.slice(0, 8), [])).toBe(false)
  expect(snapshotMatchesSpec({ briefSha256: colliding }, colliding, [])).toBe(true)
  expect(snapshotMatchesSpec({ briefSha256: colliding }, 'aaaaaaaa', second.entries)).toBe(false)
  expect(snapshotMatchesSpec({ briefSha256: colliding, briefId: 'aaaaaaab' }, 'aaaaaaaa', second.entries)).toBe(false)
  expect(() => allocateSpecIdentity([], 'aaaaaaaa')).toThrow(/64 lowercase hexadecimal/)
  expect(() => allocateSpecIdentity([], 'A'.repeat(64))).toThrow(/64 lowercase hexadecimal/)
})

it('keeps prompt version 15 and the full digest inside stage prompts', () => {
  expect(CURRENT_PROMPT_VERSION).toBe(15)
  const prompt = buildStagePrompt({
    novelId: 'novel_00000000-0000-4000-8000-000000000000' as never,
    inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }],
    task: '{"x":1}', requirements: ['r1'], kind: 'body', promptVersion: 15,
  })
  expect(prompt).toContain('0'.repeat(64))
})

it('labels an allocated reference as an id and leaves checksum lines unchanged', () => {
  const novel = parseNovelId('novel_00c38d7c-50d8-4a1b-93f0-188daf5a9859')
  const id = parseArtifactId('artifact_00c38d7c-50d8-4a1b-93f0-188daf5a9859')
  const inputDigest = 'a'.repeat(64)
  const text = JSON.stringify({ version: 1, dimensionCode: 'a1', inputRefs: [{ artifactId: id, sha256: inputDigest }], facts: [{ id: 'genre', statement: 'A mystery.' }], contentMarkdown: 'Harbor' })
  const stored: Artifact = {
    id, novelId: novel, kind: 'settings-dimension', revision: 1, text,
    sha256: digestOf(text), chars: [...text].length, bytes: Buffer.byteLength(text),
  }
  const legacy = artifactMarkdown(stored)
  expect(legacy).toContain(`Input 1 SHA-256: ${inputDigest}`)
  expect(legacy).toContain(`Artifact SHA-256: ${stored.sha256}`)
  const specIds = new Map([[inputDigest, '1d387317'], [stored.sha256, 'ffffffff']])
  const current = artifactMarkdown(stored, { specIds })
  expect(current).toContain('Input 1 ID: 1d387317')
  expect(current).not.toContain('Input 1 SHA-256')
  expect(current).not.toContain(inputDigest)
  expect(current).toContain(`Artifact SHA-256: ${stored.sha256}`)
  expect(referencedContentDigests(stored)).toEqual([inputDigest])
  const texts = projectionTexts(stored, false, specIds)
  expect(texts.current).toBe(current)
  expect(texts.current).not.toContain('Input 1 SHA-256')
  // The older string is only how an unmodified 0.2.1 file is recognized so it can be replaced.
  expect(texts.previous).toContain(legacy)
  const source = 'b'.repeat(64)
  const evidenceText = JSON.stringify({
    version: 1, novelId: novel, briefArtifactId: id, sessionId: 'author', startSeq: 1, planId: id, outcome: 'insufficient',
    findings: [{ questionId: 'q', callIds: ['call'], conclusion: '不足。', adequate: false, outcome: 'insufficient' }],
    observations: [{ callId: 'call', name: 'web_search', input: { queries: ['tide'] }, callSeq: 1, resultSeq: 2, status: 'succeeded', error: null,
      sources: [{ sourceIndex: 0, url: 'https://example.test/tide', title: null, excerpt: 'tide', offset: 0, totalChars: 4, sha256: source, truncated: false }] }],
  })
  const evidence: Artifact = { ...stored, kind: 'research-evidence', text: evidenceText, sha256: digestOf(evidenceText), chars: [...evidenceText].length, bytes: Buffer.byteLength(evidenceText) }
  const rendered = artifactMarkdown(evidence, { specIds: new Map([[source, '1d387317']]) })
  expect(rendered).toContain(`Recorded source SHA-256: ${source}`)
  expect(rendered).not.toContain('Recorded source ID')
  expect(referencedContentDigests(evidence)).toEqual([])
})

describe.each(['json', 'sqlite'] as const)('%s specification identities', (backend: StorageKind) => {
  it('reuses one id for the same specification, isolates projects, and keeps the allocation after restart', async () => {
    const h = await useStorage(backend, limits)
    const owner = actor(join(h.root, 'author'))
    const [left, right] = await Promise.all([
      h.service.createNovel(owner, { requestId: requestId('left'), title: '左', brief: '同一规格。' }),
      h.service.createNovel(owner, { requestId: requestId('right'), title: '右', brief: '同一规格。' }),
    ])
    expect(left.brief.sha256).toBe(right.brief.sha256)
    expect(left.brief.sha256).toHaveLength(64)
    const leftId = await h.service.allocateSpecIdentities(owner, left.id, [left.brief.sha256])
    const rightId = await h.service.allocateSpecIdentities(owner, right.id, [right.brief.sha256])
    expect(leftId[0]?.id).toMatch(/^[a-f0-9]{8}$/)
    expect(rightId[0]?.id).toMatch(/^[a-f0-9]{8}$/)
    const collided = await h.service.allocateSpecIdentities(owner, left.id, [occupied, colliding])
    expect(collided.map(entry => entry.id)).toEqual(['aaaaaaaa', 'aaaaaaab'])
    const isolated = await h.service.allocateSpecIdentities(owner, right.id, [colliding])
    expect(isolated[0]).toEqual({ digest: colliding, id: 'aaaaaaaa' })
    expect(h.service.resolveSpecIdentity(owner, left.id, 'aaaaaaaa')).toEqual({ kind: 'allocated', digest: occupied, id: 'aaaaaaaa' })
    expect(h.service.resolveSpecIdentity(owner, right.id, 'aaaaaaaa')).toEqual({ kind: 'allocated', digest: colliding, id: 'aaaaaaaa' })
    expect(h.service.resolveSpecIdentity(owner, left.id, colliding.slice(0, 8))).not.toMatchObject({ digest: colliding })
    await h.service.close()
    await h.restart()
    expect(await h.service.allocateSpecIdentities(owner, left.id, [colliding, occupied])).toEqual([
      { digest: colliding, id: 'aaaaaaab' }, { digest: occupied, id: 'aaaaaaaa' },
    ])
    expect(h.service.getArtifact(owner, { novelId: left.id, artifactId: left.brief.id }).sha256).toBe(digestOf('同一规格。'))
    await h.service.close()
    const reread = await readNovel(backend, h.root, left.id)
    expect(reread.specIdentities).toEqual(expect.arrayContaining([
      { digest: occupied, id: 'aaaaaaaa' }, { digest: colliding, id: 'aaaaaaab' }, { digest: left.brief.sha256, id: leftId[0]?.id },
    ]))
    const artifact = await readArtifact(backend, h.root, left.brief.id)
    expect(artifact.sha256).toBe(left.brief.sha256)
    expect(artifact.text).toBe('同一规格。')
  })

  it('allocates distinct ids for concurrent requests and retries the same binding', async () => {
    const h = await useStorage(backend, limits)
    const owner = actor(join(h.root, 'author'))
    const novel = await h.service.createNovel(owner, { requestId: requestId('concurrent'), title: '并发', brief: '并发规格。' })
    const other = `aaaaaaaa${'22'.repeat(28)}`
    const [first, second] = await Promise.all([
      h.service.allocateSpecIdentities(owner, novel.id, [occupied]),
      h.service.allocateSpecIdentities(owner, novel.id, [other]),
    ])
    expect(first[0]?.id).not.toBe(second[0]?.id)
    const [againFirst, againSecond] = await Promise.all([
      h.service.allocateSpecIdentities(owner, novel.id, [occupied, occupied]),
      h.service.allocateSpecIdentities(owner, novel.id, [other]),
    ])
    expect(againFirst).toEqual(first)
    expect(againSecond).toEqual(second)
    expect(h.service.specIdentityMap(owner, novel.id).get(occupied)).toBe(first[0]?.id)
    await expect(h.service.allocateSpecIdentities(owner, novel.id, ['abc'])).rejects.toMatchObject({ code: 'invalid-input' })
    expect(() => h.service.resolveSpecIdentity(owner, novel.id, 'ABCDEFGH')).toThrowError(expect.objectContaining({ code: 'invalid-input' }))
    expect(h.service.resolveSpecIdentity(owner, novel.id, '1d387317')).toEqual({ kind: 'unknown' })
  })
})

it('reads a legacy 64-character snapshot without rewriting it and resumes by that digest or its later id', async () => {
  const h = await useStorage('json', limits)
  const owner = actor(join(h.root, 'author'))
  const novel = await h.service.createNovel(owner, { requestId: requestId('legacy'), title: '旧档', brief: '旧规格。' })
  const settingsText = '{"legacy":true}'
  const settingsSha = digestOf(settingsText)
  const settingsId = parseArtifactId('artifact_00000000-0000-4000-8000-0000000000aa')
  await h.service.close()
  const file = join(h.root, 'data', 'story_writing.json')
  const before = await readFile(file, 'utf8')
  const document = JSON.parse(before) as { tables: { novels: Record<string, NovelRecord & { specIdentities?: unknown }>; artifacts: Record<string, { id: string; novelId: string; kind: string; revision: number; text: string; sha256: string; chars: number; bytes: number }> } }
  const storedNovel = document.tables.novels[novel.id]
  const briefArtifact = document.tables.artifacts[novel.brief.id]
  if (storedNovel === undefined || briefArtifact === undefined) throw new Error('Legacy fixture is missing')
  delete storedNovel.specIdentities
  storedNovel.settingsSnapshots = [{ briefSha256: novel.brief.sha256, roots: ['a1'], artifactId: settingsId }]
  storedNovel.manuscriptHistory = [{
    artifact: { id: settingsId, kind: 'settings', revision: 1, sha256: settingsSha, chars: [...settingsText].length, bytes: Buffer.byteLength(settingsText) },
    target: { kind: 'settings', selectedCodes: ['a1'] },
    inputRefs: [{ artifactId: novel.brief.id, sha256: novel.brief.sha256 }],
    childSessionId: null, researchPlanId: null,
    request: { requestId: requestId('legacy-snapshot'), hash: 'ab'.repeat(32) },
    reviewHistory: [], applied: false, revisionOf: null,
  }]
  document.tables.artifacts[settingsId] = {
    id: settingsId, novelId: novel.id, kind: 'settings' as ArtifactKind, revision: 1, text: settingsText,
    sha256: settingsSha, chars: [...settingsText].length, bytes: Buffer.byteLength(settingsText),
  }
  const legacyFile = `${JSON.stringify(document, null, 2)}\n`
  await writeFile(file, legacyFile)
  await h.restart()
  expect(h.service.resolveSpecIdentity(owner, novel.id, novel.brief.sha256)).toEqual({ kind: 'legacy-digest', digest: novel.brief.sha256 })
  expect(h.service.findSettingsSnapshot(owner, novel.id, novel.brief.sha256, ['a1'])).toMatchObject({ artifactId: settingsId, briefSha256: novel.brief.sha256 })
  expect(h.service.findSettingsSnapshot(owner, novel.id, novel.brief.sha256.slice(0, 8), ['a1'])).toBeUndefined()
  expect(h.service.findSettingsSnapshot(owner, novel.id, novel.brief.sha256, ['a1'])).not.toHaveProperty('briefId')
  await h.service.saveSettingsSnapshot(owner, novel.id, { briefSha256: novel.brief.sha256, roots: ['a1'], artifactId: settingsId })
  const allocated = h.service.resolveSpecIdentity(owner, novel.id, novel.brief.sha256)
  expect(allocated.kind).toBe('allocated')
  if (allocated.kind !== 'allocated') return
  expect(h.service.findSettingsSnapshot(owner, novel.id, allocated.id, ['a1'])).toMatchObject({ artifactId: settingsId, briefSha256: novel.brief.sha256 })
  expect(h.service.findSettingsSnapshot(owner, novel.id, occupied.slice(0, 8), ['a1'])).toBeUndefined()
  await h.service.close()
  const reread = JSON.parse(await readFile(file, 'utf8')) as typeof document
  expect(reread.tables.novels[novel.id]?.settingsSnapshots).toEqual([{ briefSha256: novel.brief.sha256, roots: ['a1'], artifactId: settingsId }])
  expect(reread.tables.artifacts[novel.brief.id]).toEqual(briefArtifact)
    expect(reread.tables.artifacts[settingsId]?.sha256).toBe(settingsSha)
    expect(reread.tables.novels[novel.id]?.manuscriptHistory[0]?.inputRefs).toEqual([{ artifactId: novel.brief.id, sha256: novel.brief.sha256 }])
  })

it('resumes a stopped run whose stage input digest stays 64 characters', async () => {
  const runLimits = { maxAttempts: 4, maxOutputBytes: 1024 }
  const serviceLimits = { maxArtifactBytes: 4096, maxReadChars: 512, maxResearchQuestions: 4, maxResearchCalls: 2, maxResearchSources: 4, maxEvidenceChars: 1024, maxResearchLogEvents: 20 }
  const owner: Actor = { workspace: '/author', sessionId: brandString<SessionId>('author-session') }
  const input = {
    serviceLimits,
    novelId: parseNovelId('novel_00000000-0000-4000-8000-000000000001'),
    requestId: parseRequestId('legacy-run'),
    briefArtifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'),
    executionLimits: { maxRepairAttempts: 1, maxParallelStages: 1, maxStageRequests: 2, stageTimeoutMs: 1000, maxDelegationDepth: 1, minChapterWords: 3000, maxChapterWords: 5000, stageProvider: 'fixture-spawn' },
    settingsRoots: ['a1'], chapterCount: 1, fromChapter: 1, throughChapter: 1, mode: 'write' as const, revision: null,
  }
  const stage = {
    key: 'settings:a1', prompt: 'Use the stored brief.', outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
    inputRefs: [{ artifactId: input.briefArtifactId, sha256: 'cd'.repeat(32) }],
  }
  const h = await useRunStorage('json', runLimits)
  const begun = await h.store.begin(owner, input)
  const prepared = await h.store.prepareAttempt(owner, begun.id, stage)
  expect(prepared.inputRefs[0]?.sha256).toHaveLength(64)
  const stopped = await h.store.finish(owner, begun.id, 'stopped', 'Stop before resume.')
  expect(stopped.attempts[0]?.status).toBe('unknown')
  expect(stopped.attempts[0]?.inputRefs).toEqual(stage.inputRefs)
  await h.restart()
  const resumed = await h.store.resume(owner, stopped.id, { retryUnknown: true })
  expect(resumed.status).toBe('running')
  expect(resumed.attempts[0]?.inputRefs).toEqual(stage.inputRefs)
  expect(resumed.attempts[0]?.inputRefs[0]?.sha256).toHaveLength(64)
  const retried = await h.store.prepareAttempt(owner, resumed.id, stage)
  expect(retried.inputRefs).toEqual(stage.inputRefs)
  await expect(h.store.prepareAttempt(owner, resumed.id, { ...stage, inputRefs: [{ artifactId: input.briefArtifactId, sha256: 'cd'.repeat(4) }] })).rejects.toThrow()
})

async function readNovel(backend: StorageKind, root: string, id: string): Promise<NovelRecord> {
  if (backend === 'json') {
    const document = JSON.parse(await readFile(join(root, 'data', 'story_writing.json'), 'utf8')) as { tables: { novels: Record<string, NovelRecord> } }
    const record = document.tables.novels[id]
    if (record === undefined) throw new Error('JSON novel is missing')
    return record
  }
  return JSON.parse(readSqlite(root, 'u_story_writing_novels', id)) as NovelRecord
}

async function readArtifact(backend: StorageKind, root: string, id: string): Promise<{ text: string; sha256: string }> {
  if (backend === 'json') {
    const document = JSON.parse(await readFile(join(root, 'data', 'story_writing.json'), 'utf8')) as { tables: { artifacts: Record<string, { text: string; sha256: string }> } }
    const record = document.tables.artifacts[id]
    if (record === undefined) throw new Error('JSON artifact is missing')
    return record
  }
  return JSON.parse(readSqlite(root, 'u_story_writing_artifacts', id)) as { text: string; sha256: string }
}

function readSqlite(root: string, table: string, key: string): string {
  const db = new DatabaseSync(join(root, 'data.sqlite'), { readOnly: true })
  try {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value?: string } | undefined
    if (typeof row?.value !== 'string') throw new Error(`SQLite row ${table}/${key} is missing`)
    return row.value
  } finally { db.close() }
}
