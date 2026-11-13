/** Settings batch planning and admission. Generation stays with the writing runner. */
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { projectNativeStageSchema } from './native-stage-schema.ts'
import { settingsCatalog, type SettingsDimensionKind } from './settings-catalog.ts'
import { StageValidationRejection, parseModelOutput } from './stage-rejection.ts'
import { ENUM_SETTINGS_KINDS, MAX_ENUM_SETTINGS_CONTENT_CHARS, type SettingsDimensionOutput, type StageInputRef } from './stage-output.ts'

/** A batch that would exceed maxOutputBytes is split into groups of this many dimensions. */
export const SETTINGS_BATCH_DEGRADE = 4
/** Planning allowance for one classification dimension, in UTF-8 bytes. */
const ENUM_BATCH_BYTES = (MAX_ENUM_SETTINGS_CONTENT_CHARS + 500) * 3
/** Planning allowance for one free-form dimension, in UTF-8 bytes. */
const FREE_BATCH_BYTES = 8_000 * 3

const codeSchema = z.string().regex(/^[a-z][a-z0-9]*$/)
export const settingsBatchSchema = z.strictObject({
  dimensions: z.array(z.strictObject({ code: codeSchema, body: z.string().min(1) })).min(1),
})
export const settingsConsistencySchema = z.strictObject({
  issues: z.array(z.strictObject({
    dimension: codeSchema,
    kind: z.enum(['conflict', 'gap']),
    quote: z.string().min(1),
  })),
})
export type SettingsBatchOutput = z.infer<typeof settingsBatchSchema>
export type SettingsConsistencyIssue = z.infer<typeof settingsConsistencySchema>['issues'][number]
export type SettingsBatchKind = 'draft' | 'consistency' | 'repair'

/** @param task - Stage task object. @returns The batch role when this stage is one of the three settings requests. */
export function settingsBatchKind(task: object): SettingsBatchKind | undefined {
  if (!('batch' in task)) return undefined
  const value = (task as { batch?: unknown }).batch
  return value === 'draft' || value === 'consistency' || value === 'repair' ? value : undefined
}

/**
 * Upper bound used to decide whether one draft would exceed the run output cap.
 * @param codes - Dimension codes in the candidate batch.
 * @param catalog - Catalog used for classification versus free-form size.
 */
export function estimateSettingsBatchBytes(codes: readonly string[], catalog: readonly { code: string; kind: SettingsDimensionKind }[] = settingsCatalog): number {
  let bytes = 2
  for (const code of codes) {
    const kind = catalog.find(item => item.code === code)?.kind
    bytes += code.length + 32 + (kind === 'enum_single' || kind === 'enum_multi' ? ENUM_BATCH_BYTES : FREE_BATCH_BYTES)
  }
  return bytes
}

/**
 * One group when the estimate fits in maxOutputBytes; otherwise groups of {@link SETTINGS_BATCH_DEGRADE}.
 * @param codes - Dependency order. @param maxOutputBytes - The run's raw output cap.
 */
export function planSettingsBatches(codes: readonly string[], maxOutputBytes: number): string[][] {
  if (codes.length === 0) return []
  if (estimateSettingsBatchBytes(codes) <= maxOutputBytes) return [[...codes]]
  const batches: string[][] = []
  for (let offset = 0; offset < codes.length; offset += SETTINGS_BATCH_DEGRADE) batches.push(codes.slice(offset, offset + SETTINGS_BATCH_DEGRADE))
  return batches
}

/** @param roots - Requested settings roots. @returns A stable copy for snapshot equality. */
export function canonicalSettingsRoots(roots: readonly string[]): string[] {
  return [...roots].sort()
}

/** @param left - Stored roots. @param right - Requested roots, already canonical. */
export function sameSettingsRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((code, index) => code === right[index])
}

/** @param codes - Codes in one draft. @returns The shared catalog kind when every code is that classification, otherwise undefined. */
export function batchDimensionKind(codes: readonly string[]): SettingsDimensionKind | undefined {
  const kinds = codes.map(code => settingsCatalog.find(item => item.code === code)?.kind)
  if (kinds.length > 0 && kinds.every(kind => kind === 'enum_single')) return 'enum_single'
  if (kinds.length > 0 && kinds.every(kind => kind === 'enum_multi')) return 'enum_multi'
  return undefined
}

/** Native schema for a draft or repair. */
export function settingsBatchNativeSchema(): ObjectJsonSchema {
  return projectNativeStageSchema(z.toJSONSchema(settingsBatchSchema, { io: 'input' }))
}

/** Native schema for the consistency review. */
export function settingsConsistencyNativeSchema(): ObjectJsonSchema {
  return projectNativeStageSchema(z.toJSONSchema(settingsConsistencySchema, { io: 'input' }))
}

