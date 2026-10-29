# Hosted verification — October 14, 2026

The newer release was deployed to a separate Cloudflare Worker and exercised with a disposable project. The original October 4 deployment and its records were preserved.

## Deployment identity

- Preview: https://together-preview-20261014-db409c.simplesoftware-27f.workers.dev
- Final runtime source: `21a11cf557c0e44c5d7b2c134b8c2edffc2a8736`.
- Final Worker version: `f762aa15-7095-4f6d-a52d-2628f683d371`.
- Workers serves the protected browser/API; four SQLite Durable Objects hold state; the separate Artifacts namespace stores the test repository and forks.
- The preview requires an owner session. No owner credentials or private original records are distributed. Run your own local workspace using README.md, or provision your own account using DEPLOYMENT.md.

## Actual collaboration check

Two separate agent contexts contributed to their own Artifacts forks from the same baseline. One was C3’s author child; the other was Way’s existing session. Their author workflows overlapped. This does not measure simultaneous model inference or collaboration benefit.

- Baseline: `5756e24fff3d35ac76df5e0a811036e3f4192237`.
- Author A head: `b32063f0d245416fa078ba897e23daf48306b95c`.
- Author B head: `87e84f6f055a83c3b9850af23b868a9815be8eab`.
- Combined candidate: `5a0e895a0f4367a3b609aafe12e6d13ebb0301b4`.
- Candidate ID: `d1351c7a-493f-43bc-9c06-520a0c8aee93`.
- Check job: `25cfb8b0-c29d-4091-b65b-239f85cd0d80`.
- Review: `6d334a08-4be3-404c-a6e7-34d140a271eb`.

The companion ran an actual pinned Docker check on that candidate. Container creation, execution and exit 0 were recorded; the hosted collector stored a passing receipt. C3 reviewed the exact changes using a distinct non-author identity before integration. C3 also operated the test and parented author A, so this was not a blind review by an independent team. Way authored B and independently read back the resulting canonical commit and all four changed files.

Integration returned HTTP 200 with `effect: confirmed`; the canonical tip matched the exact candidate. After the login-fix deployment, seven fresh endpoint reads confirmed the project, tasks, proposals, integrated candidate, passing check and review persisted.

## Browser-discovered repair

API login probes passed, but an ordinary Safari login exposed a real failure: the login page’s `no-referrer` policy caused a form POST with `Origin: null`, which the server correctly rejected. Runtime commit `21a11cf` changes that page to `Referrer-Policy: same-origin`. The origin validator still rejects null and foreign origins. The regression failed before the repair; 22 targeted tests and typecheck passed afterward.

Way retested the final deployment through ordinary native Safari sign-in: passed. The hosted UI showed the integrated candidate, and a newly created task and its discussion persisted after reload. Eight hosted frontend assets matched the release build. Earlier Chrome/IAB attempts remain recorded as client-blocked; this is a Safari browser pass, not cross-browser certification.

## Video provenance

Steve approved Tempo’s r3 MP4 unchanged: 5:35.68, 1080p, SHA-256 `044dbb6724bd47c6c659341c5a9659fa4ac39542e0503bc99ef57c221fed02d3`.

The newer interface was recorded locally. At 4:21.88–4:55.00 the video explicitly shows a separate saved October 4 hosted trial; at 4:55.00–5:12.00 it shows a separate local Docker record. A focused check matched 11 historical proof copies against their original hashes and supported the October 4 claims. Today’s preview does not retroactively prove that history, and the video does not present today’s test as filmed footage.

## Operational limits

The owned preview companion was stopped after bounded acceptance. The hosted browser/API remains deployed; new Git/check jobs need a configured running companion. Docker runs on that companion host, not inside Cloudflare. No native automatic agent wake-up, scale, conflict-repair benchmark, provider-model attestation or measured productivity gain is established by this small test. The optional OAuth/MCP configuration is separate and was not enabled by this deployment. Original historical data was not imported.
