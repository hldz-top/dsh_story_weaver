/** Scene cast: pov and an illegal misread are rejected. Unknown names and one shared frame stay advisory. */
import { expect, it } from 'vitest'
import { parseCharacterSheet, type CharacterSheet } from '../src/character-sheet.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { assertKnownCast, assertSceneCastFields, buildCastInjection, CAST_CARDS_OMITTED, uncastNamesOf, uniformMisreadNote } from '../src/scene-cast.ts'
import { buildStagePrompt } from '../src/stage-prompts.ts'

function row(name: string): string {
  return `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | 技艺 | 嘴上不服 | 1 |`
}
function voice(name: string): string {
  return `| ${name} | 短句 | 甲、乙、丙 | 前辈 | 我 | 按剑 | 示弱 |`
}
function sheet(names: readonly string[]): CharacterSheet {
  const core = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
  const spoken = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |\n'
  return parseCharacterSheet(`${core}${names.map(row).join('\n')}\n\n${spoken}${names.map(voice).join('\n')}`)
}

it('rejects a viewpoint outside the cast and an illegal misread, and keeps unknown names', () => {
  expect(() => assertSceneCastFields([{ id: 's1', cast: ['云望舒'], pov: '沈丹青' }])).toThrow(/s1[\s\S]*pov/)
  expect(() => assertSceneCastFields([{ id: 's1', cast: ['云望舒'], pov: '云望舒', misread: '命运' }])).toThrow(/s1[\s\S]*misread/)
  expect(() => assertSceneCastFields([{ id: 's1', cast: ['路人'], pov: '路人', misread: '利益' }])).not.toThrow()
  expect(() => assertSceneCastFields([{ id: 's1', cast: ['路人'], pov: '路人', misread: '其它' }])).not.toThrow()
  expect(() => assertSceneCastFields([{ id: 's1', cast: ['路人'], pov: '路人', misread: '其它:看错人' }])).not.toThrow()
  expect(() => assertSceneCastFields([{ id: 's1', cast: ['路人'], pov: '路人', misread: '其它:' }])).toThrow(/misread/)
  expect(uniformMisreadNote([{ id: 's1', misread: '利益' }, { id: 's2', misread: '利益' }])).toMatch(/Advisory cast/)
  expect(uniformMisreadNote([{ id: 's1', misread: '利益' }, { id: 's2', misread: '礼法' }])).toBeNull()
  expect(uncastNamesOf([{ id: 's1', cast: ['路人', '云望舒'] }], new Set(['云望舒']))).toEqual(['路人'])
  expect(() => assertKnownCast([{ id: 's1', cast: ['路人'] }], new Set(['云望舒']))).toThrow(/路人/)
})

it('injects the union of outline casts and truncates with the omission marker', () => {
  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚']
  const card = sheet(names)
  const scenes = names.map((name, index) => ({ id: `s${index}`, cast: [name], ...(index === 0 ? { pov: name } : {}), misread: '利益' as const }))
  const injected = buildCastInjection(scenes, { sheet: card, maxCastCardChars: 1200 })
  expect(injected.castCards.map(item => item.name).sort()).toEqual([...names].sort())
  expect(injected.uncastNames).toEqual([])
  expect(injected.misreadMap).toHaveLength(names.length)
  const tiny = buildCastInjection(scenes, { sheet: card, maxCastCardChars: 30 })
  expect(tiny.omittedMarker).toBe(CAST_CARDS_OMITTED)
  expect(tiny.castCards.some(item => item.name === '甲')).toBe(true)
  expect(tiny.castCards.length).toBeLessThan(names.length)
})

it('keeps version 14 chapter outlines free of cast fields and bounds the body prompt', () => {
  expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 14))).not.toContain('"cast"')
  expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 15)).includes('"cast"')).toBe(true)
  expect(JSON.stringify(nativeStageOutputSchema('chapter-outline', 15, { sceneCast: false })).includes('"cast"')).toBe(false)
  const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings' as const, chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
  const before = buildStagePrompt({ ...base, kind: 'body', promptVersion: 14 })
  const after = buildStagePrompt({ ...base, kind: 'body', promptVersion: 15 })
  expect(after.length - before.length).toBeLessThan(1500)
  expect(after).toContain('task.castCards')
  expect(buildStagePrompt({ ...base, kind: 'body', promptVersion: 15, sceneCast: false, openingIn50: false })).toBe(before)
})
