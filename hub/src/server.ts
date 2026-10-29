// Together Hub — service (build step 3, Oct 26, 2026).
//
// One process, two loopback listeners (the start-local shape, audit
// row 2):
//   - the embedded Together API on its own port (default 8937), started
//     and owned by ./transport.ts — agent-facing HTTP for the stock
//     CLI/MCP adapters, and the Hub's internal reads go through its
//     in-process api.fetch seam;
//   - this dashboard server on HUB_PORT (default 8940), serving the
//     dashboard at / and Hub-owned JSON under /hub/*.
//
// The dashboard port deliberately does NOT serve /api/v1/*: that
// namespace belongs to the embedded Together API on its own port. Hub
// status lives at /hub/status (spike verdict, wiring instruction 2).
//
// Build step 3 adds the Key Desk (audit row 5): /hub/login performs
// Together's own session exchange server-side (the start-local
// middleware pattern — the owner token never reaches the browser), and
// /hub/keydesk* pages/actions require that live owner session. Queue
// and receipts gained detail reads (/hub/queue/:project/:id,
// /hub/receipts/:project/:seq). All dashboard reads are non-recording
// (see transport.ts readQueue): refreshing this page never marks mail
// delivered or expired — recording happens only on an addressed
// reader's own explicit inbox GET against the API.
// Build step 6 adds the dispatcher (src/dispatcher.ts): its loop runs
// with this server's lifecycle, /hub/status carries its state, and
// queue index/detail responses carry each handoff's routing annotation
// (or an explicit "pending" state) — merged here at the HTTP layer so
// transport's read projections stay pure.
// Build step 7 adds the approval gate: the Key Desk lists needs-owner
// handoffs (GET /hub/keydesk/gate, and a section on the desk page) and
// the owner releases or refuses one with POST
// /hub/keydesk/gate/:projectId/:messageId — an owner-session action
// that amends only the dispatcher's Hub-side annotation.
// Build step 8 adds the receipts VIEW: GET /hub/receipts?view=page (or
// an Accept: text/html request) renders one project's full event
// stream as a readable timeline, owner-session gated, with the
// stream's canonical sha256 on its face (transport.ts
// canonicalReceiptsHash — the same construction the handoff probe
// hashes with) and an HONEST-LIMITS CARD whose changeable lines are
// read from live state at render time. The raw JSON surface at
// /hub/receipts is unchanged; the view is additive.
//
// Run: npm start   (or: node src/server.ts)
// Env: HUB_PORT (default 8940), HUB_API_PORT (default 8937),
//      HUB_STATE_DIR (default ./.state), HUB_OWNER_TOKEN (optional).

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {handleWorkPage, workSignIn, workReturn} from './workpage.ts';
import {
  HUB_CAPS,
  SESSION_COOKIE_NAME,
  endOwnerSession,
  getTransportStatus,
  hostedProjectIds,
  loginOwnerSession,
  ownerSessionPrincipal,
  readProjectReceipts,
  readProjects,
  readQueue,
  readQueueDetail,
  readReceiptDetail,
  readReceipts,
  startTransport,
  stopTransport,
} from './transport.ts';
import type { ProjectSummary, QueuePage, ReceiptsPage } from './transport.ts';
import {
  issueInvitation,
  readGateList,
  readKeyDeskState,
  revokeCredential,
} from './keydesk.ts';
import type { KeyDeskProject } from './keydesk.ts';
import {
  GateActionError,
  getAnnotation,
  getDispatcherStatus,
  refuseGate,
  releaseGate,
  startDispatcher,
  stopDispatcher,
} from './dispatcher.ts';

const HOST = '127.0.0.1';
const POLL_SECONDS = 5;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// Browser session plumbing (Key Desk gate)
// ---------------------------------------------------------------------------

function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  const raw = req.headers.cookie;
  if (raw === undefined) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function sessionToken(req: IncomingMessage): string | null {
  return parseCookies(req).get(SESSION_COOKIE_NAME) ?? null;
}

type SessionPrincipal = NonNullable<Awaited<ReturnType<typeof ownerSessionPrincipal>>>;

/** Live validation against Together's session store, every request. */
async function requireOwnerSession(req: IncomingMessage): Promise<SessionPrincipal | null> {
  const token = sessionToken(req);
  if (token === null) return null;
  return ownerSessionPrincipal(token);
}

/**
 * Hub-side write gate mirroring Together's assertWriteOrigin stance:
 * cross-site posts are refused, and a present Origin must be this
 * dashboard's own origin.
 */
