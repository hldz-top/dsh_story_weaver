/** Structured character cards parsed from e5/e6 Markdown. Pure: no I/O, no model calls. */
import { StageValidationRejection } from './stage-rejection.ts'

/** Prompt version that first requires the e5/e6 double table. Older versions do not parse or mention it. A parse failure falls back to free text and does not fail the settings stage. */
export const CHARACTER_SHEET_PROMPT_VERSION = 15
/** Default cap on characters in one e5 or e6 dimension. */
export const DEFAULT_MAX_CHARACTERS = 12
/** Misread frames the core table may use, besides `其它:` plus a short note. */
export const MISREAD_FRAMES = ['利益', '礼法', '逻辑', '技艺', '生计'] as const
const CORE_HEADERS = ['角色', '身份', '欲望', '恐惧', '缺陷', '误读框架', '反差', '出场章'] as const
const VOICE_HEADERS = ['角色', '句式', '专属词', '称呼主角', '自称', '身体签', '禁语'] as const
const CORE_TABLE = '内核表'
const VOICE_TABLE = '声纹表'

/** A closed misread frame, or `其它:` plus a note of at most 10 Unicode code points. */
export type MisreadFrame = (typeof MISREAD_FRAMES)[number] | `其它:${string}`

/** One character's motive row from the core table. */
export interface CharacterCore {
  name: string
  role: string
  want: string
  fear: string
  flaw: string
  misread: MisreadFrame
  contrast: string
  chapters: number[]
}

/** One character's voice row. `lexicon` keeps the 顿号-separated items in order. */
export interface CharacterVoice {
  name: string
  syntax: string
  lexicon: string[]
  addressForProtagonist: string
  selfReference: string
  mannerism: string
  forbidden: string
}

/** Both tables, in document order, with the same character names. */
export interface CharacterSheet {
  core: CharacterCore[]
  voice: CharacterVoice[]
}

/** Options for {@link parseCharacterSheet}. Omitted `maxCharacters` is {@link DEFAULT_MAX_CHARACTERS}. */
export interface ParseCharacterSheetOptions {
  readonly maxCharacters?: number
}

/**
 * A character-card defect the model can repair. The message names the character and the field and says what is expected.
 * The writing runner keeps the prose as free text and does not fail the settings stage.
 */
export class CharacterSheetRejection extends StageValidationRejection {
  /** @param message - The specific cell or table the next attempt must fix. */
  constructor(message: string) {
    super(message)
    this.name = 'CharacterSheetRejection'
  }
}

interface RawTable { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }

/** @param markdown - e5 or e6 contentMarkdown. @param options - Character cap. @returns Both tables. @throws CharacterSheetRejection */
export function parseCharacterSheet(markdown: string, options: ParseCharacterSheetOptions = {}): CharacterSheet {
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new Error('maxCharacters must be a positive integer')
  const tables = markdownTables(markdown)
  const core = takeTable(tables, CORE_HEADERS, CORE_TABLE, VOICE_HEADERS, VOICE_TABLE)
  const voice = takeTable(tables, VOICE_HEADERS, VOICE_TABLE, CORE_HEADERS, CORE_TABLE)
  const coreRows = core.rows.map((row, index) => readCore(row, index))
  const voiceRows = voice.rows.map((row, index) => readVoice(row, index))
  rejectDuplicates(coreRows.map(row => row.name), CORE_TABLE)
  rejectDuplicates(voiceRows.map(row => row.name), VOICE_TABLE)
  rejectMismatch(coreRows.map(row => row.name), voiceRows.map(row => row.name))
  if (coreRows.length > maxCharacters) {
    const names = coreRows.map(row => quoteName(row.name)).join(', ')
    throw new CharacterSheetRejection(`This dimension has ${coreRows.length} characters, above the maximum ${maxCharacters}. Split them between e5 助攻角色 and e6 配角群 so each dimension stays within ${maxCharacters}. Characters: ${names}.`)
  }
  return { core: coreRows, voice: voiceRows }
}

function reject(message: string): never { throw new CharacterSheetRejection(message) }

