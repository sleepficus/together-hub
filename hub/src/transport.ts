// Together transport wiring for the Hub — WIRED (build step 2, Oct 26).
//
// The seam, per the topology spike verdict
// (../hidden_files/spike-topology/VERDICT.md): the Hub process embeds the
// Together API in-process via startLocalServer from
// ../../together-candidate/cloud/local-server.ts, and every Hub-internal read
// goes through the returned handle's api.fetch (the apiFetch helper
// below) — no socket, no second listener carrying owner authority. The
// embedded server's own HTTP listener stays UP on the Together API port
// (127.0.0.1, default 8937) because agent-side stock CLI/MCP adapters are
// separate processes and can only speak HTTP (audit row 7).
//
// State: a Hub-owned state dir (default ./.state under hub/, override
// HUB_STATE_DIR). startLocalServer composes a JsonFileStore per project
// under it (audit row 1) — project state is JSON files, not SQLite;
// node:sqlite appears inside Together only for owner sessions and the
// conversation store. The Hub owner token is loaded from HUB_OWNER_TOKEN
// if set, else from <stateDir>/owner-token, else generated once and
// saved there (0600). It is held in server memory only and never printed.
//
// `wired: true` is reported ONLY after a boot self-check completes a real
// round trip through apiFetch (session exchange + one authenticated
// read). A failed start or self-check leaves wired:false with the failure
// in the status — never faked.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from '../../together-candidate/cloud/local-server.ts';
import type { LocalApi } from '../../together-candidate/cloud/local-server.ts';
import { publicMessage } from '../../together-candidate/lib/inbox.ts';
import type { Event, Message, Principal, ProjectState, Store } from '../../together-candidate/lib/types.ts';

const HUB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const OWNER_ID = 'hub-owner';
export const SEED_PROJECT_ID = 'hub-demo';
export const SEED_PROJECT_GOAL =
  'Together Hub demo project — cross-family handoffs through one shared, receipted queue';

/**
 * Declared Hub read caps (audit row 4): constants in one place, printed
 * in the status JSON. The embedded API additionally clamps every list to
 * its own PAGE_LIMIT (100); these Hub caps sit below it. Row 4's sizing
 * experiment may retune them from measurement.
 */
export const HUB_CAPS = {
  queuePageLimit: 50,
  receiptsPageLimit: 50,
  /**
   * Declared byte budgets (audit row 4: caps are declared, then verified
   * by measurement — scripts/probe-caps.ts at a 500-handoff seed, build
   * step 3). The item limits above are what the read paths enforce; the
   * budgets are the design bound the probe holds them to at demo-plus
   * scale with realistic record sizes.
   */
  indexByteBudget: 65536,
  detailByteBudget: 32768,
} as const;

export function hubStateDir(): string {
  const fromEnv = process.env.HUB_STATE_DIR;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(HUB_DIR, '.state');
}

function apiPortFromEnv(): number {
  const raw = process.env.HUB_API_PORT;
  if (raw === undefined || raw === '') return 8937; // Together's own API port
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8937;
}

function hubPortFromEnv(): number {
  const raw = process.env.HUB_PORT;
  if (raw === undefined || raw === '') return 8940; // the dashboard's own port (server.ts)
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8940;
}

/**
 * Fix #2's adoption requirement (Job 001 F7): the embedded Together API
 * pins cookie-authenticated writes to its own origin plus an explicit
 * allowedOrigins list, so the Hub dashboard's origin must be passed
 * through explicitly — the demo composition (candidate
 * scripts/start-local.mts) is the worked example, listing its UI origin
 * in both host spellings. The dashboard binds 127.0.0.1 on HUB_PORT
 * (default 8940, server.ts) and is reached as either 127.0.0.1 or
 * localhost, so exactly those two origins are wired — nothing else.
 * The API's own origin (HUB_API_PORT, default 8937) needs no entry:
 * assertWriteOrigin always allows the request URL's own origin, and
 * the API rebuilds request URLs as http://127.0.0.1:<port> — so the
 * self-origin covered is the 127.0.0.1 spelling (the localhost alias
 * of the API port would be refused; no browser page is served from
 * the API port in this topology, so nothing depends on it).
 */
