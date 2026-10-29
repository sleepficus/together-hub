// The dispatcher (build step 6, audit row 13) — rules path live, model
// path opt-in through the bundled Meta API helper.
//
// What the dispatcher is: a Hub-side process that watches each hosted
// project's event log and, for every NEW handoff the log anchors (the
// step-4.5 resolver's lifecycle events — the exact same anchor semantics
// as the queue index, via transport.ts's exported per-event resolver),
// records a ROUTING DECISION as an annotation on the Hub side.
//
// Labeling is STRUCTURAL (row 13): an annotation is ONE record written
// in ONE store write, and it always carries `routed_by`, the routing
// `decision`, and the `summary` together. There is no code path that
// can persist a summary without its provenance beside it, because the
// three are fields of a single object literal built by the router and
// stored atomically (see the annotation store below).
//
// The Hub never rewrites Together's records. Annotations live in a
// Hub-side store at <stateDir>/hub/dispatcher.json, keyed by
// projectId + messageId, following the JsonFileStore discipline
// Together itself uses (one JSON document, tmp file + atomic rename,
// mode 0600; a corrupt existing file is a hard failure, never a silent
// reset — losing the watermarks would cause re-annotation).
//
// The `hub/` subdirectory is load-bearing, not cosmetic: Together's
// bootstrap (cloud/local-server.ts) scans the state dir's TOP LEVEL
// for *.json files and parses every one as a project state, throwing
// on anything that is not one. A Hub-owned file at the top level
// would break the embedded server's next boot; the scan is
// non-recursive, so Hub-owned state lives one level down.
//
// The rules router is deterministic and evidence-only: it reads one
// store.read() snapshot (a pure, non-recording read) and decides from
// the record's own fields:
//   (a) the message names an addressee — its recipient field holds an
//       identity enrolled in the project (present in state.identities)
//       -> deliver to that identity; the reason states the explicit
//       addressee. (Together requires a recipientId on every message
//       it creates itself; a record whose recipient names no enrolled
//       identity — an imported/foreign log shape — falls through to
//       the scope branch, exactly as the divergence policy in step 4.5
//       treats record/log mismatches conservatively.)
//   (b) else, if the handoff declares required scopes (the record's
//       own `scopes` extra — assignment offers carry it) and exactly
//       one enrolled identity holds them all (via an active,
//       unexpired credential scoped to this project; the owner and
//       the sender are never scope-match candidates) -> deliver; the
//       reason states the scope match.
//   (c) else -> needs-owner; the reason states why (no scopes declared,
//       zero holders, or multiple holders — no unique match). The
//       approval gate (build step 7) will consume needs-owner; this
//       step only records it.
//
// The summary is a TEMPLATE restatement built only from the record's
// own fields — sender label (the identity's displayName from project
// state, falling back to the raw id), the decision target, the message
// type, and the body's first line truncated at a declared cap. No
// invented prose.
//
// MODEL PATH (wired 2026-10-26, after audit experiment 5): with the
// env flag HUB_DISPATCHER_MODEL=on, the dispatcher asks Muse Spark
// (Meta Model API, model muse-spark-1.3) to route + summarize each new
// handoff, through the connector helper — the same disciplined route
// experiment 5 proved. An annotation earns routed_by "model" ONLY
// when a real call returns a decision that validates against the
// record (an enrolled target, a non-empty reason and summary); the
// annotation then carries the call's receipt (response-reported model
// id, token counts, latency, estimated cost) beside the decision. If
// the call fails, times out, or returns output that does not validate,
// the handoff falls back to the rules router and the annotation says
// so: routed_by stays "rules" and a `model_attempt` record carries the
// failure (code + detail + the call receipt when the call completed).
// A failed model call never wears the "model" label. With the flag
// off (the default) nothing changes: rules only, exactly as before,
// and routeWithModel answers a typed NOT-WIRED result.
//
// Processing loop: started/stopped with the Hub server lifecycle
// (server.ts), polling on a modest interval (default 1000 ms,
// HUB_DISPATCHER_POLL_MS overrides for tests). A PERSISTED per-project
// watermark (last processed event seq, in the same store document as
// the annotations, written in the same atomic write) makes processing
// exactly-once: a Hub restart resumes past already-annotated handoffs
// without duplicating or re-annotating them — proven in the smoke's
// restart phase, which also asserts an earlier annotation's decidedAt
// is byte-identical after the restart.
//
// THE APPROVAL GATE (build step 7, audit row 14) lives here too,
// because a gate decision is an amendment TO an annotation and must
// join the same store document and the same atomic-write discipline:
// releaseGate / refuseGate below mutate the annotation in this store
// and persist through the same persistStore(). The gate governs
// needs-owner annotations ONLY. A release rewrites the annotation's
// decision to deliver (the new reason states the owner released it and
// preserves the original needs-owner reason verbatim inside it) and
// attaches a `gate` provenance object; a refusal attaches the `gate`
// object and leaves the decision as needs-owner. `routed_by` is NEVER
// touched by a gate action — the original routing provenance stands
// (row 13); the gate provenance rides alongside it, it does not
// relabel it. Together's own message record is never edited by a gate
// action: release and refusal are Hub annotations, full stop.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OWNER_ID,
  helpLinkIndex,
  hostedProjectIds,
  hubStateDir,
  messageIdsAnchoredByEvent,
  projectState,
} from './transport.ts';
import type { Message, ProjectState } from '../../together-candidate/lib/types.ts';

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  action: 'deliver' | 'needs-owner';
  /** The identity the handoff routes to. Present only on deliver. */
  to?: string;
  /** Factual, record-derived explanation of the decision. */
  reason: string;
}

