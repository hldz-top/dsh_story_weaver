/** Author settings import through the writing runner: run exclusion, resume refusal, pending review and the import-aware stop. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { executeRegisteredTool } from './support/tool-batch.ts'
import { expect, it } from 'vitest'
import { ImportRefusedError, parseRequestId, type ArtifactId } from '../src/contracts.ts'
import { parseStoryArtifactPreview } from '../src/preview-result.ts'
import { openRunStore } from '../src/run-store.ts'
import { WritingRunner } from '../src/writing-runner.ts'
import { StageDeliveries } from '../src/stage-deliveries.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureOptions, type WritingFixtureStage } from './support/writing-fixture.ts'

const SLOW = 240_000
type Fixture = Awaited<ReturnType<typeof useWritingFixture>>

const BATCH_QUOTE = '本书是一部发生在虚构雾港的悬疑冒险小说。'
/** A blocking conflict on the cross-dimension consistency review. */
function blockCollection(stage: WritingFixtureStage, output: object): object {
  if (stage.kind === 'settings' && stage.task?.batch === 'consistency') {
    return { issues: [{ dimension: stage.task.codes?.[0] ?? 'a1', kind: 'conflict', quote: BATCH_QUOTE }] }
  }
  return output
}

async function written(roots: readonly string[], options: WritingFixtureOptions = {}) {
  const fixture = await useWritingFixture(options)
  const result = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: [...roots], chapterCount: 1, throughChapter: 1 }))
  if (result.status !== 'fulfilled' || result.value.status !== 'completed') throw new Error(`Setup run did not complete: ${JSON.stringify(result)}`)
  return fixture
}

function head(fixture: Fixture, code: string) {
  const item = fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.find(entry => entry.dimensionCode === code)
  if (item === undefined) throw new Error(`No ${code} head`)
  return item
}

async function importText(fixture: Fixture, code: string, label: string, expected?: ArtifactId) {
  const current = head(fixture, code)
  const text = JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: current.artifact.id }).text) as Record<string, unknown>
  const output = { ...text, inputRefs: [], contentMarkdown: `# 作者导入 ${code}\n\n${label}`, facts: [{ id: `import-${code}`, statement: `本书是一部发生在虚构雾港的悬疑冒险小说。${label}` }] }
  return fixture.run(exec => fixture.runner.importSettings(exec, { novelId: fixture.novel.id, requestId: parseRequestId(`import-${code}-${label}`), dimensionCode: code, expectedAppliedId: expected ?? current.artifact.id, output }))
}

const lastLine = (cause: unknown) => JSON.parse(String((cause as Error).message).split('\n').at(-1) ?? '') as unknown
const update = (fixture: Fixture, requestId: string, roots: readonly string[]) =>
  fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, requestId: parseRequestId(requestId), settingsRoots: [...roots], chapterCount: 1, throughChapter: 1, mode: 'update' }))
const keys = (fixture: Fixture, runId: Parameters<Fixture['runs']['get']>[1]) => fixture.runs.get(fixture.actor, runId).attempts.map(attempt => attempt.key)

it('A1: refuses an import while the novel has a running run, with a machine-readable reason and no store change', async () => {
  const fixture = await written(['a1'])
  const before = fixture.service.getSettings(fixture.actor, fixture.novel.id)
  const running = await fixture.runs.begin(fixture.actor, { ...fixture.input, requestId: parseRequestId('running'), chapterCount: 1, throughChapter: 1, mode: 'update', revision: null, executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } })
  const refused = await importText(fixture, 'a1', '运行中')
  expect(refused.status).toBe('rejected')
  const reason = refused.status === 'rejected' ? refused.reason : null
  expect(reason).toBeInstanceOf(ImportRefusedError)
  expect(reason).toMatchObject({ code: 'import-refused', reason: 'run-active', runId: running.id })
  expect(lastLine(reason)).toEqual({ code: 'import-refused', reason: 'run-active', runId: running.id })
  expect(fixture.service.getSettings(fixture.actor, fixture.novel.id)).toEqual(before)
}, SLOW)