export function dashboardAllowedOrigins(): string[] {
  const port = hubPortFromEnv();
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export interface TransportSelfCheck {
  ok: boolean;
  detail: string;
  at: string | null;
}

export interface TransportStatus {
  /** True only after the boot self-check's real apiFetch round trip. */
  wired: boolean;
  mode: 'down' | 'embedded';
  /** Resolved port of the embedded Together API's HTTP listener. */
  apiPort: number | null;
  stateDir: string;
  projectIds: string[];
  selfCheck: TransportSelfCheck;
  error: string | null;
}

interface LiveTransport {
  server: Server;
  api: LocalApi;
  apiPort: number;
  ownerToken: string;
}

let live: LiveTransport | null = null;
let status: TransportStatus = {
  wired: false,
  mode: 'down',
  apiPort: null,
  stateDir: hubStateDir(),
  projectIds: [],
  selfCheck: { ok: false, detail: 'transport not started yet', at: null },
  error: null,
};
let startPromise: Promise<TransportStatus> | null = null;

export function getTransportStatus(): TransportStatus {
  return {
    ...status,
    projectIds: [...status.projectIds],
    selfCheck: { ...status.selfCheck },
  };
}

function loadOwnerToken(dir: string): string {
  const fromEnv = process.env.HUB_OWNER_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const file = join(dir, 'owner-token');
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved !== '') return saved;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * The Hub's internal seam: dispatch a request to the embedded Together
 * API in-process. Hub-internal reads authenticate with the owner bearer
 * token held in server memory; a caller-supplied Authorization header is
 * respected as-is (the smoke's bad-credential check rides this).
 * `opts.auth: 'none'` suppresses the owner default — required for
 * session-cookie calls, where the API must resolve the cookie and NOT
 * the bearer (a bearer would authenticate even with a dead cookie).
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts: { auth?: 'owner' | 'none' } = {},
): Promise<Response> {
  if (live === null) {
    throw new Error('Together transport is not started; apiFetch called before startTransport');
  }
  const headers = new Headers(init.headers);
  if (!headers.has('authorization') && opts.auth !== 'none') {
    headers.set('authorization', `Bearer ${live.ownerToken}`);
  }
  // Base URL matches the in-repo collector precedent (VERDICT.md §1).
  return live.api.fetch(new Request(`http://127.0.0.1${path}`, { ...init, headers }));
}

// ---------------------------------------------------------------------------
// Owner browser session — the start-local middleware pattern (spike
// VERDICT.md §3): the Hub server performs Together's own session exchange
// (POST /api/v1/session) with the owner token it holds in memory, and
// brokers the resulting Together session token to the browser as an
// HttpOnly cookie. The owner token never reaches browser-visible code.
// Every later validation is a LIVE call back through the seam
// (GET /api/v1/session with the cookie): Together's LocalSessionStore
// (owner-sessions.sqlite in the state dir) stays the only session store —
// the Hub keeps no session state of its own. Logout revokes the session
// in Together's store via DELETE /api/v1/session.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = 'together_session';

export interface OwnerSessionInfo {
  ownerId: string;
  principal: string;
  expiresAt: string;
}

/** Perform the session exchange; returns the Together session token. */
export async function loginOwnerSession(): Promise<{ token: string; session: OwnerSessionInfo }> {
  const res = await apiFetch('/api/v1/session', { method: 'POST' });
  const body = (await res.json().catch(() => null)) as { session?: OwnerSessionInfo } | null;
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (res.status !== 201 || match === null || body?.session === undefined) {
    throw new Error(`owner session exchange failed: POST /api/v1/session -> ${res.status}`);
  }
  return { token: match[1], session: body.session };
}

/**
 * Resolve a browser-presented session token against Together's session
 * store (via the seam, cookie only — no bearer). Null when the session
 * is absent, expired, or revoked.
 */
export async function ownerSessionPrincipal(
  token: string,
): Promise<{ id: string; kind: string; scopes: string[]; projectIds: string[] } | null> {
  const res = await apiFetch(
    '/api/v1/session',
    { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } },
    { auth: 'none' },
  );
  if (res.status !== 200) {
    await res.arrayBuffer();
    return null;
  }
  const body = (await res.json()) as {
    principal?: { id: string; kind: string; scopes: string[]; projectIds: string[] };
  };
  return body.principal ?? null;
}