/**
 * The owner's gate decision on a needs-owner handoff (build step 7).
 * Attached to the annotation by releaseGate / refuseGate; never
 * present on an annotation the gate has not decided. This is the
 * amendment's provenance — who decided, which way, when, and (on a
 * release) to whom — recorded alongside the routing provenance, never
 * in place of it.
 */
export interface GateRecord {
  action: 'released' | 'refused';
  /** The gate is an owner-session action; the actor is the owner. */
  by: 'owner';
  /** ISO timestamp of the gate decision. */
  at: string;
  /** The identity the handoff was released to. Released only. */
  to?: string;
  /** The owner's refusal note, when one was given. Refused only. */
  note?: string;
}

export interface DispatcherAnnotation {
  projectId: string;
  messageId: string;
  /**
   * Which path produced this annotation. "model" is earned only by a
   * completed, validated Muse Spark call (see model_call); a failed
   * model attempt falls back to the rules router and keeps "rules".
   */
  routed_by: 'rules' | 'model';
  decision: RoutingDecision;
  /**
   * The rules path's template restatement — or, on a model-routed
   * annotation, the model's own one-line summary. Never alone: the
   * routed_by provenance always rides on the same record (row 13).
   */
  summary: string;
  decidedAt: string;
  /** Seq of the anchoring event that triggered this annotation. */
  eventSeq: number;
  /** The owner's gate decision, once made (build step 7). */
  gate?: GateRecord;
  /** The live Spark call's receipt. Present only when routed_by is "model". */
  model_call?: ModelCallReceipt;
  /**
   * A failed model attempt's record, attached to the RULES annotation
   * the dispatcher fell back to. Present only when the model path was
   * enabled and tried for this handoff and did not produce the decision.
   */
  model_attempt?: ModelAttemptRecord;
}

/** One live model call's receipt, from the API response's own fields. */
export interface ModelCallReceipt {
  /** The model id the API response itself reported. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /**
   * Estimated cost at the published muse-spark-1.3 rates
   * ($1.25/M input, $4.25/M output — third-party-quoted Meta rate
   * card, experiment 5's sourcing caveat). An estimate, labeled so.
   */
  estimatedCostUsd: number;
}

/** A model attempt that did not produce the routing decision. */
export interface ModelAttemptRecord {
  ok: false;
  code: 'not_wired' | 'call_failed' | 'bad_output';
  detail: string;
  at: string;
  /** Present when the call itself completed (its tokens were spent). */
  call?: ModelCallReceipt;
}

/** The model path's success: a validated decision + the call receipt. */
export interface ModelRouteSuccess {
  wired: true;
  ok: true;
  decision: RoutingDecision;
  summary: string;
  call: ModelCallReceipt;
}

/** The model path's failure: typed, detailed, never a fabricated decision. */
export interface ModelRouteFailure {
  wired: boolean;
  ok: false;
  code: 'not_wired' | 'call_failed' | 'bad_output';
  detail: string;
  /** Present when the call itself completed but its output failed validation. */
  call?: ModelCallReceipt;
}

export type ModelRouteResult = ModelRouteSuccess | ModelRouteFailure;

/**
 * The transport seam for one model call: prompt in, the call's raw
 * facts out. The default implementation shells to the Meta connector
 * helper; the smoke substitutes a stand-in so its model-path checks
 * spend nothing live.
 */
export type ModelTransport = (prompt: string) => Promise<ModelTransportResult>;

export interface ModelTransportResult {
  /** The model's visible answer text ('' when it produced none). */
  content: string;
  /** The response's finish/stop reason, when the API reported one. */
  finishReason: string | null;
  /** The model id the response itself reported. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

type MessageExtrasView = Message & {
  helpId?: string;
  scopes?: string[];
  role?: string;
};

// ---------------------------------------------------------------------------
// Annotation store (<stateDir>/hub/dispatcher.json — see the header for
// why the subdirectory is load-bearing)
// ---------------------------------------------------------------------------

interface DispatcherFile {
  version: 1;
  savedAt: string;
  /** projectId -> last processed event seq. */
  watermarks: Record<string, number>;
  /** projectId -> messageId -> annotation. */
  annotations: Record<string, Record<string, DispatcherAnnotation>>;
}

const STORE_VERSION = 1;

let store: DispatcherFile | null = null;
let storeError: string | null = null;

