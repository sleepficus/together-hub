import assert from 'node:assert/strict';
import {statSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {startDemo,parseOptions} from './start-local.mts';

// Uses fresh OS-assigned loopback ports and only its own disposable state.
const demo=await startDemo({port:0,apiPort:0});
let closed=false;
try{
  assert.throws(()=>parseOptions(['--port','0']));
  assert.throws(()=>parseOptions(['--port','8928','--api-port','8928']));
  await assert.rejects(()=>startDemo({port:Number(new URL(demo.origin).port),apiPort:0}),{code:'EADDRINUSE'});
  assert.equal(statSync(resolve(demo.stateDir,'owner-token')).mode&0o777,0o600);
  const get=(path:string,init:RequestInit={})=>fetch(demo.origin+path,{...init,signal:AbortSignal.timeout(10000)});
  assert.equal((await get('/api/v1/projects')).status,401);
  assert.equal((await fetch(demo.apiOrigin+'/api/v1/projects')).status,401);
  assert.match(await (await get('/')).text(),/id="root"/);
  const module=await get('/src/main.tsx');assert.equal(module.status,200);
  assert.match(await module.text(),/createRoot/);
  assert.match(await (await get('/local-login')).text(),/fresh live workspace/);
  assert.equal((await get('/local-login',{method:'POST'})).status,403);
  assert.equal((await get('/local-login',{method:'POST',headers:{origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await get('/local-login',{method:'POST',headers:{origin:demo.origin,'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await get('/api/v1/session',{method:'POST',headers:{authorization:'Bearer invalid-demo-token',origin:demo.origin}})).status,401);
  const login=await get('/local-login',{method:'POST',headers:{origin:demo.origin}});
  assert.equal(login.status,201);
  const cookieHeader=login.headers.get('set-cookie')!;
  assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/SameSite=Strict/);assert.match(cookieHeader,/Path=\/api/);
  const cookie=cookieHeader.split(';')[0];
  assert.equal((await get('/api/v1/session',{headers:{cookie}})).status,200);
  const projects=await get('/api/v1/projects',{headers:{cookie}});assert.equal(projects.status,200);
  assert.match(await projects.text(),/local-demo/);
  const live=await get('/api/v1/projects/'+demo.projectId,{headers:{cookie}});assert.equal(live.status,200);
  assert.match(await live.text(),/"mode":"live"/);
  assert.equal((await get('/api/v1/session',{method:'DELETE',headers:{cookie,origin:demo.origin}})).status,200);
  assert.equal((await get('/api/v1/projects',{headers:{cookie}})).status,401);
  await demo.close();closed=true;
  await assert.rejects(()=>fetch(demo.origin,{signal:AbortSignal.timeout(2000)}));
  await assert.rejects(()=>fetch(demo.apiOrigin+'/api/v1/projects',{signal:AbortSignal.timeout(2000)}));
  console.log('PASS: fresh loopback startup, HTML, auth denials, cookie login, live API, logout and shutdown. Browser rendering, Cloudflare, agents, Git and Docker not exercised.');
}finally{
  if(!closed)await demo.close();
  rmSync(demo.stateDir,{recursive:true,force:true});
}
