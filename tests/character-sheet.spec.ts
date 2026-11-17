/** e5/e6 character cards: the parser names the character and the field, and version 15 asks for the tables. */
import { expect, it } from 'vitest'
import { CharacterSheetRejection, parseCharacterSheet } from '../src/character-sheet.ts'
import { assertCharacterSheet } from '../src/stage-output.ts'
import { buildStagePrompt, characterDimensionsForStage } from '../src/stage-prompts.ts'
import { StageValidationRejection } from '../src/stage-rejection.ts'

function row(name: string, frame = '技艺', chapters = '1,2'): string {
  return `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | ${frame} | 嘴上不服 | ${chapters} |`
}
function voice(name: string): string {
  return `| ${name} | 短句，4-12 字 | 不服、试探、剑 | 前辈 | 我 | 按剑 | 当众示弱 |`
}
const coreHead = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |'
const voiceHead = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |'
function sheet(names: readonly { name: string; frame?: string; chapters?: string }[]): string {
  return [coreHead, ...names.map(item => row(item.name, item.frame, item.chapters)), '', voiceHead, ...names.map(item => voice(item.name))].join('\n')
}
const three = sheet([
  { name: '云望舒', frame: '利益', chapters: '1,2,3' },
  { name: '苏清鸢', frame: '其它:怕输', chapters: '2' },
  { name: '沈丹青', frame: '礼法', chapters: '4' },
])

function messageOf(markdown: string, options?: { maxCharacters?: number }): string {
  try { parseCharacterSheet(markdown, options ?? {}) }
  catch (cause) {
    expect(cause).toBeInstanceOf(StageValidationRejection)
    expect(cause).toBeInstanceOf(CharacterSheetRejection)
    return (cause as Error).message
  }
  throw new Error('expected a character-sheet rejection')
}

it('parses three characters from the two tables', () => {
  const parsed = parseCharacterSheet(three)
  expect(parsed.core.map(item => item.name)).toEqual(['云望舒', '苏清鸢', '沈丹青'])
  expect(parsed.core[0]).toMatchObject({ role: '剑修', want: '证明自己', fear: '被无视', flaw: '逞强', misread: '利益', contrast: '嘴上不服', chapters: [1, 2, 3] })
  expect(parsed.core[1]?.misread).toBe('其它:怕输')
  expect(parsed.voice[2]).toMatchObject({ lexicon: ['不服', '试探', '剑'], addressForProtagonist: '前辈', selfReference: '我', mannerism: '按剑', forbidden: '当众示弱' })
})

it('names the character and the field for each structural defect', () => {
  expect(messageOf(`${voiceHead}\n${voice('苏清鸢')}`)).toContain('苏清鸢')
  expect(messageOf([
    '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 苏清鸢 | 剑修 | 证明自己 | 被无视 | 逞强 | 技艺 | 嘴上不服 |',
    '', voiceHead, voice('苏清鸢'),
  ].join('\n'))).toContain('出场章')
  expect(messageOf([coreHead, row('云望舒'), row('沈丹青'), '', voiceHead, voice('云望舒'), voice('苏清鸢')].join('\n'))).toMatch(/云望舒|沈丹青|苏清鸢/)
  expect(messageOf([coreHead, row('苏清鸢'), row('苏清鸢'), '', voiceHead, voice('苏清鸢'), voice('苏清鸢')].join('\n'))).toContain('苏清鸢')
  expect(messageOf(sheet([{ name: '苏清鸢', frame: '命运' }]))).toContain('误读框架')
  expect(messageOf(sheet([{ name: '苏清鸢', chapters: '零' }]))).toContain('出场章')
  expect(messageOf(sheet(Array.from({ length: 13 }, (_, index) => ({ name: `人${index + 1}` }))), { maxCharacters: 12 })).toContain('12')
})

it('does not parse e5 before version 15 or when the switch is off', () => {
  expect(() => assertCharacterSheet('e5', '自由文本', { promptVersion: 14 })).not.toThrow()
  expect(() => assertCharacterSheet('e5', '自由文本', { promptVersion: 15, characterSheet: false })).not.toThrow()
  expect(() => assertCharacterSheet('a1', '自由文本', { promptVersion: 15 })).not.toThrow()
  expect(() => assertCharacterSheet('e5', '自由文本', { promptVersion: 15 })).toThrow(CharacterSheetRejection)
  const base = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
  expect(buildStagePrompt({ ...base, kind: 'settings', promptVersion: 14, characterDimensions: ['e5'] })).toBe(buildStagePrompt({ ...base, kind: 'settings', promptVersion: 14 }))
  expect(buildStagePrompt({ ...base, kind: 'settings', promptVersion: 15, characterDimensions: ['e5'] })).toContain('角色, 身份, 欲望, 恐惧, 缺陷, 误读框架, 反差, 出场章')
  expect(characterDimensionsForStage({ dimensionCode: 'e6', codes: ['e5', 'a1'] })).toEqual(['e5', 'e6'])
})
