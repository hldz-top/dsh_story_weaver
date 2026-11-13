---
description: "Research necessity, native source paging, literal selected evidence and immutable version compatibility."
---
# Research service

## Scope and field authorities

New writing stages first capture a [research necessity decision](research-planning.md) from the exact output target and immutable input references. Author-declared genre, tone and fictional choices resolve locally. External questions identify a missing fact needed by the output. The retrieval child uses the frozen questions; an input-only outline or body child receives no web tools, and the service also refuses web reservations for a plan with no external question. Settings research instead invokes the host's official `web_search` and `web_fetch` when those tools are available, and continues locally when they are unavailable or the call fails for quota or billing. Semantic relevance and factual support remain model review responsibilities.

[Public types](../../src/contracts.ts), [selection types and schemas](../../src/research-selection.ts), [durable content schemas](../../src/research.ts) and [tool schemas](../../src/research-tools.ts) own field names, types and requiredness. The [repair plan](../development/research-admission-repair-plan.md) and [failed real-run audit](../development/real-model-rerun1-validation.md) distinguish implementation from live acceptance.

## Operations and data flow

| Operation | Input, output and effects |
| --- | --- |
| `story_start_research` / `startResearch` | Saves classified questions against the exact brief, creates the source-read allowance, and publishes an immutable plan. Actual Session identity and sequence come from the invocation. |
| `story_get_research`, `story_list_research` | Return workspace-owned plans, reservations, outcomes and staleness. |
| `reserveResearchCall` | Reserves the native call in the durable queue before dispatch; refuses input-only plans. This is a host operation. |
| `story_research_results` | Flushes and verifies the owning Session's native call/result pairs; returns a source index without body text or previews. |
| `story_read_research_source` | Reads the specified `callId`, `sourceIndex`, `offset` and positive `limit` from already recorded text. Returns literal text, provenance, Unicode cursors, `eof` and `remainingReadChars`. It performs no web request. |
| `story_complete_research` / `completeSelectedResearch` | Receives findings with explicit `selections`, verifies every selected range against native text, saves version-3 evidence, then publishes the reference. |
| `story_read_artifact`, `story_preview` | Read an exact saved artifact or its Markdown projection. Research documents are available on explicit request; they are not automatic reader deliveries. |

Every finding answers one frozen question. Internal and creative findings have empty `callIds` and `selections`. An external selection contains a native `callId`, original `sourceIndex`, Unicode `offset` and exact positive `limit`. The host copies the literal text; model-supplied quotations, titles and provider answer summaries cannot substitute for recorded source passages. Duplicate exact ranges shared between findings are stored once; overlapping distinct ranges each consume their retained length.

## Source identity and eligibility

Each observation retains native call identity, tool name, input, call/result sequence, execution status, error, accepted sources and rejected references. Collection checks Session ownership, reservation, preceding call, turn/step and source-event provenance. Missing results, malformed fields and unavailable durable logs fail explicitly.

The source index includes final HTTP(S) URL, nullable title, source index, SHA-256 of the entire recorded string, `totalChars`, `bodyStart`, `bodyEnd`, nullable `httpStatus`, `nativeTruncated` and `eligibility`. Fetch offsets address the exact native display string, so evidence ranges must stay inside its body interval. Search offsets address the logged snippet. `eof` means the end of that recorded string; `nativeTruncated` reports that the upstream result may already have omitted content. Paging cannot recover unlogged bytes.

| Eligibility | Meaning for completion |
| --- | --- |
| `usable` | A body is present, HTTP status is successful or not applicable, and no replacement character was recorded. A selected passage must still support its question. |
| `http-error` | A non-2xx response, including a 403 verification page, is preserved as resource data but cannot establish adequate evidence. |
| `empty` | No body-bearing text or snippet is available. Native framing and a title do not count as evidence. |
| `suspect-encoding` | The recorded body contains U+FFFD. The plugin preserves it and refuses adequacy; it does not infer an original encoding or rewrite the text. |

Native transport or decoding exceptions remain failed observations with the actual error. A completed HTTP error response remains a successful native invocation with ineligible content. A saved source has `retention: selected` and literal `excerpts`, or `unselected` and an empty excerpt list. An unselected early response cannot consume the final excerpt allowance.

Accepted and rejected rows retain each original index exactly once. Rejected relative or non-HTTP(S) references remain exact audit data with `reason: unsupported-reference`; no base URL is guessed. Markdown fences rejected references and all selected text.

## Finite limits, ownership and cancellation

`maxReadChars` bounds each source page. `maxEvidenceChars` supplies separate per-plan allowances for question/reason text, index metadata, retained excerpts, conclusion text, and cumulative requested source-read characters. Selection declarations share the metadata allowance. Excerpt allocation depends on explicit selections, not receipt order. Index metadata includes variable call/input/error/reference strings and source digests; it contains no source previews. `maxResearchQuestions`, `maxResearchCalls`, `maxResearchSources` and `maxResearchLogEvents` retain their existing finite limits, and every saved artifact obeys `maxArtifactBytes`.

Before returning a page, `reserveResearchRead` atomically records the native paging call ID and exact range in `research_reads`. Requested limits are charged, including a shorter final page. Identical invocation replay does not charge twice; a different range under that invocation ID is a conflict. Reservations survive restart and cancellation and are not refunded. Queued reservations serialize competing readers. Cancellation is checked before collection, reservation and return; it cannot publish late evidence. Paging requires the owning Session and an active current-brief plan. Completed evidence is read through the artifact tools; historical plans without a read allowance cannot acquire one silently.

Workspace reads remain separate from Session-owned retrieval, paging and completion. Brief changes preserve old artifacts and make affected plans stale. Every reserved web call must settle; pending results cannot be treated as empty success. A required external finding with no cited call or a failed cited call is `failed`; absent or ineligible selected evidence or an inadequate finding is `insufficient`. The aggregate follows the classified findings: any failed finding makes it failed, otherwise any insufficient finding makes it insufficient. A failed call that no finding cites stays recorded with its status and error but does not fail the plan by itself. Failed and insufficient plans can be archived but cannot admit a writing stage. Version-3 evidence recorded under the earlier rule, where any failed observation failed the aggregate, reads back unchanged; admission still requires a stored `succeeded` or `not-needed` outcome, so such a plan needs a new plan. The read-only version-1/2 classifier keeps the earlier rule.

## Versions and replay

Plans retain JSON `version: 1`. The modern tool saves evidence JSON `version: 3`; strict version-1 and version-2 readers preserve historical artifact bytes, IDs, hashes and Markdown. The version-1 adapter adds an empty rejected-reference list only in memory. `completeSelectedResearch` is the sole evidence writer; every new completion requires explicit selections. Artifact `revision: 1` is independent of the JSON content version.

Completion stores content before publishing its reference and rechecks ownership, cancellation and the current brief. An identical completion replays the saved result without rereading native logs. Arrays remain ordered idempotency inputs. New decoding support or plugin loading does not resubmit a terminal writing run. Native DSH tool-argument correction and provider retry policies are unchanged.
