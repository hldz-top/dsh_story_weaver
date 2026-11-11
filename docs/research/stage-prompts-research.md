---
description: "Source-backed business prompt migration from Story V2 into native DSH writing stages."
---
# Stage prompt migration

The pure [prompt builder](../../src/stage-prompts.ts) supplies English instructions for settings, review, book outline, chapter outline, body and final continuity. Author text remains in its original language inside JSON task data. This is a prompt migration and fixture validation result; it does not establish native child execution, completed writing runs or real-model literary quality.

## Evidence and confidence

Source inspection on 2026-09-11 used current local files without importing Story, connecting to its database or calling a model. The inline V2 roles below are the executed business-prompt sources for this migration. The older files under `prompts/` are not assumed to be V2 runtime inputs. SHA-256 fingerprints identify the actual files inspected, including uncommitted changes.

| Story source | Inspected role definitions | File SHA-256 |
| --- | --- | --- |
| [settings_graph.py](../../../story_weaver/app/services/writing_pipeline/settings_graph.py) | Lines 825–953: needs, dimension, reviewer and patcher | `26de94810b16f4e9c7618ba7246f32f13af8e0dbdee503b40b8438bff3ad11c2` |
| [outline_graph.py](../../../story_weaver/app/services/writing_pipeline/outline_graph.py) | Lines 1202–1436: research, proposal, structure, market and patching | `84f52224311702bceb827d268d95f069ff8e634793c60475a318e80283e2e655` |
| [chapter_outline_graph.py](../../../story_weaver/app/services/writing_pipeline/chapter_outline_graph.py) | Lines 2124–2321: continuity, research, proposal, review and adjudication | `e76afffc51cf3b8734657775d3d22b3ab54da857aba58140ee36a6af65505982` |
| [body_graph.py](../../../story_weaver/app/services/writing_pipeline/body_graph.py) | Lines 503–623: scene proposal, full-chapter review and targeted repair | `ff66ce0459cb9b91c42a4c6b629c55ac2efd61260fce9b620b26b53dda212571` |
| [body_lifecycle_graph.py](../../../story_weaver/app/services/writing_pipeline/body_lifecycle_graph.py) | Lines 208–269: body quality and final continuity proposal, review and repair | `24b65d09b84a4a11548d1a92a79d3513df3b0fd28ccf88a9811872cf4b00e516` |

Confidence is high for the inspected source wording and DSH reader field mapping. Prompt effectiveness remains unmeasured until native deterministic integration and the approved live writing acceptance run. The [settings migration inventory](story-settings-migration-research.md) owns dimension selection, dependencies and the distinction between legacy workshop templates and V2 generic dimension outputs.

## Preserved business requirements

| DSH stage | Instructions retained or adapted from the sources |
| --- | --- |
| `settings` | Produce only the assigned dimension; preserve accepted dependencies, creative premise, concrete world facts, character goals, starting state and ability costs. Avoid repeating entire upstream dimensions. |
| `book-outline` | Produce one coherent ordered chapter plan, character development and explicit ending; preserve causality, escalation, required events, genre promise and payoff. Candidate defects do not authorize changing accepted settings. |
| `chapter-outline` | Start from actual previous continuity; make the protagonist's through-line readable and connect desire, action, price and change. Each scene needs conflict, a decisive action and emotional movement. Preserve mandated advance, plant and payoff obligations. |
| `body` | Realize the ordered scenes and obligations as readable prose, with consistent knowledge, time, perspective and ability costs. Preserve unaffected passages in targeted repairs. |
| `review` | Independently inspect exact versions, cover every required check and retain precise issue locations. DSH adds explicit source quotes for both checks and issues rather than accepting a bare approval. |
| `continuity` | Derive the next state from previous applied final continuity and actual reviewed body evidence. Preserve unchanged facts and stable identities. Planned events are not an initial state and cannot be applied or counted twice. |

## DSH-specific decisions

The existing `story_read_artifact` tool replaces Story's `read_artifact` and virtual `context.json` transport. Each input supplies `artifactId`, `sha256`, `kind` and `chars`. The prompt instructs the child to send the exact novel/artifact IDs, begin at `offset=0`, use an explicit page limit within the tool's configured maximum, follow `nextOffset` until `eof=true`, and compare returned version metadata on every page. Reader offsets are Unicode code points. The builder does not copy long artifact bodies into the prompt.

Task text, requirements and input references are JSON-encoded after a stable `TASK_DATA` marker. Author requirements guide the fiction; embedded attempts to change roles, tools, permissions or budgets are explicitly treated as data. This separation is a prompt instruction, not a security guarantee. Tool allow lists, source identity checks, bounded reads and output admission must remain enforced by the host.

The native child publishes its structured-output schema. The optional `outputSchema` field is accepted for composition compatibility but is intentionally absent from prompt text; the executor owns schema validation and publication. The final stage result must be supplied through `structured_output`, preserving the parent/child Session evidence path.

Numeric limits are host-provided requirements, not constants in the prompt builder. The first acceptance run supplies 3000–5000 counted words for each assembled chapter. DSH counts the complete chapter after generation and repair and blocks an out-of-range result. This deliberately replaces Story V2's advisory word-count rule. No hard per-scene ceiling is introduced.

Required-event omissions, settings/persona contradictions, continuity conflicts and length violations are blocking. Editorial wording and pacing suggestions remain advisory unless they establish a separately specified blocking defect. Story's evolving per-graph severity lists and broad prose bans are not copied as additional acceptance gates. Runtime budgets, provider names, single-tool restrictions, database operations, direct submission tools, opaque server-owned locator fields and automatic upstream change requests are also not carried over.

## Verification and remaining work

`tests/stage-prompts.spec.ts` covers six stage purposes, exact reader guidance, chapter-total counting, JSON preservation of quoted author text, configured limits and the absence of duplicated schemas. Its inline review snapshot records the model-visible prompt text. The tests use the public pure builder; they do not mock a stage runner or claim to exercise a Session.

The runtime must supply current numeric limits, exact artifact identities and stage-specific requirements, including assigned dimensions and chapter obligations. It must allow the bounded artifact reader in the native child and admit generated output through the stage schemas. Required follow-up checks are actual read-before-submit behavior, native structured capture, request budgeting, malformed output, cancellation, repair convergence and complete persisted chapter application. Real UI and preview reopening remain in [post-development validation](../development/post-development-validation.md).

## Version 6 quality pass

On 2026-11-11 the current `hldz-top/story_weaver` tree was not readable from this environment: anonymous and credentialed clones both returned 404. Version 6 therefore does not quote a newer Story prompt. It extends the roles already migrated above—content, continuity, character motive and a repair the writer can apply—onto DSH's current fields (`facts`, `characterArcs`, `purpose`, `throughLine`, `scene.action`, `issue.message`, continuity `characters` / `timeline` / `obligations`). It does not copy Story's per-graph severity lists, broad prose bans, credit accounting or an extra retry loop. New runs record prompt version 6 and still stop at `maxRepairAttempts`. Fixture tests check the sentences and the existing repair path; they do not establish real-model prose quality.