/** End the browser session in Together's store (revokes the token). */
export async function endOwnerSession(token: string): Promise<void> {
  const res = await apiFetch(
    '/api/v1/session',
    { method: 'DELETE', headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } },
    { auth: 'none' },
  );
  await res.arrayBuffer();
}

/**
 * The embedded API's own store seam for a hosted project (LocalApi
 * exposes storeFor deliberately as an in-process bootstrap seam). Used
 * ONLY for projections Together's HTTP surface has no route for —
 * credential/invitation state (lib/identity.ts: "Credentials and
 * invitations are never listed or returned") and pure read projections
 * (the event-log-anchored queue index). Reads return an isolated copy;
 * nothing here writes.
 */
export function projectStore(projectId: string): Store | undefined {
  if (live === null) {
    throw new Error('Together transport is not started; cannot read project store');
  }
  return live.api.storeFor(projectId);
}

export async function projectState(projectId: string): Promise<ProjectState> {
  const store = projectStore(projectId);
  if (store === undefined) throw new Error(`unknown hosted project: ${projectId}`);
  return store.read();
}

export function hostedProjectIds(): string[] {
  if (live === null) {
    throw new Error('Together transport is not started; cannot list projects');
  }
  return live.api.projectIds();
}

/** The owner principal as the embedded API itself resolves it. */
export function ownerPrincipal(projectIds: string[]): Principal {
  return {
    id: OWNER_ID,
    sessionId: `owner:${OWNER_ID}`,
    kind: 'human',
    ownerId: OWNER_ID,
    scopes: ['owner', 'admin', 'read'],
    projectIds,
  };
}

async function apiJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await apiFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Together API ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Boot self-check: session exchange + one authenticated read, via apiFetch. */
async function runSelfCheck(): Promise<TransportSelfCheck> {
  const at = new Date().toISOString();
  try {
    const login = await apiFetch('/api/v1/session', { method: 'POST' });
    const setCookie = login.headers.get('set-cookie') ?? '';
    await login.arrayBuffer();
    if (login.status !== 201 || !setCookie.includes('together_session=')) {
      return {
        ok: false,
        at,
        detail: `session exchange failed: POST /api/v1/session -> ${login.status}` +
          (setCookie.includes('together_session=') ? '' : ' (no session cookie issued)'),
      };
    }
    const read = await apiJson('/api/v1/projects');
    const projects = read.projects;
    const count = Array.isArray(projects) ? projects.length : 0;
    return {
      ok: true,
      at,
      detail:
        'session exchange POST /api/v1/session -> 201 (HttpOnly cookie issued); ' +
        `authenticated read GET /api/v1/projects -> 200 (${count} project(s) hosted)`,
    };
  } catch (err) {
    return {
      ok: false,
      at,
      detail: `self-check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Start the embedded Together server and run the boot self-check.
 * Idempotent: repeat calls return the same in-flight/settled promise.
 * A failed start or self-check resolves (does not throw) with the
 * failure recorded in the status, so the dashboard can surface it.
 */
export function startTransport(): Promise<TransportStatus> {
  if (startPromise !== null) return startPromise;
  startPromise = (async () => {
    const dir = hubStateDir();
    status = { ...status, stateDir: dir };
    try {
      mkdirSync(dir, { recursive: true });
      const ownerToken = loadOwnerToken(dir);
      const started = startLocalServer({
        port: apiPortFromEnv(),
        ownerTokens: [{ ownerId: OWNER_ID, token: ownerToken }],
        seedProjects: [{ id: SEED_PROJECT_ID, goal: SEED_PROJECT_GOAL }],
        stateDir: dir,
        allowedOrigins: dashboardAllowedOrigins(),
      });
      const apiPort = await started.listening;
      live = { server: started.server, api: started.api, apiPort, ownerToken };
      status = {
        ...status,
        mode: 'embedded',
        apiPort,
        projectIds: started.api.projectIds(),
        error: null,
      };
      const check = await runSelfCheck();
      status = {
        ...status,
        selfCheck: check,
        wired: check.ok,
        projectIds: started.api.projectIds(),
        error: check.ok ? null : `boot self-check failed: ${check.detail}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status = {
        ...status,
        mode: 'down',
        wired: false,
        error: `embedded Together server failed to start: ${message}`,
      };
    }
    return getTransportStatus();
  })();
  return startPromise;
}

