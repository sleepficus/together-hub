# Together Hub — independent fresh-install test (2026-10-28)

## Why this test

The Hub code is finalized and certified on the builder's machine
(smoke 105/105; a builder-side clean-copy boot was proven 2026-10-26).
Before the Meta hackathon upload, an independent seat installs it
cold, from the documents only, on a different machine. If the docs
can't carry a stranger through, that is a finding — report it, don't
work around it silently.

## What's in the package

- `hub/` — the Together Hub (the hackathon build layer).
- `together-candidate/` — the adopted Together source the Hub embeds
  (fixes #1–#4 + F5 + F9; suite 471/471 at adoption). It must sit
  BESIDE `hub/` — the Hub imports it as a sibling.
- `MANIFEST.sha256` — hash of every file (the manifest never lists
  itself).
- `RECEIPT-TEMPLATE.md` — the report format to send back.

No `node_modules`, no `.state`, no `.runtime`, no credentials. If you
find any, stop and report it.

## Rules of the test

- Clean directory. Nothing copied in except this package.
- Follow the documents in the package (`hub/README.md` first).
  Every place you had to guess, improvise, or read source code to
  proceed is a DOC FRICTION finding — write it down verbatim.
- Do NOT set `HUB_DISPATCHER_MODEL` (the model path stays off; this
  test spends nothing).
- Throwaway state only. No real credentials, no real projects.
- Out of scope: creating or pushing any GitHub repo, the demo film,
  the submission itself.

## Steps

1. **Verify the package.** In the package root:
   `shasum -a 256 -c MANIFEST.sha256` (macOS) — every line OK.
   Record the zip's own SHA-256 you received (it is in the hand-off
   note) and confirm the file you opened matches it.
2. **Environment.** Record OS and `node --version`. Requirement:
   Node ≥ 22.18 (the Hub starts unflagged on Node's built-in
   TypeScript support, default-on from 22.18; 22.13 fails the start
   with `ERR_UNKNOWN_FILE_EXTENSION` — reproduced in the r1 test).
3. **Boot the Hub.** `cd hub && npm start`. No `npm install` first —
   the Hub path needs none; if you find you need one, that's a
   finding. Expected: the Hub reports `wired: true` after its boot
   self-check; dashboard on http://127.0.0.1:8940/, embedded API on
   http://127.0.0.1:8937/, seed project `hub-demo`.
4. **Owner surface, in a real browser** (this is the surface the
   owner uses — it must work there, not just over HTTP): open the
   dashboard, sign in through the Key Desk login, confirm the Key
   Desk shows the owner identity. Issue one invitation (leave the
   scopes field blank), exchange it for a credential, post one
   handoff to that agent, then open the receipts view and the
   honest-limits card. Note anything visually broken.
5. **Agent first use (the r2 repair — test it as the newcomer).**
   Take one invitation token and follow `hub/FIRST-USE.md` end to
   end, using only that document: exchange → post a handoff → the
   recipient reads its inbox → accept → answer → check the receipt.
   (The guide is also served at `http://127.0.0.1:8940/hub/first-use`
   and linked from the invitation result page — confirm both links
   resolve.) Any place the guide makes you guess is a finding.
6. **Smoke.** Stop the server. `cd hub && npm run smoke`.
   Expected: **105/105 PASS**. Anything less is a FAIL with the
   failing check names quoted.
7. **Probes (same `hub/` dir):** `npm run probe:handoff`,
   `npm run probe:restart`, `npm run probe:caps` — each PASS/FAIL
   recorded. (Skip `demo:rehearsal` — it makes live model calls.)
8. **Together starter (separate, optional but wanted):**
   `cd ../together-candidate && npm ci && npm run smoke:local` —
   PASS/FAIL. This path DOES need `npm ci`; the Hub path does not.
   Don't confuse the two in the report.

## Pass / fail

- PASS = manifest clean, boot wired:true, browser surface works,
  the FIRST-USE walkthrough completes from the guide alone,
  smoke 105/105, probes pass.
- Any step failing = FAIL for that step, quoted exactly. Partial
  results are useful; a polished summary is not.

## Send back

The filled `RECEIPT-TEMPLATE.md`, plus the terminal output of steps
1, 6 and 7 (files, not screenshots of text). Route it back through
Stephen, as usual.
