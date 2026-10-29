// Build step 4 probe: THE FIRST REAL CROSS-FAMILY HANDOFF, end to end,
// on the frozen demo task (a failing-test fix — BUILD-PLAN §5/§6, picked
// Oct 26).
//
// What this proves: the TRANSPORT AND THE RECORD. Two local stand-in
// seats with distinct Key Desk credentials — seat A labeled a Claude-side
// builder, seat B labeled a Codex-side builder — hand a real task to
// each other through Together's stock HTTP API surface exactly as the
// repo's CLI/MCP adapters do (audit row 7: no new agent-side protocol,
// no Hub-internal shortcuts for the agent legs). Seat B applies the
// known one-line fixture correction and runs the fixture's test; agent
// JUDGMENT is not exercised and not claimed — the seats are stand-ins,
// and the deliberate-failure beat belongs to the demo run, not here.
//
// Chain: owner creates the demo project and issues two invitations
// (Key Desk flow) -> seats exchange them for their own project-scoped
// credentials -> fixture verified FAILING -> A posts the task to B
// (help request addressed to B) -> B pulls its inbox (the recording
// read: delivery flips, as designed) -> B reads the task detail ->
// B accepts -> B fixes the fixture, test goes PASS -> B answers with
// the test evidence in the body -> A pulls its inbox and reads the
// result -> the Hub's non-recording queue projection, the receipts
// (event log), and the Key Desk per-agent state are asserted, and the
// receipts page is hashed (sha256 over the canonical events JSON).
//
// Build step 6 extends the record assertions: the dispatcher's rules
// router must have annotated both legs of the chain (routed_by
// "rules", deliver to the named addressee, summary with provenance).
//
// Everything runs in throwaway state/fixture dirs, removed at the end.
// Run: npm run probe:handoff   (exits nonzero on any failed assertion)

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env before Hub imports (read at start time) — dynamic imports below.
const root = mkdtempSync(join(tmpdir(), 'together-hub-handoff-'));
const stateDir = join(root, 'state');
process.env.HUB_STATE_DIR = stateDir;
process.env.HUB_API_PORT = '0';

const { startHubServer } = await import('../src/server.ts');
const transport = await import('../src/transport.ts');
const keydesk = await import('../src/keydesk.ts');
const dispatcher = await import('../src/dispatcher.ts');

let failures = 0;
const lines: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  lines.push(line);
  if (!ok) failures++;
}
function note(text: string): void {
  console.log(text);
  lines.push(text);
}

