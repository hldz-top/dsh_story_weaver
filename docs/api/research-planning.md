---
description: "Local research necessity capture and frozen retrieval permissions for native writing stages."
---
# Research necessity

## Summary

Every new writing research stage first uses a native child that can read the exact local inputs and return structured output. The runner saves this decision before admitting retrieval. Author-defined genre, tone and fictional choices resolve from those inputs; only missing real-world facts required by the assigned output authorize external research. The [research API](research.md) owns evidence retrieval and completion.

## Table of Contents

- [Decision and inputs](#decision-and-inputs)
- [Execution and persistence](#execution-and-persistence)
- [Failure and compatibility](#failure-and-compatibility)

## Decision and inputs

The runner records `novelId`, `briefArtifactId`, `requestId`, the assigned `purpose`, the exact `outputTarget` and immutable `inputs` in the planning prompt. A settings target identifies its dimension and catalog entry; a manuscript target identifies its kind and chapter scope. The catalog entry is the complete dimension definition: its kind states only the output form (one label, a short set of labels or free-form facts), and it has no predefined option list. The prompt therefore treats label choice as a creative question and forbids questions about host program internals, such as option lists, schemas, validation rules, counting implementation or tools. Every internal question must be answerable from the supplied inputs. Revision targets also carry the revision instructions. Input references include artifact identity, kind, revision, digest, character count and byte count. The host reads those artifacts and appends their exact text after the versioned instructions. The supplied creative brief and accepted dependency artifacts are the authoritative story sources.

[researchNecessitySchema](../../src/research-planning.ts) defines the captured output. `mode` is `input-only` or `external-required`; `reason` explains the decision. `questions` contains the existing research question fields. `externalRequirements` contains exactly one entry for each external question, associating its `questionId` with the unresolved `outputDecision` and `missingFact`. Internal and creative questions have no external requirement. Duplicate identifiers, inconsistent mode, missing requirement entries and excess questions or text reject admission. Question count uses `maxResearchQuestions` per plan, counting internal, creative and external questions together; all decision text together uses `maxEvidenceChars`, measured in Unicode code points. Rejection messages state the measured count and the limit.

An author's declared genre is a creative constraint. Optional market classification or genre-convention research does not become a prerequisite merely because it could provide background. A requested accurate real-world detail that the accepted inputs do not establish remains a required external question. The host validates the captured structure and permission decision; whether a particular fact is necessary remains a model judgment that needs real-model acceptance evidence.

A settings dimension does not prefer `input-only` merely to avoid official retrieval. When a verifiable real-world fact would ground that dimension and the inputs do not establish it, the planner is asked for `external-required` and for the host tools `web_search` and `web_fetch`. The plugin does not choose the provider. Outline and body planning keep the rule that a useful but optional reference is not a required question.

## Execution and persistence

The runner stores a planning attempt under the research key with `/planning` appended. Planning does not start a subagent. It calls `ctx.llm` once on the parent Agent's selected model, with the inlined inputs and no tools, then aggregates that stream. The model-visible prompt and raw reply are written into the current Session workspace. The attempt stores a generation receipt rather than a child Session. Model route, the single-request bound, deadline and cancellation use the direct stage path in [stage execution](stage-execution.md). The prompt, exact input references and raw output remain in the run history. Invalid captures remain available for diagnosis.

A successful planning capture is parsed before the retrieval child starts. A capture that fails admission (schema, excess questions or text, duplicate question ids, inconsistent external requirements) raises a `StageValidationRejection` naming the counts or ids involved; it is a defect of that model value, not a fatal run error: the runner starts a replacement planning request under `<key>/planning/<n>`, up to `maxRepairAttempts` replacements, whose prompt adds the host's rejection message and restates the question limit. The first planning prompt is unchanged, so retained runs still replay their saved captures. Exhaustion fails the run with `Research planning repair limit was exhausted: <message>`. The runner quotes the admitted decision in that child's prompt and requires `story_start_research` to reproduce the exact novel, brief, request identifier and questions. A child-scoped native `tools/execute` admission check rejects mismatches before the service writes a plan. It also refuses web execution until this child owns the exact active plan. Input-only outline and body children receive local research tools without `web_search` or `web_fetch`; the service independently rejects web reservations for plans without external questions. Settings research is the exception: when `web_search` and `web_fetch` are registered and admitted, the runner invokes them through the host tool registry before the research child, leaves them authorized for that child, and passes any returned excerpts to the settings writer. The research plan then completes from the inputs, so that host call is not cited as a child reservation; an external planner decision is reclassified as local for that completion. A missing registration, a provider-unavailable error such as `WEB_PROVIDER_UNAVAILABLE`, or a quota or billing failure (including HTTP 402) skips that retrieval and continues from the inputs the same way. That skip does not fail the settings layer or its admission. Any other retrieval failure still fails the layer. A resumed settings attempt reuses the stored research prompt and does not send the official call again.

Research completion still requires adequate findings for every planned question. The runner independently verifies the persisted plan's questions against the frozen decision and admits only completed, current evidence owned by the exact native child and start receipt. There is no additional AgentLoop, provider route, retrieval runtime or automatic replacement plan.

## Failure and compatibility

A captured invalid decision stops the stage before retrieval. Native tool-argument correction and request retry behavior remain owned by DSH. Failure does not reclassify an external question, enlarge a budget or replace a failed plan. A terminal writing run is not automatically resubmitted.

An existing research attempt without a planning attempt retains its original prompt and question-admission path. The runner does not insert a new decision into that historical attempt. New attempts persist planning before retrieval, and an explicitly resumed run reuses saved planning output under the existing immutable request checks. The planning capture uses run storage rather than changing historical research plan content; evidence content version compatibility is documented in the research API.

Offline regressions exercise complete native child execution, persisted planning, malformed decisions, frozen start arguments, pre-plan retrieval denial, input-only tool visibility and disposal. They establish implementation behavior, not the quality of the model's necessity judgments or completion of a real novel.
