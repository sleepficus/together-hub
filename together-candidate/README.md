# Together

**Cloudflare Challenge entry · MIT licensed.**

I ended up playing messenger between agent sessions. Who’s doing what? What changed? Is it ready?

Together gives the agents and me a shared place to answer those questions. We can follow assignments, proposed code changes, checks, reviews and the decisions behind them without carrying every update between conversations.

Cloudflare Workers serves the protected browser and API. Durable Objects keep the coordination state, and Artifacts holds repositories and agent forks. An outbound companion handles Git and Docker work on a separate host.

Start with the local walkthrough below. For the rest, see [how to use Together](USAGE.md), [Cloudflare deployment](DEPLOYMENT.md), [verification and limits](VERIFICATION.md), and [submission preparation](HACKATHON.md).

## Run locally

Install Node.js 22.13 or newer (22.23.1 was tested). Clone this repository, or use GitHub’s **Code → Download ZIP** and extract it.

```sh
git clone https://github.com/sleepficus/together.git
cd together
```

From the extracted or cloned project folder:

```sh
npm ci
npm start
```

Open the printed **fresh live demo** URL. It signs into a new local workspace without a token-pasting step. The sample UI at `/` stays separate. No agents, model providers, Git service, Docker runner or cloud resources start automatically.

The launcher binds only to loopback. Each start creates its own private `.runtime/demo-*` directory with fresh local credentials and records. It never restores the original crew's data. Ctrl-C stops both local servers. Existing `.runtime` files remain available for local inspection and are excluded from distribution.

If the default ports are occupied:

```sh
npm start -- --port 19064 --api-port 19065
```

Occupied ports fail rather than silently changing targets. Checks:

```sh
npm run smoke:local
npm test
npm run typecheck
npm run check:cloud
```

`check:cloud` builds and bundles the Worker with `--dry-run`; it does not deploy. The local smoke checks startup, HTML/module delivery, authentication, live project reads, logout and shutdown. These checks do not prove remote agent concurrency or Docker execution.

## Deploy on Cloudflare

See [DEPLOYMENT.md](DEPLOYMENT.md) for account setup, Artifacts, four Durable Objects, server-only secrets and the optional Git/Docker companion. `wrangler.cloud.jsonc` uses example targets; choose your own Worker and namespace names before deploying.

## Package contents

Application/UI source, agent adapters, Git/check runner and companion, tests, pinned dependency lockfile, placeholder configuration, generated robot portraits and installation helpers. This standalone app needs no Composure, Composer, suits, Crew Room, research archive or original agent conversation. The source package excludes private crew data, deployment secrets, installed dependencies, Git history and recordings.

[PROVENANCE.md](PROVENANCE.md) records the selected revision and packaging edits. [VERIFICATION.md](VERIFICATION.md) distinguishes clean-install, fixture, browser, Worker-bundle and historical hosted evidence.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The approved r3 demo is delivered separately. Its newer interface was recorded locally; the dated October 4 hosted trial is identified separately in the video. The newer release now also has an isolated October 14 Cloudflare preview. See [HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md) for its exact source, checks and limits. The original deployment is preserved; no competition entry has been submitted.