function storePath(): string {
  return join(hubStateDir(), 'hub', 'dispatcher.json');
}

function emptyStore(): DispatcherFile {
  return { version: STORE_VERSION, savedAt: new Date().toISOString(), watermarks: {}, annotations: {} };
}

function loadStore(): DispatcherFile {
  if (store !== null) return store;
  const file = storePath();
  if (!existsSync(file)) {
    store = emptyStore();
    return store;
  }
  // Fail closed: an unreadable annotation store must surface, not reset
  // (a reset would silently re-annotate every handoff on the next tick).
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DispatcherFile>;
  if (
    parsed.version !== STORE_VERSION ||
    typeof parsed.watermarks !== 'object' || parsed.watermarks === null ||
    typeof parsed.annotations !== 'object' || parsed.annotations === null
  ) {
    throw new Error(`dispatcher store at ${file} has an unexpected shape; refusing to reset it`);
  }
  store = {
    version: STORE_VERSION,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
    watermarks: parsed.watermarks as Record<string, number>,
    annotations: parsed.annotations as Record<string, Record<string, DispatcherAnnotation>>,
  };
  return store;
}

function persistStore(): void {
  if (store === null) return;
  const file = storePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  store.savedAt = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Rules router (deterministic, evidence-only)
// ---------------------------------------------------------------------------

const SUMMARY_LINE_MAX = 120;

function identityLabel(state: ProjectState, identityId: string): string {
  return state.identities[identityId]?.displayName ?? identityId;
}

/** Active, unexpired credentials for one identity in one project. */
function activeCredentials(
  state: ProjectState,
  projectId: string,
  identityId: string,
  now: string,
) {
  return Object.values(state.credentials).filter(
    (c) =>
      c.identityId === identityId &&
      c.status === 'active' &&
      c.projectIds.includes(projectId) &&
      (c.expiresAt === undefined || c.expiresAt > now),
  );
}

/**
 * Scopes each identity holds through ACTIVE, unexpired credentials
 * scoped to this project. One computation, two consumers: the rules
 * router's scope match, and the model prompt's roster (the model is
 * shown exactly the scope facts the rules would use).
 */
function heldScopesByIdentity(
  state: ProjectState,
  projectId: string,
  now: string,
): Map<string, Set<string>> {
  const scopesByIdentity = new Map<string, Set<string>>();
  for (const cred of Object.values(state.credentials)) {
    if (cred.status !== 'active') continue;
    if (!cred.projectIds.includes(projectId)) continue;
    if (cred.expiresAt !== undefined && cred.expiresAt <= now) continue;
    const held = scopesByIdentity.get(cred.identityId) ?? new Set<string>();
    for (const scope of cred.scopes) held.add(scope);
    scopesByIdentity.set(cred.identityId, held);
  }
  return scopesByIdentity;
}

/**
 * Enrolled identities holding ALL of `required` through active
 * credentials scoped to this project. The owner is not a routing
 * target for scope matches (a scope match that lands on the owner IS
 * the needs-owner case), and the sender never receives its own handoff
 * back as a "match". Deterministic order (by identity id).
 */
function scopeHolders(
  state: ProjectState,
  projectId: string,
  senderId: string,
  required: string[],
  now: string,
): string[] {
  const scopesByIdentity = heldScopesByIdentity(state, projectId, now);
  const holders: string[] = [];
  for (const [identityId, held] of scopesByIdentity) {
    if (identityId === OWNER_ID || identityId === senderId) continue;
    const identity = state.identities[identityId];
    if (identity === undefined || identity.status !== 'active') continue;
    if (required.every((scope) => held.has(scope))) holders.push(identityId);
  }
  return holders.sort();
}

function summarize(
  state: ProjectState,
  message: Message,
  decision: RoutingDecision,
): string {
  const sender = identityLabel(state, message.senderId);
  const target =
    decision.action === 'deliver' && decision.to !== undefined
      ? identityLabel(state, decision.to)
      : 'owner review';
  const line = (message.body.split('\n')[0] ?? '').trim();
  const firstLine =
    line.length > SUMMARY_LINE_MAX ? `${line.slice(0, SUMMARY_LINE_MAX - 1)}…` : line;
  return `${sender} → ${target}: [${message.type}] ${firstLine}`.trimEnd();
}

/**
 * Route one handoff record by the deterministic rules. Pure: the same
 * snapshot + record always yields the same decision and reason.
 */
export function routeByRules(
  state: ProjectState,
  message: Message,
  eventSeq: number,
): DispatcherAnnotation {
  const now = new Date().toISOString();
  const projectId = state.project.id;
  let decision: RoutingDecision;

  const recipientId = message.recipientId;
  const addressee =
    typeof recipientId === 'string' && recipientId !== ''
      ? state.identities[recipientId]
      : undefined;

  if (addressee !== undefined) {
    // (a) The message names an addressee enrolled in this project.
    let reason =
      `explicit addressee: ${identityLabel(state, recipientId)} (${recipientId}) ` +
      'is named in the message recipient field';
    if (addressee.status === 'revoked') {
      reason += '; the addressee identity is revoked on the record';
    } else if (activeCredentials(state, projectId, recipientId, now).length === 0) {
      reason += '; the addressee holds no active credential on the record';
    }
    decision = { action: 'deliver', to: recipientId, reason };
  } else {
    // (b)/(c) No enrolled addressee: fall to the record's declared scopes.
    const declared = (message as MessageExtrasView).scopes;
    const required = Array.isArray(declared)
      ? declared.filter((s): s is string => typeof s === 'string' && s !== '')
      : [];
    if (required.length === 0) {
      decision = {
        action: 'needs-owner',
        reason: 'no addressee named and the handoff declares no required scopes to match on',
      };
    } else {
      const holders = scopeHolders(state, projectId, message.senderId, required, now);
      if (holders.length === 1) {
        const only = holders[0];
        decision = {
          action: 'deliver',
          to: only,
          reason:
            `no addressee named; ${identityLabel(state, only)} (${only}) is the only ` +
            `enrolled identity holding the required scope(s): ${required.join(', ')}`,
        };
      } else if (holders.length === 0) {
        decision = {
          action: 'needs-owner',
          reason: `no addressee named; no enrolled identity holds the required scope(s): ${required.join(', ')}`,
        };
      } else {
        decision = {
          action: 'needs-owner',
          reason:
            `no addressee named; ${holders.length} enrolled identities hold the required ` +
            `scope(s): ${required.join(', ')} — no unique match`,
        };
      }
    }
  }

  // One object, one write: routed_by + decision + summary are born
  // together and can never be persisted apart (row 13, structural).
  return {
    projectId,
    messageId: message.id,
    routed_by: 'rules',
    decision,
    summary: summarize(state, message, decision),
    decidedAt: now,
    eventSeq,
  };
}

// ---------------------------------------------------------------------------
// Model path — WIRED (2026-10-26): Muse Spark via the Meta connector
// ---------------------------------------------------------------------------

/** The dispatcher seat: the newest Muse Spark id in the live models list (experiment 5). */
export const MODEL_DISPATCHER_ID = 'muse-spark-1.3';

/**
 * The completion cap, in the THOUSANDS on purpose: Spark reasons
 * before it answers, and reasoning tokens consume the cap first —
 * experiment 5's 500-token attempt returned null content (498 of 500
 * completion tokens were reasoning). 4000 is the cap that completed.
 */
export const MODEL_MAX_TOKENS = 4000;

/** Published muse-spark-1.3 rates (experiment 5's sourcing caveat applies). */
const MODEL_RATES_USD_PER_MTOK = { input: 1.25, output: 4.25 } as const;

const MODEL_BODY_MAX = 1200;
const MODEL_REASON_MAX = 500;
const MODEL_SUMMARY_MAX = 300;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
/** Shipped stdlib helper; no external builder workspace required. */
const DEFAULT_META_HELPER = join(
  SRC_DIR,
  '..',
  'scripts',
  'meta-api.py',
);

/**
 * Whether the model path is switched on for this process
 * (HUB_DISPATCHER_MODEL=on). Read live on every call: the flag is the
 * wiring switch for the run, and /hub/status reports `wired` from it —
 * with the flag off, this process will never call the model, exactly
 * like transport's wired is earned by this process's own self-check.
 */
export function dispatcherModelEnabled(): boolean {
  return process.env.HUB_DISPATCHER_MODEL === 'on';
}

function modelTimeoutMs(): number {
  const raw = process.env.HUB_DISPATCHER_MODEL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1000 ? n : 60_000;
}

/** Test seam: substitute the live transport (the smoke spends nothing). */
let modelTransportOverride: ModelTransport | null = null;
export function setModelTransport(transport: ModelTransport | null): void {
  modelTransportOverride = transport;
}

function receiptFrom(result: ModelTransportResult): ModelCallReceipt {
  return {
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: Math.round(result.latencyMs),
    estimatedCostUsd:
      (result.inputTokens * MODEL_RATES_USD_PER_MTOK.input +
        result.outputTokens * MODEL_RATES_USD_PER_MTOK.output) /
      1_000_000,
  };
}

/** Run the connector helper as a subprocess, with a hard timeout. */
function runMetaHelper(args: string[], timeoutMs: number): Promise<string> {
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
      fail(new Error(`meta connector helper timed out after ${timeoutMs} ms`));
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
          new Error(
            `meta connector helper exited ${code ?? 'unknown'}: ${stderr.trim().slice(0, 300)}`,
          ),
        );
      }
    });
  });
}

