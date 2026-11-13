/** DSH entry point for independent novel-writing capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import { openWritingService, type WritingService } from './service.ts'
import { registerWritingTools } from './tools.ts'
import { registerResearchTools } from './research-tools.ts'
import { openRunStore, type RunExecutionLimits } from './run-store.ts'
import { WritingRunner } from './writing-runner.ts'
import { registerRunTools } from './run-tools.ts'
import { StageDeliveries, registerStageDeliveryProjection } from './stage-deliveries.ts'
import type { ResearchLimits } from './contracts.ts'
import { onQuoteRepair } from './evidence-quote.ts'
import { assertVerifiedDshHost, resolvedSubagentPackageVersion } from './host-contract.ts'
import { normalizeWritingModel } from './writing-model.ts'

export { openWritingService, WritingService } from './service.ts'
export * from './contracts.ts'
export type { ResearchSelection, ResearchSelectedFinding, ResearchSourcePage, IndexedResearchObservation, SelectedResearchObservation } from './research-selection.ts'
export type * from './settings.ts'
export type * from './manuscript.ts'
export { WritingRunner } from './writing-runner.ts'
export { StageDeliveries, registerStageDeliveryProjection } from './stage-deliveries.ts'
export { openRunStore } from './run-store.ts'
export type * from './run-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { story: WritingService; storyRunner: WritingRunner }
}

/** Explicit size bounds and a Session-relative directory for version previews. */
export interface Config extends ResearchLimits, Omit<RunExecutionLimits, 'writingModel'> {
  maxRunAttempts: number
  maxArtifactBytes: number
  maxReadChars: number
  /** Slash-separated relative directory; empty, dot and parent segments are invalid. */
  previewDirectory: string
  /** Operator-only: skip the required-settings gate for smoke tests. Not a tool argument. Default false. */
  allowIncompleteSettings: boolean
  /** Operator-only: register story_settings_import. Enable only for an import, then turn it off. Default false: the tool is absent from the tool schema. */
  allowSettingsImport: boolean
  /** Body reviews on prompt versions 5 and 6 turn AI-tone findings quoting the body into blocking issues. Prompt version 7 records the same switch and reports a density grade instead of blocking. Frozen into each new run. Default true. */
  aiToneBlocking: boolean
  /**
   * Writing-stage model route. `inherit` uses the parent Agent's configured model and subscription for every stage.
   * A map names planning, review and body. `opencode-go` is rejected: OpenCode Go is a host subscription, and this plugin registers no adapter.
   */
  writingModel: string | { planning?: 'inherit' | { provider: string; model: string }; review?: 'inherit' | { provider: string; model: string }; body?: 'inherit' | { provider: string; model: string } }
  /** When false, research is not run. Default false. Enable it to use the host's official retrieval. */
  researchEnabled: boolean
  /** Skip research when remaining native web-call slots are below this floor. Default 1. */
  researchBudgetFloor: number
}

export const Config: z<Config> = z.object({
  stageProvider: z.string().default('spawn'),
  maxDelegationDepth: z.number().default(2),
  maxStageRequests: z.number().default(96),
  stageTimeoutMs: z.number().default(600_000),
  maxRepairAttempts: z.number().default(2),
  maxParallelStages: z.number().default(3),
  /**
   * How many candidates one settings dimension generates on its first pass.
   * Layer width is maxParallelStages and does not read this value. Default 1.
   */
  settingsCandidateCount: z.number().default(1),
  maxRunAttempts: z.number().default(512),
  minChapterWords: z.number().default(3000),
  maxChapterWords: z.number().default(5000),
  maxArtifactBytes: z.number().default(1_048_576),
  maxReadChars: z.number().default(4096),
  previewDirectory: z.string().default('.dsh-story'),
  allowIncompleteSettings: z.boolean().default(false),
  allowSettingsImport: z.boolean().default(false),
  aiToneBlocking: z.boolean().default(true),
  writingModel: z.any().default('inherit'),
  researchEnabled: z.boolean().default(false),
  researchBudgetFloor: z.number().default(1),
  maxResearchQuestions: z.number().default(12),
  maxResearchCalls: z.number().default(12),
  maxResearchSources: z.number().default(24),
  maxEvidenceChars: z.number().default(16_000),
  maxResearchLogEvents: z.number().default(2048),
})

export const name = 'dsh-story-weaver'
export const inject = ['storageDomain', 'tools', 'fs', 'llm', 'subagents', 'sessions', 'sessionPersistence', 'sessionProjections']

