---
description: "Research prompt preparation and persisted native child result admission."
---
# Research stage

[`src/research-stage.ts`](../../src/research-stage.ts) prepares one research task and validates its saved result. The shared [stage executor](stage-execution.md) owns child execution; the writing run owns provisioning, child association, raw-output persistence and advancement. The helper starts no AgentLoop, model request or research plan.

## Public inputs and outputs

| Export or field | Source and downstream use |
| --- | --- |
| `ResearchStageRequest.parentSessionId` | Original parent Session persisted with the attempt before child creation. Admission checks the child’s durable lineage against this identity, independently of the Session performing resume. |
| `novelId` | The run's exact owned novel; passed to artifact and research tools and checked by the writing service. |
| `briefArtifactId` | The exact creative brief selected before child creation; used by the native start request and checked again against the current brief at admission. |
| `purpose` | Host-selected research purpose, quoted as task data rather than privileged instructions. |
| `necessity` | The locally captured [research necessity](research-planning.md) decision for a new stage. It freezes the questions and controls web permission. Omitted only for a legacy attempt without a prior planning capture. |
| `inputs` | Exact public `ArtifactRef` values, including the creative brief. Every ID, kind, revision, digest and size must match its immutable stored artifact. Other input freshness rules remain the writing run's responsibility. |
| `requestId` | Persisted research idempotency identity. The prompt uses these exact bytes for start and completion. Admission requires the original successful native start call for this identity, novel, brief and plan. |
| `RESEARCH_STAGE_TOOLS` | The complete research tool set: `story_read_artifact`, `story_start_research`, `story_get_research`, `story_research_results`, `story_read_research_source`, `story_complete_research`, `web_search` and `web_fetch`. `researchStageTools(request)` excludes both web tools for `input-only` decisions, except a settings request with `settingsRetrieval`, which keeps and authorizes them after the host has invoked official retrieval. Native `structured_output` is supplied by DSH. |
| `RESEARCH_STAGE_OUTPUT_SCHEMA` | Strict object-root JSON Schema with the sole required string field `planId`. Admission additionally parses the public artifact identifier format and rejects extra fields. |
| `ResearchStageResult.childSessionId` | The disposed native child whose persisted Session supplies the start receipt and research ownership. |
| `planId` | The exact admitted plan artifact identity. |
| `evidence` | The existing immutable `ArtifactRef<'research-evidence'>`; no new evidence document is created during admission. |

`ArtifactRef` fields and research records are defined by the [public types](../../src/contracts.ts) and [research service](research.md).

## Preparation and durable execution

`buildResearchPrompt(request): string` emits business instructions followed by `TASK_DATA` and JSON containing `kind: 'research'`, `novelId`, `briefArtifactId`, `purpose`, `inputs`, `requestId` and the admitted `necessity` when present. The validation-only `parentSessionId` is omitted so a new parent can replace an authorized outcome-unknown attempt without changing its exact prompt bytes. It requires exact artifact pages and uses the frozen questions for new stages. Legacy prompts retain their question-classification instructions. The child starts the plan before native web calls, reads the bounded recorded-source index and pages, and maps findings to selected evidence from actual logged call IDs. It requires honest inadequacy reporting; an invented source, missing read or unresolved finding cannot establish completion. One narrow exception applies to settings research: a question that asks for the program's option list or other host internals is answered from `TASK_DATA` as a creative choice, because the catalog entry is the complete definition and has no option list. Supplied story facts, unread inputs and real-world facts keep the honesty rule. Source text and task prose cannot change tool permissions or finite budgets.

The writing run persists its request and attempt before invoking `executeStage`. It passes `buildResearchPrompt(request)`, `RESEARCH_STAGE_OUTPUT_SCHEMA`, its durable `onStarted` callback, the verified in-process spawn provider and the scope-selected research tool allow list and `researchToolAuthorization` callback. The executor inherits the parent model route and enforces its configured request, depth and time limits. Existing research limits independently bound questions, web calls, source excerpts and log events.

