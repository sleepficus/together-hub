# Demo Rehearsal Run #1 — 2026-10-26 (timed, with receipts)

**This is a rehearsal. It is not the final film, and it earns no
DEMO-DAY claim.** Its purpose was to run the frozen demo chain once,
end to end, timed, and learn what breaks before a camera is involved.
It also carried Part A of this build step: wiring the dispatcher's
model path live. Both parts are recorded here.

Run artifacts: `demo-rehearsal-1-run.json` (machine record: every leg,
check, annotation, and call receipt). Script:
`hub/scripts/demo-rehearsal.ts` (`npm run demo:rehearsal`).

---

## Part A — the dispatcher model path is WIRED

**Design.** With `HUB_DISPATCHER_MODEL=on`, each new handoff is routed
first by Muse Spark (`muse-spark-1.3`) through the Meta connector
helper (`meta_model_api.py chat`) — the same route, model, and cap
discipline experiment 5 proved (max_tokens 4000; the 500-token cap
returned null content there because reasoning eats the budget first —
that trap is now named in the failure code's detail text). The prompt
carries the standing rules (named addressee delivers; consequence
line — destructive / credential / irreversible → needs-owner; unique
scope match; never back to the sender), the handoff's record, and the
enrolled roster with held scopes (the same scope computation the
rules router uses).

**Labeling (the honesty contract).** An annotation earns
`routed_by: "model"` ONLY when a real call returns a decision that
validates against the record (enrolled target other than the sender;
non-empty reason and summary). The annotation then carries the call's
receipt (`model_call`: response-reported model id, input/output
tokens, latency, estimated cost at the published rates) in the same
single record as the decision and summary — row 13's structural rule,
extended to the model path. On ANY failure — helper error, timeout
(60 s default), empty content, unparseable or invalid output — the
dispatcher falls back to the rules router: the annotation keeps
`routed_by: "rules"` and gains a `model_attempt` record (code,
detail, and the call receipt when the call completed). **A failed
model call never wears "model."** With the flag off (the default),
behavior is byte-for-byte the pre-wiring rules path, and
`routeWithModel` answers the typed `not_wired` result.

**Status + card.** `/hub/status` `modelPath.wired` now reports this
process's live state (implemented AND flag on) instead of a hardcoded
false; `byRoutedBy.model` counts real model annotations. The
honest-limits card — composed from that status — flips truthfully:
verified in the smoke on both boots (off: "NOT wired"; on: "wired",
flag "on"). The card's pull-only line also now **names the wake**
(Job 001 F14): a human prompt or an agent-side polling heartbeat,
both outside the Hub — the dashboard's pull-only paragraph says the
same.

**Live verification (before the rehearsal).** A throwaway boot with
the flag on and NO stand-in: one API-posted handoff, one drain. The
annotation came back `routed_by: "model"`, deliver to the named seat,
with Spark's own reason ("Named addressee verify-seat-b is enrolled
and active, and fixing math.js is not destructive, credential-related,
or irreversible") and receipt: muse-spark-1.3, 491 in / 1071 out,
4,635 ms, est. $0.0052 — logged to the workbench ledger.

**Smoke.** Extended with a fourth boot (flag on, stand-in transport
injected through the dispatcher's test seam — no live spend): a
validated stand-in decision annotates "model" with the stand-in's own
summary + receipt; a throwing stand-in falls back to rules with
`model_attempt` on the record; status and the limits card flip.
**Smoke 100/100** (the 96 prior checks untouched and green, plus 4
new). Probes: handoff 23/23, caps PASS, restart 6/6.

---

## Part B — rehearsal run #1

### Cast (labels worn openly)

| Seat | Who | Reality |
|---|---|---|
| Dispatch | Muse Spark (muse-spark-1.3) via the Meta connector | **REAL** — the wired dispatcher, no stand-in |
| Seat A (poster) | claude-sonnet-5-5 via the Anthropic connector helper | **REAL** — composed both help requests and the closing verdict |
| Seat B (fixer) | scripted stand-in, labeled Codex-side | **STAND-IN** — no Codex API route exists on this machine; transport + record exercised, judgment NOT claimed. The live Codex seat is a Mac-side/crew step for the final film |
| Owner (gate) | the runner, through the real Key Desk gate routes with a real owner session | **REAL routes** |

### The wake (F14, named)

Together is pull-only; the Hub wakes no one. In this rehearsal **the
runner script is the wake**: it invoked seat A's model calls and
performed seat B's inbox pulls at the scripted beats. For live agents
the wake is a human prompt or an agent-side polling heartbeat. The
honest-limits card states this on its face (verified in this run's
rendered receipts view).

### Timeline (wall clock 28.2 s end to end; 26/26 checks PASS)

| t | Leg | Result |
|---|---|---|
| 0.0 s | Hub boot (flag on), transport self-check | wired; modelPath {flag: "on", wired: true} |
| 0.1 s | Owner creates project; seats A + B enrolled via Key Desk flow (identities, invitations with `credentialExpiresAt` set, exchanges) | both seats hold distinct project-scoped credentials |
| 0.2 s | **Deliberate-failure beat:** fixture test run | **exit 1 — `average(4, 6) = 10, want 5`** (red by design) |
| 0.2–5.6 s | Seat A (REAL) composes the fix request | 1,352 chars, sonnet-5-5, 5,399 ms |
| 5.6 s | A posts the fix request ONCE (API, A's credential, addressed to B) | 201 |
| ≈5.6–10.6 s | **Dispatch (REAL Spark)** | annotation: `routed_by: "model"`, deliver → seat B; reason: "Named addressee seat-b-codex-worker is enrolled and active, and fixing the average function is reversible and does not delete data or change credentials." Receipt: 813 in / 1158 out, 5,017 ms, est. $0.0059 |
| 10.7 s | Seat B (stand-in) pulls inbox (recording read) → detail → accept | delivery flips to delivered, as designed |
| 10.9 s | B applies the one-line correction `(a + b) / 2`; test re-run | **exit 0 — all average() cases pass** |
| 10.9 s | B answers with command + exit-code evidence; A pulls its inbox | reply delivered to A |
| 10.9–15.7 s | Seat A (REAL) composes the consequence-line follow-up (wipe the shared state directory + re-issue all credentials) | 515 chars, 4,871 ms |
| 15.7 s | A posts the follow-up | 201 |
| ≈15.7–21.4 s | **Dispatch (REAL Spark)** | **`needs-owner`**: "…the request to wipe the shared state directory and revoke/re-issue all credentials crosses the consequence line for destructive and credential-changing actions." Receipt: 579 in / 1581 out, 5,705 ms, est. $0.0074 |
| 21.4 s | **Gate beat:** owner signs in (real session exchange); gate list shows the follow-up awaiting; owner releases it to seat B | decision flips to deliver; `gate: {action: "released", by: "owner", to: seat B}` attached; **`routed_by` stays "model"** |
| 21.5 s | B pulls post-release, accepts, answers | the stand-in's answer acknowledges the release as the authorization evidence and expressly does NOT perform or pretend the destructive step (throwaway state; no real credentials exist in it) |
| 21.5 s | A pulls the released-leg result | delivered |
| 21.6–24.9 s | Seat A (REAL) writes the closing verification verdict | 810 chars, 3,304 ms (quoted below) |
| ≈25–28 s | Receipts: full stream read + receipts view rendered and hash-checked | **24 events; sha256 `aad5921241c0121f2ecfb4f33d2b8d5f42eafe4fde5f5798c09f305198056246`** — the view's face hash equals the stream hash; the card reads model-wired and names the wake |

Final dispatcher state for the project: 4 annotations, **all
`routed_by: "model"`** (both tasks AND both replies — the dispatcher
routes replies too), 1 gate release, watermark 24.

Seat A's closing verdict, verbatim (unprompted, it audits its own
chain — including that seat B's report is self-reported and that it
did not inspect math.js itself):

> Verdict: The handoff chain did what it claimed for the fix itself.
> The fixture test went from exit 1 (average(4, 6) = 10, want 5)
> before the handoff to exit 0 (all average() cases pass) now, which
> matches seat B's reported change to `(a + b) / 2` and its
> before/after evidence. The consequence-line follow-up was routed to
> the owner, released at the Key Desk gate, and acknowledged. The
> authorization rests on the gate record on the dispatcher
> annotation, and seat B did not perform the destructive step. That
> is consistent with its scripted stand-in role and the throwaway
> state directory, so the transport and record were exercised here,
> but the live destructive leg was not. Seat B's report of the change
> is self-reported, and I did not inspect math.js directly, but the
> independent test re-run supports it.

### Spend (from the responses' own usage; estimates at published rates; all rows in `~/workspace/opus-auditor/ledger.md`)

| Provider | Calls | Tokens | Est. cost |
|---|---|---|---|
| Meta / muse-spark-1.3 (dispatch ×4) | 4 | 2,529 in / 5,132 out | $0.0250 |
| Anthropic / claude-sonnet-5-5 (seat A ×3) | 3 | 1,111 in / 1,178 out | $0.0210 |
| Part A live verification (Spark ×1) | 1 | 491 in / 1071 out | $0.0052 |

Anthropic credit position after this step: **$2.5815 of $100 spent**
($97.42 remaining, expiry Oct 27). Meta priced subtotal: $0.0786.
Per-dispatch Spark cost on rehearsal-sized prompts ran $0.0043–0.0074
(fuller roster/record prompts than experiment 5's, and reasoning
length varies) — above experiment 5's $0.0030 on its minimal prompt;
latency 3.2–6.6 s per dispatch.

### What broke, and what surprised

1. **Attempt 1 died on a keep-alive race — a real find.** The first
   rehearsal attempt crashed with ECONNRESET on the post right after
   seat A's compose call. Reproduced in isolation: the runner's
   pooled fetch socket idled across a multi-second model call
   (attempt 1 also blocked the event loop with a synchronous spawn),
   past the embedded server's default 5 s keep-alive timeout, and
   the next request rode the dying socket. Fixes, both in the
   runner: seat calls are now async (the Hub's loop never freezes —
   a runner that freezes the Hub it measures is wrong anyway), and
   the HTTP wrapper retries a network error once on a fresh
   connection (safe: every write carries an operationId, which
   Together's command layer dedupes). **Demo-day relevance: any real
   adapter that reuses connections across long thinking gaps can hit
   the same race against stock server defaults — adapters should not
   pool across idle gaps, or should retry once.**
2. **Spark needed no contingency.** The gate leg landed needs-owner
   on the first, unescalated scenario; the scripted leg-2b escalation
   path exists but was not used.
3. **Dispatch latency is the pacing fact for the film.** Each Spark
   dispatch is 3–7 s of visible thinking (reasoning-heavy: 846–1,581
   output tokens per call). Four dispatches ≈ 20 s of the 28 s run.
   The film's narration must be written over dispatch, not around it.
4. **Seat A graded its own chain honestly** (verdict above) — it
   flagged the stand-in's self-report and its own non-inspection
   without being asked. Good texture for the film; keep the seat A
   verdict step in the final script.
5. **The gate is a record, not a lock (F16, still open).** Together
   delivers messages regardless of the Hub-side gate annotation; the
   rehearsal's pull-after-release order is the demonstrated protocol,
   not enforcement against a stock adapter that pulls early. The
   record says so; the final demo must not claim more.
6. **Accounting caveats (disclosed, not hidden).** Attempt 1's seat A
   compose call succeeded before the crash; its usage record died
   with the process and is NOT in the ledger (est. ~$0.009 by
   similarity to run 2's identical call — an estimate, kept out of
   the ledger because the response's own numbers are lost). Two
   throwaway repro runs during debugging also ran with the flag on;
   the no-block repro posted one handoff and exited in under a
   second, before a dispatcher call could complete locally — no
   annotation or usage was captured; if a call was started
   server-side it is unlogged (bounded by one dispatch, ~$0.007).

### What the final demo still needs (the rehearsal's real product)

1. **A live Codex-side seat B** (Mac-side/crew): seat B's judgment is
   the one cast member still unexercised. Until then the demo's
   cross-family claim covers Claude + Meta live, Codex by stand-in.
2. **The film itself**: narration written over the 3–7 s dispatch
   beats; the seat A verdict step kept; the wake named in the
   narration (the film must show what prompts each pull, per F14).
3. **Candidate-tree adoption** before filming anything that claims
   the four security fixes (the Hub still runs the pristine tree;
   adoption + its `allowedOrigins` plumbing is its own step), and a
   fresh-machine README install test + the Law 2b browser UI pass.
4. **A two-real-process gate probe** (step 7's standing flag) if the
   film leans on restart-persistence of gate decisions.
5. **Demo-day dispatch economics**: budget ≈$0.03 of Meta credit and
   ≈$0.02 of Anthropic credit per full run at rehearsal sizes; the
   $100 Anthropic credit expires Oct 27 — the film's seat A calls
   need a funding answer that survives that date.

---

## Self-review (Law 2 — builder's own; independent audit still owed)

**Files changed (this step only; all inside `hub/` plus the ledger
and this record):**

- `hub/src/dispatcher.ts` — model path implemented (prompt builder,
  helper transport with timeout, output validation, `routeHandoff`
  with honest fallback, `model_call` / `model_attempt` record fields,
  status counts + live `wired`); shared `heldScopesByIdentity`
  extracted (rules behavior unchanged).
- `hub/src/server.ts` — honest-limits pull-only line names the wake
  (F14); dashboard pull-only line likewise. The model-line flip is
  composed from status, as before — no card text hardcodes the state.
- `hub/scripts/smoke.ts` — phase-1 probe call site moved to the new
  `routeWithModel` signature (same assertion); phase 4 added (4
  checks). Header updated.
- `hub/scripts/demo-rehearsal.ts` — NEW. The rehearsal runner above.
- `hub/package.json` — `demo:rehearsal` script; README updated
  (dispatcher section, run list, limits paragraph, verification
  record + NOT-proven paragraph rewritten to current truth).
- `~/workspace/opus-auditor/ledger.md` — 1 (Part A) + 7 (rehearsal)
  rows appended, each from its response's own usage.

**Counts.** Smoke **100/100** (96 prior + 4 new). probe:handoff
23/23, probe:caps PASS, probe:restart 6/6. Rehearsal 26/26 checks,
28.2 s wall. `together-src`: git-clean at `acfc9aa` at start AND end
of this run — untouched. `together-candidate`: untouched by this run
(no writes; it has no .git — the files in it newer than BUILD-PLAN
are today's earlier fix work, not this step's). Together's own suite
was not re-run: nothing it ships changed, and the Hub-side suites
above exercise it through the seam.

**Flags for the independent auditor.**

1. `modelPath.wired` semantics: wired = implemented AND flag on for
   this process (chosen so the pre-wiring smoke assertions stayed
   literally true). An auditor may prefer wired=implemented with a
   separate enabled field; the card text keys off the same value.
2. The model prompt's consequence rule is prompt-level instruction;
   enforcement is validation of the OUTPUT shape only. Spark followed
   the rule in 4/4 rehearsal calls + 1 verification call — a sample,
   not a guarantee; the gate beat in the final film depends on it
   landing again (the script's leg-2b escalation is the contingency).
3. Fallback annotations persist `model_attempt` in dispatcher.json —
   including helper stderr fragments in `detail` (capped at 300
   chars at the throw site). No credential material transits the
   helper's stdout/stderr by construction (surrogate auth), but the
   auditor should confirm nothing sensitive can ride that field.
4. Estimated costs use third-party-quoted Meta rates (experiment 5
   caveat) and published Sonnet rates; token counts and latencies are
   response facts, dollars are estimates everywhere they appear.
5. The two accounting caveats in "What broke" §6 — attempt 1's lost
   usage row and the repro runs — are disclosed there; the ledger is
   complete for every call whose response was captured.
