/**
 * Host-side AI-tone markers for chapter narration, adapted from lieflat-less-ai-tone
 * (https://github.com/larashero3-dotcom/lieflat-less-ai-tone, commit 27d2923, MIT License, Copyright (c) 2026 shiujan;
 * full notice in third_party/lieflat-less-ai-tone.LICENSE). The patterns follow the skill's locatable trigger markers
 * (SKILL.md rules 1, 2, 4, 8/9, 10 and 11; regexes after scripts/compare-human-ai.py and scripts/check-structure.py).
 *
 * Only narration is scanned: 「」 and “” dialogue and standalone 【】 panel lines are removed first, because the skill
 * leaves dialogue, quotations and genre formatting alone. Rules the skill exempts for fiction are not ported: adjacent
 * sentence isomorphism (3), numbered headings (6) and idealised-persona metaphors (7). Counts are evidence for the
 * style review. From prompt version 5 with aiToneBlocking on, {@link aiToneHits} locates the same hits (as offsets in the
 * narration view) so the host can decide which quoted spans block (see WritingRunner). Those offsets are in the narration
 * view, not the assembled chapter.
 *
 * From prompt version 3 the body-review task includes this report. tests/ai-tone.spec.ts freezes it for the two
 * chapter fixtures. Prompt versions 3 and 4 are on main: changing that report makes a paused body review hit
 * attempt-conflict on resume, so bump CURRENT_PROMPT_VERSION in the same change. Excerpt windows stay the UTF-16
 * slice used since version 3, so resumed v1–v6 prompts rebuild identical marker bytes.
 *
 * Prompt version 7 hands the review {@link gradeAiTone} instead: the same markers plus a density grade. That grade is a
 * hint. It does not decide whether a chapter applies. Dialogue and panels stay out of the scan.
 */

export type AiToneRule = 'reversal' | 'enumeration' | 'dash' | 'opener' | 'nominalization' | 'long-attributive' | 'when-clause' | 'topic-shell' | 'connective' | 'restatement' | 'zero-subject-comment'
export interface AiToneMarker { readonly rule: AiToneRule; readonly skillRule: string; readonly count: number; readonly perThousandHan: number; readonly examples: readonly string[] }
export interface AiToneReport { readonly source: 'lieflat-less-ai-tone@27d2923 (MIT)'; readonly narrationHan: number; readonly markers: readonly AiToneMarker[] }
/** Density grade on a version-7 report. Sparse is a hint; it is not a pass/fail gate. */
export type AiToneGrade = 'hint' | 'notice' | 'heavy'
export interface GradedAiToneMarker extends AiToneMarker { readonly grade: AiToneGrade }
export interface GradedAiToneReport extends Omit<AiToneReport, 'markers'> { readonly markers: readonly GradedAiToneMarker[] }

const SPAN = '[^，。！？；\\n]'
const patterns: readonly { readonly rule: Exclude<AiToneRule, 'zero-subject-comment'>; readonly skillRule: string; readonly pattern: RegExp }[] = [
  { rule: 'reversal', skillRule: '1 翻案腔', pattern: new RegExp(`(?:不是|并非|不在于)${SPAN}{1,20}，?(?:而是|而在于)|与其说[^。！？\\n]{1,20}不如说|看似[^。！？\\n]{1,20}实则|你以为[^。！？\\n]{1,20}其实|说到底|回头才发现|答案恰恰相反`, 'gu') },
  { rule: 'enumeration', skillRule: '2 顿号罗列过密', pattern: /[^，。！？；：、\n]{1,14}、[^，。！？；：、\n]{1,14}、[^，。！？；：、\n]{1,14}/gu },
  { rule: 'dash', skillRule: '4 破折号', pattern: /——/gu },
  { rule: 'opener', skillRule: '9 禁用起手式', pattern: /说白了|说穿了|先说结论/gu },
  { rule: 'nominalization', skillRule: '8 名词化概括', pattern: /(?:完成|实现|进行|开展)了?(?:对)?[^，。\n]{0,10}的(?:优化|提升|调整|分析|改造|升级)/gu },
  { rule: 'long-attributive', skillRule: '10 过长前置定语', pattern: /(?:一个|一种|一套|这种|这个)[^，。、；：！？\n]{15,}的[\u4e00-\u9fff]{2,5}/gu },
  // 时， is the marker. 当…的时候， never reaches it, so a (?<!的时候) lookbehind changes nothing a reader would write.
  { rule: 'when-clause', skillRule: '10 当…时', pattern: /当[^，。\n]{2,20}时，/gu },
  { rule: 'topic-shell', skillRule: '10 前置话题壳', pattern: /对于[^，。\n]{2,15}来说|对[^，。\n]{2,15}而言|就[^，。\n]{2,15}而言|在[^，。\n]{2,12}方面/gu },
  // Whitespace after an ASCII period still starts a sentence. A digit before the period (第3. / 2.0.) does not.
  { rule: 'connective', skillRule: '10 句首连接词', pattern: /(?:^|(?<=[。！？\n])|(?<=(?<!\d)\.[^\S\n]*))(?:然而|因此|此外|与此同时|换言之|总而言之)[，、]/gmu },
  { rule: 'restatement', skillRule: '10 这意味着式复述', pattern: /这意味着|这表明|这说明|换句话说/gu },
]
const COMMENT = /^(?:听起来|看起来|看上去|听上去|说白了|说到底|换句话说|意味着|值得注意|不难看出|问题在于|原因在于|有意思的是|更重要的是|关键在于|真正的)/u
const ANAPHOR = /(?:这|那|其|此|上面|前面|刚才|以上|该|它|他|她)/u
// An unclosed 「 or “ stops at the line, so it cannot swallow narration through a later closing quote.
// A 【】 panel may have trailing spaces; those lines are still panels.
const DIALOGUE = /「[^」\n]*」|“[^”\n]*”|^【[^\n]*】[^\S\n]*$/gmu
const HAN = /\p{Script=Han}/gu
const MAX_EXAMPLES = 3
const CONTEXT = 8

