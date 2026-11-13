/** Paragraph-id citations and the g4/g7 checklist: re-split stability, verbatim mapping, and monotone fail counts. */
import { expect, it } from 'vitest'
import { parseArtifactId } from '../src/contracts.ts'
import { paragraphsOfStoredCandidate } from '../src/candidate-paragraphs.ts'
import { checklistRepairDecision, openChecklistItems } from '../src/open-dimension-checklist.ts'
import { admitOpenDimensionChecklist, parseReviewOutput } from '../src/stage-output.ts'

const ref = { artifactId: 'artifact_00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64) }
const document = (markdown: string) => JSON.stringify({
  version: 1, dimensionCode: 'g4', inputRefs: [ref], facts: [{ id: 'payoff', statement: '事实。' }], contentMarkdown: markdown,
})

it('re-splits the same body to the same ids and hashes, and keeps a paragraph hash when a neighbor changes', () => {
  const text = document('甲段。\n\n乙段。\n\n丙段。')
  const first = paragraphsOfStoredCandidate('settings-dimension', text)
  expect(paragraphsOfStoredCandidate('settings-dimension', text)).toEqual(first)
  expect(first.map(item => item.id)).toEqual(['p1', 'p2', 'p3'])
  expect(paragraphsOfStoredCandidate('settings-dimension', document('甲段。\r\n\r\n乙段。\r\n\r\n丙段。'))).toEqual(first)
  const repaired = paragraphsOfStoredCandidate('settings-dimension', document('甲段。\n\n乙段改了。\n\n丙段。'))
  expect(repaired[0]).toEqual(first[0])
  expect(repaired[2]!.sha256).toBe(first[2]!.sha256)
  expect(repaired[1]!.text).toBe('乙段改了。')
  expect(repaired[1]!.sha256).not.toBe(first[1]!.sha256)
  const inserted = paragraphsOfStoredCandidate('settings-dimension', document('甲段。\n\n新段。\n\n乙段。\n\n丙段。'))
  expect(inserted.find(item => item.text === '丙段。')).toMatchObject({ id: 'p4', sha256: first[2]!.sha256 })
  expect(paragraphsOfStoredCandidate('settings-dimension', document('甲段。\n乙段。')).map(item => item.text)).toEqual(['甲段。', '乙段。'])
})

it('maps a paragraph id to that paragraph and then rejects an unknown id with the existing quote check', () => {
  const stored = document('甲段。\n\n乙段。')
  const paragraphs = paragraphsOfStoredCandidate('settings-dimension', stored)
  const reviewed = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }
  const brief = { artifactId: parseArtifactId(ref.artifactId), sha256: ref.sha256 }
  const expected = { reviewed, inputRefs: [brief], requiredChecks: ['completeness', 'consistency'] as const, paragraphs,
    evidenceSources: [{ artifactId: reviewed.artifactId, text: stored }, { artifactId: brief.artifactId, text: '事实。' }] }
  const review = { version: 1, reviewed, inputRefs: [brief], issues: [], checks: [
    { category: 'completeness', summary: 'The opening paragraph is present.', evidence: [{ paragraphId: 'p1', problem: 'The opening paragraph is present.' }] },
    { category: 'consistency', summary: 'The second paragraph agrees.', evidence: [{ paragraphId: 'p2', problem: 'The second paragraph agrees.' }] },
  ] }
  expect(parseReviewOutput(review, expected).checks.map(check => check.evidence[0]!.quote)).toEqual(['甲段。', '乙段。'])
  expect(() => parseReviewOutput({ ...review, checks: [
    { ...review.checks[0]!, evidence: [{ paragraphId: 'p99', problem: '进一步确认这段并不存在。' }] }, review.checks[1]!,
  ] }, expected)).toThrow(/Evidence quote does not occur in its declared source[\s\S]*进一步确认/)
})

it('admits a g4 checklist and counts only fails that name a real paragraph', () => {
  const stored = document('甲段写明当场揭穿。\n\n乙段写明暴露方位的代价。')
  const paragraphs = paragraphsOfStoredCandidate('settings-dimension', stored)
  const reviewed = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000002'), sha256: 'b'.repeat(64) }
  const brief = { artifactId: parseArtifactId(ref.artifactId), sha256: ref.sha256 }
  const items = openChecklistItems('g4').map((item, index) => index < 2
    ? { id: item.id, status: 'fail' as const, paragraphId: 'p1' }
    : { id: item.id, status: 'pass' as const })
  const admitted = admitOpenDimensionChecklist({ version: 1, reviewed, inputRefs: [brief], items }, {
    dimensionCode: 'g4', reviewed, inputRefs: [brief], paragraphs,
    evidenceSources: [{ artifactId: reviewed.artifactId, text: stored }, { artifactId: brief.artifactId, text: '事实。' }],
  })
  expect(admitted.checklist).toMatchObject({ dimensionCode: 'g4', failCount: 2 })
  expect(admitted.issues.map(issue => [issue.id, issue.severity, issue.evidence[0]!.quote])).toEqual([
    ['g4-payoff-shown', 'advisory', '甲段写明当场揭穿。'],
    ['g4-payoff-earned', 'advisory', '甲段写明当场揭穿。'],
  ])
  expect(admitted.issues.some(issue => issue.severity === 'blocking')).toBe(false)
  const missing = items.map((item, index) => index === 0 ? { id: item.id, status: 'fail' as const } : item)
  expect(() => admitOpenDimensionChecklist({ version: 1, reviewed, inputRefs: [brief], items: missing }, {
    dimensionCode: 'g4', reviewed, inputRefs: [brief], paragraphs,
    evidenceSources: [{ artifactId: reviewed.artifactId, text: stored }],
  })).toThrow(/paragraphId/)
})

it('continues repair only while the fail count does not rise', () => {
  expect(checklistRepairDecision(null, 0)).toBe('apply-next')
  expect(checklistRepairDecision(null, 2)).toBe('continue')
  expect(checklistRepairDecision(2, 2)).toBe('continue')
  expect(checklistRepairDecision(2, 1)).toBe('continue')
  expect(checklistRepairDecision(2, 0)).toBe('apply-next')
  expect(checklistRepairDecision(2, 3)).toBe('apply-previous')
})
