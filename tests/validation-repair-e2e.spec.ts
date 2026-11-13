/**
 * Offline end-to-end proof for the unified output-validation repair loop.
 *
 * The fake stage provider runs the complete 49-stage pipeline of the live prompt (settings roots a4, a5 and e1, which plan
 * a1, a2, a3, a4, a5 and e1; one settings-collection review; the book outline; three chapters of outline, body and
 * continuity, each with research and review). One violation of every kind is injected into the first attempt of at least
 * one stage of every stage kind (tests/support/validation-injections.ts). With maxRepairAttempts 1 each is repaired by
 * exactly one replacement and the run completes; the validation-repair-zero-*.spec.ts files show that with
 * maxRepairAttempts 0 each fails the run with its specific message.
 */
import { describe, expect, it } from 'vitest'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { injections, isChapterStage, next, pipeline, PIPELINE_STAGES, stageKeys, type Injection } from './support/validation-injections.ts'

describe('unified validation repair across the full 49-stage pipeline (offline fake provider)', () => {
  it('repairs every injected violation, one per kind across every stage kind, with a single replacement each, and completes', async () => {
    const combined = injections.filter(item => item.solo !== true)
    const { fixture, run, fired } = await pipeline(1, combined)
    expect(run.error, JSON.stringify(run.attempts.filter(item => item.error !== null).map(({ key, error }) => ({ key, error })))).toBeNull()
    expect(run.status).toBe('completed')
    expect([...fired.keys()].sort()).toEqual(combined.map(item => item.id).sort())
    expect(new Set(combined.map(item => item.stage))).toEqual(new Set(['research planning', 'research', 'settings candidate', 'settings review', 'full-settings review',
      'book outline', 'book outline review', 'chapter outline', 'chapter outline review', 'body', 'body review', 'continuity', 'continuity review']))
    const keys = run.attempts.map(attempt => attempt.key)
    const report: string[] = []
    const replacements = new Set<string>()
    for (const injection of combined) {
      const stage = fired.get(injection.id)!
      const attempt = run.attempts.find(item => item.childSessionId === stage.sessionId)
      expect(attempt, injection.id).toBeDefined()
      const replacement = injection.replacement(attempt!.key)
      const replaced = run.attempts.filter(item => item.key === replacement && item.childSessionId !== stage.sessionId)
      expect(replaced, `${injection.id}: ${attempt!.key} -> ${replacement}`).toHaveLength(1)
      expect(replaced[0]!.status).toBe('succeeded')
      // Exactly one replacement: no second repair key exists.
      expect(keys.includes(next(replacement)) && replacement !== attempt!.key, injection.id).toBe(false)
      if (replacement !== attempt!.key) replacements.add(replacement)
      report.push(`${injection.stage} | ${injection.violation} | ${attempt!.key} -> ${replacement}`)
    }
    // The live prompt plans exactly 49 stages; replacements only add attempt indices (candidate/n, review/n, research repair/n) to those stages.
    const logical = new Set(stageKeys(run.attempts).map(key => key.replace(/\/repair\/\d+$/u, '').replace(/\/citations$/u, '').replace(/\/(candidate|review)\/\d+/gu, '/$1')))
    expect([...logical], JSON.stringify([...logical])).toHaveLength(PIPELINE_STAGES)
    expect(replacements.size).toBe(combined.filter(item => item.finish === undefined).length)
    const manuscript = fixture.service.getManuscript(fixture.actor, fixture.novel.id)
    expect(manuscript.appliedChapters.map(chapter => chapter.chapterNumber)).toEqual([1, 2, 3])
    expect(fixture.service.getSettings(fixture.actor, fixture.novel.id).applied.map(item => item.dimensionCode).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'e1'])
    // Repair prompts carry the specific rejection; first-attempt candidate/review prompts carry none.
    for (const stage of fixture.stages.values()) {
      if (stage.task === null) continue
      const message = stage.task.validationError ?? null
      if (message !== null) expect(message.length).toBeGreaterThan(20)
    }
    if (process.env.DSH_E2E_REPORT === '1') console.log(`repaired ${combined.length} injections; ${stageKeys(run.attempts).length} stage keys (49 + replacements)\n${report.join('\n')}`)
  }, 600_000)


  it.each(injections.filter(item => item.solo === true).map(item => [item.id, item] as const))('repairs the business-repair injection %s with one replacement and completes', async (_id, injection) => {
    const { run, fired } = await pipeline(1, [injection], Math.max(1, injection.chapter))
    expect(run.error).toBeNull()
    expect(run.status).toBe('completed')
    const stage = fired.get(injection.id)!
    const attempt = run.attempts.find(item => item.childSessionId === stage.sessionId)!
    expect(run.attempts.filter(item => item.key === injection.replacement(attempt.key) && item.status === 'succeeded')).toHaveLength(1)
  }, 300_000)

  it('lets the native structured_output schema reject a missing field in-turn, before host admission and without a repair attempt', async () => {
    const missing: Injection = { id: 'review-missing-field', stage: 'settings review', violation: 'native schema (missing issues)', chapter: 1,
      match: stage => stage.kind === 'review' && [...stage.sources.values()].some(source => source.kind === 'settings-dimension'),
      mutate: ({ issues: _issues, ...output }) => output, replacement: next, message: /./ }
    const { run, fired } = await pipeline(0, [missing], 1)
    expect(run.error).toBeNull()
    expect(run.status).toBe('completed')
    expect(fired.get(missing.id)!.nativeRejections).toBe(1)
    expect(run.attempts.some(item => item.key === 'settings/0/a1/candidate/1')).toBe(false)
  }, 300_000)

  it('keeps truncation (finish_reason length) fatal even with a repair budget', async () => {
    const truncate: Injection = { id: 'body-truncated', stage: 'body', violation: 'truncation', chapter: 1, match: stage => isChapterStage(stage, 'body', 1),
      finish: { kind: 'max-tokens' } as FinishReason, replacement: next, message: /trunc/i }
    const { run } = await pipeline(1, [truncate], 1)
    expect(run.status).toBe('failed')
    expect(run.attempts.some(item => item.key === 'body/1/candidate/1')).toBe(false)
    expect(run.attempts.filter(item => item.key === 'body/1/candidate/0')).toHaveLength(1)
  }, 300_000)
})
