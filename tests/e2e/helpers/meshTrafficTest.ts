/**
 * Extended Playwright test fixture for tests that depend on receiving
 * messages from other nodes on the mesh network.
 *
 * Usage:
 *   import { test, expect } from '../helpers/meshTrafficTest';
 *   test('my test', { tag: '@mesh-traffic' }, async ({ page }) => { ... });
 *
 * When a @mesh-traffic-tagged test fails, an advisory annotation is added
 * to the HTML report and a console message is printed, letting the user
 * know the failure may be due to low mesh traffic rather than a real bug.
 *
 * Call `await nudgeEchoBot()` at the start of any @mesh-traffic test to
 * send a trigger message to an echo bot on #flightless. If the bot is in
 * radio range it will generate an incoming packet, potentially saving the
 * full 3-minute wait. The nudge is best-effort — tests still rely on the
 * long polling timeout for environments without the bot.
 */
import { test as base, expect } from '@playwright/test';
import { ensureFlightlessChannel, sendChannelMessage } from './api';

export { expect };

const TRAFFIC_ADVISORY =
  'This test depends on receiving messages from other nodes on the mesh ' +
  'network. Failure may indicate insufficient mesh traffic rather than a bug.';

/**
 * Best-effort: send a message to #flightless that triggers a remote echo
 * bot. If the bot is within radio range it will reply, generating the
 * incoming traffic the test needs. Failures are silently ignored — the
 * test will fall back to waiting for organic mesh traffic.
 */
export async function nudgeEchoBot(): Promise<void> {
  try {
    const channel = await ensureFlightlessChannel();
    await sendChannelMessage(channel.key, '!echo please give incoming message');
  } catch {
    // Best-effort — bot may not be reachable
  }
}

export const test = base.extend<{ _meshTrafficAdvisory: void }>({
  _meshTrafficAdvisory: [
    async ({}, use, testInfo) => {
      await use();
      if (testInfo.status !== 'passed' && testInfo.tags.includes('@mesh-traffic')) {
        testInfo.annotations.push({ type: 'notice', description: TRAFFIC_ADVISORY });
        // Also print to console so it's visible in terminal output
        console.log(`\n⚠️  ${TRAFFIC_ADVISORY}\n`);
      }
    },
    { auto: true },
  ],
});