/** @param text - Assembled chapter text. @returns The text with dialogue and panel lines replaced by line breaks, so no match spans them. */
export function narrationOf(text: string): string { return text.replace(DIALOGUE, '\n') }

/**
 * @returns The match widened by up to {@link CONTEXT} UTF-16 units on each side, never past a line break, so it stays an
 * exact substring of the chapter. Unchanged since prompt version 3 for every version: these excerpts only feed the review
 * prompt's task.aiToneMarkers, so resumed runs rebuild identical prompt bytes; the window can cut a surrogate pair
 * (emoji, rare CJK), which is accepted. Blocking spans never come from here.
 */
function excerpt(narration: string, index: number, length: number): string {
  const lineStart = narration.lastIndexOf('\n', index - 1) + 1
  const lineEnd = narration.indexOf('\n', index + length)
  return narration.slice(Math.max(lineStart, index - CONTEXT), Math.min(lineEnd < 0 ? narration.length : lineEnd, index + length + CONTEXT))
}
/** @returns Up to {@link CONTEXT} code points of narration on each side of a match, never past a line break. */
function context(narration: string, index: number, length: number): { before: string; after: string } {
  const lineStart = narration.lastIndexOf('\n', index - 1) + 1
  const lineEnd = narration.indexOf('\n', index + length)
  return { before: [...narration.slice(lineStart, index)].slice(-CONTEXT).join(''),
    after: [...narration.slice(index + length, lineEnd < 0 ? narration.length : lineEnd)].slice(0, CONTEXT).join('') }
}

/** @param text - Assembled chapter text. @returns Marker counts per thousand narration Han characters, with exact excerpts. */
export function detectAiTone(text: string): AiToneReport {
  const narration = narrationOf(text)
  const narrationHan = narration.match(HAN)?.length ?? 0
  const markers: AiToneMarker[] = []
  const add = (rule: AiToneRule, skillRule: string, found: readonly string[]) => {
    if (found.length > 0) markers.push({ rule, skillRule, count: found.length, perThousandHan: narrationHan === 0 ? 0 : Math.round(found.length / narrationHan * 10_000) / 10, examples: found.slice(0, MAX_EXAMPLES) })
  }
  for (const { rule, skillRule, pattern } of patterns) add(rule, skillRule, [...narration.matchAll(pattern)].map(match => excerpt(narration, match.index, match[0].length)))
  const paragraphs = text.split('\n').map(line => line.trim()).filter(line => line.length >= 8 && !/^[「“【]/u.test(line))
  add('zero-subject-comment', '11 段首零主语评论', paragraphs.slice(1).filter(paragraph => COMMENT.test(paragraph) && !ANAPHOR.test(paragraph.split(/[，。！？]/u)[0] ?? '')).map(paragraph => paragraph.split(/[，。！？]/u)[0] ?? paragraph))
  return { source: 'lieflat-less-ai-tone@27d2923 (MIT)', narrationHan, markers }
}

/**
 * Grade each marker by hits per thousand narration Han characters: under 1 is `hint`, under 5 is `notice`, otherwise
 * `heavy`. A single dash or 、 list in a chapter-length narration is a hint. The grade is report-only.
 * @param report - The frozen {@link detectAiTone} report. @returns The same markers with a grade. The input report is unchanged.
 */
export function gradeAiTone(report: AiToneReport): GradedAiToneReport {
  const grade = (perThousandHan: number): AiToneGrade => perThousandHan < 1 ? 'hint' : perThousandHan < 5 ? 'notice' : 'heavy'
  return { ...report, markers: report.markers.map(marker => ({ ...marker, grade: grade(marker.perThousandHan) })) }
}

