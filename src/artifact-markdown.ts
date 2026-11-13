/** Readable document projection of immutable writing artifacts. */
import type { z } from 'zod'
import { assembleBody, countStoryWords } from './body-text.ts'
import { settingsCollectionSchema } from './manuscript-records.ts'
import { WritingError, type Artifact, type ResearchOutcome } from './contracts.ts'
import { researchEvidenceContentSchema, researchPlanContentSchema } from './research.ts'
import { StageOutputSchemas, type EvidenceCitation, type ReviewCategory } from './stage-output.ts'
import { literalTextBlock, quotedText, readableList, readableText } from './readable-markdown.ts'

/** How recorded text, quotations and provenance entries become Markdown blocks. */
interface BlockStyle {
  readonly text: (text: string) => string
  readonly quote: (text: string) => string
  readonly list: (items: readonly string[]) => string
}

/** Current previews: readable inert paragraphs, blockquotes and bullet lists. */
const readableStyle: BlockStyle = { text: readableText, quote: quotedText, list: readableList }

/** Previews written before readable rendering: every recorded value inside a literal code fence. */
const legacyStyle: BlockStyle = { text: literalTextBlock, quote: literalTextBlock, list: items => literalTextBlock(items.join('\n')) }

const outcomes: Record<ResearchOutcome, string> = {
  'not-needed': 'External research not needed', succeeded: 'Sufficient evidence', insufficient: 'Insufficient evidence', failed: 'Research failed',
}
const reviewCategories: Record<ReviewCategory, string> = {
  completeness: 'Completeness', consistency: 'Consistency', obligations: 'Required events',
  continuity: 'Continuity', length: 'Chapter length', style: 'Style',
}
const classifications = { internal: 'Internal context', creative: 'Creative decision', external: 'External research' }

function evidenceSections(style: BlockStyle, citations: readonly EvidenceCitation[]): string[] {
  return citations.flatMap((citation, index) => [
    `### Evidence ${index + 1}`, `Source artifact: ${citation.artifactId}`, style.quote(citation.quote),
  ])
}

function parseContent<T>(schema: z.ZodType<T>, text: string): T {
  try { return schema.parse(JSON.parse(text)) }
  catch (cause) { throw new WritingError('corrupt-artifact', 'Writing artifact JSON cannot be rendered', { cause }) }
}

function sourceLink(url: string): string {
  return `<${new URL(url).href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>`
}

/** @param artifact - Exact stored version. @param options - imported marks a settings dimension adopted through story_settings_import. @returns Its readable Markdown representation. */
export function artifactMarkdown(artifact: Artifact, options: { readonly imported?: boolean } = {}): string {
  return renderArtifact(artifact, readableStyle, options.imported === true)
}

/**
 * The representation written by releases before readable rendering. It is used only to recognize an existing preview
 * file as a faithful projection, so upgrading does not turn unmodified older previews into verification failures.
 * @param artifact - Exact stored version.
 * @returns Its previous fenced Markdown representation.
 */
export function legacyArtifactMarkdown(artifact: Artifact): string {
  return renderArtifact(artifact, legacyStyle)
}

