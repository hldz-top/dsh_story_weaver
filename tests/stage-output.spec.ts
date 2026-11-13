import { expect, it } from 'vitest'
import { z } from 'zod'
import { parseArtifactId } from '../src/contracts.ts'
import { checkSettingsDimensionScope, parseBodyOutput, parseBookOutlineOutput, parseChapterOutlineOutput, parseContinuityOutput, parseReviewOutput, parseSettingsDimensionOutput, StageOutputSchemas } from '../src/stage-output.ts'

const brief = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
const candidate = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }

it('exposes every stage schema as strict model JSON without executing output transforms', () => {
  expect(Object.keys(StageOutputSchemas)).toEqual(['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'])
  for (const schema of Object.values(StageOutputSchemas)) {
    expect(z.toJSONSchema(schema, { io: 'input' })).toMatchObject({
      type: 'object', additionalProperties: false, required: expect.arrayContaining(['version', 'inputRefs']),
    })
  }
})

it('accepts a settings dimension only for its declared dimension and exact upstream versions', () => {
  const output = { version: 1, dimensionCode: 'a1', inputRefs: [brief],
    facts: [{ id: 'genre', statement: 'The story is a coastal mystery.' }], contentMarkdown: '# Genre\n\nA coastal mystery.' }
  expect(parseSettingsDimensionOutput(output, { dimensionCode: 'a1', inputRefs: [brief] })).toEqual(output)
  expect(() => parseSettingsDimensionOutput(output, { dimensionCode: 'a2', inputRefs: [brief] })).toThrow(/dimension/i)
  expect(() => parseSettingsDimensionOutput(output, { dimensionCode: 'a1', inputRefs: [{ ...brief, sha256: 'b'.repeat(64) }] })).toThrow(/input/i)
  expect(() => parseSettingsDimensionOutput({ ...output, facts: [output.facts[0], output.facts[0]] }, { dimensionCode: 'a1', inputRefs: [brief] })).toThrow(/duplicate/i)
})

it('requires every planned body scene in order while retaining short candidates for the host length check', () => {
  const output = { version: 1, inputRefs: [brief], chapterNumber: 2,
    scenes: [{ sceneId: 'arrival', text: 'The keeper crossed the rocks.' }, { sceneId: 'recovery', text: 'The log was dry.' }] }
  const expected = { inputRefs: [brief], chapterNumber: 2, sceneIds: ['arrival', 'recovery'] }
  expect(parseBodyOutput(output, expected)).toEqual(output)
  expect(() => parseBodyOutput({ ...output, scenes: output.scenes.slice(1) }, expected)).toThrow(/scene/i)
  expect(() => parseBodyOutput({ ...output, scenes: [...output.scenes].reverse() }, expected)).toThrow(/scene/i)
  expect(() => parseBodyOutput({ ...output, scenes: [output.scenes[0], { ...output.scenes[1], sceneId: 'arrival' }] }, expected)).toThrow(/scene/i)
  expect(() => parseBodyOutput({ ...output, reviewReport: 'Approved.' }, expected)).toThrow()
})

it('keeps chapter scene order and assigns every required obligation without inventing new ones', () => {
  const output = { version: 1, inputRefs: [brief], chapterNumber: 2, title: 'The log', targetWords: 3000,
    throughLine: 'The keeper retrieves the log before the flood.', constraints: ['The keeper cannot swim.'],
    obligations: [{ id: 'recover-log', description: 'The keeper recovers the log.' }],
    scenes: [{ id: 'arrival', purpose: 'Reach the wreck.', action: 'The keeper crosses exposed rocks.', obligationIds: [] },
      { id: 'recovery', purpose: 'Recover the evidence.', action: 'The keeper opens the trapped cabin.', obligationIds: ['recover-log'] }],
  }
  const expected = { inputRefs: [brief], chapterNumber: 2, obligationIds: ['recover-log'] }
  expect(parseChapterOutlineOutput(output, expected)).toEqual(output)
  const { targetWords: _omitted, ...withoutTarget } = output
  expect(parseChapterOutlineOutput(withoutTarget, expected)).toEqual(withoutTarget)
  expect(() => parseChapterOutlineOutput({ ...output, chapterNumber: 1 }, expected)).toThrow(/chapter/i)
  expect(() => parseChapterOutlineOutput({ ...output, scenes: [{ ...output.scenes[0], obligationIds: ['invented'] }, output.scenes[1]] }, expected)).toThrow(/obligation/i)
  expect(() => parseChapterOutlineOutput({ ...output, scenes: output.scenes.map(scene => ({ ...scene, obligationIds: [] })) }, expected)).toThrow(/obligation/i)
  expect(() => parseChapterOutlineOutput({ ...output, scenes: [output.scenes[0], { ...output.scenes[1], id: 'arrival' }] }, expected)).toThrow(/duplicate/i)
})