export async function stopTransport(): Promise<void> {
  startPromise = null; // a later startTransport() must boot fresh, not replay this run
  if (live === null) return;
  const { server } = live;
  live = null;
  status = { ...status, wired: false, mode: 'down', apiPort: null };
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

// ---------------------------------------------------------------------------
// Read surfaces — projections of Together's REAL records. Projects go
// through the apiFetch seam; queue and receipts read store snapshots
// directly (Together's HTTP inbox GET would record delivery — see
// readQueue). Queue = the event-log-anchored index of handoff messages
// across every hosted project; receipts = each project's event log.
// Both return paged shapes under the declared Hub caps — never a
// materialized whole list, and never a canned literal: an empty
// project answers empty.
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  goal: string;
  mode: string;
  revision: number;
}

export async function readProjects(): Promise<ProjectSummary[]> {
  const body = await apiJson('/api/v1/projects');
  const projects = body.projects;
  return Array.isArray(projects) ? (projects as ProjectSummary[]) : [];
}

export interface QueuePage {
  /** Together message records, verbatim from the API's publicMessage view. */
  items: Record<string, unknown>[];
  counts: Record<string, unknown> | null;
  nextCursor: string | null;
  resync: boolean;
  projectIds: string[];
}

type MessageExtras = Message & {
  helpId?: string;
};

function eventDetailField(event: Event, field: string): string | undefined {
  if (event.detail === null || typeof event.detail !== 'object' || Array.isArray(event.detail)) {
    return undefined;
  }
  const value = (event.detail as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * helpId -> ids of the messages linked to that help request by their
 * helpId extra. Shared by the queue index resolver and the dispatcher,
 * so both walk the log with identical semantics.
 */
export function helpLinkIndex(state: ProjectState): Map<string, string[]> {
  const linkedByHelp = new Map<string, string[]>();
  for (const message of Object.values(state.messages)) {
    const helpId = (message as MessageExtras).helpId;
    if (helpId === undefined) continue;
    const linked = linkedByHelp.get(helpId) ?? [];
    linked.push(message.id);
    linkedByHelp.set(helpId, linked);
  }
  return linkedByHelp;
}

/**
 * The message ids ONE event anchors (the anchor contract is documented
 * on queueMessageIdsFromEvents below). Exported for the dispatcher
 * (src/dispatcher.ts), which processes the log event by event behind a
 * persisted watermark and must resolve anchors exactly as the index
 * does — one implementation, two consumers, no silent divergence.
 */
export function messageIdsAnchoredByEvent(
  event: Event,
  linkedByHelp: Map<string, string[]>,
): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined): void => {
    if (id !== undefined) ids.push(id);
  };
  const addLinkedHelp = (helpId: string | undefined): void => {
    if (helpId === undefined) return;
    for (const id of linkedByHelp.get(helpId) ?? []) ids.push(id);
  };
  if (
    event.type === 'offer:sent' ||
    event.type === 'offer:accepted' ||
    event.type === 'message:ack' ||
    event.type === 'message:reply' ||
    (event.type.startsWith('message:') && event.type.endsWith('-acknowledged'))
  ) {
    add(event.entityId);
    return ids;
  }
  if (event.type === 'help:offered') {
    add(eventDetailField(event, 'messageId'));
    // Older/imported logs may carry only the help id on the event;
    // the linked-message lookup covers that shape without weakening
    // the event anchor.
    if (eventDetailField(event, 'messageId') === undefined) addLinkedHelp(event.entityId);
    return ids;
  }
  if (event.type === 'help:accepted' || event.type === 'help:withdrawn') {
    addLinkedHelp(event.entityId);
    return ids;
  }
  if (event.type === 'help:answered') {
    add(eventDetailField(event, 'replyMessageId'));
    addLinkedHelp(event.entityId);
    return ids;
  }
  if (event.type === 'handoff:recorded') {
    add(eventDetailField(event, 'messageId'));
  }
  return ids;
}

