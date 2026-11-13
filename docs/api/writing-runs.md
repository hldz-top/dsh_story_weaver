---
description: "Durable writing-run requests, native stage attempts, raw outputs, interruption recovery and retry authorization."
---
# Writing runs

## Scope and field authority

The [run store](../../src/run-store.ts) saves writing progress through the existing DSH `DomainFacility`. Its domain is `story_runs`, version `1`, layout `single`, with per-novel histories and separate immutable raw-output records. The plugin-owned novel-run record marker is version `2`; the host domain generation remains `1`. It supports the installed JSON and SQLite providers without adding a database runtime. [The writing specification](../specs/story-writing-plugin/spec.md) owns the complete writing workflow; this module does not execute models, review writing or publish manuscript versions.

Exported TypeScript types and strict record schemas in the module own field types and requiredness. All operations require an `Actor` from [the writing service types](../../src/contracts.ts). `workspace` authorizes access; `sessionId` records the initiating or resuming Session. Sessions in the same workspace may inspect and resume the same novel. Callers first verify that the novel, brief and input artifacts belong to that workspace and that requested settings codes are enabled in the catalog.

## Requests and immutable limits

`openRunStore(facility, limits)` opens one exclusively owned domain handle. Both `maxAttempts` and `maxOutputBytes` must be positive safe integers. A run captures these values in its `limits`; changing configuration does not increase an existing run's retry or output budget. `readOutput` uses the original run limit, so lowering configuration restricts new runs without preventing reuse of existing saved output.

`begin(actor, input)` admits these fields:

| Field | Source and meaning |
| --- | --- |
| `novelId` | Exact novel whose history owns the run. |
| `requestId` | Caller-supplied idempotency key, scoped to that novel. Repeating it returns the original run; changing any requested field rejects. |
| `briefArtifactId` | Exact creative-brief version selected by the caller. The store does not resolve a newer brief. |
| `settingsRoots` | Nonempty, unique dimension codes. The caller owns catalog validation and dependency planning. Array order remains part of request identity. |
| `chapterCount` | Total planned book chapters. |
| `fromChapter`, `throughChapter` | Inclusive requested range satisfying `1 <= fromChapter <= throughChapter <= chapterCount`. |
| `mode` | Explicit `write`, `update` or `revise` intent. Downstream impact admission belongs to the writing service. |
| `revision` | Required `null` for write/update; required `{baseArtifactId, instructions}` for revise. The exact source version and nonblank, well-formed Unicode instructions remain part of request identity. Instruction UTF-8 bytes cannot exceed the captured `maxOutputBytes`. |
| `executionLimits` | Required execution snapshot described below, reused by the runner after resume. |
| `serviceLimits` | Required non-null `RunServiceLimits` for every new request: exact writing and research admission bounds. It remains part of request identity. |

`executionLimits` contains `maxRepairAttempts` (a nonnegative safe integer), positive safe integers `maxParallelStages`, `maxStageRequests`, `stageTimeoutMs`, `maxDelegationDepth`, `minChapterWords` and `maxChapterWords`, an optional positive `settingsCandidateCount`, and a nonblank `stageProvider`. The timeout cannot exceed `2147483647` milliseconds, and the minimum word count cannot exceed the maximum. `settingsCandidateCount` is how many comparison drafts a new settings batch captures; the default `1` keeps one draft. It does not change how many dimensions run together: that width is `maxParallelStages` on a run that already started the per-dimension path, including when the recorded count is 1. A resumed per-dimension run still generates this many candidates on each dimension's first pass. New runs record `1`. Records written before the field omit it; that older path then generates one candidate per dimension and still uses `maxParallelStages` as its width. Planning stages use a 600000 millisecond deadline. Settings candidates, settings batch drafts, and a continuity snapshot's first candidate use 600000. The first book-outline, chapter-outline, and continuity candidate uses 1200000; their later candidates use the 900000 repair deadline. Review children use 1200000, body generation 1800000, and repair stages 900000. A settings batch draft uses the candidate deadline, a batch consistency review uses the review deadline, and a targeted settings repair uses the repair deadline. Each of those graded stages records one published execution timeout as unknown and replaces that key once; a second timeout fails closed. `story_stop` cancels immediately and does not authorize the replacement. Research execution keeps `stageTimeoutMs` and does not take that timeout retry. `stageProvider` identifies the native subagent provider; it is not a model selector. The runner owns enforcement of these execution settings and the required chapter-counting rule. A revise request identifies an upstream change without authorizing downstream rewriting; the runner checks that the requested base artifact is revisable. Retrying an identical revise request preserves the original source and instructions.

