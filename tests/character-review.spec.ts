/** Prompt version 12 character review: category, three checks, and version isolation. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHARACTER_REVIEW_CHECKS, CHARACTER_REVIEW_PROMPT_VERSION } from '../src/character-metrics.ts'
import { parseArtifactId } from '../src/contracts.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { parseReviewOutput, StageOutputSchemas, type ReviewCategory } from '../src/stage-output.ts'
import { buildStagePrompt, CURRENT_PROMPT_VERSION, type PromptVersion, type StagePromptKind } from '../src/stage-prompts.ts'
import { useWritingFixture } from './support/writing-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const parentHashes = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'character-review-parent-hashes.json'), 'utf8')) as Record<string, string>
const promptBase = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'] as const satisfies readonly StagePromptKind[]
const brief = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
const candidate = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }
const evidence = [{ artifactId: candidate.artifactId, quote: 'coastal mystery' }]
const sources = [{ artifactId: candidate.artifactId, text: 'The story is a coastal mystery.' }, { artifactId: brief.artifactId, text: 'Write a mystery.' }]
const bodyChecks = ['completeness', 'consistency', 'obligations', 'continuity', 'length'] as const satisfies readonly ReviewCategory[]

function review(checks: readonly { category: string; summary: string }[], issues: readonly { id: string; severity: string; category: string; location: string; message: string; evidence: typeof evidence }[] = []) {
  return {
    version: 1, reviewed: candidate, inputRefs: [brief],
    checks: checks.map(check => ({ ...check, evidence })),
    issues,
  }
}

function oldReview() {
  return review([
    { category: 'completeness', summary: 'The requested genre is specified.' },
    { category: 'consistency', summary: 'The genre fits the requested setting.' },
  ], [{ id: 'style-1', severity: 'advisory', category: 'style', location: 'facts.genre', message: 'A more specific genre label could help.', evidence }])
}

describe('prompt version 12', () => {
  it('replays versions 1–11 prompt and schema bytes from parent 0776f67', () => {
    expect(CURRENT_PROMPT_VERSION).toBe(CHARACTER_REVIEW_PROMPT_VERSION)
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const satisfies readonly PromptVersion[]) {
      for (const kind of kinds) {
        expect(sha(buildStagePrompt({ ...promptBase, kind, promptVersion: version })), `p/${version}/${kind}`).toBe(parentHashes[`p/${version}/${kind}`])
        expect(sha(JSON.stringify(nativeStageOutputSchema(kind, version))), `s/${version}/${kind}`).toBe(parentHashes[`s/${version}/${kind}`])
      }
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', settingsDimensionKind: 'enum_single', promptVersion: version }))).toBe(parentHashes[`p/${version}/settings/enum_single`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', settingsDimensionKind: 'llm_free', promptVersion: version }))).toBe(parentHashes[`p/${version}/settings/llm_free`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: version }))).toBe(parentHashes[`p/${version}/review/body`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', promptVersion: version, characterDimensions: ['e5'], maxCharacters: 12 }))).toBe(parentHashes[`p/${version}/settings/e5`])
    }
  })

  it('publishes category character only on a version-12 review, and false matches version 11', () => {
    const previous = JSON.stringify(nativeStageOutputSchema('review', 11))
    const current = JSON.stringify(nativeStageOutputSchema('review', 12))
    expect(previous).not.toContain('"character"')
    expect(current).toContain('"character"')
    expect(JSON.stringify(nativeStageOutputSchema('review', 12, { characterReview: false }))).toBe(previous)
    for (const kind of kinds) if (kind !== 'review') {
      expect(JSON.stringify(nativeStageOutputSchema(kind, 12)), kind).toBe(JSON.stringify(nativeStageOutputSchema(kind, 11)))
      expect(buildStagePrompt({ ...promptBase, kind, promptVersion: 12 }), kind).toBe(buildStagePrompt({ ...promptBase, kind, promptVersion: 11 }))
    }
    const body = buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: 12 })
    expect(body).toContain('character-voice')
    expect(body).toContain('character-function')
    expect(body).toContain('character-arc')
    expect(body).toContain('metricsBlocking is false')
    expect(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: 12, characterReview: false })).toBe(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: 11 }))
    expect(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'chapter-outline', promptVersion: 12 })).toBe(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'chapter-outline', promptVersion: 11 }))
    expect(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: 11 })).not.toContain('character-voice')
  })

  it('leaves the settings schema and the continuity snapshot unchanged', () => {
    expect(Object.keys(StageOutputSchemas.settings.shape)).toEqual(['version', 'inputRefs', 'dimensionCode', 'facts', 'contentMarkdown'])
    const snapshot = JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 12))
    expect(snapshot).not.toContain('name_note')
    expect(snapshot).toBe(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 11)))
    expect(JSON.stringify(nativeStageOutputSchema('continuity', 12))).toBe(JSON.stringify(nativeStageOutputSchema('continuity', 11)))
  })
})

describe('character review admission', () => {
  it('admits a version-11 review that has no character category', () => {
    const output = oldReview()
    const expected = { reviewed: candidate, inputRefs: [brief], requiredChecks: ['completeness', 'consistency'] as const, evidenceSources: sources }
    expect(parseReviewOutput(output, expected)).toEqual(output)
    expect(output.issues[0]).toMatchObject({ severity: 'advisory' })
  })

  it('rejects a version-12 body review that is missing one character check', () => {
    const present = CHARACTER_REVIEW_CHECKS.filter(id => id !== 'character-function')
    const output = review([
      ...bodyChecks.map(category => ({ category, summary: `${category} holds.` })),
      ...present.map(id => ({ category: 'character', summary: `${id}: 这项通过。` })),
    ])
    const expected = {
      reviewed: candidate, inputRefs: [brief], requiredChecks: [...bodyChecks, 'character'] as const,
      evidenceSources: sources, characterReview: true as const,
    }
    expect(() => parseReviewOutput(output, expected)).toThrow(/character-function/)
    expect(() => parseReviewOutput(output, expected)).toThrow(/missing a required check/)
  })

  it('keeps character-arc advisory and rejects a blocking character-arc without changing the issue', () => {
    const checks = [
      ...bodyChecks.map(category => ({ category, summary: `${category} holds.` })),
      ...CHARACTER_REVIEW_CHECKS.map(id => ({ category: 'character', summary: `${id}: 这项已核对。` })),
    ]
    const arc = { id: 'character-arc', severity: 'blocking' as const, category: 'character' as const, location: 'p3', message: '配角只出现了名字。', evidence }
    const blockingArc = review(checks, [arc])
    expect(() => parseReviewOutput(blockingArc, {
      reviewed: candidate, inputRefs: [brief], requiredChecks: [...bodyChecks, 'character'], evidenceSources: sources, characterReview: true,
    })).toThrow(/character-arc is fixed advisory/)
    expect(blockingArc.issues[0]?.severity).toBe('blocking')
    const voice = { id: 'character-voice', severity: 'advisory' as const, category: 'character' as const, location: 'p3', message: '台词可以互换。', evidence }
    expect(() => parseReviewOutput(review(checks, [voice]), {
      reviewed: candidate, inputRefs: [brief], requiredChecks: [...bodyChecks, 'character'], evidenceSources: sources, characterReview: true,
    })).toThrow(/character-voice issues must be blocking/)
    expect(voice.severity).toBe('advisory')
    const accepted = review(checks, [
      { id: 'character-voice', severity: 'blocking', category: 'character', location: 'p37-p39', message: 'p37-p39 的苏清鸢台词与沈丹青可互换。给苏清鸢一句否定句和一次打断。', evidence },
      { id: 'character-arc', severity: 'advisory', category: 'character', location: 'scene-1', message: '周晚只被点了名。', evidence },
    ])
    const admitted = parseReviewOutput(accepted, {
      reviewed: candidate, inputRefs: [brief], requiredChecks: [...bodyChecks, 'character'], evidenceSources: sources, characterReview: true,
    })
    expect(admitted.issues.map(issue => issue.severity)).toEqual(['blocking', 'advisory'])
    expect(accepted.issues.map(issue => issue.severity)).toEqual(['blocking', 'advisory'])
  })
})

describe('characterReview is not stored on a run', () => {
  it('leaves the option off the recorded execution limits', async () => {
    const fixture = await useWritingFixture({ characterReview: false })
    const run = await fixture.runs.begin(fixture.actor, {
      ...fixture.input, chapterCount: 1, throughChapter: 1, revision: null,
      executionLimits: fixture.runner.limits,
      serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits },
    })
    expect(run.promptVersion).toBe(12)
    expect(run.executionLimits).not.toHaveProperty('characterReview')
    expect(JSON.stringify(run)).not.toContain('characterReview')
  })
})
