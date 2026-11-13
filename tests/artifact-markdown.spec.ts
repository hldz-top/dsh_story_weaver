import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { rendered } from './support/markdown.ts'
import { artifactMarkdown, legacyArtifactMarkdown } from '../src/artifact-markdown.ts'
import { parseArtifactId, parseNovelId, type Artifact, type ArtifactKind } from '../src/contracts.ts'

const novelId = parseNovelId('novel_00c38d7c-50d8-4a1b-93f0-188daf5a9859')
const artifactId = parseArtifactId('artifact_00c38d7c-50d8-4a1b-93f0-188daf5a9859')
const inputs = { version: 1, novelId, briefArtifactId: artifactId, sessionId: 'author', startSeq: 10 }

function artifact(kind: ArtifactKind, text: string): Artifact {
  return { id: artifactId, novelId, kind, revision: 1, text, chars: [...text].length,
    bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }
}

it('preserves every creative-brief byte including existing Markdown and line endings', () => {
  const text = '# 创作简报\r\n\r\n甲😀乙\n\n'
  expect(artifactMarkdown(artifact('creative-brief', text))).toBe(text)
})

it('renders plan classifications, questions and reasons with provenance instead of raw JSON', () => {
  const text = JSON.stringify({ ...inputs, questions: [{ id: 'motive', kind: 'creative', question: '为何留下？', reason: '由作者决定。' }] })
  const markdown = artifactMarkdown(artifact('research-plan', text))
  expect(markdown).toContain('# Research plan\n')
  expect(markdown).toContain('Classification: Creative decision')
  expect(markdown).toContain('Classification: Creative decision\n\n为何留下？\n\nReason\n\n由作者决定。')
  expect(markdown).toContain('## Provenance\n\n- Artifact: ' + artifactId + '\n- Kind: research-plan\n')
  expect(markdown).toContain('\n- Session: author\n- Start sequence: 10\n')
  expect(markdown).not.toContain('```')
  expect(markdown).not.toContain(text)
})

it('shows recorded Markdown as inert readable text and exposes native sources and outcomes', () => {
  const hostile = '`````\n# Forged heading\n[run](javascript:bad)\n<script>bad()</script>'
  const text = JSON.stringify({ ...inputs, planId: artifactId, outcome: 'insufficient',
    findings: [{ questionId: 'tides', callIds: ['native-search'], conclusion: '证据不足。', adequate: false, outcome: 'insufficient' }],
    observations: [{ callId: 'native-search', name: 'web_search', input: { queries: ['tidal cycle'] }, callSeq: 11, resultSeq: 12, status: 'succeeded', error: null,
      sources: [{ sourceIndex: 0, url: 'https://example.test/>[evil](javascript:bad)', title: null, excerpt: hostile,
        offset: 3, totalChars: 100, sha256: 'a'.repeat(64), truncated: true }] }],
  })
  const markdown = artifactMarkdown(artifact('research-evidence', text))
  expect(markdown).toContain('# Research evidence\n')
  expect(markdown).toContain('Outcome: Insufficient evidence')
  expect(markdown).toContain('Conclusion\n\n证据不足。')
  expect(markdown).toContain('Query 1\n\ntidal cycle')
  expect(markdown).toContain('URL: <https://example.test/%3E[evil](javascript:bad)>')
  expect(markdown).toContain('Quoted source material')
  expect(markdown).toContain('Quoted source material\n\n> &#96;&#96;&#96;&#96;&#96;  \n> &#35; Forged heading  \n'
    + '> &#91;run&#93;(javascript:bad)  \n> &#60;script&#62;bad()&#60;/script&#62;\n\n')
  expect(rendered(markdown)).toContain(hostile.split('\n').map(line => `> ${line}`).join('\n'))
  expect(markdown).not.toContain('```')
  expect(markdown).not.toContain('<script>')
  expect(markdown).toContain('Excerpt truncated: Yes')
  expect(markdown).toContain('Call sequence: 11; result sequence: 12')
  expect(markdown).toContain('Recorded source SHA-256: ' + 'a'.repeat(64))
})

it('refuses malformed or structurally invalid persisted research JSON', () => {
  for (const text of ['{', JSON.stringify({ ...inputs, questions: [] })]) {
    expect(() => artifactMarkdown(artifact('research-plan', text))).toThrowError(expect.objectContaining({ code: 'corrupt-artifact', cause: expect.any(Error) }))
  }
})

