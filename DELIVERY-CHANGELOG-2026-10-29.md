# Meta delivery candidate — October 29, 2026

Based on accepted r2 archive SHA-256
`522476e7cc0493732c4ff99bbc86a8ddfe0d0cdeba93d9842c589b9a4d594f04`.
That archive, its installation record, and the completed earlier live proof
remain unchanged. Restoring r2 would restore the absent external-helper
dependency, so this focused extension is made in a separate extracted copy.

- Bundled stdlib Python Meta helper replaces the default external
  builder-VM path. Existing private key-file or injected environment auth;
  no key bundled or operator home directory hardcoded.
- Explicit offline doctor and a separately initialized maximum-three-call
  campaign, one routing request, no retry, bounded output and private receipts.
- Dispatcher verifies the returned model ID instead of silently substituting
  the requested ID when identity is absent.
- Separate setup instructions and offline tests for the shipped entry point.

Historical r2 verification and rehearsal records retain their original dates,
actors and limits. They do not certify this new candidate. The new candidate's
builder and independent installed-browser results are recorded separately.
No inference has been run to certify the portable helper yet; a new recorded
campaign must earn its own result. A successful local doctor is not proof of
account entitlement. No public repository or competition submission changed.