/**
 * The event log is the index's existence proof: a message belongs in the
 * queue only when a handoff-lifecycle event anchors it. Events either
 * name the message directly, name it in their detail payload, or name
 * the help request whose linked message(s) they advance. This resolver
 * deliberately does not infer existence from `state.messages` alone —
 * an unanchored record stays out of the index — and it never fabricates
 * a row for an anchored id whose message record is no longer present.
 */
function queueMessageIdsFromEvents(state: ProjectState): Set<string> {
  const ids = new Set<string>();
  const linkedByHelp = helpLinkIndex(state);
  for (const event of state.events ?? []) {
    for (const id of messageIdsAnchoredByEvent(event, linkedByHelp)) ids.add(id);
  }
  return ids;
}

/**
 * The one message projection shared by the queue index and detail.
 * `publicMessage` supplies Together's public shape; stale queued mail
 * is labeled expired in the VIEW (the same display semantics the old
 * owner inbox projection used), while the snapshot itself is never
 * written. Sharing this helper is what makes index/detail agreement a
 * property of the code rather than a hope about two implementations.
 */
function projectQueueMessage(
  message: Message,
  projectId: string,
  now = new Date().toISOString(),
): Record<string, unknown> {
  const view = { ...publicMessage(message), projectId };
  if (message.delivery === 'queued' && message.expiresAt !== undefined && message.expiresAt <= now) {
    view.delivery = 'expired';
  }
  return view;
}

function queueCounts(items: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {
    total: 0, queued: 0, delivered: 0, expired: 0, read: 0, accepted: 0, answered: 0,
  };
  for (const item of items) {
    counts.total += 1;
    const delivery = String(item.delivery ?? '');
    if (delivery in counts) counts[delivery] += 1;
    if (item.readAt !== undefined) counts.read += 1;
    if (item.acceptedAt !== undefined) counts.accepted += 1;
    if (item.answeredAt !== undefined) counts.answered += 1;
  }
  return counts;
}