it('requires an ordered complete book plan with uniquely identified writing obligations', () => {
  const output = { version: 1, inputRefs: [brief], contentMarkdown: '# Book plan\n\nA vanished ship is found.', ending: 'The keeper recovers the ship log.',
    characterArcs: [{ character: 'The keeper', development: 'Moves from denial to responsibility.' }],
    chapters: [{ chapterNumber: 1, title: 'The empty berth', purpose: 'Establish the missing ship.', targetWords: 3000, obligations: [{ id: 'missing-ship', description: 'The keeper discovers the ship is missing.' }] },
      { chapterNumber: 2, title: 'The log', purpose: 'Resolve the disappearance.', targetWords: 3000, obligations: [{ id: 'recover-log', description: 'The keeper recovers the log.' }] }],
  }
  const expected = { inputRefs: [brief], chapterCount: 2 }
  expect(parseBookOutlineOutput(output, expected)).toEqual(output)
  const withoutTargets = { ...output, chapters: output.chapters.map(({ targetWords: _omitted, ...chapter }) => chapter) }
  expect(parseBookOutlineOutput(withoutTargets, expected)).toEqual(withoutTargets)
  expect(() => parseBookOutlineOutput({ ...output, chapters: output.chapters.slice(1) }, expected)).toThrow(/chapter/i)
  expect(() => parseBookOutlineOutput({ ...output, chapters: [...output.chapters].reverse() }, expected)).toThrow(/chapter/i)
  expect(() => parseBookOutlineOutput({ ...output, chapters: [output.chapters[0], { ...output.chapters[1], obligations: output.chapters[0]!.obligations }] }, expected)).toThrow(/duplicate/i)
})

it('requires actual reviewed-body evidence for fulfilled obligations and preserves explicitly open obligations', () => {
  const actual = [{ artifactId: candidate.artifactId, quote: 'found the log' }]
  const output = { version: 1, inputRefs: [brief, candidate], chapterNumber: 2, summary: 'The keeper recovers the log but has not found the key.',
    characters: [{ name: 'The keeper', state: 'Has the recovered log.' }], timeline: [{ event: 'The log is recovered.', evidence: actual }],
    obligations: [{ id: 'recover-log', status: 'fulfilled', explanation: 'The body records recovery.', evidence: actual },
      { id: 'find-key', status: 'open', explanation: 'The key has not appeared in the body.', evidence: [] }],
  }
  const expected = { inputRefs: [brief, candidate], chapterNumber: 2, obligationIds: ['recover-log', 'find-key'], reviewedBodyId: candidate.artifactId,
    evidenceSources: [{ artifactId: candidate.artifactId, text: 'The keeper found the log.' }, { artifactId: brief.artifactId, text: 'The keeper will find the log.' }] }
  expect(parseContinuityOutput(output, expected)).toEqual(output)
  expect(() => parseContinuityOutput({ ...output, obligations: [output.obligations[0], { ...output.obligations[1], explanation: '' }] }, expected)).toThrow()
  expect(() => parseContinuityOutput({ ...output, obligations: [{ ...output.obligations[0], evidence: [] }, output.obligations[1]] }, expected)).toThrow(/body/i)
  expect(() => parseContinuityOutput({ ...output, obligations: [{ ...output.obligations[0], evidence: [{ artifactId: brief.artifactId, quote: 'will find the log' }] }, output.obligations[1]] }, expected)).toThrow(/body/i)
  expect(() => parseContinuityOutput({ ...output, timeline: [{ event: 'The key is found.', evidence: [{ artifactId: candidate.artifactId, quote: 'found the key' }] }] }, expected)).toThrow(/quote/i)
  expect(() => parseContinuityOutput({ ...output, obligations: [output.obligations[0]] }, expected)).toThrow(/obligation/i)
})

it('accepts unordered exact input references and rejects omitted or duplicate references', () => {
  const output = { version: 1, dimensionCode: 'a2', inputRefs: [candidate, brief],
    facts: [{ id: 'genre', statement: 'The story is a coastal mystery.' }], contentMarkdown: 'A coastal mystery.' }
  const expected = { dimensionCode: 'a2', inputRefs: [brief, candidate] }
  expect(parseSettingsDimensionOutput(output, expected).inputRefs).toEqual([candidate, brief])
  expect(() => parseSettingsDimensionOutput({ ...output, inputRefs: [brief] }, expected)).toThrow(/input/i)
  expect(() => parseSettingsDimensionOutput({ ...output, inputRefs: [brief, brief] }, expected)).toThrow(/duplicate/i)
  expect(z.toJSONSchema(StageOutputSchemas.settings, { io: 'input' })).toMatchObject({ type: 'object', additionalProperties: false })
})

