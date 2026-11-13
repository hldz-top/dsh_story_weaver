---
description: "Strict model-output schemas and version, evidence, scene, and obligation checks for writing stages."
---
# Stage output validation

## Summary

[stage-output.ts](../../src/stage-output.ts) parses decoded model JSON for settings, review, book outline, chapter outline, body, and continuity. Its exported TypeScript types and `StageOutputSchemas` define the fields. The host supplies expected versions and stage requirements; successful parsing returns a detached candidate without saving or applying it. [The writing specification](../specs/story-writing-plugin/spec.md) owns the complete review and application requirements.

## Model schemas and shared fields

`StageOutputSchemas` exposes `settings`, `review`, `book-outline`, `chapter-outline`, `body`, and `continuity`. Generate a model response schema with `z.toJSONSchema(StageOutputSchemas.settings, { io: 'input' })`. The input form preserves the JSON representation of identifiers that become branded TypeScript values during parsing. Always run the matching parser after receiving the model value: generated JSON Schema does not enforce relationships with host inputs or verify quotations.

Each parser accepts a decoded `unknown` value. It does not decode a JSON string, strip a Markdown fence, accept extra fields, insert defaults, or recover a partial result. All records are strict. Required prose is nonblank and preserves its original characters. The host owns configured artifact-byte limits for model outputs and source text; these parsers do not add deployment limits.

