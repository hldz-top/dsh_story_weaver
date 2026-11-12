/** Public preview result parsing and pure Tool-card actions. */
import { isValidElement } from 'react'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { expect, test, vi } from 'vitest'
import { StoryPreview, type StoryPreviewProps } from '../src/client/StoryPreview.tsx'
import { en, zh } from '../src/client/locales.ts'
import { readStoryArtifactPreview, type StoryArtifactPreview } from '../src/preview-result.ts'

const preview: StoryArtifactPreview = {
  kind: 'story-artifact-preview',
  version: 1,
  novelId: 'novel-a',
  artifactId: 'brief-r1',
  revision: 1,
  title: '远行 · 创作要求 · 版本 1',
  path: '/workspace/story/novel-a/brief-r1.md',
}

type ToolCallBlock = StoryPreviewProps['block']
type ToolResult = Extract<ToolCallBlock, { kind: 'tool-result' }>

/** Pair one call block with the owner phase its variant requires. */
function ownerPhase(block: ToolCallBlock) {
  if ('kind' in block) return { phase: 'result' as const, block }
  if (block.phase === 'preparing') return { phase: 'preparing' as const, block }
  return { phase: 'start' as const, block }
}

function settledResult(meta: unknown): ToolResult {
  return {
    kind: 'tool-result',
    seq: 5,
    time: 123,
    callId: 'preview-call',
    name: 'story_preview',
    args: PartialArguments.fromText('{"artifactId":"brief-r1"}'),
    call: { name: 'story_preview', argsRaw: '{"artifactId":"brief-r1"}' },
    callTime: 120,
    content: [{ type: 'text', text: JSON.stringify(preview) }],
    isError: false,
    meta,
    subCalls: [],
  }
}

function translator(dictionary: Record<string, string>): StoryPreviewProps['t'] {
  return (key, params = {}) => {
    const message = dictionary[key]
    if (message === undefined) throw new Error(`Unknown locale key ${key}`)
    return message.replace(/\{([^}]+)\}/g, (_: string, name: string) => String(params[name]))
  }
}

function fixture(block: ToolCallBlock = settledResult(preview)) {
  return {
    callId: 'preview-call',
    toolName: 'story_preview',
    ...ownerPhase(block),
    cwd: '/workspace',
    home: '/home/author',
    useDisclosure: () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} }),
    openFile: vi.fn<StoryPreviewProps['openFile']>(),
    inspect: vi.fn<NonNullable<StoryPreviewProps['inspect']>>(),
    loadImage: async () => { throw new Error('Story preview has no image attachments') },
    t: translator(zh),
  } satisfies StoryPreviewProps
}

function nodes(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [{ type: node.type, props: node.props }, ...nodes(node.props.children)]
}

test('preview keeps the persisted version path for metadata and one JSON text result', () => {
  expect(readStoryArtifactPreview(preview, [{ type: 'text', text: 'model summary' }])).toEqual(preview)
  expect(readStoryArtifactPreview(undefined, [{ type: 'text', text: JSON.stringify(preview) }])).toEqual(preview)
})

test('invalid metadata cannot be replaced by a valid text result', () => {
  const malformed = [
    null,
    {},
    { ...preview, revision: 0 },
    { ...preview, revision: 1.5 },
    { ...preview, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...preview, title: '' },
    { ...preview, path: ' ' },
    { ...preview, artifactId: null },
    { ...preview, novelId: '' },
    { ...preview, kind: 'creative-brief' },
    { ...preview, version: 2 },
  ]
  for (const meta of malformed) {
    expect(readStoryArtifactPreview(meta, [{ type: 'text', text: JSON.stringify(preview) }])).toBeUndefined()
  }
})

test('nested dispatch requires exactly one JSON text result', () => {
  const malformed = [
    undefined,
    [],
    [{ type: 'image', text: JSON.stringify(preview) }],
    [{ type: 'text', text: 42 }],
    [{ type: 'text', text: 'not JSON' }],
    [{ type: 'text', text: JSON.stringify(preview) }, { type: 'text', text: 'extra result' }],
    [{ type: 'text', text: JSON.stringify([preview]) }],
  ]
  for (const content of malformed) {
    expect(readStoryArtifactPreview(undefined, content)).toBeUndefined()
  }
})

test('a successful card opens its recorded version and keeps the inspect action', () => {
  const props = fixture()
  const buttons = nodes(StoryPreview(props)).filter(node => node.type === 'button')
  expect(buttons.map(button => button.props.children)).toEqual(['打开此版本', '查看调用'])
  const open = buttons[0]?.props.onClick
  const inspect = buttons[1]?.props.onClick
  if (typeof open !== 'function' || typeof inspect !== 'function') throw new Error('Missing card actions')
  open()
  inspect()
  expect(props.openFile).toHaveBeenCalledExactlyOnceWith('/workspace/story/novel-a/brief-r1.md')
  expect(props.inspect).toHaveBeenCalledOnce()
})

test('running, failed and invalid-result cards keep inspection without a document action', () => {
  const cases: { block: ToolCallBlock; state: string; message: string }[] = [
    {
      block: {
        phase: 'start', callId: 'preview-call', name: 'story_preview', argsRaw: '{}',
        args: PartialArguments.fromText('{}'),
        turn: 1, step: 1, time: 120, subCalls: [],
      },
      state: 'running',
      message: '正在准备文档预览…',
    },
    {
      block: { ...settledResult(preview), isError: true, error: { name: 'Error', code: 'write_failed' } },
      state: 'error',
      message: '文档预览失败',
    },
    {
      block: settledResult({ ...preview, version: 2 }),
      state: 'invalid-result',
      message: '预览结果无效，无法打开文档。',
    },
  ]
  for (const { block, state, message } of cases) {
    const props = fixture(block)
    const view = nodes(StoryPreview(props))
    expect(view[0]?.props['data-state']).toBe(state)
    expect(view.find(node => node.props.role === 'status')?.props.children).toBe(message)
    expect(view.filter(node => node.type === 'button').map(node => node.props.children)).toEqual(['查看调用'])
    expect(view.filter(node => node.type === 'a')).toHaveLength(0)
    expect(props.openFile).not.toHaveBeenCalled()
  }
})

test('an English nested-result card opens the recorded file without requiring inspection', () => {
  const props = { ...fixture(settledResult(undefined)), t: translator(en), inspect: undefined }
  const view = nodes(StoryPreview(props))
  expect(view.find(node => node.props.role === 'status')?.props.children).toBe('Version file ready')
  const buttons = view.filter(node => node.type === 'button')
  expect(buttons.map(node => node.props.children)).toEqual(['Open this version'])
  const open = buttons[0]?.props.onClick
  if (typeof open !== 'function') throw new Error('Missing version action')
  open()
  expect(props.openFile).toHaveBeenCalledExactlyOnceWith('/workspace/story/novel-a/brief-r1.md')
})
