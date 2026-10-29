// Wired-seam smoke check (build step 2): starts the Hub on OS-assigned
// ports with a throwaway state dir, and proves the new reality —
//   boot -> /hub/status reports wired:true (only possible after the boot
//   self-check's real round trip through the in-process seam);
//   queue and receipts reads are API-backed and honestly empty on a
//   fresh state dir;
//   a bad credential is refused (401) through the seam, and the
//   agent-facing HTTP listener answers the real owner token and refuses
//   a bad one;
//   the demoted /api/v1/* namespace is gone from the dashboard port;
//   clean shutdown.
// Step 3 adds: the Key Desk — session-gated pages, invitation issue ->
// exchange -> per-agent credential, project-scope refusal with the code
// surfaced, revoke -> next call refused; queue + receipt DETAIL reads;
// and the queue's non-recording proof (dashboard refreshes leave
// delivery 'queued'; only the addressed reader's own API inbox GET
// records delivery).
// Step 4.5 adds: the queue INDEX is event-log anchored — an
// agent-to-agent handoff enrolled and posted inside this smoke must be
// listed in the index itself (correct parties + delivery state, detail
// in agreement), non-recording across refreshes, flipping only when
// the addressed peer makes its own API inbox GET.
// Step 6 adds: the DISPATCHER — addressed handoffs gain annotations
// (routed_by "rules", deliver to the named addressee, template summary
// with its provenance on the same record); the model path answers a
// typed NOT-WIRED; /hub/status carries dispatcher state; and a restart
// phase seeds unaddressed handoff records into the project state file
// (an imported-log shape Together's own API cannot produce, since it
// requires a recipient) to prove the scope-match and needs-owner
// branches, the "pending" state for an unanchored record, and
// exactly-once persistence across an in-process stop/start.
// Step 7 adds: the APPROVAL GATE — on the second boot, the owner works
// the two seeded needs-owner handoffs from the Key Desk: the gate list
// (401 without a session) shows them with summary/reason/sender; a
// release into the revoked first agent's credential is BLOCKED with
// the reason and changes nothing; a release to an unenrolled identity
// is 422; a clean release lands deliver + gate provenance with
// routed_by still "rules"; a refusal lands the gate record while
// Together's message record stays byte-untouched (gate state exists
// only in the Hub's dispatcher.json); double actions and gate actions
// on a delivered handoff conflict 409; /hub/status reports gate
// counts; a third boot proves the decisions persist.
// Step 8 adds: the RECEIPTS VIEW + HONEST-LIMITS CARD — the page is
// 401 without an owner session; with one it renders the smoke's own
// events as a timeline whose displayed sha256 equals a hash computed
// independently inside this smoke (Together's own events route paged
// through the seam, canonical construction as in probe-handoff); the
// limits card is present, its model-path line matches /hub/status at
// runtime, the Key Desk links the view, Accept: text/html serves it,
// the raw JSON surface is unchanged, and an unknown project is 404.
// Job 001 F1 adds: the credential-expiry pin — Together's 30-day
// credential TTL is OPT-IN (an invitation without credentialExpiresAt
// mints a credential that never expires), so the desk's issuance
// request body is shape-asserted to ALWAYS carry the field (Hub
// default: 30 days), the desk's issuance response is asserted to
// carry it, and the exchanged credential's stored state is asserted
// to expire at that timestamp, at or under 30 days.
// The desk-default-scopes pin (Law 2b UI pass finding, 2026-10-26)
// adds: scopes are opt-in the same way — an invitation without them
// carries Together's DEFAULT_INVITE_SCOPES (read, tasks:write,
// tasks:claim, assignments:write), which lack help:write, so the
// form's blank path minted an agent that could not post handoffs.
// The desk issuance body is shape-asserted to ALWAYS carry a scope
// set (explicit list untouched, or HUB_DESK_DEFAULT_SCOPES), and a
// late boot-1 block proves it end-to-end in its own project: a
// blank-scopes invitation exchanges into a credential whose stored
// scopes are exactly the desk default and which POSTs /help with
// 201, while an explicit list is stored exactly as supplied.
// The model-path wiring (2026-10-26) adds a FOURTH boot: the flag is
// on and a STAND-IN transport is injected through the dispatcher's
// test seam (no live spend in the smoke), over two seeded unaddressed
// records — one the stand-in routes (annotation must carry routed_by
// "model", the stand-in's own summary, and its call receipt), one
// whose stand-in throws (annotation must fall back to the rules
// decision, routed_by "rules", with the failed attempt recorded on
// it). /hub/status and the honest-limits card must flip truthfully
// on that boot. The flag-off phases above pin the unchanged default:
// every annotation rules-labeled, the probe's typed NOT-WIRED.
// Exits 0 on PASS, 1 on FAIL. Run: npm run smoke

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env must be set before the Hub modules are imported (they read it at
// start time), so the imports below are dynamic on purpose.
const stateDir = mkdtempSync(join(tmpdir(), 'together-hub-smoke-'));
process.env.HUB_STATE_DIR = stateDir;
process.env.HUB_API_PORT = '0'; // OS-assigned: never collides with a live Hub
process.env.HUB_DISPATCHER_POLL_MS = '100'; // fast ticks; assertions still drain explicitly

const { startHubServer } = await import('../src/server.ts');
const transport = await import('../src/transport.ts');
const dispatcher = await import('../src/dispatcher.ts');
const keydesk = await import('../src/keydesk.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const hub = await startHubServer(0);
try {
  const base = `http://127.0.0.1:${hub.port}`;

  const statusRes = await fetch(`${base}/hub/status`);
  const status = (await statusRes.json()) as {
    transport?: {
      wired?: boolean;
      mode?: string;
      apiPort?: number | null;
      selfCheck?: { ok?: boolean; detail?: string };
      projectIds?: string[];
    };
    caps?: { queuePageLimit?: number; receiptsPageLimit?: number };
    queue?: { items?: number | null };
    receipts?: { items?: number | null };
  };
  check('GET /hub/status returns 200', statusRes.status === 200, `status ${statusRes.status}`);
  check(
    'status reports transport wired:true after the boot self-check',
    status.transport?.wired === true,
    `self-check: ${status.transport?.selfCheck?.detail ?? 'none'}`,
  );
  check('status transport mode is embedded', status.transport?.mode === 'embedded');
  check(
    'status self-check ok',
    status.transport?.selfCheck?.ok === true,
  );
  const apiPort = status.transport?.apiPort ?? 0;
  check('embedded API listener is up on a resolved port', apiPort > 0, `port ${apiPort}`);
  check(
    'status hosts the seeded demo project',
    (status.transport?.projectIds ?? []).includes('hub-demo'),
    `projects: ${(status.transport?.projectIds ?? []).join(', ')}`,
  );
  check(
    'status prints the declared read caps',
    (status.caps?.queuePageLimit ?? 0) > 0 && (status.caps?.receiptsPageLimit ?? 0) > 0,
    `caps ${JSON.stringify(status.caps)}`,
  );
  check('status queue count is 0 (API-backed, fresh state)', status.queue?.items === 0);
  check('status receipts count is 0 (API-backed, fresh state)', status.receipts?.items === 0);

  const queueRes = await fetch(`${base}/hub/queue`);
  const queue = (await queueRes.json()) as {
    items?: unknown[];
    nextCursor?: unknown;
    projectIds?: string[];
  };
  check('GET /hub/queue returns 200', queueRes.status === 200);
  check(
    'queue items come from the API and are empty on fresh state',
    Array.isArray(queue.items) && queue.items.length === 0,
  );
  check(
    'queue page carries the API paging shape',
    'nextCursor' in queue && Array.isArray(queue.projectIds),
  );

  const receiptsRes = await fetch(`${base}/hub/receipts`);
  const receipts = (await receiptsRes.json()) as {
    items?: unknown[];
    pages?: { projectId?: string }[];
    total?: number;
  };
  check('GET /hub/receipts returns 200', receiptsRes.status === 200);
  check(
    'receipts items come from the API event logs and are empty on fresh state',
    Array.isArray(receipts.items) && receipts.items.length === 0 && receipts.total === 0,
  );
  check(
    'receipts page is per-project and names the seeded project',
    Array.isArray(receipts.pages) && receipts.pages[0]?.projectId === 'hub-demo',
  );

  const home = await fetch(`${base}/`);
  const html = await home.text();
  check('GET / returns 200', home.status === 200, `status ${home.status}`);
  check('dashboard shows the WIRED transport state', html.includes('Transport: WIRED'));
  check('dashboard has a Queue section', html.includes('<h2>Queue</h2>'));
  check('dashboard has a Receipts section', html.includes('<h2>Receipts</h2>'));
  check(
    'dashboard states the pull-only limit',
    html.includes('pull-only') && html.includes('never wakes an agent'),
  );

  const demoted = await fetch(`${base}/api/v1/status`);
  check(
    'old /api/v1/status on the dashboard port is 404 (namespace demoted)',
    demoted.status === 404,
    `status ${demoted.status}`,
  );
  await demoted.arrayBuffer();

  // The seam itself: a bad credential through apiFetch is refused.
  const bad = await transport.apiFetch('/api/v1/projects', {
    headers: { authorization: 'Bearer smoke-wrong-token' },
  });
  check('bad credential through the seam (apiFetch) is refused 401', bad.status === 401, `status ${bad.status}`);
  await bad.arrayBuffer();

  // The agent-facing HTTP listener: real owner token answers, bad one 401s.
  const ownerToken = readFileSync(join(stateDir, 'owner-token'), 'utf8').trim();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const apiOk = await fetch(`${apiBase}/api/v1/projects`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const apiBody = (await apiOk.json()) as { projects?: { id?: string }[] };
  check(
    'agent-facing HTTP listener answers the owner token',
    apiOk.status === 200 && (apiBody.projects ?? []).some((p) => p.id === 'hub-demo'),
    `status ${apiOk.status}`,
  );
  const apiBad = await fetch(`${apiBase}/api/v1/projects`, {
    headers: { authorization: 'Bearer smoke-wrong-token' },
  });
  check('agent-facing HTTP listener refuses a bad token 401', apiBad.status === 401, `status ${apiBad.status}`);
  await apiBad.arrayBuffer();

  // ---- Build step 3: Key Desk identity + detail reads + non-recording queue

  const deskAnon = await fetch(`${base}/hub/keydesk`);
  check('Key Desk page without an owner session is refused 401', deskAnon.status === 401, `status ${deskAnon.status}`);
  await deskAnon.arrayBuffer();
  const deskAnonJson = await fetch(`${base}/hub/keydesk.json`, {
    headers: { accept: 'application/json' },
  });
  check('Key Desk JSON without an owner session is refused 401', deskAnonJson.status === 401, `status ${deskAnonJson.status}`);
  await deskAnonJson.arrayBuffer();

  const login = await fetch(`${base}/hub/login`, { method: 'POST', redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookiePair = setCookie.split(';')[0];
  check(
    'POST /hub/login exchanges server-side and sets an HttpOnly session cookie',
    login.status === 303 && cookiePair.startsWith('together_session=') && setCookie.includes('HttpOnly'),
    `status ${login.status}`,
  );
  await login.arrayBuffer();
  const cookie = { cookie: cookiePair };

  const deskPage = await fetch(`${base}/hub/keydesk`, { headers: cookie });
  const deskHtml = await deskPage.text();
  check(
    'Key Desk page opens with the owner session',
    deskPage.status === 200 && deskHtml.includes('Key Desk') && deskHtml.includes('Issue an invitation'),
    `status ${deskPage.status}`,
  );

  // ---- Job 001 F1: the desk's issuance request ALWAYS sets the expiry
  // Shape checks on the request body the desk constructs (the pure
  // builder issueInvitation sends through) — not just on the outcome:
  // Together treats credentialExpiresAt as opt-in, so an omitted field
  // would mint a credential that never expires.
  const shapeDefault = keydesk.buildInvitationRequestBody({ scopes: ['read'] });
  const shapeDefaultDelta =
    Date.parse(String(shapeDefault.credentialExpiresAt)) - Date.now();
  check(
    'F1 shape: desk issuance body ALWAYS carries credentialExpiresAt when the caller omits it (Hub default = 30 days, at Together\'s cap)',
    typeof shapeDefault.credentialExpiresAt === 'string' &&
      shapeDefaultDelta > keydesk.HUB_CREDENTIAL_TTL_MS - 60_000 &&
      shapeDefaultDelta <= keydesk.HUB_CREDENTIAL_TTL_MS,
    `credentialExpiresAt ${String(shapeDefault.credentialExpiresAt)} (in ${Math.round(shapeDefaultDelta / 86_400_000)}d)`,
  );
  const explicitExpiry = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const shapeExplicit = keydesk.buildInvitationRequestBody({
    credentialExpiresAt: explicitExpiry,
  });
  check(
    'F1 shape: an explicit shorter credentialExpiresAt passes through the desk body exactly',
    shapeExplicit.credentialExpiresAt === explicitExpiry,
    `credentialExpiresAt ${String(shapeExplicit.credentialExpiresAt)}`,
  );

  // ---- Desk default scopes: the issuance body ALWAYS carries a set
  // Shape-level, beside the F1 pins: blank scopes must become the
  // desk default (Together's own defaults lack help:write), and an
  // explicit list must pass through exactly.
  const shapeScopesDefault = keydesk.buildInvitationRequestBody({});
  check(
    'desk default scopes shape: an invitation body built with scopes omitted carries exactly HUB_DESK_DEFAULT_SCOPES (read, help:write)',
    JSON.stringify(shapeScopesDefault.scopes) ===
      JSON.stringify([...keydesk.HUB_DESK_DEFAULT_SCOPES]),
    `scopes ${JSON.stringify(shapeScopesDefault.scopes)}`,
  );
  const shapeScopesExplicit = keydesk.buildInvitationRequestBody({ scopes: ['read'] });
  check(
    'desk default scopes shape: an explicit scope list passes through the desk body exactly',
    JSON.stringify(shapeScopesExplicit.scopes) === JSON.stringify(['read']),
    `scopes ${JSON.stringify(shapeScopesExplicit.scopes)}`,
  );

  const inviteAnon = await fetch(`${base}/hub/keydesk/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ projectId: 'hub-demo', displayName: 'nobody' }),
  });
  check('issuing an invitation without a session is refused 401', inviteAnon.status === 401, `status ${inviteAnon.status}`);
  await inviteAnon.arrayBuffer();

  const inviteRes = await fetch(`${base}/hub/keydesk/invite`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      projectId: 'hub-demo',
      displayName: 'smoke-agent',
      scopes: ['read', 'help:write'],
    }),
  });
  const invite = (await inviteRes.json()) as {
    identityId?: string;
    invitationId?: string;
    token?: string;
    scopes?: string[];
    credentialExpiresAt?: string | null;
  };
  check(
    'Key Desk issues an invitation for a new agent identity',
    inviteRes.status === 201 && typeof invite.token === 'string' && typeof invite.identityId === 'string',
    `status ${inviteRes.status}`,
  );
  const inviteCredExpiryDelta =
    typeof invite.credentialExpiresAt === 'string'
      ? Date.parse(invite.credentialExpiresAt) - Date.now()
      : Number.NaN;
  check(
    'F1: no credentialTtlDays was supplied, yet the issued invitation carries credentialExpiresAt ~30 days out (Together echoes the field only when the desk sent it)',
    typeof invite.credentialExpiresAt === 'string' &&
      inviteCredExpiryDelta > keydesk.HUB_CREDENTIAL_TTL_MS - 300_000 &&
      inviteCredExpiryDelta <= keydesk.HUB_CREDENTIAL_TTL_MS,
    `credentialExpiresAt ${invite.credentialExpiresAt ?? 'ABSENT — would mint a non-expiring credential'}`,
  );
  const agentIdentityId = invite.identityId ?? '';
  const invitationToken = invite.token ?? '';

  const exchange = await transport.apiFetch('/api/v1/projects/hub-demo/enrollment/exchange', {
    method: 'POST',
    headers: { authorization: `Bearer ${invitationToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: randomUUID(), adapter: 'smoke' }),
  });
  const exchangeBody = (await exchange.json()) as { token?: string; credentialId?: string };
  check(
    'the agent exchanges the invitation for its own credential (single-use token)',
    exchange.status === 201 && typeof exchangeBody.token === 'string',
    `status ${exchange.status}`,
  );
  const agentToken = exchangeBody.token ?? '';
  const agentCredentialId = exchangeBody.credentialId ?? '';
  const agentAuth = { authorization: `Bearer ${agentToken}` };

  const agentRead = await transport.apiFetch('/api/v1/projects/hub-demo/identities', {
    headers: agentAuth,
  });
  check('the issued credential reads its own project (200)', agentRead.status === 200, `status ${agentRead.status}`);
  await agentRead.arrayBuffer();

  // F1 stored-state proof: the credential the agent just minted by
  // exchanging the desk's invitation carries an expiry in Together's
  // stored state — exactly the invitation's credentialExpiresAt, and
  // at or under 30 days after the credential's own creation time.
  const deskAfterExchange = (await (
    await fetch(`${base}/hub/keydesk.json`, {
      headers: { ...cookie, accept: 'application/json' },
    })
  ).json()) as {
    projects?: {
      projectId?: string;
      agents?: {
        identity?: { id?: string };
        invitations?: { credentialExpiresAt?: string | null }[];
        credentials?: {
          id?: string;
          expiresAt?: string | null;
          createdAt?: string;
        }[];
      }[];
    }[];
  };
  const agentAfterExchange = deskAfterExchange.projects
    ?.find((p) => p.projectId === 'hub-demo')
    ?.agents?.find((a) => a.identity?.id === agentIdentityId);
  const mintedCred = agentAfterExchange?.credentials?.find((c) => c.id === agentCredentialId);
  const mintedCredLifeMs =
    mintedCred?.expiresAt != null && mintedCred?.createdAt != null
      ? Date.parse(mintedCred.expiresAt) - Date.parse(mintedCred.createdAt)
      : Number.NaN;
  check(
    'F1 stored state: the exchanged credential expires exactly at the invitation\'s credentialExpiresAt, a lifetime of (0, 30 days] from its creation',
    typeof invite.credentialExpiresAt === 'string' &&
      agentAfterExchange?.invitations?.[0]?.credentialExpiresAt === invite.credentialExpiresAt &&
      mintedCred?.expiresAt === invite.credentialExpiresAt &&
      mintedCredLifeMs > 0 &&
      mintedCredLifeMs <= keydesk.HUB_CREDENTIAL_TTL_MS,
    `credential expiresAt ${mintedCred?.expiresAt ?? 'ABSENT'} vs invitation ${invite.credentialExpiresAt ?? 'absent'}, lifetime ${Math.round(mintedCredLifeMs / 86_400_000)}d`,
  );

  const secondProject = await transport.apiFetch('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'smoke second project (scope refusal target)' }),
  });
  const secondBody = (await secondProject.json()) as { project?: { id?: string } };
  const secondProjectId = secondBody.project?.id ?? '';
  check('owner creates a second project for the scope check', secondProject.status === 201 && secondProjectId !== '', `status ${secondProject.status}`);
  const crossRead = await transport.apiFetch(
    `/api/v1/projects/${encodeURIComponent(secondProjectId)}/identities`,
    { headers: agentAuth },
  );
  const crossBody = (await crossRead.json()) as { error?: { code?: string } };
  check(
    'the credential is refused on another project, code surfaced',
    crossRead.status === 401 && crossBody.error?.code === 'unauthenticated',
    `status ${crossRead.status} code ${crossBody.error?.code ?? 'none'}`,
  );

  const helpAsk = await transport.apiFetch('/api/v1/projects/hub-demo/help', {
    method: 'POST',
    headers: { ...agentAuth, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: randomUUID(),
      question: 'smoke: owner, can you see this handoff in the queue?',
      toId: 'hub-owner',
    }),
  });
  const helpBody = (await helpAsk.json()) as { message?: { id?: string } };
  const messageId = helpBody.message?.id ?? '';
  check('the agent posts a handoff message to the owner', helpAsk.status === 201 && messageId !== '', `status ${helpAsk.status}`);

  const queueOnce = (await (await fetch(`${base}/hub/queue`)).json()) as {
    items?: { id?: string; delivery?: string }[];
  };
  const queueTwice = (await (await fetch(`${base}/hub/queue`)).json()) as {
    items?: { id?: string; delivery?: string }[];
  };
  check(
    'dashboard queue reads are NON-recording (delivery stays queued across refreshes)',
    queueOnce.items?.length === 1 &&
      queueOnce.items[0]?.delivery === 'queued' &&
      queueTwice.items?.[0]?.delivery === 'queued',
    `deliveries: ${queueOnce.items?.[0]?.delivery ?? 'none'} then ${queueTwice.items?.[0]?.delivery ?? 'none'}`,
  );

  const queueDetailRes = await fetch(`${base}/hub/queue/hub-demo/${messageId}`);
  const queueDetail = (await queueDetailRes.json()) as { id?: string; body?: string };
  check(
    'queue detail returns exactly the one handoff by id',
    queueDetailRes.status === 200 && queueDetail.id === messageId,
    `status ${queueDetailRes.status}`,
  );

  const recordingRead = await transport.apiFetch('/api/v1/inbox?limit=50');
  const recordingBody = (await recordingRead.json()) as {
    messages?: { id?: string; delivery?: string }[];
  };
  const recorded = recordingBody.messages?.find((m) => m.id === messageId);
  check(
    "the addressed reader's own API inbox GET is the recording read (marks delivered)",
    recordingRead.status === 200 && recorded?.delivery === 'delivered',
    `delivery ${recorded?.delivery ?? 'not found'}`,
  );
  const queueAfter = (await (await fetch(`${base}/hub/queue`)).json()) as {
    items?: { delivery?: string }[];
  };
  check(
    'the queue view then reflects the recorded delivery',
    queueAfter.items?.[0]?.delivery === 'delivered',
  );

  // Step 4.5 regression coverage: the queue INDEX is event-log anchored,
  // so an agent-to-agent handoff must be listed there — not only in the
  // detail surface and not only when the owner is a party. A second
  // agent is enrolled so the first agent can address it directly.
  const peerInviteRes = await fetch(`${base}/hub/keydesk/invite`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      projectId: 'hub-demo',
      displayName: 'smoke-agent-peer',
      scopes: ['read', 'help:write'],
    }),
  });
  const peerInvite = (await peerInviteRes.json()) as {
    identityId?: string;
    token?: string;
  };
  check(
    'Key Desk issues an invitation for a peer agent',
    peerInviteRes.status === 201 && typeof peerInvite.token === 'string' && typeof peerInvite.identityId === 'string',
    `status ${peerInviteRes.status}`,
  );
  const peerIdentityId = peerInvite.identityId ?? '';

  const peerExchange = await transport.apiFetch('/api/v1/projects/hub-demo/enrollment/exchange', {
    method: 'POST',
    headers: { authorization: `Bearer ${peerInvite.token ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: randomUUID(), adapter: 'smoke-peer' }),
  });
  const peerExchangeBody = (await peerExchange.json()) as { token?: string };
  check(
    'the peer agent exchanges its invitation for its own credential',
    peerExchange.status === 201 && typeof peerExchangeBody.token === 'string',
    `status ${peerExchange.status}`,
  );
  const peerAuth = { authorization: `Bearer ${peerExchangeBody.token ?? ''}` };

  // Step 6 fixture: a third agent holding a scope the other two do not
  // ('tasks:claim'), so an unaddressed handoff declaring that scope has
  // exactly ONE holder — the dispatcher's scope-match branch.
  const soloInviteRes = await fetch(`${base}/hub/keydesk/invite`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      projectId: 'hub-demo',
      displayName: 'smoke-agent-solo',
      scopes: ['read', 'tasks:claim'],
    }),
  });
  const soloInvite = (await soloInviteRes.json()) as { identityId?: string; token?: string };
  const soloIdentityId = soloInvite.identityId ?? '';
  const soloExchange = await transport.apiFetch('/api/v1/projects/hub-demo/enrollment/exchange', {
    method: 'POST',
    headers: { authorization: `Bearer ${soloInvite.token ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: randomUUID(), adapter: 'smoke-solo' }),
  });
  const soloExchangeBody = (await soloExchange.json()) as { token?: string };
  check(
    'Key Desk enrolls a scope-distinct third agent (sole holder of tasks:claim)',
    soloInviteRes.status === 201 &&
      soloIdentityId !== '' &&
      soloExchange.status === 201 &&
      typeof soloExchangeBody.token === 'string',
    `invite ${soloInviteRes.status}, exchange ${soloExchange.status}`,
  );

  const peerHelpAsk = await transport.apiFetch('/api/v1/projects/hub-demo/help', {
    method: 'POST',
    headers: { ...agentAuth, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: randomUUID(),
      question: 'smoke: peer, this agent-to-agent handoff must appear in the queue index',
      toId: peerIdentityId,
    }),
  });
  const peerHelpBody = (await peerHelpAsk.json()) as { message?: { id?: string } };
  const peerMessageId = peerHelpBody.message?.id ?? '';
  check(
    'the first agent posts a handoff directly to the peer agent',
    peerHelpAsk.status === 201 && peerMessageId !== '',
    `status ${peerHelpAsk.status}`,
  );

  type QueueItemView = {
    id?: string;
    senderId?: string;
    recipientId?: string;
    delivery?: string;
  };
  const queueItemsNow = async (): Promise<QueueItemView[]> => {
    const body = (await (await fetch(`${base}/hub/queue`)).json()) as { items?: QueueItemView[] };
    return body.items ?? [];
  };
  const peerIndexed1 = (await queueItemsNow()).find((m) => m.id === peerMessageId);
  const peerIndexed2 = (await queueItemsNow()).find((m) => m.id === peerMessageId);
  const peerDetailRes = await fetch(`${base}/hub/queue/hub-demo/${peerMessageId}`);
  const peerDetail = (await peerDetailRes.json()) as QueueItemView;
  check(
    'queue INDEX lists the agent-to-agent handoff, non-recording across two reads (detail agrees)',
    peerIndexed1?.senderId === agentIdentityId &&
      peerIndexed1?.recipientId === peerIdentityId &&
      peerIndexed1?.delivery === 'queued' &&
      peerIndexed2?.delivery === 'queued' &&
      peerDetailRes.status === 200 &&
      peerDetail.delivery === peerIndexed1?.delivery &&
      peerDetail.recipientId === peerIndexed1?.recipientId,
    `index ${peerIndexed1?.delivery ?? 'absent'} -> ${peerIndexed2?.delivery ?? 'absent'}, detail ${peerDetail.delivery ?? 'absent'}`,
  );

  const peerInbox = await transport.apiFetch('/api/v1/projects/hub-demo/inbox?limit=50', {
    headers: peerAuth,
  });
  const peerInboxBody = (await peerInbox.json()) as { messages?: QueueItemView[] };
  const peerCopy = peerInboxBody.messages?.find((m) => m.id === peerMessageId);
  check(
    "the addressed peer's own API inbox GET records delivery for the agent-to-agent handoff",
    peerInbox.status === 200 && peerCopy?.delivery === 'delivered',
    `status ${peerInbox.status}, delivery ${peerCopy?.delivery ?? 'not found'}`,
  );

  const peerIndexedAfter = (await queueItemsNow()).find((m) => m.id === peerMessageId);
  const peerDetailAfterRes = await fetch(`${base}/hub/queue/hub-demo/${peerMessageId}`);
  const peerDetailAfter = (await peerDetailAfterRes.json()) as QueueItemView;
  check(
    'queue INDEX then reflects the peer recorded delivery (detail agrees)',
    peerIndexedAfter?.delivery === 'delivered' &&
      peerDetailAfterRes.status === 200 &&
      peerDetailAfter.delivery === peerIndexedAfter?.delivery,
    `index/detail ${peerIndexedAfter?.delivery ?? 'absent'}/${peerDetailAfter.delivery ?? 'absent'}`,
  );

  // ---- Build step 6: the dispatcher (rules path) ---------------------
  // Both handoffs above name an enrolled addressee, so the rules router
  // must annotate them deliver-to-that-identity, routed_by "rules", with
  // the summary and its provenance on the SAME record (row 13). Drain
  // explicitly so the assertions never depend on the poll interval.
  type RoutingView = {
    state?: string;
    routed_by?: string;
    decision?: { action?: string; to?: string; reason?: string };
    summary?: string;
    decidedAt?: string;
    eventSeq?: number;
    gate?: { action?: string; by?: string; at?: string; to?: string; note?: string };
  };
  await dispatcher.processDispatcherOnce();
  const ownerDetail2Res = await fetch(`${base}/hub/queue/hub-demo/${messageId}`);
  const ownerDetail2 = (await ownerDetail2Res.json()) as { routing?: RoutingView };
  const ownerRouting = ownerDetail2.routing;
  check(
    'dispatcher annotated the addressed handoff: routed_by rules, deliver to the explicit addressee, summary present WITH provenance',
    ownerDetail2Res.status === 200 &&
      ownerRouting?.routed_by === 'rules' &&
      ownerRouting?.decision?.action === 'deliver' &&
      ownerRouting?.decision?.to === 'hub-owner' &&
      typeof ownerRouting?.decision?.reason === 'string' &&
      ownerRouting.decision.reason.includes('explicit addressee') &&
      typeof ownerRouting?.summary === 'string' &&
      ownerRouting.summary.includes('smoke: owner, can you see this handoff in the queue?') &&
      typeof ownerRouting?.decidedAt === 'string' &&
      typeof ownerRouting?.eventSeq === 'number',
    `routing ${JSON.stringify(ownerRouting)}`,
  );
  const phase1DecidedAt = ownerRouting?.decidedAt ?? '';
  const phase1EventSeq = ownerRouting?.eventSeq ?? -1;

  const peerDetail2Res = await fetch(`${base}/hub/queue/hub-demo/${peerMessageId}`);
  const peerDetail2 = (await peerDetail2Res.json()) as { routing?: RoutingView };
  check(
    'dispatcher annotated the agent-to-agent handoff: deliver to the peer identity',
    peerDetail2Res.status === 200 &&
      peerDetail2.routing?.routed_by === 'rules' &&
      peerDetail2.routing?.decision?.action === 'deliver' &&
      peerDetail2.routing?.decision?.to === peerIdentityId,
    `routing ${JSON.stringify(peerDetail2.routing)}`,
  );

  const queueWithRouting = (await (await fetch(`${base}/hub/queue`)).json()) as {
    items?: (QueueItemView & { routing?: RoutingView })[];
  };
  const peerRowRouting = queueWithRouting.items?.find((m) => m.id === peerMessageId)?.routing;
  check(
    'queue INDEX items carry the compact routing (routed_by + decision) for annotated handoffs',
    peerRowRouting?.routed_by === 'rules' &&
      peerRowRouting?.decision?.action === 'deliver' &&
      peerRowRouting?.decision?.to === peerIdentityId,
    `index routing ${JSON.stringify(peerRowRouting)}`,
  );

  const probeState = await transport.projectState('hub-demo');
  const modelProbe = await dispatcher.routeWithModel({
    state: probeState,
    message: probeState.messages[messageId],
  });
  check(
    'model path with the flag off answers a typed NOT-WIRED result (no call made, no fake routing output)',
    modelProbe.wired === false && modelProbe.ok === false && modelProbe.code === 'not_wired',
    `detail: ${modelProbe.detail}`,
  );

  const status2 = (await (await fetch(`${base}/hub/status`)).json()) as {
    dispatcher?: {
      running?: boolean;
      modelPath?: { flag?: string; wired?: boolean };
      projects?: Record<
        string,
        { watermark?: number; annotated?: number; byRoutedBy?: { rules?: number; model?: number }; needsOwner?: number }
      >;
    };
  };
  const dispDemo = status2.dispatcher?.projects?.['hub-demo'];
  check(
    '/hub/status carries dispatcher state: running, model path not wired, per-project counts by routed_by',
    status2.dispatcher?.running === true &&
      status2.dispatcher?.modelPath?.wired === false &&
      dispDemo?.annotated === 2 &&
      dispDemo?.byRoutedBy?.rules === 2 &&
      dispDemo?.byRoutedBy?.model === 0 &&
      dispDemo?.needsOwner === 0 &&
      (dispDemo?.watermark ?? 0) > 0,
    `dispatcher ${JSON.stringify(status2.dispatcher)}`,
  );

  const receiptsNow = (await (await fetch(`${base}/hub/receipts`)).json()) as {
    items?: { type?: string; seq?: number }[];
  };
  const offered = receiptsNow.items?.find((e) => e.type === 'help:offered');
  const receiptDetailRes = await fetch(`${base}/hub/receipts/hub-demo/${offered?.seq ?? -1}`);
  const receiptDetail = (await receiptDetailRes.json()) as { type?: string; seq?: number };
  check(
    'receipt detail returns exactly the one event by project + seq',
    receiptDetailRes.status === 200 && receiptDetail.seq === offered?.seq && receiptDetail.type === 'help:offered',
    `status ${receiptDetailRes.status}`,
  );
  const receiptMissing = await fetch(`${base}/hub/receipts/hub-demo/999999`);
  check('receipt detail for an absent seq is 404', receiptMissing.status === 404, `status ${receiptMissing.status}`);
  await receiptMissing.arrayBuffer();

  // ---- Build step 8: the receipts view + honest-limits card --------
  // The page is a desk surface: 401 without the owner session. With
  // one, it renders THIS run's own events as a timeline, and the
  // sha256 on its face must equal a hash computed independently here:
  // Together's own events route paged through the seam (after-cursor,
  // full stream), each record tagged {...event, projectId}, sorted by
  // seq, JSON.stringify, sha256 — the canonical construction
  // scripts/probe-handoff.ts hashes with over readReceipts items.
  const receiptsPageAnon = await fetch(`${base}/hub/receipts?view=page`);
  check(
    'receipts PAGE without an owner session is refused 401',
    receiptsPageAnon.status === 401,
    `status ${receiptsPageAnon.status}`,
  );
  await receiptsPageAnon.arrayBuffer();

  const receiptsPageRes = await fetch(`${base}/hub/receipts?view=page`, {
    headers: cookie,
  });
  const receiptsPageHtml = await receiptsPageRes.text();
  check(
    "receipts page renders the smoke's own events as a timeline (project header, event rows, limits card)",
    receiptsPageRes.status === 200 &&
      receiptsPageHtml.includes('Receipts — hub-demo') &&
      receiptsPageHtml.includes('help:offered') &&
      receiptsPageHtml.includes('Honest limits'),
    `status ${receiptsPageRes.status}`,
  );

  const streamEvents: Record<string, unknown>[] = [];
  {
    let after = 0;
    for (;;) {
      const pageRes = await transport.apiFetch(
        `/api/v1/projects/hub-demo/events?after=${after}&limit=100`,
      );
      const pageBody = (await pageRes.json()) as {
        events?: Record<string, unknown>[];
        latestSeq?: number;
      };
      const pageEvents = pageBody.events ?? [];
      if (pageEvents.length === 0) break;
      for (const e of pageEvents) streamEvents.push({ ...e, projectId: 'hub-demo' });
      const lastSeq = Number(pageEvents[pageEvents.length - 1]?.seq ?? after);
      if (!(lastSeq > after) || lastSeq >= (pageBody.latestSeq ?? lastSeq)) break;
      after = lastSeq;
    }
    streamEvents.sort((a, b) => Number(a.seq) - Number(b.seq));
  }
  const expectedHash = createHash('sha256')
    .update(JSON.stringify(streamEvents))
    .digest('hex');
  const shownHash = /id="receipts-sha256">([0-9a-f]{64})</.exec(receiptsPageHtml)?.[1];
  const shownCount = Number(
    /id="receipts-count">(\d+)</.exec(receiptsPageHtml)?.[1] ?? '-1',
  );
  check(
    'receipts page sha256 equals the independently computed canonical-stream hash; the displayed count is the full stream length',
    shownHash === expectedHash && shownCount === streamEvents.length,
    `page ${shownHash ?? 'none'} (${shownCount} events) vs computed ${expectedHash} (${streamEvents.length} events)`,
  );
  check(
    "timeline restatements are built from the events' own fields (the help:offered row names the smoke's handoff message)",
    offered?.seq !== undefined &&
      receiptsPageHtml.includes(`#${offered.seq} · help:offered`) &&
      receiptsPageHtml.includes(messageId),
    `offered seq ${offered?.seq ?? 'absent'}, message ${messageId}`,
  );

  const statusNow = (await (await fetch(`${base}/hub/status`)).json()) as {
    dispatcher?: { modelPath?: { flag?: string; wired?: boolean } };
  };
  check(
    'honest-limits card: pull-only + refusal-not-recorded lines present; the model-path line matches /hub/status at runtime',
    receiptsPageHtml.includes('wakes an agent') &&
      receiptsPageHtml.includes('not recorded') &&
      statusNow.dispatcher?.modelPath?.wired === false &&
      receiptsPageHtml.includes('model path is NOT wired') &&
      receiptsPageHtml.includes('wired: false') &&
      receiptsPageHtml.includes(`"${String(statusNow.dispatcher?.modelPath?.flag ?? 'off')}"`),
    `status modelPath ${JSON.stringify(statusNow.dispatcher?.modelPath)}`,
  );
  check(
    'Key Desk page links the receipts view + honest-limits card',
    deskHtml.includes('/hub/receipts?view=page'),
  );
  const receiptsAcceptRes = await fetch(`${base}/hub/receipts`, {
    headers: { ...cookie, accept: 'text/html' },
  });
  const receiptsAcceptHtml = await receiptsAcceptRes.text();
  const receiptsRawRes = await fetch(`${base}/hub/receipts`);
  const receiptsRaw = (await receiptsRawRes.json()) as {
    items?: unknown[];
    pages?: unknown[];
    total?: number;
  };
  check(
    'Accept: text/html serves the receipts page; the raw JSON surface is unchanged (items/pages/total, no session needed)',
    receiptsAcceptRes.status === 200 &&
      receiptsAcceptHtml.includes('id="receipts-sha256"') &&
      receiptsRawRes.status === 200 &&
      Array.isArray(receiptsRaw.items) &&
      Array.isArray(receiptsRaw.pages) &&
      typeof receiptsRaw.total === 'number',
    `accept status ${receiptsAcceptRes.status}, raw status ${receiptsRawRes.status}`,
  );
  const receiptsUnknownRes = await fetch(
    `${base}/hub/receipts?view=page&project=smoke-no-such-project`,
    { headers: cookie },
  );
  check(
    'receipts page for an unknown project is 404',
    receiptsUnknownRes.status === 404,
    `status ${receiptsUnknownRes.status}`,
  );
  await receiptsUnknownRes.arrayBuffer();

  type DeskAgent = {
    identity?: { id?: string };
    credentials?: { id?: string; status?: string; scopes?: string[] }[];
    invitations?: { status?: string }[];
    lastSuccess?: { type?: string } | null;
    lastRefusal?: { recorded?: boolean };
    standingRefusal?: { reason?: string } | null;
  };
  const deskState = async (): Promise<DeskAgent | undefined> => {
    const res = await fetch(`${base}/hub/keydesk.json`, {
      headers: { ...cookie, accept: 'application/json' },
    });
    const body = (await res.json()) as {
      projects?: { projectId?: string; agents?: DeskAgent[] }[];
    };
    return body.projects
      ?.find((p) => p.projectId === 'hub-demo')
      ?.agents?.find((a) => a.identity?.id === agentIdentityId);
  };
  const agentRow = await deskState();
  check(
    'Key Desk lists the agent: credential active, invitation exchanged, last action recorded',
    agentRow?.credentials?.some((c) => c.id === agentCredentialId && c.status === 'active') === true &&
      agentRow.invitations?.[0]?.status === 'exchanged' &&
      typeof agentRow.lastSuccess?.type === 'string',
    `lastSuccess ${agentRow?.lastSuccess?.type ?? 'none'}`,
  );
  check(
    'Key Desk shows last refusal as not recorded (Together logs no refused calls)',
    agentRow?.lastRefusal?.recorded === false && agentRow?.standingRefusal === null,
  );

  const revokeRes = await fetch(`${base}/hub/keydesk/revoke`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ projectId: 'hub-demo', credentialId: agentCredentialId }),
  });
  check('owner revokes the credential from the Key Desk', revokeRes.status === 200, `status ${revokeRes.status}`);
  await revokeRes.arrayBuffer();

  const afterRevoke = await transport.apiFetch('/api/v1/projects/hub-demo/identities', {
    headers: agentAuth,
  });
  check("the revoked credential's next API call is refused 401", afterRevoke.status === 401, `status ${afterRevoke.status}`);
  await afterRevoke.arrayBuffer();

  const agentRowAfter = await deskState();
  check(
    'Key Desk after revoke: credential revoked, standing refusal on record, last action kept',
    agentRowAfter?.credentials?.some((c) => c.id === agentCredentialId && c.status === 'revoked') === true &&
      agentRowAfter.standingRefusal?.reason === 'credential_revoked' &&
      typeof agentRowAfter.lastSuccess?.type === 'string',
    `standingRefusal ${agentRowAfter?.standingRefusal?.reason ?? 'none'}`,
  );

  // ---- Desk default scopes, end-to-end (Law 2b UI pass finding) --
  // In its OWN project (so no hub-demo count anywhere above or below
  // can move): an invitation issued through the desk route with the
  // scopes field left BLANK must exchange into a credential whose
  // STORED scopes are exactly the desk default — and that credential
  // must be able to POST /help, the act attempt 1 of the UI pass
  // watched fail 403 on Together's defaults. An explicit list in the
  // same project must be stored exactly as supplied.
  const dsProject = await transport.apiFetch('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'smoke desk-default-scopes project' }),
  });
  const dsProjectBody = (await dsProject.json()) as { project?: { id?: string } };
  const dsProjectId = dsProjectBody.project?.id ?? '';
  const dsInvite = async (payload: Record<string, unknown>) => {
    const res = await fetch(`${base}/hub/keydesk/invite`, {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ projectId: dsProjectId, ...payload }),
    });
    const body = (await res.json()) as {
      identityId?: string;
      token?: string;
      scopes?: string[];
    };
    return { status: res.status, body };
  };
  const dsExchange = async (token: string) => {
    const res = await transport.apiFetch(
      `/api/v1/projects/${encodeURIComponent(dsProjectId)}/enrollment/exchange`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: randomUUID(), adapter: 'smoke-desk-scopes' }),
      },
    );
    const body = (await res.json()) as { token?: string; credentialId?: string };
    return { status: res.status, body };
  };
  const dsStoredScopes = async (identityId: string): Promise<string[] | undefined> => {
    const res = await fetch(`${base}/hub/keydesk.json`, {
      headers: { ...cookie, accept: 'application/json' },
    });
    const body = (await res.json()) as {
      projects?: {
        projectId?: string;
        agents?: {
          identity?: { id?: string };
          credentials?: { scopes?: string[] }[];
        }[];
      }[];
    };
    return body.projects
      ?.find((p) => p.projectId === dsProjectId)
      ?.agents?.find((a) => a.identity?.id === identityId)?.credentials?.[0]?.scopes;
  };

  const dsExplicitInvite = await dsInvite({
    displayName: 'smoke-desk-explicit',
    scopes: ['read'],
  });
  const dsExplicitExchange = await dsExchange(dsExplicitInvite.body.token ?? '');
  const dsBlankInvite = await dsInvite({ displayName: 'smoke-desk-blank' });
  const dsBlankExchange = await dsExchange(dsBlankInvite.body.token ?? '');
  const dsBlankStored = await dsStoredScopes(dsBlankInvite.body.identityId ?? '');
  check(
    'desk default scopes end-to-end: an invitation issued with scopes left BLANK exchanges into a credential whose stored scopes are exactly the desk default (read, help:write)',
    dsProjectId !== '' &&
      dsBlankInvite.status === 201 &&
      dsBlankExchange.status === 201 &&
      JSON.stringify(dsBlankStored) ===
        JSON.stringify([...keydesk.HUB_DESK_DEFAULT_SCOPES]),
    `stored scopes ${JSON.stringify(dsBlankStored)} (invite ${dsBlankInvite.status}, exchange ${dsBlankExchange.status})`,
  );
  const dsExplicitStored = await dsStoredScopes(dsExplicitInvite.body.identityId ?? '');
  check(
    'desk default scopes end-to-end: an explicit scope list is honored exactly (stored scopes are precisely the supplied list)',
    dsExplicitInvite.status === 201 &&
      dsExplicitExchange.status === 201 &&
      JSON.stringify(dsExplicitStored) === JSON.stringify(['read']),
    `stored scopes ${JSON.stringify(dsExplicitStored)} (invite ${dsExplicitInvite.status}, exchange ${dsExplicitExchange.status})`,
  );
  const dsHelp = await transport.apiFetch(
    `/api/v1/projects/${encodeURIComponent(dsProjectId)}/help`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${dsBlankExchange.body.token ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operationId: randomUUID(),
        question: 'smoke: the blank-default credential posts this handoff',
        toId: dsExplicitInvite.body.identityId ?? '',
      }),
    },
  );
  const dsHelpBody = (await dsHelp.json()) as { message?: { id?: string } };
  check(
    'desk default scopes end-to-end: the blank-default credential POSTs /help successfully (201) — the form\u2019s default path yields an agent that can do the Hub\u2019s central thing',
    dsHelp.status === 201 && (dsHelpBody.message?.id ?? '') !== '',
    `status ${dsHelp.status}`,
  );

  const logout = await fetch(`${base}/hub/logout`, {
    method: 'POST',
    headers: cookie,
    redirect: 'manual',
  });
  check('POST /hub/logout ends the session', logout.status === 303, `status ${logout.status}`);
  await logout.arrayBuffer();
  const deskAfterLogout = await fetch(`${base}/hub/keydesk`, { headers: cookie });
  check(
    'the ended session no longer opens the Key Desk (revoked in Together\'s store)',
    deskAfterLogout.status === 401,
    `status ${deskAfterLogout.status}`,
  );
  await deskAfterLogout.arrayBuffer();

  // ---- Build step 6, phase 2: restart persistence + rules branches --
  // Stop the first boot, seed unaddressed handoff records directly into
  // the project state file (the imported-log shape from the header —
  // records whose recipient field names no enrolled identity), then
  // boot again on the SAME state dir. Expectations: the phase-1
  // annotations survive byte-identical (persisted watermark — no
  // duplicates, no re-annotation), the seeded handoffs are annotated
  // exactly once through the scope-match and needs-owner branches, and
  // a record with no anchoring event stays "pending".
  await hub.close();
  const projectFile = join(stateDir, 'hub-demo.json');
  const doc = JSON.parse(readFileSync(projectFile, 'utf8')) as {
    savedAt?: string;
    state: {
      messages: Record<string, Record<string, unknown>>;
      events: Record<string, unknown>[];
    };
  };
  const seededAt = new Date().toISOString();
  const maxSeq = doc.state.events.reduce((m, e) => Math.max(m, Number(e.seq ?? 0)), 0);
  const seedMessage = (id: string, body: string, scopes?: string[]): void => {
    doc.state.messages[id] = {
      id,
      projectId: 'hub-demo',
      revision: 1,
      createdAt: seededAt,
      updatedAt: seededAt,
      actorId: agentIdentityId,
      recipientId: '',
      senderId: agentIdentityId,
      type: 'assignment-offer',
      body,
      delivery: 'queued',
      ...(scopes !== undefined ? { role: 'builder', scopes } : {}),
    };
  };
  const seedEvent = (seq: number, id: string, messageId: string): void => {
    doc.state.events.push({
      id,
      projectId: 'hub-demo',
      seq,
      createdAt: seededAt,
      actorId: agentIdentityId,
      actorKind: 'agent',
      type: 'offer:sent',
      entityId: messageId,
      detail: {},
    });
  };
  seedMessage('smoke-seeded-scope-match', 'seeded: unaddressed handoff declaring tasks:claim', ['tasks:claim']);
  seedEvent(maxSeq + 1, 'smoke-seeded-event-1', 'smoke-seeded-scope-match');
  // 'read' is held by two ACTIVE credentials at this point (peer +
  // solo). help:write would NOT do: the first agent's credential was
  // revoked above, so the peer is its only active holder — the router
  // proved exactly that in an earlier run of this fixture.
  seedMessage('smoke-seeded-multi-match', 'seeded: unaddressed handoff declaring read (two active holders)', ['read']);
  seedEvent(maxSeq + 2, 'smoke-seeded-event-2', 'smoke-seeded-multi-match');
  seedMessage('smoke-seeded-no-scopes', 'seeded: unaddressed handoff declaring no scopes');
  seedEvent(maxSeq + 3, 'smoke-seeded-event-3', 'smoke-seeded-no-scopes');
  seedMessage('smoke-seeded-unanchored', 'seeded: record with no anchoring event — must stay pending');
  doc.savedAt = seededAt;
  writeFileSync(projectFile, JSON.stringify(doc, null, 2));

  // Step 7 cross-boot evidence: the released annotation's dispatcher
  // decidedAt, captured on boot 2 and re-asserted on boot 3.
  let gateReleasedDecidedAt = '';
  const hub2 = await startHubServer(0);
  try {
    const base2 = `http://127.0.0.1:${hub2.port}`;
    await dispatcher.processDispatcherOnce();
    const detail2 = async (id: string): Promise<{ routing?: RoutingView }> => {
      const res = await fetch(`${base2}/hub/queue/hub-demo/${id}`);
      return (await res.json()) as { routing?: RoutingView };
    };
    const scopeMatch = (await detail2('smoke-seeded-scope-match')).routing;
    check(
      'restart + scope branch: unaddressed handoff with exactly one scope holder is delivered to that holder',
      scopeMatch?.routed_by === 'rules' &&
        scopeMatch?.decision?.action === 'deliver' &&
        scopeMatch?.decision?.to === soloIdentityId &&
        (scopeMatch?.decision?.reason ?? '').includes('tasks:claim') &&
        typeof scopeMatch?.summary === 'string' &&
        scopeMatch.summary.length > 0,
      `routing ${JSON.stringify(scopeMatch)}`,
    );
    const multiMatch = (await detail2('smoke-seeded-multi-match')).routing;
    check(
      'restart + needs-owner branch: multiple scope holders means no unique match',
      multiMatch?.routed_by === 'rules' &&
        multiMatch?.decision?.action === 'needs-owner' &&
        multiMatch?.decision?.to === undefined &&
        (multiMatch?.decision?.reason ?? '').includes('no unique match'),
      `routing ${JSON.stringify(multiMatch)}`,
    );
    const noScopes = (await detail2('smoke-seeded-no-scopes')).routing;
    check(
      'restart + needs-owner branch: no addressee and no declared scopes',
      noScopes?.routed_by === 'rules' &&
        noScopes?.decision?.action === 'needs-owner' &&
        (noScopes?.decision?.reason ?? '').includes('no required scopes'),
      `routing ${JSON.stringify(noScopes)}`,
    );
    const unanchored = (await detail2('smoke-seeded-unanchored')).routing;
    check(
      'an unanchored record is never annotated: routing state shows "pending" (absence shown, not backfilled)',
      unanchored?.state === 'pending' && unanchored?.routed_by === undefined,
      `routing ${JSON.stringify(unanchored)}`,
    );
    const ownerAgain = (await detail2(messageId)).routing;
    check(
      'restart persistence: the phase-1 annotation is unchanged (same decidedAt + eventSeq — no duplicate, no re-annotation)',
      ownerAgain?.routed_by === 'rules' &&
        phase1DecidedAt !== '' &&
        ownerAgain?.decidedAt === phase1DecidedAt &&
        ownerAgain?.eventSeq === phase1EventSeq,
      `decidedAt ${ownerAgain?.decidedAt ?? 'absent'} vs phase 1 ${phase1DecidedAt}`,
    );
    const status3 = (await (await fetch(`${base2}/hub/status`)).json()) as typeof status2;
    const dispDemo3 = status3.dispatcher?.projects?.['hub-demo'];
    check(
      'dispatcher status after restart: 5 annotations (2 + 3 seeded), 2 needs-owner, watermark at the log end',
      dispDemo3?.annotated === 5 &&
        dispDemo3?.byRoutedBy?.rules === 5 &&
        dispDemo3?.needsOwner === 2 &&
        dispDemo3?.watermark === maxSeq + 3,
      `dispatcher ${JSON.stringify(dispDemo3)}, expected watermark ${maxSeq + 3}`,
    );

    // ---- Build step 7: the approval gate ---------------------------
    // Both seeded needs-owner handoffs (multi-match + no-scopes) are
    // waiting at the gate. The owner signs in on this boot and works
    // the gate end to end: list, blocked release, bad target, clean
    // release, refusal, conflicts, counts.
    const login2 = await fetch(`${base2}/hub/login`, { method: 'POST', redirect: 'manual' });
    const cookie2Pair = (login2.headers.get('set-cookie') ?? '').split(';')[0];
    await login2.arrayBuffer();
    check(
      'second boot: the owner signs in again for the gate checks',
      login2.status === 303 && cookie2Pair.startsWith('together_session='),
      `status ${login2.status}`,
    );
    const cookie2 = { cookie: cookie2Pair };

    const gatePostAnon = await fetch(
      `${base2}/hub/keydesk/gate/hub-demo/smoke-seeded-multi-match`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: 'refuse' }),
      },
    );
    check(
      'gate action without an owner session is refused 401',
      gatePostAnon.status === 401,
      `status ${gatePostAnon.status}`,
    );
    await gatePostAnon.arrayBuffer();
    const gateListAnon = await fetch(`${base2}/hub/keydesk/gate`, {
      headers: { accept: 'application/json' },
    });
    check(
      'gate list without an owner session is refused 401',
      gateListAnon.status === 401,
      `status ${gateListAnon.status}`,
    );
    await gateListAnon.arrayBuffer();

    type GateItemView = {
      messageId?: string;
      summary?: string;
      reason?: string;
      senderId?: string;
      sender?: string;
      decidedAt?: string;
    };
    const readGateAwaiting = async (): Promise<GateItemView[]> => {
      const res = await fetch(`${base2}/hub/keydesk/gate`, {
        headers: { ...cookie2, accept: 'application/json' },
      });
      const body = (await res.json()) as {
        projects?: { projectId?: string; awaiting?: GateItemView[] }[];
      };
      return body.projects?.find((p) => p.projectId === 'hub-demo')?.awaiting ?? [];
    };
    const awaiting0 = await readGateAwaiting();
    const awaitingMulti = awaiting0.find((a) => a.messageId === 'smoke-seeded-multi-match');
    const awaitingNoScopes = awaiting0.find((a) => a.messageId === 'smoke-seeded-no-scopes');
    check(
      'gate list shows both needs-owner handoffs: summary, dispatcher reason, sender, annotation decidedAt',
      awaiting0.length === 2 &&
        typeof awaitingMulti?.summary === 'string' &&
        awaitingMulti.summary.length > 0 &&
        (awaitingMulti?.reason ?? '').includes('no unique match') &&
        awaitingMulti?.senderId === agentIdentityId &&
        awaitingMulti?.sender === 'smoke-agent' &&
        typeof awaitingMulti?.decidedAt === 'string' &&
        (awaitingNoScopes?.reason ?? '').includes('no required scopes'),
      `awaiting: ${awaiting0.map((a) => a.messageId ?? '?').join(', ') || 'none'}`,
    );

    type GatePostResult = {
      status: number;
      body: {
        ok?: boolean;
        error?: string;
        detail?: string;
        annotation?: RoutingView;
      };
    };
    const gatePost = async (
      mid: string,
      payload: Record<string, unknown>,
    ): Promise<GatePostResult> => {
      const res = await fetch(`${base2}/hub/keydesk/gate/hub-demo/${mid}`, {
        method: 'POST',
        headers: { ...cookie2, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: (await res.json()) as GatePostResult['body'] };
    };

    // The first agent's credential was revoked in phase 1: releasing
    // into it must be BLOCKED, with the record's reason, and the
    // annotation must not change.
    const blocked = await gatePost('smoke-seeded-no-scopes', {
      action: 'release',
      to: agentIdentityId,
    });
    check(
      'release to an identity whose credential is revoked is BLOCKED with the reason (the desk never routes into a wall)',
      blocked.status === 409 &&
        blocked.body.error === 'gate_target_blocked' &&
        (blocked.body.detail ?? '').includes('revoked'),
      `status ${blocked.status}, detail: ${blocked.body.detail ?? 'none'}`,
    );
    const noScopesAfterBlock = (await detail2('smoke-seeded-no-scopes')).routing;
    check(
      'the blocked release changed nothing: still needs-owner, no gate record attached',
      noScopesAfterBlock?.decision?.action === 'needs-owner' &&
        noScopesAfterBlock?.gate === undefined,
      `routing ${JSON.stringify(noScopesAfterBlock)}`,
    );

    const unknownTarget = await gatePost('smoke-seeded-no-scopes', {
      action: 'release',
      to: 'smoke-no-such-identity',
    });
    check(
      'release to an identity not enrolled in the project is refused 422',
      unknownTarget.status === 422 &&
        unknownTarget.body.error === 'gate_target_not_enrolled',
      `status ${unknownTarget.status}`,
    );

    const released = await gatePost('smoke-seeded-multi-match', {
      action: 'release',
      to: soloIdentityId,
    });
    const relAnn = released.body.annotation;
    gateReleasedDecidedAt = relAnn?.decidedAt ?? '';
    check(
      'owner releases the multi-match handoff: decision becomes deliver (release + original reason stated), gate provenance attached, routed_by still rules, dispatcher decidedAt untouched',
      released.status === 200 &&
        relAnn?.decision?.action === 'deliver' &&
        relAnn?.decision?.to === soloIdentityId &&
        (relAnn?.decision?.reason ?? '').startsWith('released by owner (was needs-owner:') &&
        (relAnn?.decision?.reason ?? '').includes('no unique match') &&
        relAnn?.gate?.action === 'released' &&
        relAnn?.gate?.by === 'owner' &&
        relAnn?.gate?.to === soloIdentityId &&
        typeof relAnn?.gate?.at === 'string' &&
        relAnn?.routed_by === 'rules' &&
        relAnn?.decidedAt === (multiMatch?.decidedAt ?? '') &&
        (multiMatch?.decidedAt ?? '') !== '',
      `annotation ${JSON.stringify(relAnn)}`,
    );

    const multiDetailAfter = (await detail2('smoke-seeded-multi-match')).routing;
    const queueIdx2 = (await (await fetch(`${base2}/hub/queue`)).json()) as {
      items?: (QueueItemView & { routing?: RoutingView })[];
    };
    const multiRow = queueIdx2.items?.find((m) => m.id === 'smoke-seeded-multi-match');
    check(
      'queue detail + index show the release: deliver decision WITH the gate marker beside it',
      multiDetailAfter?.decision?.action === 'deliver' &&
        multiDetailAfter?.gate?.action === 'released' &&
        multiRow?.routing?.decision?.action === 'deliver' &&
        multiRow?.routing?.gate?.action === 'released' &&
        multiRow?.routing?.gate?.to === soloIdentityId,
      `detail gate ${JSON.stringify(multiDetailAfter?.gate)}, index gate ${JSON.stringify(multiRow?.routing?.gate)}`,
    );

    const doubleAct = await gatePost('smoke-seeded-multi-match', { action: 'refuse' });
    check(
      'a second gate action on an already-decided handoff is a conflict (409)',
      doubleAct.status === 409 && doubleAct.body.error === 'gate_conflict',
      `status ${doubleAct.status}`,
    );

    const refused = await gatePost('smoke-seeded-no-scopes', {
      action: 'refuse',
      note: 'smoke: not for this crew',
    });
    const refAnn = refused.body.annotation;
    check(
      'owner refuses the no-scopes handoff: gate record carries the refusal + note; the decision stays needs-owner (the dispatcher did route it to the owner)',
      refused.status === 200 &&
        refAnn?.gate?.action === 'refused' &&
        refAnn?.gate?.by === 'owner' &&
        refAnn?.gate?.note === 'smoke: not for this crew' &&
        typeof refAnn?.gate?.at === 'string' &&
        refAnn?.decision?.action === 'needs-owner' &&
        refAnn?.routed_by === 'rules',
      `annotation ${JSON.stringify(refAnn)}`,
    );

    const noScopesDetailRes = await fetch(
      `${base2}/hub/queue/hub-demo/smoke-seeded-no-scopes`,
    );
    const noScopesDetail = (await noScopesDetailRes.json()) as {
      delivery?: string;
      body?: string;
      routing?: RoutingView;
    };
    check(
      "queue detail displays the refusal — and Together's message record is untouched (still queued, body intact)",
      noScopesDetailRes.status === 200 &&
        noScopesDetail.routing?.gate?.action === 'refused' &&
        noScopesDetail.delivery === 'queued' &&
        noScopesDetail.body === 'seeded: unaddressed handoff declaring no scopes',
      `delivery ${noScopesDetail.delivery ?? 'absent'}, body ${JSON.stringify(noScopesDetail.body)}`,
    );

    const dispatcherDoc = JSON.parse(
      readFileSync(join(stateDir, 'hub', 'dispatcher.json'), 'utf8'),
    ) as {
      annotations?: Record<string, Record<string, { gate?: { action?: string } }>>;
    };
    const projectDocNow = JSON.parse(readFileSync(join(stateDir, 'hub-demo.json'), 'utf8')) as {
      state: { messages: Record<string, Record<string, unknown>> };
    };
    check(
      "gate decisions live ONLY in the Hub's annotation store — Together's project record carries no gate field",
      dispatcherDoc.annotations?.['hub-demo']?.['smoke-seeded-no-scopes']?.gate?.action ===
        'refused' &&
        !('gate' in (projectDocNow.state.messages['smoke-seeded-no-scopes'] ?? {})),
    );

    const onDelivered = await gatePost(peerMessageId, {
      action: 'release',
      to: soloIdentityId,
    });
    check(
      'gate action on a handoff that is NOT needs-owner (dispatcher already delivered it) is a conflict (409)',
      onDelivered.status === 409 && onDelivered.body.error === 'gate_conflict',
      `status ${onDelivered.status}`,
    );

    const awaitingAfter = await readGateAwaiting();
    check(
      'gate list is empty once both handoffs are decided',
      awaitingAfter.length === 0,
      `awaiting ${awaitingAfter.length}`,
    );

    const status4 = (await (await fetch(`${base2}/hub/status`)).json()) as {
      dispatcher?: {
        projects?: Record<
          string,
          { gate?: { released?: number; refused?: number; awaiting?: number } }
        >;
      };
    };
    const gateCounts = status4.dispatcher?.projects?.['hub-demo']?.gate;
    check(
      '/hub/status dispatcher block reports the gate counts (released 1, refused 1, awaiting 0)',
      gateCounts?.released === 1 && gateCounts?.refused === 1 && gateCounts?.awaiting === 0,
      `gate ${JSON.stringify(gateCounts)}`,
    );
  } finally {
    await hub2.close();
  }

  // ---- Build step 7, phase 3: gate decisions persist across restart --
  const hub3 = await startHubServer(0);
  try {
    const base3 = `http://127.0.0.1:${hub3.port}`;
    await dispatcher.processDispatcherOnce();
    const detail3 = async (id: string): Promise<{ routing?: RoutingView }> => {
      const res = await fetch(`${base3}/hub/queue/hub-demo/${id}`);
      return (await res.json()) as { routing?: RoutingView };
    };
    const multiAgain = (await detail3('smoke-seeded-multi-match')).routing;
    const noScopesAgain = (await detail3('smoke-seeded-no-scopes')).routing;
    const status5 = (await (await fetch(`${base3}/hub/status`)).json()) as {
      dispatcher?: {
        projects?: Record<
          string,
          {
            annotated?: number;
            gate?: { released?: number; refused?: number; awaiting?: number };
          }
        >;
      };
    };
    const demoAgain = status5.dispatcher?.projects?.['hub-demo'];
    check(
      'restart persistence: gate decisions survive a Hub restart (release + refusal intact, dispatcher decidedAt unchanged, still exactly 5 annotations, counts stable)',
      multiAgain?.gate?.action === 'released' &&
        multiAgain?.gate?.to === soloIdentityId &&
        multiAgain?.decision?.action === 'deliver' &&
        gateReleasedDecidedAt !== '' &&
        multiAgain?.decidedAt === gateReleasedDecidedAt &&
        noScopesAgain?.gate?.action === 'refused' &&
        noScopesAgain?.gate?.note === 'smoke: not for this crew' &&
        demoAgain?.annotated === 5 &&
        demoAgain?.gate?.released === 1 &&
        demoAgain?.gate?.refused === 1 &&
        demoAgain?.gate?.awaiting === 0,
      `multi gate ${JSON.stringify(multiAgain?.gate)}, refused gate ${JSON.stringify(noScopesAgain?.gate)}`,
    );
  } finally {
    await hub3.close();
  }

  // ---- Model path (wired): a fourth boot, flag on, stand-in transport
  // Two more imported-shape records are seeded into the project file:
  // one the stand-in routes successfully, one whose stand-in throws.
  // No live call is made in this phase — the transport seam is the
  // point — but the labeling discipline under test is the live one:
  // "model" is earned only by a validated success, and a failure
  // falls back to rules WITH the attempt recorded on the annotation.
  const doc4 = JSON.parse(readFileSync(projectFile, 'utf8')) as {
    savedAt?: string;
    state: {
      messages: Record<string, Record<string, unknown>>;
      events: Record<string, unknown>[];
    };
  };
  const maxSeq4 = doc4.state.events.reduce((m, e) => Math.max(m, Number(e.seq ?? 0)), 0);
  const seedMessage4 = (id: string, body: string, scopes?: string[]): void => {
    doc4.state.messages[id] = {
      id,
      projectId: 'hub-demo',
      revision: 1,
      createdAt: seededAt,
      updatedAt: seededAt,
      actorId: agentIdentityId,
      recipientId: '',
      senderId: agentIdentityId,
      type: 'assignment-offer',
      body,
      delivery: 'queued',
      ...(scopes !== undefined ? { role: 'builder', scopes } : {}),
    };
  };
  const seedEvent4 = (seq: number, id: string, messageId: string): void => {
    doc4.state.events.push({
      id,
      projectId: 'hub-demo',
      seq,
      createdAt: seededAt,
      actorId: agentIdentityId,
      actorKind: 'agent',
      type: 'offer:sent',
      entityId: messageId,
      detail: {},
    });
  };
  seedMessage4(
    'smoke-seeded-model-ok',
    'seeded: model-path success case — the stand-in routes this one',
    ['tasks:claim'],
  );
  seedEvent4(maxSeq4 + 1, 'smoke-seeded-event-4', 'smoke-seeded-model-ok');
  seedMessage4(
    'smoke-seeded-model-fail',
    'seeded: model-path failure case — the stand-in throws on this one',
  );
  seedEvent4(maxSeq4 + 2, 'smoke-seeded-event-5', 'smoke-seeded-model-fail');
  doc4.savedAt = seededAt;
  writeFileSync(projectFile, JSON.stringify(doc4, null, 2));

  process.env.HUB_DISPATCHER_MODEL = 'on';
  dispatcher.setModelTransport(async (prompt: string) => {
    if (prompt.includes('model-path failure case')) {
      throw new Error('smoke stand-in: simulated transport failure');
    }
    return {
      content: JSON.stringify({
        action: 'deliver',
        to: soloIdentityId,
        reason: 'stand-in: the record declares tasks:claim and the roster shows a single holder',
        summary: 'STAND-IN SUMMARY: smoke-agent -> smoke-agent-solo: seeded model-path success case',
      }),
      finishReason: 'stop',
      model: 'muse-spark-1.3 (stand-in)',
      inputTokens: 321,
      outputTokens: 87,
      latencyMs: 12,
    };
  });

  const hub4 = await startHubServer(0);
  try {
    const base4 = `http://127.0.0.1:${hub4.port}`;
    await dispatcher.processDispatcherOnce();
    type ModelAnnotationView = {
      routed_by?: string;
      decision?: { action?: string; to?: string; reason?: string };
      summary?: string;
      model_call?: { model?: string; inputTokens?: number; outputTokens?: number };
      model_attempt?: { ok?: boolean; code?: string; detail?: string };
    };
    const modelOk = dispatcher.getAnnotation(
      'hub-demo',
      'smoke-seeded-model-ok',
    ) as ModelAnnotationView | null;
    check(
      'model path ON (stand-in): a validated model decision annotates routed_by "model" — the model\'s OWN summary (not the rules template) and its call receipt on the same record',
      modelOk?.routed_by === 'model' &&
        modelOk?.decision?.action === 'deliver' &&
        modelOk?.decision?.to === soloIdentityId &&
        (modelOk?.summary ?? '').startsWith('STAND-IN SUMMARY') &&
        modelOk?.model_call?.model === 'muse-spark-1.3 (stand-in)' &&
        modelOk?.model_call?.inputTokens === 321 &&
        modelOk?.model_call?.outputTokens === 87 &&
        modelOk?.model_attempt === undefined,
      `annotation ${JSON.stringify(modelOk)}`,
    );
    const modelFail = dispatcher.getAnnotation(
      'hub-demo',
      'smoke-seeded-model-fail',
    ) as ModelAnnotationView | null;
    check(
      'model path ON (stand-in throws): the annotation falls back to the rules decision — routed_by stays "rules" (a failed call never wears "model") and the failed attempt is recorded on the record',
      modelFail?.routed_by === 'rules' &&
        modelFail?.decision?.action === 'needs-owner' &&
        modelFail?.model_attempt?.ok === false &&
        modelFail?.model_attempt?.code === 'call_failed' &&
        (modelFail?.model_attempt?.detail ?? '').includes('simulated transport failure') &&
        modelFail?.model_call === undefined,
      `annotation ${JSON.stringify(modelFail)}`,
    );
    const status6 = (await (await fetch(`${base4}/hub/status`)).json()) as {
      dispatcher?: {
        modelPath?: { flag?: string; wired?: boolean };
        projects?: Record<
          string,
          {
            watermark?: number;
            annotated?: number;
            byRoutedBy?: { rules?: number; model?: number };
          }
        >;
      };
    };
    const demo6 = status6.dispatcher?.projects?.['hub-demo'];
    check(
      '/hub/status with the flag on: modelPath reports flag "on" + wired true; counts show 7 annotations (6 rules + 1 model), watermark at the log end',
      status6.dispatcher?.modelPath?.flag === 'on' &&
        status6.dispatcher?.modelPath?.wired === true &&
        demo6?.annotated === 7 &&
        demo6?.byRoutedBy?.rules === 6 &&
        demo6?.byRoutedBy?.model === 1 &&
        demo6?.watermark === maxSeq4 + 2,
      `dispatcher ${JSON.stringify(status6.dispatcher)}`,
    );
    const login4 = await fetch(`${base4}/hub/login`, { method: 'POST', redirect: 'manual' });
    const cookie4Pair = (login4.headers.get('set-cookie') ?? '').split(';')[0];
    await login4.arrayBuffer();
    const card4Res = await fetch(`${base4}/hub/receipts?view=page`, {
      headers: { cookie: cookie4Pair },
    });
    const card4 = await card4Res.text();
    check(
      'honest-limits card flips truthfully on the wired boot: the model line reads wired with flag "on" (and no longer NOT wired), and the pull-only line names the wake (human prompt or polling heartbeat)',
      card4Res.status === 200 &&
        card4.includes('model path is wired') &&
        !card4.includes('model path is NOT wired') &&
        card4.includes('"on"') &&
        card4.includes('polling heartbeat') &&
        card4.includes('human prompting the agent'),
      `login ${login4.status}, page ${card4Res.status}`,
    );
  } finally {
    await hub4.close();
    dispatcher.setModelTransport(null);
    delete process.env.HUB_DISPATCHER_MODEL;
  }
} finally {
  await hub.close();
  rmSync(stateDir, { recursive: true, force: true });
}
check('clean shutdown completed', true);

if (failures > 0) {
  console.log(`SMOKE FAILED — ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('SMOKE PASSED — embedded Together API wired through the in-process seam; Key Desk identity live; reads are API-backed and non-recording; dispatcher rules path annotates with provenance and persists across restart; approval gate releases/refuses needs-owner handoffs from the Key Desk and its decisions persist; receipts view renders the timeline with the canonical sha256 verified against an independent hash, honest-limits card live-state-checked; the desk always issues its default scope set when scopes are left blank, proven end-to-end (a blank-scopes credential holds help:write in stored state and posts /help)');
}
