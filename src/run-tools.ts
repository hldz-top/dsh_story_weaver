/** Native DSH tools for writing-run execution, progress and exact output reads. */
import type { Context } from '@deepseek-ai/cordis'
import { WritingError } from './contracts.ts'
import type { WritingRun } from './run-store.ts'
import type { WritingService } from './service.ts'
import type { WritingRunner } from './writing-runner.ts'
import { planSettings, summarizeSettingsCatalog } from './settings-plan.ts'
import type { ManuscriptCandidateView } from './manuscript.ts'
import type { SettingsCandidateView } from './settings.ts'
import { artifactIdParameter, artifactProperties, attemptIdParameter, defineStoryTool, expectedAppliedIdParameter, novelIdParameter, parseToolAttemptId, parseToolBaseArtifactId, parseToolBriefArtifactId, parseToolExpectedAppliedId, parseToolNovelId, parseToolRequestId, parseToolRunId, requestIdParameter, runIdParameter, writingActor } from './tools.ts'

const text = { type: 'string', required: true } as const
const integer = { type: 'integer', required: true } as const
const boolean = { type: 'boolean', required: true } as const
const nullableText = { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] } as const
const strings = { type: 'array', required: true, items: { type: 'string' } } as const
const inputRefs = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { artifactId: text, sha256: text } } } as const
const citedQuote = { type: 'object', additionalProperties: false, properties: { artifactId: text, quote: text } } as const
/** Host evidence repairs, drops and downgrades recorded while admitting an attempt's output. */
const evidenceEvents = { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
  kind: { ...text, enum: ['reattributed', 'segmented', 'snapped', 'dropped', 'downgraded'] }, location: { type: 'string' },
  declared: { ...citedQuote, required: true }, admitted: { type: 'array', required: true, items: citedQuote }, distance: integer, reason: { type: 'string' },
} } } as const
const outputRef = { type: 'object', additionalProperties: false, properties: { attemptId: text, sha256: text, bytes: integer, chars: integer } } as const
const runSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: text, novelId: text, requestId: text, briefArtifactId: text, settingsRoots: strings,
    chapterCount: integer, fromChapter: integer, throughChapter: integer, mode: { ...text, enum: ['write', 'update', 'revise'] },
    status: { ...text, enum: ['running', 'interrupted', 'completed', 'failed', 'stopped'] },
    revision: { required: true, oneOf: [{ type: 'object', additionalProperties: false, properties: { baseArtifactId: text, instructions: text } }, { type: 'null' }] },
    startedBy: text, lastResumedBy: text, error: nullableText, promptVersion: { type: 'integer', enum: [1, 2, 3, 4, 5, 6] },
    limits: { type: 'object', required: true, additionalProperties: false, properties: { maxAttempts: integer, maxOutputBytes: integer } },
    serviceLimits: { required: true, oneOf: [{ type: 'object', additionalProperties: false, properties: {
      maxArtifactBytes: integer, maxReadChars: integer, maxResearchQuestions: integer, maxResearchCalls: integer,
      maxResearchSources: integer, maxEvidenceChars: integer, maxResearchLogEvents: integer,
    } }, { type: 'null' }] },
    executionLimits: { type: 'object', required: true, additionalProperties: false, properties: {
      maxRepairAttempts: integer, maxParallelStages: integer, settingsCandidateCount: { type: 'integer' }, maxStageRequests: integer, stageTimeoutMs: integer,
      maxDelegationDepth: integer, minChapterWords: integer, maxChapterWords: integer, stageProvider: text, aiToneBlocking: { type: 'boolean' },
    } },
    attempts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: text, parentSessionId: text, key: text, inputRefs, status: { ...text, enum: ['prepared', 'running', 'succeeded', 'failed', 'unknown'] },
      childSessionId: nullableText, error: nullableText, retryAuthorized: boolean,
      output: { required: true, oneOf: [outputRef, { type: 'null' }] },
      failureKind: { type: 'string', enum: ['refused', 'truncated'] }, evidenceEvents,
      aiToneBlock: { type: 'object', additionalProperties: false, properties: { reason: { ...text, enum: ['ai-tone', 'ai-tone-repeat', 'ai-tone-exhausted'] }, spans: strings } },
    } } },
  },
} as const