function quoteName(name: string): string {
  const chars = [...name]
  return chars.length <= 40 ? name : `${chars.slice(0, 40).join('')}…`
}

function cells(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined
  const inner = trimmed.slice(1, -1)
  if (!inner.includes('|')) return undefined
  return inner.split('|').map(cell => cell.trim())
}

function isSeparator(line: string, width: number): boolean {
  const parsed = cells(line)
  return parsed !== undefined && parsed.length === width && parsed.every(cell => /^:?-+:?$/u.test(cell))
}

function markdownTables(markdown: string): RawTable[] {
  const lines = markdown.split('\n')
  const tables: RawTable[] = []
  let index = 0
  while (index < lines.length - 1) {
    const header = cells(lines[index] ?? '')
    if (header === undefined || !isSeparator(lines[index + 1] ?? '', header.length)) {
      index += 1
      continue
    }
    const rows: string[][] = []
    index += 2
    while (index < lines.length) {
      const row = cells(lines[index] ?? '')
      if (row === undefined) break
      // The next header sits immediately above its own separator, so it is not a body row of this table.
      if (index + 1 < lines.length && isSeparator(lines[index + 1] ?? '', row.length)) break
      rows.push(row)
      index += 1
    }
    tables.push({ header, rows })
  }
  return tables
}

function sameHeader(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((cell, index) => cell === expected[index])
}

function looksLike(header: readonly string[], expected: readonly string[]): boolean {
  if (header[0] !== '角色') return false
  return expected.slice(1).some(column => header.includes(column))
}

function named(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row[0]?.trim() ?? '').find(name => name.length > 0) ?? ''
}

function takeTable(tables: readonly RawTable[], expected: readonly string[], label: string, otherHeaders: readonly string[], otherLabel: string): RawTable {
  const exact = tables.filter(table => sameHeader(table.header, expected))
  const malformed = tables.filter(table => !sameHeader(table.header, expected) && looksLike(table.header, expected) && overlap(table.header, expected) >= overlap(table.header, otherHeaders))
  if (malformed.length > 0 && exact.length === 0) {
    const table = malformed[0]!
    const name = named(table.rows)
    const who = name.length > 0 ? `Character ${quoteName(name)} ` : ''
    reject(`${who}${label} has ${table.header.length} columns; expected ${expected.length} columns: ${expected.join(', ')}.`)
  }
  if (exact.length === 0) {
    const other = tables.find(table => sameHeader(table.header, otherHeaders))
    const name = other === undefined ? '' : named(other.rows)
    const who = name.length > 0 ? `Character ${quoteName(name)} is missing the ` : 'Missing the '
    reject(`${who}${label} (columns ${expected.join(', ')}). The ${other === undefined ? 'other table is also missing' : `${otherLabel} is present`}.`)
  }
  if (exact.length > 1) {
    const name = named(exact[1]!.rows) || named(exact[0]!.rows)
    const who = name.length > 0 ? `Character ${quoteName(name)} ` : ''
    reject(`${who}${label} appears more than once; keep one ${label}.`)
  }
  return exact[0]!
}

function overlap(header: readonly string[], expected: readonly string[]): number {
  return header.filter(cell => (expected as readonly string[]).includes(cell)).length
}

function cellAt(row: readonly string[], index: number, name: string, field: string, table: string): string {
  const value = row[index]
  if (value === undefined || value.trim().length === 0) reject(`Character ${quoteName(name)} field ${field} in ${table} is blank; write that ${field}.`)
  return value.trim()
}

function readCore(row: readonly string[], index: number): CharacterCore {
  if (row.length !== CORE_HEADERS.length) {
    const name = row[0]?.trim() || `row ${index + 1}`
    reject(`Character ${quoteName(name)} ${CORE_TABLE} row has ${row.length} columns; expected ${CORE_HEADERS.length} columns: ${CORE_HEADERS.join(', ')}.`)
  }
  const name = cellAt(row, 0, row[0]?.trim() || `row ${index + 1}`, '角色', CORE_TABLE)
  return {
    name,
    role: cellAt(row, 1, name, '身份', CORE_TABLE),
    want: cellAt(row, 2, name, '欲望', CORE_TABLE),
    fear: cellAt(row, 3, name, '恐惧', CORE_TABLE),
    flaw: cellAt(row, 4, name, '缺陷', CORE_TABLE),
    misread: readFrame(name, cellAt(row, 5, name, '误读框架', CORE_TABLE)),
    contrast: cellAt(row, 6, name, '反差', CORE_TABLE),
    chapters: readChapters(name, cellAt(row, 7, name, '出场章', CORE_TABLE)),
  }
}

