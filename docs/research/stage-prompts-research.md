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

## Current-tip template comparison (not the V2 runtime)

A read-only reference of `hldz-top/story_weaver` master `0cac906317305609a0a0b579b1db62eaf266d0f0` (2026-11-05, prompts tree `7527955453fb56e806c1659c8fa9a4b2c3d4860f`) was attached on 2026-11-11. It contains the full text of 45 root `prompts/*.txt` templates and only an index of the V2 modules. This section compares those templates with prompt version 6. It is not a comparison against the executable V2 reviewer or generator. The attachment states that `app/services/writing_pipeline/` has no `.txt` prompt directory at that tip, and that the runtime instructions live in Python. Those modules were not expanded:

- `settings_graph.py`, `outline_graph.py`, `chapter_outline_graph.py`, `body_graph.py`
- `production_settings.py`, `production_outline.py`, `production_chapter_outline.py`, `production_body.py`
- `review_contract.py`, `provisional_review_contracts.py`, `upstream_revision.py`
- the matching `*_tools.py` modules

`prompts/novel_review_prompt.txt` (`b05f425ef8ae6b818067b7552aa3d5f7e448227d`, 332 bytes) asks for a reader-style impression, strengths, weaknesses and suggestions. `prompts/novel_approval_prompt.txt` (`ead48ae39952a571b4c8d084e72f6eb6245cb578`, 324 bytes) asks for a yes/no compliance flag. Neither is the V2 review contract. DSH review keeps quoted checks, `issue.message` as one repair step, and the existing blocking set. Those two templates were not copied.

| DSH stage | Templates actually read | What version 6 already shares | Left out on purpose |
| --- | --- | --- | --- |
| Settings | Extract templates such as `novel_extract_basic_enum.txt` (`f3545358…`) and `novel_extract_protagonist_e1.txt` (`f351388a…`) reverse-fill fixed brainstorm payloads from a finished text. E1 requires a name, start state and `overall_goal`. | Free-form people get one present want, one limit and one reusable relationship. Classification dimensions stay labels and grounds. | Fixed genre/tone enums, Markdown payload schemas, “infer a non-empty value when the source is silent”, and parser-FAIL rules. DSH generates forward from the brief and rejects invented enum facts. |
| Book outline | `novel_outline_prompt.txt` (`b11a63b1…`) is a seven-section blueprint and forbids a chapter list. `novel_plot_prompt.txt` (`453ed634…`) is a second step that then enumerates every chapter. | Arcs state starting want, pressure and ending stance. Chapter purpose states the immediate want and the risk of required events. | The “do not enumerate chapters” shape, because the DSH schema requires ordered chapters and obligations. Also omitted: payoff quotas, a four-type end hook as a required field, audience-gender branching, and a 600–1000 character cap. |
| Chapter outline | `novel_chapter_outline_prompt.txt` (`9613b4d0…`) and the plot template’s DAPC clause: a concrete desire, an active choice, a price, and a change; previous chapters stay continuous; technical words are not metaphors. | `scene.action` names who chooses, what they want, and the cost. Events that contradict applied continuity or current knowledge are refused. | A mandatory `本章预计字数` line, fictional country renaming, “bury a new plant whenever one is paid off”, and a three-layer conflict that would block an otherwise consistent plan. |
| Body | `novel_chapter_writing_prompt.txt` (`cbdeff37…`) and the tools/user variants. They require at least 3000 Chinese characters, POV-limited perception, outline items rewritten as prose, and a ban on “不是…而是” plus technical metaphors. | The host still counts 3000–5000 words. Version 2–5 already ban outline restatement, technical or financial metaphors, and the listed AI-tone patterns. Version 6 adds the present want inside the choice and forbids unsupported knowledge, tools and injuries. | The fourteen-rule rewrite list as new blocking gates: metaphor density, single-sentence paragraph caps, anatomy word bans, a required count of interpersonal payoffs, and geopolitical renaming. DSH has no E9 `forbidden_words` field to enforce. |
| Review | Only the two short templates above. | Actionable `issue.message`; taste and thin motive stay advisory. | A free-form book review or a yes/no approval flag. The V2 `review_contract.py` text is still unread. |
| Revision | `novel_chapter_revise_prompt.txt` (`52309421…`) polishes one draft and forbids plot changes. | Author `revisionInstructions` on settings and outlines must be applied without inventing a new plot. Body repair still preserves passages that no blocking issue names, except a host length repair. | Replacing `story_revise` with an expression-only polish pass. That tool revises the named upstream settings or outline, then stops. |
| Continuity | `narrative_state_update_novel.txt` (`cafae566…`) emits a five-part Markdown ledger and writes “no change” explicitly. | Character state, timeline and obligations change only when the reviewed prose supports them. An obligation is fulfilled only when the prose performs it. | The Markdown ledger, `character_id` columns, and a foreshadowing ledger. Those fields are not in the continuity schema. |

## V2 runtime comparison at the same tip

The runtime supplement for `0cac906317305609a0a0b579b1db62eaf266d0f0` contains 63 `writing_pipeline` sources, including the inline role prompts. Billing, lane, and storage modules were omitted from that pack and were not copied. The root `prompts/*.txt` files are not this runtime. `novel_review_prompt.txt` and `novel_approval_prompt.txt` remain non-contracts.

Version 6 now borrows these runtime constraints, mapped onto the existing fields and the existing blocking set:

| Runtime source | Borrowed into version 6 | Excluded |
| --- | --- | --- |
| `settings_graph.py` dimension/patcher plus `_SETTINGS_HUMAN_PROSE_CONTRACT` | Reader-facing `contentMarkdown`; no catalog codes, JSON names, or mechanical ratios; do not lock later plot to fixed chapter numbers. People still get one want, one limit, and one relationship. | Mandatory `g1`/`g4`/`e1` closure, `first_use_chapter = 1`, “first big payoff by chapter 3”, 0.5–2K dimension cap, and `positioning_pacing` as a blocker. |
| `outline_graph.py` proposer | Writing guidance stays specific to this story and does not imitate a named author. Repair still follows the named host rejection. | A separate research-planner/executor/curator role set and its search budgets. |
| `chapter_outline_graph.py` proposer and reviewer | `throughLine` is what the protagonist sets out to do and how the chapter ends. An obligation is required here only when the book outline assigns it; a later due date is a reminder. Thin guidance stays advisory. | Per-scene 1,500-word ceilings, `accepted=true` flags, C4 hollow-field blockers, and upstream ChangeRequest locators. |
| `body_graph.py` proposer and reviewer | Continue from the previous scene and close so the next can pick up. Do not repeat an explanation, end on a narrator thesis, stack metaphors, or drift time. Those style hits stay advisory, with one cited rewrite. Through-line, knowledge, and timeline contradictions stay on the existing blocking categories. | Scene word ceilings, sentence-skeleton and AI-tone as new DSH categories, and the reviewer’s full 17-item checklist as gates. AI tone stays on the existing host detector. |
| `body_lifecycle_graph.py` continuity roles and `review_contract.py` | Continuity still changes only what the reviewed prose supports. Acceptance stays “no unresolved blocking issue”, not a model approval flag. | Quote-length machinery, fingerprint stagnation, round-2 carry rules, and obligation/ending lifecycle agents. `story_revise` still edits one upstream settings or outline version and stops. |

Mocked tests still do not establish prose quality.
