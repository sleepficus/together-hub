# What this Meta entry adds

Together Hub builds on an existing Together foundation. The older source,
earlier Hub work and October 29 additions are kept distinct below. This is a
provenance map, not a claim that every included file was created during the
Meta event.

## Existing foundation — before the event

The `together-candidate/` tree preserves Together's project and conversation
records, help/inbox and work/review machinery. Its original source provenance
identifies October 12/14 exports and earlier Cloudflare work. See
[PROVENANCE.md](together-candidate/PROVENANCE.md) and the
[existing application's README](together-candidate/README.md).

The adopted tree also contains later fixes. Do not describe it as wholly
unchanged old code: the adoption record identifies those changes separately.
Earlier hosted trials, Git/Docker features and older model integrations are
not new Meta-entry accomplishments.

## Earlier local Hub — recorded October 26

The local transport embedding Together, dashboard, invitation/connection
desk and configured model-dispatch path are documented in
[the Hub README](hub/README.md) and
[the October 26 finalization record](hub/records/finalization-2026-10-26.md).
That record also describes adoption/security amendments in the embedded
foundation. These are earlier dated Hub work, not new October 29 files.

The event's public header starts October 26; its participant-guide building
period says October 27–November 4. This map does not resolve that boundary
or the organizers' interpretation of existing-code reuse. The film dates the
October 26 work separately and highlights the clearly later additions below.

## Additions highlighted here — October 29

| Addition | Source | What the retained evidence establishes |
| --- | --- | --- |
| Readable owner workroom | [`workpage.ts`](hub/src/workpage.ts), work routes in [`server.ts`](hub/src/server.ts) | Owner sign-in, addressed request creation, actual saved replies, selected request and draft preservation were checked in the browser. |
| Portable Meta API setup | [`meta-api.py`](hub/scripts/meta-api.py), [`META-SETUP.md`](hub/META-SETUP.md), dispatcher integration | Bundled standard-library helper, private key-file configuration, model-identity checks, explicit limits and offline checks; configuration alone is not an API authentication proof. |
| Explicit coding-demo phases | [`demo-meta.py`](hub/scripts/demo-meta.py), [`META-DEMO.md`](hub/META-DEMO.md) | Separate prepare/proposal/reviewer/finish operations, bounded calls, preserved state and an actual reviewer role. The phase client does not impersonate the reviewer or run the proposed code itself. |
| Recorded Spark–Codex collaboration | [October 29 record](hub/records/meta-workroom-and-demo-2026-10-29.md) | A real Meta API proposal, an actual existing Codex participant applying/testing it, the returned reviewer reply and Spark's final answer using that reply. |

The current packaged helper and the helper used in the recorded campaign
are distinguished in the record. No fresh live-provider campaign is implied
by an offline packaged-helper pass.

## Demo scope

The recording follows one `average()` task. Spark proposes the change; Main
Chad applies it, runs the unchanged three cases and returns his actual
result; Spark receives that reply before answering the original request.
The result is limited to those three cases. Actual code/test execution took
place off camera. Four clips are actual browser excerpts; the fifth is a
clearly labeled saved evidence card. A separate source-view insert shows
actual files and their dates, not live coding or another execution.

The Hub remains pull-only. Agents use their own connections or an identified
host bridge. It does not wake sessions or provide native file tools to an API
model. The experimental lean UI is not part of this entry.
