/**
 * Reader-facing plain-text view of a stored artifact, served to review stages so that every quote they can copy is
 * prose rather than JSON scaffolding. A chapter body becomes exactly its assembled scenes (the text its evidence is
 * checked against); another structured (JSON) artifact becomes its human-readable string values, one per line, with
 * field names, identifiers, digests and JSON punctuation removed; plain-text artifacts are served unchanged.
 */
import { assembleBody } from './body-text.ts'
import { StageOutputSchemas } from './stage-output.ts'

/** A string value that is only an identifier, digest, code or enum literal, never reader-facing prose. */
const IDENTIFIER = /^[\w.:/@+-]*$/u

function strings(value: unknown, into: string[]): void {
  if (typeof value === 'string') { if (value.trim().length > 0 && !IDENTIFIER.test(value)) into.push(value) }
  else if (Array.isArray(value)) for (const item of value) strings(item, into)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, into)
}

/** @param kind - Stored artifact kind. @param text - Exact stored text. @returns The plain-text view; deterministic for a given stored text. */
export function proseView(kind: string, text: string): string {
  if (!/^\s*[[{]/u.test(text)) return text
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return text }
  if (kind === 'body') {
    const body = StageOutputSchemas.body.safeParse(parsed)
    if (body.success) return assembleBody(body.data)
  }
  const values: string[] = []
  strings(parsed, values)
  return values.join('\n')
}

/**
 * Body-stage view of one outline: what happens in this chapter, and what the characters do now.
 * Book outlines contribute only this chapter's title, purpose and obligation descriptions.
 * Chapter outlines contribute the title, through-line, obligation descriptions, and each scene's purpose and action.
 * Word targets, constraints, state notes and the rest of the book are not in this view, so a beat table or a percentage
 * position stored on the outline is not handed to the writer. Other kinds are returned unchanged.
 * @param kind - Stored artifact kind. @param text - Exact stored text. @param chapterNumber - The chapter being written.
 * @returns The feed text. A value that is not an outline of this chapter is returned unchanged.
 */
export function bodyFeed(kind: string, text: string, chapterNumber: number): string {
  if (kind !== 'book-outline' && kind !== 'chapter-outline') return text
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return text }
  if (kind === 'book-outline') {
    const outline = StageOutputSchemas['book-outline'].safeParse(parsed)
    const chapter = outline.success ? outline.data.chapters.find(item => item.chapterNumber === chapterNumber) : undefined
    if (chapter === undefined) return text
    return [chapter.title, chapter.purpose, ...chapter.obligations.map(item => item.description)].join('\n')
  }
  const outline = StageOutputSchemas['chapter-outline'].safeParse(parsed)
  if (!outline.success || outline.data.chapterNumber !== chapterNumber) return text
  return [outline.data.title, outline.data.throughLine, ...outline.data.obligations.map(item => item.description),
    ...outline.data.scenes.flatMap(scene => [scene.purpose, scene.action])].join('\n')
}
