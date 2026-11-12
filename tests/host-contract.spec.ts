/** Host package version and live service shape, checked before storage or a child starts. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { assertVerifiedDshHost, resolvedSubagentPackageVersion, VERIFIED_DSH_SUBAGENT_VERSION } from '../src/host-contract.ts'
import * as Story from '../src/index.ts'

const verifiedService = { startActivation() { return Promise.reject(new Error('must not start')) } }

it('reads the official subagent package version and rejects every other release string', () => {
  expect(resolvedSubagentPackageVersion()).toBe(VERIFIED_DSH_SUBAGENT_VERSION)
  expect(VERIFIED_DSH_SUBAGENT_VERSION).toBe('0.2.2-rc.2')
  expect(() => assertVerifiedDshHost('0.2.2-rc.1', verifiedService, {})).toThrow(/0\.2\.2-rc\.2/)
  expect(() => assertVerifiedDshHost('0.2.0-rc.2', verifiedService, {})).toThrow(/package\.json export/)
  expect(() => assertVerifiedDshHost('', verifiedService, {})).toThrow(/unresolved/)
  expect(() => assertVerifiedDshHost(VERIFIED_DSH_SUBAGENT_VERSION, { start() { return undefined }, startActivation() { return undefined } }, {})).toThrow(/start must be absent/)
  expect(() => assertVerifiedDshHost(VERIFIED_DSH_SUBAGENT_VERSION, { startActivation: 'present' }, {})).toThrow(/startActivation must be a function/)
  expect(() => assertVerifiedDshHost(VERIFIED_DSH_SUBAGENT_VERSION, undefined, {})).toThrow(/startActivation must be a function/)
  expect(() => assertVerifiedDshHost(VERIFIED_DSH_SUBAGENT_VERSION, verifiedService, undefined)).toThrow(/agents service/)
  expect(() => assertVerifiedDshHost(VERIFIED_DSH_SUBAGENT_VERSION, verifiedService, {})).not.toThrow()
})

it('rejects a valid writing config before opening storage when the host service is absent', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await expect(Story.apply(ctx, new Story.Config())).rejects.toThrow(/startActivation must be a function/)
  expect(ctx.get('story')).toBeUndefined()
  expect(ctx.get('storyRunner')).toBeUndefined()
})