// ---------------------------------------------------------------- fixture
const fixtureDir = join(root, 'fixture');
mkdirSync(fixtureDir, { recursive: true });
const BUGGY = [
  '// Fixture under repair: average() must return the mean of two numbers.',
  'export function average(a, b) {',
  '  return a + b; // BUG: sums instead of averaging',
  '}',
  '',
].join('\n');
const FIXED = [
  '// Fixture under repair: average() must return the mean of two numbers.',
  'export function average(a, b) {',
  '  return (a + b) / 2;',
  '}',
  '',
].join('\n');
const TEST = [
  "import { average } from './math.js';",
  '',
  'let failed = 0;',
  'const cases = [[4, 6, 5], [10, 0, 5], [-2, 2, 0]];',
  'for (const [a, b, want] of cases) {',
  '  const got = average(a, b);',
  '  if (got !== want) { console.error(`average(${a}, ${b}) = ${got}, want ${want}`); failed++; }',
  '}',
  "if (failed > 0) { console.error(`${failed} case(s) failed`); process.exit(1); }",
  "console.log('all average() cases pass');",
  '',
].join('\n');
writeFileSync(join(fixtureDir, 'math.js'), BUGGY);
writeFileSync(join(fixtureDir, 'test.mjs'), TEST);
const runFixtureTest = (): { status: number; out: string } => {
  const run = spawnSync(process.execPath, [join(fixtureDir, 'test.mjs')], { encoding: 'utf8' });
  return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}`.trim() };
};

// ------------------------------------------------------------- HTTP client
interface Leg {
  name: string;
  status: number;
  ms: number;
}
const legs: Leg[] = [];
async function call(
  legName: string,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const t0 = performance.now();
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  legs.push({ name: legName, status: res.status, ms });
  return { status: res.status, body };
}

const hub = await startHubServer(0);
try {
  const status = transport.getTransportStatus();
  check('hub booted, transport wired', status.wired === true, `api port ${status.apiPort}`);
  const apiBase = `http://127.0.0.1:${status.apiPort}`;
  const ownerToken = readFileSync(join(stateDir, 'owner-token'), 'utf8').trim();

  // ------------------------------------------------------------ owner setup
  const proj = await call('owner: create demo project', `${apiBase}/api/v1/projects`, ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      goal: 'Hub step-4 demo project — frozen demo task: failing-test fix, handed Claude-side -> Codex-side',
    }),
  });
  const project = (proj.body.project ?? {}) as { id?: string };
  const projectId = project.id ?? '';
  check('owner created the demo project', proj.status === 201 && projectId !== '', `project ${projectId}`);
  const P = `${apiBase}/api/v1/projects/${encodeURIComponent(projectId)}`;

  const issueSeat = async (
    legPrefix: string,
    displayName: string,
  ): Promise<{ identityId: string; token: string; credentialId: string }> => {
    const created = await call(`${legPrefix}: owner creates identity`, `${P}/identities`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ operationId: randomUUID(), displayName }),
    });
    const identityId = String(((created.body.identity ?? {}) as { id?: string }).id ?? '');
    const invited = await call(
      `${legPrefix}: owner issues invitation`,
      `${P}/identities/${encodeURIComponent(identityId)}/invitations`,
      ownerToken,
      {
        method: 'POST',
        body: JSON.stringify({
          operationId: randomUUID(),
          scopes: ['read', 'help:write'],
          // This probe calls Together's API directly (not via the Key
          // Desk), but follows the Hub's always-expire policy (Job 001
          // F1): every Hub-issued invitation sets credentialExpiresAt.
          credentialExpiresAt: new Date(
            Date.now() + keydesk.HUB_CREDENTIAL_TTL_MS,
          ).toISOString(),
        }),
      },
    );
    const invitationToken = String(invited.body.token ?? '');
    const exchanged = await call(
      `${legPrefix}: seat exchanges invitation for its credential`,
      `${P}/enrollment/exchange`,
      invitationToken,
      {
        method: 'POST',
        body: JSON.stringify({ operationId: randomUUID(), adapter: 'probe-handoff' }),
      },
    );
    return {
      identityId,
      token: String(exchanged.body.token ?? ''),
      credentialId: String(exchanged.body.credentialId ?? ''),
    };
  };

  const seatA = await issueSeat('seat A (Claude-side)', 'seat-a-claude-builder');
  const seatB = await issueSeat('seat B (Codex-side)', 'seat-b-codex-builder');
  check(
    'seat A holds its own project-scoped credential',
    seatA.token !== '' && seatA.identityId !== '',
    `identity ${seatA.identityId}`,
  );
  check(
    'seat B holds its own, distinct credential',
    seatB.token !== '' && seatB.identityId !== '' && seatB.identityId !== seatA.identityId,
    `identity ${seatB.identityId}`,
  );

  // ------------------------------------------------------------ fixture red
  const before = runFixtureTest();
  check(
    'fixture test FAILS before the handoff (frozen demo task precondition)',
    before.status !== 0,
    `exit ${before.status}: ${before.out.split('\n')[0] ?? ''}`,
  );

  // ------------------------------------------------------------- the handoff
  const question =
    `HANDOFF (frozen demo task: failing-test fix). Fixture package: ${fixtureDir} ` +
    `(source: math.js, test: test.mjs — run \`node test.mjs\`). Failing test: ` +
    `average(4, 6) must equal 5; the suite currently exits ${before.status}. ` +
    `Please fix math.js so the suite passes and answer with the test evidence (command + exit code).`;
  const posted = await call('A -> B: A posts the task', `${P}/help`, seatA.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), question, toId: seatB.identityId }),
  });
  const help = (posted.body.help ?? {}) as { id?: string };
  const message = (posted.body.message ?? {}) as { id?: string; delivery?: string };
  const helpId = help.id ?? '';
  const taskMessageId = message.id ?? '';
  check(
    'seat A posted the task to seat B through the API',
    posted.status === 201 && helpId !== '' && taskMessageId !== '',
    `help ${helpId}, message ${taskMessageId}`,
  );

  const taskIndexBefore1 = await transport.readQueue();
  const taskIndexBefore2 = await transport.readQueue();
  const taskIndexed1 = taskIndexBefore1.items.find((m) => m.id === taskMessageId);
  const taskIndexed2 = taskIndexBefore2.items.find((m) => m.id === taskMessageId);
  const taskDetailBefore = await transport.readQueueDetail(projectId, taskMessageId);
  check(
    'queue INDEX lists the agent-to-agent task, non-recording across two reads (parties + queued state, detail agrees)',
    taskIndexed1?.senderId === seatA.identityId &&
      taskIndexed1?.recipientId === seatB.identityId &&
      taskIndexed1?.delivery === 'queued' &&
      taskIndexed2?.delivery === 'queued' &&
      taskDetailBefore?.delivery === taskIndexed1?.delivery &&
      taskDetailBefore?.recipientId === taskIndexed1?.recipientId,
    `index ${String(taskIndexed1?.delivery ?? 'absent')} -> ${String(taskIndexed2?.delivery ?? 'absent')}, detail ${String(taskDetailBefore?.delivery ?? 'absent')}`,
  );

  const bInbox = await call('B: pulls its inbox (recording read)', `${P}/inbox?limit=50`, seatB.token);
  const bMessages = Array.isArray(bInbox.body.messages)
    ? (bInbox.body.messages as Record<string, unknown>[])
    : [];
  const bCopy = bMessages.find((m) => m.id === taskMessageId);
  check(
    "seat B's inbox pull delivers the task (delivery flips to delivered, as designed)",
    bInbox.status === 200 && bCopy?.delivery === 'delivered',
    `delivery ${String(bCopy?.delivery ?? 'not found')}`,
  );

  const taskIndexAfterPull = await transport.readQueue();
  const taskIndexedAfterPull = taskIndexAfterPull.items.find((m) => m.id === taskMessageId);
  const taskDetailAfterPull = await transport.readQueueDetail(projectId, taskMessageId);
  check(
    'queue INDEX reflects the recorded delivery after B pulls its inbox (detail agrees)',
    taskIndexedAfterPull?.delivery === 'delivered' &&
      taskDetailAfterPull?.delivery === taskIndexedAfterPull?.delivery &&
      taskDetailAfterPull?.recipientId === seatB.identityId,
    `index/detail ${String(taskIndexedAfterPull?.delivery ?? 'absent')}/${String(taskDetailAfterPull?.delivery ?? 'absent')}`,
  );

  const detail = await call('B: reads the task detail', `${P}/help/${encodeURIComponent(helpId)}`, seatB.token);
  const detailHelp = (detail.body.help ?? {}) as { question?: string; state?: string; revision?: number };
  check(
    'seat B read the task detail (fixture reference + failing test named)',
    detail.status === 200 &&
      (detailHelp.question ?? '').includes('average(4, 6)') &&
      (detailHelp.question ?? '').includes(fixtureDir),
    `state ${detailHelp.state ?? '?'}, revision ${detailHelp.revision ?? '?'}`,
  );

  // Together's write protocol: entity-targeted writes carry the current
  // expectedRevision (lib/core.ts command()). Thread it accept -> answer.
  const accepted = await call('B: accepts the task', `${P}/help/${encodeURIComponent(helpId)}/accept`, seatB.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), expectedRevision: detailHelp.revision }),
  });
  const acceptedHelp = (accepted.body.help ?? {}) as { revision?: number; state?: string };
  check(
    'seat B accepted the task',
    accepted.status === 200 && acceptedHelp.state === 'accepted',
    `status ${accepted.status}`,
  );
  // The accept response carries the pre-bump revision; re-read the
  // detail to thread the CURRENT revision into the answer write.
  const detailAfterAccept = await call(
    'B: re-reads the task detail (current revision)',
    `${P}/help/${encodeURIComponent(helpId)}`,
    seatB.token,
  );
  const currentHelp = (detailAfterAccept.body.help ?? {}) as { revision?: number; state?: string };

  // Seat B does the work: the known one-line correction, then the test.
  writeFileSync(join(fixtureDir, 'math.js'), FIXED);
  const after = runFixtureTest();
  check(
    'fixture test PASSES after seat B applies the fix',
    after.status === 0,
    `exit ${after.status}: ${after.out.split('\n')[0] ?? ''}`,
  );

  const answerText =
    `DONE — failing-test fix complete. Fixture: ${fixtureDir} (math.js: average returns (a + b) / 2). ` +
    `Evidence — command: node test.mjs; before: exit ${before.status} (average(4, 6) = 10, want 5); ` +
    `after: exit ${after.status} (${after.out.split('\n')[0] ?? 'pass'}).`;
  const answered = await call('B -> A: B posts the result back', `${P}/help/${encodeURIComponent(helpId)}/answer`, seatB.token, {
    method: 'POST',
    body: JSON.stringify({
      operationId: randomUUID(),
      expectedRevision: currentHelp.revision,
      answer: answerText,
    }),
  });
  const reply = (answered.body.reply ?? {}) as { id?: string };
  const replyId = reply.id ?? '';
  check(
    'seat B posted the result back through the API (test evidence in the body)',
    answered.status === 200 && replyId !== '',
    `reply message ${replyId}`,
  );

  const replyIndexBefore1 = await transport.readQueue();
  const replyIndexBefore2 = await transport.readQueue();
  const replyIndexed1 = replyIndexBefore1.items.find((m) => m.id === replyId);
  const replyIndexed2 = replyIndexBefore2.items.find((m) => m.id === replyId);
  const replyDetailBefore = await transport.readQueueDetail(projectId, replyId);
  check(
    'queue INDEX lists the agent-to-agent result, non-recording across two reads (parties + queued state, detail agrees)',
    replyIndexed1?.senderId === seatB.identityId &&
      replyIndexed1?.recipientId === seatA.identityId &&
      replyIndexed1?.delivery === 'queued' &&
      replyIndexed2?.delivery === 'queued' &&
      replyDetailBefore?.delivery === replyIndexed1?.delivery &&
      replyDetailBefore?.recipientId === replyIndexed1?.recipientId,
    `index ${String(replyIndexed1?.delivery ?? 'absent')} -> ${String(replyIndexed2?.delivery ?? 'absent')}, detail ${String(replyDetailBefore?.delivery ?? 'absent')}`,
  );

  const aInbox = await call('A: pulls its inbox (recording read)', `${P}/inbox?limit=50`, seatA.token);
  const aMessages = Array.isArray(aInbox.body.messages)
    ? (aInbox.body.messages as Record<string, unknown>[])
    : [];
  const aCopy = aMessages.find((m) => m.id === replyId);
  check(
    'seat A pulled its inbox and read the result (delivered, evidence intact)',
    aInbox.status === 200 &&
      aCopy?.delivery === 'delivered' &&
      String(aCopy?.body ?? '').includes('exit 0'),
    `delivery ${String(aCopy?.delivery ?? 'not found')}`,
  );

  // --------------------------------------------------------- assert the record
  // The queue INDEX is event-log anchored (build step 4.5): both
  // agent-to-agent legs must be listed there, with the same parties and
  // delivery states the detail surface reports — no owner-mail detour.
  const finalIndex = await transport.readQueue();
  const qTask = finalIndex.items.find((m) => m.id === taskMessageId);
  const qReply = finalIndex.items.find((m) => m.id === replyId);
  const qTaskDetail = await transport.readQueueDetail(projectId, taskMessageId);
  const qReplyDetail = await transport.readQueueDetail(projectId, replyId);
  check(
    'queue INDEX shows the full chain after A pulls its inbox, both legs delivered (detail agrees)',
    qTask?.delivery === 'delivered' &&
      qTask?.senderId === seatA.identityId &&
      qTask?.recipientId === seatB.identityId &&
      qTaskDetail?.delivery === qTask?.delivery &&
      qReply?.delivery === 'delivered' &&
      qReply?.senderId === seatB.identityId &&
      qReply?.recipientId === seatA.identityId &&
      qReplyDetail?.delivery === qReply?.delivery,
    `task ${String(qTask?.delivery ?? 'absent')} -> B, result ${String(qReply?.delivery ?? 'absent')} -> A`,
  );

  const receipts = await transport.readReceipts();
  const page = receipts.pages.find((p) => p.projectId === projectId);
  const events = receipts.items
    .filter((e) => e.projectId === projectId)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  check(
    'receipts page is complete (no event lost to the page cap)',
    page !== undefined && page.count === events.length,
    `${events.length} events, latest seq ${page?.latestSeq ?? '?'}`,
  );
  const byType = (type: string) => events.find((e) => e.type === type);
  const offered = byType('help:offered');
  const acceptedEv = byType('help:accepted');
  const answeredEv = byType('help:answered');
  check(
    'receipts carry the posted leg (help:offered by seat A, with seq)',
    offered !== undefined && typeof offered.seq === 'number' && offered.actorId === seatA.identityId,
    `seq ${String(offered?.seq ?? 'absent')}`,
  );
  check(
    'receipts carry the acceptance and the result leg (help:accepted, help:answered by seat B, in order)',
    acceptedEv !== undefined &&
      answeredEv !== undefined &&
      Number(answeredEv.seq) > Number(acceptedEv.seq) &&
      answeredEv.actorId === seatB.identityId,
    `accepted seq ${String(acceptedEv?.seq ?? 'absent')}, answered seq ${String(answeredEv?.seq ?? 'absent')}`,
  );
  const canonicalEvents = JSON.stringify(events);
  const receiptsHash = createHash('sha256').update(canonicalEvents).digest('hex');
  note(`receipts sha256 (canonical events JSON, ${events.length} events): ${receiptsHash}`);

  const desk = await keydesk.readKeyDeskState();
  const deskProject = desk.projects.find((p) => p.projectId === projectId);
  const deskA = deskProject?.agents.find((a) => a.identity.id === seatA.identityId);
  const deskB = deskProject?.agents.find((a) => a.identity.id === seatB.identityId);
  // The desk's "last recorded action" is the identity's latest event;
  // Together appends an operation:* event per confirmed command, so the
  // assertion is positional: each seat's last action sits at or after
  // the leg it performed.
  check(
    "Key Desk shows seat A's last recorded action at/after the task it posted",
    deskA?.lastSuccess != null &&
      offered !== undefined &&
      deskA.lastSuccess.seq >= Number(offered.seq),
    `lastSuccess ${deskA?.lastSuccess?.type ?? 'none'} (seq ${deskA?.lastSuccess?.seq ?? '?'})`,
  );
  check(
    "Key Desk shows seat B's last recorded action at/after the result it posted",
    deskB?.lastSuccess != null &&
      answeredEv !== undefined &&
      deskB.lastSuccess.seq >= Number(answeredEv.seq),
    `lastSuccess ${deskB?.lastSuccess?.type ?? 'none'} (seq ${deskB?.lastSuccess?.seq ?? '?'})`,
  );

  // ------------------------------------------- dispatcher (build step 6)
  // Both legs of the chain name an enrolled addressee, so the rules
  // router must have annotated them deliver-to-that-identity with
  // routed_by "rules" — summary and provenance on the same record.
  // Drain explicitly so the assertions never depend on the poll tick.
  await dispatcher.processDispatcherOnce();
  const taskAnnotation = dispatcher.getAnnotation(projectId, taskMessageId);
  const replyAnnotation = dispatcher.getAnnotation(projectId, replyId);
  check(
    'dispatcher annotated both chain legs: routed_by rules, deliver to the named addressees, summaries present',
    taskAnnotation?.routed_by === 'rules' &&
      taskAnnotation.decision.action === 'deliver' &&
      taskAnnotation.decision.to === seatB.identityId &&
      taskAnnotation.summary.length > 0 &&
      replyAnnotation?.routed_by === 'rules' &&
      replyAnnotation.decision.action === 'deliver' &&
      replyAnnotation.decision.to === seatA.identityId &&
      replyAnnotation.summary.length > 0,
    `task -> ${String(taskAnnotation?.decision.to ?? 'none')}, reply -> ${String(replyAnnotation?.decision.to ?? 'none')}`,
  );
  check(
    'each annotation carries its provenance beside the summary (reason + decidedAt + anchoring eventSeq on the same record)',
    typeof taskAnnotation?.decision.reason === 'string' &&
      taskAnnotation.decision.reason.length > 0 &&
      typeof taskAnnotation?.decidedAt === 'string' &&
      typeof taskAnnotation?.eventSeq === 'number' &&
      typeof replyAnnotation?.decision.reason === 'string' &&
      typeof replyAnnotation?.eventSeq === 'number',
    `task eventSeq ${String(taskAnnotation?.eventSeq ?? 'absent')}, reply eventSeq ${String(replyAnnotation?.eventSeq ?? 'absent')}`,
  );
  note(`dispatcher annotation (task leg): ${JSON.stringify(taskAnnotation)}`);

  // ---------------------------------------------------------------- summary
  note('');
  note('--- HANDOFF RUN SUMMARY (stand-in seats; transport + record proven) ---');
  for (const leg of legs) note(`leg ${leg.name}: HTTP ${leg.status}, ${leg.ms.toFixed(1)} ms`);
  note(`fixture test before: FAIL (exit ${before.status}); after: PASS (exit ${after.status})`);
  note(`events on the project receipt: ${events.length}; receipts sha256: ${receiptsHash}`);
} finally {
  await hub.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? 'PROBE PASSED — cross-family handoff flowed end to end through the stock API; the record is complete and hash-complete'
    : `PROBE FAILED — ${failures} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
