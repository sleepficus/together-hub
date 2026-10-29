// Key Desk — the identity minimum (build step 3, audit row 5).
//
// Everything here runs on Together's OWN identity machinery through the
// embedded API; the Hub reimplements no part of identity, enrollment, or
// credential storage:
//
// - Identities + sessions are read through the API route that exists
//   for them (GET /api/v1/projects/:id/identities).
// - Invitations are issued and credentials revoked through the API's
//   identity routes (POST .../identities, POST .../invitations,
//   POST .../credentials/:id/revoke), authenticated with the owner
//   bearer the Hub holds in server memory. The browser never calls the
//   API and never sees the owner token; it talks to the Hub, and the Hub
//   requires a live Together owner session for every Key Desk action
//   (see transport.ts: the session broker).
// - Credential + invitation STATE has no HTTP list route — by design:
//   lib/identity.ts states "Credentials and invitations are never listed
//   or returned — only their hashes exist in state". The desk therefore
//   projects them from the project store snapshot the embedded API
//   exposes via storeFor (Together's own in-process seam), picking only
//   safe fields. Token hashes are never copied into a desk record.
//
// Last success / last refusal — what the records can and cannot support:
// - LAST SUCCESS: the project event log is the durable record of
//   successful actions (every confirmed command appends an event with
//   the actor's id). An agent's last success = its latest event. GET
//   reads append nothing, so this is "last recorded action", and the
//   desk labels it exactly that way.
// - LAST REFUSAL: Together records NO refused calls. Authentication
//   failures return before any store write; command failures throw
//   inside store.transact and roll back (lib/core.ts command()); there
//   is no access/refusal log in the local composition. The desk
//   therefore shows lastRefusal as NOT RECORDED — never invented — and
//   separately shows a STANDING REFUSAL when the records do support one:
//   a revoked or expired credential refuses every subsequent call, and
//   the revocation itself is a recorded event with a timestamp.
//
// Build step 7 adds the APPROVAL GATE list (bottom of this file): the
// needs-owner handoffs the dispatcher routed to the owner, waiting for
// the owner's release or refusal. The actions themselves live in
// dispatcher.ts — they amend the dispatcher's annotations in the
// dispatcher's store; the desk only lists and (in server.ts) routes.

