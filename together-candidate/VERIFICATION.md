# Verification — October 14, 2026

This standalone release packages the newer Together interface for installation and review under MIT at https://github.com/sleepficus/together. Steve approved publication and the r3 video. Manual competition submission remains separate.

- Fresh `npm ci`: passed.
- Core tests: 465/465 passed. After the encoded task-discussion ID repair and private-link removal, the complete 465-test suite, typecheck and Cloudflare dry bundle passed. Browser-created work and task-discussion messages remained after a refresh.
- `npm run typecheck`: passed.
- `npm run check:cloud`: passed; protected assets, four SQLite Durable Objects and Artifacts binding bundled.
- `npm run smoke:local`: passed; fresh startup, occupied-port refusal, HTML/module delivery, authentication denials, cookie sign-in, live project read, logout and shutdown.

The newer candidate also passed a real in-app-browser check of automatic local sign-in, a newly created task, its discussion message and persistence after refresh. The pre-fix task discussion returned 404; the new regression reproduced that failure before repair. The narrow repair decodes only the conversation ID once, after existing authentication and membership checks; malformed encoding returns a controlled 400.

These checks ran on the same Mac using Node 22.23.1 and npm 10.9.8, with fresh isolated dependency trees and caches. Those initial packaging checks did not include a second-machine install, fresh Cloudflare provisioning, Git/Docker companion execution or connected-agent concurrency. A separate October 14 hosted check now covers the new preview and is recorded in [HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md). The original demonstration deployment remains preserved. Fixture success does not establish measured collaboration benefit. Optional OAuth/MCP activation and recovery automation require separate setup; the private operator restore script is excluded.