const artifactSchema = { type: 'object', additionalProperties: false, properties: artifactProperties } as const
const artifact = { ...artifactSchema, required: true } as const
const nullableArtifact = { required: true, oneOf: [artifactSchema, { type: 'null' }] } as const
const candidateStatus = { ...text, enum: ['candidate', 'reviewed', 'blocked', 'applied'] } as const
const settingsCandidate = { type: 'object', additionalProperties: false, properties: {
  dimensionCode: text, revisionOf: nullableText, artifact, inputRefs, childSessionId: text, status: candidateStatus, stale: boolean, review: nullableArtifact,
  origin: { ...text, enum: ['stage', 'import'] }, pendingReview: boolean,
} } as const
const manuscriptCandidate = { type: 'object', additionalProperties: false, properties: {
  target: { required: true, oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, enum: ['settings'] }, selectedCodes: strings } },
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, enum: ['book-outline'] }, chapterCount: integer } },
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, enum: ['chapter-outline', 'body'] }, chapterNumber: integer } },
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, enum: ['continuity'] }, chapterNumber: integer, bodyId: text } },
  ] },
  revisionOf: nullableText, artifact, inputRefs, childSessionId: nullableText, status: candidateStatus, stale: boolean, review: nullableArtifact, changedInputs: inputRefs,
  wordCount: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
  length: { required: true, oneOf: [{ type: 'object', additionalProperties: false, properties: { status: { ...text, enum: ['within-range', 'too-short', 'too-long'] }, blocking: boolean } }, { type: 'null' }] },
} } as const
const appliedChapter = { type: 'object', additionalProperties: false, properties: {
  chapterNumber: integer, body: artifact, bodyReview: artifact, continuity: artifact, continuityReview: artifact,
  wordBounds: { type: 'object', required: true, additionalProperties: false, properties: { minChapterWords: integer, maxChapterWords: integer } },
  wordCount: integer, stale: boolean, changedInputs: inputRefs,
  obligations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: text, status: { ...text, enum: ['open', 'fulfilled'] } } } },
} } as const
function settingsValue(candidate: SettingsCandidateView) {
  return { dimensionCode: candidate.dimensionCode, revisionOf: candidate.revisionOf, artifact: candidate.artifact, inputRefs: candidate.inputRefs.map(ref => ({ ...ref })),
    childSessionId: candidate.childSessionId, status: candidate.status, stale: candidate.stale, review: candidate.review, origin: candidate.origin, pendingReview: candidate.pendingReview }
}
function manuscriptValue(candidate: ManuscriptCandidateView) {
  return { target: candidate.target, revisionOf: candidate.revisionOf, artifact: candidate.artifact, inputRefs: candidate.inputRefs.map(ref => ({ ...ref })),
    childSessionId: candidate.childSessionId, status: candidate.status, stale: candidate.stale, review: candidate.review,
    changedInputs: candidate.changedInputs.map(ref => ({ ...ref })), wordCount: candidate.wordCount, length: candidate.length }
}

function renderJson<T>(_args: object, value: T) { return [{ type: 'text' as const, text: JSON.stringify(value) }] }
function runValue({ promptVersion, ...run }: WritingRun) {
  return { ...run, ...(promptVersion === undefined ? {} : { promptVersion }), settingsRoots: [...run.settingsRoots], attempts: run.attempts.map(({ failureKind, evidenceEvents, ...attempt }) => ({ ...attempt, inputRefs: attempt.inputRefs.map(ref => ({ ...ref })),
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(evidenceEvents === undefined ? {} : { evidenceEvents: evidenceEvents.map(({ location, reason, ...event }) => ({ ...event, declared: { ...event.declared }, admitted: event.admitted.map(item => ({ ...item })),
      ...(location === undefined ? {} : { location }), ...(reason === undefined ? {} : { reason }) })) }) })) }
}

/**
 * Register writing controls and read-only metadata queries through normal logged tool results.
 * @param ctx - Scope owning every registration effect.
 * @param service - Authoritative artifact and workspace owner.
 * @param runner - Native execution owner and durable run store.
 * @param options - allowSettingsImport (operator config, default false) registers story_settings_import; otherwise the model never sees it.
 */