`RunServiceLimits` contains positive safe integers `maxArtifactBytes`, `maxReadChars`, `maxResearchQuestions`, `maxResearchCalls`, `maxResearchSources`, `maxEvidenceChars` and `maxResearchLogEvents`. Unknown fields reject. Capture these exact values from the writing service when beginning a run; model/tool arguments do not choose them. The runner must compare the snapshot and chapter bounds with the mounted service before changing durable state for begin replay or resume. A mismatch requires restoring the recorded configuration rather than silently applying new admission rules to saved output.

`WritingRun.serviceLimits` is required but nullable for explicitly migrated legacy history only. `WritingRun` adds a branded `id`, `status`, `startedBy`, `lastResumedBy`, `attempts`, `limits` and nullable `error`. Reads return detached metadata without prompts, response schemas or raw output text. `get(actor, runId)` reads an exact run; `list(actor, novelId)` returns creation-ordered history, or an empty list when that novel has no run history.

## Attempts and raw outputs

The runner must retain exclusive in-process ownership of an active run. The store serializes mutations and coalesces identical writes; returning an existing prepared or running attempt does not authorize a second native invocation.

| Operation | Persistence and return behavior |
| --- | --- |
| `prepareAttempt(actor, runId, input)` | Persists a prepared attempt before native startup. `input` contains `key`, `prompt`, exact `{artifactId, sha256}` `inputRefs` and an object `outputSchema` supported by DSH. Keys have 1–256 characters; prompts and input lists are nonempty; input artifact IDs are unique. An existing key must retain exactly the same request. |
| `associateChild(actor, runId, attemptId, childSessionId)` | Associates the actual native child and marks the attempt running. The caller awaits this operation from the executor's `onStarted` callback before streaming. A child cannot belong to multiple attempts. Repeating the same active association is idempotent. |
| `saveOutput(actor, runId, attemptId, text)` | Saves the exact raw string under the attempt ID, then publishes its output reference in the novel's queued update. Conflicting content rejects; concurrent identical saves share their result. |
| `readOutput(actor, runId, attemptId)` | Explicitly returns the complete saved raw string and its metadata after checking ownership, reference identity, SHA-256, UTF-8 bytes and Unicode code-point count. It rejects oversized reads instead of truncating parser input. |
| `failAttempt(actor, runId, attemptId, failure)` | Records `outcome: 'failed'` or `'unknown'` and a nonblank `message` on an active attempt. The caller classifies the actual native outcome after its work settles. A completed raw-output attempt cannot be rewritten as failed. |

`WritingAttempt` contains a branded `id`, immutable `parentSessionId` captured from the preparing actor, `key`, `status`, exact `inputRefs`, nullable `childSessionId`, nullable `output`, nullable `error`, `retryAuthorized`, and, only on a known failed attempt whose model response was declined or cut off, `failureKind` (`refused` or `truncated`). `failAttempt` accepts that classification only with `outcome: 'failed'`; a stored classification on any other status is rejected as corrupt. Records written before this field existed omit it and remain valid. Reusing an attempt retains its original parent Session; an authorized replacement records the new preparing Session. The runner must check persisted child-log ancestry against this original parent, even when another Session resumes the run. The full prompt and schema remain in the durable attempt record. `RunOutputRef` contains `attemptId`, `sha256`, `bytes` and `chars`; `RunOutput` additionally contains `runId` and `text`. SHA-256 covers the full UTF-8 string. Ill-formed Unicode and mismatched stored counts or digests reject.