function assertHubWriteOrigin(req: IncomingMessage): void {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') {
    throw new HubHttpError(403, 'origin_denied', 'cross-site requests are not accepted');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host ?? ''}`) {
    throw new HubHttpError(403, 'origin_denied', `origin ${origin} is not this dashboard`);
  }
}

class HubHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if(bytes > maxBytes) throw new HubHttpError(413, 'body_too_large', 'Request body is too large'); chunks.push(chunk as Buffer); }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HubHttpError(422, 'invalid_body', 'JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
  }
  // Browser forms post urlencoded; normalize everything to strings.
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  return out;
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('application/json');
}

function field(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

interface DashboardData {
  queue: QueuePage | null;
  receipts: ReceiptsPage | null;
  projects: ProjectSummary[];
  readsError: string | null;
}

async function loadDashboardData(): Promise<DashboardData> {
  try {
    const [queue, receipts, projects] = await Promise.all([
      readQueue(),
      readReceipts(),
      readProjects(),
    ]);
    return { queue, receipts, projects, readsError: null };
  } catch (err) {
    return {
      queue: null,
      receipts: null,
      projects: [],
      readsError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dashboardHtml(req: IncomingMessage): Promise<string> {
  const transport = getTransportStatus();
  const data = await loadDashboardData();
  const session = await requireOwnerSession(req);
  const wiredLine = transport.wired
    ? `<strong>Transport: WIRED</strong> — embedded Together API, in-process
       seam. Boot self-check: ${esc(transport.selfCheck.detail)}`
    : `<strong>Transport: NOT WIRED</strong> — ${esc(transport.error ?? transport.selfCheck.detail)}`;
  const queueItems = data.queue?.items ?? [];
  const receiptItems = data.receipts?.items ?? [];
  const queueList = queueItems
    .slice(0, 10)
    .map(
      (m) =>
        `<li>${esc(m.id)} · ${esc(m.type)} · ${esc(m.senderId)} → ${esc(m.recipientId)} · ${esc(m.delivery)} · ${esc(m.createdAt)}</li>`,
    )
    .join('\n');
  const receiptList = receiptItems
    .slice(-10)
    .map(
      (e) =>
        `<li>${esc(e.projectId)}#${esc(e.seq)} · ${esc(e.type)} · ${esc(e.actorId)} · ${esc(e.createdAt)}</li>`,
    )
    .join('\n');
  const keyDeskLine = session
    ? `signed in as ${esc(session.id)} — <a href="/hub/keydesk">open the Key Desk</a>`
    : `<a href="/hub/login">sign in</a> to manage agent credentials at the Key Desk`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${POLL_SECONDS}">
<title>Together Hub — Oct 26</title>
</head>
<body>
<h1>Together Hub — Oct 26</h1>
<p><a href="/hub/work">Open the workroom — ask for help and follow the answer</a></p>
<p>${wiredLine}</p>
<p>Embedded Together API (agent-facing HTTP): http://127.0.0.1:${esc(transport.apiPort ?? '—')}/
· hosted project(s): ${data.projects.map((p) => esc(p.id)).join(', ') || '—'}
· state dir: ${esc(transport.stateDir)}</p>
<p>This page auto-refreshes every ${POLL_SECONDS} seconds; what you see is
the queue as of the last refresh. Together is pull-only: agents see work
when they call and read — the Hub never wakes an agent; the wake is a
human prompt or the agent's own polling heartbeat, both outside the Hub.
Refreshing this
page records nothing: delivery is marked only when the addressed reader
makes its own inbox read against the API.</p>
<p>Key Desk: ${keyDeskLine}</p>
${data.readsError ? `<p><strong>Read error:</strong> ${esc(data.readsError)}</p>` : ''}

<h2>Queue</h2>
<p>${queueItems.length === 0
    ? 'No handoffs queued. (A real read against the embedded Together API — the queue is genuinely empty.)'
    : `${queueItems.length} handoff(s) in the inbox page.`}</p>
${queueList ? `<ul>\n${queueList}\n</ul>` : ''}

<h2>Receipts</h2>
<p>${receiptItems.length === 0
    ? 'No events recorded yet. (A real read of the project event logs — a receipt exists only when work actually happens.)'
    : `${receiptItems.length} event(s) in the project logs.`}</p>
