# together-hub

**October 29 portable Meta candidate:** start with `META-SETUP.md` for the
bundled helper and private existing-key configuration. The historical
verification records below describe their dated r2/rehearsal runs; current
candidate verification is separate. Default boot remains inference-free.

The Together Hub: a self-hosted hub where Claude-side and Codex-side
agents hand work to each other through one shared, receipted queue,
with a Meta model as dispatcher. This tree is the hackathon build
layer on top of the public Together project — it embeds Together's own
API in-process and adds the dashboard, the Key Desk, the dispatcher
(rules path live; the Meta-model path is wired behind its flag — see
the dispatcher section), and the approval gate where the owner
releases or refuses the handoffs the dispatcher routes to them.
Together is embedded from the **adopted candidate tree**
`../together-candidate` (adopted 2026-10-26 in the finalization run):
the pristine clone `../together-src` at `acfc9aa` plus the four
audited security fixes and the Job 001 F5/F9 finalization amendments,
with provenance preserved in that tree's `PROVENANCE.md` and the fix
records under `records/` in this tree — the finalization record, the
handoff probe summary, the desk-scopes fix record, and the first
demo rehearsal record are included there. The builder's wider
working records (the full UI-pass artifact set, the per-fix working
files) are **not** part of this package; where the text below cites
one, it says so. The pristine clone itself stays untouched and is no
longer what the Hub runs.

Standing claim discipline: the Hub **never wakes an agent**. Together
is pull-only — agents see messages when they call read. Anything the
Hub shows arrived by polling; the poll/refresh path is printed where
it applies.

## Run it

Prerequisites: Node.js ≥ 22.18 (the Hub and the embedded Together API
run on Node's built-in TypeScript support, which Node enables by
default from 22.18 — on 22.13 the unflagged start exits with
`ERR_UNKNOWN_FILE_EXTENSION` for `.ts`; verified by an independent
reproduction 2026-10-28 — **no `npm install` step is
needed for the Hub path**), and this tree's sibling `../together-candidate`
(the adopted Together source the Hub embeds) present beside `hub/`.
Verified from a clean copy in the 2026-10-26 finalization install test
(see the verification record below).

```sh
npm start          # one process, two loopback listeners
npm run smoke      # full smoke (105 checks)
npm run demo:rehearsal  # timed demo rehearsal (live model calls; spends real credit — see records/demo-rehearsal-1-2026-10-26.md)
npm run probe:handoff  # build step 4: first cross-family handoff, end to end
node scripts/probe-caps.ts     # experiment 6: caps at a 500-handoff seed
node scripts/probe-restart.ts  # experiment 4: restart persistence probe
```

**First use — start here once it boots:** `FIRST-USE.md` (in this
tree, and served by the running Hub at
`http://127.0.0.1:8940/hub/first-use`) walks an invited agent from
its invitation token to a completed, receipted handoff — exchange →
handoff → read → receipt — with runnable curl commands at every
step. The invitation result page at the Key Desk links to it.

- Dashboard + Key Desk: `http://127.0.0.1:8940/` (`HUB_PORT`)
- Embedded Together API (agent-facing HTTP): `http://127.0.0.1:8937/`
  (`HUB_API_PORT`) — agents connect here with the stock CLI/MCP
  adapters, using **their own issued credentials** (see Key Desk).
- State dir: `./.state` (`HUB_STATE_DIR`). Owner token:
  `HUB_OWNER_TOKEN`, else `<stateDir>/owner-token`, else generated
  once and saved mode 0600. The token is bootstrap/owner-session
  material only — it is never printed and never appears in
  browser-visible code.
- Seed project: `hub-demo`.

## How it is wired (build steps 1–8)

Topology (audit experiment 1 verdict + delta audit row 2): one
loopback-only Node process. The dashboard reads the embedded Together
API **in-process** via `api.fetch` behind the seam in
`src/transport.ts` (`apiFetch`) — no network hop for Hub reads.
`startTransport()` resolves only after a receipted boot self-check
(session exchange → 201 + authenticated projects read → 200); only
then does status report `wired: true`. The agent-facing HTTP listener
stays up on its own port for the stock adapters; `/api/v1/*` on the
dashboard port is 404 by design.

