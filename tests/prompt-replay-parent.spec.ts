/** Versions 1–14 rebuild the prompt and schema bytes of parent 334136f8, computed from that commit. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildBodyRepairPrompt } from '../src/body-repair.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { buildStagePrompt, type PromptVersion, type StagePromptKind } from '../src/stage-prompts.ts'

const PARENT = '334136f8abe08dc2037d385606de47d6025a809a'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'] as const satisfies readonly StagePromptKind[]
const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const satisfies readonly PromptVersion[]
const dimensions = ['enum_single', 'enum_multi', 'llm_free', 'edit_external'] as const
const floors = ['hint', 'notice', 'heavy'] as const

function replayHashes(): Record<string, string> {
  const got: Record<string, string> = {}
  const put = (key: string, text: string) => { got[key] = sha(text) }
  for (const version of versions) {
    for (const kind of kinds) {
      put(`prompt/${version}/${kind}`, buildStagePrompt({ ...base, kind, promptVersion: version }))
      put(`schema/${version}/${kind}`, JSON.stringify(nativeStageOutputSchema(kind, version)))
    }
    for (const reviewedKind of kinds) put(`review/${version}/${reviewedKind}`, buildStagePrompt({ ...base, kind: 'review', reviewedKind, promptVersion: version }))
    const bodyReview = { ...base, kind: 'review' as const, reviewedKind: 'body' as const, promptVersion: version }
    put(`aiToneBlocking/${version}/true`, buildStagePrompt({ ...bodyReview, aiToneBlocking: true }))
    put(`aiToneBlocking/${version}/false`, buildStagePrompt({ ...bodyReview, aiToneBlocking: false }))
    for (const floor of floors) put(`floor/${version}/${floor}`, buildStagePrompt({ ...bodyReview, aiToneRepairFloor: floor }))
    for (const settingsDimensionKind of dimensions) {
      put(`settings/${version}/${settingsDimensionKind}`, buildStagePrompt({ ...base, kind: 'settings', settingsDimensionKind, promptVersion: version }))
      put(`settingsReview/${version}/${settingsDimensionKind}`, buildStagePrompt({ ...base, kind: 'review', settingsDimensionKind, promptVersion: version }))
    }
    put(`collection/${version}`, buildStagePrompt({ ...base, kind: 'review', settingsCollectionKinds: { a1: 'enum_single', e1: 'llm_free' }, promptVersion: version }))
    for (const code of ['g4', 'g7'] as const) put(`checklist/${version}/${code}`, buildStagePrompt({ ...base, kind: 'review', settingsDimensionCode: code, promptVersion: version }))
  }
  put('bodyPatch', buildBodyRepairPrompt({ novelId: base.novelId, prior: { version: 1, scenes: [] }, inputs: base.inputs, task: { validationError: null }, inputRefs: [] }))
  return got
}

const parentDump = `import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildBodyRepairPrompt } from '../src/body-repair.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { buildStagePrompt } from '../src/stage-prompts.ts'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000', inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001', sha256: '${'0'.repeat(64)}', kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']
const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
const dimensions = ['enum_single', 'enum_multi', 'llm_free', 'edit_external']
const floors = ['hint', 'notice', 'heavy']
it('dumps parent hashes', () => {
  const got = {}
  const put = (key, text) => { got[key] = sha(text) }
  for (const version of versions) {
    for (const kind of kinds) {
      put(\`prompt/\${version}/\${kind}\`, buildStagePrompt({ ...base, kind, promptVersion: version }))
      put(\`schema/\${version}/\${kind}\`, JSON.stringify(nativeStageOutputSchema(kind, version)))
    }
    for (const reviewedKind of kinds) put(\`review/\${version}/\${reviewedKind}\`, buildStagePrompt({ ...base, kind: 'review', reviewedKind, promptVersion: version }))
    const bodyReview = { ...base, kind: 'review', reviewedKind: 'body', promptVersion: version }
    put(\`aiToneBlocking/\${version}/true\`, buildStagePrompt({ ...bodyReview, aiToneBlocking: true }))
    put(\`aiToneBlocking/\${version}/false\`, buildStagePrompt({ ...bodyReview, aiToneBlocking: false }))
    for (const floor of floors) put(\`floor/\${version}/\${floor}\`, buildStagePrompt({ ...bodyReview, aiToneRepairFloor: floor }))
    for (const settingsDimensionKind of dimensions) {
      put(\`settings/\${version}/\${settingsDimensionKind}\`, buildStagePrompt({ ...base, kind: 'settings', settingsDimensionKind, promptVersion: version }))
      put(\`settingsReview/\${version}/\${settingsDimensionKind}\`, buildStagePrompt({ ...base, kind: 'review', settingsDimensionKind, promptVersion: version }))
    }
    put(\`collection/\${version}\`, buildStagePrompt({ ...base, kind: 'review', settingsCollectionKinds: { a1: 'enum_single', e1: 'llm_free' }, promptVersion: version }))
    for (const code of ['g4', 'g7']) put(\`checklist/\${version}/\${code}\`, buildStagePrompt({ ...base, kind: 'review', settingsDimensionCode: code, promptVersion: version }))
  }
  put('bodyPatch', buildBodyRepairPrompt({ novelId: base.novelId, prior: { version: 1, scenes: [] }, inputs: base.inputs, task: { validationError: null }, inputRefs: [] }))
  writeFileSync(process.env.REPLAY_OUT, JSON.stringify(got))
  expect(Object.keys(got).length).toBeGreaterThan(0)
})
`

function haveCommit(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

it('rebuilds versions 1–14 from parent 334136f8 byte for byte', () => {
  const here = replayHashes()
  if (!haveCommit(PARENT)) execFileSync('git', ['fetch', '--depth=1', 'origin', PARENT], { stdio: 'pipe' })
  const dir = mkdtempSync(join(tmpdir(), 'prompt-replay-'))
  const out = join(dir, 'parent-hashes.json')
  let added = false
  try {
    execFileSync('git', ['worktree', 'add', '--detach', dir, PARENT], { stdio: 'pipe' })
    added = true
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'))
    writeFileSync(join(dir, 'tests/dump-parent-hashes.spec.ts'), parentDump)
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', 'tests/dump-parent-hashes.spec.ts', '--configLoader', 'runner', '--cache=false'], {
      cwd: dir, env: { ...process.env, REPLAY_OUT: out }, stdio: 'pipe',
    })
    const parent = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>
    expect(Object.keys(here).sort()).toEqual(Object.keys(parent).sort())
    for (const key of Object.keys(here)) expect(here[key], key).toBe(parent[key])
  } finally {
    if (added) {
      try { execFileSync('git', ['worktree', 'remove', '--force', dir], { stdio: 'pipe' }) } catch { /* the assertion above is the result that matters */ }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
