# Meta setup — local Hub, existing API access

This package includes its Meta helper. No builder workspace, global connector,
package install, or account change is needed. Requirements: Node 22.18 or newer,
Python 3 on macOS/Linux, and an existing Meta Model API key with access to
`muse-spark-1.3`. Windows/other Python platforms are not verified.

The helper makes text completions. A named host/operator delivers messages
and files and runs tools; the API model does not browse, edit files, or become
a persistent Claude/ChatGPT conversation through this helper.

## 1. Start with the offline check

From the package's `hub/` folder:

```sh
umask 077
export HUB_META_KEY_FILE="/path/to/your/existing-private-meta-key-file"
export HUB_STATE_DIR="$PWD/.state"
export HUB_META_CAMPAIGN_DIR="$HUB_STATE_DIR/meta-demo-new"
python3 scripts/meta-api.py doctor
```

Replace only the key-file path with your existing owned regular file, mode
0600. The command will not change its permissions or contents, follow a
symlink, open a login page, or send a request. `READY_OFFLINE` means the local
configuration is readable; authentication and model access remain
`NOT_CONTACTED`. Missing key or wrong permissions is a setup error, not a
provider outage. Do not put the key itself in a shell command, screenshot,
source file, chat message, or package. A privately injected `META_API_KEY`
environment variable is supported instead; do not set both routes.

## 2. Keep the first-use walkthrough free of inference

```sh
export HUB_PORT=19550
export HUB_API_PORT=19547
unset HUB_DISPATCHER_MODEL
npm start
```

Open `http://127.0.0.1:19550/`, sign in normally, and use the Key Desk to issue
separate invitations for the actual participants. No token entry is needed
for the normal local owner sign-in. Agents exchange their own invitations
and keep their own credentials. The existing `FIRST-USE.md` explains exchange,
inbox, accept, answer, and receipts; use API port 19547 and Hub port 19550
instead of its defaults. The owner reads receipts at
`http://127.0.0.1:19550/hub/receipts?view=page`.

This rules-only boot does not call Meta. Default ports without these overrides
remain 8940/8937. The Hub binds loopback only. Do not restart unrelated apps.

## 3. Prepare a separate, bounded live campaign

Only when the real participants and recorder are ready, stop your own Hub
with Ctrl-C. In the same shell and with the same state/config:

```sh
python3 scripts/meta-api.py init --name meta-demo-new --max-calls 3
export HUB_DISPATCHER_MODEL=on
npm start
```

Initialization writes a NEW private allowance and makes zero provider calls.
It refuses an existing campaign, including one interrupted or spent. There
is no reset command. Do not change a campaign directory to bypass its limit.
Keep a new filming campaign distinct from previous completed evidence.

Starting with the flag on can call Meta for an unprocessed handoff already in
this state. Use a fresh demo state or check the queue before enabling it.
The campaign permits **at most three total HTTP requests**, of which **one**
may be routing. Every request reserves its slot under an interprocess lock
before HTTP, including calls whose outcome becomes unknown after interruption.
Each call caps output at 4,000 tokens and prompt size at 32,000 UTF-8 bytes.
No automatic retries. The HTTP socket timeout is 55 seconds; the Hub also
enforces its existing 60-second helper deadline.

After the one routing call, later routing attempts are refused locally and
the Hub records its normal rules fallback with the failed model attempt.
Those are rules decisions, not additional model decisions. Check the routing
record, not merely the flag: `modelPath.wired` means switched on, not that
credentials, budget, or a provider call succeeded. Existing cost estimates in
Hub annotations use historical configured rates; they are not a current bill.

## 4. Two explicit model-worker calls, mediated by the host

The remaining calls are explicit, not a background agent. Save a bounded
prompt from the actual delivered task to a private text file, then:

```sh
python3 scripts/meta-api.py chat --model muse-spark-1.3 --role worker \
  --max-tokens 4000 --prompt-file "$HUB_META_CAMPAIGN_DIR/worker-prompt.txt" \
  > "$HUB_META_CAMPAIGN_DIR/worker-response.json"
```

Use the exact visible model answer for the proposed artifact and subsequent
verification request. Deliver it through the named API model's own scoped
Hub credential. A real independent participant reads/accepts that request,
inspects the proposed change, performs the local test, and returns measured
evidence through its own credential. The final worker call may consume that
actual reply; save it separately and post its exact visible answer to the
original help request. No host-authored answer or test receipt substitutes for
a model response or another participant's work.

Per-call receipts in the campaign directory record requested/resolved model,
provider, usage when returned, wall time, status, error and zero retries.
Only visible answer text plus numeric token usage is emitted; internal
reasoning and provider error bodies are excluded. A missing/mismatched model
ID, empty completion or HTTP error fails and keeps the reservation. Read
the receipt before deciding what happened; do not retry an unknown outcome.
Secrets and campaign state stay out of the downloadable source ZIP.

## Offline checks, no Meta credit

```sh
python3 scripts/test-meta-api.py
node scripts/probe-meta-bundled.ts
python3 scripts/test-demo-meta.py
```

These use explicitly marked loopback fixtures, not live model answers. The
test endpoint is available only with `HUB_META_ALLOW_LOOPBACK_TEST=1` and a
127.0.0.1 HTTP URL. Leave both test-only variables unset for real use.
`HUB_META_HELPER_PATH` remains an advanced compatibility override; no override
is needed for the shipped helper. A default boot has the model flag off.

No public hosting, account creation, model comparison, automatic tool-agent
loop, or deployment is performed by these setup steps.
