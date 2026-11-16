/** Deterministic character metrics. Warnings stay in the repair instruction. */
import { describe, expect, it } from 'vitest'
import { parseCharacterSheet, type CharacterSheet } from '../src/character-sheet.ts'
import {
  ADDRESS_COLLAPSE_PRESENT, appendCharacterMetricWarnings, CHARACTER_METRICS_BLOCKING, measureCharacterMetrics,
  sheetForCharacterMetrics, type CharacterMetrics,
} from '../src/character-metrics.ts'

const coreHead = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |'
const voiceHead = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |'
function voice(name: string, address: string): string {
  return `| ${name} | 短句，4-12 字 | 不服、试探、剑 | ${address} | 我 | 按剑 | 当众示弱 |`
}
function row(name: string): string {
  return `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | 利益 | 嘴上不服 | 1 |`
}
function sheet(names: readonly { name: string; address: string }[]): string {
  return [coreHead, ...names.map(item => row(item.name)), '', voiceHead, ...names.map(item => voice(item.name, item.address))].join('\n')
}

const three = parseCharacterSheet(sheet([
  { name: '苏清鸢', address: '前辈' },
  { name: '沈丹青', address: '前辈' },
  { name: '周晚', address: '前辈' },
]))
const body = '苏清鸢说「前辈」。沈丹青问「你来了吗」。周晚答「走吧」。'
const scenes = [{ cast: ['苏清鸢', '沈丹青', '周晚'] }]

function measure(overrides: Partial<Parameters<typeof measureCharacterMetrics>[0]> = {}, card: CharacterSheet = three) {
  return measureCharacterMetrics({
    bodyText: body, scenes, sheet: card, protagonistName: '林澜', recentProtagonistFreeScenes: [], ...overrides,
  })
}

describe('measureCharacterMetrics', () => {
  it('emits one warning when one address form is used and three characters are present', () => {
    const metrics = measure()
    expect(metrics.addressVariety).toEqual([
      { name: '苏清鸢', address: '前辈', count: 1 },
      { name: '沈丹青', address: '前辈', count: 1 },
      { name: '周晚', address: '前辈', count: 1 },
    ])
    expect(metrics.castPresence).toEqual([
      { name: '苏清鸢', present: true },
      { name: '沈丹青', present: true },
      { name: '周晚', present: true },
    ])
    expect(metrics.castPresence.filter(row => row.present)).toHaveLength(ADDRESS_COLLAPSE_PRESENT)
    expect(metrics.uncastNames).toBe(0)
    expect(metrics.protagonistFreeScenes).toBe(1)
    expect(metrics.quoteP50).toBe(2)
    expect(metrics.quoteP90).toBe(4)
    expect(metrics.warnings).toEqual(['3 characters are present and only 1 address form is used.'])
    expect(metrics).not.toHaveProperty('dialogueByCharacter')
    expect(CHARACTER_METRICS_BLOCKING).toBe(false)
  })

  it('does not warn when two address forms are used', () => {
    const card = parseCharacterSheet(sheet([
      { name: '苏清鸢', address: '前辈' },
      { name: '沈丹青', address: '道友' },
      { name: '周晚', address: '道友' },
    ]))
    const metrics = measure({ bodyText: '苏清鸢称前辈。沈丹青称道友。周晚在旁。', sheet: card })
    expect(metrics.warnings.filter(warning => warning.includes('address form'))).toEqual([])
  })

  it('skips a missing or rejected character card', () => {
    expect(sheetForCharacterMetrics([], 12)).toBeNull()
    expect(sheetForCharacterMetrics(['not a table'], 12)).toBeNull()
    const good = sheet([{ name: '苏清鸢', address: '前辈' }])
    expect(sheetForCharacterMetrics([good, 'not a table'], 12)).toBeNull()
    expect(sheetForCharacterMetrics([good], 12)?.core.map(row => row.name)).toEqual(['苏清鸢'])
  })

  it('warns once when the protagonist is in every scene for three chapters', () => {
    const metrics = measure({
      scenes: [{ cast: ['林澜', '苏清鸢'] }],
      bodyText: '林澜与苏清鸢同行。',
      recentProtagonistFreeScenes: [0, 0],
      sheet: parseCharacterSheet(sheet([
        { name: '林澜', address: '我' },
        { name: '苏清鸢', address: '前辈' },
      ])),
    })
    expect(metrics.protagonistFreeScenes).toBe(0)
    expect(metrics.warnings).toEqual(['The protagonist is in every scene for 3 consecutive chapters.'])
  })
})

describe('repair instructions', () => {
  it('appends warnings only to the repair text and leaves issue severity untouched', () => {
    const metrics: CharacterMetrics = measure()
    const issues = [
      { id: 'character-voice', severity: 'blocking' as const },
      { id: 'character-arc', severity: 'advisory' as const },
    ]
    const before = issues.map(issue => ({ ...issue }))
    const instruction = 'Resolve the blocking issues in the exact supplied review.'
    const repair = appendCharacterMetricWarnings(instruction, metrics)
    expect(issues).toEqual(before)
    expect(repair.startsWith(instruction)).toBe(true)
    expect(repair).toContain(metrics.warnings[0])
    expect(repair).toContain('do not change issue severity')
    expect(appendCharacterMetricWarnings(instruction, { ...metrics, warnings: [] })).toBe(instruction)
    expect(appendCharacterMetricWarnings(instruction, undefined)).toBe(instruction)
  })
})