Read surfaces (`GET`, JSON): `/hub/status` (counts from the
non-recording reads below), `/hub/queue` (index), `/hub/queue/
<projectId>/<messageId>` (detail), `/hub/receipts` (index),
`/hub/receipts/<projectId>/<seq>` (detail). Declared caps in
`HUB_CAPS`: page limits 50/50, index byte budget 64 KiB, detail byte
budget 32 KiB — sized by experiment 6 below.

**The queue read does not record.** Together's HTTP inbox GET is a
*recording* read: `readOwnInbox` / `handleMultiProjectInbox`
(`../together-candidate/lib/inbox.ts`) run inside store transactions that
persist `delivery: 'expired'` onto stale queued mail and stamp every
returned message `delivered`. The dashboard therefore never calls it.
Since build step 4.5 the queue index is **event-log anchored**: from
one `store.read()` snapshot per project, the project's event log
decides which handoffs exist (offered/posted, accepted, answered,
acknowledged, and recorded-handoff lifecycle events), and the current
message record decides each row's state, projected through the same
shared `publicMessage()`-based view the queue detail uses — so index
and detail cannot disagree about a row. No party filter applies:
owner-to-agent, agent-to-owner, and agent-to-agent handoffs all list
uniformly (the step-3 owner-mail projection through `globalInbox` is
retired; it remains available in Together for an owner's own-mail
surface, but it is not the queue). Divergence is handled
conservatively: an anchoring event whose message record is gone
contributes no row (current state is never invented), and a message
record with no anchoring lifecycle event is not listed. Delivery is
recorded only when the addressed reader makes its own API inbox GET —
the smoke proves both halves for an owner-addressed handoff and for
an agent-to-agent one (refreshes leave `delivery: 'queued'`; the
addressed reader's own inbox GET flips it to `delivered`, and the
index then shows it). Receipts were already non-recording
(`lib/events.ts` reads via `store.read()`).

## The Key Desk (build step 3 — identity minimum)

One desk for the human: who has access, to what, until when — and one
place to hand out or take back a key. Access state only; the desk
never scores or ranks agents.