| Shared field or type | Meaning and checks |
| --- | --- |
| `version` | Required literal `1` in every stage output. |
| `inputRefs` | Nonempty array of `StageInputRef` values. Artifact IDs must be unique. The array must match the host's exact expected ID/hash pairs; reference order does not affect equality. |
| `StageInputRef.artifactId` | Existing branded writing-artifact ID, validated with the writing identifier parser. |
| `StageInputRef.sha256` | Required 64-character lowercase hexadecimal digest of the exact upstream artifact. The host obtains it from verified storage. |
| `EvidenceCitation` | `{ artifactId, quote }`, with a nonblank quote that must occur verbatim in the declared admitted source. Matching ignores only representation differences: Unicode compatibility forms (NFKC, so full-width and half-width forms match), whitespace and line breaks, typographic versus straight quote marks, and Markdown `*`/`` ` `` markers. For a JSON-stored source, the quote may also match its decoded string values, so a line break the model saw as a `\n` escape matches a real newline; a quote cannot span two JSON fields. Added, dropped or reworded characters, ellipses and joined passages still fail. |
| `EvidenceSource` | Host-supplied `{ artifactId, text }`. The host verifies the stored version before supplying its text; the parser checks quotation membership and admitted IDs. Source IDs must be unique. |

Quoting a real source does not establish that a model's interpretation is correct. Semantic review, mechanical chapter checks, input freshness at publication, cancellation, storage ownership, and final adoption remain host responsibilities.

## Settings dimensions

`parseSettingsDimensionOutput(value, { dimensionCode, inputRefs })` returns `SettingsDimensionOutput` for one selected dimension. The dimension must equal the host request; dependency planning and aggregation across selected dimensions belong to the settings planner and writing host.

| Output field | Meaning and checks |
| --- | --- |
| `dimensionCode` | Canonical lowercase code, matching the requested dimension. |
| `facts` | Nonempty array of `{ id, statement }`. Both strings are nonblank, and fact IDs are unique within the dimension. |
| `contentMarkdown` | Complete nonblank readable candidate content. |

This parser is structural, so stored candidates and replayed requests always parse under the rules that admitted them. `checkSettingsDimensionScope(output, kind)` adds the scope bound for a newly admitted [classification dimension](../specs/story-writing-plugin/CONTEXT.md). For `enum_single` and `enum_multi` it rejects more than 10 facts or more than 2,500 code points of `contentMarkdown` with a `StageValidationRejection` (formerly `StageOutputError`, still exported as an alias of the same class) that states the actual counts. For `llm_free` it accepts any size that the configured artifact limit allows. The writing service applies it only when it admits a new candidate, never on readback or idempotent replay.

## Review

`parseReviewOutput(value, { reviewed, inputRefs, requiredChecks, evidenceSources })` returns `ReviewOutput`. The host supplies the exact candidate reference in `reviewed`, the categories required for this stage, and source text for the candidate and admitted inputs. Every required category must appear. Additional supported categories are allowed; duplicate check categories and issue IDs are rejected.

| Output field | Meaning and checks |
| --- | --- |
| `reviewed` | Exact candidate `StageInputRef`; both ID and hash must match the host request. |
| `checks` | Nonempty array of `{ category, summary, evidence }`. Each summary is nonblank and each evidence array is nonempty. |
| `issues` | Array of `{ id, severity, category, location, message, evidence }`. IDs, locations, and messages are nonblank; evidence is nonempty. The array may be empty when the reviewer detects no issues. |
| `category` | `completeness`, `consistency`, `obligations`, `continuity`, `length`, or `style`. |
| `severity` | `advisory` for `style` issues; `blocking` for every other category. The parser rejects mismatched category/severity pairs without changing them. The host also enforces mandatory mechanical checks before adoption. |

All citations must identify either the exact reviewed candidate or a declared input, and their quotes must occur in supplied text. There is no model-authored approval field. The host derives whether a validated review permits progress from its issues and the independent mechanical checks.

## Book outline

`parseBookOutlineOutput(value, { inputRefs, chapterCount })` returns `BookOutlineOutput`. Chapters must appear in order from 1 through the exact requested count. Obligation IDs are unique across the entire book outline.

| Output field | Meaning and checks |
| --- | --- |
| `contentMarkdown` | Complete nonblank readable book plan. |
| `ending` | Nonblank intended resolution. |
| `characterArcs` | Nonempty array of `{ character, development }`, both nonblank. Character names are unique. |
| `chapters` | Nonempty ordered array of `{ chapterNumber, title, purpose, obligations }`. Chapter numbers are positive integers; titles and purposes are nonblank. |
| `obligations` | Explicit array of `{ id, description }` for the chapter. Both strings are nonblank; an empty array does not invent mandatory events. |

Prompt versions before 7 also stored a required `targetWords` on each chapter. Admission still accepts that historical field. Version 7 does not publish it, and the Markdown preview does not render it. The host counts the assembled body; an outline word number is not an acceptance check.

## Chapter outline

`parseChapterOutlineOutput(value, { inputRefs, chapterNumber, obligationIds })` returns `ChapterOutlineOutput`. The chapter number and complete set of obligation IDs must match the host request. Every required obligation must be assigned to at least one scene. Unknown obligation references are rejected.

| Output field | Meaning and checks |
| --- | --- |
| `chapterNumber` | Positive integer matching the requested chapter. |
| `title`, `throughLine` | Nonblank title and continuous line of action. |
| `targetWords` | Accepted when a version before 7 stored it. Version 7 does not publish the field, and the preview does not render it. It is not a per-scene ceiling and it does not replace the host body count. |
| `constraints` | Explicit array of nonblank constraints; may be empty. |
| `obligations` | `{ id, description }` entries with unique IDs matching the requested obligations. |
| `scenes` | Nonempty ordered array of `{ id, purpose, action, obligationIds }`. IDs, purposes, and actions are nonblank. Scene IDs are unique; a scene cannot repeat the same obligation ID. One obligation may span multiple scenes. |

## Body

`parseBodyOutput(value, { inputRefs, chapterNumber, sceneIds })` returns `BodyOutput`. Its fields beyond the shared fields are the positive integer `chapterNumber` and nonempty `scenes` array. Each scene contains only `{ sceneId, text }`, with nonblank strings. Scene IDs must match the host's complete ordered list exactly; missing, extra, repeated, or reordered scenes are rejected.

The parser preserves scene text without assembling it, counting it, or inserting titles and review reports. Short or long prose remains a candidate that the host may retain for repair. Only the host's final assembled-body counter determines whether the configured chapter length is satisfied.

## Continuity

`parseContinuityOutput(value, { inputRefs, chapterNumber, obligationIds, evidenceSources, reviewedBodyId })` returns `ContinuityOutput`. The exact reviewed body must be a declared input and have supplied source text. The host supplies actual previous continuity and reviewed body as factual evidence sources; planned events must not be admitted as evidence of completed events.

| Output field | Meaning and checks |
| --- | --- |
| `chapterNumber` | Positive integer matching the requested chapter. |
| `summary` | Nonblank proposed chapter summary, still subject to semantic review. |
| `characters` | Explicit array of `{ name, state }` with nonblank strings and unique names. States remain proposed claims until reviewed. |
| `timeline` | Explicit array of `{ event, evidence }`. Events are nonblank, and each evidence array is nonempty with verified quotations. |
| `obligations` | Complete array of `{ id, status, explanation, evidence }` with unique IDs matching the host request. Status is `open` or `fulfilled`; explanation is nonblank. |

Every fulfilled obligation requires at least one citation quoting the actual reviewed body identified by `reviewedBodyId`. A citation of an outline alone cannot establish fulfillment. Open obligations may contain an empty evidence array but must explain why they remain open; the parser does not manufacture a quotation for an event that has not occurred. Any supplied citation is still checked. Applying reviewed continuity together with the body and obligation outcomes is the writing host's responsibility.

## Failures and focused validation

Every rejection is a `StageValidationRejection` from [`src/stage-rejection.ts`](../../src/stage-rejection.ts) that names the offending item and the actual versus allowed value. Invalid fields are summarized per path (`<label> does not match its output schema: path: message; …`, at most eight paths). Wrong versions list the missing and unexpected `artifactId@sha` prefixes; missing required checks list the categories; duplicate identifiers echo the value; chapter, scene and obligation mismatches state expected and received values. A rejected quotation names the cited artifact and echoes the quote (truncated to 120 code points), so the runner's repair prompt identifies exactly which citation to correct. No failure returns an approved or applied value.

The public parser suite is `tests/stage-output.spec.ts`. Run it with the installed toolchain:

```sh
node node_modules/vitest/vitest.mjs run tests/stage-output.spec.ts --configLoader runner --cache=false
```

These tests validate admission and schema generation. They do not establish model quality, persistence, complete writing execution, or browser acceptance.