/**
 * Mount one writing service and its tools on the existing DSH capabilities.
 * @param ctx - Plugin scope owning service and tool lifetimes.
 * @param config - Validated deployment limits and relative preview directory.
 * @returns After the durable service is opened and all tools are registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const directory = config.previewDirectory
  // oxlint-disable-next-line no-control-regex -- Configured filesystem directories cannot contain NUL or control characters.
  if (/[\\:\u0000-\u001f\u007f]/.test(directory)
    || directory.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.trim() !== segment)) {
    throw new Error('previewDirectory must be a normalized relative directory with nonempty path segments')
  }
  const settingsCandidateCount = config.settingsCandidateCount ?? 1
  for (const [name, value] of Object.entries({ maxDelegationDepth: config.maxDelegationDepth, maxStageRequests: config.maxStageRequests,
    stageTimeoutMs: config.stageTimeoutMs, maxParallelStages: config.maxParallelStages, maxRunAttempts: config.maxRunAttempts,
    settingsCandidateCount })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a finite positive integer`)
  }
  if (!Number.isSafeInteger(config.maxRepairAttempts) || config.maxRepairAttempts < 0) throw new Error('maxRepairAttempts must be a finite nonnegative integer')
  if (config.stageTimeoutMs > 2_147_483_647) throw new Error('stageTimeoutMs exceeds the supported timer range')
  if (typeof config.aiToneBlocking !== 'boolean') throw new Error('aiToneBlocking must be a boolean')
  if (config.stageProvider.trim().length === 0) throw new Error('stageProvider must name a configured native in-process spawn provider')
  const writingModel = normalizeWritingModel(config.writingModel)
  if (!Number.isSafeInteger(config.researchBudgetFloor) || config.researchBudgetFloor < 0) throw new Error('researchBudgetFloor must be a finite nonnegative integer')
  if (typeof config.researchEnabled !== 'boolean') throw new Error('researchEnabled must be a boolean')
  assertVerifiedDshHost(resolvedSubagentPackageVersion(), ctx.get('subagents'), ctx.get('agents'))
  const executionLimits: RunExecutionLimits = { stageProvider: config.stageProvider, maxDelegationDepth: config.maxDelegationDepth,
    maxStageRequests: config.maxStageRequests, stageTimeoutMs: config.stageTimeoutMs, maxRepairAttempts: config.maxRepairAttempts,
    maxParallelStages: config.maxParallelStages, settingsCandidateCount,
    minChapterWords: config.minChapterWords, maxChapterWords: config.maxChapterWords,
    aiToneBlocking: config.aiToneBlocking, writingModel, researchEnabled: config.researchEnabled, researchBudgetFloor: config.researchBudgetFloor }
  const researchLimits: ResearchLimits = {
    maxResearchQuestions: config.maxResearchQuestions,
    maxResearchCalls: config.maxResearchCalls,
    maxResearchSources: config.maxResearchSources,
    maxEvidenceChars: config.maxEvidenceChars,
    maxResearchLogEvents: config.maxResearchLogEvents,
  }
  const service = await openWritingService(ctx.storageDomain, { maxArtifactBytes: config.maxArtifactBytes, maxReadChars: config.maxReadChars }, researchLimits, { minChapterWords: config.minChapterWords, maxChapterWords: config.maxChapterWords })
  const logger = ctx.logger('dsh-story')
  const stopQuoteLog = onQuoteRepair(repair => logger.info('evidence quote %s: %s', repair.kind, JSON.stringify({
    declared: repair.declared.artifactId, admitted: repair.admitted.map(item => item.artifactId), distance: repair.distance,
    from: [...repair.declared.quote].slice(0, 80).join(''), to: repair.admitted.map(item => [...item.quote].slice(0, 80).join('')) })))
  ctx.effect(() => stopQuoteLog)
  let runs: Awaited<ReturnType<typeof openRunStore>> | undefined
  let runner: WritingRunner | undefined
  let deliveryProjection: Awaited<ReturnType<typeof registerStageDeliveryProjection>> | undefined
  ctx.effect(() => async () => {
    const failures: unknown[] = []
    for (const owner of [runner, runs, service]) {
      if (owner === undefined) continue
      try { await owner.close() }
      catch (cause) { failures.push(cause) }
    }
    try { await deliveryProjection?.dispose() }
    catch (cause) { failures.push(cause) }
    if (failures.length > 0) throw new AggregateError(failures, 'Writing plugin shutdown could not complete')
  })
  runs = await openRunStore(ctx.storageDomain, { maxAttempts: config.maxRunAttempts, maxOutputBytes: config.maxArtifactBytes })
  deliveryProjection = await registerStageDeliveryProjection(ctx)
  runner = new WritingRunner(ctx, service, runs, executionLimits, new StageDeliveries(ctx, service, runs, config.previewDirectory), { allowIncompleteSettings: config.allowIncompleteSettings })
  ctx.provide('story', service)
  ctx.provide('storyRunner', runner)
  registerWritingTools(ctx, service, config.previewDirectory)
  registerResearchTools(ctx, service)
  registerRunTools(ctx, service, runner, { allowSettingsImport: config.allowSettingsImport })
}
