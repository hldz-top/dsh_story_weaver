import { describe, expect, it } from 'vitest'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const reviewedKind = (stage: WritingFixtureStage) => stage.task?.reviewed ? stage.sources.get(stage.task.reviewed.artifactId)?.kind : undefined

/** Quote reattribution is the citation style of prompt versions before 7. Version 7 cites paragraph ids instead. */
async function resumeVersion6(fixture: Awaited<ReturnType<typeof useWritingFixture>>, throughChapter: number) {
  const begun = await fixture.runs.begin(fixture.actor, { ...fixture.input, throughChapter, revision: null,
    executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 6)
  await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stored on prompt version 6.')
  return fixture.run(exec => fixture.runner.resume(exec, begun.id, false))
}

/** Version 6 still copies quotes. A settings/0/ attempt keeps that resume on the per-dimension path, where those reviews still run. */
async function resumeVersion6PerDimension(fixture: Awaited<ReturnType<typeof useWritingFixture>>, throughChapter: number) {
  const begun = await fixture.runs.begin(fixture.actor, { ...fixture.input, throughChapter, revision: null,
    executionLimits: fixture.runner.limits, serviceLimits: { ...fixture.service.limits, ...fixture.service.researchLimits } }, 6)
  const attempt = await fixture.runs.prepareAttempt(fixture.actor, begun.id, {
    key: 'settings/0/seed', prompt: 'Already-started per-dimension settings path.',
    inputRefs: [{ artifactId: fixture.novel.brief.id, sha256: fixture.novel.brief.sha256 }],
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })
  await fixture.runs.associateChild(fixture.actor, begun.id, attempt.id, fixture.parent.session.id)
  await fixture.runs.saveOutput(fixture.actor, begun.id, attempt.id, '{}')
  await fixture.runs.finish(fixture.actor, begun.id, 'stopped', 'Stored on prompt version 6.')
  return fixture.run(exec => fixture.runner.resume(exec, begun.id, false))
}

/**
 * A correct, verbatim quote of the reviewed candidate labeled with another admitted input's id must be
 * reattributed by the host for every review stage, without spending a repair: with maxRepairAttempts 0
 * any rejection would fail the run.
 */
describe('mislabeled review quote source is reattributed in every review stage', () => {
  // In the fixture the settings and chapter-outline candidates open with a line also present in another input (brief / book outline),
  // so those two are the ambiguous case below; every other review kind has a unique quote.
  it.each(['book-outline', 'body', 'continuity'] as const)('%s review', async kind => {
    let target: { reviewed: string, declared: string, quote: string } | undefined
    const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 0 }, intervene(stage, output) {
      if (stage.kind !== 'review' || target || reviewedKind(stage) !== kind) return output
      const review = StageOutputSchemas.review.parse(output)
      const [check, ...rest] = review.checks
      const evidence = check!.evidence[0]!
      const other = [...stage.sources.values()].find(source => source.artifactId !== evidence.artifactId && !source.text.includes(evidence.quote))!
      expect([...stage.sources.values()].filter(source => source.text.includes(evidence.quote)).map(source => source.artifactId)).toEqual([evidence.artifactId])
      target = { reviewed: evidence.artifactId, declared: other.artifactId, quote: evidence.quote }
      return { ...review, checks: [{ ...check!, evidence: [{ ...evidence, artifactId: other.artifactId }, ...check!.evidence.slice(1)] }, ...rest] }
    } })
    const outcome = await resumeVersion6(fixture, 1)
    if (outcome.status === 'rejected') throw outcome.reason
    expect(target, `no ${kind} review ran`).toBeDefined()
    expect(outcome.value.error).toBeNull()
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.attempts.filter(item => /\/review\/[1-9]|\/citations$/.test(item.key)).map(item => item.key)).toEqual([])
    const events = outcome.value.attempts.flatMap(item => item.evidenceEvents ?? [])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'reattributed', distance: 0, declared: { artifactId: target!.declared, quote: target!.quote },
      admitted: expect.arrayContaining([{ artifactId: target!.reviewed, quote: target!.quote }]) }))
  })

  it('reproduces live run run_0f27a3ae: an a2-style settings review quotes the dimension candidate but labels it as the research evidence', async () => {
    // Live: 「灾难生存不单列为主标签」 is verbatim in the a2 candidate (fact a2_f6) and cited as research-evidence artifact_ea6722c9,
    // which only says 「建议不单列为独立主标签…」; three reviews were rejected and maxRepairAttempts=2 was exhausted.
    const QUOTE = '灾难生存不单列为主标签'
    let ids: { candidate: string, research: string } | undefined
    const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 0 }, intervene(stage, output) {
      if (stage.kind === 'settings' && reviewedKind(stage) === undefined && 'facts' in output && !JSON.stringify(output).includes(QUOTE)) {
        const settings = StageOutputSchemas.settings.parse(output)
        return { ...settings, facts: [...settings.facts, { id: `${settings.facts[0]!.id}-f6`, statement: `${QUOTE}，仅作为辅助标签出现。` }] }
      }
      if (stage.kind !== 'review' || ids || reviewedKind(stage) !== 'settings-dimension') return output
      const candidate = stage.task!.reviewed!.artifactId
      const research = [...stage.sources.values()].find(source => source.kind === 'research-evidence')!
      expect(stage.sources.get(candidate)!.text).toContain(QUOTE)
      expect(research.text).not.toContain(QUOTE)
      ids = { candidate, research: research.artifactId }
      const review = StageOutputSchemas.review.parse(output)
      const [check, ...rest] = review.checks
      return { ...review, checks: [{ ...check!, evidence: [{ artifactId: research.artifactId, quote: QUOTE }] }, ...rest] }
    } })
    const outcome = await resumeVersion6PerDimension(fixture, 1)
    if (outcome.status === 'rejected') throw outcome.reason
    expect(ids).toBeDefined()
    expect(outcome.value.error).toBeNull()
    expect(outcome.value.status).toBe('completed')
    const review = outcome.value.attempts.find(item => /^settings\/0\/a1\/candidate\/0\/review\/0$/.test(item.key))!
    expect(outcome.value.attempts.some(item => /^settings\/0\/a1\/candidate\/0\/review\/(?:[1-9]|0\/citations)/.test(item.key))).toBe(false)
    expect(review.evidenceEvents).toEqual([expect.objectContaining({ kind: 'reattributed', location: 'checks[0]', distance: 0,
      declared: { artifactId: ids!.research, quote: QUOTE }, admitted: [{ artifactId: ids!.candidate, quote: QUOTE }] })])
    // The stored review cites the candidate, where the quote actually is.
    const a1 = fixture.service.getSettings(fixture.actor, fixture.input.novelId).history.find(item => item.dimensionCode === 'a1' && item.review !== null)!
    const saved = StageOutputSchemas.review.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.input.novelId, artifactId: a1.review!.id }).text))
    expect(saved.checks[0]!.evidence).toEqual([{ artifactId: ids!.candidate, quote: QUOTE }])
  })

  it.each(['settings', 'chapter-outline'] as const)('%s review: a quote found in several inputs is never guessed; the rejection lists every match and only that citation is repaired', async kind => {
    let target: { matches: string[], declared: string } | undefined
    const fixture = await useWritingFixture({ intervene(stage, output) {
      if (stage.kind !== 'review' || target || reviewedKind(stage) !== kind) return output
      const review = StageOutputSchemas.review.parse(output)
      const [check, ...rest] = review.checks
      const evidence = check!.evidence[0]!
      const matches = [...stage.sources.values()].filter(source => source.text.includes(evidence.quote)).map(source => source.artifactId)
      expect(matches.length).toBeGreaterThan(1)
      const other = [...stage.sources.values()].find(source => !source.text.includes(evidence.quote))!
      target = { matches, declared: other.artifactId }
      return { ...review, checks: [{ ...check!, evidence: [{ ...evidence, artifactId: other.artifactId }, ...check!.evidence.slice(1)] }, ...rest] }
    } })
    const outcome = kind === 'settings' ? await resumeVersion6PerDimension(fixture, 1) : await resumeVersion6(fixture, 1)
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.error).toBeNull()
    expect(outcome.value.status).toBe('completed')
    const repairs = outcome.value.attempts.filter(item => /\/review\/[1-9]/.test(item.key))
    expect(repairs.map(item => item.key)).toEqual([expect.stringMatching(/\/review\/1\/citations$/)])
    const repairStage = [...fixture.stages.values()].find(stage => stage.kind === 'review-citation-repair')!
    expect(repairStage.data.kind === 'review-citation-repair' && repairStage.data.items.map(item => item.location)).toEqual(['checks[0]'])
    const listed = repairStage.data.kind === 'review-citation-repair' ? JSON.stringify(repairStage.data) : ''
    for (const id of target!.matches) expect(listed).toContain(id)
    expect(listed).toContain('several admitted inputs')
  })
})

