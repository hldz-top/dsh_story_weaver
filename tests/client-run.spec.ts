/** Live writing cards consume host projections while their owning Tool remains active. */
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { isValidElement } from 'react'
import { expect, test, vi } from 'vitest'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { StoryRun, type StoryRunProps } from '../src/client/StoryRun.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { StoryStageDeliveries } from '../src/stage-delivery.ts'

const runId = 'run_11111111-1111-4111-8111-111111111111'
const artifactA = 'artifact_22222222-2222-4222-8222-222222222222'
const artifactB = 'artifact_33333333-3333-4333-8333-333333333333'
const attemptId = 'attempt_44444444-4444-4444-8444-444444444444'
const first = { runId, source: { kind: 'artifact' as const, artifactId: artifactA }, path: '/workspace/.dsh-story/settings-v1.md', description: '雾港 · a1 设定 · v1', eventSeq: 12 }
const repaired = { runId, source: { kind: 'artifact' as const, artifactId: artifactB }, path: '/workspace/.dsh-story/settings-v2.md', description: '雾港 · a1 设定 · v2', eventSeq: 20 }
const rejected = { runId, source: { kind: 'rejected-output' as const, attemptId }, path: '/workspace/.dsh-story/rejected-output.md', description: 'a1 · Invalid structured output', eventSeq: 9 }
const projected: StoryStageDeliveries = { version: 1, calls: [{ callId: 'write-call', deliveries: [first] }] }
type ToolResult = Extract<StoryRunProps['block'], { kind: 'tool-result' }>
const noopDisclosure: StoryRunProps['useDisclosure'] = () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} })

function translator(dictionary: Record<string, string>): StoryRunProps['t'] {
  return (key, params = {}) => {
    const value = dictionary[key]
    if (value === undefined) throw new Error(`Missing locale key: ${key}`)
    return value.replace(/\{([^}]+)\}/g, (_: string, name: string) => String(params[name]))
  }
}
function reader(value: unknown): UseProjection {
  return ((key: string, selector?: (value: unknown) => unknown) => {
    if (key !== 'story-stage-deliveries') throw new Error(`Unexpected projection ${key}`)
    return selector === undefined ? value : selector(value)
  }) as UseProjection
}
function fixture(value: unknown = projected): StoryRunProps & { openFile: ReturnType<typeof vi.fn<StoryRunProps['openFile']>> } {
  return { callId: 'write-call', toolName: 'story_write', phase: 'start',
    block: { phase: 'start', callId: 'write-call', name: 'story_write', argsRaw: '{}', args: PartialArguments.fromText('{}'), turn: 1, step: 1, time: 120, subCalls: [] },
    cwd: '/workspace', useDisclosure: noopDisclosure, openFile: vi.fn<StoryRunProps['openFile']>(), inspect: vi.fn(),
    loadImage: async () => { throw new Error('Writing cards have no image attachments') }, t: translator(zh), useProjection: reader(value) }
}
function settled(status: 'completed' | 'failed' | 'stopped' | 'interrupted'): ToolResult {
  return { kind: 'tool-result', seq: 30, time: 123, callId: 'write-call', name: 'story_write', args: PartialArguments.fromText('{}'), call: { name: 'story_write', argsRaw: '{}' }, callTime: 120,
    content: [{ type: 'text', text: JSON.stringify({ id: runId, status, error: status === 'failed' ? 'Generation failed' : null }) }], isError: false, subCalls: [] }
}
function nodes(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [{ type: node.type, props: node.props }, ...nodes(node.props.children)]
}
function fileButtons(node: unknown) { return nodes(node).filter(item => item.type === 'button' && item.props['data-open-stage'] === true) }
function click(node: { props: Record<string, unknown> } | undefined) {
  if (node === undefined || typeof node.props.onClick !== 'function') throw new Error('Missing stage-file action')
  node.props.onClick()
}

