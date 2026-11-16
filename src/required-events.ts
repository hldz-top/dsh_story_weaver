/**
 * Host hit check for required events and physical chains.
 *
 * The creative brief is the only source of requirements. A numbered list under a requirement heading, or an
 * unnumbered physical chain under that heading, is taken from the brief itself. An admitted outline obligation is
 * added only when its description occurs verbatim in the brief. Nothing else becomes a required item: an outline
 * may not invent a beat the brief does not state.
 *
 * After a body is assembled, each item is a keyword hit. A miss is named by the brief's own item number and written
 * into the repair instruction. The check does not read the review, and it does not change prompt bytes.
 */

/** One required event the brief states, in the brief's own numbering when the brief numbered it. */
export interface RequiredEvent {
  /** 1-based item number from the brief, or the next free number for a verbatim outline obligation. */
  readonly index: number
  /** Verbatim requirement text. For a brief item this is the brief's wording; for an outline obligation, that description. */
  readonly text: string
  /** Substrings that must all occur in the assembled chapter. */
  readonly keywords: readonly string[]
  /** Outline obligation this item was grounded to, when one supplied the description. */
  readonly obligationId?: string
}

/** A required event the assembled chapter did not hit, with the keywords that were absent. */
export interface MissingRequiredEvent extends RequiredEvent {
  readonly absentKeywords: readonly string[]
}

/** Admitted outline obligations. Descriptions the brief does not contain are ignored. */
export interface RequiredEventObligation {
  readonly id?: string
  readonly description: string
}

const MARKERS = [
  '必写事件', '必写情节', '必写节点', '必须写到', '必须写出', '必须发生', '必须包含', '必须出现', '必须写',
  '硬性要求', '硬性约束', '硬性条件', '不得遗漏', '物理链', '必写',
  'required events', 'required event', 'physical chains', 'physical chain',
] as const

/**
 * Connectors that separate beats in one physical chain. 和, 及, 再 and 并 also occur inside ordinary words
 * (和平, 及时) and are not split.
 */
const CONNECTORS = ['以及', '接连', '然后', '接着', '与'] as const
/** Leading function words removed from a keyword. A word is removed only when the remainder is nonempty. Single characters that begin ordinary words, such as 要 in 要求, are not removed. */
const LEADING = ['必须', '务必', '应当', '应该', '不得', '不能', '不可', '尚未', '已经', '写到', '写出', '被', '把', '将'] as const
const LEAD_IN = /^(?:如下|如下所示|包括|见下|见下列|名单如下)$/u
const NUMBERED_SOURCE = String.raw`第\s*(\d{1,3})\s*条\s*|[（(]\s*(\d{1,3})\s*[)）]\s*|(\d{1,3})\s*[.、．)）:：]\s*`

function compact(value: string): string {
  return value.replace(/\s+/gu, '')
}

function clean(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().replace(/^[:：]+/u, '').replace(/[。！？!?;；]+$/u, '').trim()
}

function normalizeDescription(description: string): string {
  return clean(description)
}

/** @param line - One brief line. @returns The heading marker and the text after its colon, when the line is a requirement heading. */
function matchMarker(line: string): { marker: string; tail: string } | null {
  const trimmed = line.trim()
  const lower = trimmed.toLowerCase()
  for (const marker of MARKERS) {
    const at = lower.indexOf(marker.toLowerCase())
    if (at < 0) continue
    const before = trimmed.slice(0, at).trim()
    if ([...before].length > 6) continue
    if (before.length > 0 && !/^[\p{Script=Han}A-Za-z]+$/u.test(before)) continue
    let tail = trimmed.slice(at + marker.length).trim()
    if (tail.startsWith(':') || tail.startsWith('：')) tail = tail.slice(1).trim()
    else if (tail.length > 0) continue
    return { marker, tail }
  }
  return null
}

function parseNumbered(text: string): { index: number; text: string }[] {
  const marks: { index: number; from: number; end: number }[] = []
  for (const match of text.matchAll(new RegExp(NUMBERED_SOURCE, 'gu'))) {
    const raw = match[1] ?? match[2] ?? match[3]
    if (raw === undefined || match.index === undefined) continue
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 1) continue
    marks.push({ index, from: match.index, end: match.index + match[0].length })
  }
  const items: { index: number; text: string }[] = []
  for (let cursor = 0; cursor < marks.length; cursor++) {
    const mark = marks[cursor]!
    const textEnd = cursor + 1 < marks.length ? marks[cursor + 1]!.from : text.length
    const body = clean(text.slice(mark.end, textEnd))
    if (body.length === 0 || items.some(item => item.index === mark.index)) continue
    items.push({ index: mark.index, text: body })
  }
  return items
}

function stripLeading(value: string): string {
  let rest = value
  let changed = true
  while (changed) {
    changed = false
    for (const word of LEADING) {
      if (rest.startsWith(word) && [...rest].length > [...word].length) {
        rest = rest.slice(word.length)
        changed = true
        break
      }
    }
  }
  return rest
}

function splitConnectors(value: string): string[] {
  const parts: string[] = []
  let rest = value
  while (rest.length > 0) {
    let at = -1
    let found = ''
    for (const word of CONNECTORS) {
      const index = rest.indexOf(word)
      if (index >= 0 && (at < 0 || index < at || (index === at && word.length > found.length))) {
        at = index
        found = word
      }
    }
    if (at < 0 || found.length === 0) {
      parts.push(rest)
      break
    }
    if (at > 0) parts.push(rest.slice(0, at))
    rest = rest.slice(at + found.length)
  }
  return parts
}

