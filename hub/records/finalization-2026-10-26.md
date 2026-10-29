# Together Hub finalization — record (2026-10-26)

Stephen's direction (2026-10-26 ~21:47 EDT): "finalize the hackathon
all the code and stuff — make sure to use the Opus if you can — you
can also use a fable as well." Authorization reading, as stated to
Stephen: "finalize + use Opus" = adopt the candidate fixes WITH the
independent auditor's two prescriptions implemented — F5 (policy
version bump) and F9 (per-transition actor rules) — Opus certifies
the result, Fable second-reads independently. NOT in scope (unchanged):
creating/pushing any GitHub repo, the final demo film, the submission
package.

## Step 1 — Adoption prep / state verification

- Pristine `~/workspace/together-hub/together-src`: git-clean, HEAD
  `acfc9aa6feb3ea63cca7c75b774ce0cf8a499091` — verified at start and
  again at the end of this run.
- Candidate tree `~/workspace/together-hub/together-candidate/` carried
  fixes #1–#4 at chain start (records: fix1–fix4-record.md).
- The BUILD-PLAN states no explicit adoption mechanics, so adoption
  followed the chain's fallback: the Hub's embedded Together source
  became the candidate tree, provenance preserved, pristine untouched.

## Step 2 — F5 in candidate (independence policy version bump)

`INDEPENDENCE_POLICY_VERSION` 1 → 2 in `lib/reviews.ts`; header states
v2 supersedes v1 only for new evaluations. Stored v1 reviews keep v1
by construction (policyVersion is written once at creation from the
producing evaluation; every read returns the stored value verbatim —
no migration, no relabelling). Suite pins BOTH behaviors: v2 matrix +
ancestor tests assert `policyVersion: 2` on fresh evaluations; the
dedicated versioning test seeds a stored v1 review and asserts it
still reads 1 (record + public view) while a newly created review
stamps 2. fix1-record.md amended. NOTE: the F5 amendment was recorded
twice in fix1-record.md during parallel finalization (two agents ran
the step concurrently); both sections are kept with a reconciliation
note, and the code diff was verified single and clean (one bump, one
ancestor walk, one header update).

## Step 3 — F9 in candidate (per-transition actor rules)

Fix #3's blanket author-only rule replaced per Job 001 F9. Transition
table (from `lib/changes.ts` TRANSITIONS; `integrated`/`withdrawn`
terminal) and the actor rules as implemented (actor check inside the
command callback, before the legality check; the `changes:write`
scope gate in `command` still applies to every actor first;
"admin" = principal carries the `admin` scope):

| Target | Legitimate actors |
| --- | --- |
| submitted (incl. re-submission) | the author, or a non-author admin |
| withdrawn | the author, or a non-author admin |
| changes-requested | non-author reviewer or non-author admin — never the author (403 `reviewer_required`), even an author holding admin |
| ready-to-combine | non-author reviewer or non-author admin — never the author (403 `reviewer_required`) |
| integrated | nobody via the API — 422 `reserved_state`; reconciler's direct write untouched |

Failing-test-first: the new F9 matrix test + the reworked
forward-only test failed against the blanket rule (exactly those 2 of
18 in `tests/integration.test.ts`); post-fix the file passes 18/18.
fix3-record.md amended (original fix preserved in its history).

Candidate totals after F5+F9: **full suite 471/471 pass, typecheck
PASS** (baseline at acfc9aa was 466; +fix1 ancestor, +fix2, +fix3→F9
matrix, +fix4 allowlist, +F5 versioning = 471).

## Step 4 — Adopt + plumb

- `hub/src/transport.ts` and `hub/src/dispatcher.ts` now import the
  embedded Together source from `../../together-candidate/…` (was
  `together-src`); comments updated to match. Candidate
  `PROVENANCE.md` carries the adoption note.
