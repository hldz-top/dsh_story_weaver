import { expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { nativeStageOutputSchema, projectNativeStageSchema } from '../src/native-stage-schema.ts'
import type { StagePromptKind } from '../src/stage-prompts.ts'
import { parseArtifactId } from '../src/contracts.ts'
import { executeStage, type StageExecutionConfig } from '../src/stage-executor.ts'
import { parseSettingsDimensionOutput, StageOutputSchemas } from '../src/stage-output.ts'
import { call } from './support/model.ts'
import { useStageFixture } from './support/stage-fixture.ts'

const kinds: readonly StagePromptKind[] = ['settings', 'review', 'book-outline', 'chapter-outline', 'body', 'continuity', 'continuity-snapshot']

it.each(kinds)('publishes %s through the installed native object-schema validator', kind => {
  expect(() => assertObjectJsonSchema(nativeStageOutputSchema(kind))).not.toThrow()
})

const source = { artifactId: parseArtifactId('artifact_00000000-0000-4000-8000-000000000001'), sha256: 'a'.repeat(64) }
const common = { version: 1, inputRefs: [source] }
const citation = { artifactId: source.artifactId, quote: 'The keeper opens the log.' }
const outputs = {
  settings: { ...common, dimensionCode: 'a1', facts: [{ id: 'genre', statement: 'A coastal mystery.' }], contentMarkdown: 'A coastal mystery.' },
  review: { ...common, reviewed: source, checks: [{ category: 'completeness', summary: 'The action is recorded.', evidence: [citation] }], issues: [] },
  'book-outline': { ...common, contentMarkdown: 'The keeper investigates.', ending: 'The log identifies the sender.',
    characterArcs: [{ character: 'The keeper', development: 'She learns to trust the crew.' }],
    chapters: [{ chapterNumber: 1, title: 'The log', purpose: 'Recover the log.', obligations: [] }] },
  'chapter-outline': { ...common, chapterNumber: 1, title: 'The log', throughLine: 'Recover the log.',
    constraints: [], obligations: [], scenes: [{ id: 'open-log', purpose: 'Read the record.', action: 'The keeper opens the log.', obligationIds: [] }] },
  body: { ...common, chapterNumber: 1, scenes: [{ sceneId: 'open-log', text: 'The keeper opens the log.' }] },
  continuity: { ...common, chapterNumber: 1, summary: 'The log is recovered.', characters: [{ name: 'The keeper', state: 'Holds the log.' }],
    timeline: [{ event: 'The log is opened.', evidence: [citation] }], obligations: [] },
  'continuity-snapshot': { ...common, chapterNumber: 1, characterStatus: [{ name: 'The keeper', status: 'Holds the log.' }], unrecoveredForeshadowing: [], usedPlotBridges: [{ note: 'The log was opened.' }] },
} satisfies Record<StagePromptKind, object>
const execution: StageExecutionConfig = {
  stageProvider: 'stage-spawn', maxDelegationDepth: 2, allowedTools: [], maxStageRequests: 1, stageTimeoutMs: 5000,
}

const paragraphReview = { ...common, reviewed: source, checks: [{ category: 'completeness', summary: 'The action is recorded.', evidence: [{ paragraphId: 'p1', problem: 'The keeper opens the log.' }] }], issues: [] }

it.each(kinds)('captures %s through the actual native child structured-output tool', async kind => {
  const output = kind === 'review' ? paragraphReview : outputs[kind]
  if (kind === 'review') {
    expect(validateJsonSchemaValue(nativeStageOutputSchema('review'), paragraphReview)).toEqual([])
    expect(validateJsonSchemaValue(nativeStageOutputSchema('review', 6), outputs.review)).toEqual([])
    expect(validateJsonSchemaValue(nativeStageOutputSchema('review'), outputs.review)).not.toEqual([])
  } else expect(StageOutputSchemas[kind].parse(output)).toEqual(output)
  const fixture = await useStageFixture(request => {
    expect(request.provider).toBe('stage-fixture')
    expect(request.model).toBe('inherited-model')
    return call('structured_output', output)
  })
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: `native-schema-${kind}`, prompt: `Return the ${kind} result.`, outputSchema: nativeStageOutputSchema(kind), onStarted: async () => {},
  }, execution))
  expect(outcome).toMatchObject({ status: 'fulfilled', value: { structured: output } })
  expect(fixture.childRequests).toHaveLength(1)
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it('publishes version 7 outlines without targetWords and keeps it required through version 6', () => {
  for (const kind of ['book-outline', 'chapter-outline'] as const) {
    expect(JSON.stringify(nativeStageOutputSchema(kind))).not.toContain('targetWords')
    expect(JSON.stringify(nativeStageOutputSchema(kind, 6))).toContain('targetWords')
    expect(validateJsonSchemaValue(nativeStageOutputSchema(kind), outputs[kind])).toEqual([])
  }
  const book = { ...outputs['book-outline'], chapters: [{ ...outputs['book-outline'].chapters[0], targetWords: 3500 }] }
  expect(validateJsonSchemaValue(nativeStageOutputSchema('book-outline', 6), book)).toEqual([])
  expect(validateJsonSchemaValue(nativeStageOutputSchema('book-outline'), book)).not.toEqual([])
})