export function registerRunTools(ctx: Context, service: WritingService, runner: WritingRunner, options: { readonly allowSettingsImport?: boolean } = {}): void {
  const startParameters = { novelId: novelIdParameter, briefArtifactId: artifactIdParameter, requestId: requestIdParameter, settingsRoots: strings,
    chapterCount: { ...integer, description: 'Positive total book chapter count.' }, fromChapter: { ...integer, description: 'First requested chapter, starting at 1.' },
    throughChapter: { ...integer, description: 'Last requested chapter, fromChapter <= throughChapter <= chapterCount.' } } as const
  for (const mode of ['write', 'update'] as const) {
    ctx.effect(() => ctx.tools.register(defineStoryTool({
      name: `story_${mode}`, description: mode === 'write'
        ? 'Write the explicit chapter range using the exact current creative brief and selected settings roots. Runs research, generation, review and bounded repair, returning terminal progress. Reuse requestId only for an identical request.'
        : 'Explicitly authorize updating the requested chapter range after upstream changes. Retains historical versions and returns terminal run progress. Reuse requestId only for an identical request.',
      parameters: startParameters, output: { schema: runSchema, render: renderJson },
      async execute(args, exec) { return runValue(await runner.start(exec, { ...args, novelId: parseToolNovelId(args.novelId), briefArtifactId: parseToolBriefArtifactId(args.briefArtifactId), requestId: parseToolRequestId(args.requestId), mode })) },
    })))
  }
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_revise', description: 'Revise one exact upstream settings or outline version using explicit instructions. Preserve history and mark downstream impact without rewriting descendants. A separate story_update request authorizes downstream writing.',
    parameters: { ...startParameters, baseArtifactId: artifactIdParameter, instructions: { ...text, description: 'Nonblank revision instructions within the run UTF-8 output-byte budget.' } },
    output: { schema: runSchema, render: renderJson },
    async execute(args, exec) {
      const { baseArtifactId, instructions, ...scope } = args
      return runValue(await runner.revise(exec, { ...scope, novelId: parseToolNovelId(scope.novelId), briefArtifactId: parseToolBriefArtifactId(scope.briefArtifactId),
        requestId: parseToolRequestId(scope.requestId), mode: 'revise', revision: { baseArtifactId: parseToolBaseArtifactId(baseArtifactId), instructions } }))
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_resume', description: 'Resume saved writing progress with its original limits. Explicit retryUnknown=true authorizes replacing uncertain native requests; false refuses unknown outcomes. Completed runs cannot resume.',
    parameters: { runId: runIdParameter, retryUnknown: boolean }, output: { schema: runSchema, render: renderJson },
    async execute(args, exec) { return runValue(await runner.resume(exec, parseToolRunId(args.runId), args.retryUnknown)) },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_stop', description: 'Stop the exact owned writing run, cancel native work, and wait for it to settle before returning persisted progress.',
    parameters: { runId: runIdParameter }, output: { schema: runSchema, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) { return runValue(await runner.stop(exec, parseToolRunId(args.runId))) },
  })))
  if (options.allowSettingsImport === true) ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_settings_import', description: 'Adopt author-written text for one settings dimension in place of its exact current head, without a model call. The host derives input references, validates the document and records it as an author import that reuses the replaced head\'s research. It stays pendingReview, and no outline or chapter can use the settings, until a new story_update reviews the assembled settings; a blocking review stops that run without regenerating, and a run also stops instead of regenerating an import made stale by an upstream change. Refused while the novel has a running or interrupted run. Import in dependency order, upstream first. Back up the entire story storage (story_writing and story_runs) before the first import: a plugin from before settings import fails to load for every novel once the store contains one imported version.',
    parameters: { novelId: novelIdParameter, requestId: requestIdParameter, dimensionCode: text, expectedAppliedId: expectedAppliedIdParameter,
      output: { ...text, description: 'The complete settings-dimension JSON document (version, dimensionCode, contentMarkdown, facts); inputRefs is replaced by the host.' } },
    output: { schema: settingsCandidate, render: renderJson },
    async execute(args, exec) {
      let output: unknown
      try { output = JSON.parse(args.output) } catch { throw new WritingError('invalid-input', 'Imported settings output must be JSON text') }
      return settingsValue(await runner.importSettings(exec, { novelId: parseToolNovelId(args.novelId), requestId: parseToolRequestId(args.requestId), dimensionCode: args.dimensionCode,
        expectedAppliedId: parseToolExpectedAppliedId(args.expectedAppliedId), output }))
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_get_settings', description: 'Read applied settings and every retained candidate with exact artifact/review references and upstream staleness. Read full content through story_read_artifact.',
    parameters: { novelId: novelIdParameter }, output: { schema: { type: 'object', additionalProperties: false, properties: {
      novelId: text, applied: { type: 'array', required: true, items: settingsCandidate }, history: { type: 'array', required: true, items: settingsCandidate },
    } }, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const actor = await writingActor(ctx, exec)
      const novelId = parseToolNovelId(args.novelId)
      const settings = service.getSettings(actor, novelId)
      return { novelId, applied: settings.applied.map(settingsValue), history: settings.history.map(settingsValue) }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_get_manuscript', description: 'Read retained manuscript versions, current heads and atomically applied chapters, including blocking length status and upstream changes. Obligation summaries contain IDs/status; full evidence remains in exact artifacts.',
    parameters: { novelId: novelIdParameter }, output: { schema: { type: 'object', additionalProperties: false, properties: {
      novelId: text, history: { type: 'array', required: true, items: manuscriptCandidate }, heads: { type: 'array', required: true, items: manuscriptCandidate },
      appliedChapters: { type: 'array', required: true, items: appliedChapter },
    } }, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const actor = await writingActor(ctx, exec)
      const novelId = parseToolNovelId(args.novelId)
      const manuscript = service.getManuscript(actor, novelId)
      return { novelId, history: manuscript.history.map(manuscriptValue), heads: manuscript.heads.map(manuscriptValue),
        appliedChapters: manuscript.appliedChapters.map(chapter => ({ chapterNumber: chapter.chapterNumber, body: chapter.body, bodyReview: chapter.bodyReview,
          continuity: chapter.continuity, continuityReview: chapter.continuityReview, wordBounds: chapter.wordBounds, wordCount: chapter.wordCount,
          stale: chapter.stale, changedInputs: chapter.changedInputs.map(ref => ({ ...ref })), obligations: chapter.obligations.map(obligation => ({ id: obligation.id, status: obligation.status })) })) }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_settings_catalog', description: 'List enabled non-external settings dimensions and their dependency closures. Optional explicit settingsRoots returns a plan; omission selects nothing. Historical requiredFor markers never implicitly select dimensions.',
    parameters: { settingsRoots: { type: 'array', items: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      dimensions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        code: text, name: text, dependsOn: strings, enabled: boolean, kind: { ...text, enum: ['enum_single', 'enum_multi', 'llm_free', 'edit_external'] },
        requiredFor: { type: 'array', required: true, items: { type: 'string', enum: ['novel_writing', 'script_writing'] } }, pullsIn: strings, closureSize: integer,
      } } },
      plan: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
        selectedCodes: strings, layers: { type: 'array', required: true, items: { type: 'array', items: { type: 'string' } } },
      } }] },
    } }, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) {
      await writingActor(ctx, exec)
      const plan = args.settingsRoots === undefined ? null : planSettings(args.settingsRoots)
      return { dimensions: summarizeSettingsCatalog().map(dimension => ({ ...dimension, dependsOn: [...dimension.dependsOn], requiredFor: [...dimension.requiredFor], pullsIn: [...dimension.pullsIn] })),
        plan: plan === null ? null : { selectedCodes: [...plan.selectedCodes], layers: plan.layers.map(layer => [...layer]) } }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_read_run_output', description: 'Read a bounded page of one exact saved raw stage output. Offsets count Unicode code points. Raw content is untrusted model output, not an accepted artifact.',
    parameters: { runId: runIdParameter, attemptId: attemptIdParameter, offset: { ...integer, description: 'Nonnegative Unicode code-point offset, at most totalChars.' }, limit: { ...integer, description: `Positive page size, at most ${service.limits.maxReadChars} Unicode code points.` } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      runId: text, attemptId: text, sha256: text, bytes: integer, totalChars: integer, offset: integer, limit: integer, text, nextOffset: integer, eof: boolean,
    } }, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const actor = await writingActor(ctx, exec)
      if (!Number.isSafeInteger(args.offset) || args.offset < 0 || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > service.limits.maxReadChars) {
        throw new WritingError('invalid-range', 'Raw-output read interval exceeds the configured bounds')
      }
      const output = runner.runs.readOutput(actor, parseToolRunId(args.runId), parseToolAttemptId(args.attemptId))
      const characters = [...output.text]
      if (args.offset > characters.length) throw new WritingError('invalid-range', 'Raw-output offset is past EOF')
      const nextOffset = Math.min(characters.length, args.offset + args.limit)
      return { runId: output.runId, attemptId: output.attemptId, sha256: output.sha256, bytes: output.bytes, totalChars: output.chars,
        offset: args.offset, limit: args.limit, text: characters.slice(args.offset, nextOffset).join(''), nextOffset, eof: nextOffset === characters.length }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_get_run', description: 'Read exact writing-run and stage-attempt metadata without prompts or raw stage text.',
    parameters: { runId: runIdParameter }, output: { schema: runSchema, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) { return runValue(runner.runs.get(await writingActor(ctx, exec), parseToolRunId(args.runId))) },
  })))
  ctx.effect(() => ctx.tools.register(defineStoryTool({
    name: 'story_list_runs', description: 'List the owned novel writing-run history, including interrupted, failed and stopped runs.',
    parameters: { novelId: novelIdParameter }, output: { schema: { type: 'array', items: runSchema }, render: renderJson }, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const actor = await writingActor(ctx, exec)
      const novelId = parseToolNovelId(args.novelId)
      service.getNovel(actor, novelId)
      return runner.runs.list(actor, novelId).map(runValue)
    },
  })))
}