describe('drop and downgrade apply in every review stage, with recorded events and no repair spent', () => {
  it.each(['book-outline', 'chapter-outline', 'body', 'continuity'] as const)('%s review', async kind => {
    const INVENTED = '这句话从未出现在任何输入中。'
    let injected = false
    const fixture = await useWritingFixture({ executionLimits: { maxRepairAttempts: 0 }, intervene(stage, output) {
      if (stage.kind !== 'review' || injected || reviewedKind(stage) !== kind) return output
      injected = true
      const review = StageOutputSchemas.review.parse(output)
      const [check, ...rest] = review.checks
      const evidence = check!.evidence[0]!
      return { ...review,
        checks: [{ ...check!, evidence: [...check!.evidence, { artifactId: evidence.artifactId, quote: INVENTED }] }, ...rest],
        issues: [...review.issues, { id: 'qa-invented', severity: 'blocking', category: check!.category, location: '全篇', message: '引文无法核对的阻断问题。', evidence: [{ artifactId: evidence.artifactId, quote: INVENTED }] }] }
    } })
    const outcome = await resumeVersion6(fixture, 1)
    if (outcome.status === 'rejected') throw outcome.reason
    expect(injected).toBe(true)
    expect(outcome.value.error).toBeNull()
    expect(outcome.value.status).toBe('completed')
    const events = outcome.value.attempts.flatMap(item => item.evidenceEvents ?? [])
    expect(events.map(event => [event.kind, event.location])).toEqual(expect.arrayContaining([['dropped', 'checks[0]'], ['downgraded', expect.stringMatching(/^issues\[\d+\]$/)]]))
    expect(events.find(event => event.kind === 'downgraded')?.reason).toMatch(/^blocking \S+ issue "qa-invented" made advisory: /)
  })
})