test('a running Tool gains separate exact version actions as its projection advances', () => {
  const props = fixture()
  const initial = StoryRun(props)
  expect(nodes(initial)[0]?.props['data-state']).toBe('running')
  expect(fileButtons(initial)).toHaveLength(1)
  expect(props.openFile).not.toHaveBeenCalled()
  const later = StoryRun({ ...props, useProjection: reader({ version: 1, calls: [{ callId: 'write-call', deliveries: [first, repaired] }] }) })
  const actions = fileButtons(later)
  expect(actions).toHaveLength(2)
  expect(nodes(later).filter(node => node.type === 'li').map(node => node.props['data-event-seq'])).toEqual([12, 20])
  click(actions[0])
  click(actions[1])
  expect(props.openFile.mock.calls).toEqual([[first.path], [repaired.path]])
})

test('only the actual owning Tool call receives its deliveries', () => {
  const props = fixture({ version: 1, calls: [{ callId: 'another-call', deliveries: [repaired] }, ...projected.calls] })
  const actions = fileButtons(StoryRun(props))
  expect(actions).toHaveLength(1)
  click(actions[0])
  expect(props.openFile).toHaveBeenCalledExactlyOnceWith(first.path)
})

test('rejected raw output remains distinct and readable beside later admitted artifacts', () => {
  const props = fixture({ version: 1, calls: [{ callId: 'write-call', deliveries: [rejected, first] }] })
  const view = StoryRun(props)
  expect(nodes(view).filter(node => node.type === 'li').map(node => node.props['data-source'])).toEqual(['rejected-output', 'artifact'])
  expect(nodes(view).some(node => node.props.children === zh['run.rejected-output'])).toBe(true)
  click(fileButtons(view)[0])
  expect(props.openFile).toHaveBeenCalledExactlyOnceWith(rejected.path)
})

test.each(['completed', 'failed', 'stopped', 'interrupted'] as const)('%s results retain every completed-stage file action', state => {
  const props = { ...fixture(), phase: 'result' as const, block: settled(state) }
  const view = StoryRun(props)
  expect(nodes(view)[0]?.props['data-state']).toBe(state)
  expect(fileButtons(view)).toHaveLength(1)
  expect(props.openFile).not.toHaveBeenCalled()
})

test('a transport failure and malformed final result retain already delivered files', () => {
  const completed = settled('completed')
  if (!('kind' in completed)) throw new Error('Fixture requires a settled result')
  for (const [block, state] of [
    [{ ...completed, isError: true, error: { name: 'Error', code: 'stage_failed' } }, 'failed'],
    [{ ...completed, content: [{ type: 'text' as const, text: '{' }] }, 'invalid-result'],
  ] as const) {
    const props = { ...fixture(), phase: 'result' as const, block }
    const view = StoryRun(props)
    expect(nodes(view)[0]?.props['data-state']).toBe(state)
    expect(fileButtons(view)).toHaveLength(1)
  }
})

test.each([undefined, { version: 1, calls: [] }, { version: 9, calls: [] }, { ...projected, calls: [{ callId: 'write-call', deliveries: [{ ...first, path: '' }] }] }])(
  'absent, empty and invalid projections never invent a file action: %j', projection => {
    const props = { ...fixture(), useProjection: reader(projection) }
    const view = StoryRun(props)
    expect(fileButtons(view)).toHaveLength(0)
    expect(props.openFile).not.toHaveBeenCalled()
    expect(nodes(view).filter(node => node.type === 'button').map(node => node.props.children)).toEqual([zh['card.inspect']])
  },
)

test('English card status and controls preserve recorded descriptions and need no inspect action', () => {
  const { inspect: _inspect, ...base } = fixture()
  const props = { ...base, t: translator(en), phase: 'result' as const, block: settled('completed') }
  const view = StoryRun(props)
  expect(nodes(view).some(node => node.props.children === en['run.state.completed'])).toBe(true)
  expect(nodes(view).some(node => node.props.children === first.description)).toBe(true)
  expect(nodes(view).filter(node => node.type === 'button').map(node => node.props.children)).toEqual([en['card.open']])
})