function readVoice(row: readonly string[], index: number): CharacterVoice {
  if (row.length !== VOICE_HEADERS.length) {
    const name = row[0]?.trim() || `row ${index + 1}`
    reject(`Character ${quoteName(name)} ${VOICE_TABLE} row has ${row.length} columns; expected ${VOICE_HEADERS.length} columns: ${VOICE_HEADERS.join(', ')}.`)
  }
  const name = cellAt(row, 0, row[0]?.trim() || `row ${index + 1}`, '角色', VOICE_TABLE)
  const lexicon = cellAt(row, 2, name, '专属词', VOICE_TABLE).split('、').map(item => item.trim()).filter(item => item.length > 0)
  if (lexicon.length === 0) reject(`Character ${quoteName(name)} field 专属词 in ${VOICE_TABLE} is blank; write the words separated by 、.`)
  return {
    name,
    syntax: cellAt(row, 1, name, '句式', VOICE_TABLE),
    lexicon,
    addressForProtagonist: cellAt(row, 3, name, '称呼主角', VOICE_TABLE),
    selfReference: cellAt(row, 4, name, '自称', VOICE_TABLE),
    mannerism: cellAt(row, 5, name, '身体签', VOICE_TABLE),
    forbidden: cellAt(row, 6, name, '禁语', VOICE_TABLE),
  }
}

function readFrame(name: string, value: string): MisreadFrame {
  if ((MISREAD_FRAMES as readonly string[]).includes(value)) return value as MisreadFrame
  if (value.startsWith('其它:')) {
    const note = value.slice('其它:'.length)
    const length = [...note].length
    if (note.trim().length === 0 || length > 10) {
      reject(`Character ${quoteName(name)} field 误读框架 is ${JSON.stringify(value)}; expected 利益, 礼法, 逻辑, 技艺, or 生计, or 其它: followed by 1 to 10 characters.`)
    }
    return `其它:${note}`
  }
  reject(`Character ${quoteName(name)} field 误读框架 is ${JSON.stringify(value)}; expected 利益, 礼法, 逻辑, 技艺, or 生计, or 其它: followed by at most 10 characters.`)
}

function readChapters(name: string, value: string): number[] {
  const parts = value.split(/[,，]/u).map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length === 0) reject(`Character ${quoteName(name)} field 出场章 is blank; expected comma-separated positive integers such as 1,2,3.`)
  return parts.map(part => {
    if (!/^[1-9][0-9]*$/u.test(part) || !Number.isSafeInteger(Number(part))) {
      reject(`Character ${quoteName(name)} field 出场章 contains ${JSON.stringify(part)}; expected comma-separated positive integers such as 1,2,3.`)
    }
    return Number(part)
  })
}

function rejectDuplicates(names: readonly string[], table: string): void {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) reject(`Character ${quoteName(name)} is duplicated in ${table}; each name appears once.`)
    seen.add(name)
  }
}

function rejectMismatch(coreNames: readonly string[], voiceNames: readonly string[]): void {
  const onlyCore = coreNames.filter(name => !voiceNames.includes(name))
  const onlyVoice = voiceNames.filter(name => !coreNames.includes(name))
  if (onlyCore.length === 0 && onlyVoice.length === 0) return
  const parts = [
    ...onlyCore.map(name => `Character ${quoteName(name)} is in ${CORE_TABLE} but not in ${VOICE_TABLE}`),
    ...onlyVoice.map(name => `Character ${quoteName(name)} is in ${VOICE_TABLE} but not in ${CORE_TABLE}`),
  ]
  reject(`${parts.join('; ')}. Both tables must list the same characters.`)
}