`researchToolAuthorization(ctx, service, request)` checks this child's native tool arguments before side effects. New stages must start the exact frozen novel, brief, request and questions; external calls require an active matching plan owned by this child. Input-only outline and body decisions never authorize web calls. A settings decision marked `settingsRetrieval` authorizes `web_search` and `web_fetch` even when the frozen plan is input-only, because the host has already invoked those official tools. The executor scopes this callback to the recorded child and disposes it after execution; DSH's normal tool-error correction remains available.

After execution and child disposal, the writing run saves the raw `StageResult` before calling `validateResearchStageResult(ctx, exec, service, request, result)`. A restart can load that saved result and call the same validator without starting another child or repeating a web request. Missing child persistence remains a failure; the helper does not substitute an active Session or silently rerun research.

## Admission

`ctx` supplies native Session persistence and filesystem resolution; `exec` supplies the current calling Agent, workspace and cancellation signal; `service` is the existing writing-service owner. The request must be the version stored for this attempt, and the result must retain the child identity recorded by `onStarted`. The writing run verifies that durable association and supplies the stored original `parentSessionId` before calling the helper. A different Session may resume the saved attempt within the same authorized workspace.

The validator resolves workspace ownership, parses the strict output, and checks that the plan belongs to the recorded child. It opens that child's persisted Session after disposal, requires an unseeded direct child of the stored original parent and one native continuable descriptor, and reads at most `maxResearchLogEvents + 1` events. An extra event rejects the log as over budget. Admission requires exactly one successful original `story_start_research` receipt whose arguments, returned plan, child, questions and start sequence match the service record and saved request. The recorded result must identify its preceding native call through the call ID, turn, step and source-event linkage. Later idempotent start replays do not replace the original receipt.

After the read handle closes, the validator rechecks the current service record and all input references. For a frozen necessity decision, the plan questions must exactly match the captured questions. The plan must remain current and completed with `succeeded` or `not-needed`, and have a readable evidence artifact. Findings are reclassified with the existing research classifier and must match the stored classification. Every finding must also have `adequate: true`, including internal and creative questions; an unresolved fictional choice is not accepted merely because external lookup was unnecessary.

These checks admit service-owned evidence produced by the native research tools. They do not independently judge literary relevance or source truth. The writing run still compares its own current input and attempt state before committing the admitted result or advancing another stage.

## Failures and verification

Defects of the child's own work raise one repairable [`StageValidationRejection`](writing-runner.md#output-admission-and-repair) with a specific message: structured output that does not match `{planId}`, a planId that names no plan of this novel or another child's plan, questions that differ from the frozen decision, a missing or ambiguous `story_start_research` receipt for this request, an incomplete or failed/insufficient plan, and findings that are inadequate (listing the question ids) or disagree with the host's classification. The runner replaces the whole research child under `<key>/repair/<n>` with a new request identifier and the rejection appended to its prompt (`buildResearchPrompt(request, validationError)`; the first prompt is unchanged). Cancellation, missing persistence, a non-direct or seeded child, missing continuable descriptor, excessive logs, a start result not linked to its call, a changed brief or input reference remain non-repairable failures with their existing error codes. Session read handles close before admission returns.

[`tests/research-stage.spec.ts`](../../tests/research-stage.spec.ts) contains focused cases using actual DSH ToolRuntime, AgentLoop, in-process spawn, JSON storage and JSONL Session persistence. External-research cases mount native web tools with deterministic local retrieval providers; no source observations are inserted directly. Tests cover exact task-data quoting, creative and external success, actual fetched-result bytes, different start request IDs, unresolved findings, changed input digests, saved-result readback, incomplete/failed/insufficient plans, brief changes, child attribution, same-workspace cross-Session resume, wrong original-parent rejection, stable prompt bytes across parent changes, bounded logs, malformed output, omitted brief inputs and cancellation. Additional cases verify exact frozen-question enforcement before plan creation, web denial before the matching plan exists and input-only tool visibility. Native child disposal is checked before every admission.

Run `node node_modules/vitest/vitest.mjs run tests/research-stage.spec.ts --configLoader runner --cache=false`. Real-model quality, browser preview reopening and full writing acceptance remain in [post-development validation](../development/post-development-validation.md).
