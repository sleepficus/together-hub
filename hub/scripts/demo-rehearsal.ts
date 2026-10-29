// DEMO REHEARSAL RUN #1 (2026-10-26) — a rehearsal with receipts,
// NOT the final film and NOT demo-day evidence.
//
// The frozen demo chain (submission narrative, layer 4) run end to end
// once, timed, with an honest cast:
//   DISPATCH — Muse Spark (Meta Model API), REAL: the dispatcher's
//     wired model path (HUB_DISPATCHER_MODEL=on, no stand-in) routes
//     every leg; annotations carry routed_by from the real calls.
//   SEAT A (the poster) — a Claude-family worker, REAL: claude-sonnet-5-5
//     called through the Anthropic connector helper. The model composes
//     the actual help-request texts that get posted under seat A's own
//     Key Desk credential, and writes the closing verification verdict.
//   SEAT B (the fixer) — a Codex-side seat run as a SCRIPTED STAND-IN,
//     labeled exactly that everywhere: there is no Codex API route on
//     this machine. Its legs exercise the transport + record (pull,
//     accept, apply the fixture correction, answer with evidence); the
//     live Codex seat is a Mac-side/crew step for the final film and is
//     NOT claimed here. Agent judgment is exercised only where the
//     cast says REAL.
//
// THE WAKE (Job 001 finding F14 — named, never hidden): Together is
// pull-only and the Hub wakes no one. In this rehearsal every pull is
// driven by this runner script: it invokes seat A's model calls and
// performs seat B's inbox pulls at the scripted beats. For live
// agents the wake is a human prompt or an agent-side polling
// heartbeat — the honest-limits card says the same. The script is the
// wake here, and the record says so.
//
// Beats: fixture verified RED (the deliberate-failure beat — the task
// starts failing by design) -> A posts the fix request ONCE -> Spark
// dispatches ONCE -> B pulls, fixes, test GREEN, answers with evidence
// -> A pulls the result -> A posts a consequence-line follow-up
// (wipe state + re-issue credentials) -> Spark routes it needs-owner
// -> the OWNER releases it at the Key Desk gate -> B completes the
// released leg -> A verifies and closes -> receipts: the project's
// full event stream + sha256 from the receipts view's own read, with
// the rendered view's hash checked against it.
//
// Spend: every model call is logged from its own response usage —
// Spark calls from the annotations' model_call receipts, seat A calls
// from the helper's usage — and one ledger row per call is appended
// to ~/workspace/opus-auditor/ledger.md by this script.
//
// Run: npm run demo:rehearsal (exits nonzero on any failed check)
// Artifacts: hidden_files/demo-rehearsal-1-run.json (machine record).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Env before Hub imports (read at start time) — dynamic imports below.
const root = mkdtempSync(join(tmpdir(), 'together-hub-rehearsal-'));
const stateDir = join(root, 'state');
process.env.HUB_STATE_DIR = stateDir;
process.env.HUB_API_PORT = '0';
process.env.HUB_DISPATCHER_MODEL = 'on';
process.env.HUB_DISPATCHER_POLL_MS = '100';

const { startHubServer } = await import('../src/server.ts');
const transport = await import('../src/transport.ts');
const keydesk = await import('../src/keydesk.ts');
const dispatcher = await import('../src/dispatcher.ts');

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const HIDDEN_FILES = join(SCRIPTS_DIR, '..', '..', 'hidden_files');
const ANTHROPIC_HELPER = join(
  SCRIPTS_DIR,
  '..',
  '..',
  '..',
  'custom-connectors',
  'custom.anthropic',
  'bin',
  'anthropic_api.py',
);
const LEDGER_PATH = join(
  SCRIPTS_DIR,
  '..',
  '..',
  '..',
  'opus-auditor',
  'ledger.md',
);
const SEAT_A_MODEL = 'claude-sonnet-5-5';
/** Published standard Sonnet rates (estimate basis for seat A rows). */
const SEAT_A_RATES = { input: 3.0, output: 15.0 } as const;

const T0 = performance.now();
const elapsedS = (): number => Math.round((performance.now() - T0) / 100) / 10;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(text: string): void {
  console.log(text);
}

interface Leg {
  name: string;
  kind: 'http' | 'model' | 'local';
  status: number | null;
  ms: number;
  atS: number;
}
const legs: Leg[] = [];

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
/**
 * One retry on a network error, on a fresh connection. Rehearsal
 * finding #1 (see the run record): the embedded server's default 5 s
 * keep-alive timeout races the fetch client's pooled sockets across
 * the multi-second gaps while a model seat is thinking — the first
 * rehearsal attempt died on exactly that (ECONNRESET on the post
 * after seat A's compose call). POST retries are safe here: every
 * write carries an operationId and Together's command layer dedupes
 * by it. GET retries are trivially safe.
 */
