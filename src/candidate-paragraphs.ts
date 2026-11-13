/** Paragraph split of a stored candidate. Each block stays inside one JSON string or the assembled chapter. */
import { assembleBody } from './body-text.ts'
import { settingsCollectionSchema } from './manuscript-records.ts'
import { numberParagraphs, type NumberedParagraph } from './paragraphs.ts'
import { StageOutputSchemas } from './stage-output.ts'

/**
 * Reader-facing body strings of one stored candidate, in order.
 * A chapter body is its assembled scenes. Other candidates contribute the prose fields a review cites,
 * each field on its own so a paragraph cannot span two JSON strings.
 * @param kind - Stored artifact kind. @param storedText - Exact stored text.
 * @returns Sources to number. An unrecognized kind contributes the raw text when it is not JSON.
 */
export function candidateBodySources(kind: string, storedText: string): readonly string[] {
  if (!/^\s*[[{]/u.test(storedText)) return [storedText]
  let parsed: unknown
  try { parsed = JSON.parse(storedText) } catch { return [storedText] }
  if (kind === 'body') {
    const body = StageOutputSchemas.body.safeParse(parsed)
    return body.success ? [assembleBody(body.data)] : [storedText]
  }
  if (kind === 'settings-dimension') {
    const settings = StageOutputSchemas.settings.safeParse(parsed)
    return settings.success ? [settings.data.contentMarkdown] : [storedText]
  }
  if (kind === 'book-outline') {
    const outline = StageOutputSchemas['book-outline'].safeParse(parsed)
    return outline.success ? [outline.data.contentMarkdown] : [storedText]
  }
  if (kind === 'chapter-outline') {
    const outline = StageOutputSchemas['chapter-outline'].safeParse(parsed)
    return outline.success ? [outline.data.throughLine, ...outline.data.scenes.map(scene => scene.action)] : [storedText]
  }
  if (kind === 'continuity') {
    const continuity = StageOutputSchemas.continuity.safeParse(parsed)
    return continuity.success ? [continuity.data.summary] : [storedText]
  }
  if (kind === 'settings') {
    const collection = settingsCollectionSchema.safeParse(parsed)
    return collection.success ? collection.data.dimensions.map(dimension => dimension.contentMarkdown) : [storedText]
  }
  return [storedText]
}

/**
 * Re-split a stored candidate into stable paragraph ids.
 * Call this again after a repair; do not reuse a split from the previous text.
 * @param kind - Stored artifact kind. @param storedText - Exact stored text.
 * @returns Numbered paragraphs of the current body.
 */
export function paragraphsOfStoredCandidate(kind: string, storedText: string): readonly NumberedParagraph[] {
  return numberParagraphs(candidateBodySources(kind, storedText))
}
