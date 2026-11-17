/** A repeated hookType repairs inside the outline budget. An opening miss on a clean chapter is only an advisory. */
import { expect, it } from 'vitest'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

it('fails a repeated hookType and accepts the repair inside the outline budget', async () => {
  let chapterTwo = 0
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'chapter-outline') return output
      const chapter = stage.task?.chapterNumber
      if (chapter === 1) return { ...output, hookType: 'suspense' }
      if (chapter !== 2) return output
      chapterTwo += 1
      if ('changes' in output && Array.isArray(output.changes)) {
        return { ...output, changes: [...output.changes, { op: 'set', path: 'hookType', value: 'danger' }] }
      }
      return { ...output, hookType: chapterTwo === 1 ? 'suspense' : 'danger' }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 2, throughChapter: 2 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  expect(run.promptVersion).toBe(15)
  const outlines = run.attempts.filter(item => item.key.startsWith('chapter-outline/2/candidate/') && !item.key.includes('/review'))
  expect(outlines.map(item => item.key)).toEqual(['chapter-outline/2/candidate/0', 'chapter-outline/2/candidate/1'])
  expect(outlines.every(item => item.failureSignature === undefined)).toBe(true)
  const repair = fixture.runs.storedPrompt(fixture.actor, run.id, 'chapter-outline/2/candidate/1') ?? ''
  expect(repair).toContain('repeats the previous chapter')
}, 180_000)

it('stops a repeated hookType inside the outline budget and does not sign it', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, maxParallelStages: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'chapter-outline') return output
      if ('changes' in output) return output
      return { ...output, hookType: 'suspense' }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 2, throughChapter: 2 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('failed')
  expect(run.error).toContain('Repair limit was exhausted')
  const outlines = run.attempts.filter(item => item.key.startsWith('chapter-outline/2/candidate/') && !item.key.includes('/review'))
  expect(outlines.map(item => item.key)).toEqual(['chapter-outline/2/candidate/0', 'chapter-outline/2/candidate/1'])
  expect(run.attempts.some(item => item.key.startsWith('chapter-outline/2/candidate/2'))).toBe(false)
  expect(outlines.every(item => item.failureSignature === undefined)).toBe(true)
}, 180_000)

const scenery = '阳光明媚，海风很轻，水面平静，远山含黛。'

function spoilOpening(text: string): string {
  const lead = scenery.repeat(3)
  return `${lead}${text.slice(lead.length)}`
}

function spoilBody(output: object): object {
  if ('changes' in output && Array.isArray(output.changes)) {
    return {
      ...output,
      changes: output.changes.map(change => {
        if (typeof change !== 'object' || change === null || !('value' in change) || typeof change.value !== 'string') return change
        return { ...change, value: spoilOpening(change.value) }
      }),
    }
  }
  const body = output as { scenes?: { text: string }[] }
  if (body.scenes === undefined) return output
  return { ...body, scenes: body.scenes.map((scene, index) => index === 0 ? { ...scene, text: spoilOpening(scene.text) } : scene) }
}

it('completes an otherwise clean chapter 1 at round 0 when the opening misses', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      return spoilBody(output)
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  expect(run.error).toBeNull()
  const bodies = run.attempts.filter(item => item.key.startsWith('body/1/candidate/') && !item.key.includes('/review'))
  expect(bodies.map(item => item.key)).toEqual(['body/1/candidate/0'])
  expect(bodies.every(item => item.failureSignature === undefined)).toBe(true)
  const continuity = fixture.runs.storedPrompt(fixture.actor, run.id, 'continuity/1/candidate/0') ?? ''
  expect(continuity).toContain('Advisory openingIn50')
  expect(continuity).toContain('accepted chapter is kept')
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters
  expect(applied).toHaveLength(1)
}, 180_000)

it('completes chapter 1 when an opening-only repair patch would not apply', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      if ('changes' in output) return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
      return spoilBody(output)
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  expect(run.attempts.some(item => item.key.startsWith('body/1/candidate/1'))).toBe(false)
  expect(run.attempts.some(item => item.failureSignature !== undefined)).toBe(false)
  const continuity = fixture.runs.storedPrompt(fixture.actor, run.id, 'continuity/1/candidate/0') ?? ''
  expect(continuity).toContain('Advisory openingIn50')
  expect(fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters).toHaveLength(1)
}, 180_000)

it('completes chapter 1 when an opening-only repair would overflow the length limit', async () => {
  const fixture = await useWritingFixture({
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      if ('changes' in output) {
        return { version: 1, changes: [{ op: 'set', path: 'scenes[0].text', value: '光'.repeat(5608) }] }
      }
      return spoilBody(output)
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('completed')
  expect(run.attempts.some(item => item.key.startsWith('body/1/candidate/1'))).toBe(false)
  const applied = fixture.service.getManuscript(fixture.actor, fixture.novel.id).appliedChapters[0]
  expect(applied).toBeDefined()
  expect(applied!.wordCount).toBeLessThan(5608)
  const continuity = fixture.runs.storedPrompt(fixture.actor, run.id, 'continuity/1/candidate/0') ?? ''
  expect(continuity).toContain('Advisory openingIn50')
}, 180_000)

it('keeps a repair that is already required on the same outcome when the opening also misses', async () => {
  const runOnce = async (openingIn50: boolean) => {
    const fixture = await useWritingFixture({
      openingIn50,
      executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
      intervene(stage: WritingFixtureStage, output: object) {
        if (stage.kind === 'review' && stage.task?.reviewed !== undefined) {
          const paragraphId = stage.task.paragraphs?.[0]?.id
          const reviewedKind = stage.sources.get(stage.task.reviewed.artifactId)?.kind
          if (reviewedKind === 'body' && paragraphId !== undefined && (stage.task.validationError ?? null) === null) {
            return {
              ...output,
              issues: [{
                id: 'body-conflict', severity: 'blocking', category: 'consistency', location: 'opening',
                message: '只改被点名的段落，使它与已采纳的设定一致。',
                evidence: [{ paragraphId, problem: '这一段与已采纳的设定矛盾。' }],
              }],
            }
          }
        }
        if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
        if ('changes' in output) return { version: 1, changes: [{ op: 'set', path: 'no-such-field', value: '改' }] }
        return spoilBody(output)
      },
    })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    const repair = [...fixture.stages.values()].find(stage => stage.kind === 'body' && stage.task?.validationError != null)
    return { status: outcome.value.status, error: outcome.value.error, repair: repair?.task?.validationError ?? '' }
  }
  const withOpening = await runOnce(true)
  const withoutOpening = await runOnce(false)
  expect(withOpening.status).toBe(withoutOpening.status)
  expect(withOpening.status).toBe('failed')
  expect(withOpening.error).toContain('Repair limit was exhausted')
  expect(withoutOpening.error).toContain('Repair limit was exhausted')
  expect(withOpening.repair).toContain('openingIn50')
  expect(withoutOpening.repair).not.toContain('openingIn50')
}, 180_000)
