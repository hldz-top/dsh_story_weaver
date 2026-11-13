/** Stable paragraph ids for review citations. The host re-splits the candidate body; the model cites an id. */
import { createHash } from 'node:crypto'
import { echo, StageValidationRejection } from './stage-rejection.ts'

/** One block of candidate body text, in reading order. `id` is its position in this split (`p1`, `p12`). */
export interface NumberedParagraph {
  /** Positional id from this split, `p` plus a 1-based index. */
  readonly id: string
  /** Exact paragraph text the id maps back to. */
  readonly text: string
  /** SHA-256 of `text`. The same wording keeps the same hash after a later re-split. */
  readonly sha256: string
}

const PARAGRAPH_ID = /^p[1-9][0-9]*$/u

/**
 * Split one source string into paragraph texts.
 * A blank line (a line break, optional spaces, another line break) separates paragraphs.
 * With no blank line, each non-empty line is a paragraph. The same string always splits the same way.
 * @param text - One reader-facing source that does not cross stored JSON fields.
 * @returns Trimmed non-empty blocks, in order.
 */
export function splitParagraphTexts(text: string): readonly string[] {
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const pieces = /\n[ \t]*\n/u.test(normalized) ? normalized.split(/\n[ \t]*\n+/u) : normalized.split('\n')
  return pieces.map(piece => piece.trim()).filter(piece => piece.length > 0)
}

/**
 * Number a re-split of the candidate body.
 * Ids are positions in this split. A later repair re-splits the new text; unchanged wording keeps its content hash.
 * @param sources - Body strings, each wholly inside one stored field or one assembled chapter. Empty sources are skipped.
 * @returns `p1` onward. An empty body yields an empty list.
 */
export function numberParagraphs(sources: readonly string[]): readonly NumberedParagraph[] {
  const blocks = sources.flatMap(splitParagraphTexts)
  return blocks.map((text, index) => ({
    id: `p${index + 1}`,
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param value - A model value. @returns Whether it contains a `{ paragraphId, problem }` citation. */
export function hasParagraphCitation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasParagraphCitation)
  if (!isRecord(value)) return false
  if (typeof value.paragraphId === 'string' && typeof value.problem === 'string' && Object.keys(value).length === 2) return true
  return Object.values(value).some(hasParagraphCitation)
}

/**
 * Replace `{ paragraphId, problem }` citations with `{ artifactId, quote }` for the existing verbatim check.
 * A known id quotes that paragraph of the reviewed candidate. An unknown id quotes `problem`, which the verbatim
 * check then rejects. Quote citations are left unchanged.
 * @param value - Model review JSON. @param paragraphs - The host re-split of the reviewed candidate.
 * @param reviewedArtifactId - Artifact the paragraph text is taken from.
 * @returns A copy safe for quote admission.
 */
export function expandParagraphCitations(value: unknown, paragraphs: readonly NumberedParagraph[], reviewedArtifactId: string): unknown {
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph.text]))
  const expand = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(expand)
    if (!isRecord(current)) return current
    if (typeof current.paragraphId === 'string' && typeof current.problem === 'string' && Object.keys(current).length === 2) {
      if (!PARAGRAPH_ID.test(current.paragraphId)) {
        throw new StageValidationRejection(`Evidence paragraphId ${echo(current.paragraphId)} is not a paragraph id; cite one id from task.paragraphs, such as p1`)
      }
      if (current.problem.trim().length === 0) throw new StageValidationRejection('Evidence problem must not be blank')
      const text = byId.get(current.paragraphId)
      return { artifactId: reviewedArtifactId, quote: text ?? current.problem }
    }
    return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, expand(child)]))
  }
  return expand(value)
}
