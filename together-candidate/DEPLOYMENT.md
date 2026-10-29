# Cloudflare deployment

This is a fresh deployment procedure, not a replay of the original private trial. The frontend and API share one Worker origin. Artifacts stores repositories and agent forks; four SQLite Durable Objects own the directory, browser sessions, project state and execution queue. Git/Docker compute runs on an outbound companion host.

## Setup

Use Node.js 22.13 or newer, `npm ci`, a Cloudflare account with Artifacts access, and normal Wrangler login:

```sh
npx wrangler login
```

Edit `wrangler.cloud.jsonc`: choose a unique `name` and your own `artifacts[0].namespace`. Keep the four Durable Object bindings/migration and `assets.run_worker_first: true`; authentication must run before assets are delivered. A fresh Worker uses the included `v1` migration. Do not apply this template blindly to an unrelated existing Worker.

Artifacts creates a namespace when its first repository is created. You can provision a harmless bootstrap repository in your chosen namespace:

```sh
npx wrangler artifacts repos create bootstrap --namespace YOUR_NAMESPACE
```

Use the same namespace in the binding. See [Artifacts namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/) and [Wrangler Artifacts commands](https://developers.cloudflare.com/workers/wrangler/commands/artifacts/).

Set `OWNER_TOKENS` through Wrangler's interactive secret prompt. Its value is JSON, for example `[{"ownerId":"your-owner-id","token":"YOUR_RANDOM_SECRET"}]`; this example is not a usable credential.

```sh
npx wrangler secret put OWNER_TOKENS --config wrangler.cloud.jsonc
npm run deploy:cloud
```

Open the resulting Worker `/login` URL and use your configured owner login. Keep secrets out of command arguments, source and ZIPs. `.dev.vars.example` documents names only. The hosted app refuses missing authority.

Wrangler may create the named Worker when registering its first secret, so choose the new target first. A fresh isolated preview was provisioned on October 14; see [HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md) for the tested source and results. Your own account and deployment still need the checks below.

## Git and check companion

The hosted UI/API can run without a companion. Git combination/integration and checks remain queued/unavailable until one is configured.

On an owned host install Git and Docker. Configure separate random `GIT_BRIDGE_TOKEN` and `CHECK_BRIDGE_TOKEN` Worker secrets, then set `GIT_BRIDGE_PROJECT_IDS` and `CHECK_BRIDGE_PROJECT_IDS` to explicit allowed project IDs. Add these through `wrangler secret put NAME --config wrangler.cloud.jsonc`. An absent project allowlist refuses access.

Set the companion variables documented in `.env.example`: Worker origin, allowed projects, each purpose token or its owner-only `_FILE` path, and an owned scratch root. The script reads environment variables; it does not automatically source the example file.

```sh
npm run companion:cloud
```

The companion opens no inbound port. It polls allowed projects and executes exact Git jobs or candidate checks. Checks use the pinned image in `runner/snapshot-runner.ts`, read-only source/root, disabled network, a non-root user and hard time bounds. Missing Git, Docker, image or snapshot support remains an honest blocked outcome. Starting the companion executes queued work for the named projects; initially use only your own test deployment. Ctrl-C stops it.

## Checks and rollback

Run `npm run types:cloud` and `npm run check:cloud` before deployment. Verify `/api/v1/projects` denies anonymous access; verify owner login can list/create a disposable project and reconnect. Record the actual deployed version separately from the package. Preserve the previous Worker version and migration history for rollback.

Default contest configuration is `wrangler.cloud.jsonc` with Artifacts. An optional OAuth/MCP collaboration configuration, when present, requires separate setup; it has no Artifacts binding and is not a substitute for the contest configuration. A successful dry bundle does not enable its external integrations.

Local checks do not establish a new deployment, original-agent participation, concurrency, current conflict repair, scale or measured collaboration benefit.