it('A2/A3: refuses an import while a run is interrupted after restart; allows it once the run is stopped, and a failed run is not active', async () => {
  const fixture = await written(['a1'])
  const running = await fixture.runs.begin(fixture.actor, { ...fixture.input, requestId: parseRequestId('interrupted'), chapterCount: 1, throughChapter: 1, mode: 'update', revision: null, executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } })
  await fixture.runs.close()
  const reopened = await openRunStore(fixture.ctx.storageDomain, { maxAttempts: 256, maxOutputBytes: 262_144 })
  fixture.ctx.effect(() => () => reopened.close())
  expect(reopened.get(fixture.actor, running.id).status).toBe('interrupted')
  const runner = new WritingRunner(fixture.ctx, fixture.service, reopened, fixture.runner.limits, new StageDeliveries(fixture.ctx, fixture.service, reopened, '.dsh-story'), { allowIncompleteSettings: true })
  fixture.ctx.effect(() => () => runner.close())
  const current = head(fixture, 'a1')
  const output = { ...JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: current.artifact.id }).text) as object, contentMarkdown: '# 作者导入' }
  const request = { novelId: fixture.novel.id, requestId: parseRequestId('import-interrupted'), dimensionCode: 'a1', expectedAppliedId: current.artifact.id, output }
  const refused = await fixture.run(exec => runner.importSettings(exec, request))
  expect(refused).toMatchObject({ status: 'rejected', reason: { code: 'import-refused', reason: 'run-active', runId: running.id } })
  await reopened.finish(fixture.actor, running.id, 'failed', 'Simulated failure')
  const allowed = await fixture.run(exec => runner.importSettings(exec, request))
  expect(allowed).toMatchObject({ status: 'fulfilled', value: { origin: 'import', pendingReview: true, status: 'applied', revisionOf: current.artifact.id } })
}, SLOW)

it('E2/E3/E4: a pending import is not complete; no outline can use the settings; a new story_update reviews it without regenerating it', async () => {
  const fixture = await written(['a1'])
  const old = head(fixture, 'a1')
  const imported = await importText(fixture, 'a1', '导入一')
  if (imported.status !== 'fulfilled') throw new Error(String(imported.reason))
  expect(imported.value).toMatchObject({ origin: 'import', pendingReview: true, status: 'applied', stale: false, revisionOf: old.artifact.id, review: null, childSessionId: fixture.actor.sessionId })
  expect(head(fixture, 'a1').pendingReview).toBe(true)
  const old0 = fixture.service.getSettings(fixture.actor, fixture.novel.id).history.find(item => item.artifact.id === old.artifact.id)
  expect(old0).toMatchObject({ origin: 'stage', pendingReview: false })
  // E3: every downstream context refuses the pending collection before any research or stage.
  expect(() => fixture.service.manuscriptResearchInputs(fixture.actor, { novelId: fixture.novel.id, target: { kind: 'book-outline', chapterCount: 1 } })).toThrowError(expect.objectContaining({ code: 'revision-conflict' }))
  const book = fixture.service.getManuscript(fixture.actor, fixture.novel.id).heads.find(item => item.target.kind === 'book-outline')
  if (book === undefined) throw new Error('No book outline head')
  const revised = await fixture.run(exec => fixture.runner.revise(exec, { ...fixture.input, requestId: parseRequestId('revise-book'), chapterCount: 1, throughChapter: 1, mode: 'revise', revision: { baseArtifactId: book.artifact.id, instructions: '更紧凑。' } }))
  expect(revised).toMatchObject({ status: 'fulfilled', value: { status: 'failed' } })
  if (revised.status === 'fulfilled') expect(revised.value.attempts).toEqual([])
  // E4: the new run reviews the assembled settings with the import and does not regenerate it.
  const updated = await update(fixture, 'update-after-import', ['a1'])
  if (updated.status !== 'fulfilled') throw new Error(String(updated.reason))
  expect(updated.value.status).toBe('completed')
  expect(keys(fixture, updated.value.id).filter(key => key.startsWith('settings/0/a1/'))).toEqual([])
  expect(keys(fixture, updated.value.id)).toContain('settings/collection/0/review/0')
  expect(head(fixture, 'a1')).toMatchObject({ artifact: imported.value.artifact, origin: 'import', pendingReview: false })
}, SLOW)

