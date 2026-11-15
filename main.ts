// The entry <-> harness lifecycle: bind an ephemeral port, tell the harness
// where we listen, serve until it says the trial is over, then exit 0.
//
// The harness (the "env") listens on $MAKEFUN_ENV_URL. It waits for our
// register call, drives the forge from the address that call came from, and
// answers GET /done with {"done": false} while the suite runs and
// {"done": true} once its export is written. This file owns that exchange
// and nothing else; the forge itself lives in app.ts.

import { createForgeServer } from './lib/app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, nothing to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${envUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// Register the bound port. A 200 means the harness recorded us; a 409 means
// some other process registered first, which is not ours to fix, so we
// simply wait like any other entrant. Anything else is retried: the harness
// may still be coming up.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await postJson('/register', { port });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

// Poll GET /done until the harness says the trial is over.
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The harness is not answering yet: it is not done, so keep polling.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