/**
 * NON-RECORDING, EVENT-LOG-ANCHORED queue index (build step 4.5).
 *
 * Together's HTTP inbox routes are RECORDING reads: the root
 * handleMultiProjectInbox and the project-scoped readOwnInbox both run
 * inside store.transact — they persist `delivery: 'expired'` onto stale
 * queued mail and mark every returned message `delivered`
 * (together-candidate/lib/inbox.ts). A dashboard that polls them would consume
 * the very delivery state it displays. The step-3 replacement avoided
 * the recording route but projected only the OWNER's own mail through
 * globalInbox, which made agent-to-agent handoffs invisible in the
 * index — the blind spot this rebuild closes.
 *
 * The source of truth here is deliberately two-part, from ONE
 * store.read() snapshot per project:
 *   1. the project's event log decides WHICH handoffs exist
 *      (queueMessageIdsFromEvents — offered/posted, accepted, answered,
 *      acknowledged, and recorded-handoff lifecycle events); and
 *   2. the current message record decides WHAT STATE each is in now
 *      (projectQueueMessage — the same projection the detail read
 *      uses, so the index and detail cannot disagree about a row).
 * Sender and recipient are irrelevant to inclusion: owner-to-agent,
 * agent-to-owner, and agent-to-agent handoffs all list uniformly.
 * Rows are merged in the route's order (createdAt, then id), then paged
 * with the Hub cap and the existing bare-message-id cursor semantics.
 *
 * Divergence policy: the stored message state wins for every displayed
 * field. An event whose message record is gone (expired/purged or an
 * import that carried the log without the record) contributes no row —
 * the index never invents current state — and a message record with no
 * anchoring lifecycle event is not listed. Both are conservative
 * omissions, surfaced for the independent auditor in the step report.
 */
export async function readQueue(after?: string): Promise<QueuePage> {
  if (live === null) {
    throw new Error('Together transport is not started; cannot read queue');
  }
  const projectIds = live.api.projectIds();
  const merged: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  for (const projectId of projectIds) {
    const store = live.api.storeFor(projectId);
    if (store === undefined) continue;
    const state = await store.read();
    const anchoredIds = queueMessageIdsFromEvents(state);
    for (const messageId of anchoredIds) {
      const message = state.messages[messageId];
      if (message === undefined) continue; // anchored but record gone: omit, never fabricate
      merged.push(projectQueueMessage(message, projectId, now));
    }
  }
  merged.sort((a, b) => {
    const ca = String(a.createdAt ?? '');
    const cb = String(b.createdAt ?? '');
    return ca === cb ? String(a.id).localeCompare(String(b.id)) : ca < cb ? -1 : 1;
  });
  const counts = queueCounts(merged);
  let start = 0;
  let resync = false;
  if (after !== undefined && after !== '') {
    const idx = merged.findIndex((m) => m.id === after);
    if (idx < 0) resync = true;
    else start = idx + 1;
  }
  const page = merged.slice(start, start + HUB_CAPS.queuePageLimit);
  const last = page[page.length - 1];
  return {
    items: page,
    counts,
    nextCursor: start + HUB_CAPS.queuePageLimit < merged.length && last ? String(last.id) : null,
    resync,
    projectIds,
  };
}

/**
 * Queue detail: ONE handoff (message) by id in one project. Together's
 * HTTP surface has no GET-by-id message route (lib/inbox.ts routes are
 * the inbox list, brief, help list/detail, handoffs list), so this
 * projects the project store snapshot through the shared
 * projectQueueMessage view — the same projection the queue index uses,
 * which is what keeps their parties and delivery states in agreement.
 * It is an owner-desk read of the owner's own project state (the step-2
 * design: Hub-internal reads are owner-scoped); agents' own reads stay
 * scoped to their own mail by the API itself. Null when absent.
 */
export async function readQueueDetail(
  projectId: string,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  const store = projectStore(projectId);
  if (store === undefined) return null;
  const state = await store.read();
  const message = state.messages[messageId];
  if (message === undefined) return null;
  return projectQueueMessage(message, projectId);
}

/**
 * Receipt detail: ONE event by project + seq, through the seam against
 * the API's events route (a pure store.read in lib/events.ts — never a
 * recording read). Events are cursor-addressed by seq, so the detail
 * read asks for the single entry after seq-1 and verifies the seq.
 * Null when no event carries that seq.
 */