import { randomUUID } from 'node:crypto';
import { OWNER_ID, apiFetch, hostedProjectIds, projectState } from './transport.ts';
import { listAnnotations } from './dispatcher.ts';

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function apiCall(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const res = await apiFetch(path, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

function apiErrorMessage(result: ApiResult): string {
  const err = result.body.error as { code?: string; message?: string } | undefined;
  return `${result.status} ${err?.code ?? 'error'}: ${err?.message ?? 'request failed'}`;
}

// ---------------------------------------------------------------------------
// Per-agent state projection
// ---------------------------------------------------------------------------

export interface KeyDeskCredential {
  id: string;
  status: string;
  scopes: string[];
  projectIds: string[];
  /** ISO timestamp, or null when the credential carries no expiry. */
  expiresAt: string | null;
  createdAt: string;
  sessionId: string | null;
}

export interface KeyDeskInvitation {
  id: string;
  status: string;
  scopes: string[];
  expiresAt: string;
  /** Issuer-selected expiry for the resulting credential, or null. */
  credentialExpiresAt: string | null;
  createdAt: string;
  label: string | null;
}

export interface KeyDeskSession {
  id: string;
  status: string;
  adapter: string | null;
  model: string | null;
  provider: string | null;
  harness: string | null;
  host: string | null;
  lastActivityAt: string | null;
}

export interface KeyDeskAgent {
  projectId: string;
  identity: {
    id: string;
    displayName: string;
    ownerId: string;
    status: string;
    parentId: string | null;
    creationSource: string;
    createdAt: string;
    isOwnerIdentity: boolean;
  };
  sessions: KeyDeskSession[];
  invitations: KeyDeskInvitation[];
  credentials: KeyDeskCredential[];
  /** Latest recorded action by this identity in the project event log. */
  lastSuccess: { at: string; type: string; seq: number } | null;
  /** Together records no refused calls — see the header of this file. */
  lastRefusal: { recorded: false; note: string };
  /** A refusal that stands on the record (revoked/expired), if any. */
  standingRefusal: { since: string; reason: string; eventSeq: number | null } | null;
}

export interface KeyDeskProject {
  projectId: string;
  agents: KeyDeskAgent[];
}

const REFUSAL_NOTE =
  'not recorded — Together does not log refused calls; a refused call is ' +
  'answered with a status code at call time and leaves no record';

export async function readKeyDeskState(): Promise<{ projects: KeyDeskProject[] }> {
  const projects: KeyDeskProject[] = [];
  for (const projectId of hostedProjectIds()) {
    const listed = await apiCall(
      `/api/v1/projects/${encodeURIComponent(projectId)}/identities`,
    );
    if (listed.status !== 200) {
      throw new Error(`identity list for ${projectId} failed: ${apiErrorMessage(listed)}`);
    }
    const identities = Array.isArray(listed.body.identities)
      ? (listed.body.identities as Record<string, unknown>[])
      : [];
    const sessions = Array.isArray(listed.body.sessions)
      ? (listed.body.sessions as Record<string, unknown>[])
      : [];
    const state = await projectState(projectId);
    const now = new Date().toISOString();

    const agents: KeyDeskAgent[] = identities.map((raw) => {
      const id = String(raw.id);
      const creds = Object.values(state.credentials).filter((c) => c.identityId === id);
      const invs = Object.values(state.invitations).filter((i) => i.identityId === id);

      let lastSuccess: KeyDeskAgent['lastSuccess'] = null;
      for (const ev of state.events) {
        if (ev.actorId !== id) continue;
        if (lastSuccess === null || ev.seq > lastSuccess.seq) {
          lastSuccess = { at: ev.createdAt, type: ev.type, seq: ev.seq };
        }
      }

      // Standing refusal candidates, newest wins: identity revoked
      // (identity:revoked event), a credential revoked (credential:
      // revoked event), or a credential whose expiry has passed
      // (authenticate() refuses it from expiresAt on).
      let standing: KeyDeskAgent['standingRefusal'] = null;
      const consider = (candidate: NonNullable<KeyDeskAgent['standingRefusal']>) => {
        if (standing === null || candidate.since > standing.since) standing = candidate;
      };
      for (const ev of state.events) {
        const detail = (ev.detail ?? {}) as Record<string, unknown>;
        if (ev.type === 'identity:revoked' && ev.entityId === id) {
          consider({ since: ev.createdAt, reason: 'identity_revoked', eventSeq: ev.seq });
        }
        if (
          ev.type === 'credential:revoked' &&
          // lib/identity.ts appends this event with entityId = the
          // credential id and detail.identityId = the identity id.
          (creds.some((c) => c.id === ev.entityId) || detail.identityId === id)
        ) {
          consider({ since: ev.createdAt, reason: 'credential_revoked', eventSeq: ev.seq });
        }
      }
      if (raw.status === 'revoked') {
        consider({
          since: String(raw.updatedAt ?? raw.createdAt ?? now),
          reason: 'identity_revoked',
          eventSeq: standing?.reason === 'identity_revoked' ? standing.eventSeq : null,
        });
      }
      for (const cred of creds) {
        if (cred.status === 'active' && cred.expiresAt !== undefined && cred.expiresAt <= now) {
          consider({ since: cred.expiresAt, reason: 'credential_expired', eventSeq: null });
        }
      }

      return {
        projectId,
        identity: {
          id,
          displayName: String(raw.displayName ?? ''),
          ownerId: String(raw.ownerId ?? ''),
          status: String(raw.status ?? ''),
          parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
          creationSource: String(raw.creationSource ?? ''),
          createdAt: String(raw.createdAt ?? ''),
          isOwnerIdentity: id === OWNER_ID,
        },
        sessions: sessions
          .filter((s) => s.identityId === id)
          .map((s) => ({
            id: String(s.id),
            status: String(s.status ?? ''),
            adapter: typeof s.adapter === 'string' ? s.adapter : null,
            model: typeof s.model === 'string' ? s.model : null,
            provider: typeof s.provider === 'string' ? s.provider : null,
            harness: typeof s.harness === 'string' ? s.harness : null,
            host: typeof s.host === 'string' ? s.host : null,
            lastActivityAt: typeof s.lastActivityAt === 'string' ? s.lastActivityAt : null,
          })),
        invitations: invs.map((inv) => ({
          id: inv.id,
          status: inv.status,
          scopes: [...inv.scopes],
          expiresAt: inv.expiresAt,
          credentialExpiresAt: inv.credentialExpiresAt ?? null,
          createdAt: inv.createdAt,
          label: inv.label ?? null,
        })),
        credentials: creds.map((cred) => ({
          id: cred.id,
          status: cred.status,
          scopes: [...cred.scopes],
          projectIds: [...cred.projectIds],
          expiresAt: cred.expiresAt ?? null,
          createdAt: cred.createdAt,
          sessionId: typeof cred.sessionId === 'string' ? cred.sessionId : null,
        })),
        lastSuccess,
        lastRefusal: { recorded: false, note: REFUSAL_NOTE },
        standingRefusal: standing,
      };
    });
    projects.push({ projectId, agents });
  }
  return { projects };
}

// ---------------------------------------------------------------------------
// Owner actions (all through the API's identity routes, owner bearer)
// ---------------------------------------------------------------------------

/**
 * The Hub's credential-lifetime policy (Job 001 finding F1, MAJOR):
 * Together treats `credentialExpiresAt` as OPT-IN — an invitation
 * issued without it mints a credential that NEVER expires (Together
 * validates the field when present: future, within 30 days — but
 * omission is allowed and means no expiry). The Key Desk therefore
 * ALWAYS sets it. The Hub default is the full 30 days Together caps
 * at (MAX_CREDENTIAL_TTL_MS in together-candidate/lib/identity.ts): the
 * longest life Together permits, chosen so a desk-issued credential
 * is never shorter-lived than the owner asked Together to allow,
 * while still always expiring. A caller may request a SHORTER life
 * explicitly; the value is passed through and Together enforces the
 * cap. No Hub surface may omit the field.
 */
export const HUB_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HUB_CREDENTIAL_TTL_DAYS = 30;

/**
 * The desk's DEFAULT SCOPE SET (Law 2b UI pass finding, 2026-10-26):
 * Together treats `scopes` as opt-in too — an invitation issued
 * without it carries Together's DEFAULT_INVITE_SCOPES (read,
 * tasks:write, tasks:claim, assignments:write), which do NOT include
 * help:write. An agent minted that way cannot POST /help — it cannot
 * do the Hub's central thing (the screenshot pass's attempt 1 proved
 * it live: both handoff posts refused 403, queue empty). The desk
 * therefore ALWAYS sends a scope set: the caller's explicit list
 * untouched, or this default when the field is left blank. The set
 * is exactly the one every working Hub flow runs on (the smoke, the
 * handoff/restart probes, the demo rehearsal, UI pass run 2) — read
 * plus help:write, no broader than the demonstrated need.
 */
export const HUB_DESK_DEFAULT_SCOPES: readonly string[] = ['read', 'help:write'];

export function defaultCredentialExpiresAt(from: Date = new Date()): string {
  return new Date(from.getTime() + HUB_CREDENTIAL_TTL_MS).toISOString();
}

/**
 * The exact request body the desk sends to Together's invitation
 * route, minus the operationId. Pure and exported so the smoke can
 * shape-assert the issuance request itself (F1): whatever the caller
 * supplied, the body ALWAYS carries a credentialExpiresAt — the
 * caller's explicit value, or the Hub default — and ALWAYS carries a
 * scope set: the caller's explicit list, or HUB_DESK_DEFAULT_SCOPES
 * when scopes were left blank (an omitted field would fall through
 * to Together's defaults, which lack help:write).
 */
export function buildInvitationRequestBody(
  input: Pick<IssueInvitationInput, 'scopes' | 'inviteTtlMs' | 'credentialExpiresAt'>,
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    scopes: input.scopes !== undefined ? input.scopes : [...HUB_DESK_DEFAULT_SCOPES],
    ...(input.inviteTtlMs !== undefined ? { ttlMs: input.inviteTtlMs } : {}),
    credentialExpiresAt: input.credentialExpiresAt ?? defaultCredentialExpiresAt(now),
  };
}

export interface IssueInvitationInput {
  projectId: string;
  /** Create a new identity with this display name… */
  displayName?: string;
  /** …or invite an existing identity. Exactly one of the two. */
  identityId?: string;
  /** Explicit scopes, passed through untouched; omitted → HUB_DESK_DEFAULT_SCOPES. */
  scopes?: string[];
  inviteTtlMs?: number;
  /** Optional SHORTER credential lifetime; omitted → the Hub default (30 days, always set). */
  credentialExpiresAt?: string;
}

export interface IssueInvitationResult {
  identityId: string;
  invitationId: string;
  /** The single-use invitation token — returned ONCE, never stored. */
  token: string;
  scopes: string[];
  expiresAt: string;
  credentialExpiresAt: string | null;
}

export async function issueInvitation(
  input: IssueInvitationInput,
): Promise<IssueInvitationResult> {
  const project = encodeURIComponent(input.projectId);
  let identityId = input.identityId;
  if (identityId === undefined) {
    if (input.displayName === undefined || input.displayName === '') {
      throw new Error('issueInvitation needs a displayName (new identity) or an identityId');
    }
    const created = await apiCall(`/api/v1/projects/${project}/identities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: randomUUID(), displayName: input.displayName }),
    });
    if (created.status !== 201) {
      throw new Error(`create identity failed: ${apiErrorMessage(created)}`);
    }
    identityId = String((created.body.identity as Record<string, unknown>).id);
  }
  const requestBody = buildInvitationRequestBody(input);
  const invited = await apiCall(
    `/api/v1/projects/${project}/identities/${encodeURIComponent(identityId)}/invitations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: randomUUID(), ...requestBody }),
    },
  );
  if (invited.status !== 201 || typeof invited.body.token !== 'string') {
    throw new Error(`create invitation failed: ${apiErrorMessage(invited)}`);
  }
  return {
    identityId,
    invitationId: String(invited.body.invitationId),
    token: invited.body.token,
    scopes: Array.isArray(invited.body.scopes) ? (invited.body.scopes as string[]) : [],
    expiresAt: String(invited.body.expiresAt),
    credentialExpiresAt:
      typeof invited.body.credentialExpiresAt === 'string'
        ? invited.body.credentialExpiresAt
        : (requestBody.credentialExpiresAt as string),
  };
}

