/** Version 14 failure sign-off: same signature injects, a different signature does not, and two rounds stop. */
import { expect, it } from 'vitest'
import { failureSignature, nextFailureRepair, sameDefectNote, skipFailureRound } from '../src/failure-signoff.ts'
import { CURRENT_PROMPT_VERSION } from '../src/stage-prompts.ts'
import { StageOutputSchemas } from '../src/stage-output.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const brief = ['守灯人林澜在虚构雾港追查失踪船只。', '必写事件：', '1. 落石', '2. 雷击'].join('\n')
const note = sameDefectNote()

it('signs missing keywords and pov paragraphs, and ignores style, AI tone, and poison', () => {
  expect(CURRENT_PROMPT_VERSION).toBe(15)
  expect(failureSignature({ missingKeywords: ['落石', '雷击'] })).toBe('missing:落石|雷击')
  expect(failureSignature({ eventHits: [{ keywords: ['落石', '雷击'], hit: false }, { keywords: ['打中'], hit: true }] })).toBe('missing:落石|雷击')
  expect(failureSignature({ issues: [
    { category: 'pov', id: 'pov-limited', paragraphId: 'p3' },
    { category: 'pov', id: 'pov-limited', paragraphId: 'p1' },
  ] })).toBe('pov:p1|p3')
  expect(failureSignature({
    missingKeywords: ['落石', '雷击'],
    issues: [{ category: 'pov', id: 'pov-limited', paragraphId: 'p2' }],
  })).toBe('missing:落石|雷击;pov:p2')
  expect(failureSignature({ issues: [
    { category: 'style', id: 'ai-tone-1', paragraphId: 'p1', poison: 'forced' },
    { category: 'style', id: 'wording', paragraphId: 'p2' },
  ] })).toBeNull()
  expect(failureSignature({ issues: [{ category: 'pov', id: 'ai-tone-1', paragraphId: 'p1' }] })).toBeNull()
})

it('injects the first signature, stops a repeat without injecting, and does not count a poison round', () => {
  const first = nextFailureRepair(null, 'missing:落石|雷击')
  expect(first.stop).toBe(false)
  expect(first.note).toBe(note)
  const poison = skipFailureRound(first.streak)
  expect(poison).toEqual({ stop: false, streak: first.streak, note: null })
  const repeated = nextFailureRepair(poison.streak, 'missing:落石|雷击')
  expect(repeated.stop).toBe(true)
  expect(repeated.note).toBeNull()
  const changed = nextFailureRepair(first.streak, 'missing:雷击')
  expect(changed.stop).toBe(false)
  expect(changed.note).toBeNull()
  expect(nextFailureRepair(first.streak, null)).toEqual({ stop: false, streak: null, note: null })
})

function withWords(output: object, words: string): object {
  if ('changes' in output && Array.isArray(output.changes)) {
    const changes = output.changes as { op?: string; path?: string; value?: string }[]
    const mapped = changes.map(change => change.path === 'scenes[0].text' && typeof change.value === 'string' ? { ...change, value: `${change.value}${words}` } : change)
    const hasScene = mapped.some(change => change.path === 'scenes[0].text')
    return { ...output, changes: hasScene ? mapped : [...mapped, { op: 'set', path: 'scenes[0].text', value: words }] }
  }
  const body = StageOutputSchemas.body.parse(output)
  return { ...body, scenes: body.scenes.map((scene, index) => index === 0 ? { ...scene, text: `${scene.text}${words}` } : scene) }
}

