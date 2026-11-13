---
description: "Independent dependency resolution, native-runtime tests, builds and acceptance evidence for DSH Story contributors."
---
# Development and validation

## Summary

Build and test this independent plugin against its installed public DSH dependencies. Use an isolated supported DSH profile for built Host and browser integration. The [migration validation record](migration-validation.md#final-local-checks) records the passed final local checks and package inspection after the four-kind presentation change. The [real-model attempt](real-model-validation.md) failed before any reader documents; current-policy browser acceptance remains pending. Earlier T01, T02 and T03 records retain evidence from their own source snapshots.

## Table of Contents

- [Environment and dependencies](#environment)
- [Local checks](#checks)
- [Build and package inspection](#packaging)
- [Isolated profile validation](#profile)
- [CI isolation](#ci)
- [Evidence and remaining checks](#evidence)

<a id="environment"></a>
## Environment and dependencies

Maintain documentation and the package README in English only. Keep one canonical document per topic without translated copies or language-switch links.

Use the Node engine range and pinned package-manager version in [package.json](../../package.json). Runtime, peer and development dependencies resolve from this project's lockfile and `node_modules`. A sibling checkout's dependencies or TypeScript source aliases do not establish compatibility with published packages. Dependencies imported at runtime must remain available to the installed bundle; test-only installation does not satisfy that requirement.

Story is a read-only source of domain behavior, and the adjacent DSH checkout is an integration reference. Production code cannot import their source paths or embed another AgentLoop or Python runtime. Dependency installation, environment changes and publication follow [repository authorization rules](../../AGENTS.md); this guide grants none of those permissions.

The plugin mounts the host capabilities listed in [runner configuration](../api/writing-runner.md#configuration). A deployment must supply its verified native in-process spawn provider, Session persistence, filesystem and web tools. Model routing and access policy remain DSH configuration. The bundle patch only inserts the plugin; it does not replace the user's model, storage or security settings.

<a id="checks"></a>
## Local checks

Run from this repository with its approved dependencies installed:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

| Command | Responsibility |
| --- | --- |
| `npm run typecheck` | Checks Host, Client and test programs, then verifies public Client types resolved from installed declarations. |
| `npm run lint` | Checks source, tests, scripts and Vitest configuration with the local linter. |
| `npm test` | Runs Vitest behavior tests and Node tests for the Client build and offline profile fixture. |
| `npm run build` | Emits Host JavaScript and declarations, Client declarations and the browser module-loader artifact. |

The [Client declaration check](../../scripts/check-client-types.mjs) complements `skipLibCheck`: it rejects source aliases and verifies that selected public card properties, call parameters and returns do not resolve to `any` or `unknown`. [Its regressions](../../tests/build-client.test.mjs) cover missing declarations that declaration skipping can conceal.

During implementation, select relevant test files with the pinned executable; this avoids package-download wrappers and build-cache writes:

```sh
node node_modules/vitest/vitest.mjs run tests/run-tools.spec.ts tests/run-store.spec.ts tests/writing-revisions.spec.ts --configLoader runner --cache=false
```

The [Vitest configuration](../../vitest.config.ts) provides 60-second test and hook timeouts for complete native writing and durable cleanup under concurrent suite load. The validation record retains the earlier 15-second timeout and measured three-chapter duration; assertions remain unchanged.

Service and run-store tests use real isolated JSON and SQLite providers. Native writing fixtures mount public DSH AgentLoop, ToolRuntime, spawn and JSONL Session persistence; deterministic model responses and local web providers replace external services. Tests cover logged input, exact artifact pages, typed output admission, review/application, interrupted attempts and cleanup. A passing deterministic scenario establishes that behavior, not production-model quality or an actual killed-process recovery test.

<a id="packaging"></a>
## Build and package inspection

Host and Client have separate TypeScript programs. [The Client builder](../../scripts/build-client.mjs) emits `lib/client.js` for DSH's module loader, sharing host React modules and rejecting unsupported runtime or CSS imports. [The manifest](../../package.json) declares exports, peers and the bundle patch.

After building, inspect an archive in an existing temporary directory. Substitute its path below; the command packs existing outputs without installing or publishing:

```text
npm pack --ignore-scripts --pack-destination <temporary-directory> --json
```

Verify that the archive contains the Host entry, Client artifact, declarations and bundle patch, and excludes test fixtures, working data and credentials. A valid archive does not establish private authentication, dependency resolution or plugin activation. T15 requires a built fixed-version installation from outside the source checkout, exact version readback, reload, disable/re-enable and a working writing operation.

<a id="profile"></a>
## Isolated profile validation

Final local checks after the four-kind presentation change passed. Complete built-profile/browser acceptance when its prerequisites and any new paid execution are authorized; the attempted real-model flow failed during research. Proactive full-preview access covers complete settings collections, book outlines, chapter outlines and bodies; internal artifacts remain explicitly readable. The [post-development checklist](post-development-validation.md) remains the UI acceptance record. Source tests and the historical T01 browser flow cannot certify the expanded writing UI.

Use supported `dsh --profile` entry points with a private DSH home, separate profile overlay and temporary workspace. Record the actual built host version. The plugin now requires DSH `0.2.2-rc.3` exactly. Earlier acceptance on `0.2.0-rc.2-639ed01-dirty` remains historical; its dependency record is [the DSH 0.2 dependency upgrade](dsh-0.2-dependencies.md). Keep deterministic fixture configuration out of the user's saved providers and novels. [The offline profile guide](../../tests/profile/README.md) owns concrete fixture commands, provider exclusions and built Client loading.

Exercise create → write → review → full preview → upstream revise → impact → explicit update → restart. Observe only the four eligible kinds proactively: `settings`, `book-outline`, `chapter-outline` and `body`, including eligible repair versions. A fresh three-chapter run without repairs produces eight documents. Read internal research, dimensions, reviews, continuity and rejected outputs explicitly when auditing; new automatic links for those records are outside the presentation scope. Confirm automatic continuation, exact historical version links and actual end-of-file readback. Record Session tool results, preview paths, Host/background logs, browser console and network responses; a fixture completion message is not proof of full document display.

Concurrency checks use unique storage directories and deterministic barriers. Tests and manual profiles own and dispose their Contexts, file handles and processes. Stop and shutdown verification must await accepted work and native child disposal; an idle parent alone is insufficient.

<a id="ci"></a>
## CI isolation

[The workflow](../../.github/workflows/check.yml) declares Ubuntu jobs for Node 22.19.0 and 24.18.0. It installs the frozen lockfile with lifecycle scripts disabled, then runs the same four scripts. Repository permissions are read-only, checkout credentials are not persisted and the workflow has no publication step. This describes configuration, not an executed CI result.

Offline tests must not load production credentials, make paid requests, install into a user's profile or publish artifacts. Real-model quality and private-address installation require their separately authorized scopes and recorded results.

<a id="evidence"></a>
## Evidence and remaining checks

Use [current migration validation](migration-validation.md) for final local results, named focused snapshots and remaining acceptance work. Preserve [T01](t01-validation.md), [T02](t02-validation.md) and [T03](t03-validation.md) as historical observations, including earlier failures and incomplete states. Do not add focused counts together and call them a final aggregate, or transfer evidence to files changed afterward without rerunning the affected checks.

The final four-script validation and package inspection passed after the presentation scope changed. The single real-model attempt failed during research; the [failure report](real-model-validation.md) separates the proposed plugin repair from DNS/environment work, both awaiting approval. Do not resume or resubmit the terminal run. Remaining completion work includes full current-policy browser acceptance, real-model three-chapter reading after a newly authorized attempt, private CLI installation, and final human UI acceptance. The [real-model preflight](real-model-acceptance-preflight.md) retains the attempted sample and limits; its single-run authorization is consumed. Stage publication uses the [native delivery service](../api/stage-deliveries.md) and [live tool cards](../api/live-stage-cards.md). Linux/Node 22 execution also needs actual CI evidence. Local implementation or validation does not authorize Git or release actions.
