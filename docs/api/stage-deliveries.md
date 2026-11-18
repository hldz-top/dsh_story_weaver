---
description: "Generic native full-document delivery, four-kind automatic runner policy and durable historical replay."
---
# Writing-stage deliveries

## Summary

The [stage publisher](../../src/stage-deliveries.ts) makes an exact stored version accessible from its owning Story tool card. It materializes the complete immutable Markdown projection, executes the Host's native `present` tool, verifies the committed delivery event, and awaits Session durability. Publication does not request human review or change an artifact's candidate, reviewed, or applied state.

The automatic [runner policy](writing-runner.md#stage-presentation) selects only `settings`, `book-outline`, `chapter-outline` and `body`. A complete settings collection is distinct from an individual settings dimension. Eligible candidate and repair versions may appear before application. A fresh three-chapter run without repairs produces eight documents. Research, dimensions, reviews and continuity remain available for audits and explicit reads; the automatic runner does not publish them. Rejected raw responses are not published.

The [native API investigation](../research/stage-artifact-presentation.md) and [dependency record](../development/stage-preview-dependencies.md) explain the released DSH interfaces. Final browser and installation acceptance remain in [migration validation](../development/migration-validation.md).

## Host commands and ownership

Call `registerStageDeliveryProjection(ctx)` once in the plugin's owning scope. Its effect registers a pure fold and Client view under `story-stage-deliveries`; disposal removes the registration. Construct `StageDeliveries(ctx, service, runs, directory)` with the existing Host capabilities, artifact authority, run authority, and validated relative preview directory. The constructor neither mounts a replacement tool nor supplies defaults.

| Method | Required inputs | Completion |
| --- | --- | --- |
| `publishArtifact` | Actual owning `ToolExecution`, exact `runId`, its `novelId`, published `artifactId`. | Full artifact preview and native delivery are durable. |

`publishArtifact` returns `Promise<void>` and propagates failures. It is a generic publisher API that can render stored artifact kinds beyond the four automatic kinds; its availability does not authorize automatic display of internal results. Rejected outputs are not published. The runner owns its four-kind selection and awaits each eligible publication before continuing the dependent stage. Its existing cancellation and shutdown lifecycle owns in-flight publication; the publisher starts no detached work. The Host must supply native tools, filesystem, Session storage, and Session projections. Availability of `present` is checked in the actual Agent scope; its normal runtime policy and cancellation still apply.

Artifact publication verifies workspace ownership, run/novel association, the exact stored artifact and its projection. Descriptions identify the actual artifact kind, dimension or chapter where applicable, and revision. Review descriptions identify the exact reviewed artifact. Research, candidates, reviews and repaired versions retain their own identities.

Rejected outputs are not published. The raw response stays in the run store and is read explicitly through `RunStore.readOutput`.

Artifact preview paths use the [existing projection owner](../../src/projection.ts): resolve within the calling workspace, apply its filesystem policy, and publish the current rendering. A missing file is created. A file that exactly matches an earlier derived rendering is replaced in place. A file with any other bytes is left verbatim and the current rendering is written to a separate path, which is what the delivery presents. Escaped paths fail without changing authoritative content. The Markdown read compares the complete file, not a prefix. The Markdown read limit uses its actual rendered byte length, including metadata, rather than the underlying JSON artifact size.

## Native event and replay

Every actual nested invocation receives a fresh opaque `ToolCallId` under `dsh-story-present/v1/`. Its encoded segments identify the owning Story call, run, source kind, exact source ID, and nonce. The invocation retains the original `rootCallId`, opaque parent token, Agent and cancellation signal. It creates no fabricated model `tool/call` or `tool/result` events and appends no custom Session event.

A successful first native return must have exactly one matching `deliverables/presented` event with the expected open turn, call ID, path and description. Only then does publication await `ctx.sessions.flush`. A reported success without that event is a failure. A later publish of the same source reuses that receipt when the path and description still match. When the recorded file was edited and the current projection moved to a separate path, a new present event updates the card path; the edited file stays. Completed concurrent deliveries remain separate; requests for the same source under one Session and owning Story call share pending work.

Deduplication uses the owning call, run and exact source. A new owning tool call can receive a new delivery for the same historical version. The runner republishes only eligible exact saved versions when recovering or skipping completed work; this service does not traverse other Sessions or replay completed model requests. Cold projection reads reconstruct the card list from built-in delivery events, including historical internal-result or rejected-output deliveries recorded before the four-kind policy. No Client filter erases those receipts. A run receipt is not a substitute for that durable event.

## Client fields

The [browser-safe parser](../../src/stage-delivery.ts) accepts a complete versioned value. Unsupported versions, missing or extra fields, malformed entries, and duplicate owner groups reject the whole value; invalid rows are not silently dropped.

| Field | Meaning |
| --- | --- |
| `version` | Wire version, exactly `1`. |
| `calls` | Ordered list of owner groups; empty before any delivery. |
| `calls[].callId` | Actual Story tool call identity, unique within the value. |
| `calls[].deliveries` | Completed deliveries in their committed event order. |
| `runId` | Durable writing run owning the source. |
| `source.kind` | Exactly `artifact` or `rejected-output`. |
| `source.artifactId` | Required only for an immutable writing artifact. |
| `source.attemptId` | Required only for a historical rejected raw response receipt. |
| `path` | Exact nonblank file path, passed unchanged to the Session's `openFile`. |
| `description` | Recorded nonblank human description of the delivered version. |
| `eventSeq` | Nonnegative safe integer identifying its native delivery event. |

The existing Story card reads this projection through `useProjection`, selects its exact `callId`, and opens files only on user action. Parent-tool failure or stop does not remove earlier version links. The projection is rebuildable display data; authoritative writing content remains in the writing store, and raw rejected responses remain in the run store.

## Local evidence

The focused public-runtime suite covers complete file readback, native delivery persisted before the parent tool result, JSONL cold projection replay, parallel deduplication, deleted-file reconstruction, distinct versions, edited-file refusal, policy denial, cancellation quiescence, missing native receipts and a new owning call. The existing six projection regressions remain included.

```sh
node node_modules/vitest/vitest.mjs run tests/stage-delivery.spec.ts tests/stage-deliveries.spec.ts tests/projection.spec.ts --configLoader runner --cache=false
```

Before the automatic display scope was narrowed on 2026-09-11, this command passed 24 tests. Host type checking and scoped `oxlint` also passed. This evidence describes the generic publisher and predates verification of the four-kind runner policy. These deterministic local checks do not establish real-model quality, an actual process-kill recovery, completed browser acceptance, or private package installation.