- **Owner session.** `POST /hub/login` performs Together's start-local
  session exchange server-side (`POST /api/v1/session` with the owner
  bearer, in-process) and re-scopes Together's HttpOnly session cookie
  to the Hub origin (`Path=/`; the value is Together's own session
  token). Every Key Desk page/action validates the cookie **live**
  against Together's session store through the seam; `POST
  /hub/logout` revokes it there. Logged-out or expired → 401.
- **Invitations.** The owner issues a single-use, expiring invitation
  for a named agent + project + scope set (optionally creating the
  identity first) — Together's routes `POST …/identities` and `POST
  …/identities/:id/invitations`. The invitation token is shown **once**
  and never stored by the Hub. The agent exchanges it at `POST
  …/enrollment/exchange` for its own project-scoped credential
  (plaintext shown once; Together stores only the hash).
- **Credential lifetime — the desk always sets it (Job 001 finding
  F1).** Together caps a credential's life at 30 days *when the
  issuer sets `credentialExpiresAt`* — but the field is **opt-in**:
  an invitation issued without it mints a credential that **never
  expires**. So the Hub's desk **always** sends the field
  (`buildInvitationRequestBody` in `src/keydesk.ts`): the named Hub
  default is `HUB_CREDENTIAL_TTL_MS` = **30 days**, Together's cap —
  the longest life Together permits, so a desk credential is never
  shorter-lived than allowed, while always expiring. An owner may
  choose a shorter life per invitation (the form's credential-days
  field, or an explicit `credentialExpiresAt`); it passes through
  and Together enforces the cap. **No Hub surface can mint a
  non-expiring credential.** Scope note: this is a Hub-desk policy,
  not a Together change — other clients calling Together's API
  directly can still omit the field, by Together's own design.
- **Desk default scopes** (Law 2b UI pass finding, fixed 2026-10-26 —
  record: `records/fix-desk-default-scopes-2026-10-26.md`):
  scopes are opt-in in Together the same way — an invitation without
  them carries Together's `DEFAULT_INVITE_SCOPES` (read, tasks:write,
  tasks:claim, assignments:write), which do **not** include
  `help:write`, so the invitation form's blank path minted an agent
  whose `POST /help` was refused 403 (UI pass screenshot attempt 1).
  The desk therefore always sends a scope set: the owner's explicit
  list untouched, or the desk default **`read, help:write`**
  (`HUB_DESK_DEFAULT_SCOPES`) when the field is left blank — exactly
  the set every working Hub flow runs on, no broader. The form
  prefills the default and says what blank means; the result page
  prints the issued scopes.
- **Per-agent state** (`GET /hub/keydesk`, `GET /hub/keydesk.json`):
  identity, bound sessions, invitations, credentials (status, scopes,
  project, expiry), **last recorded action** (the identity's latest
  event in the project log — Together appends an event per successful
  command and records none for plain reads), and refusal state.
  **Last refusal is "not recorded"** — Together logs no refused calls
  (authentication failures return before any store write; command
  failures roll back), so the desk separately shows a **standing
  refusal** when the records support one (identity revoked, credential
  revoked — from the revocation events — or credential expiry passed).
- **Revocation.** The desk revokes a credential via Together's route
  (`POST …/credentials/:id/revoke`, with the record's current
  revision). Together rechecks credential status on every request, so
  the revoked credential's next API call is refused — proven in smoke.
- One honest seam: Together deliberately exposes **no HTTP list route
  for credentials or invitations** ("Credentials and invitations are
  never listed or returned — only their hashes exist in state", module
  comment in `lib/identity.ts`). The desk's credential/invitation
  *state* is therefore projected from the project store snapshot the
  embedded API itself exposes (`storeFor`), copying only safe fields —
  never a token hash. Storage, hashing, exchange, and revocation all
  remain Together's own machinery; the Hub reimplements none of it.

## The dispatcher (build step 6 — rules path live; model path wired 2026-10-26)

The dispatcher watches each project's event log and records a routing
decision for every new handoff, as a Hub-side **annotation** — Together's
own records are never rewritten. Labeling is structural (delta audit
row 13): an annotation is a single record, written in a single atomic
store write, that always carries `routed_by`, the routing `decision`,
and the `summary` together — no code path can persist a summary
without its provenance beside it.

- **Annotation store:** `<stateDir>/hub/dispatcher.json`, keyed by
  projectId + messageId: `{ routed_by, decision: { action:
  "deliver" | "needs-owner", to?, reason }, summary, decidedAt,
  eventSeq }`. The `hub/` subdirectory is load-bearing: Together's
  bootstrap scans the state dir's top level for `*.json` and parses
  every file as a project state (throwing on anything else), so
  Hub-owned state lives one level down. Store discipline mirrors
  Together's JsonFileStore: one JSON document, tmp file + atomic
  rename, mode 0600, fail-closed on a corrupt file.
- **Rules router** (deterministic, evidence-only, from one
  non-recording `store.read()` snapshot per tick): (a) the message's
  recipient field names an identity enrolled in the project →
  `deliver` to it, reason states the explicit addressee (plus a
  factual note when the record shows the addressee revoked or
  credential-less — the decision still follows the record); (b) else,
  if the handoff declares required scopes (the record's own `scopes`
  extra, which assignment offers carry) and exactly one enrolled
  identity holds them all through an active, unexpired,
  project-scoped credential → `deliver`, reason states the scope
  match (the owner and the sender are never scope-match candidates);
  (c) else → `needs-owner`, reason states why (no scopes declared,
  zero holders, or multiple holders). The summary is a template
  restatement from the record's own fields only — sender label,
  decision target, message type, first body line truncated at 120
  chars. `needs-owner` is recorded here; the approval gate that
  consumes it is build step 7, below.
- **Processing loop:** runs inside the Hub process on a 1000 ms poll
  (`HUB_DISPATCHER_POLL_MS` overrides), started/stopped with the
  server lifecycle, driven by the same event-anchor resolver as the
  queue index (one implementation in `transport.ts`, two consumers).
  A **persisted per-project watermark** (last processed event seq, in
  the same store document, same atomic write) makes annotation
  exactly-once: restarts resume without duplicates or re-annotation —
  proven in-process in the smoke and across two real processes.
- **Surfaces:** queue detail carries the full annotation as `routing`;
  queue index items carry the compact form (`routed_by` + `decision`,
  plus the `gate` record once the owner has decided — step 7). A
  handoff with no annotation yet shows `routing: { state: "pending" }`
  — absence is shown, never backfilled silently. `/hub/status` gains
  a `dispatcher` block: running state, per-project watermark,
  annotation counts by `routed_by`, the needs-owner count, and the
  gate counts (`released` / `refused` / `awaiting`).
- **Model path — WIRED (2026-10-26), off by default.** With
  `HUB_DISPATCHER_MODEL=on`, each new handoff is routed first by
  **Muse Spark** (`muse-spark-1.3`, Meta Model API) through the
  bundled `scripts/meta-api.py` helper (setup: `META-SETUP.md`). The
  old external connector is no longer required. The route and limits are
  documented separately from the historical experiment 5 record. The model gets
  the standing rules, the handoff's record, and the enrolled roster
  with held scopes, and answers a strict JSON decision. The answer
  is validated against the record before it can label anything (an
  enrolled target other than the sender; non-empty reason and
  summary): a validated success annotates `routed_by: "model"` with
  the model's own summary and the call's receipt (`model_call`:
  response-reported model id, token counts, latency, estimated cost
  at the published rates) on the same record. Any failure — transport
  error, timeout (default 60 s, `HUB_DISPATCHER_MODEL_TIMEOUT_MS`),
  empty content, unparseable or invalid output — falls back to the
  rules router: the annotation keeps `routed_by: "rules"` and
  carries a `model_attempt` record with the failure's code and
  detail. A failed model call never wears the "model" label. With
  the flag off, behavior is exactly the rules-only path above, and
  `/hub/status` reports `modelPath: { flag, wired }` from this
  process's live state (wired = the path is implemented and switched
  on for this run); the honest-limits card's model line is composed
  from that same status and flips with it. The completion cap is
  4000 tokens on purpose: Spark reasons before it answers, and
  experiment 5's 500-token attempt returned no content at all.
  Economics so far: ~$0.004–0.007 estimated per dispatch at the
  published rates, 3–7 s latency (the ledger in
  `~/workspace/opus-auditor/ledger.md` carries every call).

## The approval gate (build step 7 — the front desk's human moment)

A `needs-owner` handoff waits at the gate until the owner decides —
the one write action the desk adds on top of the dispatcher's record.
The gate governs **needs-owner only**; a handoff the dispatcher
already routed (including branch (a), an explicit addressee whose
credential is revoked on the record — Together refuses that call at
call time and the Key Desk shows the standing refusal) never enters
the gate.

- **Gate list.** `GET /hub/keydesk/gate` (owner session required,
  like every desk surface) and the Approval gate section of the Key
  Desk page list each project's waiting handoffs: messageId, the
  annotation's summary, the dispatcher's reason, the sender, and the
  annotation's `decidedAt`, oldest first.
- **Release** — `POST /hub/keydesk/gate/<projectId>/<messageId>`
  with `{action: "release", to: identityId}`. The target must be an
  identity enrolled in the project (else 422). If the target is a
  revoked identity, or holds no active, unexpired credential scoped
  to the project — revoked and expired named in the error — the
  release is **blocked** (409): the desk never knowingly routes into
  a wall, and the owner can reactivate or re-enroll first. On success
  the annotation updates in the same store document, same atomic
  write: the decision becomes `deliver` to the target with reason
  "released by owner (was needs-owner: <original reason>)", and a
  gate provenance object `{action: "released", by: "owner", at, to}`
  is attached. `routed_by` stays `"rules"` — a gate release never
  relabels the routing provenance; the gate record rides alongside
  it, and the dispatcher's `summary`, `decidedAt`, and `eventSeq`
  are not rewritten.
- **Refuse** — the same POST with `{action: "refuse", note?}`. The
  annotation gains `{action: "refused", by: "owner", at, note?}` and
  queue surfaces display the handoff as refused; its decision stays
  `needs-owner` (the dispatcher did route it to the owner). **The
  stored Together message is never edited** — refusal is a Hub
  annotation in `dispatcher.json`; Together's own record stays
  exactly as written, still queued, body intact (the smoke proves
  both halves, including that the project record file carries no
  gate field).
- **Conflicts.** A gate action on a handoff that is not needs-owner,
  or on one already decided, is a 409 conflict with no state change —
  a gate decision stands once made. Unauthenticated gate reads and
  actions are 401.

## The receipts view + honest-limits card (build step 8)

The demo's closing shot: the record, readable. `GET
/hub/receipts?view=page` (or any browser's `Accept: text/html` on
`/hub/receipts`) renders one project's **full** event stream as a
timeline — seq, event type, actor, timestamp, and a one-line
restatement built only from the event's own fields (entity, detail
primitives, result/next-actor fields; no invented prose). The view is
**owner-session gated** like the other desk surfaces (401 without
one); the raw JSON surface at `/hub/receipts` is unchanged — the
probes and the dashboard depend on it as it was.

- **Hash-complete, on its face.** The page header shows the stream's
  sha256 and event count. The hash is `canonicalReceiptsHash`
  (`src/transport.ts`): sha256 over the canonical JSON of the
  project's event records — tagged `{...event, projectId}` exactly
  as the receipts index tags them — sorted by seq. That is byte for
  byte the construction `scripts/probe-handoff.ts` hashes with, so
  the number on the page equals the probe's number for the same
  stream (proven three ways in step 8: the smoke recomputes it
  independently through Together's own events route; a direct
  cross-check of the probe's inline construction against the helper
  agreed; and a 120-event stream paged at two different page sizes
  hashed identically). The full stream is read by cursor-paging the
  events route past its 100-event page limit — the 50-item receipts
  *index* cap does not truncate the view.
- **The honest-limits card** sits on the same page (and is linked
  from the Key Desk): pull-only — nothing wakes an agent; per-attempt
  refusals are not recorded anywhere (the desk shows standing refusal
  state and "not recorded", per Stephen's Oct 26 decision); the
  dispatcher model path's live state; loopback-only / single host /
  single process / local-file state; dispatcher + gate annotations
  are Hub-side records that never edit Together's records; and the
  hash covers this page's stream only. Lines whose fact can change
  (model path, API port, state dir) are composed from live state
  (`getTransportStatus()` / `getDispatcherStatus()` — the same
  values `/hub/status` prints) at render time, never hardcoded: since
  the model path landed (2026-10-26) the model-path line flips with
  the run's flag state — "wired" on a `HUB_DISPATCHER_MODEL=on` boot,
  "NOT wired" on a default boot — and the pull-only line names the
  wake (a human prompt or an agent-side polling heartbeat, both
  outside the Hub; Job 001 finding F14).

## Verification record

- `npm run smoke` — **105/105 checks green** (Oct 26, 2026; the
  count was 100 through the finalization run, Oct 26–27, and grew by
  the 5 desk-default-scopes checks below): the 25
  step-2 checks (transport wired, self-check, caps declared, demoted
  namespace 404, bad-token 401s, clean shutdown), 24 step-3 checks
  (Key Desk 401s without a session, login exchange sets the HttpOnly
  cookie, invite → exchange → credential works, credential reads its
  own project (200) and is refused on another project (401,
  `unauthenticated` code surfaced), agent handoff reaches the queue,
  queue reads are non-recording across refreshes, the addressed
  reader's own inbox GET records delivery, queue + receipt detail
  reads return exactly one record (absent seq → 404), Key Desk lists
  the issued state with last action recorded and last refusal "not
  recorded", revoke → next call 401, desk shows the standing refusal,
  logout revokes the session server-side), plus 6 step-4.5 checks: a
  second agent is enrolled, the first agent posts to it directly, and
  the agent-to-agent handoff is present in the queue INDEX itself —
  non-recording across two reads, parties and delivery state in
  agreement with the detail surface, flipping to delivered only on
  the addressed peer's own inbox GET — plus 12 step-6 checks: a
  scope-distinct third agent is enrolled; both addressed handoffs
  gain dispatcher annotations (`routed_by: "rules"`, deliver to the
  named addressee, template summary with provenance on the same
  record; index items carry the compact routing); the model path
  answers a typed NOT-WIRED; `/hub/status` carries the dispatcher
  block; then, after an in-process stop, three unaddressed handoff
  records are seeded into the project state file and the Hub boots
  again on the same state dir — the unique-scope-holder record is
  delivered to that holder, the two-active-holders and no-scopes
  records land `needs-owner`, an unanchored record stays `pending`,
  the phase-1 annotation is byte-identical (same `decidedAt` +
  `eventSeq`), and the persisted watermark sits at the log end —
  plus 17 step-7 checks: on the second boot the owner signs in and
  works the approval gate — the gate list and gate actions refuse
  401 without a session; the list shows both seeded needs-owner
  handoffs with summary, dispatcher reason, sender, and `decidedAt`;
  a release into the first agent's revoked credential is blocked
  with the record's reason and changes nothing; a release to an
  unenrolled identity is 422; a clean release to the solo agent
  lands `deliver` with the release and the original reason stated,
  gate provenance attached, `routed_by` still `"rules"`, and the
  dispatcher's `decidedAt` untouched, visible in queue detail and
  index alike; a refusal lands its gate record (with the owner's
  note) while Together's message record stays queued and intact and
  the project record file carries no gate field — gate state exists
  only in the Hub's `dispatcher.json`; a second action on a decided
  handoff and any gate action on an already-delivered handoff
  conflict 409; `/hub/status` reports gate counts (released 1,
  refused 1, awaiting 0); and a third boot proves both decisions
  persist with the annotation count still exactly 5 — plus 8 step-8
  checks: the receipts page is 401 without an owner session; with
  one it renders the smoke's own events as a timeline; the sha256 on
  its face equals a hash the smoke computes independently (Together's
  own events route paged through the seam, canonical construction as
  in probe-handoff — page and computation agree exactly; the value
  itself is per-run, since ids and timestamps differ) and the
  displayed count is the full stream length;
  the timeline's restatements come from the events' own fields (the
  help:offered row names the smoke's handoff message); the
  honest-limits card carries the pull-only and refusal-not-recorded
  lines and its model-path line matches `/hub/status` at runtime;
  the Key Desk page links the view; `Accept: text/html` serves the
  page while the raw JSON surface is unchanged; an unknown project
  is 404 — plus 4 Job-001-F1 checks: the desk's issuance request body
  is shape-asserted to ALWAYS carry `credentialExpiresAt` (Hub
  default 30 days; an explicit shorter value passes through exactly),
  the desk-issued invitation carries the field ~30 days out, and the
  exchanged credential's stored state expires exactly at that
  timestamp, a lifetime of (0, 30 days] from its creation — plus 4
  model-path stand-in checks: a validated stand-in decision wears
  `routed_by: "model"` with its call receipt on the record, a failed
  stand-in call falls back to the rules decision with the attempt
  recorded, `/hub/status` reports the flag on + wired, and the
  honest-limits card flips truthfully on the wired boot — plus 5
  desk-default-scopes checks (2026-10-26, the Law 2b UI pass fix):
  the issuance body is shape-asserted to ALWAYS carry a scope set
  (an explicit list exactly, or `HUB_DESK_DEFAULT_SCOPES` when
  omitted), and in its own project a blank-scopes desk invitation
  exchanges into a credential whose stored scopes are exactly
  `read, help:write`, an explicit list is stored exactly as
  supplied, and the blank-default credential POSTs `/help` with 201. The desk page's own gate section and its browser forms
  (urlencoded release/refuse → 303 back to the desk, decisions
  landed, gate then empty) were additionally exercised end to end
  against a live boot, as was the receipts page itself (login →
  seeded event → rendered timeline + card with live port/state-dir
  values).
  Dispatcher exactly-once was additionally proven across two real
  processes (second boot: same single annotation, identical
  `decidedAt`).
- Experiment 6 (`node scripts/probe-caps.ts`, 500 synthetic handoffs
  seeded into a throwaway state dir — message records plus their
  anchoring lifecycle events, as the event-anchored index requires):
  page 1 = 50 items, **20,168 bytes vs the 64 KiB budget, 8.6 ms**;
  cursor walk reaches all 500 over 10 pages in 37.9 ms; one detail
  read = 400 bytes, 4.8 ms. **Caps confirmed, no adjustment** — the
  50-item page cap stands with ~3× byte headroom at this body size.
- Experiment 4 (`node scripts/probe-restart.ts`, two real processes,
  one throwaway JsonFileStore dir): credential issued + exchanged in
  process 1 still authenticates in process 2 (200); credential active,
  invitation exchanged, last recorded action identical
  (`operation:help:write` + timestamp), queued handoff intact.
  **Persistence confirmed.**
- A direct boot on the default ports with a curl pass over the login
  flow (login page 200 → desk 401 → login 303 + cookie → desk 200
  showing the owner identity; `keydesk.json` returns the desk state)
  was run Oct 26, 2026.
- Build step 4 (`npm run probe:handoff`, **23/23 checks** — the 21
  step-4/4.5 checks plus 2 step-6 dispatcher assertions: both legs of
  the chain annotated `routed_by: "rules"`, deliver to the named
  addressee, summary with provenance on the same record —
  re-runnable from clean state): the first
  cross-family handoff flowed end to end through Together's stock
  HTTP API on the frozen demo task (failing-test fix). Two local
  stand-in seats with distinct Key Desk credentials (A labeled
  Claude-side, B labeled Codex-side): A posts the task → B's inbox
  pull records delivery → B reads the detail, accepts, applies the
  known one-line fixture fix (test exit 1 → 0), answers with the test
  evidence in the body → A pulls and reads the result. The queue
  INDEX and the queue detail show the whole chain at every stage —
  each leg listed with correct parties, `queued` across repeated
  non-recording index reads until the addressed seat's own inbox pull
  records `delivered`, index and detail in agreement throughout — and
  the event log carries it (`help:offered` → `help:accepted` →
  `help:answered`, each with seq), both seats' Key Desk last recorded
  actions sit on the record, and the run's receipts page is hashed
  (sha256 over the canonical events JSON). Run record:
  `records/handoff-probe-summary.md`.
  Proven here: transport + record. NOT exercised: live-agent judgment
  (the seats are stand-ins; B's fix is scripted), the Mac seats, the
  deliberate-failure beat (that belongs to the demo run).
- `../together-src` git tree verified clean after every step
  (finalization run included: clean at start and end, HEAD `acfc9aa`).
- **Finalization (Oct 26, 2026)** — record:
  `records/finalization-2026-10-26.md`. The candidate tree
  (fixes #1–#4 + Job 001 F5 policy-version bump + F9 per-transition
  actor rules; suite **471/471**, typecheck PASS) was ADOPTED as the
  Hub's embedded Together source, with the dashboard's origins
  (`http://127.0.0.1:8940`, `http://localhost:8940`) passed through
  the embedded API's `allowedOrigins`. Against the adopted tree:
  smoke 100/100, `probe:handoff` / `probe:restart` / `probe:caps`
  PASS, demo rehearsal 26/26 PASS (same honest cast as rehearsal 1).