function renderArtifact(artifact: Artifact, style: BlockStyle, imported = false): string {
  if (artifact.kind === 'creative-brief') return artifact.text
  const sections: string[] = []
  const provenance = [
    `Artifact: ${artifact.id}`, `Kind: ${artifact.kind}`, `Revision: ${artifact.revision}`,
    `Artifact SHA-256: ${artifact.sha256}`, `Novel: ${artifact.novelId}`,
  ]
  if (artifact.kind === 'settings-dimension') {
    const settings = parseContent(StageOutputSchemas.settings, artifact.text)
    sections.push('# Settings dimension', `Dimension: ${settings.dimensionCode}`, `Document: ${imported ? 'Author import (人工导入)' : 'Generated candidate'}`,
      '## Content', style.text(settings.contentMarkdown))
    for (const [index, fact] of settings.facts.entries()) {
      sections.push(`## Fact ${index + 1}`, 'Fact ID', style.text(fact.id), 'Statement', style.text(fact.statement))
    }
    for (const [index, input] of settings.inputRefs.entries()) {
      provenance.push(`Input ${index + 1} artifact: ${input.artifactId}`, `Input ${index + 1} SHA-256: ${input.sha256}`)
    }
  } else if (artifact.kind === 'review') {
    const review = parseContent(StageOutputSchemas.review, artifact.text)
    const blocking = review.issues.filter(issue => issue.severity === 'blocking').length
    sections.push('# Review', `Review result: ${blocking > 0 ? 'Blocking issues found' : 'No blocking issues reported'}`,
      `Blocking issues: ${blocking}`, `Advisory issues: ${review.issues.length - blocking}`)
    for (const [index, check] of review.checks.entries()) {
      sections.push(`## Check ${index + 1}`, `Category: ${reviewCategories[check.category]}`, 'Summary', style.text(check.summary),
        ...evidenceSections(style, check.evidence))
    }
    for (const [index, issue] of review.issues.entries()) {
      sections.push(`## Issue ${index + 1}`, `Severity: ${issue.severity === 'blocking' ? 'Blocking' : 'Advisory'}`,
        `Category: ${reviewCategories[issue.category]}`, 'Issue ID', style.text(issue.id), 'Location', style.text(issue.location),
        'Finding', style.text(issue.message), ...evidenceSections(style, issue.evidence))
    }
    provenance.push(`Reviewed artifact: ${review.reviewed.artifactId}`, `Reviewed SHA-256: ${review.reviewed.sha256}`)
    for (const [index, input] of review.inputRefs.entries()) {
      provenance.push(`Input ${index + 1} artifact: ${input.artifactId}`, `Input ${index + 1} SHA-256: ${input.sha256}`)
    }
  } else if (artifact.kind === 'settings') {
    const settings = parseContent(settingsCollectionSchema, artifact.text)
    sections.push('# Settings', 'Selected dimensions', style.text(settings.selectedCodes.join(', ')))
    for (const dimension of settings.dimensions) {
      sections.push(`## Dimension ${dimension.dimensionCode}`, style.text(dimension.contentMarkdown))
      for (const fact of dimension.facts) sections.push('Fact ID', style.text(fact.id), 'Statement', style.text(fact.statement))
    }
    for (const input of settings.inputRefs) provenance.push(`Input artifact: ${input.artifactId}`, `Input SHA-256: ${input.sha256}`)
  } else if (artifact.kind === 'book-outline') {
    const outline = parseContent(StageOutputSchemas['book-outline'], artifact.text)
    sections.push('# Book outline', style.text(outline.contentMarkdown), '## Ending', style.text(outline.ending))
    for (const arc of outline.characterArcs) sections.push('## Character arc', 'Character', style.text(arc.character), 'Development', style.text(arc.development))
    for (const chapter of outline.chapters) {
      sections.push(`## Chapter ${chapter.chapterNumber}`, 'Title', style.text(chapter.title), 'Purpose', style.text(chapter.purpose))
      for (const obligation of chapter.obligations) sections.push('Required event ID', style.text(obligation.id), 'Required event', style.text(obligation.description))
    }
    for (const input of outline.inputRefs) provenance.push(`Input artifact: ${input.artifactId}`, `Input SHA-256: ${input.sha256}`)
  } else if (artifact.kind === 'chapter-outline') {
    const outline = parseContent(StageOutputSchemas['chapter-outline'], artifact.text)
    sections.push(`# Chapter ${outline.chapterNumber} outline`, 'Title', style.text(outline.title), '## Through-line', style.text(outline.throughLine))
    for (const constraint of outline.constraints) sections.push('## Constraint', style.text(constraint))
    for (const scene of outline.scenes) sections.push('## Scene', 'Scene ID', style.text(scene.id), 'Purpose', style.text(scene.purpose), 'Action', style.text(scene.action), 'Required event IDs', style.text(scene.obligationIds.join(', ')))
    for (const obligation of outline.obligations) sections.push('## Required event', 'ID', style.text(obligation.id), 'Description', style.text(obligation.description))
    for (const note of outline.stateNotes ?? []) sections.push('## State note', style.text(note))
    for (const input of outline.inputRefs) provenance.push(`Input artifact: ${input.artifactId}`, `Input SHA-256: ${input.sha256}`)
  } else if (artifact.kind === 'body') {
    const body = parseContent(StageOutputSchemas.body, artifact.text)
    const prose = assembleBody(body)
    sections.push(`# Chapter ${body.chapterNumber}`, `Story word count: ${countStoryWords(prose)}`, '## Prose', style.text(prose))
    for (const scene of body.scenes) provenance.push(`Scene: ${scene.sceneId}`)
    for (const input of body.inputRefs) provenance.push(`Input artifact: ${input.artifactId}`, `Input SHA-256: ${input.sha256}`)
  } else if (artifact.kind === 'continuity') {
    const continuity = parseContent(StageOutputSchemas.continuity, artifact.text)
    sections.push(`# Chapter ${continuity.chapterNumber} continuity`, '## Summary', style.text(continuity.summary))
    for (const character of continuity.characters) sections.push('## Character', 'Name', style.text(character.name), 'State', style.text(character.state))
    for (const event of continuity.timeline) sections.push('## Timeline event', style.text(event.event), ...evidenceSections(style, event.evidence))
    for (const obligation of continuity.obligations) sections.push('## Required event', 'ID', style.text(obligation.id), `Status: ${obligation.status}`, 'Explanation', style.text(obligation.explanation), ...evidenceSections(style, obligation.evidence))
    for (const input of continuity.inputRefs) provenance.push(`Input artifact: ${input.artifactId}`, `Input SHA-256: ${input.sha256}`)
  } else if (artifact.kind === 'research-plan') {
    const plan = parseContent(researchPlanContentSchema, artifact.text)
    sections.push('# Research plan')
    for (const [index, question] of plan.questions.entries()) {
      sections.push(`## Question ${index + 1}`, `Classification: ${classifications[question.kind]}`,
        style.text(question.question), 'Reason', style.text(question.reason))
      provenance.push(`Question ${index + 1} ID: ${question.id}`)
    }
    provenance.push(`Creative brief: ${plan.briefArtifactId}`, `Session: ${plan.sessionId}`, `Start sequence: ${plan.startSeq}`)
  } else if (artifact.kind === 'research-evidence') {
    const evidence = parseContent(researchEvidenceContentSchema, artifact.text)
    sections.push('# Research evidence', `Outcome: ${outcomes[evidence.outcome]}`)
    for (const [index, finding] of evidence.findings.entries()) {
      sections.push(`## Finding ${index + 1}`, 'Question ID', style.text(finding.questionId),
        `Outcome: ${outcomes[finding.outcome]}`, 'Conclusion', style.text(finding.conclusion),
        `Evidence judged adequate: ${finding.adequate ? 'Yes' : 'No'}`)
      provenance.push(`Finding ${index + 1} call IDs: ${finding.callIds.join(', ')}`)
      if (evidence.version === 3) for (const selection of evidence.findings[index]!.selections) provenance.push(`Finding ${index + 1}: call ${selection.callId}, source ${selection.sourceIndex}, offset ${selection.offset}, characters ${selection.limit}`)
    }
    for (const [index, observation] of evidence.observations.entries()) {
      sections.push(`## Native web call ${index + 1}`, `Tool: ${observation.name}`, `Execution: ${observation.status}`)
      if ('queries' in observation.input) {
        for (const [queryIndex, query] of observation.input.queries.entries()) sections.push(`Query ${queryIndex + 1}`, style.text(query))
      } else sections.push('Requested URL', style.text(observation.input.url))
      if (observation.error !== null) sections.push('Recorded error', style.text(observation.error))
      if (observation.sources.length === 0) sections.push(observation.rejectedSources.length === 0
        ? 'No sources were recorded for this call.' : 'No usable sources were recorded for this call.')
      for (const [sourceNumber, source] of observation.sources.entries()) {
        sections.push(`### Source ${sourceNumber + 1}`, `URL: ${sourceLink(source.url)}`)
        if (source.title !== null) sections.push('Recorded title', style.text(source.title))
        if ('excerpts' in source) {
          sections.push(`HTTP status: ${source.httpStatus === null ? 'Not applicable' : source.httpStatus}`, `Evidence eligibility: ${source.eligibility}`,
            `Retention: ${source.retention}`, `Native result truncated: ${source.nativeTruncated ? 'Yes' : 'No'}`)
          if (source.excerpts.length === 0) sections.push('No source excerpt was selected.')
          for (const excerpt of source.excerpts) sections.push(`Quoted source material at Unicode offset ${excerpt.offset} (${excerpt.limit} characters)`, style.quote(excerpt.text))
          provenance.push(`Call ${index + 1}, source ${sourceNumber + 1}: index ${source.sourceIndex}`, `Recorded URL: ${source.url}`,
            `Body interval: ${source.bodyStart}–${source.bodyEnd}; recorded characters: ${source.totalChars}`, `Recorded source SHA-256: ${source.sha256}`)
        } else {
          sections.push('Quoted source material', source.excerpt.length === 0 ? 'No source text was recorded.' : style.quote(source.excerpt),
            `Excerpt truncated: ${source.truncated ? 'Yes' : 'No'}`)
          provenance.push(`Call ${index + 1}, source ${sourceNumber + 1}: index ${source.sourceIndex}`, `Recorded URL: ${source.url}`,
            `Excerpt offset: ${source.offset}; recorded characters: ${source.totalChars}`, `Recorded source SHA-256: ${source.sha256}`)
        }
      }
      for (const source of observation.rejectedSources) {
        sections.push('### Rejected source reference', `Original source index: ${source.sourceIndex}`,
          `Reason: ${source.reason}`, 'Original reference (not usable as evidence)', style.text(source.reference))
        if (source.title !== null) sections.push('Recorded title', style.text(source.title))
      }
      provenance.push(`Call ${index + 1} ID: ${observation.callId}`, `Call sequence: ${observation.callSeq}; result sequence: ${observation.resultSeq}`)
    }
    provenance.push(`Plan: ${evidence.planId}`, `Creative brief: ${evidence.briefArtifactId}`, `Session: ${evidence.sessionId}`, `Start sequence: ${evidence.startSeq}`)
  } else {
    const kind: never = artifact.kind
    throw new Error(`Unsupported artifact kind: ${kind}`)
  }
  sections.push('## Provenance', style.list(provenance))
  return `${sections.join('\n\n')}\n`
}