it('A6: refuses to resume a run while an import in its settings awaits review', async () => {
  const fixture = await written(['a1'])
  const stopped = await fixture.runs.begin(fixture.actor, { ...fixture.input, requestId: parseRequestId('stopped'), chapterCount: 1, throughChapter: 1, mode: 'update', revision: null, executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } })
  await fixture.runs.finish(fixture.actor, stopped.id, 'stopped', 'Stopped by the author.')
  const imported = await importText(fixture, 'a1', '待复核')
  if (imported.status !== 'fulfilled') throw new Error(String(imported.reason))
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, stopped.id, false))
  expect(resumed.status).toBe('rejected')
  const reason = resumed.status === 'rejected' ? resumed.reason : null
  expect(reason).toBeInstanceOf(ImportRefusedError)
  expect(lastLine(reason)).toEqual({ code: 'import-refused', reason: 'pending-review', runId: stopped.id, importItems: [{ dimensionCode: 'a1', artifactId: imported.value.artifact.id, pendingReview: true }] })
  expect(fixture.runs.get(fixture.actor, stopped.id)).toMatchObject({ status: 'stopped', attempts: [] })
}, SLOW)

it('F1/F2: a blocking collection review over an import stops the run with review-blocked, regenerating nothing', async () => {
  let block = false
  const fixture = await written(['a1'], { intervene: (stage, output) => block ? blockCollection(stage, output) : output })
  const imported = await importText(fixture, 'a1', '有矛盾')
  if (imported.status !== 'fulfilled') throw new Error(String(imported.reason))
  block = true
  const updated = await update(fixture, 'update-blocked', ['a1'])
  if (updated.status !== 'fulfilled') throw new Error(String(updated.reason))
  expect(updated.value.status).toBe('failed')
  expect(JSON.parse(updated.value.error?.split('\n').at(-1) ?? '')).toEqual({ code: 'review-blocked', importItems: [{ dimensionCode: 'a1', artifactId: imported.value.artifact.id, pendingReview: true }] })
  expect(keys(fixture, updated.value.id).filter(key => key.startsWith('settings/1/') || key.startsWith('settings/0/a1/'))).toEqual([])
  expect(head(fixture, 'a1')).toMatchObject({ artifact: imported.value.artifact, pendingReview: true })
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).heads.find(item => item.target.kind === 'settings')?.stale).toBe(true)
}, SLOW)

it('F3: without imports a blocking collection review still triggers cross-dimension repair', async () => {
  let blocks = 0
  const blocked = await useWritingFixture({ intervene: (stage, output) => {
    const changed = blockCollection(stage, output)
    if (changed !== output && blocks === 0) { blocks += 1; return changed }
    return output
  } })
  const result = await blocked.run(exec => blocked.runner.start(exec, { ...blocked.input, settingsRoots: ['a1'], chapterCount: 1, throughChapter: 1 }))
  if (result.status !== 'fulfilled') throw new Error(String(result.reason))
  expect(result.value.status).toBe('completed')
  expect(blocks).toBe(1)
  expect(keys(blocked, result.value.id).some(key => key.startsWith('settings/repair/'))).toBe(true)
}, SLOW)

it('F5: a released import still stops repair when a later collection review blocks (imported text is never silently regenerated)', async () => {
  let block = false
  const fixture = await written(['a2'], { intervene: (stage, output) => block ? blockCollection(stage, output) : output })
  const imported = await importText(fixture, 'a1', '已放行')
  if (imported.status !== 'fulfilled') throw new Error(String(imported.reason))
  // a2 depends on a1, so a2 is now stale and regenerated by this run; the import itself is reviewed and released.
  const released = await update(fixture, 'update-release', ['a2'])
  if (released.status !== 'fulfilled') throw new Error(String(released.reason))
  expect(released.value.status).toBe('completed')
  expect(head(fixture, 'a1')).toMatchObject({ origin: 'import', pendingReview: false })
  const a2 = head(fixture, 'a2')
  const revised = await fixture.run(exec => fixture.runner.revise(exec, { ...fixture.input, requestId: parseRequestId('revise-a2'), settingsRoots: ['a2'], chapterCount: 1, throughChapter: 1, mode: 'revise', revision: { baseArtifactId: a2.artifact.id, instructions: '换个流派。' } }))
  expect(revised).toMatchObject({ status: 'fulfilled', value: { status: 'completed' } })
  block = true
  const stopped = await update(fixture, 'update-after-release', ['a2'])
  if (stopped.status !== 'fulfilled') throw new Error(String(stopped.reason))
  expect(stopped.value.status).toBe('failed')
  expect(JSON.parse(stopped.value.error?.split('\n').at(-1) ?? '')).toEqual({ code: 'review-blocked', importItems: [{ dimensionCode: 'a1', artifactId: imported.value.artifact.id, pendingReview: false }] })
  expect(keys(fixture, stopped.value.id).filter(key => key.startsWith('settings/1/'))).toEqual([])
  expect(head(fixture, 'a1').artifact).toEqual(imported.value.artifact)
  // F2: resuming the stopped run replays its blocking round-0 review and stops again instead of entering round 1.
  const resumed = await fixture.run(exec => fixture.runner.resume(exec, stopped.value.id, false))
  if (resumed.status !== 'fulfilled') throw new Error(String(resumed.reason))
  expect(resumed.value.status).toBe('failed')
  expect(JSON.parse(resumed.value.error?.split('\n').at(-1) ?? '')).toEqual({ code: 'review-blocked', importItems: [{ dimensionCode: 'a1', artifactId: imported.value.artifact.id, pendingReview: false }] })
  expect(keys(fixture, stopped.value.id).filter(key => key.startsWith('settings/1/'))).toEqual([])
  expect(head(fixture, 'a1').artifact).toEqual(imported.value.artifact)
}, SLOW)