it('renders the complete settings dimension, facts and exact input versions as a candidate document', () => {
  const content = '# Harbor\n' + 'The lighthouse remains dark.\n'.repeat(400) + '`````\n# Embedded heading\nEND-SETTINGS'
  const text = JSON.stringify({ version: 1, dimensionCode: 'a1', inputRefs: [{ artifactId, sha256: 'a'.repeat(64) }],
    facts: [{ id: 'genre', statement: 'A mystery.' }, { id: 'world', statement: 'A fictional harbor.' }], contentMarkdown: content })
  const markdown = artifactMarkdown(artifact('settings-dimension', text))
  expect(markdown).toContain('# Settings dimension\n')
  expect(markdown).toContain('Dimension: a1')
  expect(markdown).toContain('Document: Generated candidate')
  expect(markdown).toContain('## Content\n\n&#35; Harbor  \nThe lighthouse remains dark.  \n')
  expect(rendered(markdown)).toContain('## Content\n\n' + content + '\n\n')
  expect(markdown).not.toMatch(/^#+ (?:Harbor|Embedded heading)/m)
  expect(markdown).not.toContain('```')
  expect(markdown).toContain('## Fact 1\n\nFact ID\n\ngenre\n\nStatement\n\nA mystery.')
  expect(markdown).toContain('## Fact 2\n\nFact ID\n\nworld\n\nStatement\n\nA fictional harbor.')
  expect(markdown).toContain('Input 1 artifact: ' + artifactId)
  expect(markdown).toContain('Input 1 SHA-256: ' + 'a'.repeat(64))
  expect(markdown).toContain('Kind: settings-dimension')
  expect(markdown).toMatch(/\n$/)
})

it('renders review checks, blocking and advisory issues, quoted evidence and exact reviewed identity', () => {
  const reviewedId = parseArtifactId('artifact_00000000-0000-4000-8000-000000000002')
  const quote = '````\n# A quoted heading\nThe lighthouse was dark.'
  const text = JSON.stringify({ version: 1, inputRefs: [{ artifactId, sha256: 'a'.repeat(64) }],
    reviewed: { artifactId: reviewedId, sha256: 'b'.repeat(64) },
    checks: [{ category: 'consistency', summary: 'The two versions disagree.', evidence: [{ artifactId, quote }] }],
    issues: [
      { id: 'light', severity: 'blocking', category: 'consistency', location: 'Opening scene', message: 'Keep the light off.', evidence: [{ artifactId, quote }] },
      { id: 'rhythm', severity: 'advisory', category: 'style', location: 'Final paragraph', message: 'Vary the sentence rhythm.', evidence: [{ artifactId: reviewedId, quote: 'The harbor waited.' }] },
    ],
  })
  const markdown = artifactMarkdown(artifact('review', text))
  expect(markdown).toContain('# Review\n')
  expect(markdown).toContain('Review result: Blocking issues found')
  expect(markdown).toContain('Blocking issues: 1\n\nAdvisory issues: 1')
  expect(markdown).toContain('## Check 1\n\nCategory: Consistency\n\nSummary\n\nThe two versions disagree.')
  expect(markdown).toContain('Source artifact: ' + artifactId + '\n\n> &#96;&#96;&#96;&#96;  \n> &#35; A quoted heading  \n> The lighthouse was dark.')
  expect(markdown).not.toContain('```')
  expect(markdown).toContain('## Issue 1\n\nSeverity: Blocking\n\nCategory: Consistency')
  expect(markdown).toContain('Issue ID\n\nlight\n\nLocation\n\nOpening scene\n\nFinding\n\nKeep the light off.')
  expect(markdown).toContain('## Issue 2\n\nSeverity: Advisory\n\nCategory: Style')
  expect(markdown).toContain('Vary the sentence rhythm.')
  expect(markdown).toContain('Source artifact: ' + reviewedId + '\n\n> The harbor waited.')
  expect(markdown).toContain('Reviewed artifact: ' + reviewedId)
  expect(markdown).toContain('Reviewed SHA-256: ' + 'b'.repeat(64))
  expect(markdown).toContain('Input 1 artifact: ' + artifactId)
  expect(markdown).toContain('Input 1 SHA-256: ' + 'a'.repeat(64))
  expect(markdown).not.toContain('Status: Applied')
})

it.each([false, true])('reports no blocking findings without claiming adoption (advisory issue: %s)', advisory => {
  const evidence = [{ artifactId, quote: 'The harbor waited.' }]
  const text = JSON.stringify({ version: 1, inputRefs: [{ artifactId, sha256: 'a'.repeat(64) }],
    reviewed: { artifactId, sha256: 'b'.repeat(64) },
    checks: [{ category: 'completeness', summary: 'The required facts are present.', evidence }],
    issues: advisory ? [{ id: 'rhythm', severity: 'advisory', category: 'style', location: 'Final paragraph', message: 'Vary the rhythm.', evidence }] : [],
  })
  const markdown = artifactMarkdown(artifact('review', text))
  expect(markdown).toContain('Review result: No blocking issues reported')
  expect(markdown).toContain('Blocking issues: 0')
  expect(markdown).toContain(`Advisory issues: ${advisory ? 1 : 0}`)
  expect(markdown).not.toMatch(/approved|applied/i)
})

it.each(['settings-dimension', 'review'] as const)('refuses malformed and incomplete persisted %s JSON', kind => {
  const settings = { version: 1, dimensionCode: 'a1', inputRefs: [{ artifactId, sha256: 'a'.repeat(64) }],
    facts: [], contentMarkdown: 'A mystery.' }
  const review = { version: 1, inputRefs: [{ artifactId, sha256: 'a'.repeat(64) }],
    reviewed: { artifactId, sha256: 'b'.repeat(64) }, checks: [], issues: [] }
  for (const text of ['{', JSON.stringify(kind === 'settings-dimension' ? settings : review)]) {
    expect(() => artifactMarkdown(artifact(kind, text))).toThrowError(expect.objectContaining({ code: 'corrupt-artifact', cause: expect.any(Error) }))
  }
})

it('renders full assembled settings and every book chapter obligation', () => {
  const inputRefs = [{ artifactId, sha256: 'a'.repeat(64) }]
  const settings = { version: 1, selectedCodes: ['a1'], inputRefs, dimensions: [{ version: 1, dimensionCode: 'a1', inputRefs,
    facts: [{ id: 'genre', statement: 'A mystery.' }], contentMarkdown: '# Genre\nA mystery.' }] }
  const assembled = artifactMarkdown(artifact('settings', JSON.stringify(settings)))
  expect(assembled).toContain('## Dimension a1\n\n&#35; Genre  \nA mystery.\n\nFact ID\n\ngenre\n\nStatement\n\nA mystery.')
  expect(assembled).not.toContain('```')
  const book = { version: 1, inputRefs, contentMarkdown: 'A harbor mystery.', ending: 'The missing ship returns.', characterArcs: [{ character: 'Keeper', development: 'Learns to trust.' }],
    chapters: [{ chapterNumber: 1, title: 'Fog', purpose: 'Find the manifest.', targetWords: 4000, obligations: [{ id: 'manifest', description: 'Recover the hidden manifest.' }] }] }
  const markdown = artifactMarkdown(artifact('book-outline', JSON.stringify(book)))
  for (const text of ['The missing ship returns.', 'Learns to trust.', 'Recover the hidden manifest.']) expect(markdown).toContain(text)
  expect(markdown).not.toContain('Target words')
  expect(markdown).not.toContain('4000')
})

it('renders chapter plans, complete scene prose and actual continuity without dropping the last evidence', () => {
  const inputRefs = [{ artifactId, sha256: 'a'.repeat(64) }]
  const outline = { version: 1, inputRefs, chapterNumber: 1, title: 'Fog', targetWords: 4000, throughLine: 'Find the manifest.', constraints: ['The light remains off.'],
    scenes: [{ id: 'search', purpose: 'Locate the hidden log.', action: 'Search the tower.', obligationIds: ['manifest'] }], obligations: [{ id: 'manifest', description: 'Recover the manifest.' }] }
  const chapterPlan = artifactMarkdown(artifact('chapter-outline', JSON.stringify(outline)))
  expect(chapterPlan).toContain('The light remains off.')
  expect(chapterPlan).not.toContain('Target words')
  expect(chapterPlan).not.toContain('4000')
  const prose = '夜色沉沉。'.repeat(1000) + '\nEND-BODY'
  const body = { version: 1, inputRefs, chapterNumber: 1, scenes: [{ sceneId: 'search', text: prose }] }
  const chapter = artifactMarkdown(artifact('body', JSON.stringify(body)))
  expect(chapter).toContain('## Prose\n\n' + '夜色沉沉。'.repeat(1000) + '  \nEND-BODY\n\n## Provenance\n\n- Artifact: ' + artifactId + '\n- Kind: body\n- Revision: 1\n')
  expect(chapter).toContain('\n- Scene: search\n- Input artifact: ' + artifactId + '\n- Input SHA-256: ' + 'a'.repeat(64) + '\n')
  expect(chapter).not.toContain('```')
  const continuity = { version: 1, inputRefs, chapterNumber: 1, summary: 'The keeper has the manifest.', characters: [{ name: 'Keeper', state: 'At the tower.' }],
    timeline: [{ event: 'Manifest recovered.', evidence: [{ artifactId, quote: 'END-BODY' }] }],
    obligations: [{ id: 'manifest', status: 'fulfilled', explanation: 'Recovered in the final scene.', evidence: [{ artifactId, quote: 'END-BODY' }] }] }
  const markdown = artifactMarkdown(artifact('continuity', JSON.stringify(continuity)))
  for (const text of ['At the tower.', 'Manifest recovered.', 'Recovered in the final scene.', 'END-BODY']) expect(markdown).toContain(text)
})

it('preserves the version-1 empty-source Markdown wording', () => {
  const text = JSON.stringify({ ...inputs, planId: artifactId, outcome: 'failed',
    findings: [{ questionId: 'signal', callIds: ['native-fetch'], conclusion: 'Unavailable.', adequate: false, outcome: 'failed' }],
    observations: [{ callId: 'native-fetch', name: 'web_fetch', input: { url: 'https://example.test/signal' },
      callSeq: 11, resultSeq: 12, status: 'failed', error: 'Unavailable.', sources: [] }],
  })
  expect(artifactMarkdown(artifact('research-evidence', text))).toContain('No sources were recorded for this call.')
})

it.each([
  { sourceIndex: 0, reference: 'https://example.test/usable', title: null, reason: 'unsupported-reference' },
  { sourceIndex: 1, reference: '/relative', title: null, reason: 'unsupported-reference' },
  { sourceIndex: 0, reference: '/relative', title: null, reason: 'invented-reason' },
])('rejects inconsistent version-2 rejected-source data: %j', rejected => {
  const text = JSON.stringify({ ...inputs, version: 2, planId: artifactId, outcome: 'insufficient',
    findings: [{ questionId: 'signal', callIds: ['native-search'], conclusion: 'Unverified.', adequate: false, outcome: 'insufficient' }],
    observations: [{ callId: 'native-search', name: 'web_search', input: { queries: ['signal'] },
      callSeq: 11, resultSeq: 12, status: 'succeeded', error: null, sources: [], rejectedSources: [rejected] }],
  })
  expect(() => artifactMarkdown(artifact('research-evidence', text))).toThrowError(expect.objectContaining({ code: 'corrupt-artifact' }))
})

it('keeps the previous fenced rendering byte-exact so unmodified older preview files still verify', () => {
  const inputRefs = [{ artifactId, sha256: 'a'.repeat(64) }]
  const body = { version: 1, inputRefs, chapterNumber: 2, scenes: [{ sceneId: 'dock', text: '潮水退去。``' }, { sceneId: 'tower', text: '灯亮了。' }] }
  const stored = artifact('body', JSON.stringify(body))
  expect(legacyArtifactMarkdown(stored)).toBe([
    '# Chapter 2', 'Story word count: 7', '## Prose', '```text\n潮水退去。``\n\n灯亮了。\n```', '## Provenance',
    `\`\`\`text\nArtifact: ${artifactId}\nKind: body\nRevision: 1\nArtifact SHA-256: ${stored.sha256}\nNovel: ${novelId}\nScene: dock\nScene: tower\nInput artifact: ${artifactId}\nInput SHA-256: ${'a'.repeat(64)}\n\`\`\``,
  ].join('\n\n') + '\n')
  expect(artifactMarkdown(stored)).toContain('## Prose\n\n潮水退去。&#96;&#96;\n\n灯亮了。\n\n## Provenance\n\n- Artifact: ')
  const brief = artifact('creative-brief', '# 简报')
  expect(legacyArtifactMarkdown(brief)).toBe(artifactMarkdown(brief))
})
