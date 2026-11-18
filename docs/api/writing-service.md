---
description: "Writing-service operations, ownership, version retries, bounded reads and document preview in T01."
---
# Writing service

## Summary

This reference covers novel projects and immutable creative briefs in T01. [Service types](../../src/contracts.ts), [tool schemas](../../src/tools.ts) and [preview result types](../../src/preview-result.ts) are the authorities for fields and their TypeScript or JSON types. This page explains where values originate, which operations persist them, and how callers handle failures. It does not define generated settings or chapter-writing stages.

## Table of Contents

- [Input ownership](#input-ownership)
- [Operations](#operations)
- [Versions and retries](#versions-and-retries)
- [Persistence and concurrency](#persistence-and-concurrency)
- [Reads and preview](#reads-and-preview)
- [Failures and cancellation](#failures-and-cancellation)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="input-ownership"></a>
## Input ownership

The Host mounts one service through `openWritingService`. Tools derive `Actor.sessionId` from their actual Session and `Actor.workspace` from the display path returned by resolving that Session's working directory through DSH filesystem services. Model arguments cannot supply either value. The service compares workspace ownership exactly; two Sessions in one workspace can access the same novel while keeping independent selections. A Session without a working directory cannot use these tools.

Callers supply a request identity and creative text. Tool parsers admit nonblank request identities of at most 256 characters and server-generated novel and artifact identities; those identities are not filesystem paths. The service rejects blank titles and briefs without trimming accepted text. Revisions begin at 1. The Host passes its execution signal as invocation context and never persists that signal.

The plugin's [configuration](../../src/index.ts) owns deployment values. The service requires explicit positive safe-integer `maxArtifactBytes` and `maxReadChars` values; byte sizes use UTF-8 and read intervals use Unicode code points. The preview directory is resolved inside the Session workspace by the Host projection code.

<a id="operations"></a>
## Operations

Tools expose the service through ordinary DSH tool execution. Their structured results enter the Session log, allowing subsequent model requests to use the returned identities without querying hidden service state.

| Tool | Service operation | Observable result and side effect |
| --- | --- | --- |
| `story_create_novel` | `createNovel` | Persists the initial brief and novel metadata; returns revision 1 without selecting it. |
| `story_list_novels`, `story_get_novel` | `listNovels`, `getNovel` | Reads workspace-owned metadata and brief references without embedding document text. |
| `story_select_novel`, `story_get_selection` | `selectNovel`, `getSelection` | Persists or reads the selection for the Session and workspace; no selection is explicitly `null`. |
| `story_save_brief` | `saveBrief` | Publishes another immutable brief after checking the expected revision. |
| `story_read_artifact` | `readArtifact` | Reads an exact published version in an explicit bounded interval. |
| `story_preview` | `getNovel`, `getArtifact`, Host projection | Creates or verifies the exact version's Markdown file and returns persisted card metadata. |

A caller obtains `novelId` from a novel result and `artifactId` from that result's brief reference. A save uses the current novel revision as `expectedRevision`; a preview uses the artifact identity from the specific result it intends to show. Selection is a convenience for the Session, not an implicit substitute for the explicit identities required by save, read and preview.

<a id="versions-and-retries"></a>
## Versions and retries

Each save retains the old artifact and appends a new reference. A novel result contains metadata at its returned revision and the brief history through that revision. Reading a historical artifact never substitutes the latest version. Creative-brief persistence in T01 is not a generated-candidate review or chapter-application operation.

Creation request identities are scoped to the workspace. Repeating the same identity with the same title and brief returns the original creation result, including after restart and after later brief edits. Reusing that identity with different creation input fails.

Brief-save request identities are scoped to the novel. An identical retry includes both the original expected revision and the original text; it returns the originally saved revision without replacing a newer current revision. Conflicting payloads and reuse of that novel's creation request identity fail. Request comparisons preserve the exact input text.

A stale revision fails with `revision-conflict`. The caller must reread current metadata and decide whether another change is appropriate. Changing the expected revision under an existing request identity is a conflicting retry; a genuinely new edit needs a new identity.

<a id="persistence-and-concurrency"></a>
## Persistence and concurrency

The [storage declaration](../../src/records.ts) uses the DSH `story_writing` domain with its single-document layout. The host supplies the JSON or SQLite provider. Novel metadata, immutable artifacts and Session selections persist in that domain; the plugin does not start a database service.

The service persists artifact content before publishing its reference. A brief save checks the current revision inside the domain's serialized novel update, so two Sessions saving against the same revision cannot both publish different successors. Concurrent identical creation requests share an in-flight result; durable receipts preserve retries after restart.

Read tools declare concurrency safety to the DSH scheduler. Mutation tools use its exclusive scheduling, but that flag is not the protection against writes from another Agent or Session: the service's revision check owns that protection. This verification assumes one service owner in one host and does not establish multi-process writer safety.

There is no cross-record transaction assumption. A rejected revision check or cancellation after content persistence can leave an unreferenced artifact. Public reads require membership in the novel's published history, so these records cannot be read as a committed version. T01 has no orphan-artifact garbage collector.

<a id="reads-and-preview"></a>
## Reads and preview

`readArtifact` requires a nonnegative integer offset and a positive integer limit no larger than the configured read maximum. The returned `nextOffset` and `eof` make continuation explicit. An offset at the end returns empty text with `eof: true`; an offset beyond the end fails. These intervals count Unicode code points, not bytes or UTF-16 code units. Full artifact reads also enforce the configured UTF-8 byte maximum. Both read methods compare the stored artifact's metadata with its published history reference and recompute the text's SHA-256, code-point count and UTF-8 byte count. Any mismatch fails with `corrupt-artifact` and leaves storage unchanged.

The [projection](../../src/projection.ts) resolves a path containing server-generated novel and artifact identities under the configured directory inside the Session workspace. It writes the exact text through DSH filesystem policy and records the observed file version. Different brief versions have different paths.

A missing preview file is created when `story_preview` runs. The returned file is the current rendering: an allocated input or reviewed reference is `Input ID` or `Reviewed ID` with that eight-character id. The document's own `Artifact SHA-256` line and recorded research-source SHA-256 lines stay full digests. An existing file that exactly matches this rendering is reused. An existing file that exactly matches an earlier derived rendering, including a 0.2.1 preview that still labels those references with a full SHA-256, is replaced with the current rendering. The stored artifact is not modified. A file with any other bytes is left verbatim and the current rendering is written beside it; the tool result points at that new file. Editing Markdown cannot revise a creative brief. The service's storage remains authoritative.

The [preview card](../../src/client/StoryPreview.tsx) derives its state from recorded tool results. Only a valid successful result exposes the Session file-opening action. Running, failed and malformed results do not offer an artifact-opening action. Reopening an old card uses its recorded version path; it does not select the newest brief or regenerate a missing file by itself.

<a id="failures-and-cancellation"></a>
## Failures and cancellation

The [service error definitions](../../src/contracts.ts) distinguish invalid input or ranges, oversized content, missing novels or artifacts, workspace mismatches, request conflicts and revision conflicts. Storage and filesystem failures propagate to the normal tool failure path. Invalid preview metadata remains invalid; it is not converted into a successful file action.

Mutation entry points check cancellation. Creation and brief saves check again after artifact persistence; a queued brief update checks before publishing its reference. Cancellation propagates the signal's reason. A storage write already accepted by the provider can finish, so cancellation does not promise to erase durable but unpublished text.

Service disposal uses the domain's close operation to drain accepted writes and prevent subsequent publication. The cancellation and close tests observe the real domain event after content becomes durable and verify that no new novel reference appears after restart.

<a id="verification"></a>
## Verification

[Service tests](../../tests/service.spec.ts) exercise the public methods with real JSON and SQLite providers, including restart, concurrent writers, exact retries, cancellation, close, ownership and size limits. Host tests and the [offline profile fixture](../../tests/profile/README.md) cover tool execution, logged results and preview integration. The [development guide](../development/harness.md) owns current command results and browser evidence; deterministic fixture results do not establish chapter-writing quality or private-address installation.

<a id="dev-note"></a>
## Dev Note

None.

T02 adds explicit `ResearchLimits` to service construction and introduces research artifact kinds; see the [research service](research.md). Research previews verify the actual derived Markdown bytes; creative briefs still verify their original text.