it('B-1: a stale import is never regenerated in round 0; the run stops before any settings work and asks for a re-import', async () => {
  const fixture = await written(['a2'])
  const a1 = await importText(fixture, 'a1', '第一版')
  if (a1.status !== 'fulfilled') throw new Error(String(a1.reason))
  const a2 = await importText(fixture, 'a2', '作者流派')
  if (a2.status !== 'fulfilled') throw new Error(String(a2.reason))
  // Re-importing only the upstream a1 leaves the imported a2 stale.
  const again = await importText(fixture, 'a1', '第二版')
  if (again.status !== 'fulfilled') throw new Error(String(again.reason))
  expect(head(fixture, 'a2')).toMatchObject({ artifact: a2.value.artifact, origin: 'import', stale: true })
  const updated = await update(fixture, 'update-stale-import', ['a2'])
  if (updated.status !== 'fulfilled') throw new Error(String(updated.reason))
  expect(updated.value.status).toBe('failed')
  expect(updated.value.error).toContain('Import them again in dependency order')
  expect(JSON.parse(updated.value.error?.split('\n').at(-1) ?? '')).toEqual({ code: 'review-blocked', reason: 'stale-import', importItems: [{ dimensionCode: 'a2', artifactId: a2.value.artifact.id, pendingReview: true }] })
  expect(keys(fixture, updated.value.id).filter(key => key.startsWith('settings/'))).toEqual([])
  expect(head(fixture, 'a2').artifact).toEqual(a2.value.artifact)
  // Re-importing the downstream dimension in dependency order clears the stop; the update reviews both without regenerating them.
  const fixed = await importText(fixture, 'a2', '作者流派二')
  if (fixed.status !== 'fulfilled') throw new Error(String(fixed.reason))
  const reviewed = await update(fixture, 'update-after-reimport', ['a2'])
  if (reviewed.status !== 'fulfilled') throw new Error(String(reviewed.reason))
  expect(reviewed.value.status).toBe('completed')
  expect(keys(fixture, reviewed.value.id).filter(key => key.startsWith('settings/0/'))).toEqual([])
  expect(head(fixture, 'a2')).toMatchObject({ artifact: fixed.value.artifact, pendingReview: false })
}, SLOW)

it('keeps imported settings readable as a document', async () => {
  const fixture = await written(['a1'])
  const imported = await importText(fixture, 'a1', '可读')
  if (imported.status !== 'fulfilled') throw new Error(String(imported.reason))
  const stored = fixture.service.getArtifact(fixture.actor, { novelId: fixture.novel.id, artifactId: imported.value.artifact.id })
  expect(StageOutputSchemas.settings.parse(JSON.parse(stored.text))).toMatchObject({ dimensionCode: 'a1', facts: [{ id: 'import-a1' }] })
  const preview = async (artifactId: ArtifactId) => {
    const outcome = await executeRegisteredTool(fixture.ctx, { name: 'story_preview', arguments: { novelId: fixture.novel.id, artifactId }, agent: fixture.parent, signal: new AbortController().signal })
    if (outcome.isError) throw new Error(outcome.error.message)
    const path = parseStoryArtifactPreview(outcome.value)?.path
    if (path === undefined) throw new Error('Expected preview metadata')
    return readFile(isAbsolute(path) ? path : join(fixture.root, path), 'utf8')
  }
  expect(await preview(imported.value.artifact.id)).toContain('Document: Author import (人工导入)')
  const generated = await preview(imported.value.revisionOf!)
  expect(generated).toContain('Document: Generated candidate')
  expect(generated).not.toContain('人工导入')
}, SLOW)