${receiptList ? `<ul>\n${receiptList}\n</ul>` : ''}
</body>
</html>
`;
}

async function hubStatus(res: ServerResponse): Promise<void> {
  const transport = getTransportStatus();
  const data = await loadDashboardData();
  json(res, 200, {
    service: 'together-hub',
    date: '2026-10-26',
    transport,
    caps: HUB_CAPS,
    dispatcher: getDispatcherStatus(),
    projects: data.projects,
    queue: { items: data.queue === null ? null : data.queue.items.length },
    receipts: { items: data.receipts === null ? null : data.receipts.items.length },
    ...(data.readsError !== null ? { readsError: data.readsError } : {}),
  });
}

/**
 * Routing state for one queue row (build step 6). The annotation is a
 * Hub-side dispatcher record (src/dispatcher.ts); Together's own
 * records are never rewritten. Absence is shown, never backfilled: a
 * handoff the dispatcher has not processed yet reports
 * { state: 'pending' }.
 */
function routingForDetail(projectId: string, messageId: string): Record<string, unknown> {
  const annotation = getAnnotation(projectId, messageId);
  return annotation === null ? { state: 'pending' } : { ...annotation };
}

/** Compact routing for index rows (the full record lives on detail). */
function routingForIndexItem(projectId: string, messageId: string): Record<string, unknown> {
  const annotation = getAnnotation(projectId, messageId);
  if (annotation === null) return { state: 'pending' };
  return {
    routed_by: annotation.routed_by,
    decision: annotation.decision,
    // The gate marker rides along when the owner has decided
    // (build step 7): released rows read as deliver WITH the gate
    // record beside the decision; refused rows carry it as their
    // displayed state.
    ...(annotation.gate !== undefined ? { gate: annotation.gate } : {}),
  };
}

// ---------------------------------------------------------------------------
// Receipts view + honest-limits card (build step 8)
// ---------------------------------------------------------------------------

const RESTATE_MAX = 200;

/**
 * A one-line restatement of one event, built ONLY from the event's own
 * fields: its entity/collection, the primitive values in its detail
 * payload, and its result/next-actor fields when present. No prose is
 * invented — this is a mechanical projection of the record, truncated
 * at a declared cap. Detail keys that name token/secret material are
 * never rendered (events carry none by construction; this is a belt
 * on top of that suspenders).
 */
function eventRestatement(event: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof event.entityId === 'string') bits.push(`entity ${event.entityId}`);
  if (typeof event.collection === 'string') bits.push(`collection ${event.collection}`);
  const detail = event.detail;
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
      if (/token|secret/i.test(key)) continue;
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        bits.push(`${key} ${String(value)}`);
      }
    }
  }
  if (typeof event.result === 'string') bits.push(`result ${event.result}`);
  if (typeof event.nextActorId === 'string') bits.push(`next actor ${event.nextActorId}`);
  if (typeof event.nextAction === 'string') bits.push(`next action ${event.nextAction}`);
  if (typeof event.humanCategory === 'string') bits.push(`human category ${event.humanCategory}`);
  const line = bits.join(' · ');
  if (line === '') return 'no further fields on the record';
  return line.length > RESTATE_MAX ? `${line.slice(0, RESTATE_MAX - 1)}…` : line;
}

/**
 * The honest-limits card: what the Hub does NOT do or prove. Every
 * line is true of the current build; lines whose fact can change are
 * composed from live state at render time (transport status +
 * dispatcher status, the same values /hub/status prints) — never
 * hardcoded where the state can speak for itself.
 */
function honestLimitsHtml(): string {
  const transport = getTransportStatus();
  const dispatcher = getDispatcherStatus();
  const modelWired: boolean = dispatcher.modelPath.wired;
  const modelLine = modelWired
    ? `The dispatcher's model path is wired (live from /hub/status: flag
       "${esc(dispatcher.modelPath.flag)}"). Model-produced routing and summaries
       are labeled routed_by "model" on their records, beside the rules path's
       "rules" — the label travels with the record either way.`
    : `The dispatcher's model path is NOT wired (live from /hub/status: flag
       "${esc(dispatcher.modelPath.flag)}", wired: false). Every routing decision
       and summary so far comes from the deterministic rules path and is labeled
       routed_by "rules" on its record; summaries are template restatements of
       the handoff record's own fields, not model prose. This line flips the
       day the model path lands — it is read from live state, not written here.`;
  return `<h2 id="limits">Honest limits — what this Hub does not do</h2>
