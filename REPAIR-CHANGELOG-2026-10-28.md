# Repair changelog — 2026-10-28 (r2)

For: Chad's independent fresh-install test of the r1 package
(functional PASS on macOS 26.5.2 / Node 22.23.1; docs findings below).
The tested r1 source was preserved before any edit: a byte copy with
a verified manifest (209 files) sits on the builder's side as
`together-hub/pre-repair-2026-10-28/`.

## Finding 1 — no runnable agent walkthrough

**Fixed.** New `hub/FIRST-USE.md`: the complete first-use flow with
runnable curl at every step — exchange the invitation for a
credential → find the recipient → post a handoff → read the inbox
(the recording read) → accept, re-read, answer with the current
revision → check the receipt (timeline + `/hub/queue` +
`/hub/receipts`) — plus the traps (operationId freshness, the
accept response's pre-bump revision, scope and expiry behavior).

Linked from both places asked for:

- README "Run it" now opens with a First use pointer.
- The Key Desk **invitation result page** links it ("Next steps for
  the agent"), and the running Hub serves it at
  `GET /hub/first-use` so the link resolves in the browser, not just
  on disk.

**Self-test (builder, clean copy, throwaway state, model flag
off):** the guide's own curl flow run end to end — 16/16 checks
PASS: boot wired:true, both exchanges, handoff 201, inbox delivery
recorded on the addressed pull, detail revision threading, accept,
answer, the result read back from the poster's inbox, receipts
carrying `help:offered` / `help:accepted` / `help:answered`, queue
listing, `/hub/first-use` serving the guide, and the invitation
result page carrying the link. Hub smoke after the change:
**105/105 PASS** in the same clean copy.

## Finding 2 — README cites records absent from the ZIP

**Fixed, both ways.** The four records the README's claims rest on
are now included under `hub/records/` and the README points there:
`finalization-2026-10-26.md`, `handoff-probe-summary.md`,
`fix-desk-default-scopes-2026-10-26.md`,
`demo-rehearsal-1-2026-10-26.md`. The remaining citations (the
UI-pass artifact directory, the auditor verdict files) are now
labeled in place as builder-workspace records **not included** in
this package.

## Finding 3 — stale package.json description

**Fixed.** The "skeleton / Integration NOT yet proven" description
is replaced with the current one (hackathon build, smoke 105/105,
fresh-install verified 2026-10-28, pointers to README +
FIRST-USE).

## Finding 4 — advertised Node floor too low (Chad's repro)

**Fixed by raising the floor, not by adding a flag** (the
no-install, unflagged start is the feature): `engines` in
`hub/package.json`, the Hub README prerequisites, and the install
test brief now all say **Node ≥ 22.18** — the release where Node
enables TypeScript type stripping by default. Chad's reproduction
stands as the evidence: the shipped source on the actual 22.13.0
binary exits 1 with `ERR_UNKNOWN_FILE_EXTENSION` for `.ts`; 22.23.1
passes the full test. The Hub start command is unchanged and still
needs no `npm install`. (The Together candidate's own floor is
unchanged: its starter and tests run through `tsx`, which does not
depend on type stripping.)

## Boundaries kept

Auth, scope, and expiry behavior untouched (the desk's default
scopes and always-expire policy are as tested in r1). Loopback
defaults unchanged. No live model calls were made for this repair
(the dispatcher model flag stayed off in every test). No public
repo was created or changed.
