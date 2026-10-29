# Cloudflare Challenge submission preparation

Checked against the official event page, rules and submission form on October 14, 2026:

- https://www.cloudflare.com/git-competition/
- https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf
- https://www.cloudflare.com/git-competition/submit/

## Project description

Together gives people and AI agents a shared place to work on code changes. I can see who’s doing what, follow the discussion, inspect a proposed change and see what checks and reviews actually happened before deciding whether it should be integrated.

The goal is to keep the work and its context together while agents contribute from separate sessions. The prototype records assignments, proposals, candidates, checks, reviews and integration decisions. It does not claim that a small pilot proves large-scale performance.

## How we use Cloudflare

Workers serves the authenticated browser and API. SQLite Durable Objects hold the directory, browser sessions, project state and execution queue. Artifacts stores repositories and scoped agent forks. A separate outbound companion performs Git operations and Docker checks; those jobs do not run inside the browser.

Use `wrangler.cloud.jsonc` for the contest configuration. The optional OAuth/MCP configuration is a separate setup and has no Artifacts binding.

## Run instructions for the form

Clone the repository, install Node.js 22.13 or newer, then run `npm ci` and `npm start`. Open the fresh live demo URL printed in the terminal. See README.md and USAGE.md for the local walkthrough, and DEPLOYMENT.md for a fresh Cloudflare Workers + Artifacts deployment and the optional Git/Docker companion.

## Remaining submission steps

- Open-source repository URL: https://github.com/sleepficus/together. The complete standalone source, root MIT license and run instructions are included.
- Root LICENSE contains MIT, one of the allowed licenses. Dependencies retain their own notices.
- Use the approved `Together-Cloudflare-Hackathon-1080p-r3.mp4`: 5:35.68, 1920×1080, 30,321,792 bytes. Upload the extracted MP4, not its transfer ZIP. SHA-256: `044dbb6724bd47c6c659341c5a9659fa4ac39542e0503bc99ef57c221fed02d3`.
- The video shows the newer interface running locally and a separate, dated October 4 hosted trial. An isolated October 14 preview now runs the newer source plus the login fix. Keep those three records distinct; see [HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md).
- The October 4 video claims were checked against the original receipts. A fresh October 14 hosted collaboration test is recorded separately in [HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md); neither small test establishes scale or measured collaboration benefit.
- Steve completes the submission manually, including personal eligibility, attendee details and agreement to the terms. No automated entry. Deadline: October 14, 2026, 11:59 PM Pacific / October 15, 2:59 AM Eastern.

See VERIFICATION.md for what was checked and what remains unverified. This checklist records preparation; it is not a claim that the entry has been accepted or that every requirement is already satisfied.

## Video and deployment note for the submission

The interface in the video is our newer packaged release running locally. The Cloudflare section shows a separate, saved October 4 hosted trial. We have since deployed the newer release to an isolated October 14 preview and recorded its verification separately. The preview requires an owner session; the repository includes instructions to run your own local workspace or Cloudflare deployment.
