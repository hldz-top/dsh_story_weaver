---
description: "Versioned selected settings, outlines, prose, reviews, and atomic chapter adoption over the writing storage domain."
---
# Manuscript service

## Summary

[Manuscript types and storage operations](../../src/manuscript.ts) extend the [writing service](../../src/service.ts) with complete selected settings, book outlines, chapter outlines, body candidates, and actual continuity. These operations validate and persist supplied native-stage output; they do not invoke a model or run an automatic writing loop. The host owns research execution, generation, bounded repair, cancellation coordination, and explicit downstream-update requests. [Stage execution](stage-execution.md) and the [writing specification](../specs/story-writing-plugin/spec.md) describe those surrounding responsibilities.

## Table of Contents

- [Ownership and limits](#ownership)
- [Settings assembly](#settings)
- [Research and generation inputs](#inputs)
- [Candidate publication](#candidates)
- [Review and standalone adoption](#reviews)
- [Explicit outline revision](#revision)
- [Atomic chapter adoption](#chapters)
- [Queries, history, and staleness](#history)
- [Records and compatibility](#records)
- [Dev Note](#dev-note)

<a id="ownership"></a>
## Ownership and limits

`WritingService` owns one open `story_writing` domain. Its composed `ManuscriptStore` uses that same handle and closes with the service; it does not open a second provider or database. Every operation receives an `Actor`, checks the novel's workspace ownership, and uses explicit novel/artifact IDs. The host supplies generating and reviewing `childSessionId` values as native-run provenance. Publication receipts detect changes to these saved fields, but the storage service does not itself establish that a supplied Session ID executed a native model run.

`openWritingService(facility, writingLimits, researchLimits, manuscriptLimits)` requires all four arguments. `ManuscriptLimits` contains `minChapterWords` and `maxChapterWords`: positive safe integers with minimum no greater than maximum. There are no service defaults or scene word ceilings. [Body counting](body-text.md) measures assembled prose; artifact byte limits cover the full stored JSON, and ordinary [artifact reads](writing-service.md#reads-and-preview) remain bounded.

Content artifacts are durable before a serialized novel update publishes their references. Saves check invocation cancellation before work, after content persistence, and inside the publication update. A failed or cancelled publication may leave unreferenced content, but cannot advertise it as a saved candidate. The service does not claim cross-record transactions or cross-process multiwriter safety.

<a id="settings"></a>
## Settings assembly

`assembleSettings(actor, { novelId, requestId, selectedCodes }): Promise<ManuscriptCandidateView>` expands the explicitly selected roots through their catalog prerequisites, then assembles those current applied dimensions. Empty roots, unavailable dimensions, and missing or stale prerequisites are rejected. It does not implicitly select all catalog dimensions or wizard-required defaults.

The immutable `settings` JSON contains `version: 1`, `selectedCodes` in canonical catalog order, `inputRefs` for the creative brief and each selected dimension, and `dimensions` containing their complete parsed facts and Markdown. [The collection schema](../../src/manuscript-records.ts) owns these fields. Assembly preserves source content and verifies it on readback. Its candidate has no generating child or new research plan because assembly is a program operation. A separate cross-dimension review must pass before this collection becomes the applied settings head.

<a id="inputs"></a>
## Research and generation inputs

`manuscriptResearchInputs(actor, { novelId, target, revisionOf? }): readonly ArtifactRef[]` returns current source versions before the host plans stage research. It excludes research evidence. `manuscriptInputs(actor, { novelId, target, researchPlanId, revisionOf? }): ManuscriptContext` resolves the same current sources and inserts the explicitly named research result after the creative brief. It rejects incomplete, stale, failed, or insufficient research. There is no implicit latest-plan lookup; the host records a fresh research decision for each generated stage, including an explicit internal/creative decision when external research is unnecessary.

| `GeneratedManuscriptTarget` | Required scope |
| --- | --- |
| `{ kind: 'book-outline', chapterCount }` | Positive integral total chapter count and current applied assembled settings. |
| `{ kind: 'chapter-outline', chapterNumber }` | A chapter in the applied book plan. |
| `{ kind: 'body', chapterNumber }` | The exact applied chapter outline and its ordered scenes. |
| `{ kind: 'continuity', chapterNumber, bodyId }` | This chapter's exact reviewed body with no blocking review issues and valid current length. |

Both calls accept optional `snapshotThrough`, the highest earlier chapter whose reviewed continuity snapshot may be read. Omit it to include every applied chapter before this one. A caller that is writing a parallel batch passes the last chapter applied before that batch, so unfinished siblings are not inputs. Each included chapter must already have a current reviewed snapshot. Book outlines do not read snapshots.

| `ManuscriptContext` field | Meaning |
| --- | --- |
| `target` | Validated requested stage and scope. |
| `researchPlanId` | Explicit adequate research plan used by this invocation. |
| `revisionOf` | Exact applied outline retained as revision lineage, or `null` for ordinary generation. |
| `inputRefs` | Exact full artifact references: brief, research evidence, assembled settings, then the book outline, this chapter's outline when needed, and reviewed continuity snapshots through `snapshotThrough`. Continuity also includes its reviewed body and body review. |
| `requiredChecks` | Review categories required for this stage. |
| `obligations` | This chapter's required IDs and descriptions from the exact book plan; empty for book generation. |
| `sceneIds` | Ordered formal chapter-outline scene IDs for body or continuity stages; empty for book and chapter-outline generation. |
| `continuitySnapshots` | Reviewed snapshots of earlier applied chapters in chapter order, or an empty list. |

<a id="candidates"></a>
## Candidate publication

`saveManuscriptCandidate(actor, request): Promise<ManuscriptCandidateView>` accepts `SaveManuscriptCandidateRequest` with `novelId`, caller-owned `requestId`, `target`, explicit `researchPlanId`, generating `childSessionId`, optional `revisionOf`, and untrusted model `output`. [Stage-output schemas](stage-output.md) validate all output fields. The service supplies exact source versions, chapter count/number, obligations, scene order, and factual evidence sources to their semantic checks. A candidate is stored without automatic application.

Input ID/hash equality is unordered and rejects duplicates; ordered scenes, chapters, and substantive arrays retain their defined order. Request receipts canonicalize input-reference order and parsed JSON fields while preserving substantive array order. An identical recorded retry returns the same artifact with its current review/application/staleness view, including after upstream changes. Conflicting reuse of a request ID is rejected. Publication rechecks current sources inside the serialized novel update.

A short or long body remains complete and repairable. Its view reports a blocking length finding; no text is truncated or relabeled as complete. Continuity output can preserve an open obligation with a nonblank explanation and empty evidence, but that obligation will block chapter application. Fulfilled obligations must quote the actual reviewed body. Continuity evidence sources are actual body text and the continuity snapshots supplied as inputs, not planned book or chapter events.

`saveContinuitySnapshot` stores one compact snapshot for an applied body and continuity pair. `attachContinuitySnapshot` requires its latest review to pass and then records that snapshot on the applied chapter. A blocking review is not attached. The snapshot lists character status, unrecovered foreshadowing and used plot bridges. It is not a narrative-state graph.

<a id="reviews"></a>
## Review and standalone adoption

`saveManuscriptReview(actor, request): Promise<ManuscriptCandidateView>` takes `novelId`, exact `candidateId`, `requestId`, reviewing `childSessionId`, untrusted review `output`, and `expectedReviewId`. The expected ID is the latest review observed by the caller, or `null` before the first review. It is checked before persistence and again in the serialized publication update. A late review cannot replace a newer result. A new review cannot modify an already applied candidate.

Reviews name the exact candidate ID/hash and its original input references. Quotes are checked against those immutable sources; body quotations are matched against assembled prose. Settings require completeness and consistency checks; book outlines also require obligations; chapter outlines and continuity also require continuity; bodies additionally require length. All non-style issues must be blocking, and style issues must be advisory. The model cannot submit an approval boolean. Review histories retain their original child provenance and receipt, and index flags are checked against immutable review findings.

`applyManuscriptCandidate(actor, { novelId, candidateId, reviewId, expectedAppliedId })` applies only assembled settings, book outlines, or chapter outlines. It requires the latest exact nonblocking review, current inputs, and the expected existing head for that scope. `expectedAppliedId` is `null` for a new head. Application checks the head inside the serialized update and preserves old versions. Replaying an already applied candidate does not move a newer head backward. Bodies and continuity are rejected by this operation because they must apply together.

<a id="revision"></a>
## Explicit outline revision

The input queries and candidate-save request accept optional `revisionOf`. It must identify the current applied book outline with the same `chapterCount`, or the current applied chapter outline with the same `chapterNumber`. Settings collections, body, and continuity cannot use this revision operation. A former head, another novel's artifact, an unreviewed candidate, or a different target scope is rejected. The separate [settings API](settings.md) supports dimension revision.

The current brief, research result, and ordinary stage dependencies remain active inputs. The exact base artifact is appended as the final input, allowing native generation and independent review to read its retained content. A base with obsolete upstream references can be revised using fresh current dependencies; its lineage alone does not make the new version stale. Candidate and review outputs must still declare the full exact input ID/hash set.

First adoption requires both the current head and `expectedAppliedId` to equal `revisionOf`. Concurrent base replacement blocks saving, reviewing, or applying a new revision. After adoption, lineage is retained and validated but excluded from dependency-staleness traversal; ordinary dependencies remain checked. Old artifacts and reviews are not overwritten. Descendants that consume the replaced head become stale without starting generation or repair; the host requires a separate explicit downstream-update request.

<a id="chapters"></a>
## Atomic chapter adoption

`applyChapter(actor, request): Promise<AppliedChapterView>` publishes one reviewed body, its reviewed actual continuity, and the resulting obligation outcomes in the same novel update. It validates the pair before publication and inside the update, recounts the complete body, requires every mandatory obligation fulfilled, and rejects stale inputs or blocking findings.

| `ApplyChapterRequest` field | Meaning |
| --- | --- |
| `novelId` | Owning novel. |
| `bodyId`, `bodyReviewId` | Exact body and its latest passing review. |
| `continuityId`, `continuityReviewId` | Exact continuity derived from that body and its latest passing review. |
| `expectedBodyId`, `expectedContinuityId` | Both currently applied IDs for this chapter, or both `null` for first adoption. Each must match; checking only the body would miss concurrent continuity replacements. |

The returned `AppliedChapterView` contains `chapterNumber`, full `body`, `bodyReview`, `continuity`, and `continuityReview` references, exact `obligations`, `wordCount`, `wordBounds`, `stale`, and `changedInputs`. `wordBounds` records the explicit limits used for that adoption. Historical application is revalidated against its recorded range after deployment limits change; each new application uses the service's current frozen limits. Repeating an already recorded exact pair has no additional application effect and returns that historical pair's view.

<a id="history"></a>
## Queries, history, and staleness

`getManuscript(actor, novelId): ManuscriptView` returns `history` in candidate-publication order, `heads` as full current candidate views for assembled settings/book/chapter outlines, and `appliedChapters` as the latest atomic pair per chapter in chapter order. Historical application pairs remain retained internally. Raw artifact reads require exact IDs and never substitute a newer version.

| `ManuscriptCandidateView` field | Meaning |
| --- | --- |
| `target` | Settings selection or generated stage scope. |
| `artifact` | Exact full manuscript artifact reference; each immutable document has revision 1. |
| `inputRefs` | Original source ID/hash pairs. |
| `childSessionId` | Generating native child provenance, or `null` for program-assembled settings. |
| `revisionOf` | Exact earlier applied outline retained as revision lineage, or `null`. |
| `status` | `candidate`, `reviewed`, `blocked`, or `applied`. A body outside current length bounds is blocked before application, even without a review. |
| `review` | Latest exact review reference, or `null`. |
| `stale`, `changedInputs` | Whether an original source or its dependency chain changed, and the affected original input references. |
| `wordCount`, `length` | Recomputed body count and current service length finding; both are `null` for other document kinds. |

Historical candidates can remain `applied` after replacement or an upstream edit. Use `heads` and `appliedChapters` for current selection. `stale` is independent of historical status; the service retains old content and refuses new downstream use of stale sources. It does not authorize or initiate a downstream repair when an upstream version changes.

<a id="records"></a>
## Records and compatibility

[Manuscript record schemas](../../src/manuscript-records.ts) define candidate targets, source/provenance receipts, immutable review histories, standalone head slots, and atomic chapter pairs. [Novel records](../../src/records.ts) use internal `recordVersion: 5`, retaining `manuscriptHistory`, `manuscriptHeads`, and append-only `appliedChapters`, and recording nullable `revisionOf` on every settings/manuscript candidate. The storage domain remains version 1 and uses the existing `single` layout with JSON or SQLite.

Strict version 4 records decode with `revisionOf: null` on every retained candidate; their existing manuscript and chapter histories are preserved. Strict T03 version 3, T02 version 2, and the original T01 record have explicit decode paths that preserve their existing fields and add empty collections for later features. Arbitrary missing version 5 fields are not repaired with defaults. Saved content, source roles, request provenance, review findings, current heads, and atomic pair references are checked at read/admission boundaries; corrupt records fail rather than becoming successful empty results.

<a id="dev-note"></a>
## Dev Note

The public storage fixtures exercise both installed DSH providers and restart readback. They establish persistence/admission behavior, not production-model quality, automatic orchestration, browser preview acceptance, or private-package installation. Those integration and acceptance responsibilities remain with the surrounding writing workflow.