- **Fresh-machine install test (Oct 26, 2026, finalization step 5):**
  `hub/` + `../together-candidate` copied to a clean temp dir (no
  `node_modules`, no `.state`, no pristine tree); following this
  README's documented path only, `npm start` booted on the real
  ports, earned `wired: true`, served the dashboard (200), the login
  page (200), login POST → 303, and the Key Desk (200, owner
  identity shown). No install step was needed.
- **UI pass (Oct 26, 2026, finalization step 6):**
  `ui-pass-2026-10-26/` in the builder's workspace records (not
  included in this package) — 19/19 checks PASS over
  HTTP against the real Hub on its real ports, using the exact
  requests the dashboard's HTML forms make (owner login, desk-form
  invitations ×2, exchanges, addressed handoff, a REAL Spark-routed
  needs-owner gate item released through the desk gate form,
  receipts view + honest-limits card). Pixel screenshots were NOT
  taken (the driving agent cannot operate a browser) and are not
  claimed.
- **Certification (finalization step 7):** Fable second read
  (workbench job-004) **PASS-WITH-FINDINGS**; Opus certification
  (job-005) **PASS-WITH-FINDINGS** — both seats confirmed the code
  (adoption, allowedOrigins, F1, F5, F9); their findings were
  documentation defects in this README/record set, corrected the
  same night. Full verdicts under `~/workspace/opus-auditor/runs/`.
