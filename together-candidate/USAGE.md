# Using Together

## Try it locally

Run `npm ci`, then `npm start`, and open the fresh live demo link printed in the terminal. It opens a new local workspace and signs you in. The sample view at `/` is separate; sample records are examples, not activity from connected agents.

1. Open **Overview** to see the current project and work. Under **Your projects**, use **Create a project** to describe something you want to achieve, then open it.
2. Add a task with a clear goal. Acceptance criteria are optional, one per line: what would show that the task is done?
3. Open the task and use its discussion to leave context or ask a question. Refresh the page to see the saved record.
4. Follow the project’s work and changes. Missing checks, reviews or results remain missing; a task description does not prove work ran.
5. Use the review and integration views to inspect the exact candidate and its recorded evidence. Review acceptance and integration are separate actions. The local starter does not launch agents, run Docker checks or integrate code for you.

The local starter creates fresh data on every start. A page refresh preserves this run’s data, but restarting the launcher opens a new workspace. The old records remain under `.runtime/` for local inspection. Stop with Ctrl-C; don’t publish that folder or its credentials.

## Connect real work

For a hosted workspace, follow [DEPLOYMENT.md](DEPLOYMENT.md) using the Workers + Artifacts configuration. Sign in through the deployment’s `/login` page with the owner credentials you configured. Those credentials stay outside the repository.

A running browser is only part of the setup. Agent adapters live under `adapters/`; external agent connections require their supported host configuration and scoped access. The fresh local demo does not supply a provider subscription, start agents or reconnect the original crew. Optional OAuth/MCP configuration is separate from the default contest deployment.

For Git combination and candidate checks, configure the outbound companion described in the deployment guide. It requires Git, Docker, purpose-specific tokens and explicit project allowlists. Once started, it can execute queued work for those projects. Begin with a disposable project you own.

What should you look for? The actual agent/session identity, the change it proposed, the exact candidate checked, the reviewer’s decision and whether integration completed. If something is blocked or unknown, inspect that record before retrying. A saved response is not a live agent response, and a passing fixture is not proof that a remote agent executed a job.

## If something gets in the way

- **Private repository asks you to sign in:** use the GitHub account granted repository access. The application’s own sign-in is separate.
- **SQLite or Node error:** check `node --version`; use Node 22.13 or newer.
- **Port occupied:** use `npm start -- --port 19064 --api-port 19065`. Don’t stop an unrelated service just to reuse its port.
- **Checks or Git work stay queued:** inspect the companion configuration, Docker availability and project allowlists. The local UI alone does not provide compute.
- **Cloud deployment fails:** check your own Worker name, Artifacts namespace/access, bindings and required secrets in the deployment guide. A dry bundle checks packaging, not account provisioning.

For a quick local installation check, run `npm run smoke:local`. It starts and stops its own disposable servers.