/** @param text - One requirement's brief wording. @returns The substrings that must occur in the chapter. */
export function requiredEventKeywords(text: string): string[] {
  const keywords: string[] = []
  for (const piece of text.split(/[\s,，。；;、！？!?:：]+/u).flatMap(splitConnectors)) {
    const stripped = stripLeading(piece.trim())
    if ([...stripped].length >= 2) keywords.push(stripped)
  }
  if (keywords.length > 0) return keywords
  const fallback = text.trim()
  return fallback.length === 0 ? [] : [fallback]
}

function chainText(marker: string, tail: string): string | null {
  const text = clean(tail)
  if (text.length === 0 || LEAD_IN.test(text) || [...text].length < 2) return null
  if (marker === '物理链' || marker === 'physical chain' || marker === 'physical chains' || /[、,，;；]/u.test(text)) return text
  return null
}

function nextIndex(events: readonly { index: number }[]): number {
  return events.reduce((max, event) => Math.max(max, event.index), 0) + 1
}

function pushEvent(events: RequiredEvent[], index: number, text: string, obligationId?: string): void {
  const keywords = requiredEventKeywords(text)
  if (keywords.length === 0 || events.some(event => event.index === index)) return
  events.push({ index, text, keywords, ...(obligationId === undefined ? {} : { obligationId }) })
}

function extractBriefEvents(briefText: string): RequiredEvent[] {
  const lines = briefText.replace(/\r\n/gu, '\n').split('\n')
  const events: RequiredEvent[] = []
  for (let line = 0; line < lines.length; line++) {
    const marker = matchMarker(lines[line] ?? '')
    if (marker === null) continue
    const chunks: string[] = []
    if (marker.tail.length > 0) chunks.push(marker.tail)
    let next = line + 1
    for (; next < lines.length; next++) {
      const current = lines[next] ?? ''
      if (current.trim().length === 0 || matchMarker(current) !== null || parseNumbered(current).length === 0) break
      chunks.push(current.trim())
    }
    line = next - 1
    const numbered = parseNumbered(chunks.join('\n'))
    if (numbered.length > 0) {
      for (const item of numbered) pushEvent(events, item.index, item.text)
      continue
    }
    const chain = chainText(marker.marker, marker.tail)
    if (chain !== null) pushEvent(events, nextIndex(events), chain)
  }
  return events
}

function covers(eventText: string, description: string): boolean {
  const left = compact(eventText)
  const right = compact(normalizeDescription(description))
  if (left.length === 0 || right.length === 0) return false
  return left.includes(right) || right.includes(left)
}

function grounded(description: string, briefText: string): boolean {
  const text = normalizeDescription(description)
  if ([...text].length < 4) return false
  return compact(briefText).includes(compact(text))
}

/**
 * @param input - The creative brief, and outline obligations that may restate it.
 * @returns Required events in item order. An obligation whose description is not in the brief is omitted.
 */
export function extractRequiredEvents(input: {
  briefText: string
  obligations?: readonly RequiredEventObligation[]
}): RequiredEvent[] {
  const events = extractBriefEvents(input.briefText)
  for (const obligation of input.obligations ?? []) {
    const description = normalizeDescription(obligation.description)
    if (description.length === 0) continue
    const existing = events.find(event => covers(event.text, description))
    if (existing !== undefined) {
      if (existing.obligationId === undefined && obligation.id !== undefined) {
        const index = events.indexOf(existing)
        events[index] = { ...existing, obligationId: obligation.id }
      }
      continue
    }
    if (!grounded(description, input.briefText)) continue
    pushEvent(events, nextIndex(events), description, obligation.id)
  }
  return events
}

/**
 * @param bodyText - Assembled chapter prose.
 * @param events - Events from {@link extractRequiredEvents}.
 * @returns Events whose keywords do not all occur. The review is not an input.
 */
export function missingRequiredEvents(bodyText: string, events: readonly RequiredEvent[]): MissingRequiredEvent[] {
  const body = compact(bodyText)
  const missing: MissingRequiredEvent[] = []
  for (const event of events) {
    const absentKeywords = event.keywords.filter(keyword => !body.includes(compact(keyword)))
    if (absentKeywords.length > 0) missing.push({ ...event, absentKeywords })
  }
  return missing
}

/**
 * @param missing - Events the chapter did not hit.
 * @returns The repair instruction. Item numbers are the brief's numbers, so a gap stays "missing item 3".
 */
export function requiredEventRepairInstruction(missing: readonly MissingRequiredEvent[]): string {
  const items = missing.map(item => {
    const same = item.absentKeywords.length === 1 && compact(item.absentKeywords[0] ?? '') === compact(item.text)
    const gap = same || item.absentKeywords.length === 0 ? '' : ` (absent: ${item.absentKeywords.join('、')})`
    return `missing item ${item.index} (缺第 ${item.index} 条): 「${item.text}」${gap}`
  })
  return `Host required-event check: ${items.join('; ')}. Write each missing required event into the prose. The creative brief is the only source of requirements; do not add an event it does not state.`
}