<ul>
<li><strong>Pull-only — the wake lives outside the Hub.</strong> Nothing in
the Hub wakes an agent — Together is pull-only, and agents see work only
when they call and read. What prompts that call is not a Hub mechanism and
is named here so it is never mistaken for one: in practice the wake is a
human prompting the agent, or a polling heartbeat on the agent's own side.
The Hub neither sends nor schedules it — a handoff can sit queued,
correctly routed and receipted, until its reader is woken by one of those.
Hub pages show state as of their last load or refresh, and reading them
records nothing: delivery is marked only when the addressed reader makes
its own inbox read against the API.</li>
<li><strong>Refusals are not recorded per attempt.</strong> Neither Together nor
the Hub keeps a log of refused calls — a refusal is a status code at call time
and leaves no record. The Key Desk shows each agent's standing refusal state
(a revoked or expired credential refuses every call) and marks per-attempt
refusals "not recorded".</li>
<li><strong>Dispatcher model path.</strong> ${modelLine}</li>
<li><strong>Loopback-only, single host, single process.</strong> The dashboard
and the embedded Together API bind 127.0.0.1 only (API port
${esc(transport.apiPort ?? '—')}); all state is local files under
${esc(transport.stateDir)}. This is not a hosted or multi-machine service.</li>
<li><strong>Annotations are Hub-side records.</strong> Dispatcher routing
decisions, summaries, and approval-gate release/refusal records live in the
Hub's own store (${esc(transport.stateDir)}/hub/dispatcher.json). They annotate
Together's handoffs; they never edit Together's own message or event records —
the timeline above is Together's record exactly as written.</li>
<li><strong>The hash covers this stream only.</strong> The sha256 above is over
the canonical JSON of the events listed on this page, in seq order — the same
construction the cross-family handoff probe hashes with. It shows this page's
stream is whole and untampered as displayed; it says nothing about any other
project or any state off this page.</li>
</ul>`;
}

async function receiptsViewPage(
  res: ServerResponse,
  session: SessionPrincipal,
  requestedProject: string | null,
): Promise<void> {
  const hosted = hostedProjectIds();
  const projectId = requestedProject ?? hosted[0];
  if (projectId === undefined || !hosted.includes(projectId)) {
    html(res, 404, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Together Hub — Receipts</title></head>
<body>
<h1>Receipts</h1>
<p>No hosted project named ${esc(requestedProject ?? '(none)')}. Hosted
project(s): ${hosted.map((id) => esc(id)).join(', ') || 'none'}.</p>
<p><a href="/hub/keydesk">Back to the Key Desk</a></p>
</body>
</html>
`);
    return;
  }
  const stream = await readProjectReceipts(projectId);
  if (stream === null) {
    html(res, 404, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Together Hub — Receipts</title></head>
<body>
<h1>Receipts</h1>
<p>Project ${esc(projectId)} is not hosted by this Hub.</p>
<p><a href="/hub/keydesk">Back to the Key Desk</a></p>
</body>
</html>
`);
    return;
  }
  const switcher = hosted
    .map((id) =>
      id === projectId
        ? `<strong>${esc(id)}</strong>`
        : `<a href="/hub/receipts?view=page&amp;project=${encodeURIComponent(id)}">${esc(id)}</a>`,
    )
    .join(' · ');
  const rows = stream.events
    .map(
      (e) => `<li>
<p>#${esc(e.seq)} · ${esc(e.type)} · ${esc(e.actorId)}${typeof e.actorKind === 'string' ? ` (${esc(e.actorKind)})` : ''} · ${esc(e.createdAt)}</p>
<p>${esc(eventRestatement(e))}</p>
</li>`,
    )
    .join('\n');
  html(res, 200, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Together Hub — Receipts · ${esc(projectId)}</title></head>
<body>
<h1>Receipts — ${esc(projectId)}</h1>
<p>Signed in as ${esc(session.id)} (owner session, validated live against
Together's session store). Project: ${switcher}</p>
<p>The project's event log as Together recorded it, read through the Hub's
non-recording projection — opening this page marks nothing delivered and
changes nothing. <span id="receipts-count">${esc(stream.count)}</span>
event(s) · latest seq ${esc(stream.latestSeq)}.</p>
<p>Stream sha256: <code id="receipts-sha256">${esc(stream.sha256)}</code><br>
Sha256 over the canonical JSON of exactly the events listed below, in seq
order — the same construction the cross-family handoff probe hashes with.
If an event were added, dropped, or altered, this number would change.</p>
${stream.count === 0 ? '<p>No events recorded yet — a receipt exists only when work actually happens.</p>' : `<ol>\n${rows}\n</ol>`}

${honestLimitsHtml()}
<p><a href="/hub/keydesk">Key Desk</a> · <a href="/">Dashboard</a></p>
</body>
</html>
`);
}

// ---------------------------------------------------------------------------
// Key Desk pages
// ---------------------------------------------------------------------------

