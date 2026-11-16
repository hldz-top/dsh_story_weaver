/** Chapter-outline cast, viewpoint and misread: admission, version isolation, and strictCast. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCharacterSheet } from '../src/character-sheet.ts'
import { nativeStageOutputSchema } from '../src/native-stage-schema.ts'
import { assertKnownCast, SCENE_CAST_PROMPT_VERSION, SCENE_MISREAD_FRAMES, uncastNamesOf } from '../src/scene-cast.ts'
import { StageValidationRejection } from '../src/stage-rejection.ts'
import { parseChapterOutlineOutput, StageOutputSchemas } from '../src/stage-output.ts'
import { buildStagePrompt, CURRENT_PROMPT_VERSION, type PromptVersion, type StagePromptKind } from '../src/stage-prompts.ts'
import { useWritingFixture, type WritingFixtureStage } from './support/writing-fixture.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const parentHashes = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'scene-cast-parent-hashes.json'), 'utf8')) as Record<string, string>
const promptBase = { novelId: 'novel_00000000-0000-4000-8000-000000000000' as never, inputs: [{ artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: '0'.repeat(64), kind: 'settings', chars: 10 }], task: '{"x":1}', requirements: ['r1'] }
const kinds = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot'] as const satisfies readonly StagePromptKind[]
const ref = { artifactId: 'artifact_00000000-0000-4000-8000-000000000001' as never, sha256: 'a'.repeat(64) }
const scene = { id: 's1', purpose: '确认航道。', action: '林澜记下灯光。', obligationIds: ['signal-1'] }

function outline(scenes: readonly object[]) {
  return {
    version: 1, inputRefs: [ref], chapterNumber: 1, title: '第一章', throughLine: '林澜查航标。',
    constraints: [], obligations: [{ id: 'signal-1', description: '查明航标。' }], scenes,
  }
}

function admit(scenes: readonly object[]) {
  return parseChapterOutlineOutput(outline(scenes), { inputRefs: [ref], chapterNumber: 1, obligationIds: ['signal-1'] })
}

function rejection(scenes: readonly object[]): string {
  try { admit(scenes) }
  catch (cause) {
    expect(cause).toBeInstanceOf(StageValidationRejection)
    return (cause as Error).message
  }
  throw new Error('expected a chapter-outline rejection')
}

describe('scene cast admission', () => {
  it('rejects a viewpoint that is not in the scene cast and names the scene', () => {
    const message = rejection([{ ...scene, cast: ['云望舒', '苏清鸢'], pov: '林澜', misread: '利益' }])
    expect(message).toContain('s1')
    expect(message).toContain('pov')
    expect(message).toContain('林澜')
    expect(message).toContain('云望舒')
    expect(message).toContain('苏清鸢')
    expect(message).toContain('cast')
  })

  it('rejects a misread outside the scene enum and names the scene', () => {
    const message = rejection([{ ...scene, cast: ['云望舒'], pov: '云望舒', misread: '恩怨' }])
    expect(message).toContain('s1')
    expect(message).toContain('misread')
    expect(message).toContain('恩怨')
    for (const frame of SCENE_MISREAD_FRAMES) expect(message).toContain(frame)
  })

  it('keeps an unknown cast name and records it in uncastNames', () => {
    const scenes = [{ ...scene, cast: ['云望舒', '路人甲'], pov: '云望舒', misread: '礼法' }]
    expect(admit(scenes).scenes[0]).toMatchObject({ cast: ['云望舒', '路人甲'], pov: '云望舒', misread: '礼法' })
    const known = new Set(['云望舒'])
    expect(uncastNamesOf(scenes, known)).toEqual(['路人甲'])
    expect(() => assertKnownCast(scenes, known)).toThrow(StageValidationRejection)
    try { assertKnownCast(scenes, known) }
    catch (cause) {
      expect((cause as Error).message).toContain('路人甲')
      expect((cause as Error).message).toContain('角色')
      expect((cause as Error).message).toContain('strictCast')
    }
  })

  it('leaves the settings schema unchanged', () => {
    expect(Object.keys(StageOutputSchemas.settings.shape)).toEqual(['version', 'inputRefs', 'dimensionCode', 'facts', 'contentMarkdown'])
  })
})

describe('prompt version 11', () => {
  it('replays versions 1–10 prompt and schema bytes from parent 6bd305e', () => {
    expect(CURRENT_PROMPT_VERSION).toBe(SCENE_CAST_PROMPT_VERSION)
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const satisfies readonly PromptVersion[]) {
      for (const kind of kinds) {
        expect(sha(buildStagePrompt({ ...promptBase, kind, promptVersion: version })), `p/${version}/${kind}`).toBe(parentHashes[`p/${version}/${kind}`])
        expect(sha(JSON.stringify(nativeStageOutputSchema(kind, version))), `s/${version}/${kind}`).toBe(parentHashes[`s/${version}/${kind}`])
      }
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', settingsDimensionKind: 'enum_single', promptVersion: version }))).toBe(parentHashes[`p/${version}/settings/enum_single`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', settingsDimensionKind: 'llm_free', promptVersion: version }))).toBe(parentHashes[`p/${version}/settings/llm_free`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'review', reviewedKind: 'body', promptVersion: version }))).toBe(parentHashes[`p/${version}/review/body`])
      expect(sha(buildStagePrompt({ ...promptBase, kind: 'settings', promptVersion: version, characterDimensions: ['e5'], maxCharacters: 12 }))).toBe(parentHashes[`p/${version}/settings/e5`])
    }
  })

  it('publishes cast, pov and misread only on version 11 chapter outlines', () => {
    const previous = JSON.stringify(nativeStageOutputSchema('chapter-outline', 10))
    const current = JSON.stringify(nativeStageOutputSchema('chapter-outline', 11))
    expect(previous).not.toContain('cast')
    expect(previous).not.toContain('misread')
    expect(current).toContain('"cast"')
    expect(current).toContain('"pov"')
    expect(current).toContain('"misread"')
    expect(current).toContain('利益')
    const published = nativeStageOutputSchema('chapter-outline', 11) as unknown as { properties: { scenes: { items: { required?: string[] } } } }
    expect(published.properties.scenes.items.required ?? []).not.toEqual(expect.arrayContaining(['cast', 'pov', 'misread']))
    for (const kind of kinds) if (kind !== 'chapter-outline' && kind !== 'body') {
      expect(buildStagePrompt({ ...promptBase, kind, promptVersion: 11 }), kind).toBe(buildStagePrompt({ ...promptBase, kind, promptVersion: 10 }))
    }
    const outlinePrompt = buildStagePrompt({ ...promptBase, kind: 'chapter-outline', promptVersion: 11 })
    expect(outlinePrompt).toContain('set cast to every name present')
    expect(outlinePrompt).toContain('利益')
    expect(buildStagePrompt({ ...promptBase, kind: 'chapter-outline', promptVersion: 10 })).not.toContain('set cast to every name present')
    const bodyPrompt = buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 11 })
    expect(bodyPrompt).toContain('task.castCards')
    expect(bodyPrompt).toContain('task.misreadMap')
    expect(buildStagePrompt({ ...promptBase, kind: 'body', promptVersion: 10 })).not.toContain('task.castCards')
  })
})

const coreHead = '| 角色 | 身份 | 欲望 | 恐惧 | 缺陷 | 误读框架 | 反差 | 出场章 |\n| --- | --- | --- | --- | --- | --- | --- | --- |'
const voiceHead = '| 角色 | 句式 | 专属词 | 称呼主角 | 自称 | 身体签 | 禁语 |\n| --- | --- | --- | --- | --- | --- | --- |'
function card(name: string): string {
  return [
    coreHead,
    `| ${name} | 剑修 | 证明自己 | 被无视 | 逞强 | 利益 | 嘴上不服 | 1 |`,
    '',
    voiceHead,
    `| ${name} | 短句，4-12 字 | 不服、试探、剑 | 前辈 | 我 | 按剑 | 当众示弱 |`,
  ].join('\n')
}

function withE5(stage: WritingFixtureStage, output: object, body: string): object {
  if (stage.kind !== 'settings' || (stage.task?.batch !== 'draft' && stage.task?.batch !== 'repair')) return output
  const batch = output as { dimensions?: { code: string; body: string }[] }
  if (!Array.isArray(batch.dimensions)) return output
  return { ...batch, dimensions: batch.dimensions.map(item => item.code === 'e5' ? { code: item.code, body } : item) }
}

describe('strictCast on a run', () => {
  it('rejects an unknown cast name, then admits the repaired outline', async () => {
    const fixture = await useWritingFixture({
      strictCast: true,
      executionLimits: { researchEnabled: false, maxRepairAttempts: 1 },
      intervene(stage, output) {
        const withCard = withE5(stage, output, card('云望舒'))
        if (stage.kind === 'chapter-outline' && stage.task?.validationError == null) {
          const plan = withCard as { scenes?: object[] }
          return { ...plan, scenes: (plan.scenes ?? []).map(scene => ({ ...scene, cast: ['路人甲'], pov: '路人甲', misread: '利益' })) }
        }
        return withCard
      },
    })
    const outcome = await fixture.run(exec => fixture.runner.start(exec, { ...fixture.input, settingsRoots: ['e5'], chapterCount: 1, throughChapter: 1 }))
    if (outcome.status === 'rejected') throw outcome.reason
    expect(outcome.value.status).toBe('completed')
    expect(outcome.value.executionLimits).not.toHaveProperty('strictCast')
    expect(outcome.value.executionLimits).not.toHaveProperty('castInjection')
    expect(outcome.value.executionLimits).not.toHaveProperty('maxCastCardChars')
    const repair = [...fixture.stages.values()].find(stage => stage.kind === 'chapter-outline' && stage.task?.validationError != null)
    expect(repair?.task?.validationError).toContain('路人甲')
    expect(repair?.task?.validationError).toContain('角色')
    expect(parseCharacterSheet(card('云望舒')).core[0]?.name).toBe('云望舒')
  }, 120_000)
})