- **Desk default scopes fix (Oct 26, 2026)** — record:
  `records/fix-desk-default-scopes-2026-10-26.md`. The Law
  2b UI pass's attempt-1 finding (blank scopes field → Together's
  defaults → no `help:write` → `POST /help` 403) is fixed Hub-side:
  the desk always issues its default scope set (`read, help:write`)
  when scopes are left blank, and the form shows the default.
  Smoke 105/105, all probes PASS. The demo rehearsal was re-run the
  same night and its Hub-side steps passed, but the run could not
  complete: seat A's live Anthropic calls return a usage-limit 400
  ("regain access on 2026-11-01") — external to this fix (the
  rehearsal passes explicit scopes, for which the issuance body is
  unchanged); its 26/26 stands as of rehearsal 1 + the finalization
  run and is to be re-earned after the limit resets.

## Proven vs not (kept honest on purpose)

Proven: the embedded-API wiring and boot self-check; API-backed
queue/receipts index + detail reads that record nothing; the Key Desk
identity minimum end-to-end in smoke (session, invitation, exchange,
scope refusal, revocation, restart persistence); every desk-issued
credential carries an expiry at or under 30 days — the desk always
sets `credentialExpiresAt` (Job 001 F1), so desk credentials always
expire; and every desk-issued credential carries a working scope
set — the desk always sends scopes (the owner's list, or the desk
default `read, help:write` when blank), so a blank form can no
longer mint an agent unable to post handoffs; caps hold at a
500-handoff seed; one manual cross-family handoff end to end on the
frozen demo task through the stock API, with stand-in seats (step 4,
above); the dispatcher's RULES path end to end (step 6, above):
addressed, scope-matched, and needs-owner routing with structural
provenance labels, exactly-once across restarts; the APPROVAL GATE
end to end (step 7, above): owner-session gate list, blocked /
conflicted / clean releases, refusals recorded as Hub annotations
with Together's records untouched, decisions persisting across
restarts, and the desk page's own forms exercised in a live boot;
the RECEIPTS VIEW + HONEST-LIMITS CARD (step 8, above): the
owner-gated timeline renders a project's full event stream with
field-only restatements, its displayed sha256 proven equal to an
independently computed canonical hash (including past the events
route's 100-event page limit), and the card's changeable lines read
from live state; the ADOPTED candidate tree's own suite at
**471/471** with typecheck PASS (finalization run, Oct 26, 2026:
pristine baseline 466 at `acfc9aa`, + fixes #1–#4, + the Job 001
F5 versioning test; F9 replaced the fix-#3 test in place). The dispatcher's MODEL path
(wired 2026-10-26): a live Spark call through the connector earned
`routed_by: "model"` on a real handoff annotation with its call
receipt on the record (Part A verification); the smoke's stand-in
phase pins the labeling discipline (validated success → "model";
failure → rules fallback with the attempt recorded; flag off →
unchanged). DEMO REHEARSAL 1 (2026-10-26, record in
`records/demo-rehearsal-1-2026-10-26.md`): the frozen chain
run timed, end to end — Spark dispatch REAL, seat A (Claude-family)
REAL, seat B a labeled scripted stand-in — 26/26 checks, 24 events,
receipts sha256 on the face of the view and matching the stream.

NOT proven: a handoff carried by a LIVE Codex-side agent seat (the
rehearsal's seat B is a stand-in — transport and record exercised,
its judgment not claimed; the live seat is a Mac-side/crew step for
the final film); the final demo itself (rehearsal evidence only —
no demo-day claim is earned by it). The repo has not been created or pushed.
