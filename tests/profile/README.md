# Offline Web/profile acceptance fixture

`fixture.mjs` registers `story-fixture/deterministic` in the public DSH LLM registry and two offline web providers. It drives the installed writing tools, native child Sessions, tool cards and document previews from visible messages only. It never reads writing-service state or calls an external model or website. Its repeated prose is deterministic test data; successful execution does not establish novel-writing quality.

## Commands and saved versions

Use an isolated DSH home and a temporary workspace. Add that workspace in the Web interface and create a Session there. Run each T14 command once, in the order below, in that Session; the fixed request IDs and exact prior-result checks make this a controlled acceptance sequence.

| Exact command | Native parent tools | Result checks |
| --- | --- | --- |
| `T14 写作三章` | Create novel → write → get manuscript → preview | Creates the short fictional brief with `t14-web-create`; `t14-web-write` selects `a1`, a three-chapter book and chapters 1–3. Requires all three applied chapters, each within 3,000–5,000 words, with fresh body and continuity references. Returns chapter 3's exact body preview. |
| `T14 修订设定并检查影响` | Get settings → revise → get settings → get manuscript | Revises the actual current `a1` head with `t14-web-revise-a1`, changing white lighthouse light to blue. Requires a new applied version whose `revisionOf` identifies the prior head. All three old body/continuity pairs must remain unchanged and become stale. Reports the impact without presenting the incomplete settings dimension. |
| `T14 更新三章并预览` | Update → get manuscript → preview | `t14-web-update` updates chapters 1–3. Requires all three fresh body/continuity pairs to have new IDs and all chapter counts to remain in range. Returns the new chapter 3 body preview. |
| `T01 创建并预览` | Create novel → preview | Fixed `t01-web-create-original` creates the long initial brief. Preview uses the actual creation result. |
| `T01 更新并预览` | Save brief → preview | Reads this Session's original T01 creation result, uses its revision precondition and `t01-web-update-v2`, and previews the actual saved version. |

T01 creation/update requests can be repeated with the same arguments to exercise idempotency and historical version access. Their briefs each contain 5,200 numbered records. The initial last-page marker is `T01_INITIAL_END_7F3A`; the revised marker is `T01_UPDATED_END_9C6B`. Check Markdown and plain-text preview beyond the default 5,000-line read page. Keep `maxArtifactBytes` at least 1,048,576.

Missing prerequisite results produce instructions or fail the request. Failed tools, missing offered tools, incomplete chapter sets, wrong preview identities and incorrect revision propagation fail visibly. Returning a preview result does not prove that a browser opened the file.

## Native child execution

The adapter identifies the logged `TASK_DATA` in each native child's prompt. Each child calls `story_read_artifact` for every exact input in 4,096-character pages, checks contiguous offsets, artifact metadata and EOF, and recomputes the complete UTF-8 SHA-256 before producing output. Reviews quote the parsed candidate bytes; continuity quotes the actual body and retains prior timeline evidence. Body generation uses the planned scene IDs and obligations and targets the total chapter length.

Research children read their inputs and start a plan for the exact brief and request ID with creative and external questions. They call native `web_fetch` for `https://story-fixture.invalid/navigation`; the registered local provider serves one fixed offline reference and rejects all other URLs. Children then read `story_research_results`, require the actual successful call ID, reference URL, complete excerpt and SHA-256, cite that call in the external finding, and reopen the completed `succeeded` plan before structured capture. Missing observations, unrelated calls or empty source content prevent completion. The production parser, log collector, review admission and atomic chapter application execute through actual writing tools and the native runner during profile acceptance. The reference is offline test data, not live factual research.

## Test-profile composition

Build the production plugin before starting the supported `dsh --profile web` CLI. Keep these choices in an isolated home, separate from the user's normal model settings. The overlay must disable production `llm-deepseek`, `llm-pi-ai`, `session-title-llm`, search and fetch provider entries. Configure `agent-default-model` with `provider: story-fixture` and `model: deterministic`, and configure the existing web service with `searchProvider: story-fixture-search` and `fetchProvider: story-fixture-fetch`. The fixture rejects auxiliary title/compaction requests and advertises a 262,144-token context window.

Use native tools, such as `DSH_TOOLS_MODE=native`. Retain the shipped profile's Session persistence, filesystem, `spawn` in-process subagent provider and web runtime. Its per-session preset owns the web tool consumer; do not add a duplicate host consumer. The story plugin needs `stageProvider: spawn`, `maxReadChars` at least 4,096, and its documented finite execution limits. Writing stages inherit the configured parent model and subscription. The default stage request budget accommodates these short T14 sources; the long T01 briefs are preview-only cases. Disable the fixture profile's spill policy and tool-result pruner so the deterministic adapter can validate complete logged JSON throughout the writing sequence; keep this override out of production configuration.

Mount the production entry from `lib/index.js`. Mount the fixture through a wrapper outside this package, because two direct absolute-path Loader entries with the same nearest `dsh.client` manifest would make the Client scanner discover duplicate sources. For this checkout, the wrapper's complete content is:

```js
export { apply, inject, name } from '/Users/hldz2/project/ai/dsh-story/tests/profile/fixture.mjs'
```

Put that wrapper in the temporary run directory outside any package declaring `dsh.client`; its Loader row names that absolute wrapper path. The fixture resolves public packages from this project's installed dependencies. It is excluded from the package's published `files` list. Loading the built plugin and validating installation from a private repository address remain distinct checks.

## Validation evidence

`node --test tests/profile/fixture.test.mjs` checks adapter decisions against explicit message and result fixtures and fetches the reference through the real local WebRuntime/provider. Those adapter tests construct logged observation records explicitly; actual collector provenance still requires the native integration and profile checks. Native runner integration tests separately exercise real tools, persistence and child Sessions. Neither check establishes a running shipped-profile or browser result.

For profile acceptance, record the exact CLI command, isolated home/workspace, port, Host log, browser console and relevant network responses. Confirm that the Client boot graph contains `dsh-story` and serves built `lib/client.js`. Inspect successful native stage and parent tool events. Automatic delivery presents four artifact kinds: the complete settings collection, book outline, chapter outlines and chapter bodies. A three-chapter writing run presents eight files: one collection, one book outline, three chapter outlines and three bodies. Open these complete versions and verify every chapter; research, reviews, continuity and individual settings dimensions remain internal records. A dimension-only revision reports impact and delivers no incomplete setting preview; its following update presents the new complete collection and downstream versions. After the setting revision, verify all three stale flags before explicit update; after update, compare every old/new body and continuity ID. Reopen historical cards, reload the Session and read the Markdown files back to verify exact UTF-8 bytes and SHA-256, including both T01 end markers. Record browser-open evidence separately from returned preview metadata.
