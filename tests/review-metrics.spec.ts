import { describe, expect, it } from 'vitest'
import { countHanChars, countStoryWords } from '../src/body-text.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { advisoryReviewMetrics, HOOK_WINDOW_CHARS, measureChapterMetrics, METRICS_BLOCKING_DEFAULT, type ChapterMetricsInput } from '../src/review-metrics.ts'
import { buildStagePrompt, type StagePromptKind } from '../src/stage-prompts.ts'

const FIXTURE_TEXT = '林澜推开门。\n\n「你好。」\n\n他看见落石。远处还有雷击吗？'
const FIXTURE_BRIEF = '必写事件：\n1. 落石\n2. 雷击\n'
const FIXTURE_SETTINGS = '硬性要求：\n1. 雾港灯塔\n'
const fixtureInput: ChapterMetricsInput = {
  text: FIXTURE_TEXT,
  previousSnapshot: { unrecoveredForeshadowing: [{ note: '落石' }] },
  briefText: FIXTURE_BRIEF,
  settingsTexts: [FIXTURE_SETTINGS],
}
const prompt = {
  novelId: 'novel_00000000-0000-4000-8000-000000000000' as never,
  inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'body', chars: 10 }],
  task: '{"x":1}', requirements: ['r1'],
}

describe('chapter metrics', () => {
  it('gives the fixture chapter five fixed measurements', () => {
    expect(METRICS_BLOCKING_DEFAULT).toBe(false)
    expect(countHanChars(FIXTURE_TEXT)).toBe(19)
    expect(countStoryWords(FIXTURE_TEXT)).toBe(19)
    const metrics = measureChapterMetrics(fixtureInput)
    expect(metrics).toEqual({
      wordCount: 19,
      dialogueRatio: 0.105,
      hookWindow: { chars: 300, fragments: ['他看见落石。', '远处还有雷击吗？'] },
      beatPositions: [
        { paragraph: '林澜推开门。', ratio: 0 },
        { paragraph: '他看见落石。远处还有雷击吗？', ratio: 0.517 },
      ],
      eventHits: [
        { index: 1, source: 'brief', text: '落石', keywords: ['落石'], hit: true },
        { index: 2, source: 'brief', text: '雷击', keywords: ['雷击'], hit: true },
        { index: 1, source: 'settings', text: '雾港灯塔', keywords: ['雾港灯塔'], hit: false },
      ],
    })
    expect(measureChapterMetrics(fixtureInput)).toEqual(metrics)
    expect(metrics).not.toHaveProperty('passed')
  })

  it('counts Han characters inside “” and 「」 and ignores half-width and full-width quotation marks', () => {
    const input = (text: string): ChapterMetricsInput => ({ text, previousSnapshot: null, briefText: '', settingsTexts: [] })
    expect(measureChapterMetrics(input('甲「乙，丙」丁')).dialogueRatio).toBe(0.5)
    expect(measureChapterMetrics(input('甲“乙”丁')).dialogueRatio).toBe(0.333)
    expect(measureChapterMetrics(input('甲"乙"丁')).dialogueRatio).toBe(0)
    expect(measureChapterMetrics(input('甲＂乙＂丁')).dialogueRatio).toBe(0)
    expect(measureChapterMetrics(input('hello 「甲」')).wordCount).toBe(1)
    expect(measureChapterMetrics(input('')).dialogueRatio).toBe(0)
  })

  it('splits sentences on full-width and half-width stops, and not on commas or a decimal point', () => {
    const input = (text: string): ChapterMetricsInput => ({ text, previousSnapshot: null, briefText: '', settingsTexts: [] })
    expect(measureChapterMetrics(input('甲，乙。丙,丁。')).hookWindow.fragments).toEqual([])
    expect(measureChapterMetrics(input('3.14不炸。')).hookWindow.fragments).toEqual([])
    expect(measureChapterMetrics(input('甲.乙？')).hookWindow.fragments).toEqual(['乙？'])
    expect(measureChapterMetrics(input('甲．乙?')).hookWindow.fragments).toEqual(['乙?'])
    expect(measureChapterMetrics(input('他停了……')).hookWindow.fragments).toEqual(['他停了……'])
    expect(measureChapterMetrics(input('门开了！')).hookWindow.fragments).toEqual([])
    expect(measureChapterMetrics(input('甲；乙？')).hookWindow.fragments).toEqual(['乙？'])
  })

  it('keeps an unrecovered snapshot note that the closing window still contains, and ignores one outside that window', () => {
    const carried = measureChapterMetrics({
      text: `${'叙'.repeat(HOOK_WINDOW_CHARS)}落石。`,
      previousSnapshot: { unrecoveredForeshadowing: [{ note: '落石' }, { note: '   ' }] },
      briefText: '', settingsTexts: [],
    })
    expect(carried.hookWindow.fragments).toEqual([`${'叙'.repeat(297)}落石。`])
    const early = measureChapterMetrics({
      text: `落石。${'叙'.repeat(HOOK_WINDOW_CHARS)}`,
      previousSnapshot: { unrecoveredForeshadowing: [{ note: '落石' }] },
      briefText: '', settingsTexts: [],
    })
    expect(early.hookWindow.fragments).toEqual([])
  })

  it('does not crash on an empty chapter, and a keyword miss is only a hit row', () => {
    const metrics = measureChapterMetrics({
      text: '',
      previousSnapshot: { unrecoveredForeshadowing: [{ note: '落石' }] },
      briefText: FIXTURE_BRIEF,
      settingsTexts: [''],
    })
    expect(metrics).toEqual({
      wordCount: 0,
      dialogueRatio: 0,
      hookWindow: { chars: 300, fragments: [] },
      beatPositions: [],
      eventHits: [
        { index: 1, source: 'brief', text: '落石', keywords: ['落石'], hit: false },
        { index: 2, source: 'brief', text: '雷击', keywords: ['雷击'], hit: false },
      ],
    })
  })

  it('attaches metrics only from prompt version 11', () => {
    for (const promptVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
      expect(advisoryReviewMetrics(promptVersion, fixtureInput, false), String(promptVersion)).toBeUndefined()
    }
    expect(advisoryReviewMetrics(11, null, false)).toBeUndefined()
    expect(advisoryReviewMetrics(11, fixtureInput, false)?.metricsBlocking).toBe(false)
    expect(advisoryReviewMetrics(11, fixtureInput, true)?.metrics).toEqual(measureChapterMetrics(fixtureInput))
    expect(advisoryReviewMetrics(11, fixtureInput, true)?.metricsBlocking).toBe(true)
  })

  it('adds the advisory sentence only to a version-11 body review and keeps versions 1–10 byte-identical', () => {
    const bodyReview = (promptVersion: 9 | 10 | 11) => buildStagePrompt({ ...prompt, kind: 'review', reviewedKind: 'body', promptVersion })
    expect(bodyReview(10)).toBe(bodyReview(9))
    expect(bodyReview(10)).not.toContain('task.metrics')
    expect(bodyReview(11)).toContain('task.metrics')
    expect(bodyReview(11)).toContain('metricsBlocking is the recorded host flag')
    expect(bodyReview(11)).toContain('not a pass condition')
    const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']
    for (const kind of kinds) {
      const reviewed = kind === 'review' ? { reviewedKind: 'chapter-outline' as const } : {}
      expect(buildStagePrompt({ ...prompt, kind, promptVersion: 11, ...reviewed }), kind).toBe(buildStagePrompt({ ...prompt, kind, promptVersion: 10, ...reviewed }))
      expect(JSON.stringify(nativeStageOutputSchema(kind, 11)), kind).toBe(JSON.stringify(nativeStageOutputSchema(kind, 10)))
    }
    expect(JSON.stringify(nativeStageOutputSchema('continuity-snapshot', 11))).not.toContain('name_note')
    expect(JSON.stringify(nativeStageOutputSchema('book-outline', 11))).not.toContain('targetWords')
    expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 11))).not.toContain('beatPositions')
  })
})
