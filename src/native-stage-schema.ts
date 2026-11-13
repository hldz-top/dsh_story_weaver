/** Native DSH publication of the canonical writing-stage schemas. */
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { openChecklistModelSchema, type OpenChecklistCode } from './open-dimension-checklist.ts'
import { bookOutlineSchemaLegacy, bookOutlineSchemaV7, chapterOutlineSchemaLegacy, chapterOutlineSchemaV1, chapterOutlineSchemaV7, reviewParagraphSchema, StageOutputSchemas } from './stage-output.ts'
import { CURRENT_PROMPT_VERSION, type PromptVersion, type StagePromptKind } from './stage-prompts.ts'

const nativeFields = new Set(['type', 'required', 'additionalProperties', 'enum', 'const', 'description', 'title', 'default', 'examples'])
const hostConstraints = new Set(['minLength', 'minItems', 'pattern', 'exclusiveMinimum', 'maximum'])

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be a schema object`)
  return value as Record<string, unknown>
}

function project(value: unknown, path: string, ancestors: Set<object>): Record<string, unknown> {
  const source = record(value, path)
  if (ancestors.has(source)) throw new Error(`${path} contains a cyclic schema`)
  ancestors.add(source)
  const output: Record<string, unknown> = {}
  const constraints: string[] = []
  for (const key of Reflect.ownKeys(source)) {
    if (key === '~standard' && path === 'schema' && !Object.prototype.propertyIsEnumerable.call(source, key)) continue
    if (typeof key !== 'string') throw new Error(`${path} contains unsupported symbol metadata`)
    const field = source[key]
    if (key === '$schema' && path === 'schema' && typeof field === 'string') continue
    if (hostConstraints.has(key)) {
      if (key === 'pattern' ? typeof field !== 'string' : typeof field !== 'number' || !Number.isFinite(field)) {
        throw new Error(`${path}.${key} has an invalid host constraint`)
      }
      constraints.push(`${key}=${JSON.stringify(field)}`)
    } else if (nativeFields.has(key)) {
      output[key] = field
    } else if (key === 'properties') {
      output[key] = Object.fromEntries(Object.entries(record(field, `${path}.properties`)).map(([name, child]) => [name, project(child, `${path}.properties.${name}`, ancestors)]))
    } else if (key === 'items') {
      output[key] = project(field, `${path}.items`, ancestors)
    } else if (key === 'oneOf' && Array.isArray(field)) {
      output[key] = field.map((child, index) => project(child, `${path}.oneOf[${index}]`, ancestors))
    } else {
      throw new Error(`${path}.${key} is unsupported by native stage schema publication`)
    }
  }
  if (constraints.length > 0) {
    if (output.description !== undefined && typeof output.description !== 'string') throw new Error(`${path}.description must be a string`)
    const note = `Host validation requires ${constraints.join('; ')}.`
    output.description = output.description === undefined ? note : `${output.description} ${note}`
  }
  ancestors.delete(source)
  return output
}

/**
 * Adapt canonical JSON Schema to DSH's enforced structural subset.
 * @param schema - The stage compiler's object schema; unknown keywords reject.
 * @returns Native schema with host-only constraints preserved as descriptions.
 */
export function projectNativeStageSchema(schema: object): ObjectJsonSchema {
  const output = project(schema, 'schema', new Set())
  assertObjectJsonSchema(output)
  return output
}

/**
 * Publish a writing-stage output schema for native child capture.
 * @param kind - The canonical stage schema selected by the writing run.
 * @param promptVersion - The run's prompt version. Version 1 chapter outlines omit `stateNotes`. Versions before 7 still
 * require `targetWords`. Version 7 book and chapter outlines omit it, so the model is not asked for a word number.
 * Version 7 reviews cite `{ paragraphId, problem }` instead of a copied quote.
 * @returns An object-root schema; the caller must still run canonical admission.
 */
export function nativeStageOutputSchema(kind: StagePromptKind, promptVersion: PromptVersion = CURRENT_PROMPT_VERSION): ObjectJsonSchema {
  const outline = kind === 'book-outline' || kind === 'chapter-outline'
  const schema = outline && promptVersion >= 7
    ? kind === 'book-outline' ? bookOutlineSchemaV7 : chapterOutlineSchemaV7
    : kind === 'chapter-outline'
      ? promptVersion === 1 ? chapterOutlineSchemaV1 : chapterOutlineSchemaLegacy
      : kind === 'book-outline' ? bookOutlineSchemaLegacy
        : kind === 'review' && promptVersion >= 7 ? reviewParagraphSchema
          : StageOutputSchemas[kind]
  return projectNativeStageSchema(z.toJSONSchema(schema, { io: 'input' }))
}

/** @param code - g4 or g7. @returns Native object schema of that dimension's fixed checklist. */
export function openChecklistNativeSchema(code: OpenChecklistCode): ObjectJsonSchema {
  return projectNativeStageSchema(z.toJSONSchema(openChecklistModelSchema(code), { io: 'input' }))
}
