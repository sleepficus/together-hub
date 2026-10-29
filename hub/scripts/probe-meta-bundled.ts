// Offline integration: real dispatcher -> bundled Python -> local HTTP fixture.
// No Meta provider request. Unlike setModelTransport(), this exercises the shipped path.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState, Message } from '../../together-candidate/lib/types.ts';

const temp = mkdtempSync(join(tmpdir(), 'hub-meta-integration-'));
let hits = 0;
let reportedModel = 'muse-spark-1.3';
const server = createServer(async (req, res) => {
  const pieces = [];
  for await (const chunk of req) pieces.push(chunk);
  const request = JSON.parse(Buffer.concat(pieces).toString());
  assert.equal(req.headers.authorization, 'Bearer OFFLINE-NOT-A-REAL-KEY');
  assert.equal(request.model, 'muse-spark-1.3');
  hits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: reportedModel, choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ action: 'deliver', to: 'reader', reason: 'Offline fixture addressee', summary: 'OFFLINE TEST ONLY' }),
  }}], usage: { prompt_tokens: 22, completion_tokens: 33, total_tokens: 55 } }));
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');
const keyfile = join(temp, 'fixture-key');
writeFileSync(keyfile, 'OFFLINE-NOT-A-REAL-KEY\n', { mode: 0o600 });
process.env.HUB_META_KEY_FILE = keyfile;
delete process.env.META_API_KEY;
delete process.env.HUB_META_HELPER_PATH; // Prove the new bundled default, not an override.
process.env.HUB_META_CAMPAIGN_DIR = join(temp, 'campaign');
process.env.HUB_META_TEST_ENDPOINT = `http://127.0.0.1:${address.port}/v1/chat/completions`;
process.env.HUB_META_ALLOW_LOOPBACK_TEST = '1';
const helper = new URL('./meta-api.py', import.meta.url).pathname;
async function init() {
  const child = spawn('python3', [helper, 'init', '--name', 'OFFLINE-INTEGRATION'], { stdio: 'pipe' });
  let out = '';
  child.stderr.on('data', b => out += b.toString());
  const exit = await new Promise((done) => child.on('close', done));
  assert.equal(exit, 0, out);
}
const state = { project: { id: 'offline' }, credentials: {}, identities: {
  sender: { id: 'sender', displayName: 'Offline sender', status: 'active' },
  reader: { id: 'reader', displayName: 'Offline reader', status: 'active' },
}} as unknown as ProjectState;
const message = { id: 'offline-message', body: 'OFFLINE TEST ONLY', senderId: 'sender',
  recipientId: 'reader', type: 'help:request' } as unknown as Message;
try {
  const { routeWithModel } = await import('../src/dispatcher.ts');
  delete process.env.HUB_DISPATCHER_MODEL;
  assert.equal((await routeWithModel({ state, message })).wired, false);
  assert.equal(hits, 0);
  console.log('PASS flag-off makes no HTTP call');
  process.env.HUB_DISPATCHER_MODEL = 'on';
  const missing = await routeWithModel({ state, message });
  assert.equal(missing.ok, false);
  assert.equal(hits, 0);
  console.log('PASS uninitialized budget refuses before HTTP');
  await init();
  const result = await routeWithModel({ state, message });
  assert.equal(result.ok, true);
  if (!result.ok) throw Error('Unreachable');
  assert.equal(result.call.model, 'muse-spark-1.3');
  assert.equal(result.call.inputTokens, 22);
  assert.equal(result.decision.to, 'reader');
  assert.equal(hits, 1);
  console.log('PASS shipped helper default returns validated route and actual reported model/usage');
  const denied = await routeWithModel({ state, message });
  assert.equal(denied.ok, false);
  assert.match('detail' in denied ? denied.detail : '', /DISPATCH_CAP_REACHED/);
  assert.equal(hits, 1);
  console.log('PASS second dispatch locally denied, typed failure available for normal rules fallback');
  process.env.HUB_META_CAMPAIGN_DIR = join(temp, 'separate-bad-model-campaign');
  await init();
  reportedModel = 'unverified-model';
  assert.equal((await routeWithModel({ state, message })).ok, false);
  assert.equal(hits, 2);
  console.log('PASS provider model mismatch never labels a valid model decision');
  delete process.env.HUB_META_KEY_FILE;
  assert.equal((await routeWithModel({ state, message })).ok, false);
  assert.equal(hits, 2);
  console.log('PASS missing auth fails without another HTTP request');
  console.log('6/6 offline integration checks PASS; 0 Meta provider requests');
} finally {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(temp, { recursive: true, force: true });
}