it('admits evidence-backed review checks and advisory issues without trusting an approval flag', () => {
  const evidence = [{ artifactId: candidate.artifactId, quote: 'coastal mystery' }]
  const output = { version: 1, reviewed: candidate, inputRefs: [brief],
    checks: [{ category: 'completeness', summary: 'The requested genre is specified.', evidence },
      { category: 'consistency', summary: 'The genre fits the requested setting.', evidence }],
    issues: [{ id: 'style-1', severity: 'advisory', category: 'style', location: 'facts.genre', message: 'A more specific genre label could help.', evidence }],
  }
  const expected = { reviewed: candidate, inputRefs: [brief], requiredChecks: ['completeness', 'consistency'] as const,
    evidenceSources: [{ artifactId: candidate.artifactId, text: 'The story is a coastal mystery.' }, { artifactId: brief.artifactId, text: 'Write a mystery.' }] }
  expect(parseReviewOutput(output, expected)).toEqual(output)
  expect(() => parseReviewOutput({ ...output, checks: output.checks.slice(1) }, expected)).toThrow(/check/i)
  expect(() => parseReviewOutput({ ...output, reviewed: { ...candidate, sha256: 'c'.repeat(64) } }, expected)).toThrow(/reviewed/i)
  expect(() => parseReviewOutput({ ...output, approved: true }, expected)).toThrow()
  expect(() => parseReviewOutput({ ...output, issues: [{ ...output.issues[0], severity: 'blocking' }] }, expected)).toThrow(/advisory/i)
  expect(() => parseReviewOutput({ ...output, checks: [{ ...output.checks[0], evidence: [{ artifactId: candidate.artifactId, quote: 'unrecorded assertion' }] }, output.checks[1]] }, expected)).toThrow(/quote/i)
})

it.each(['completeness', 'consistency', 'obligations', 'continuity', 'length'] as const)(
  'requires %s issues to block instead of accepting an advisory downgrade', category => {
    const evidence = [{ artifactId: candidate.artifactId, quote: 'coastal mystery' }]
    const issue = { id: 'required-1', severity: 'advisory', category, location: 'facts.genre', message: 'The required constraint is not met.', evidence }
    const output = { version: 1, reviewed: candidate, inputRefs: [brief],
      checks: [{ category, summary: 'The candidate was checked against its required constraints.', evidence }], issues: [issue] }
    const expected = { reviewed: candidate, inputRefs: [brief], requiredChecks: [category],
      evidenceSources: [{ artifactId: candidate.artifactId, text: 'The story is a coastal mystery.' }] }
    expect(() => parseReviewOutput(output, expected)).toThrow(/blocking/i)
    const blocking = { ...output, issues: [{ ...issue, severity: 'blocking' }] }
    expect(parseReviewOutput(blocking, expected)).toEqual(blocking)
    expect(output.issues[0]?.severity).toBe('advisory')
  },
)

const settingsBase = { version: 1 as const, dimensionCode: 'a1', inputRefs: [brief] }

it.each(['enum_single', 'enum_multi'] as const)('accepts a %s classification dimension exactly at its fact and character bound', kind => {
  const atLimit = { ...settingsBase, facts: Array.from({ length: 10 }, (_, index) => ({ id: `f${index}`, statement: 'A label with brief grounds.' })), contentMarkdown: 'x'.repeat(2500) }
  expect(() => checkSettingsDimensionScope(atLimit, kind)).not.toThrow()
})

it('rejects a classification dimension with one fact over the bound, naming the limit and the actual count', () => {
  const output = { ...settingsBase, facts: Array.from({ length: 11 }, (_, index) => ({ id: `f${index}`, statement: 'A label with brief grounds.' })), contentMarkdown: 'x'.repeat(100) }
  expect(() => checkSettingsDimensionScope(output, 'enum_single')).toThrow('A classification dimension allows at most 10 facts; this candidate has 11')
})

it('rejects a classification dimension with contentMarkdown one code point over the bound, naming the limit and the actual count', () => {
  const output = { ...settingsBase, facts: [{ id: 'f0', statement: 'A label.' }], contentMarkdown: 'x'.repeat(2501) }
  expect(() => checkSettingsDimensionScope(output, 'enum_multi')).toThrow('A classification dimension allows at most 2500 characters of contentMarkdown; this candidate has 2501')
})

it('leaves an llm_free settings dimension unbounded at a size that would violate the classification bound', () => {
  const output = { ...settingsBase, facts: Array.from({ length: 26 }, (_, index) => ({ id: `f${index}`, statement: 'A world-building fact.' })), contentMarkdown: 'x'.repeat(5000) }
  expect(() => checkSettingsDimensionScope(output, 'llm_free')).not.toThrow()
})

it('counts contentMarkdown by Unicode code points, not UTF-16 length, with CJK and an astral character', () => {
  const astral = '😀' // U+1F600: one Unicode code point, but a UTF-16 surrogate pair (two code units).
  const cjk = '雾' // one Unicode code point and one UTF-16 code unit.
  const atLimit = { ...settingsBase, facts: [{ id: 'f0', statement: 'A label.' }], contentMarkdown: astral + cjk.repeat(2499) }
  expect([...atLimit.contentMarkdown]).toHaveLength(2500)
  expect(atLimit.contentMarkdown.length).toBe(2501) // UTF-16 .length overcounts the single astral character by one.
  expect(() => checkSettingsDimensionScope(atLimit, 'enum_single')).not.toThrow()
  const overLimit = { ...settingsBase, facts: [{ id: 'f0', statement: 'A label.' }], contentMarkdown: astral + cjk.repeat(2500) }
  expect([...overLimit.contentMarkdown]).toHaveLength(2501)
  expect(() => checkSettingsDimensionScope(overLimit, 'enum_single')).toThrow('this candidate has 2501')
})