it('keeps native structure strict while publishing host constraints in field descriptions', () => {
  const settings = nativeStageOutputSchema('settings')
  expect(settings.properties?.dimensionCode).toEqual({ type: 'string', description: 'Host validation requires pattern="^[a-z][a-z0-9]*$".' })
  expect(settings.properties?.facts?.description).toBe('Host validation requires minItems=1.')
  expect(settings.properties?.contentMarkdown).toEqual({ type: 'string', description: 'Host validation requires minLength=1.' })
  expect(nativeStageOutputSchema('body').properties?.chapterNumber).toEqual({
    type: 'integer', description: 'Host validation requires exclusiveMinimum=0; maximum=9007199254740991.',
  })
  expect(validateJsonSchemaValue(settings, { ...outputs.settings, extra: true })).not.toEqual([])
  expect(validateJsonSchemaValue(settings, { ...outputs.settings, facts: [{ ...outputs.settings.facts[0], extra: true }] })).not.toEqual([])
  expect(validateJsonSchemaValue(settings, { ...outputs.settings, facts: 'not an array' })).not.toEqual([])
  expect(validateJsonSchemaValue(settings, { ...outputs.settings, version: 2 })).not.toEqual([])
  expect(validateJsonSchemaValue(settings, { version: 1 })).not.toEqual([])
  expect(projectNativeStageSchema({ type: 'object', properties: { value: { type: 'string', minLength: 2, description: 'Existing instruction.' } } })
    .properties?.value?.description).toBe('Existing instruction. Host validation requires minLength=2.')
})

it.each([
  ['pattern', { ...outputs.settings, dimensionCode: 'INVALID' }],
  ['nonempty collection', { ...outputs.settings, facts: [] }],
  ['nonblank content', { ...outputs.settings, contentMarkdown: '   ' }],
  ['minimum string length', { ...outputs.settings, contentMarkdown: '' }],
] as const)('rejects %s in canonical admission after native structural capture', async (_constraint, output) => {
  const schema = nativeStageOutputSchema('settings')
  expect(validateJsonSchemaValue(schema, output)).toEqual([])
  const fixture = await useStageFixture(() => call('structured_output', output))
  const outcome = await fixture.run(exec => executeStage(fixture.ctx, exec, {
    attemptId: 'host-constraint', prompt: 'Return a settings candidate.', outputSchema: schema, onStarted: async () => {},
  }, execution))
  if (outcome.status === 'rejected') throw outcome.reason
  expect(outcome.value.structured).toEqual(output)
  expect(() => parseSettingsDimensionOutput(outcome.value.structured, { dimensionCode: 'a1', inputRefs: [source] })).toThrow()
  expect(fixture.ctx.agents.list()).toEqual([fixture.parent])
})

it.each(['$ref', '$defs', 'anyOf', 'allOf', 'not', 'prefixItems', 'contains', 'unevaluatedProperties', 'format'])(
  'rejects the unsupported %s construct instead of omitting it', keyword => {
    expect(() => projectNativeStageSchema({ type: 'object', properties: { nested: { type: 'string', [keyword]: {} } } }))
      .toThrow(`schema.properties.nested.${keyword} is unsupported`)
  },
)

it('preserves native oneOf branches and rejects malformed or cyclic schema topology', () => {
  const schema = projectNativeStageSchema({ type: 'object', properties: { value: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] } } })
  expect(validateJsonSchemaValue(schema, { value: 'text' })).toEqual([])
  expect(validateJsonSchemaValue(schema, { value: null })).toEqual([])
  expect(validateJsonSchemaValue(schema, { value: 1 })).not.toEqual([])
  expect(() => projectNativeStageSchema({ type: 'object', properties: { value: { type: ['string', 'null'] } } })).toThrow(/type/)
  expect(() => projectNativeStageSchema({ type: 'object', properties: { value: { type: 'string', pattern: 42 } } })).toThrow(/invalid host constraint/)
  const recursive: { type: string; properties: Record<string, object> } = { type: 'object', properties: {} }
  recursive.properties.recursive = recursive
  expect(() => projectNativeStageSchema(recursive)).toThrow(/cyclic schema/)
})
