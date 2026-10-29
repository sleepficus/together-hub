// Experiment 4 probe (audit §c.4): Key Desk persistence across restart.
// Two REAL processes against one throwaway state dir (a real
// JsonFileStore dir — the step-2 persistence shape):
//   phase 1: boot, issue an invitation via the Key Desk action, the
//            agent exchanges it for a credential and makes recorded
//            actions; print the resulting desk facts as JSON.
//   phase 2: boot FRESH on the same dir; the credential must still
//            authenticate, and the Key Desk state (credential active,
//            invitation exchanged, last recorded action) must match
//            phase 1 exactly.
// The agent credential crosses from phase 1 to phase 2 via this
// script's stdout/env inside the throwaway run only — test material,
// deleted with the dir. Run: node scripts/probe-restart.ts

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2];

if (phase === 'phase1' || phase === 'phase2') {
  const transport = await import('../src/transport.ts');
  const keydesk = await import('../src/keydesk.ts');
  const status = await transport.startTransport();
  if (!status.wired) throw new Error(`transport not wired: ${status.error ?? ''}`);

  if (phase === 'phase1') {
    const issued = await keydesk.issueInvitation({
      projectId: 'hub-demo',
      displayName: 'probe-agent',
      scopes: ['read', 'help:write'],
    });
    const exchange = await transport.apiFetch('/api/v1/projects/hub-demo/enrollment/exchange', {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: randomUUID(), adapter: 'probe-restart' }),
    });
    const exchanged = (await exchange.json()) as { token?: string; credentialId?: string };
    if (exchange.status !== 201 || typeof exchanged.token !== 'string') {
      throw new Error(`exchange failed: ${exchange.status}`);
    }
    // One more recorded action so last-success is an agent action, and a
    // message the desk can see in the queue after the restart.
    const ask = await transport.apiFetch('/api/v1/projects/hub-demo/help', {
      method: 'POST',
      headers: { authorization: `Bearer ${exchanged.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: randomUUID(),
        question: 'probe: persistence check across a Hub restart',
        toId: transport.OWNER_ID,
      }),
    });
    if (ask.status !== 201) throw new Error(`help ask failed: ${ask.status}`);
    await ask.arrayBuffer();
    const state = await keydesk.readKeyDeskState();
    const agent = state.projects
      .find((p) => p.projectId === 'hub-demo')
      ?.agents.find((a) => a.identity.id === issued.identityId);
    console.log(JSON.stringify({
      identityId: issued.identityId,
      credentialId: exchanged.credentialId,
      token: exchanged.token,
      credentialStatus: agent?.credentials[0]?.status,
      invitationStatus: agent?.invitations[0]?.status,
      lastSuccessType: agent?.lastSuccess?.type,
      lastSuccessAt: agent?.lastSuccess?.at,
    }));
  } else {
    const token = process.env.PROBE_AGENT_TOKEN ?? '';
    const expect = JSON.parse(process.env.PROBE_EXPECT ?? '{}') as Record<string, string>;
    const read = await transport.apiFetch('/api/v1/projects/hub-demo/identities', {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = await keydesk.readKeyDeskState();
    const agent = state.projects
      .find((p) => p.projectId === 'hub-demo')
      ?.agents.find((a) => a.identity.id === expect.identityId);
    const queue = await transport.readQueue();
    console.log(JSON.stringify({
      authStatus: read.status,
      credentialStatus: agent?.credentials[0]?.status,
      invitationStatus: agent?.invitations[0]?.status,
      lastSuccessType: agent?.lastSuccess?.type,
      lastSuccessAt: agent?.lastSuccess?.at,
      queueTotal: queue.counts?.total,
    }));
  }
  await transport.stopTransport();
  process.exit(0);
}

// -- orchestrator ------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'together-hub-restart-'));
const self = fileURLToPath(import.meta.url);
const runPhase = (name: string, extraEnv: Record<string, string> = {}): Record<string, string> => {
  const run = spawnSync(process.execPath, [self, name], {
    env: { ...process.env, HUB_STATE_DIR: dir, HUB_API_PORT: '0', ...extraEnv },
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    throw new Error(`${name} exited ${run.status}`);
  }
  const lastLine = run.stdout.trim().split('\n').pop() ?? '{}';
  return JSON.parse(lastLine) as Record<string, string>;
};

let failures = 0;
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
  if (!ok) failures++;
};

try {
  const p1 = runPhase('phase1');
  verdict('phase 1 issued + exchanged a credential', p1.credentialStatus === 'active', `credential ${p1.credentialStatus ?? '?'}`);
  const p2 = runPhase('phase2', {
    PROBE_AGENT_TOKEN: p1.token,
    PROBE_EXPECT: JSON.stringify({ identityId: p1.identityId }),
  });
  verdict('credential still authenticates after restart', String(p2.authStatus) === '200', `GET identities -> ${p2.authStatus}`);
  verdict('credential state survived (active)', p2.credentialStatus === 'active', `status ${p2.credentialStatus ?? '?'}`);
  verdict('invitation state survived (exchanged)', p2.invitationStatus === 'exchanged', `status ${p2.invitationStatus ?? '?'}`);
  verdict(
    'last recorded action survived identically',
    p2.lastSuccessType === p1.lastSuccessType && p2.lastSuccessAt === p1.lastSuccessAt,
    `${p2.lastSuccessType ?? 'none'} @ ${p2.lastSuccessAt ?? 'none'}`,
  );
  verdict('queued handoff survived', Number(p2.queueTotal) === 1, `queue total ${p2.queueTotal ?? '?'}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  failures === 0
    ? 'PROBE PASSED — credential + last-success state persist across a Hub restart on a real JsonFileStore dir'
    : `PROBE FAILED — ${failures} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
