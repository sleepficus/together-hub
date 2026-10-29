# Together Hub

Agents can hand work to each other here, and you can see what happened.
The local Hub keeps the request, the reply, who handled each step, and the
receipts in one place. A Meta model can help route a request. It can also
propose a code change and ask another agent to check it.

The Hub is pull-only. It doesn't wake agents or give an API model its own
tools. An agent or a named host bridge reads the queue and carries out its
part. A saved request means the request was saved; it doesn't mean a model
has started or the work is correct.

## Meta hackathon scope

**Intended entry: Indie Developer · Build for Your World.**

Together predates this event. Its existing project, conversation, agent-help
and work-record code is retained in `together-candidate/`; the source history
is preserved in [its provenance record](together-candidate/PROVENANCE.md).

The earlier local Hub is documented in the October 26 records. The October 29
additions highlighted in this entry are the owner workroom, portable Meta
API setup and explicit Spark-to-Codex demo controls, alongside a recorded
real model/participant run. The demo is one small coding task with an
independent three-case check; it does not present the whole older Together
application as newly built here.

See [the existing/new work map](META-HACKATHON-WORK.md) and the
[October 29 work and demo record](hub/records/meta-workroom-and-demo-2026-10-29.md)
for the dates, source files and verification limits. These dates describe
retained records; an October 29 repository import is not the original
creation date of every included file.

## Open it locally

You need **Node.js 22.18 or newer**. No `npm install` is needed for this Hub.
Keep `hub/` and `together-candidate/` beside each other as delivered.

```sh
shasum -a 256 -c MANIFEST.sha256
cd hub
npm start
```

Open **http://127.0.0.1:8940/hub/work?project=hub-demo** and sign in as the
local owner. You won't be asked to paste a token. The work page is where you
write an addressed request and read the real replies. Use the Key Desk to
invite the actual agents first; issue and revoke credentials away from any
recording. Invitations show a secret once, so keep them private.

The embedded agent API is **http://127.0.0.1:8937/**. Agent credentials are
project-scoped, revocable, and expire within the Key Desk's chosen lifetime
(30 days by default). Each agent exchanges its own invitation and uses its
own credential. [Agent first use](hub/FIRST-USE.md) gives the exact HTTP steps.
The dashboard does not mark messages delivered; the addressed agent's inbox
read does.

This first boot makes **no Meta calls**. State stays in `hub/.state/`, and both
listeners bind to loopback. Stop your own server with Ctrl-C. You can set
`HUB_PORT`, `HUB_API_PORT` and `HUB_STATE_DIR` before starting if the defaults
are already in use.

## Use Meta with an existing key

[Meta setup](hub/META-SETUP.md) explains the bundled Python 3 helper, private
key-file configuration, the offline check and the separate call allowance.
No external builder workspace or global connector is needed. A configuration
check is not a successful authentication test.

For the small coding demonstration, follow [the explicit demo phases](hub/META-DEMO.md).
There are at most **three provider requests**: one routing call and two model
worker calls, up to 4,000 output tokens each, with no automatic retry. A real
reviewer applies and tests the model's proposal through their own session.
The bridge never pretends to be that reviewer or a persistent Tally/Muse chat.
Model, provider, tool execution and routing fallback stay separately recorded.

## What is in this package?

- `hub/`: the app, Key Desk, readable work page, receipts and Meta helper.
- `together-candidate/`: the adopted Together source embedded by the Hub.
- `MANIFEST.sha256`: hashes for the shipped files.
- Dated change and verification records: earlier evidence, with its original
  actors and limits. A past rehearsal does not certify a new run.

The source is MIT licensed; see [LICENSE](LICENSE) and the bundled
[third-party notices](together-candidate/THIRD-PARTY-NOTICES.md).
This package does not publish, deploy, install native client registrations,
buy credit, or create accounts. It is a local single-host application.
