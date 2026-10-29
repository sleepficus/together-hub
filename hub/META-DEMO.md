# A small Meta coding handoff, one phase at a time

This is a bounded demonstration, not an autonomous agent manager. The app and
phase client preserve actual requests and replies. The Meta API returns text;
the host saves it and carries it to the Hub. A real reviewer, in their own
session, chooses whether to apply it and runs the test. No scripted reviewer.

Requirements: complete [META-SETUP.md](META-SETUP.md), Python 3, Node>=22.18,
existing approved Meta access, and the actual reviewer ready to participate.
Do not spend credit until both the UI and the recorder have been checked.
The default key route, helper and ports are described there. Example commands
below use Hub19550/API19547; use the same values in every shell.

## 1. Private setup, before recording; zero inference

In `hub/`, choose NEW state outside the source package. Do not reuse a finished
proof's state, fixture, budget or identities. Use paths private to your machine:

```sh
umask 077
export HUB_STATE_DIR="/path/to/new-private-demo/state"
export HUB_FILM_DIR="/path/to/new-private-demo/film"
export HUB_META_CAMPAIGN_DIR="/path/to/new-private-demo/meta-allowance"
export HUB_META_KEY_FILE="/path/to/existing-private-meta-key-file"
export HUB_PORT=19550 HUB_API_PORT=19547
export HUB_FILM_URL=http://127.0.0.1:19550
export HUB_FILM_API=http://127.0.0.1:19547
unset HUB_DISPATCHER_MODEL HUB_META_HELPER_PATH HUB_META_TEST_ENDPOINT HUB_META_ALLOW_LOOPBACK_TEST HUB_FILM_TEST_MODE META_API_KEY
python3 scripts/meta-api.py doctor
npm start
```

Leave that terminal running. In another terminal with the same environment
and working folder:

```sh
python3 scripts/demo-meta.py prepare
node "$HUB_FILM_DIR/fixture/test.mjs" > "$HUB_FILM_DIR/test-before.stdout.txt" 2> "$HUB_FILM_DIR/test-before.stderr.txt"
```

The intentionally buggy fixture must exit1, two failures out of three frozen
cases. Record that exit; don't pretend a passing test is a failure. The script
freezes three files and enrolls **API Spark — Meta coding worker** and
**Main Chad — actual Codex reviewer**, separately, via the normal Key Desk and
invitation exchange, each `read, help:write`,30days. It keeps secrets in the
private film directory and prints none. `PREPARED.json` contains their public
identity IDs and the suggested task. This setup doesn't create a help request
or call a model. The old UI and credentials are not reused.

Check the work page and recorder before proceeding. The work page should be
empty except for the actual newly enrolled participants. Keep the Key Desk,
invitation result pages, private terminals and absolute file paths off camera.

## 2. Enable this new three-request campaign

Stop only your own setup server with Ctrl-C. In the same environment:

```sh
python3 scripts/meta-api.py init --name new-meta-demo --max-calls 3
HUB_DISPATCHER_MODEL=on npm start
```

Initialization makes no model request. It refuses an existing allowance.
The first new handoff can trigger the single routing call; later routing uses
rules fallback with the local cap refusal on the record. Maximum3 HTTP model
requests total,4,000 output tokens and32,000 input bytes per call, no retry.
Failed or interrupted attempts keep their reserved slot. Don't reset one.

## 3. Owner saves the real request in the app

At `http://127.0.0.1:19550/hub/work?project=hub-demo`, sign in normally and
address a request to API Spark. Suggested task, also in `PREPARED.json`:

> Fix average() to return the mean of two numbers. Ask Main Chad to review your exact proposal and run the unchanged three-case test. Return the actual result; do not claim execution you did not perform.

Saving creates the request, not a worker. The separate bridge now reads it.
Read the selected request URL's `help=` query value (for example,
`/hub/work?project=hub-demo&help=REQUEST_ID`). The same value is in that
request's **Open this request** link. This is the help ID; no hidden details
panel or developer source lookup is required. Confirm the
new allowance has exactly one successful dispatch receipt before continuing;
if not, inspect the actual error and stop rather than manufacture a film.

## 4. Ask Spark for the proposal; leave the reviewer to the reviewer

```sh
python3 scripts/demo-meta.py proposal ORIGINAL_HELP_ID
```

This phase reads Spark's actual inbox, accepts the addressed owner request,
sends one worker completion through the **bundled** helper, saves the exact
visible code in `Spark-proposed-math.js`, and posts Spark's own verification
request to Main's identity. It never applies or executes the proposed code.
The helper's raw visible response, prompt and receipt stay preserved privately.
If the model fails the output contract, stop; no tutoring, repair or retry.

The actual Main Codex participant runs these commands from its own session,
with the same private film directory configuration:

```sh
python3 scripts/demo-meta.py participant inbox
python3 scripts/demo-meta.py participant get-help VERIFICATION_HELP_ID
python3 scripts/demo-meta.py participant accept VERIFICATION_HELP_ID
```

The verification help ID is in `PHASE.json` and on the actual work page.
Main inspects `fixture/math.js`, `Spark-proposed-math.js`, the unchanged test,
the before receipt and `FIXTURE-FREEZE.json`. If acceptable, Main applies the
model's **exact proposed bytes** to `fixture/math.js` only, then runs:

```sh
node "$HUB_FILM_DIR/fixture/test.mjs"
```

Main saves its own measured command/exit/stdout/stderr and frozen test/package
hash checks to an answer file. Success is limited to those three cases; if it
fails, report the failure. Main posts that exact answer through its own
credential:

```sh
python3 scripts/demo-meta.py participant answer VERIFICATION_HELP_ID --file /path/to/private/actual-review-answer.txt
```

The phase client makes only the HTTP action chosen by that participant. It
doesn't do the review or invent evidence. All write operation IDs are saved
before sending; reconcile an interrupted attempt instead of blindly repeating.

## 5. Spark reads the actual review and answers the original request

```sh
python3 scripts/demo-meta.py finish
```

This reads the real answered verification help through Spark's credential,
checks that the expected reviewer accepted it and the frozen tests/package
remain unchanged, then makes the final worker call. Its exact visible answer
is posted to the original request and read back. It must attribute execution
to the real reviewer. The work page shows the actual separate requests,
answers and states; receipts remain the underlying event record.

Each phase refuses to overwrite its own attempt record. A failed phase is
evidence, not an invitation to run it again. Review files in the private film
directory and provider receipts in the allowance directory. Token costs and
timings come from those real receipts; billing/current rates are unverified.

After the independent browser check and capture, stop only your own server
with Ctrl-C. Keep state and failure records privately; never include them,
keys or tokens in the source ZIP. No public deployment or submission is made.