/**
 * Admit one batch draft or repair.
 * @param value - Model JSON. @param expected - Requested codes, the output cap, and each code's catalog kind.
 */
export function parseSettingsBatch(value: unknown, expected: { readonly codes: readonly string[]; readonly maxOutputBytes: number; readonly kinds: ReadonlyMap<string, SettingsDimensionKind> }): SettingsBatchOutput {
  assertOutputBytes(value, expected.maxOutputBytes, 'Settings batch')
  const output = parseModelOutput(settingsBatchSchema, value, 'Settings batch output')
  const seen = new Set<string>()
  for (const item of output.dimensions) {
    if (item.body.trim().length === 0) throw new StageValidationRejection(`Settings batch body for ${item.code} must not be blank`)
    if (seen.has(item.code)) throw new StageValidationRejection(`Settings batch repeats dimension ${item.code}`)
    seen.add(item.code)
    if (!expected.codes.includes(item.code)) throw new StageValidationRejection(`Settings batch names an unrequested dimension ${item.code}`)
    const kind = expected.kinds.get(item.code)
    if (kind !== undefined && ENUM_SETTINGS_KINDS.has(kind)) {
      const chars = [...item.body].length
      if (chars > MAX_ENUM_SETTINGS_CONTENT_CHARS) {
        throw new StageValidationRejection(`A classification dimension allows at most ${MAX_ENUM_SETTINGS_CONTENT_CHARS} characters of contentMarkdown; this candidate has ${chars}`)
      }
    }
  }
  for (const code of expected.codes) if (!seen.has(code)) throw new StageValidationRejection(`Settings batch is missing ${code}`)
  return output
}

/**
 * Admit a cross-dimension review that only names conflicts and gaps.
 * @param value - Model JSON. @param expected - Selected codes, their bodies, and the output cap.
 */
export function parseSettingsConsistency(value: unknown, expected: { readonly codes: readonly string[]; readonly bodies: ReadonlyMap<string, string>; readonly maxOutputBytes: number }): readonly SettingsConsistencyIssue[] {
  assertOutputBytes(value, expected.maxOutputBytes, 'Settings consistency')
  const output = parseModelOutput(settingsConsistencySchema, value, 'Settings consistency output')
  for (const issue of output.issues) {
    if (!expected.codes.includes(issue.dimension)) throw new StageValidationRejection(`Consistency issue names a dimension outside this batch: ${issue.dimension}`)
    const body = expected.bodies.get(issue.dimension) ?? ''
    if (!body.includes(issue.quote)) throw new StageValidationRejection(`Consistency quote does not occur in ${issue.dimension}`)
  }
  return output.issues
}

/** @param code - Catalog code. @param body - Admitted Markdown. @param inputRefs - Host-bound sources. */
export function dimensionDocument(code: string, body: string, inputRefs: readonly StageInputRef[]): SettingsDimensionOutput {
  return { version: 1, inputRefs: [...inputRefs], dimensionCode: code, facts: [{ id: `batch-${code}`, statement: batchFactStatement(body) }], contentMarkdown: body }
}

/** @param body - Dimension Markdown. @returns One line of prose the host can quote inside stored JSON. */
export function batchFactStatement(body: string): string {
  const line = body.split('\n').map(item => item.trim()).find(item => item.length > 0 && !item.startsWith('#'))
  const statement = [...(line ?? body.trim())].slice(0, 200).join('')
  if (statement.length === 0 || statement.includes('\n')) throw new StageValidationRejection('Settings batch body must contain text')
  return statement
}

const IDENTIFIER = /^[\w.:/@+-]*$/u

/** @param facts - Stored facts. @param contentMarkdown - Stored prose. @returns A quote that survives the prose view. */
export function quoteOfDimension(facts: readonly { readonly statement: string }[], contentMarkdown: string): string {
  const statement = facts.find(fact => fact.statement.trim().length > 0 && !IDENTIFIER.test(fact.statement.trim()))?.statement
  if (statement !== undefined) return [...statement].slice(0, 200).join('')
  const line = contentMarkdown.split('\n').find(item => item.trim().length > 0 && !IDENTIFIER.test(item.trim()))
  if (line === undefined) throw new StageValidationRejection('Settings dimension has no reader-facing text to quote')
  return [...line.trim()].slice(0, 200).join('')
}

function assertOutputBytes(value: unknown, maxOutputBytes: number, label: string): void {
  const text = JSON.stringify(value)
  if (text === undefined) throw new StageValidationRejection(`${label} output is not JSON`)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxOutputBytes) throw new StageValidationRejection(`${label} output is ${bytes} UTF-8 bytes, above maxOutputBytes ${maxOutputBytes}`)
}