export async function readReceiptDetail(
  projectId: string,
  seq: number,
): Promise<Record<string, unknown> | null> {
  if (!Number.isInteger(seq) || seq < 1) return null;
  const body = await apiJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/events?after=${seq - 1}&limit=1`,
  );
  const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : [];
  const event = events[0];
  return event !== undefined && event.seq === seq ? event : null;
}

export interface ReceiptsPage {
  /** Event records from each project's log, tagged with their projectId. */
  items: Record<string, unknown>[];
  pages: {
    projectId: string;
    count: number;
    nextCursor: number;
    latestSeq: number;
    resync: boolean;
  }[];
  total: number;
}

/**
 * The canonical receipts hash (build step 8): sha256 over the JSON of
 * one project's event records — each tagged with its projectId exactly
 * as readReceipts tags them — sorted by seq ascending. This is byte
 * for byte the construction scripts/probe-handoff.ts hashes with, so
 * the number on the receipts page equals the probe's number for the
 * same stream.
 */
export function canonicalReceiptsHash(events: Record<string, unknown>[]): string {
  const sorted = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export interface ProjectReceipts {
  projectId: string;
  /** The project's FULL event stream, seq ascending, records tagged as readReceipts tags them. */
  events: Record<string, unknown>[];
  count: number;
  latestSeq: number;
  /** canonicalReceiptsHash over `events` — the hash the receipts view puts on its face. */
  sha256: string;
}

/**
 * One project's complete event stream (build step 8), for the receipts
 * view. readReceipts above returns the declared 50-item index page;
 * this read pages the API's events route with its seq cursor until
 * the log tip, so the timeline — and the hash on its face — cover the
 * whole stream, not a page of it. The events route is a pure
 * store.read (lib/events.ts), so this records nothing, like every
 * other Hub read. Records go through the same {...event, projectId}
 * tagging as readReceipts, which is what makes the hash comparable
 * to the probe's. Null when the project is not hosted.
 */
export async function readProjectReceipts(
  projectId: string,
): Promise<ProjectReceipts | null> {
  if (live === null) {
    throw new Error('Together transport is not started; cannot read project receipts');
  }
  if (!live.api.projectIds().includes(projectId)) return null;
  const events: Record<string, unknown>[] = [];
  let after = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const body = await apiJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/events?after=${after}&limit=100`,
    );
    const page = Array.isArray(body.events)
      ? (body.events as Record<string, unknown>[])
      : [];
    if (page.length === 0) break;
    for (const event of page) events.push({ ...event, projectId });
    const lastSeq = Number(page[page.length - 1]?.seq);
    const latestSeq = typeof body.latestSeq === 'number' ? body.latestSeq : lastSeq;
    if (!Number.isFinite(lastSeq) || lastSeq <= after || lastSeq >= latestSeq) break;
    after = lastSeq;
  }
  events.sort((a, b) => Number(a.seq) - Number(b.seq));
  return {
    projectId,
    events,
    count: events.length,
    latestSeq: events.length > 0 ? Number(events[events.length - 1].seq) : 0,
    sha256: canonicalReceiptsHash(events),
  };
}

export async function readReceipts(): Promise<ReceiptsPage> {
  if (live === null) {
    throw new Error('Together transport is not started; cannot read receipts');
  }
  const items: Record<string, unknown>[] = [];
  const pages: ReceiptsPage['pages'] = [];
  for (const projectId of live.api.projectIds()) {
    const body = await apiJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/events?limit=${HUB_CAPS.receiptsPageLimit}`,
    );
    const events = Array.isArray(body.events)
      ? (body.events as Record<string, unknown>[])
      : [];
    for (const event of events) items.push({ ...event, projectId });
    pages.push({
      projectId,
      count: typeof body.count === 'number' ? body.count : events.length,
      nextCursor: typeof body.nextCursor === 'number' ? body.nextCursor : 0,
      latestSeq: typeof body.latestSeq === 'number' ? body.latestSeq : 0,
      resync: body.resync === true,
    });
  }
  return { items, pages, total: items.length };
}
