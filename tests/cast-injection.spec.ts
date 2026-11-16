/** Body-task cast cards: the injected names match the outline, and a long card list is trimmed. */
import { describe, expect, it } from 'vitest'
import { type CharacterSheet } from '../src/character-sheet.ts'
import { buildCastInjection, CAST_CARDS_OMITTED, castTaskFields, countHan, DEFAULT_MAX_CAST_CARD_CHARS, MAX_CAST_TELL_HAN, mergeCharacterSheets, type SceneCastScene } from '../src/scene-cast.ts'
import { buildStagePrompt } from '../src/stage-prompts.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const promptBase = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], requirements: ['r1'] }

function person(name: string, syntax = '短句，4-12 字'): CharacterSheet {
  return {
    core: [{ name, role: '配角', want: '证明自己', fear: '被无视', flaw: '逞强', misread: name === '云望舒' ? '利益' : '礼法', contrast: '嘴上不服', chapters: [1] }],
    voice: [{ name, syntax, lexicon: ['甲', '乙', '丙'], addressForProtagonist: name === '云望舒' ? '稳长老' : '前辈', selfReference: name === '云望舒' ? '本座' : '我', mannerism: name === '云望舒' ? '指尖点账页' : '按剑', forbidden: name === '云望舒' ? '为高人惊叹' : '当众示弱' }],
  }
}

function sheetOf(names: readonly string[], syntax?: string): CharacterSheet {
  const merged = mergeCharacterSheets(names.map(name => person(name, syntax)))
  if (merged === null) throw new Error('sheet')
  return merged
}

const longSyntax = '长句'.repeat(80)

describe('cast injection', () => {
  it('injects exactly the cast union that has a card, and no one else', () => {
    const scenes: SceneCastScene[] = [
      { id: 's1', cast: ['云望舒', '路人甲'], pov: '云望舒', misread: '利益' },
      { id: 's2', cast: ['苏清鸢', '云望舒'], pov: '苏清鸢', misread: '礼法' },
    ]
    const sheet = sheetOf(['云望舒', '苏清鸢', '章外闲人'])
    const injection = buildCastInjection(scenes, { sheet })
    expect(injection.castCards.map(card => card.name).sort()).toEqual(['云望舒', '苏清鸢'])
    expect(injection.uncastNames).toEqual(['路人甲'])
    expect(injection.misreadMap).toEqual([{ sceneId: 's1', frame: '利益' }, { sceneId: 's2', frame: '礼法' }])
    expect(injection.omittedMarker).toBeUndefined()
    const yun = injection.castCards.find(card => card.name === '云望舒')
    expect(yun?.tell).toBe('云望舒｜利益｜称他"稳长老"，自称"本座"｜短句，4-12 字｜指尖点账页｜禁：为高人惊叹')
    const task = { chapterNumber: 1, ...castTaskFields(injection) }
    const prompt = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11, task: JSON.stringify(task) })
    expect(prompt).toContain('云望舒')
    expect(prompt).toContain('苏清鸢')
    expect(prompt).toContain('路人甲')
    expect(prompt).not.toContain('章外闲人')
    const plain = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11, task: JSON.stringify({ chapterNumber: 1 }) })
    const delta = countHan(prompt) - countHan(plain)
    expect(delta).toBe(63)
    expect(delta).toBeLessThan(1500)
    expect(injection.castCards.every(card => countHan(card.tell) <= MAX_CAST_TELL_HAN)).toBe(true)
  })

  it('trims to the viewpoints plus the four most frequent names and marks the omission', () => {
    const scenes: SceneCastScene[] = [
      { id: 's1', cast: ['甲', '乙', '丙'], pov: '甲', misread: '利益' },
      { id: 's2', cast: ['乙', '丙', '丁'], pov: '乙', misread: '礼法' },
      { id: 's3', cast: ['丙', '丁', '戊'], pov: '丙', misread: '逻辑' },
      { id: 's4', cast: ['丁', '戊', '己'], misread: '技艺' },
      { id: 's5', cast: ['戊', '己', '庚'], misread: '生计' },
      { id: 's6', cast: ['己', '庚', '辛'], pov: '辛', misread: '其它' },
    ]
    const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '章外闲人']
    const sheet = sheetOf(names, longSyntax)
    const full = buildCastInjection(scenes, { sheet, maxCastCardChars: DEFAULT_MAX_CAST_CARD_CHARS })
    expect(full.castCards.map(card => card.name).sort()).toEqual(['丁', '丙', '己', '庚', '甲', '戊', '乙', '辛'].sort())
    expect(full.omittedMarker).toBeUndefined()
    expect(full.castCards.every(card => countHan(card.tell) <= MAX_CAST_TELL_HAN)).toBe(true)
    expect(full.castCards.every(card => card.tell.endsWith('…'))).toBe(true)
    const fullPrompt = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11, task: JSON.stringify({ chapterNumber: 1, ...castTaskFields(full) }) })
    const fullPlain = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11, task: JSON.stringify({ chapterNumber: 1 }) })
    expect(countHan(fullPrompt) - countHan(fullPlain)).toBe(980)
    expect(countHan(fullPrompt) - countHan(fullPlain)).toBeLessThan(1500)
    const trimmed = buildCastInjection(scenes, { sheet, maxCastCardChars: 400 })
    expect(trimmed.castCards.map(card => card.name)).toEqual(['甲', '乙', '丙', '辛', '丁', '戊', '己'])
    expect(trimmed.castCards.map(card => card.name)).not.toContain('庚')
    expect(trimmed.castCards.map(card => card.name)).not.toContain('章外闲人')
    expect(trimmed.omittedMarker).toBe(CAST_CARDS_OMITTED)
    const task = castTaskFields(trimmed)
    expect(task.castCardsOmitted).toBe(CAST_CARDS_OMITTED)
    const prompt = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11, task: JSON.stringify({ chapterNumber: 1, ...task }) })
    const plain = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11, task: JSON.stringify({ chapterNumber: 1 }) })
    expect(prompt).toContain(CAST_CARDS_OMITTED)
    expect(prompt).not.toContain('章外闲人')
    expect(countHan(prompt) - countHan(plain)).toBe(867)
    expect(countHan(prompt) - countHan(plain)).toBeLessThan(1500)
  })

  it('adds nothing when injection is off or the card is missing', () => {
    const scenes: SceneCastScene[] = [{ id: 's1', cast: ['云望舒'], pov: '云望舒', misread: '利益' }]
    const sheet = sheetOf(['云望舒'])
    expect(castTaskFields(buildCastInjection(scenes, { sheet, castInjection: false }))).toEqual({})
    expect(castTaskFields(buildCastInjection(scenes, { sheet: null }))).toEqual({})
    expect(buildCastInjection(scenes, { sheet: null }).uncastNames).toEqual([])
  })
})

