# Hub build step 4 — first cross-family handoff probe: run summary

**Date:** 2026-10-26 · **Command:** `cd hub && npm run probe:handoff`
(`node scripts/probe-handoff.ts`) · **Result: PROBE PASSED** (20/20
checks), re-run from clean state multiple times with the same verdict.
Smoke after the step: `npm run smoke` **49/49 green**.
`../together-src` git tree verified clean at the end.

**What was proven:** the TRANSPORT AND THE RECORD of one manual
cross-family handoff on the frozen demo task (failing-test fix),
through Together's stock HTTP API — the same surface the repo's CLI/MCP
adapters use. Both seats are **local stand-in processes** with distinct
Key Desk credentials (seat A labeled Claude-side, seat B labeled
Codex-side). Seat B applies the known one-line fixture correction; no
agent judgment was exercised or is claimed. The deliberate-failure beat
belongs to the demo run, not this step.

## Run record (final captured run)

```
PASS hub booted, transport wired — api port 44381
PASS owner created the demo project — project proj-4be27895-04ed-4302-90a9-...
PASS seat A holds its own project-scoped credential — identity f56611b2-...
PASS seat B holds its own, distinct credential — identity 9d3d096b-...
PASS fixture test FAILS before the handoff (frozen demo task precondition) — exit 1: average(4, 6) = 10, want 5
PASS seat A posted the task to seat B through the API — help c00740fb-..., message 435e941f-...
PASS seat B's inbox pull delivers the task (delivery flips to delivered, as designed)
PASS seat B read the task detail (fixture reference + failing test named) — state offered, revision 1
PASS seat B accepted the task — status 200
PASS fixture test PASSES after seat B applies the fix — exit 0: all average() cases pass
PASS seat B posted the result back through the API (test evidence in the body) — reply message e150d6a6-...
PASS seat A pulled its inbox and read the result (delivered, evidence intact)
PASS queue detail shows the full chain, both legs delivered — task delivered -> B, result delivered -> A
PASS receipts page is complete (no event lost to the page cap) — 18 events, latest seq 18
PASS receipts carry the posted leg (help:offered by seat A, with seq) — seq 13
PASS receipts carry the acceptance and the result leg (help:accepted, help:answered by seat B, in order) — accepted seq 15, answered seq 17
receipts sha256 (canonical events JSON, 18 events): acdcbcc5b5775157cbf32b91e808384d695073e85de52bfee21374bc71c3abf0
PASS Key Desk shows seat A's last recorded action at/after the task it posted — lastSuccess operation:help:write (seq 14)
PASS Key Desk shows seat B's last recorded action at/after the result it posted — lastSuccess operation:help:write (seq 18)

--- HANDOFF RUN SUMMARY (stand-in seats; transport + record proven) ---
leg owner: create demo project: HTTP 201, 28.7 ms
leg seat A (Claude-side): owner creates identity: HTTP 201, 11.8 ms
leg seat A (Claude-side): owner issues invitation: HTTP 201, 7.8 ms
leg seat A (Claude-side): seat exchanges invitation for its credential: HTTP 201, 6.0 ms
leg seat B (Codex-side): owner creates identity: HTTP 201, 3.4 ms
leg seat B (Codex-side): owner issues invitation: HTTP 201, 6.3 ms
leg seat B (Codex-side): seat exchanges invitation for its credential: HTTP 201, 3.9 ms
leg A -> B: A posts the task: HTTP 201, 7.2 ms
leg B: pulls its inbox (recording read): HTTP 200, 7.1 ms
leg B: reads the task detail: HTTP 200, 5.5 ms
leg B: accepts the task: HTTP 200, 5.8 ms
leg B: re-reads the task detail (current revision): HTTP 200, 2.3 ms
leg B -> A: B posts the result back: HTTP 200, 18.4 ms
leg A: pulls its inbox (recording read): HTTP 200, 8.4 ms
fixture test before: FAIL (exit 1); after: PASS (exit 0)
events on the project receipt: 18; receipts sha256: acdcbcc5b5775157cbf32b91e808384d695073e85de52bfee21374bc71c3abf0
PROBE PASSED — cross-family handoff flowed end to end through the stock API; the record is complete and hash-complete
```

Notes:

- The receipts hash differs per run (fresh identities, ids, and
  timestamps each run); it is a hash OF that run's complete canonical
  events JSON, which is the workshop sense of hash-complete: the whole
  record, hashed, nothing outside it.
- Chain events on the receipt: `help:offered` seq 13 (A),
  `help:accepted` seq 15 (B), `help:answered` seq 17 (B), with an
  `operation:*` event per confirmed command interleaved (the Key Desk's
  "last recorded action" for a seat is its latest such event).
- Together's write protocol surfaced twice while building this probe:
  entity-targeted writes (accept, answer) require `expectedRevision`,
  and a command's response carries the pre-bump revision — the probe
  re-reads the detail to thread the current revision, exactly as a real
  adapter client must.