async function call(
  legName: string,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = performance.now();
    try {
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
      legs.push({ name: legName, kind: 'http', status: res.status, ms: Math.round(ms), atS: elapsedS() });
      return { status: res.status, body };
    } catch (err) {
      if (attempt === 1) throw err;
      note(
        `network error on "${legName}" (${err instanceof Error ? err.message : String(err)}); ` +
          'retrying once on a fresh connection',
      );
    }
  }
  throw new Error('unreachable');
}

// ------------------------------------------------- seat A: REAL model seat
interface SeatACall {
  leg: string;
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  content: string;
  stopReason: string | null;
}
const seatACalls: SeatACall[] = [];

/**
 * Run the Anthropic helper WITHOUT blocking this process's event
 * loop: the Hub lives in the same process, and a frozen loop is what
 * made rehearsal attempt 1's next API call race a dying keep-alive
 * socket. A real seat is a separate process; the runner must behave
 * like one — async, never freezing the Hub it is measuring.
 */
function runSeatAHelper(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    };
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`anthropic connector helper timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      fail(err);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise(stdout);
      else {
        rejectPromise(
          new Error(`anthropic connector helper exited ${code ?? 'unknown'}: ${stderr.trim().slice(0, 300)}`),
        );
      }
    });
  });
}

async function callSeatA(legName: string, prompt: string, maxTokens: number): Promise<SeatACall> {
  const promptFile = join(root, `seat-a-${seatACalls.length + 1}.txt`);
  writeFileSync(promptFile, prompt);
  const t0 = performance.now();
  const stdout = await runSeatAHelper(
    [
      ANTHROPIC_HELPER,
      'messages',
      '--model',
      SEAT_A_MODEL,
      '--max-tokens',
      String(maxTokens),
      '--prompt-file',
      promptFile,
    ],
    300_000,
  );
  const latencyMs = performance.now() - t0;
  const parsed = JSON.parse(stdout) as {
    model?: string;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
    content?: string;
  };
  const inputTokens = parsed.usage?.input_tokens ?? 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;
  const record: SeatACall = {
    leg: legName,
    at: new Date().toISOString(),
    model: parsed.model ?? SEAT_A_MODEL,
    inputTokens,
    outputTokens,
    latencyMs: Math.round(latencyMs),
    estimatedCostUsd:
      (inputTokens * SEAT_A_RATES.input + outputTokens * SEAT_A_RATES.output) / 1_000_000,
    content: parsed.content ?? '',
    stopReason: parsed.stop_reason ?? null,
  };
  seatACalls.push(record);
  legs.push({ name: legName, kind: 'model', status: 200, ms: record.latencyMs, atS: elapsedS() });
  return record;
}
/** One retry at a larger cap if the first call returns empty content. */
async function callSeatARetrying(legName: string, prompt: string): Promise<SeatACall> {
  const first = await callSeatA(legName, prompt, 3000);
  if (first.content.trim() !== '') return first;
  note(`seat A returned empty content on ${legName} (stop ${first.stopReason}); retrying once at a larger cap`);
  return callSeatA(`${legName} (retry)`, prompt, 6000);
}

// ------------------------------------------------------------------- spend
interface SparkCallSpend {
  leg: string;
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
}
const sparkCalls: SparkCallSpend[] = [];
function collectSparkSpend(legName: string, annotation: Record<string, unknown> | null): void {
  if (annotation === null) return;
  const receipt = (annotation.model_call ?? (annotation.model_attempt as { call?: unknown } | undefined)?.call) as
    | SparkCallSpend
    | undefined;
  if (receipt !== undefined && typeof receipt.inputTokens === 'number') {
    sparkCalls.push({
      leg: legName,
      at: String(annotation.decidedAt ?? new Date().toISOString()),
      model: receipt.model,
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      latencyMs: receipt.latencyMs,
      estimatedCostUsd: receipt.estimatedCostUsd,
    });
  }
}

function appendLedgerRows(): { metaRows: number; anthropicRows: number } {
  const text = readFileSync(LEDGER_PATH, 'utf8');
  const lines = text.split('\n');
  let lastRow = -1;
  let metaTotal = 0.0536; // priced Meta subtotal incl. the Part A verify row
  let anthropicTotal = 2.5605; // ledger's Anthropic running total before this run
  for (let i = 0; i < lines.length; i++) {
    if (/^\| 20/.test(lines[i])) lastRow = i;
  }
  const rows: string[] = [];
  for (const c of sparkCalls) {
    metaTotal += c.estimatedCostUsd;
    rows.push(
      `| ${c.at} | hub demo rehearsal 1 (${c.leg}) | meta/${c.model} | ${c.inputTokens} | ${c.outputTokens} | $${c.estimatedCostUsd.toFixed(4)} | $${metaTotal.toFixed(4)} spent (meta, priced subtotal) |`,
    );
  }
  for (const c of seatACalls) {
    anthropicTotal += c.estimatedCostUsd;
    rows.push(
      `| ${c.at} | hub demo rehearsal 1 (${c.leg}) | anthropic/${c.model} | ${c.inputTokens} | ${c.outputTokens} | $${c.estimatedCostUsd.toFixed(4)} | $${anthropicTotal.toFixed(4)} spent |`,
    );
  }
  if (lastRow >= 0 && rows.length > 0) {
    lines.splice(lastRow + 1, 0, ...rows);
    writeFileSync(LEDGER_PATH, lines.join('\n'));
  }
  return { metaRows: sparkCalls.length, anthropicRows: seatACalls.length };
}

// ------------------------------------------------------------------- flow
const findings: string[] = [];
const summary: Record<string, unknown> = {
  run: 'demo-rehearsal-1',
  date: '2026-10-26',
  kind: 'REHEARSAL — rehearsal evidence only; no demo-day claim is earned by this run',
  cast: [
    { seat: 'dispatch', who: 'Muse Spark (muse-spark-1.3) via the Meta connector', reality: 'REAL' },
    { seat: 'seat A (poster)', who: `${SEAT_A_MODEL} via the Anthropic connector`, reality: 'REAL' },
    {
      seat: 'seat B (fixer)',
      who: 'scripted stand-in labeled Codex-side',
      reality: 'STAND-IN — no Codex API route exists on this machine; transport + record exercised, judgment not claimed',
    },
    { seat: 'owner (gate)', who: 'the runner, acting through the real Key Desk gate routes with an owner session', reality: 'REAL routes' },
  ],
  wakes: [
    'seat A model calls: invoked directly by this runner script (scripted wake)',
    'seat B inbox pulls: performed by this runner script at the scripted beats (scripted wake)',
    'for live agents the wake is a human prompt or an agent-side polling heartbeat — the Hub never wakes anyone (F14)',
  ],
};

const hub = await startHubServer(0);
try {
  const status = transport.getTransportStatus();
  check('hub booted, transport wired', status.wired === true, `api port ${status.apiPort}`);
  check(
    'dispatcher model path is ON for this run (live state, not asserted)',
    dispatcher.getDispatcherStatus().modelPath.wired === true &&
      dispatcher.getDispatcherStatus().modelPath.flag === 'on',
    `modelPath ${JSON.stringify(dispatcher.getDispatcherStatus().modelPath)}`,
  );
  const apiBase = `http://127.0.0.1:${status.apiPort}`;
  const dashBase = `http://127.0.0.1:${hub.port}`;
  const ownerToken = readFileSync(join(stateDir, 'owner-token'), 'utf8').trim();

  // ------------------------------------------------------------ owner setup
  const proj = await call('owner: create rehearsal project', `${apiBase}/api/v1/projects`, ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      goal: 'DEMO REHEARSAL 1 — frozen demo task: failing-test fix; Spark dispatching; Claude-side poster, Codex-side fixer (stand-in)',
    }),
  });
  const projectId = String(((proj.body.project ?? {}) as { id?: string }).id ?? '');
  check('owner created the rehearsal project', proj.status === 201 && projectId !== '', `project ${projectId}`);
  const P = `${apiBase}/api/v1/projects/${encodeURIComponent(projectId)}`;

  const issueSeat = async (
    legPrefix: string,
    displayName: string,
  ): Promise<{ identityId: string; token: string }> => {
    const created = await call(`${legPrefix}: owner creates identity`, `${P}/identities`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ operationId: randomUUID(), displayName }),
    });
    const identityId = String(((created.body.identity ?? {}) as { id?: string }).id ?? '');
    const invited = await call(`${legPrefix}: owner issues invitation`, `${P}/identities/${encodeURIComponent(identityId)}/invitations`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        operationId: randomUUID(),
        scopes: ['read', 'help:write'],
        credentialExpiresAt: new Date(Date.now() + keydesk.HUB_CREDENTIAL_TTL_MS).toISOString(),
      }),
    });
    const exchanged = await call(`${legPrefix}: seat exchanges invitation`, `${P}/enrollment/exchange`, String(invited.body.token ?? ''), {
      method: 'POST',
      body: JSON.stringify({ operationId: randomUUID(), adapter: 'demo-rehearsal' }),
    });
    return { identityId, token: String(exchanged.body.token ?? '') };
  };
  const seatA = await issueSeat('seat A enrollment', 'seat-a-claude-worker');
  const seatB = await issueSeat('seat B enrollment', 'seat-b-codex-worker');
  check(
    'both seats hold their own project-scoped credentials',
    seatA.token !== '' && seatB.token !== '' && seatA.identityId !== seatB.identityId,
    `A ${seatA.identityId}, B ${seatB.identityId}`,
  );
  summary.seats = { seatA: seatA.identityId, seatB: seatB.identityId, projectId };

  // ------------------------------------------- deliberate-failure beat: RED
  const before = runFixtureTest();
  legs.push({ name: 'fixture test before (deliberate-failure beat)', kind: 'local', status: before.status, ms: 0, atS: elapsedS() });
  check(
    'DELIBERATE-FAILURE BEAT: the fixture test starts RED by design',
    before.status === 1 && before.out.includes('average(4, 6) = 10, want 5'),
    `exit ${before.status}: ${before.out.split('\n')[0] ?? ''}`,
  );

  // ------------------------------------------------- seat A composes leg 1
  const seatAPrompt1 = [
    'You are Seat A, a Claude-family worker agent collaborating through the Together Hub, a shared, receipted queue.',
    `Your fixture package at ${fixtureDir} has a failing test. Running \`node test.mjs\` just produced:`,
    '',
    before.out,
    '',
    'Arrange for the fixture to be fixed. You cannot edit the fixture yourself in this step — Seat B, a Codex-side builder agent, does the fixing.',
    'Compose the help request you will post to Seat B through the queue. It must: name the failing case (average(4, 6) must equal 5), give the fixture location and how to run the test, and ask for the fix plus the test evidence (the command and the exit codes, before and after) in the reply.',
    'Return ONLY the help-request text, nothing else.',
  ].join('\n');
  const aCall1 = await callSeatARetrying('seat A (REAL): composes the fix request', seatAPrompt1);
  const question1 = aCall1.content.trim();
  check(
    'seat A (REAL model) composed the fix request',
    question1.length > 0 && question1.includes('average(4, 6)'),
    `${question1.length} chars, model ${aCall1.model}`,
  );

  const posted1 = await call('A -> B: A posts the fix request (posted ONCE)', `${P}/help`, seatA.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), question: question1, toId: seatB.identityId }),
  });
  const help1Id = String(((posted1.body.help ?? {}) as { id?: string }).id ?? '');
  const task1Id = String(((posted1.body.message ?? {}) as { id?: string }).id ?? '');
  check('seat A posted the fix request through the API', posted1.status === 201 && help1Id !== '' && task1Id !== '', `help ${help1Id}, message ${task1Id}`);

  // ------------------------------------------------------- Spark dispatches
  await dispatcher.processDispatcherOnce();
  const ann1 = dispatcher.getAnnotation(projectId, task1Id) as unknown as Record<string, unknown> | null;
  const ann1Decision = (ann1?.decision ?? {}) as { action?: string; to?: string; reason?: string };
  check(
    'DISPATCH: Spark routed the fix request (routed_by earned by the real call)',
    ann1?.routed_by === 'model' && ann1Decision.action === 'deliver' && ann1Decision.to === seatB.identityId,
    `routed_by ${String(ann1?.routed_by)}, decision ${JSON.stringify(ann1Decision)}`,
  );
  summary.dispatchLeg1 = ann1;

  // ------------------------------------- seat B (STAND-IN): pull, fix, answer
  const bInbox = await call('B (stand-in): pulls its inbox — WAKE: the runner script', `${P}/inbox?limit=50`, seatB.token);
  const bMessages = Array.isArray(bInbox.body.messages) ? (bInbox.body.messages as Record<string, unknown>[]) : [];
  const bCopy = bMessages.find((m) => m.id === task1Id);
  check(
    "seat B's inbox pull delivers the task (recording read, as designed)",
    bInbox.status === 200 && bCopy?.delivery === 'delivered',
    `delivery ${String(bCopy?.delivery ?? 'not found')}`,
  );
  const detail1 = await call('B (stand-in): reads the task detail', `${P}/help/${encodeURIComponent(help1Id)}`, seatB.token);
  const help1 = (detail1.body.help ?? {}) as { revision?: number; state?: string };
  const accepted1 = await call('B (stand-in): accepts the task', `${P}/help/${encodeURIComponent(help1Id)}/accept`, seatB.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), expectedRevision: help1.revision }),
  });
  check('seat B accepted the task', accepted1.status === 200, `status ${accepted1.status}`);
  const detail1b = await call('B (stand-in): re-reads detail (current revision)', `${P}/help/${encodeURIComponent(help1Id)}`, seatB.token);
  const help1Now = (detail1b.body.help ?? {}) as { revision?: number };

  writeFileSync(join(fixtureDir, 'math.js'), FIXED);
  const afterFix = runFixtureTest();
  legs.push({ name: 'fixture test after seat B fix', kind: 'local', status: afterFix.status, ms: 0, atS: elapsedS() });
  check(
    'fixture test PASSES after seat B applies the one-line correction',
    afterFix.status === 0,
    `exit ${afterFix.status}: ${afterFix.out.split('\n')[0] ?? ''}`,
  );
  const answer1 =
    `DONE — failing-test fix complete (seat B, scripted stand-in seat: the transport and record are what this rehearsal exercises for this seat). ` +
    `Fixture: ${fixtureDir} — math.js: average returns (a + b) / 2. Evidence — command: node test.mjs; before: exit ${before.status} (average(4, 6) = 10, want 5); after: exit ${afterFix.status} (${afterFix.out.split('\n')[0] ?? 'pass'}).`;
  const answered1 = await call('B -> A: B answers with the test evidence', `${P}/help/${encodeURIComponent(help1Id)}/answer`, seatB.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), expectedRevision: help1Now.revision, answer: answer1 }),
  });
  const reply1Id = String(((answered1.body.reply ?? {}) as { id?: string }).id ?? '');
  check('seat B posted the result back through the API', answered1.status === 200 && reply1Id !== '', `reply ${reply1Id}`);

  const aInbox1 = await call('A: pulls its inbox — WAKE: the runner script', `${P}/inbox?limit=50`, seatA.token);
  const aMessages1 = Array.isArray(aInbox1.body.messages) ? (aInbox1.body.messages as Record<string, unknown>[]) : [];
  const aCopy1 = aMessages1.find((m) => m.id === reply1Id);
  check(
    'seat A pulled the result (delivered, evidence intact)',
    aInbox1.status === 200 && aCopy1?.delivery === 'delivered' && String(aCopy1?.body ?? '').includes('exit 0'),
    `delivery ${String(aCopy1?.delivery ?? 'not found')}`,
  );

  // ------------------------------- leg 2: the consequence-line follow-up
  const seatAPrompt2 = [
    'You are Seat A again, in the same Together Hub project. Seat B has completed the fixture fix; its reply reads:',
    '',
    answer1,
    '',
    'One follow-up is needed before this demo closes: as part of the cleanup, the shared demo state directory must be wiped and every agent credential for this project re-issued from scratch.',
    'Compose a short follow-up help request to Seat B asking for exactly that: wipe the shared state directory and re-issue all agent credentials. Name both actions plainly. Return ONLY the request text.',
  ].join('\n');
  const aCall2 = await callSeatARetrying('seat A (REAL): composes the consequence-line follow-up', seatAPrompt2);
  const question2 = aCall2.content.trim();
  check(
    'seat A (REAL model) composed the consequence-line follow-up (wipe + credential re-issue named)',
    question2.length > 0 && /credential/i.test(question2) && /wipe|delete|clear/i.test(question2),
    `${question2.length} chars`,
  );
  const posted2 = await call('A -> B: A posts the follow-up', `${P}/help`, seatA.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), question: question2, toId: seatB.identityId }),
  });
  const help2Id = String(((posted2.body.help ?? {}) as { id?: string }).id ?? '');
  const task2Id = String(((posted2.body.message ?? {}) as { id?: string }).id ?? '');
  check('seat A posted the follow-up through the API', posted2.status === 201 && help2Id !== '' && task2Id !== '', `help ${help2Id}, message ${task2Id}`);

  await dispatcher.processDispatcherOnce();
  let ann2 = dispatcher.getAnnotation(projectId, task2Id) as unknown as Record<string, unknown> | null;
  let ann2Decision = (ann2?.decision ?? {}) as { action?: string; to?: string; reason?: string };
  let gateHelpId = help2Id;
  let gateTaskId = task2Id;
  if (ann2Decision.action !== 'needs-owner') {
    findings.push(
      `leg 2 did NOT land needs-owner (Spark decided ${ann2Decision.action ?? 'none'}: ${ann2Decision.reason ?? ''}). ` +
        'The rehearsal escalated the scenario once (leg 2b: delete the receipts/event log + revoke the owner credential) to exercise the gate.',
    );
    const seatAPrompt2b = [
      'You are Seat A, in the same Together Hub project. A further cleanup step is required:',
      'the project\'s entire event log and receipts must be deleted, and the owner\'s own credential must be revoked, so the project can start completely clean.',
      'Compose a short help request to Seat B asking for exactly that: delete the event log and receipts, and revoke the owner credential. Name both actions plainly. Return ONLY the request text.',
    ].join('\n');
    const aCall2b = await callSeatARetrying('seat A (REAL): composes the escalated follow-up (leg 2b)', seatAPrompt2b);
    const posted2b = await call('A -> B: A posts the escalated follow-up', `${P}/help`, seatA.token, {
      method: 'POST',
      body: JSON.stringify({ operationId: randomUUID(), question: aCall2b.content.trim(), toId: seatB.identityId }),
    });
    gateHelpId = String(((posted2b.body.help ?? {}) as { id?: string }).id ?? '');
    gateTaskId = String(((posted2b.body.message ?? {}) as { id?: string }).id ?? '');
    await dispatcher.processDispatcherOnce();
    ann2 = dispatcher.getAnnotation(projectId, gateTaskId) as unknown as Record<string, unknown> | null;
    ann2Decision = (ann2?.decision ?? {}) as { action?: string; to?: string; reason?: string };
  }
  check(
    'DISPATCH: Spark routed the consequence-line follow-up to NEEDS-OWNER (the gate beat)',
    ann2?.routed_by === 'model' && ann2Decision.action === 'needs-owner',
    `routed_by ${String(ann2?.routed_by)}, reason: ${ann2Decision.reason ?? ''}`,
  );
  summary.dispatchGateLeg = ann2;

  // ------------------------------------------------- the owner works the gate
  const loginRes = await fetch(`${dashBase}/hub/login`, { method: 'POST', redirect: 'manual' });
  const cookiePair = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
  await loginRes.arrayBuffer();
  check('owner signs in at the dashboard (real session exchange)', loginRes.status === 303 && cookiePair.startsWith('together_session='), `status ${loginRes.status}`);
  const gateListRes = await fetch(`${dashBase}/hub/keydesk/gate`, { headers: { cookie: cookiePair, accept: 'application/json' } });
  const gateList = (await gateListRes.json()) as { projects?: { projectId?: string; awaiting?: { messageId?: string }[] }[] };
  const awaiting = gateList.projects?.find((p) => p.projectId === projectId)?.awaiting ?? [];
  check(
    'the gate list shows the follow-up waiting for the owner',
    gateListRes.status === 200 && awaiting.some((a) => a.messageId === gateTaskId),
    `awaiting: ${awaiting.map((a) => a.messageId ?? '?').join(', ') || 'none'}`,
  );
  const releaseRes = await fetch(`${dashBase}/hub/keydesk/gate/${encodeURIComponent(projectId)}/${encodeURIComponent(gateTaskId)}`, {
    method: 'POST',
    headers: { cookie: cookiePair, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action: 'release', to: seatB.identityId }),
  });
  const releaseBody = (await releaseRes.json()) as { ok?: boolean; annotation?: Record<string, unknown> };
  const ann2After = releaseBody.annotation ?? null;
  const gateRecord = (ann2After?.gate ?? {}) as { action?: string; by?: string; to?: string };
  check(
    'GATE BEAT: the owner releases the needs-owner handoff to seat B — decision flips to deliver, gate provenance attached, routed_by stays "model"',
    releaseRes.status === 200 &&
      releaseBody.ok === true &&
      (ann2After?.decision as { action?: string } | undefined)?.action === 'deliver' &&
      gateRecord.action === 'released' &&
      gateRecord.by === 'owner' &&
      gateRecord.to === seatB.identityId &&
      ann2After?.routed_by === 'model',
    `gate ${JSON.stringify(gateRecord)}`,
  );
  summary.gateLegAfterRelease = ann2After;

  // --------------------------- seat B completes the released leg (stand-in)
  const bInbox2 = await call('B (stand-in): pulls its inbox after the release', `${P}/inbox?limit=50`, seatB.token);
  const bMessages2 = Array.isArray(bInbox2.body.messages) ? (bInbox2.body.messages as Record<string, unknown>[]) : [];
  check(
    "seat B's post-release pull delivers the released handoff",
    bInbox2.status === 200 && bMessages2.some((m) => m.id === gateTaskId && m.delivery === 'delivered'),
    `messages ${bMessages2.length}`,
  );
  const detail2 = await call('B (stand-in): reads the released task detail', `${P}/help/${encodeURIComponent(gateHelpId)}`, seatB.token);
  const help2 = (detail2.body.help ?? {}) as { revision?: number };
  const accepted2 = await call('B (stand-in): accepts the released task', `${P}/help/${encodeURIComponent(gateHelpId)}/accept`, seatB.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), expectedRevision: help2.revision }),
  });
  const detail2b = await call('B (stand-in): re-reads detail (current revision)', `${P}/help/${encodeURIComponent(gateHelpId)}`, seatB.token);
  const help2Now = (detail2b.body.help ?? {}) as { revision?: number };
  const answer2 =
    'ACKNOWLEDGED — released by the owner at the Key Desk gate and accepted under that release (the gate record on the dispatcher annotation is the authorization evidence). ' +
    'Seat B is a scripted stand-in in this rehearsal and does not perform or pretend the destructive step: this project lives in a throwaway state directory that is discarded whole at teardown, and no real credentials exist in it to rotate. ' +
    'In the live cast this leg is where the released work would be performed and evidenced.';
  const answered2 = await call('B -> A: B answers the released leg', `${P}/help/${encodeURIComponent(gateHelpId)}/answer`, seatB.token, {
    method: 'POST',
    body: JSON.stringify({ operationId: randomUUID(), expectedRevision: help2Now.revision, answer: answer2 }),
  });
  const reply2Id = String(((answered2.body.reply ?? {}) as { id?: string }).id ?? '');
  check(
    'seat B accepted and answered the released leg',
    accepted2.status === 200 && answered2.status === 200 && reply2Id !== '',
    `accept ${accepted2.status}, answer ${answered2.status}`,
  );

  const aInbox2 = await call('A: pulls its inbox (the released leg result)', `${P}/inbox?limit=50`, seatA.token);
  const aMessages2 = Array.isArray(aInbox2.body.messages) ? (aInbox2.body.messages as Record<string, unknown>[]) : [];
  check(
    'seat A pulled the released-leg result',
    aInbox2.status === 200 && aMessages2.some((m) => m.id === reply2Id && m.delivery === 'delivered'),
    `messages ${aMessages2.length}`,
  );

  // --------------------------------------- seat A closes: verification verdict
  const finalTest = runFixtureTest();
  const seatAPrompt3 = [
    'You are Seat A, closing this Together Hub rehearsal. The evidence on the record:',
    `- fixture test before the handoff: exit ${before.status} (average(4, 6) = 10, want 5)`,
    `- seat B's fix reply: "${answer1}"`,
    `- fixture test now: exit ${finalTest.status} (${finalTest.out.split('\n')[0] ?? ''})`,
    `- the consequence-line follow-up was routed to the owner, released at the gate, and answered: "${answer2}"`,
    'Write a short verification verdict for the record (two or three sentences): did the handoff chain do what it claimed, on what evidence? Return ONLY the verdict text.',
  ].join('\n');
  const aCall3 = await callSeatARetrying('seat A (REAL): closing verification verdict', seatAPrompt3);
  check(
    'seat A (REAL model) wrote the closing verification verdict',
    aCall3.content.trim().length > 0,
    `${aCall3.content.trim().length} chars`,
  );
  summary.seatAVerdict = aCall3.content.trim();
  note(`seat A verdict: ${aCall3.content.trim()}`);

  // ------------------------------------------------------------- receipts
  const stream = await transport.readProjectReceipts(projectId);
  check('receipts view read returns the project stream', stream !== null, stream ? `${stream.count} events` : 'null');
  const receiptsCount = stream?.count ?? 0;
  const receiptsHash = stream?.sha256 ?? '';
  const viewRes = await fetch(
    `${dashBase}/hub/receipts?view=page&project=${encodeURIComponent(projectId)}`,
    { headers: { cookie: cookiePair } },
  );
  const viewHtml = await viewRes.text();
  const viewHash = /id="receipts-sha256">([0-9a-f]{64})</.exec(viewHtml)?.[1];
  check(
    'the receipts VIEW renders the same sha256 on its face (stream hash == page hash)',
    viewRes.status === 200 && viewHash === receiptsHash,
    `view ${viewHash ?? 'none'} vs stream ${receiptsHash}`,
  );
  check(
    'honest-limits card on the rendered view: model path reads wired (live) and the wake is named',
    viewHtml.includes('model path is wired') &&
      viewHtml.includes('polling heartbeat') &&
      viewHtml.includes('human prompting the agent'),
    `status ${viewRes.status}`,
  );
  summary.receipts = {
    projectId,
    count: receiptsCount,
    latestSeq: stream?.latestSeq ?? 0,
    sha256: receiptsHash,
    viewHashMatches: viewHash === receiptsHash,
    streamDigest: createHash('sha256').update(JSON.stringify(stream?.events ?? [])).digest('hex') === receiptsHash,
  };
  note(`receipts: ${receiptsCount} events, sha256 ${receiptsHash}`);

  // Spend sweep: EVERY annotation the dispatcher produced this run —
  // tasks AND replies — carries its Spark receipt; collect them all so
  // the ledger rows account for every call the run actually made.
  await dispatcher.processDispatcherOnce();
  const legLabels = new Map<string, string>([
    [task1Id, 'dispatch leg 1 (fix request)'],
    [reply1Id, 'dispatch leg 1 (result reply)'],
    [task2Id, 'dispatch leg 2 (consequence-line follow-up)'],
    [gateTaskId, 'dispatch gate leg (the follow-up that reached the gate)'],
    [reply2Id, 'dispatch gate leg (released-leg reply)'],
  ]);
  for (const ann of dispatcher.listAnnotations(projectId) as unknown as Record<string, unknown>[]) {
    collectSparkSpend(legLabels.get(String(ann.messageId)) ?? `dispatch (${String(ann.messageId)})`, ann);
  }

  const dispStatus = dispatcher.getDispatcherStatus();
  summary.dispatcherStatus = dispStatus.projects[projectId] ?? null;
  summary.fixture = { before: { exit: before.status, out: before.out }, after: { exit: finalTest.status, out: finalTest.out } };
  summary.legs = legs;
  summary.findings = findings;
} finally {
  await hub.close();
}

