# Fix — Key Desk default scopes (Law 2b UI pass finding, 2026-10-26)

**Finding (source: `ui-pass-2026-10-26/UI-PASS-LOG.md`, screenshot-pass
attempt 1):** issuing a Key Desk invitation with the scopes field left
BLANK minted a credential carrying Together's default scopes — which
do **not** include `help:write` — so the agent's `POST /help` was
refused 403 and the queue stayed empty. The form's blank-default path
produced an agent that cannot do the Hub's central thing.

## Characterization (from source, before the fix)

- **The form** (`hub/src/server.ts`, Key Desk page): a scopes input
  with the label *"Scopes (comma-separated; blank = Together's
  defaults)"* and no prefilled value.
- **The route** (`POST /hub/keydesk/invite`): `field()` returns
  `undefined` for a blank/whitespace field, so a blank form (or a JSON
  body without the key) reached `issueInvitation` with
  `scopes === undefined`.
- **The desk** (`hub/src/keydesk.ts`, `buildInvitationRequestBody`):
  the pre-fix body spread scopes in ONLY when supplied —
  `...(input.scopes !== undefined ? { scopes: input.scopes } : {})` —
  so a blank desk invitation omitted the field entirely. (The F1
  policy had pinned exactly this opt-in shape for
  `credentialExpiresAt`; scopes were never pinned.)
- **Together** (`together-candidate/lib/identity.ts:48-50,453`):
  `body.scopes === undefined ? [...DEFAULT_INVITE_SCOPES] :
  validateScopeList(body.scopes)`, with
  `DEFAULT_INVITE_SCOPES = ['read', 'tasks:write', 'tasks:claim',
  'assignments:write']` — no `help:write`. The minted credential
  inherits the invitation's scopes at exchange, so `POST /help`
  (which requires `help:write`) is refused 403. Exactly the attempt-1
  observation.
- **The working set:** every flow that works names its scopes
  explicitly — UI pass run 2 (artifact `04-invite-a.html`: *"scopes:
  read, help:write"*), the smoke, `probe-handoff.ts`,
  `probe-restart.ts`, `demo-rehearsal.ts` — all use exactly
  `['read', 'help:write']`.

## The desk default + rationale

`HUB_DESK_DEFAULT_SCOPES = ['read', 'help:write']` — read, plus the
one write scope an agent needs to post handoffs, the Hub's central
act. It is exactly the demonstrated working set and no broader: the
Together defaults' task scopes (`tasks:write`, `tasks:claim`,
`assignments:write`) are NOT carried over, because no Hub flow has
demonstrated a need for them through the desk.

## The fix (Hub-side only; `together-src` / `together-candidate` untouched)

- `hub/src/keydesk.ts`: new documented constant
  `HUB_DESK_DEFAULT_SCOPES`; `buildInvitationRequestBody` now ALWAYS
  carries a scope set — the caller's explicit list untouched, or the
  desk default when scopes are omitted (the same always-set shape as
  the F1 `credentialExpiresAt` policy). `IssueInvitationInput.scopes`
  doc updated to match.
- `hub/src/server.ts` (route): an explicitly EMPTY parsed list (a
  cleared form field, a JSON `scopes: []`) is normalized to blank, so
  it also receives the desk default instead of minting a zero-scope
  credential; a non-empty explicit list passes through untouched.
- `hub/src/server.ts` (form): the scopes input is prefilled with
  `read, help:write` and the label text now states plainly that
  clearing the field still issues exactly that default, and why
  (Together's built-in defaults lack `help:write`). No silent
  behavior: the result page already prints the issued scopes, and it
  now prints the default set on a blank submission.

## Verification (2026-10-26, this run)

- `npm run smoke` — **105/105 PASS** (the 100 existing checks
  untouched and green, plus 5 new):
  - shape: a body built with scopes omitted carries exactly
    `HUB_DESK_DEFAULT_SCOPES`;
  - shape: an explicit list passes through the body exactly;
  - end-to-end (own project, so no hub-demo count can move): a
    desk-route invitation with scopes left blank exchanges into a
    credential whose **stored** scopes are exactly
    `['read', 'help:write']`;
  - end-to-end: an explicit `['read']` list is stored exactly;
  - end-to-end: the blank-default credential **POSTs /help with
    201** — the act attempt 1 watched fail.
- `npm run probe:handoff` PASS · `npm run probe:caps` PASS ·
  `npm run probe:restart` PASS.
- `npm run demo:rehearsal` — **could not complete this run, for an
  external reason**: its Hub-side steps all PASS (boot/wired,
  project created, both seats credentialed, deliberate-failure beat
  red), then the run stops at seat A's FIRST live Anthropic call —
  the Anthropic API returns HTTP 400, *"You have reached your
  specified API usage limits. You will regain access on 2026-11-01
  at 00:00 UTC."* Non-regression of the path this fix touches is
  established two ways: (1) the rehearsal always passes explicit
  scopes (`['read', 'help:write']`, `demo-rehearsal.ts:432`), and
  for an explicit list `buildInvitationRequestBody` produces a
  byte-identical body before and after this fix (the
  `credentialExpiresAt` logic is untouched); (2) every Hub-side step
  the rehearsal did run passed. The rehearsal should be re-run once
  the Anthropic limit resets (2026-11-01) to restore its 26/26 —
  flagged for the parent: that reset date sits inside the
  hackathon's final stretch (submissions due Nov 4).

## Self-review (Law 2 — builder's review only; no independent certification claimed)

Files changed: `hub/src/keydesk.ts`, `hub/src/server.ts`,
`hub/scripts/smoke.ts`, `hub/README.md`,
`hidden_files/ui-pass-2026-10-26/UI-PASS-LOG.md` (resolution
appended; attempt-1 history untouched), this note.

Flags:
1. The route now treats an explicit empty scope list (`[]`) as
   blank. A caller deliberately wanting a zero-scope credential
   through the desk can no longer express it — judged a feature (a
   zero-scope credential cannot even read), but it is a semantic
   choice, recorded here rather than hidden.
2. The desk default is a Hub policy, not a Together change — a
   direct Together API client omitting scopes still gets Together's
   defaults, by Together's design (same scope note as F1).
3. The smoke's end-to-end block exercises the desk route with a JSON
   body omitting the key; the form-blank path converges to the same
   `undefined` at `field()` (verified from source), so the two paths
   are the same code from the route inward. A browser-driven
   form-blank submission is not separately re-proven.
4. Demo rehearsal 26/26 is NOT re-claimed for this run — see the
   Anthropic limit above. Smoke + all probes green; rehearsal
   Hub-side green, live-seat legs blocked externally.