it('injects the same missing signature into the next repair and does not inject a different one', async () => {
  let round = 0
  const fixture = await useWritingFixture({
    brief,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      const index = round++
      return withWords(output, index === 0 ? '' : '落石滚过。')
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.promptVersion).toBe(15)
  const first = fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/0') ?? ''
  const second = fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/1') ?? ''
  const third = fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/2') ?? ''
  expect(first).not.toContain(note)
  expect(second).toContain(note)
  expect(third).not.toContain(note)
  expect(run.attempts.find(item => item.key === 'body/1/candidate/0')?.failureSignature).toBe('missing:落石|雷击')
  expect(run.attempts.find(item => item.key === 'body/1/candidate/1')?.failureSignature).toBe('missing:雷击')
}, 180_000)

it('stops a body stage before a third round when the same signature occurs twice', async () => {
  const fixture = await useWritingFixture({
    brief,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(run.status).toBe('failed')
  expect(run.error).toContain('missing:落石|雷击')
  expect(run.error).toContain('stopped before another repair round')
  const bodies = run.attempts.map(item => item.key).filter(key => key.startsWith('body/1/candidate/') && !key.includes('/review'))
  expect(bodies).toEqual(['body/1/candidate/0', 'body/1/candidate/1'])
  expect(run.attempts.some(item => item.key.startsWith('body/1/candidate/2'))).toBe(false)
  expect(run.attempts.find(item => item.key === 'body/1/candidate/0')?.failureSignature).toBe('missing:落石|雷击')
  expect(run.attempts.find(item => item.key === 'body/1/candidate/1')?.failureSignature).toBe('missing:落石|雷击')
  const second = fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/1') ?? ''
  expect(second).toContain(note)
}, 180_000)

it('completes a clean body when the only miss is a metric eventHits row', async () => {
  const plain = '守灯人林澜在虚构雾港追查失踪船只。请完成三章故事，每章三千至五千字。'
  const fixture = await useWritingFixture({
    brief: plain,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'settings' || (stage.task?.batch !== 'draft' && stage.task?.batch !== 'repair')) return output
      const batch = output as { dimensions: { code: string; body: string }[] }
      return { ...batch, dimensions: batch.dimensions.map(item => item.code === 'a1' ? { ...item, body: '必写事件：\n1. 落石\n2. 雷击' } : item) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(plain).not.toContain('落石')
  expect(run.status).toBe('completed')
  const bodies = run.attempts.filter(item => item.key.startsWith('body/1/candidate/') && !item.key.includes('/review'))
  expect(bodies.map(item => item.key)).toEqual(['body/1/candidate/0'])
  expect(bodies.every(item => item.failureSignature === undefined)).toBe(true)
  expect(fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/0') ?? '').not.toContain(note)
  expect(fixture.runs.storedPrompt(fixture.actor, run.id, 'body/1/candidate/1') ?? '').not.toContain(note)
}, 180_000)

it('adds a metric eventHits miss to the signature of a round that already failed', async () => {
  const requiredOnly = ['守灯人林澜在虚构雾港追查失踪船只。', '必写事件：', '1. 落石'].join('\n')
  const fixture = await useWritingFixture({
    brief: requiredOnly,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind !== 'settings' || (stage.task?.batch !== 'draft' && stage.task?.batch !== 'repair')) return output
      const batch = output as { dimensions: { code: string; body: string }[] }
      return { ...batch, dimensions: batch.dimensions.map(item => item.code === 'a1' ? { ...item, body: '必写事件：\n1. 雷击' } : item) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(requiredOnly).not.toContain('雷击')
  expect(run.attempts.find(item => item.key === 'body/1/candidate/0')?.failureSignature).toBe('missing:落石|雷击')
}, 180_000)

it('completes a length repair when the only repeated miss is a settings eventHits row', async () => {
  const plain = '守灯人林澜在虚构雾港追查失踪船只。请完成三章故事，每章三千至五千字。'
  let bodyRound = 0
  const fixture = await useWritingFixture({
    brief: plain,
    executionLimits: { researchEnabled: false, maxRepairAttempts: 1, metricsBlocking: false },
    intervene(stage: WritingFixtureStage, output: object) {
      if (stage.kind === 'settings' && (stage.task?.batch === 'draft' || stage.task?.batch === 'repair')) {
        const batch = output as { dimensions: { code: string; body: string }[] }
        return { ...batch, dimensions: batch.dimensions.map(item => item.code === 'a1' ? { ...item, body: '必写事件：\n1. 雷击' } : item) }
      }
      if (stage.kind !== 'body' || stage.task?.chapterNumber !== 1) return output
      const words = bodyRound++ < 2 ? 5200 : 4000
      const text = '光'.repeat(words)
      if ('changes' in output && Array.isArray(output.changes)) {
        const changes = output.changes as { path?: string; value?: string }[]
        return { ...output, changes: changes.map(change => typeof change.path === 'string' && change.path.endsWith('.text') ? { ...change, value: text } : change) }
      }
      const body = StageOutputSchemas.body.parse(output)
      return { ...body, scenes: body.scenes.map(scene => ({ ...scene, text })) }
    },
  })
  const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, chapterCount: 1, throughChapter: 1 }))
  if (outcome.status === 'rejected') throw outcome.reason
  const run = outcome.value
  expect(plain).not.toContain('雷击')
  expect(run.status).toBe('completed')
  const bodies = run.attempts.filter(item => item.key.startsWith('body/1/candidate/') && !item.key.includes('/review'))
  expect(bodies.map(item => item.key)).toEqual(['body/1/candidate/0', 'body/1/candidate/1', 'body/1/candidate/2'])
  expect(bodies.every(item => item.failureSignature === undefined)).toBe(true)
  for (const key of bodies.map(item => item.key)) expect(fixture.runs.storedPrompt(fixture.actor, run.id, key) ?? '').not.toContain(note)
}, 180_000)