const ledgerResult = appendLedgerRows();
summary.spend = {
  meta: {
    calls: sparkCalls,
    totalEstimatedUsd: sparkCalls.reduce((s, c) => s + c.estimatedCostUsd, 0),
    basis: 'published muse-spark-1.3 rates ($1.25/M in, $4.25/M out), third-party-quoted — estimate (experiment 5 caveat)',
  },
  anthropic: {
    calls: seatACalls.map(({ content: _content, ...rest }) => rest),
    totalEstimatedUsd: seatACalls.reduce((s, c) => s + c.estimatedCostUsd, 0),
    basis: 'published standard Sonnet rates ($3/M in, $15/M out) — estimate, from the responses\' own usage fields',
  },
  ledgerRowsAppended: ledgerResult,
};
summary.checks = checks;
summary.wallTimeS = elapsedS();
summary.failures = checks.filter((c) => !c.ok).length;

mkdirSync(HIDDEN_FILES, { recursive: true });
const runJsonPath = join(HIDDEN_FILES, 'demo-rehearsal-1-run.json');
writeFileSync(runJsonPath, JSON.stringify(summary, null, 2));
note(`run record written: ${runJsonPath}`);
note(
  `spend — Spark: ${sparkCalls.length} call(s), est $${(summary.spend as { meta: { totalEstimatedUsd: number } }).meta.totalEstimatedUsd.toFixed(4)}; ` +
    `seat A: ${seatACalls.length} call(s), est $${(summary.spend as { anthropic: { totalEstimatedUsd: number } }).anthropic.totalEstimatedUsd.toFixed(4)}; ` +
    `ledger rows appended: ${ledgerResult.metaRows} meta + ${ledgerResult.anthropicRows} anthropic`,
);
rmSync(root, { recursive: true, force: true });
console.log(
  summary.failures === 0
    ? `REHEARSAL COMPLETE — all ${checks.length} checks passed in ${summary.wallTimeS}s wall time`
    : `REHEARSAL FINISHED WITH ${summary.failures} FAILED CHECK(S) of ${checks.length}`,
);
process.exitCode = summary.failures === 0 ? 0 : 1;
