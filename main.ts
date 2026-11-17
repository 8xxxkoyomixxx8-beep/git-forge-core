// Entry point: the trial lifecycle between this forge and the make.fun env.
//
// The env owns the trial. This process has exactly four jobs:
//   1. Read the env's origin from MAKEFUN_ENV_URL. With no env there is no
//      trial, so exit 1 immediately instead of idling.
//   2. Build the HTTP app (app.ts) and bind an ephemeral port with listen(0).
//      Port 8080 belongs to the env and is never bound here.
//   3. Register the bound port: POST {port} to $MAKEFUN_ENV_URL/register.
//      A 200 means the env now dials this process; a 409 means an earlier
//      register already won and is equally final. Contract errors (400, 405)
//      abort. Anything else (the env still starting, a reset connection) is
//      retried with backoff.
//   4. Poll GET $MAKEFUN_ENV_URL/done until its JSON body says done is true,
//      then close the server and exit 0. The process never exits early: a
//      failed poll only means "not done yet".

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One env request gets at most this long before it counts as a miss and the
// caller backs off and tries again.
const REQUEST_DEADLINE_MS = 30_000;
// Backoff between retries: starts short, doubles, and is capped, so a slow
// env is polled gently but a dead one is noticed quickly.
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(failures: number): number {
  const grown = BACKOFF_FLOOR_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CEILING_MS, grown);
}

// Register the port, retrying transient failures forever: the trial cannot
// start until the env knows where to dial, and giving up helps no one.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let verdict: 'registered' | 'fatal' | 'retry' = 'retry';
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (response.status === 200 || response.status === 409) {
        verdict = 'registered';
      } else if (response.status === 400 || response.status === 405) {
        process.stderr.write(`[entry] register answered HTTP ${response.status}: ${await response.text()}\n`);
        verdict = 'fatal';
      }
    } catch {
      verdict = 'retry'; // network-level miss: the env may still be starting
    }
    if (verdict === 'registered') return;
    if (verdict === 'fatal') throw new Error('register was refused by the env');
    failures += 1;
    await pause(backoffMs(failures));
  }
}

// Ask the env whether the trial is over, and keep asking until it says so.
async function awaitTrialEnd(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Unreachable or too slow: that is "not done", never a reason to exit.
    }
    failures += 1;
    await pause(backoffMs(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);
  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await awaitTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