describe('host-repaired evidence in a generated manuscript candidate stays verifiable', () => {
  it('a continuity candidate whose quote is reattributed is stored with a receipt over the admitted output, so the manuscript reads back (live run run_dbabf085)', async () => {
    let target: { declared: string, quote: string } | undefined
    const fixture = await useWritingFixture({ intervene(stage, output) {
      if (stage.kind !== 'continuity' || target) return output
      const continuity = StageOutputSchemas.continuity.parse(output)
      const [entry, ...rest] = continuity.timeline
      const evidence = entry!.evidence[0]!
      const other = [...stage.sources.values()].find(source => source.artifactId !== evidence.artifactId && !source.text.includes(evidence.quote))!
      target = { declared: other.artifactId, quote: evidence.quote }
      return { ...continuity, timeline: [{ ...entry!, evidence: [{ ...evidence, artifactId: other.artifactId }, ...entry!.evidence.slice(1)] }, ...rest] }
    } })
    const outcome = await resumeVersion6(fixture, 1)
    if (outcome.status === 'rejected') throw outcome.reason
    expect(target).toBeDefined()
    expect(outcome.value.error).toBeNull()
    expect(outcome.value.status).toBe('completed')
    const manuscript = fixture.service.getManuscript(fixture.actor, fixture.input.novelId)
    const continuity = manuscript.history.filter(item => item.target.kind === 'continuity')
    expect(continuity.length).toBeGreaterThan(0)
    const stored = StageOutputSchemas.continuity.parse(JSON.parse(fixture.service.getArtifact(fixture.actor, { novelId: fixture.input.novelId, artifactId: continuity[0]!.artifact.id }).text))
    expect(stored.timeline[0]!.evidence[0]!.artifactId).not.toBe(target!.declared)
    expect(stored.timeline[0]!.evidence[0]!.quote).toBe(target!.quote)
  })
})