/**
 * One text completion through the bundled helper. The helper reads private
 * key-file configuration (or an explicitly injected environment key); no
 * credential is put in argv or logs. No native model tool loop is claimed.
 */
async function liveMetaTransport(prompt: string): Promise<ModelTransportResult> {
  const helper = process.env.HUB_META_HELPER_PATH ?? DEFAULT_META_HELPER;
  if (!existsSync(helper)) {
    throw new Error(`meta connector helper not found at ${helper}`);
  }
  const t0 = performance.now();
  const stdout = await runMetaHelper(
    [
      helper,
      'chat',
      '--model',
      MODEL_DISPATCHER_ID,
      '--max-tokens',
      String(MODEL_MAX_TOKENS),
      '--prompt',
      prompt,
    ],
    modelTimeoutMs(),
  );
  const latencyMs = performance.now() - t0;
  const parsed = JSON.parse(stdout) as {
    model?: unknown;
    choices?: { finish_reason?: unknown; message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  if (typeof parsed.model !== 'string' || parsed.model !== MODEL_DISPATCHER_ID) {
    throw new Error('Meta helper did not verify the requested model identity');
  }
  return {
    content: typeof content === 'string' ? content : '',
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    model: parsed.model,
    inputTokens:
      typeof parsed.usage?.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : 0,
    outputTokens:
      typeof parsed.usage?.completion_tokens === 'number'
        ? parsed.usage.completion_tokens
        : 0,
    latencyMs,
  };
}

/**
 * The dispatcher's prompt: standing rules + this handoff's record +
 * the enrolled roster with its held scopes (the same scope facts the
 * rules router uses). The model is asked for a decision in a strict
 * JSON shape; its answer is validated against the record before it
 * can label anything (see routeWithModel) — the prompt instructs, the
 * code enforces.
 */
function buildModelPrompt(state: ProjectState, message: Message): string {
  const projectId = state.project.id;
  const now = new Date().toISOString();
  const held = heldScopesByIdentity(state, projectId, now);
  const extras = message as MessageExtrasView;
  const declared = Array.isArray(extras.scopes)
    ? extras.scopes.filter((s): s is string => typeof s === 'string' && s !== '')
    : [];
  const body =
    message.body.length > MODEL_BODY_MAX
      ? `${message.body.slice(0, MODEL_BODY_MAX)}…`
      : message.body;
  const recipient =
    typeof message.recipientId === 'string' && message.recipientId !== ''
      ? `${identityLabel(state, message.recipientId)} (${message.recipientId})`
      : 'none named';
  const roster = Object.values(state.identities)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((identity) => {
      const scopes = [...(held.get(identity.id) ?? [])].sort();
      return (
        `- ${identity.id} — ${identity.displayName} — status ${identity.status}` +
        ` — scopes held via active credentials: ${scopes.length > 0 ? scopes.join(', ') : 'none'}` +
        (identity.id === OWNER_ID ? ' — the project owner' : '')
      );
    })
    .join('\n');
  return [
    'You are the dispatcher for Together Hub, a shared queue where AI agents hand work to each other.',
    'Read the handoff below and decide its routing, applying the Hub standing rules WITH judgment:',
    '1. If the handoff names an addressee enrolled in the project, deliver to that addressee —',
    '   UNLESS the request crosses the consequence line: anything destructive (deleting or wiping',
    '   state, data, logs, or receipts), anything that creates, rotates, revokes, or changes',
    '   credentials, permissions, or access, and anything irreversible goes to the owner instead',
    '   (action "needs-owner"), whoever it is addressed to.',
    '2. If no addressee is named, deliver to the one enrolled agent whose held scopes uniquely',
    '   cover the work; if none or several fit, "needs-owner".',
    '3. Never route a handoff back to its sender.',
    '',
    'Return ONLY a JSON object, no other text, of this shape:',
    '{"action": "deliver" | "needs-owner", "to": "<identity id, deliver only>", "reason": "<one or two factual sentences>", "summary": "<one line: sender -> target: what the handoff asks>"}',
    '',
    'Handoff:',
    `- project: ${projectId}`,
    `- type: ${message.type}`,
    `- from: ${identityLabel(state, message.senderId)} (${message.senderId})`,
    `- named addressee: ${recipient}`,
    `- declared required scopes: ${declared.length > 0 ? declared.join(', ') : 'none'}`,
    '- body:',
    body,
    '',
    'Enrolled identities in this project:',
    roster,
  ].join('\n');
}

function extractJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function capText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * The model routing path — the rules router's judgment sibling. With
 * the flag off it answers a typed NOT-WIRED result and performs no
 * call (the pre-wiring behavior, unchanged). With the flag on it makes
 * ONE live Spark call and validates the answer against the record
 * before anything is labeled: the target must be an enrolled identity
 * other than the sender, reason and summary must be present. Any
 * failure — transport error, timeout, empty content (the experiment-5
 * reasoning-cap trap is named in the detail), unparseable or invalid
 * output — returns a typed failure; the caller falls back to the
 * rules router and records the attempt. A model decision that did
 * not validate never reaches an annotation.
 */
export async function routeWithModel(input: {
  state: ProjectState;
  message: Message;
  transport?: ModelTransport;
}): Promise<ModelRouteResult> {
  if (!dispatcherModelEnabled()) {
    return {
      wired: false,
      ok: false,
      code: 'not_wired',
      detail:
        'model path is not enabled for this process (HUB_DISPATCHER_MODEL is not "on"); ' +
        'no call was made and the dispatcher routes by rules.',
    };
  }
  const transport = input.transport ?? modelTransportOverride ?? liveMetaTransport;
  let result: ModelTransportResult;
  try {
    result = await transport(buildModelPrompt(input.state, input.message));
  } catch (err) {
    return {
      wired: true,
      ok: false,
      code: 'call_failed',
      detail: `model call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const call = receiptFrom(result);
  if (result.content.trim() === '') {
    return {
      wired: true,
      ok: false,
      code: 'bad_output',
      detail:
        result.finishReason === 'length'
          ? 'model returned no content: the completion budget was consumed by reasoning ' +
            '(finish_reason "length") — the experiment-5 trap; the call receipt rides along'
          : 'model returned no content',
      call,
    };
  }
  const parsed = extractJsonObject(result.content);
  if (parsed === null) {
    return {
      wired: true,
      ok: false,
      code: 'bad_output',
      detail: 'model output was not a JSON object; no decision could be read from it',
      call,
    };
  }
  const action = parsed.action;
  const reason = typeof parsed.reason === 'string' ? capText(parsed.reason, MODEL_REASON_MAX) : '';
  const summary =
    typeof parsed.summary === 'string' ? capText(parsed.summary, MODEL_SUMMARY_MAX) : '';
  if (action !== 'deliver' && action !== 'needs-owner') {
    return {
      wired: true,
      ok: false,
      code: 'bad_output',
      detail: `model returned an unknown action (${JSON.stringify(action ?? null)}); expected "deliver" or "needs-owner"`,
      call,
    };
  }
  if (reason === '' || summary === '') {
    return {
      wired: true,
      ok: false,
      code: 'bad_output',
      detail: 'model output lacked a non-empty reason or summary; provenance must ride beside the decision',
      call,
    };
  }
  if (action === 'needs-owner') {
    return { wired: true, ok: true, decision: { action: 'needs-owner', reason }, summary, call };
  }
  const to = typeof parsed.to === 'string' ? parsed.to : '';
  if (to === '' || input.state.identities[to] === undefined) {
    return {
      wired: true,
      ok: false,
      code: 'bad_output',
      detail: `model routed to ${JSON.stringify(parsed.to ?? null)}, which is not an enrolled identity in this project`,
      call,
    };
  }
  if (to === input.message.senderId) {
    return {
      wired: true,
      ok: false,
      code: 'bad_output',
      detail: 'model routed the handoff back to its own sender; the standing rules forbid it',
      call,
    };
  }
  return { wired: true, ok: true, decision: { action: 'deliver', to, reason }, summary, call };
}

/**
 * Route one handoff for the drain loop. Flag off: the rules router,
 * untouched. Flag on: the model first; on success the annotation is
 * born with routed_by "model" + the call receipt in ONE record (row
 * 13's structural rule — provenance is never persisted apart from the
 * decision it describes). On any model failure the rules annotation
 * is built as usual and the failed attempt is recorded on it — the
 * fallback is visible on the face of the record, not silent.
 */
async function routeHandoff(
  state: ProjectState,
  message: Message,
  eventSeq: number,
): Promise<DispatcherAnnotation> {
  if (!dispatcherModelEnabled()) return routeByRules(state, message, eventSeq);
  const result = await routeWithModel({ state, message });
  if (result.ok) {
    return {
      projectId: state.project.id,
      messageId: message.id,
      routed_by: 'model',
      decision: result.decision,
      summary: result.summary,
      decidedAt: new Date().toISOString(),
      eventSeq,
      model_call: result.call,
    };
  }
  const fallback = routeByRules(state, message, eventSeq);
  const attempt: ModelAttemptRecord = {
    ok: false,
    code: result.code,
    detail: result.detail,
    at: new Date().toISOString(),
  };
  if (result.call !== undefined) attempt.call = result.call;
  fallback.model_attempt = attempt;
  return fallback;
}

// ---------------------------------------------------------------------------
// Processing loop — event-log driven, persisted watermark, exactly-once
// ---------------------------------------------------------------------------

export const DISPATCHER_POLL_DEFAULT_MS = 1000;

function pollMs(): number {
  const raw = process.env.HUB_DISPATCHER_POLL_MS;
  if (raw === undefined || raw === '') return DISPATCHER_POLL_DEFAULT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 10 ? n : DISPATCHER_POLL_DEFAULT_MS;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickError: string | null = null;
let drainChain: Promise<void> = Promise.resolve();

async function drainOnce(): Promise<void> {
  const file = loadStore();
  let changed = false;
  for (const projectId of hostedProjectIds()) {
    const state = await projectState(projectId); // store.read() snapshot — non-recording
    const linkedByHelp = helpLinkIndex(state);
    const annotations = (file.annotations[projectId] ??= {});
    let watermark = file.watermarks[projectId] ?? 0;
    const events = [...(state.events ?? [])].sort((a, b) => a.seq - b.seq);
    for (const event of events) {
      if (event.seq <= watermark) continue;
      for (const messageId of messageIdsAnchoredByEvent(event, linkedByHelp)) {
        if (annotations[messageId] !== undefined) continue; // exactly once
        const message = state.messages[messageId];
        if (message === undefined) continue; // anchored but record gone: omit, never fabricate
        annotations[messageId] = await routeHandoff(state, message, event.seq);
        changed = true;
      }
      watermark = event.seq;
    }
    if ((file.watermarks[projectId] ?? 0) !== watermark) {
      file.watermarks[projectId] = watermark;
      changed = true;
    }
  }
  if (changed) persistStore();
}

/**
 * Process every project's log up to its current end, exactly once per
 * handoff. Serialized through a promise chain so a manual drain (the
 * smoke, the probes) can never race the poll loop into a double write.
 * Exported so tests can force processing deterministically instead of
 * sleeping on the poll interval.
 */
export function processDispatcherOnce(): Promise<void> {
  const run = drainChain.then(drainOnce, drainOnce);
  drainChain = run.catch(() => undefined);
  return run;
}

export function startDispatcher(): void {
  if (timer !== null) return;
  try {
    loadStore();
    storeError = null;
  } catch (err) {
    // The store failed closed; surface it in the status and do not run
    // the loop on a guessed-at state.
    storeError = err instanceof Error ? err.message : String(err);
    return;
  }
  timer = setInterval(() => {
    processDispatcherOnce().then(
      () => {
        lastTickError = null;
      },
      (err: unknown) => {
        lastTickError = err instanceof Error ? err.message : String(err);
      },
    );
  }, pollMs());
  timer.unref();
  void processDispatcherOnce().catch((err: unknown) => {
    lastTickError = err instanceof Error ? err.message : String(err);
  });
}

export function stopDispatcher(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

export function getAnnotation(
  projectId: string,
  messageId: string,
): DispatcherAnnotation | null {
  try {
    const file = loadStore();
    return file.annotations[projectId]?.[messageId] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The approval gate (build step 7, audit row 14) — the owner releases or
// refuses a needs-owner handoff. Both actions mutate ONLY the Hub-side
// annotation, in this store, through the same atomic persistStore() the
// annotations and watermarks use. Together's records are never touched.
// ---------------------------------------------------------------------------

/** A gate refusal with an HTTP-shaped outcome (the server maps it). */
export class GateActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The annotation a gate action may decide: it must exist, still be
 * needs-owner, and carry no gate decision yet. Every other state is a
 * conflict (409) with NO state change — a gate action can never act
 * twice, and can never reach a handoff the dispatcher already routed.
 */
function gateAwaitingAnnotation(
  projectId: string,
  messageId: string,
): DispatcherAnnotation {
  const file = loadStore();
  const annotation = file.annotations[projectId]?.[messageId];
  if (annotation === undefined) {
    throw new GateActionError(
      409,
      'gate_conflict',
      `no dispatcher annotation for ${messageId} in ${projectId} — there is nothing at the gate to decide`,
    );
  }
  if (annotation.gate !== undefined) {
    throw new GateActionError(
      409,
      'gate_conflict',
      `this handoff was already ${annotation.gate.action} by ${annotation.gate.by} at ${annotation.gate.at} — a gate decision stands once made`,
    );
  }
  if (annotation.decision.action !== 'needs-owner') {
    throw new GateActionError(
      409,
      'gate_conflict',
      `this handoff is not waiting at the gate (dispatcher decision: ${annotation.decision.action}` +
        `${annotation.decision.to !== undefined ? ` to ${annotation.decision.to}` : ''})`,
    );
  }
  return annotation;
}

/**
 * Why an enrolled identity cannot currently act on this project, in
 * the record's own terms — used only when it holds no active,
 * unexpired, project-scoped credential.
 */
function unusableCredentialReason(
  state: ProjectState,
  projectId: string,
  identityId: string,
  now: string,
): string {
  const creds = Object.values(state.credentials).filter(
    (c) => c.identityId === identityId,
  );
  if (creds.length === 0) return 'holds no credential on the record';
  if (creds.every((c) => c.status === 'revoked')) {
    return 'its credential is revoked on the record';
  }
  const active = creds.filter((c) => c.status === 'active');
  if (
    active.length > 0 &&
    active.every((c) => c.expiresAt !== undefined && c.expiresAt <= now)
  ) {
    return 'its credential is expired on the record';
  }
  return `holds no active credential scoped to ${projectId} on the record`;
}

/**
 * Release a needs-owner handoff to an enrolled identity. The desk
 * never knowingly routes into a wall: the target must be enrolled in
 * the project, not a revoked identity, and must hold an active,
 * unexpired credential scoped to this project — otherwise the release
 * is BLOCKED with the record's reason (the owner can reactivate or
 * re-enroll first, e.g. by issuing a fresh invitation at the Key
 * Desk). On success the annotation's decision becomes deliver/to with
 * the release — and the original needs-owner reason — stated in the
 * reason, and the gate provenance is attached. `routed_by`, `summary`,
 * `decidedAt`, and `eventSeq` are the dispatcher's record and are NOT
 * rewritten.
 */
export async function releaseGate(
  projectId: string,
  messageId: string,
  to: string,
): Promise<DispatcherAnnotation> {
  const annotation = gateAwaitingAnnotation(projectId, messageId);
  const state = await projectState(projectId);
  const identity = state.identities[to];
  if (identity === undefined) {
    throw new GateActionError(
      422,
      'gate_target_not_enrolled',
      `${to} is not an identity enrolled in ${projectId} — a release can only name an enrolled identity`,
    );
  }
  const label = identityLabel(state, to);
  if (identity.status === 'revoked') {
    throw new GateActionError(
      409,
      'gate_target_blocked',
      `release blocked: ${label} (${to}) is a revoked identity on the record — ` +
        'the desk never routes into a wall; reactivate or re-enroll the identity first',
    );
  }
  const at = new Date().toISOString();
  if (activeCredentials(state, projectId, to, at).length === 0) {
    throw new GateActionError(
      409,
      'gate_target_blocked',
      `release blocked: ${label} (${to}) ${unusableCredentialReason(state, projectId, to, at)} — ` +
        'the desk never routes into a wall; reactivate or re-enroll the identity first',
    );
  }
  const wasReason = annotation.decision.reason;
  annotation.decision = {
    action: 'deliver',
    to,
    reason: `released by owner (was needs-owner: ${wasReason})`,
  };
  annotation.gate = { action: 'released', by: 'owner', at, to };
  persistStore();
  return annotation;
}

/**
 * Refuse a needs-owner handoff. The decision stays needs-owner on the
 * annotation (the dispatcher DID route it to the owner); the gate
 * record carries the refusal, and queue surfaces display the handoff
 * as refused from it. Together's message record is not edited,
 * closed, or annotated — refusal is a Hub-side annotation only.
 */
export function refuseGate(
  projectId: string,
  messageId: string,
  note?: string,
): DispatcherAnnotation {
  const annotation = gateAwaitingAnnotation(projectId, messageId);
  const gate: GateRecord = {
    action: 'refused',
    by: 'owner',
    at: new Date().toISOString(),
  };
  if (note !== undefined && note !== '') gate.note = note;
  annotation.gate = gate;
  persistStore();
  return annotation;
}

/**
 * Every annotation for one project (insertion order — oldest first).
 * Read surface for the Key Desk gate list; returns the live records,
 * so callers project, never mutate.
 */
export function listAnnotations(projectId: string): DispatcherAnnotation[] {
  try {
    const file = loadStore();
    return Object.values(file.annotations[projectId] ?? {});
  } catch {
    return [];
  }
}

export interface DispatcherProjectStatus {
  watermark: number;
  annotated: number;
  byRoutedBy: { rules: number; model: number };
  /** Annotations whose dispatcher decision is needs-owner (gate state below). */
  needsOwner: number;
  /**
   * Gate state (build step 7): released and refused count annotations
   * carrying that gate decision; awaiting counts needs-owner
   * annotations with no gate decision yet.
   */
  gate: { released: number; refused: number; awaiting: number };
}

export interface DispatcherStatus {
  running: boolean;
  pollMs: number;
  /**
   * wired reports THIS process's live state: the model path is
   * implemented and switched on (HUB_DISPATCHER_MODEL=on). With the
   * flag off this process will never call the model, and the status —
   * and the honest-limits card composed from it — says not wired.
   */
  modelPath: { flag: string; wired: boolean };
  error: string | null;
  projects: Record<string, DispatcherProjectStatus>;
}

export function getDispatcherStatus(): DispatcherStatus {
  const projects: Record<string, DispatcherProjectStatus> = {};
  let loadError: string | null = null;
  let file: DispatcherFile | null = null;
  try {
    file = loadStore();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  if (file !== null) {
    const projectIds = new Set([
      ...Object.keys(file.watermarks),
      ...Object.keys(file.annotations),
    ]);
    for (const projectId of projectIds) {
      const annotations = Object.values(file.annotations[projectId] ?? {});
      projects[projectId] = {
        watermark: file.watermarks[projectId] ?? 0,
        annotated: annotations.length,
        byRoutedBy: {
          rules: annotations.filter((a) => a.routed_by === 'rules').length,
          model: annotations.filter((a) => a.routed_by === 'model').length,
        },
        needsOwner: annotations.filter((a) => a.decision.action === 'needs-owner').length,
        gate: {
          released: annotations.filter((a) => a.gate?.action === 'released').length,
          refused: annotations.filter((a) => a.gate?.action === 'refused').length,
          awaiting: annotations.filter(
            (a) => a.decision.action === 'needs-owner' && a.gate === undefined,
          ).length,
        },
      };
    }
  }
  return {
    running: timer !== null,
    pollMs: pollMs(),
    modelPath: { flag: process.env.HUB_DISPATCHER_MODEL ?? 'off', wired: dispatcherModelEnabled() },
    error: storeError ?? loadError ?? lastTickError,
    projects,
  };
}