// ---------------------------------------------------------------------------
// The approval gate (build step 7, audit row 14) — the desk's list of
// handoffs waiting on the owner. The dispatcher's annotations decide
// what is at the gate (decision needs-owner, no gate decision yet);
// the sender is projected from the project store snapshot, like the
// rest of the desk's state. The gate ACTIONS live in dispatcher.ts
// (they amend annotations in the dispatcher's own store); this is
// only the read.
// ---------------------------------------------------------------------------

export interface GateListItem {
  projectId: string;
  messageId: string;
  /** The annotation's summary — always beside its provenance. */
  summary: string;
  /** The dispatcher's reason for routing this handoff to the owner. */
  reason: string;
  routed_by: string;
  /** Sender identity id from the message record, or null if it is gone. */
  senderId: string | null;
  /** Sender display label from project state (falls back to the id). */
  sender: string | null;
  /** When the dispatcher recorded the needs-owner decision. */
  decidedAt: string;
}

export interface GateListProject {
  projectId: string;
  awaiting: GateListItem[];
}

export async function readGateList(): Promise<{ projects: GateListProject[] }> {
  const projects: GateListProject[] = [];
  for (const projectId of hostedProjectIds()) {
    const awaiting = listAnnotations(projectId)
      .filter((a) => a.decision.action === 'needs-owner' && a.gate === undefined)
      .sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0));
    if (awaiting.length === 0) {
      projects.push({ projectId, awaiting: [] });
      continue;
    }
    const state = await projectState(projectId);
    projects.push({
      projectId,
      awaiting: awaiting.map((a) => {
        const senderId = state.messages[a.messageId]?.senderId ?? null;
        return {
          projectId,
          messageId: a.messageId,
          summary: a.summary,
          reason: a.decision.reason,
          routed_by: a.routed_by,
          senderId,
          sender:
            senderId === null
              ? null
              : (state.identities[senderId]?.displayName ?? senderId),
          decidedAt: a.decidedAt,
        };
      }),
    });
  }
  return { projects };
}

export async function revokeCredential(
  projectId: string,
  credentialId: string,
): Promise<{ credentialId: string; status: string }> {
  const state = await projectState(projectId);
  const cred = state.credentials[credentialId];
  if (cred === undefined) throw new Error(`unknown credential in ${projectId}: ${credentialId}`);
  const result = await apiCall(
    `/api/v1/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}/revoke`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Together's write protocol: entity-targeted writes carry the
      // current revision (read from the store snapshot just above).
      body: JSON.stringify({ operationId: randomUUID(), expectedRevision: cred.revision }),
    },
  );
  if (result.status !== 200) {
    throw new Error(`revoke credential failed: ${apiErrorMessage(result)}`);
  }
  return { credentialId, status: String(result.body.status ?? 'revoked') };
}