const coreHead = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |'
const voiceHead = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |'
function markdown(names: readonly string[]): string {
  const cores = names.map(name => `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | 利益 | 嘴上不服 | 1 |`)
  const voices = names.map(name => `| ${name} | 短句，4-12 字 | 不服、试探、剑 | 前辈 | 我 | 按剑 | 当众示弱 |`)
  return [coreHead, ...cores, '', voiceHead, ...voices].join('\n')
}
const voiceOnly = `${voiceHead}\n| 苏清鸢 | 短句，4-12 字 | 不服、试探、剑 | 前辈 | 我 | 按剑 | 当众示弱 |`

function withE5(stage: WritingFixtureStage, output: object, body: string): object {
  if (stage.kind !== 'settings' || (stage.task?.batch !== 'draft' && stage.task?.batch !== 'repair')) return output
  const batch = output as { dimensions?: { code: string; body: string }[] }
  if (!Array.isArray(batch.dimensions)) return output
  return { ...batch, dimensions: batch.dimensions.map(item => item.code === 'e5' ? { code: item.code, body } : item) }
}

function bodyTask(stage: WritingFixtureStage | undefined): { castCards?: { name: string }[]; uncastNames?: string[]; misreadMap?: { frame: string }[]; castCardsOmitted?: string } {
  const prompt = stage?.prompt ?? ''
  const marker = '\n\nTASK_DATA\n\n'
  const at = prompt.indexOf(marker)
  if (at < 0) return {}
  const body = prompt.slice(at + marker.length)
  const hosted = body.indexOf('\n\nHOST_INPUTS\n\n')
  const data = JSON.parse(hosted < 0 ? body : body.slice(0, hosted)) as { task?: string }
  return JSON.parse(data.task ?? '{}') as { castCards?: { name: string }[]; uncastNames?: string[]; misreadMap?: { frame: string }[]; castCardsOmitted?: string }
}

function withSceneCast(output: object, cast: readonly string[]): object {
  const plan = output as { scenes?: object[] }
  if (!Array.isArray(plan.scenes)) return output
  return { ...plan, scenes: plan.scenes.map(scene => ({ ...scene, cast, pov: cast[0], misread: '利益' })) }
}

describe('body task wiring', () => {
  it('puts only the outline cast that has a card onto the body task', async () => {
    const fixture = await useWritingFixture({
      executionLimits: { researchEnabled: false, maxRepairAttempts: 0 },
      intervene(stage, output) {
        const next = withE5(stage, output, markdown(['云望舒', '章外闲人']))
        if (stage.kind === 'chapter-outline') return withSceneCast(next, ['云望舒', '路人甲'])
        return next
      },
    })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.executionLimits).not.toHaveProperty('castInjection')
    const body = [...fixture.stages.values()].find(stage => stage.kind === 'body')
    const task = bodyTask(body)
    expect(task.castCards).toEqual([expect.objectContaining({ name: '云望舒' })])
    expect(task.uncastNames).toEqual(['路人甲'])
    expect(task.misreadMap).toEqual([expect.objectContaining({ frame: '利益' })])
    const taskText = JSON.stringify({ castCards: task.castCards, misreadMap: task.misreadMap, uncastNames: task.uncastNames })
    expect(taskText).toContain('云望舒')
    expect(taskText).not.toContain('章外闲人')
    expect(countHan(taskText)).toBeLessThan(1500)
  }, 120_000)

  it('skips injection when the character card was kept as free text', async () => {
    const fixture = await useWritingFixture({
      executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
      intervene(stage, output) {
        const next = withE5(stage, output, voiceOnly)
        if (stage.kind === 'chapter-outline') return withSceneCast(next, ['苏清鸢'])
        return next
      },
    })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    const body = [...fixture.stages.values()].find(stage => stage.kind === 'body')
    const task = bodyTask(body)
    expect(task.castCards).toBeUndefined()
    expect(task.uncastNames).toBeUndefined()
    expect(body?.prompt).not.toContain('苏清鸢｜')
  }, 120_000)

  it('skips injection when castInjection is off', async () => {
    const fixture = await useWritingFixture({
      castInjection: false,
      executionLimits: { researchEnabled: false, maxRepairAttempts: 0 },
      intervene(stage, output) {
        const next = withE5(stage, output, markdown(['云望舒']))
        if (stage.kind === 'chapter-outline') return withSceneCast(next, ['云望舒'])
        return next
      },
    })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    const body = [...fixture.stages.values()].find(stage => stage.kind === 'body')
    expect(bodyTask(body).castCards).toBeUndefined()
    expect(body?.prompt).not.toContain('云望舒｜')
  }, 120_000)
})
