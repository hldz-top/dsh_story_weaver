/** Exact host package this plugin has been verified against. Not a range. */
import { createRequire } from 'node:module'

export const VERIFIED_DSH_SUBAGENT_VERSION = '0.2.2-rc.2'

const require = createRequire(import.meta.url)

/**
 * Read the version of the `@deepseek-ai/dsh-subagent` package Node resolves for this plugin.
 * That package exports `./package.json`. There is no documented DSH application version on the
 * live `subagents` service; `startActivation` existing does not identify a release.
 * @returns The resolved package version, or an empty string when the package cannot be read.
 */
export function resolvedSubagentPackageVersion(): string {
  try {
    const pkg = require('@deepseek-ai/dsh-subagent/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** The minimum live service shape checked before any writing storage or child is opened. */
export interface HostSubagentService { start?: unknown; startActivation?: unknown }

/**
 * Reject a host that is not the verified subagent package, or whose live service is not that contract.
 * @param subagentVersion - Version string from {@link resolvedSubagentPackageVersion}.
 * @param subagents - The loaded service, when the host mounted one.
 * @param agents - The loaded agent registry, required before a local child can be captured.
 */
export function assertVerifiedDshHost(subagentVersion: string, subagents: HostSubagentService | undefined, agents: unknown): void {
  const resolved = subagentVersion === '' ? 'unresolved' : JSON.stringify(subagentVersion)
  if (subagentVersion !== VERIFIED_DSH_SUBAGENT_VERSION) {
    throw new Error(`dsh-story-weaver requires the resolved @deepseek-ai/dsh-subagent package ${VERIFIED_DSH_SUBAGENT_VERSION}. Resolved ${resolved}. The package.json export identifies that module only; it is not a DSH application version, and startActivation existing does not identify a release.`)
  }
  if (subagents === undefined || typeof subagents.startActivation !== 'function' || typeof subagents.start === 'function') {
    throw new Error(`The loaded subagents service does not match the verified ${VERIFIED_DSH_SUBAGENT_VERSION} contract: startActivation must be a function and start must be absent. This shape check does not identify any other DSH release.`)
  }
  if (agents === undefined) throw new Error(`dsh-story-weaver requires the host agents service on DSH ${VERIFIED_DSH_SUBAGENT_VERSION} before writing storage opens.`)
}
