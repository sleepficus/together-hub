// Experiment 6 probe (audit §c.6): index-cap sizing at demo-plus scale.
// Seeds 500 synthetic handoffs (messages addressed to the owner) into a
// THROWAWAY state dir through Together's own store, then measures the
// Hub's real read paths: queue page 1 payload bytes + latency at the
// declared cap, a full cursor walk over all 500, and one detail read.
// Verdict: page 1 must fit the declared index byte budget
// (HUB_CAPS.indexByteBudget); the detail must fit the detail budget.
// Seeding writes message records AND their anchoring lifecycle events
// directly into a draft transaction — the queue index is event-log
// anchored (build step 4.5), so a synthetic handoff needs both halves,
// exactly as a real send path leaves them. It exercises the READ
// surfaces only and claims nothing about send paths.
// Run: node scripts/probe-caps.ts (exit 1 if a budget is blown)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'together-hub-caps-'));
process.env.HUB_STATE_DIR = stateDir;
process.env.HUB_API_PORT = '0';

const transport = await import('../src/transport.ts');

const SEEDED = 500;
const status = await transport.startTransport();
if (!status.wired) {
  console.error(`transport not wired: ${status.error ?? status.selfCheck.detail}`);
  process.exit(1);
}

const store = transport.projectStore('hub-demo');
if (store === undefined) throw new Error('hub-demo store missing');
const base = Date.now() - SEEDED * 60_000;
await store.transact((draft) => {
  for (let i = 0; i < SEEDED; i++) {
    const at = new Date(base + i * 60_000).toISOString();
    const id = `seed-msg-${String(i).padStart(4, '0')}`;
    draft.messages[id] = {
      id,
      projectId: 'hub-demo',
      revision: 1,
      createdAt: at,
      updatedAt: at,
      actorId: 'seed-agent',
      senderId: 'seed-agent',
      recipientId: transport.OWNER_ID,
      type: 'handoff',
      body:
        `handoff ${i}: finished the parser pass on the demo task; ` +
        'next is the wiring step, uncertain about the fixture format, ' +
        'verify the receipt before repeating the migration.',
      delivery: 'queued',
    };
    draft.events.push({
      id: `seed-event-${String(i).padStart(4, '0')}`,
      projectId: 'hub-demo',
      seq: draft.events.length + 1,
      createdAt: at,
      actorId: 'seed-agent',
      actorKind: 'agent',
      type: 'offer:sent',
      entityId: id,
      detail: { recipientId: transport.OWNER_ID },
    });
  }
  return true;
});

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

let failures = 0;
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
  if (!ok) failures++;
};

const t0 = performance.now();
const page1 = await transport.readQueue();
const page1Ms = performance.now() - t0;
verdict(
  'page 1 item count equals the declared cap',
  page1.items.length === transport.HUB_CAPS.queuePageLimit,
  `${page1.items.length} items (cap ${transport.HUB_CAPS.queuePageLimit})`,
);
verdict(
  'counts report the full seeded total',
  page1.counts?.total === SEEDED,
  `total ${String(page1.counts?.total)} of ${SEEDED}`,
);
verdict(
  'page 1 payload fits the declared index byte budget',
  bytes(page1) <= transport.HUB_CAPS.indexByteBudget,
  `${bytes(page1)} bytes vs budget ${transport.HUB_CAPS.indexByteBudget} · ${page1Ms.toFixed(1)} ms`,
);

const tWalk = performance.now();
let walked = page1.items.length;
let cursor = page1.nextCursor;
let pages = 1;
while (cursor !== null) {
  const page = await transport.readQueue(cursor);
  walked += page.items.length;
  cursor = page.nextCursor;
  pages++;
}
const walkMs = performance.now() - tWalk;
verdict(
  'cursor walk reaches every seeded handoff',
  walked === SEEDED,
  `${walked} items over ${pages} pages · ${walkMs.toFixed(1)} ms total`,
);

const tDetail = performance.now();
const detail = await transport.readQueueDetail('hub-demo', 'seed-msg-0250');
const detailMs = performance.now() - tDetail;
verdict(
  'detail read returns the one record within the detail byte budget',
  detail !== null && bytes(detail) <= transport.HUB_CAPS.detailByteBudget,
  detail === null
    ? 'record missing'
    : `${bytes(detail)} bytes vs budget ${transport.HUB_CAPS.detailByteBudget} · ${detailMs.toFixed(1)} ms`,
);

await transport.stopTransport();
rmSync(stateDir, { recursive: true, force: true });
console.log(
  failures === 0
    ? `PROBE PASSED — caps hold at ${SEEDED} seeded handoffs`
    : `PROBE FAILED — ${failures} budget check(s) blown`,
);
process.exitCode = failures === 0 ? 0 : 1;
