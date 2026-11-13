---
description: "Settings candidates, exact review and adoption, explicit revision lineage, and durable version compatibility."
---
# Settings service

## Summary

The [writing service](../../src/service.ts) persists individual settings dimensions, their reviews, and the currently applied version of each dimension. [Settings types](../../src/settings.ts) define the requests and views; [stage-output parsing](stage-output.md) defines model JSON. These commands validate supplied stage output and own its durable state. [Stage execution](stage-execution.md) owns native model calls, and the [manuscript service](manuscript.md) assembles and adopts the selected dimensions as a separately reviewed settings document. The [T03 validation record](../development/t03-validation.md) records the earlier checkpoint; current behavior is exercised by [the service tests](../../tests/settings-service.spec.ts).

## Table of Contents

- [Ownership and identifiers](#ownership)
- [Current inputs](#inputs)
- [Candidate publication](#candidate)
- [Queries and status](#queries)
- [Review publication](#review)
- [Application](#application)
- [Stored records and compatibility](#records)
- [Known limits](#limits)
- [Dev Note](#dev-note)

<a id="ownership"></a>
## Ownership and identifiers

Every method receives an `Actor` from the host, containing the resolved workspace, calling DSH Session identity, and optional invocation cancellation signal. The service scopes the novel to that workspace. Novel and artifact IDs are explicit branded identities, independent of the calling Session and preview paths; [base service types](../../src/contracts.ts) own their parsers and the shared `ArtifactRef` fields.

The host supplies `childSessionId` as the provenance of a candidate or review run. Candidate and review records retain their own child IDs. These service calls neither start a child Session nor establish that a submitted ID belongs to an independently executed native reviewer. A stored ID alone is not evidence of a logged model run; the native execution owner must establish that relationship.

Long content belongs to immutable artifacts. Novel records own references, request receipts, review history, and current dimension heads. Settings artifacts and review artifacts are separate immutable documents whose `revision` is 1; their exact identity is the artifact ID and hash. They do not use the creative brief's revision as a settings revision counter.

<a id="inputs"></a>
## Current inputs

`settingsInputs(actor, novelId, dimensionCode, researchPlanId, revisionOf?): ArtifactRef[]` constructs the current source references for one catalog dimension. `dimensionCode` must identify an enabled, generatable entry in the [settings catalog](../../src/settings-catalog.ts); an `edit_external` entry is unavailable for generation. `researchPlanId` must identify completed, current-brief research with outcome `succeeded` or `not-needed` and a result artifact. Missing, stale, failed, or insufficient research prevents this operation from proceeding.

The returned order is the current creative brief, that research result, then the dimension's applied prerequisites in catalog dependency order. A missing or stale prerequisite prevents publication. When `revisionOf` is supplied, it must name the current applied version of this dimension and is appended as the final source. This base may have obsolete upstream inputs: generation consumes the current dependencies and retains the old version only as revision reference material. The method returns references rather than a concatenated model prompt.

<a id="candidate"></a>
## Candidate publication

`saveSettingsCandidate(actor, request: SaveSettingsCandidateRequest): Promise<SettingsCandidateView>` parses the submitted output against the requested dimension and the current input ID/hash set. It writes the content artifact before publishing its reference through the storage domain's serialized novel update. It rechecks current inputs inside that update. A newly published candidate has no review and is not applied. A new candidate for a classification dimension must also pass [the scope bound](stage-output.md#settings-dimensions) before anything is written. An identical recorded retry and readback do not apply the bound, so candidates admitted before it existed remain readable.

| Request field | Source and meaning |
| --- | --- |
| `novelId` | Existing novel owned by the actor's workspace. |
| `requestId` | Caller-supplied idempotency identity for candidate publication, recorded within the novel's settings history. |
| `dimensionCode` | Exact catalog dimension requested by the host. |
| `researchPlanId` | Exact completed research plan used to select the research-evidence input. |
| `revisionOf` | Optional current applied version of this same dimension; omission records `null`. |
| `childSessionId` | Host-supplied generating child Session ID, retained as provenance. |
| `output` | Untrusted model JSON with `version`, `dimensionCode`, `inputRefs`, `facts`, and `contentMarkdown`; [the settings output parser](stage-output.md#settings-dimensions) owns field checks. |

The request receipt hashes the research plan ID, child Session ID, parsed output, and revision lineage when supplied. A repeated receipt with differing content is a request conflict. An identical recorded retry returns the original artifact with its current view even after its inputs become stale; it does not regenerate or restore an old head.

<a id="queries"></a>
## Queries and status

`getSettings(actor, novelId): SettingsView` returns `history`, containing retained candidates in publication order, and `applied`, containing the current head for each applied dimension. It reads candidate artifacts and validates stored reviews and adoption flags. Readback verifies indexed dimension, required source roles, research identity, source hashes, revision lineage, publication receipt, and review/adoption state against immutable content. Malformed records fail rather than yielding empty state.

| `SettingsCandidateView` field | Meaning |
| --- | --- |
| `dimensionCode` | The dimension associated with the candidate. |
| `artifact` | Exact `ArtifactRef<'settings-dimension'>`; read its content through the ordinary artifact API. |
| `inputRefs` | Stored input artifact ID/hash pairs used for generation; revision lineage is the final source. |
| `revisionOf` | Earlier applied version retained for this revision, or `null`. |
| `childSessionId` | Generating child Session provenance supplied by the host. |
| `status` | `candidate` before review, `blocked` when its latest review has blocking issues, `reviewed` when that review has none, or `applied` after adoption. |
| `stale` | Whether an active brief/prerequisite changed, transitively, or an unapplied revision lost its exact current base. Adopted revision lineage is excluded from dependency-staleness checks. |
| `review` | Exact latest review reference, or `null` before review. |

`stale` is independent of `status`: history remains readable after its inputs change. An older version can retain `status: 'applied'` after another candidate becomes the current head. Use the `applied` collection to identify current heads; do not select them by filtering history's status. These views omit long prose, the research plan ID, request receipts, and earlier review references.

<a id="review"></a>
## Review publication

`saveSettingsReview(actor, request: SaveSettingsReviewRequest): Promise<SettingsCandidateView>` stores a separate review artifact and appends it to the exact candidate's review history. It requires `completeness` and `consistency` checks with source quotations. Every non-style issue must be `blocking`; style issues must be `advisory`. Invalid severity is rejected, and there is no model-authored approval boolean.

| Request field | Source and meaning |
| --- | --- |
| `novelId`, `candidateId` | The candidate's owning novel and exact published artifact ID. These fields form `SettingsCandidateRequest`. |
| `expectedReviewId` | The latest review ID observed by the caller, or `null` when there is no review. This is the compare-and-set precondition for appending a new review. |
| `requestId` | Review-publication idempotency identity within this candidate's review history. |
| `output` | Untrusted review JSON naming the exact candidate ID/hash and exact input references, with checks, issues, and quotations as defined in [review output parsing](stage-output.md#review). |
| `childSessionId` | Host-supplied reviewing child Session ID, retained separately from the generating child ID. |

The service checks `expectedReviewId` before writing and again inside the serialized update. A newer review cannot be overwritten by a late review based on an earlier head. It rejects a stale candidate and prevents a new review from changing an already applied candidate; create a new candidate for revised work. Review request receipts include the child ID, expected review ID, and parsed output. An identical recorded retry returns the candidate view; conflicting reuse fails.

<a id="application"></a>
## Application

`applySettingsCandidate(actor, request: ApplySettingsCandidateRequest): Promise<SettingsCandidateView>` applies an exact reviewed candidate. It reloads and parses the immutable latest review, requires no blocking issues, and then checks staleness, latest review identity, and the expected dimension head in one serialized novel update.

| Request field | Source and meaning |
| --- | --- |
| `novelId`, `candidateId` | Exact candidate and its owning novel. |
| `reviewId` | Exact latest review artifact to authorize this application; an older passing review cannot substitute for a newer review. |
| `expectedAppliedId` | Current head artifact ID previously observed for this dimension, or `null` when none exists. A different current head causes a revision conflict on first adoption. A revision additionally requires this ID to equal its `revisionOf`. |

Successful first adoption marks the candidate applied and sets that dimension's current head without erasing prior candidates or reviews. When a revision replaces its base, the new candidate remains valid against its active inputs while descendants of the old head become stale; no downstream writing is started. Reapplying an already applied candidate returns its view without moving the current head back; the first-adoption compare-and-set checks do not turn a historical retry into a new replacement. Review and application are separate operations, and saving a candidate or passing review never applies it automatically.

<a id="records"></a>
## Stored records and compatibility

The [record schemas](../../src/records.ts) keep storage domain `story_writing` at version 1 with `single` layout. Novel records use internal `recordVersion: 5`, retaining `settingsHistory`, `settingsHeads`, and manuscript state, and requiring nullable `revisionOf` on settings and manuscript candidates. This does not change the provider's database or file-format version.

Each settings history entry stores the candidate reference, dimension code, research plan ID, exact input references, nullable revision lineage, generating child ID, request receipt, review history, and applied flag. Each review-history entry stores its artifact reference, request receipt, reviewing child ID, and the derived blocking flag. `settingsHeads` maps each dimension to at most one current artifact; duplicate dimension heads are rejected by the record schema.

Compatibility is explicit: strict version 4 records preserve their state and assign `revisionOf: null` to existing candidates. Strict T03 version 3, T02 version 2, and the original T01 record each preserve their known fields and add empty collections for later features. Existing artifact content and brief references are retained. Arbitrary missing fields in a version 5 record are not filled with defaults.

A passed settings collection can also be remembered on the novel as optional `settingsSnapshots`: `{ briefSha256, roots, artifactId }`. The field is absent until the runner writes one. Roots are stored in code order. The runner skips a later settings layer when `reuseSettingsSnapshot` is on and the current brief text and requested roots match a snapshot whose collection is still published. The snapshot is not a second source of truth; the applied collection remains the document.

Author imports (`importSettings`) add an optional `origin` field to settings history entries without a record-version change. `origin: "import"` marks author text adopted in place of the current head: it requires non-null `revisionOf`, `applied: true` and an empty review history, it is exempt from the applied-needs-nonblocking-review rule, and its provenance hash is prefixed with `import`, so relabelling a record in either direction fails validation as corrupt. A missing `origin` means `stage`; writes never add it to older entries. Views derive `origin` and `pendingReview` (an import head that no passing assembled-settings review has covered). An older plugin cannot read a store containing an `origin` field; its strict schema rejects the whole domain, so the plugin fails to load for every novel and does not rewrite the store. Import receipts written since the P-1 fix leave the importing Session out of the hash; #18 (`8675246`) cannot verify them and reports `Settings metadata or source content cannot be verified` when reading that novel's settings. Receipts written by #18 (`8675246`) still verify here.

The provenance check (including the `import` prefix that rejects a relabelled stage record) is integrity checking, not authentication. It detects accidental or partial edits and records that no longer agree with their receipt, but anyone who can write the store can also recompute a receipt: an unreviewed stage revision relabelled as an import with a recomputed `import` hash is accepted and shown as an import pending review. The importing Session (`childSessionId`) of a new-format import record is metadata outside the hash, so editing it is not detected; only receipts written by #18 (`8675246`) bind it. Protect the store with file permissions and backups, not with these checks.

A rejected or cancelled import may leave an unreferenced content artifact; public reads reject it, the same as for other writes.

<a id="limits"></a>
## Known limits

These APIs establish persistent candidate, review, revision, and adoption behavior through the installed JSON and SQLite providers. The earlier six source/idempotency regressions have been repaired and are retained in the service tests. Native execution and run orchestration remain separate owners; passing storage fixtures do not establish production-model quality, browser acceptance, or private-package installation. Downstream update is an explicit host operation, not a side effect of revision adoption.

<a id="dev-note"></a>
## Dev Note

Settings model JSON, immutable content, and adoption state have different owners. Keep field definitions in the exported types and schemas, and keep executed validation evidence in the development checkpoints. No cross-record transaction or cross-process multiwriter guarantee is added by the settings service.