- allowedOrigins (fix #2's adoption requirement): `startLocalServer`
  now receives `allowedOrigins: dashboardAllowedOrigins()` = exactly
  the dashboard's origins from the Hub's server code — the dashboard
  binds 127.0.0.1 on HUB_PORT (default 8940, `hub/src/server.ts`), so
  `http://127.0.0.1:8940` and `http://localhost:8940` (both spellings,
  mirroring the demo composition's worked example). The API's own
  origin (8937) needs no entry: `assertWriteOrigin` always allows the
  request URL's own origin.
- Against the adopted tree: Hub smoke **100/100 PASS**;
  `probe:handoff` PASS (receipts sha256 recorded in the run output);
  `probe:restart` PASS; `probe:caps` PASS (500-handoff seed);
  demo rehearsal **26/26 PASS** in 24.2s (Spark dispatch REAL, seat A
  REAL, seat B labeled stand-in — same honest cast as rehearsal 1;
  spend ledgered by the script: Spark est $0.0229, seat A est $0.0197).
- Key Desk F1 re-verified in smoke against the adopted tree: desk
  issuance ALWAYS carries `credentialExpiresAt` (Hub default 30 days,
  at Together's cap); the exchanged credential's stored expiry equals
  the invitation's, lifetime in (0, 30 days].

## Step 5 — README fresh-machine install test

As a stranger: copied `hub/` + `together-candidate/` (no `node_modules`,
no `.state`, no pristine tree) to a clean temp dir, followed the Hub
README's documented path only. Result: `npm start` booted on the real
ports, transport **wired: true** (session exchange 201 + authenticated
projects read 200, 1 project), dashboard 200, login page 200, login
POST → 303, Key Desk 200 showing the owner identity. Hub smoke also
ran in the fresh copy's sibling verification (main tree, 100/100).
Friction found and fixed in the README: the "Run it" section stated
neither the Node ≥ 22.13 prerequisite, nor that no `npm install` is
needed for the Hub path, nor that the sibling candidate tree must be
present — all three are now stated there, and this test is recorded
in the README's verification section.

## Step 6 — Law 2b UI pass (the surface Stephen uses)

`hidden_files/ui-pass-2026-10-26/` — driven over HTTP against the REAL
Hub on its real ports, using the exact requests the dashboard's HTML
forms make (the agent driving this chain cannot operate a browser;
**pixel screenshots were not taken and are not claimed** — a
browser-operator screenshot pass remains available to the parent/
crew). 19/19 checks PASS, 0 failures: dashboard home; desk locked
anonymously (401); owner login through the desk login route (303 +
HttpOnly cookie); desk serves for the owner; invitation issued
through the desk form ×2 (token shown once, credential expiry on the
page); both agents exchange at the API; addressed handoff A→B posted;
consequence-line follow-up routed **needs-owner by a REAL Muse Spark
call** with its reason on the record; gate list shows it awaiting;
owner releases it through the desk gate form (303); queue detail
shows the release on the record; B pulls its inbox; receipts view
renders with its sha256 on its face; honest-limits card present;
status wired:true with the declared caps.
Run-1 finding (kept, not a defect): a broadcast help request (no
addressee) materializes NO inbox message in Together — by design in
`lib/inbox.ts` — so it can never reach the queue/gate; the gate beat
was therefore driven exactly as the demo drives it (above).

## Step 7 — Opus + Fable certification

Workbench jobs job-004 (Fable) / job-005 (Opus), --max-output 40000,
every call ledgered in ~/workspace/opus-auditor/ledger.md.

**Fable (job-004, claude-fable-5-1): VERDICT: PASS-WITH-FINDINGS.**
Full text: `~/workspace/opus-auditor/runs/job-004/anthropic--fable/VERDICT.md`
(84,432 in / 21,151 out, est $1.9019). F5 and F9 both CONFIRMED as
faithful to the Job 001 prescriptions (A1–A11); adoption imports and
allowedOrigins CONFIRMED (A13–A15); record reconciliation CONFIRMED
(A17). Builder responses to its findings:

- **A18 (MAJOR) — "adopted tree carries a change outside the recorded
  fix set" (checks command-template allowlist):** the change is real
  and IS recorded — it is **fix #4**, `hidden_files/fix4-record.md`,
  built before this chain began and part of the candidate at chain
  start (step 1). Job-004's input list omitted fix4-record.md, so the
  auditor correctly flagged it from the inputs it was given; the
  adopted set is fixes #1–#4 + F5 + F9, as step 1 and the step-7
  question state. Count check: 466 + fix1 + fix2 + fix3 + fix4 + F5
  versioning = 471. PROVENANCE.md's candidate header already credits
  the fix records collectively; no code change results.
- **A12 (MINOR) — fix3 amendment's scope-gate note:** auditor correct,
  verified in `lib/core.ts` (`requireScope` accepts the `admin` scope
  for any scope). The note is corrected in fix3-record.md with a dated
  correction; the F9 security property is unaffected.
- **A5 (NOTE) — v1 `independent: true` approvals still satisfy
  readiness:** confirmed as the intended F5 semantics (v2 does not
  retroactively disqualify v1 approvals); recorded here so the
  operator knows.
- **A13/A16 (UNVERIFIED tails):** `dispatcher.ts` also imports the
  candidate tree (verified in this run — the auditor was not given
  the file); `server.ts` parses HUB_PORT as an integer 1–65535 and
  refuses to start otherwise, while transport falls back to 8940 on
  an invalid value — the two cannot drift in a running system because
  an invalid HUB_PORT means the dashboard never starts.
- **A15 (NOTE):** transport comment qualified (127.0.0.1 spelling of
  the API self-origin) in `hub/src/transport.ts`.
- **A19:** this record is the file the auditor noted as absent from
  its inputs; it exists and is completed by this section.

**Opus (job-005, claude-opus-5-5): VERDICT: PASS-WITH-FINDINGS.**
Full text: `~/workspace/opus-auditor/runs/job-005/anthropic--opus/VERDICT.md`
(57,974 in / 14,665 out, est $0.5252). Per-item: adoption integrity
CONFIRMED; allowedOrigins CONFIRMED (Hub side); F1 CONFIRMED; F5
CONFIRMED; F9 CONFIRMED; UI-pass evidence CONFIRMED; install-test
record CONFIRMED as consistent (result itself UNVERIFIED from its
inputs — no run output was supplied to the seat); claim discipline
CONFIRMED for the named open items. Its findings were documentation
defects, all corrected the same night (this record + the Hub README):

- **M1** — README verification record lacked the install-test and
  UI-pass entries its pointers referenced: **added** (finalization,
  install-test, UI-pass, and certification entries now in the README
  verification record).
- **M2** — README "NOT proven" still said the fixes' "adoption is a
  later step": **removed**; the Proven section now records the
  adopted tree's 471/471 suite instead of only the 466 baseline.
- **M3** — smoke count 100 vs itemized 96: **reconciled** — the
  itemization now includes the 4 model-path stand-in checks
  (25+24+6+12+17+8+4 F1 +4 model-path = 100), re-verified by direct
  count of PASS lines in this run.
- **M4** — F9 table wording: "reviewer" in the table means **any
  non-author principal passing the `changes:write` scope gate**
  (which `admin` also satisfies); no independence test is applied to
  transition actors. That matches the F9 prescription as written;
  whether reviewer-family transitions SHOULD require F5-style
  independence is a policy question for Stephen, not a defect
  against the prescription — flagged, not silently changed. (Opus
  also notes `ready-to-combine` is not itself the merge gate;
  readiness is.)
- **M5/M6** — UI-pass log: the stale "unaddressed" label corrected
  with a dated addendum, and the addendum prints the decisive fields
  (awaiting messageId; `gate: {action: "released", by: "owner"}`)
  from the saved artifacts, which verify them.
- **N1** — step 5 phrasing: to be plain, the smoke re-runs in this
  chain ran in the MAIN tree; the fresh copy itself proved boot +
  wired + desk. The record now says exactly that (step 5 text
  stands corrected by this note).
- **N3** — receipts count: 15 (post-fix-#1) + 1 (fix #4 allowlist)
  + 1 (F5 versioning) = 17, consistent with both seats' arithmetic.
- **N6** — F1 edge: an explicit `credentialExpiresAt: ""` would pass
  the desk's `??` defaulting and be refused by Together's own
  validation; it cannot mint a non-expiring credential. Noted, not
  changed (the auditor concurs it is not an omission).

**Spend (Anthropic, ledgered in ~/workspace/opus-auditor/ledger.md):**
chain total $2.4468 — Fable job-004 $1.9019 + Opus job-005 $0.5252 +
demo-rehearsal seat-A calls $0.0197. Ledger running total across all
work: $5.0283 of the $100 credit → **$94.97 remaining** (credit
expiry Oct 27 stood as the sanctioned reason to spend tonight).
Meta-side: rehearsal Spark calls est $0.0229 (ledgered by the script)
+ one Spark dispatch call in the UI pass (489 in / 1,264 out, est
$0.0060, receipt on the annotation in
`ui-pass-2026-10-26/09-queue-detail-released.json`).

## Remaining known gaps (unchanged, honestly carried)

- Browser screenshot pass COMPLETED 2026-10-26 (Playwright Firefox,
  VM-local): real-browser pixel evidence for dashboard/status, Key
  Desk sign-in, Key Desk after login, queue, gate awaiting and
  released, receipts, and the honest-limits card — see the
  "Browser screenshot pass" section of
  `ui-pass-2026-10-26/UI-PASS-LOG.md` (files s01–s09 there). The
  browser-rendering half of self-review flag (3) below is closed
  by it; the pass also recorded a defaults observation (a
  blank-scopes desk invitation mints a credential without
  help:write, which is then refused 403 on POST /help).
- Raw-JSON receipts surface (`/hub/receipts` JSON) is not
  owner-session gated the way the HTML view is — known, pre-existing.
- The two-process gate probe (gate behavior across two Hub processes
  sharing one state dir) has not been run; single-process restart
  persistence IS proven (smoke + probe:restart).
- Demo-day list: the final film with the crew's live Codex seat
  (seat B is a labeled stand-in in every rehearsal); GitHub repo
  creation/push still awaits Stephen's explicit go; the submission
  package is a separate step.
- DEMO-DAY claim tags in the submission narrative stay as they are
  until the film exists (see step 8 note in the run report).

## Law 2 self-review (builder)

Built, self-tested, self-reviewed here; certification is the two
independent seats in step 7 — the builder does not certify this work.
Self-review flags: (1) F9's author exclusion on reviewer-family
transitions is absolute even for an author holding admin — deliberate
(it is the F9 Problem-2 closure) and pinned by test. (2) The F9 actor
check runs after Together's `changes:write` scope gate, so an owner
principal without that scope is refused on scope first — unchanged
from fix #3, stated in the fix3 amendment. (3) The UI pass is
HTTP-driven, not browser-driven: the requests are the forms' own, but
rendering/JS behavior in a real browser is not evidenced by it.
(4) allowedOrigins is derived from HUB_PORT at transport start; a
dashboard later rebound to a different port than HUB_PORT declares
would need the env to match — server.ts itself derives its port from
the same env, so the two cannot drift in the shipped composition.