An attempt's `succeeded` state means its raw native output is durable. It does not mean the model JSON, writing facts or review findings passed admission. The runner serializes structured output with `JSON.stringify`, parses saved output through the stage-specific parser, and gives a changed repair prompt a distinct stage key. It owns candidate adoption and atomic chapter/continuity publication through the writing service.

## Legacy record migration

The explicit version-1 decoder accepts the former complete record format and adds `serviceLimits: null` to its runs. No original writing or research limit can be reconstructed from that format. Opening first validates every record, reference and raw output, then writes version-2 record markers and recovery changes. Corrupt legacy content fails before any migration write. Existing request identities, prompts, attempts, child lineage, outputs and available execution/storage limits remain intact.

Legacy histories and saved raw outputs remain readable. `resume`, `prepareAttempt` and `begin` replay for a run with a null snapshot reject `run-limits` without changing its status or retry authorization. Setting the current configuration cannot supply missing historical values. An unfinished legacy run still occupies its novel's active slot; the author can explicitly stop it and submit a distinct new request with captured limits. This preserves history without claiming that a new run reuses the old request's unknown policy.

## Interruption, retry and completion

Only one run per novel may be `running` or `interrupted`. Both occupy the unfinished-run slot. The store uses the host domain's existing write queue; this guarantee applies to one open facility and does not establish cross-process writer safety.

Opening the store validates every durable record and its relationships before writing recovery changes. A persisted running run becomes interrupted. Prepared or running attempts without saved output become `unknown`, including attempts whose native startup may never have occurred. This state makes no claim about provider execution or cost.

A valid raw-output record left durable before its reference update is recovered only for its exact associated attempt ID. Corrupt or missing referenced content, conflicting identities, unsupported stored response schemas, duplicate children and inconsistent statuses fail admission. Recovery never replaces a conflicting published reference with a guessed value.

`resume(actor, runId, {retryUnknown})` first reconciles already saved outputs. If any latest stage attempt remains unknown, `retryUnknown: false` rejects. Explicit `true` authorizes a new attempt for that exact stage request; preparing it consumes the authorization and retains the original unknown attempt in history. Known failed attempts may be replaced within the captured attempt budget. Saved succeeded attempts are reused. Earlier failed or unknown attempts that have a successful replacement do not prevent completion. Completed runs cannot resume, and another unfinished run prevents resuming an older failed or stopped run.

`finish(actor, runId, status, message?)` records `completed`, `failed` or `stopped`. Completion requires every latest attempted stage to have saved output; verification that all requested manuscript stages actually exist belongs to the runner. Failed or stopped runs retain their history and mark remaining active attempts unknown. A repeated identical final status and reason is idempotent; changing a terminal result requires resume.

Cancellation is checked before writes and again inside queued updates. The caller prevents new work, propagates cancellation to native execution and awaits quiescence before terminal cleanup. It may use the same workspace/Session actor without an aborted signal to save that cleanup. `close()` drains accepted domain writes and releases the handle; it neither cancels nor waits for external native execution.

## Validation evidence

The [public tests](../../tests/run-store.spec.ts) use [isolated installed JSON and SQLite providers](../../tests/support/run-storage.ts). On 2026-09-11 the focused suite passed 66 tests, covering concurrent admission, captured budgets, queued cancellation, exact child identity, immutable raw outputs, unknown retries, terminal history and actual JSON corruption, exact revision intent and old-output reuse after decreasing configuration, exact service-limit snapshots, version-1 JSON/SQLite migration, missing-limit refusal and corrupted-record rejection before migration writes. The orphan-output case aborts at a real post-durability domain event, then reopens the provider. It does not simulate a killed OS process or execute a model.

```sh
node node_modules/vitest/vitest.mjs run tests/run-store.spec.ts --configLoader runner --cache=false
node node_modules/oxlint/bin/oxlint src/run-store.ts tests/run-store.spec.ts tests/support/run-storage.ts
```

These tests establish the storage module's behavior. Native execution, full writing orchestration, process-termination recovery, browser acceptance and real-model writing quality require their own integration evidence.