/** One detector hit located in the narration view, with a position-independent identity for repeat detection. */
export interface AiToneHit {
  readonly rule: AiToneRule
  /** UTF-16 offsets in {@link AiToneHits.narration}; the hit is narration.slice(start, end). */
  readonly start: number
  readonly end: number
  /**
   * Identities for repeat detection: rule and hit text with the narration just before it, and with the narration just after
   * it (up to the review excerpt's context on each side). A later body's hit is the same instance when any identity
   * matches, so an edit on one side of the marker, or a reviewer quoting it with another length, still counts as a repeat,
   * while another instance with the same marker text elsewhere does not. A side whose context is empty or only whitespace
   * (a hit opening a paragraph or following dialogue) yields no identity, since every such hit would share it; a hit with
   * no context on either side is identified by its text and its ordinal among identical such hits.
   */
  readonly keys: readonly string[]
}
/** The narration view of a chapter and every detector hit in it. */
export interface AiToneHits { readonly narration: string; readonly hits: readonly AiToneHit[] }

/** @returns {@link narrationOf} plus, for every text offset, its narration offset (-1 inside removed dialogue and panel lines). */
function narrationWithOffsets(text: string): { narration: string; offsets: number[] } {
  let narration = ''
  const offsets: number[] = Array.from({ length: text.length }, () => -1)
  let last = 0
  const keep = (from: number, to: number) => {
    for (let index = from; index < to; index++) offsets[index] = narration.length + index - from
    narration += text.slice(from, to)
  }
  for (const match of text.matchAll(DIALOGUE)) {
    keep(last, match.index)
    narration += '\n'
    last = match.index + match[0].length
  }
  keep(last, text.length)
  return { narration, offsets }
}

/**
 * Locate every hit of the same rules {@link detectAiTone} counts, in context: patterns run on the narration view (dialogue
 * and panels removed, so sentence and line starts are real), and zero-subject comments only at the start of a paragraph
 * that is not the first, as the detector requires. The prompt-version-5 gate blocks a quoted span only when one of its
 * occurrences in this narration fully covers one of these hits.
 * @param text - Assembled chapter text. @returns The narration view and its hits in document order.
 */
export function aiToneHits(text: string): AiToneHits {
  const { narration, offsets } = narrationWithOffsets(text)
  const hits: AiToneHit[] = []
  const add = (rule: AiToneRule, start: number, length: number) => {
    const { before, after } = context(narration, start, length)
    const marker = narration.slice(start, start + length)
    const keys = [...before.trim() === '' ? [] : [`${rule}\u0000${marker}\u0000<${before}`], ...after.trim() === '' ? [] : [`${rule}\u0000${marker}\u0000>${after}`]]
    hits.push({ rule, start, end: start + length, keys })
  }
  for (const { rule, pattern } of patterns) {
    for (const match of narration.matchAll(pattern)) {
      if (match[0].length === 0) continue
      if (rule !== 'enumeration') { add(rule, match.index, match[0].length); continue }
      // The enumeration pattern's leading item is greedy (it can swallow a sentence lead-in); its hit is the core, from the
      // character before the first 、 to the character after the second, so quoting just the listed items covers it.
      const first = match.index + match[0].indexOf('、')
      const second = match.index + match[0].indexOf('、', first - match.index + 1)
      const start = first - (/[\uDC00-\uDFFF]/u.test(narration[first - 1] ?? '') ? 2 : 1)
      const end = second + 1 + (/[\uD800-\uDBFF]/u.test(narration[second + 1] ?? '') ? 2 : 1)
      add(rule, start, end - start)
    }
  }
  let lineStart = 0
  let qualifying = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length >= 8 && !/^[「“【]/u.test(trimmed)) {
      const opener = qualifying++ > 0 ? COMMENT.exec(trimmed) : null
      const start = offsets[lineStart + line.indexOf(trimmed)] ?? -1
      if (opener !== null && start >= 0 && !ANAPHOR.test(trimmed.split(/[，。！？]/u)[0] ?? '')) add('zero-subject-comment', start, opener[0].length)
    }
    lineStart += line.length + 1
  }
  hits.sort((left, right) => left.start - right.start || left.end - right.end)
  const ordinals = new Map<string, number>()
  return { narration, hits: hits.map(hit => {
    if (hit.keys.length > 0) return hit
    const marker = `${hit.rule}\u0000${narration.slice(hit.start, hit.end)}`
    const ordinal = ordinals.get(marker) ?? 0
    ordinals.set(marker, ordinal + 1)
    return { ...hit, keys: [`${marker}\u0000#${ordinal}`] }
  }) }
}