function loginPage(res: ServerResponse, status = 200, note = ''): void {
  html(res, status, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Together Hub — Key Desk sign-in</title></head>
<body>
<h1>Key Desk sign-in</h1>
<p>The Key Desk manages agent credentials for this Hub. Signing in runs
Together's own session exchange on this server — your browser receives
an HttpOnly session cookie; no token is ever typed into or stored by
this page.</p>
${note ? `<p><strong>${esc(note)}</strong></p>` : ''}
<form method="post" action="/hub/login"><button type="submit">Sign in as the owner</button></form>
<p><a href="/">Back to the dashboard</a></p>
</body>
</html>
`);
}

function keyDeskAgentHtml(project: KeyDeskProject, agent: KeyDeskProject['agents'][number]): string {
  const credRows = agent.credentials
    .map(
      (c) => `<li>credential <code>${esc(c.id)}</code> · ${esc(c.status)} · scopes: ${esc(c.scopes.join(', ') || '—')}
      · projects: ${esc(c.projectIds.join(', '))} · expires: ${esc(c.expiresAt ?? 'no expiry set')} · issued ${esc(c.createdAt)}
      ${c.status === 'active'
        ? `<form method="post" action="/hub/keydesk/revoke" style="display:inline">
             <input type="hidden" name="projectId" value="${esc(project.projectId)}">
             <input type="hidden" name="credentialId" value="${esc(c.id)}">
             <button type="submit">Revoke</button></form>`
        : ''}</li>`,
    )
    .join('\n');
  const invRows = agent.invitations
    .map(
      (i) => `<li>invitation <code>${esc(i.id)}</code> · ${esc(i.status)} · scopes: ${esc(i.scopes.join(', ') || '—')}
      · invite expires ${esc(i.expiresAt)} · credential expiry: ${esc(i.credentialExpiresAt ?? 'no expiry set')}</li>`,
    )
    .join('\n');
  const sessionRows = agent.sessions
    .map(
      (s) => `<li>session <code>${esc(s.id)}</code> · ${esc(s.status)} · ${esc([s.adapter, s.provider, s.model, s.host].filter(Boolean).join(' · ') || 'no adapter details')}
      · last activity ${esc(s.lastActivityAt ?? 'not recorded')}</li>`,
    )
    .join('\n');
  const lastSuccess = agent.lastSuccess
    ? `${esc(agent.lastSuccess.type)} at ${esc(agent.lastSuccess.at)} (event #${esc(agent.lastSuccess.seq)})`
    : 'not recorded';
  const refusal = agent.standingRefusal
    ? `standing refusal: ${esc(agent.standingRefusal.reason)} since ${esc(agent.standingRefusal.since)} — every call with this credential is refused`
    : `last refusal: ${esc(agent.lastRefusal.note)}`;
  return `<h3>${esc(agent.identity.displayName)}${agent.identity.isOwnerIdentity ? ' (the owner)' : ''}</h3>
<p>identity <code>${esc(agent.identity.id)}</code> · status ${esc(agent.identity.status)}
· created ${esc(agent.identity.createdAt)} via ${esc(agent.identity.creationSource)}</p>
<p>Last recorded action (the event log records actions, not reads): ${lastSuccess}<br>${refusal}</p>
${sessionRows ? `<p>Sessions:</p><ul>\n${sessionRows}\n</ul>` : '<p>Sessions: none recorded.</p>'}
${invRows ? `<p>Invitations:</p><ul>\n${invRows}\n</ul>` : ''}
${credRows ? `<p>Credentials:</p><ul>\n${credRows}\n</ul>` : '<p>Credentials: none issued.</p>'}`;
}

async function keyDeskPage(res: ServerResponse, session: SessionPrincipal): Promise<void> {
  const state = await readKeyDeskState();
  const gate = await readGateList();
  const projectOptions = hostedProjectIds()
    .map((id) => `<option value="${esc(id)}">${esc(id)}</option>`)
    .join('');
  // The approval gate (build step 7): needs-owner handoffs waiting on
  // the owner's one decision. Release names the identity to route to
  // (the desk blocks a release into a revoked/expired credential —
  // dispatcher.ts releaseGate); refuse closes the handoff at the
  // desk. Both are recorded on the Hub-side annotation only.
  const gateSections = gate.projects
    .filter((project) => project.awaiting.length > 0)
    .map((project) => {
      const agents = state.projects.find((p) => p.projectId === project.projectId)?.agents ?? [];
      const targetOptions = agents
        .map(
          (a) =>
            `<option value="${esc(a.identity.id)}">${esc(a.identity.displayName)} (${esc(a.identity.id)})</option>`,
        )
        .join('');
      const items = project.awaiting
        .map((item) => {
          const action = `/hub/keydesk/gate/${encodeURIComponent(project.projectId)}/${encodeURIComponent(item.messageId)}`;
          return `<li>
<p><code>${esc(item.messageId)}</code> · from ${esc(item.sender ?? 'unknown sender')} · dispatcher decided ${esc(item.decidedAt)} (routed_by ${esc(item.routed_by)})</p>
<p>${esc(item.summary)}</p>
<p>Dispatcher reason: ${esc(item.reason)}</p>
<form method="post" action="${action}" style="display:inline">
<input type="hidden" name="action" value="release">
<label>Release to <select name="to">${targetOptions}</select></label>
<button type="submit">Release</button></form>
<form method="post" action="${action}" style="display:inline">
<input type="hidden" name="action" value="refuse">
<label>Refusal note (optional) <input name="note" size="36"></label>
<button type="submit">Refuse</button></form>
</li>`;
        })
        .join('\n');
      return `<h3>Project ${esc(project.projectId)} — ${project.awaiting.length} waiting</h3>\n<ul>\n${items}\n</ul>`;
    })
    .join('\n');
  const gateHtml =
    `<h2>Approval gate</h2>\n` +
    (gateSections === ''
      ? '<p>Nothing is waiting at the gate — no handoff is in needs-owner awaiting a decision.</p>'
      : `<p>These handoffs crossed the dispatcher's consequence line and wait for your decision. A release or refusal is recorded on the Hub's dispatcher annotation; Together's own message record is never edited.</p>\n${gateSections}`);
  const sections = state.projects
    .map(
      (project) => `<h2>Project ${esc(project.projectId)}</h2>\n` +
        project.agents.map((agent) => keyDeskAgentHtml(project, agent)).join('\n'),
    )
    .join('\n');
  html(res, 200, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Together Hub — Key Desk</title></head>
<body>
<h1>Key Desk</h1>
<p><a href="/hub/work">Open the workroom — requests and answers</a></p>
<p>Signed in as ${esc(session.id)} (owner session, validated live against
Together's session store). Access state only — this desk never scores or
ranks agents.</p>
<form method="post" action="/hub/logout"><button type="submit">Sign out</button></form>
<p><a href="/hub/receipts?view=page">Receipts timeline + honest-limits card</a>
— each project's event log as a readable timeline with its sha256 on its
face, and the card that states plainly what the Hub does not do.</p>

<h2>Issue an invitation</h2>
<p>An invitation is single-use and expiring; the agent exchanges it for
its own revocable credential. The token is shown ONCE, on the result
page — hand it to the agent and it is gone.</p>
<form method="post" action="/hub/keydesk/invite">
<p><label>Project <select name="projectId">${projectOptions}</select></label></p>
<p><label>New agent display name <input name="displayName" size="32"></label>
(or existing identity id <label><input name="identityId" size="36"></label>)</p>
<p><label>Scopes (comma-separated) <input name="scopes" size="48" value="read, help:write"></label><br>
The desk default — <code>read, help:write</code> — is prefilled. If you clear
the field, the invitation is still issued with exactly that default:
Together's own built-in defaults do not include <code>help:write</code>,
which an agent needs to post handoffs.</p>
<p><label>Invitation lifetime, minutes (blank = 15) <input name="inviteTtlMinutes" size="6"></label>
<label>Credential lifetime, days (blank = Hub default, 30 days; max 30) <input name="credentialTtlDays" size="6"></label></p>
<p><button type="submit">Issue invitation</button></p>
</form>

${gateHtml}

${sections}
<p><a href="/">Back to the dashboard</a></p>
</body>
</html>
`);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/hub/work' || url.pathname === '/hub/work/request') {
    const session = await requireOwnerSession(req);
    if(session === null){ html(res,401,workSignIn(workReturn(req.url) ?? '/hub/work')); return; }
    if(req.method === 'POST') assertHubWriteOrigin(req);
    const body = req.method === 'POST' ? await readBody(req,196608) : undefined;
    await handleWorkPage(req,res,session,sessionToken(req)!,body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await dashboardHtml(req));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/hub/status') {
    await hubStatus(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/hub/first-use') {
    // The newcomer's walkthrough (FIRST-USE.md beside this package's
    // README), served on the dashboard port so the invitation result
    // page can link straight to it: exchange -> handoff -> read ->
    // receipt, curl only. Read per request so the served text is
    // always the file on disk.
    try {
      const guide = readFileSync(new URL('../FIRST-USE.md', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(guide);
    } catch {
      json(res, 404, { error: 'not_found', path: url.pathname, hint: 'FIRST-USE.md is missing from this Hub package.' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/hub/queue') {
    try {
      const page = await readQueue(url.searchParams.get('after') ?? undefined);
      json(res, 200, {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          routing: routingForIndexItem(String(item.projectId ?? ''), String(item.id ?? '')),
        })),
      });
    } catch (err) {
      json(res, 503, {
        error: 'queue_read_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (
    req.method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'hub' &&
    parts[1] === 'queue'
  ) {
    try {
      const projectId = decodeURIComponent(parts[2]);
      const messageId = decodeURIComponent(parts[3]);
      const detail = await readQueueDetail(projectId, messageId);
      if (detail === null) {
        json(res, 404, { error: 'not_found', detail: 'no such handoff in that project' });
      } else {
        json(res, 200, { ...detail, routing: routingForDetail(projectId, messageId) });
      }
    } catch (err) {
      json(res, 503, {
        error: 'queue_detail_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/hub/receipts') {
    // Build step 8: the human receipts VIEW (?view=page, or a browser's
    // Accept: text/html) is owner-session gated like the other desk
    // surfaces. The raw JSON surface below is unchanged — the probes
    // and the dashboard depend on it exactly as it was.
    const accept = req.headers.accept ?? '';
    const wantsPage =
      url.searchParams.get('view') === 'page' ||
      (accept.includes('text/html') && !accept.includes('application/json'));
    if (wantsPage) {
      const session = await requireOwnerSession(req);
      if (session === null) {
        if (wantsJson(req)) {
          json(res, 401, { error: 'unauthenticated', detail: 'owner session required' });
        } else {
          loginPage(res, 401, 'Sign in to open the receipts view.');
        }
        return;
      }
      try {
        await receiptsViewPage(res, session, url.searchParams.get('project'));
      } catch (err) {
        json(res, 503, {
          error: 'receipts_view_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    try {
      json(res, 200, await readReceipts());
    } catch (err) {
      json(res, 503, {
        error: 'receipts_read_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (
    req.method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'hub' &&
    parts[1] === 'receipts'
  ) {
    try {
      const detail = await readReceiptDetail(
        decodeURIComponent(parts[2]),
        Number(parts[3]),
      );
      if (detail === null) {
        json(res, 404, { error: 'not_found', detail: 'no event with that seq in that project' });
      } else {
        json(res, 200, detail);
      }
    } catch (err) {
      json(res, 503, {
        error: 'receipt_detail_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // -- Key Desk: login / logout ------------------------------------------
  if (req.method === 'GET' && url.pathname === '/hub/login') {
    if ((await requireOwnerSession(req)) !== null) {
      redirect(res, workReturn(url.searchParams.get('next')) ?? '/hub/keydesk');
    } else {
      loginPage(res);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hub/login') {
    assertHubWriteOrigin(req);
    try {
      const { token } = await loginOwnerSession();
      // The API issues this cookie with Path=/api on its own origin; the
      // desk re-scopes it to Path=/ so the browser returns it to the
      // Hub's pages. The token VALUE is Together's session token, and
      // every Key Desk request is validated live against Together's
      // session store — the Hub keeps no session state of its own.
      res.writeHead(303, {
        location: workReturn(url.searchParams.get('next')) ?? '/hub/keydesk',
        'set-cookie':
          `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
    } catch {
      loginPage(res, 401, 'Sign-in failed — the embedded API refused the exchange.');
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hub/logout') {
    assertHubWriteOrigin(req);
    const token = sessionToken(req);
    if (token !== null) await endOwnerSession(token);
    res.writeHead(303, {
      location: '/',
      'set-cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
    res.end();
    return;
  }

  // -- Key Desk: pages + actions (owner session required) ----------------
  if (url.pathname === '/hub/keydesk' || url.pathname.startsWith('/hub/keydesk')) {
    const session = await requireOwnerSession(req);
    if (session === null) {
      if (wantsJson(req)) {
        json(res, 401, { error: 'unauthenticated', detail: 'owner session required' });
      } else {
        loginPage(res, 401, 'Sign in to open the Key Desk.');
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/hub/keydesk') {
      await keyDeskPage(res, session);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/hub/keydesk.json') {
      json(res, 200, await readKeyDeskState());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/hub/keydesk/gate') {
      json(res, 200, await readGateList());
      return;
    }
    if (
      req.method === 'POST' &&
      parts.length === 5 &&
      parts[0] === 'hub' &&
      parts[1] === 'keydesk' &&
      parts[2] === 'gate'
    ) {
      // The approval gate (build step 7): one owner decision on one
      // needs-owner handoff. The decision amends the dispatcher's
      // Hub-side annotation (dispatcher.ts) — Together's records are
      // never touched by a gate action.
      assertHubWriteOrigin(req);
      const body = await readBody(req);
      const projectId = decodeURIComponent(parts[3]);
      const messageId = decodeURIComponent(parts[4]);
      const action = field(body, 'action');
      try {
        let annotation;
        if (action === 'release') {
          const to = field(body, 'to');
          if (to === undefined) {
            throw new HubHttpError(
              422,
              'missing_field',
              'a release requires "to": the enrolled identity to route the handoff to',
            );
          }
          annotation = await releaseGate(projectId, messageId, to);
        } else if (action === 'refuse') {
          annotation = refuseGate(projectId, messageId, field(body, 'note'));
        } else {
          throw new HubHttpError(
            422,
            'invalid_action',
            'action must be "release" or "refuse"',
          );
        }
        if (wantsJson(req)) {
          json(res, 200, { ok: true, annotation });
        } else {
          redirect(res, '/hub/keydesk');
        }
      } catch (err) {
        if (err instanceof GateActionError) {
          if (wantsJson(req)) {
            json(res, err.status, { error: err.code, detail: err.message });
          } else {
            html(res, err.status, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Gate action refused</title></head>
<body>
<h1>Gate action refused</h1>
<p>${esc(err.message)}</p>
<p><a href="/hub/keydesk">Back to the Key Desk</a></p>
</body>
</html>
`);
          }
          return;
        }
        throw err;
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/hub/keydesk/invite') {
      assertHubWriteOrigin(req);
      const body = await readBody(req);
      const projectId = field(body, 'projectId');
      if (projectId === undefined) {
        throw new HubHttpError(422, 'missing_field', 'projectId is required');
      }
      const scopesText = field(body, 'scopes');
      const parsedScopes = Array.isArray(body.scopes)
        ? (body.scopes as unknown[]).map(String)
        : scopesText !== undefined
          ? scopesText.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      // Blank means ABSENT or EMPTY (a cleared form field, an empty
      // JSON list): the desk then sends its own default scope set
      // (HUB_DESK_DEFAULT_SCOPES in keydesk.ts) instead of omitting
      // the field and falling through to Together's defaults, which
      // lack help:write. A non-empty explicit list passes untouched.
      const scopes =
        parsedScopes !== undefined && parsedScopes.length > 0 ? parsedScopes : undefined;
      const ttlMinutes = field(body, 'inviteTtlMinutes');
      const ttlDays = field(body, 'credentialTtlDays');
      const result = await issueInvitation({
        projectId,
        displayName: field(body, 'displayName'),
        identityId: field(body, 'identityId'),
        scopes,
        inviteTtlMs:
          typeof body.inviteTtlMs === 'number'
            ? body.inviteTtlMs
            : ttlMinutes !== undefined
              ? Number(ttlMinutes) * 60_000
              : undefined,
        credentialExpiresAt:
          field(body, 'credentialExpiresAt') ??
          (ttlDays !== undefined
            ? new Date(Date.now() + Number(ttlDays) * 86_400_000).toISOString()
            : undefined),
      });
      if (wantsJson(req)) {
        json(res, 201, result);
      } else {
        html(res, 201, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Invitation issued</title></head>
<body>
<h1>Invitation issued</h1>
<p>For agent identity <code>${esc(result.identityId)}</code> in project
${esc(projectId)} · scopes: ${esc(result.scopes.join(', '))} · invitation
expires ${esc(result.expiresAt)} · the credential it mints expires
${esc(result.credentialExpiresAt ?? '—')} (the desk always sets a credential
expiry — Together treats the field as opt-in, and the Hub never omits it).</p>
<p><strong>Invitation token (shown once — it is never stored or shown
again):</strong></p>
<p><code>${esc(result.token)}</code></p>
<p>Hand this token to the agent; it exchanges the token for its own
credential. <a href="/hub/keydesk">Back to the Key Desk</a></p>
<p><strong>Next steps for the agent:</strong> the first-use
walkthrough — exchange this token, post or read a handoff, and check
the receipt — is at <a href="/hub/first-use">/hub/first-use</a>
(also <code>FIRST-USE.md</code> beside the Hub README in this
package). It needs nothing beyond the token, the project id above,
and curl.</p>
</body>
</html>
`);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/hub/keydesk/revoke') {
      assertHubWriteOrigin(req);
      const body = await readBody(req);
      const projectId = field(body, 'projectId');
      const credentialId = field(body, 'credentialId');
      if (projectId === undefined || credentialId === undefined) {
        throw new HubHttpError(422, 'missing_field', 'projectId and credentialId are required');
      }
      const result = await revokeCredential(projectId, credentialId);
      if (wantsJson(req)) {
        json(res, 200, { ok: true, ...result });
      } else {
        redirect(res, '/hub/keydesk');
      }
      return;
    }
  }

  json(res, 404, {
    error: 'not_found',
    path: url.pathname,
    hint: 'The embedded Together API owns /api/v1/* on its own port; Hub surfaces live at /, /hub/status, /hub/queue (+ /:project/:id), /hub/receipts (+ /:project/:seq, + ?view=page for the owner-gated timeline + honest-limits card), /hub/login, /hub/keydesk (+ /gate, /gate/:project/:message).',
  });
}

export function createHubServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HubHttpError) {
        json(res, err.status, { error: err.code, detail: err.message });
      } else {
        json(res, 500, {
          error: 'internal_error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}

export interface HubHandle {
  server: Server;
  /** Resolved dashboard port. */
  port: number;
  close: () => Promise<void>;
}

/**
 * Boot order: the embedded Together transport starts (and self-checks)
 * first, then the dispatcher loop starts on the transport's event logs,
 * then the dashboard listener opens — so the first dashboard read
 * already reports the true wired state. Shutdown reverses the order:
 * dispatcher first (no tick may race a closing transport), then the
 * dashboard, then the transport.
 */
export async function startHubServer(port: number): Promise<HubHandle> {
  await startTransport();
  startDispatcher();
  const server = createHubServer();
  const actual = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, HOST, () => {
      const address = server.address();
      resolvePromise(typeof address === 'object' && address ? address.port : port);
    });
  });
  const close = async (): Promise<void> => {
    stopDispatcher();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((done) => server.close(() => done()));
    }
    await stopTransport();
  };
  return { server, port: actual, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.HUB_PORT ?? '8940');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('HUB_PORT must be an integer 1..65535');
    process.exitCode = 1;
  } else {
    const hub = await startHubServer(port);
    const transport = getTransportStatus();
    console.log(`Together Hub: http://${HOST}:${hub.port}/`);
    console.log(
      `Embedded Together API: http://127.0.0.1:${transport.apiPort ?? '?'}/ ` +
        `(agent-facing HTTP; Hub reads use the in-process seam)`,
    );
    console.log(
      transport.wired
        ? `Transport wired — self-check: ${transport.selfCheck.detail}`
        : `Transport NOT wired — ${transport.error ?? transport.selfCheck.detail}`,
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void hub.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}
