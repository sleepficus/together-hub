// Isolated actual-domain integration tests. No provider/model calls or worker jobs.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const reservation=createServer();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done));const port=(reservation.address() as {port:number}).port;await new Promise<void>(done=>reservation.close(()=>done()));
process.env.HUB_STATE_DIR=mkdtempSync(join(tmpdir(),'hub-workpage-fixture-'));
process.env.HUB_PORT=String(port);process.env.HUB_API_PORT='0';process.env.HUB_DISPATCHER_MODEL='off';process.env.HUB_DISPATCHER_POLL_MS='3600000';
const {startHubServer}=await import('../src/server.ts');const tr=await import('../src/transport.ts');const kd=await import('../src/keydesk.ts');const {safeWorkText,workReturn}=await import('../src/workpage.ts');
const hub=await startHubServer(port);const base=`http://127.0.0.1:${hub.port}`;let count=0;
function check(name:string,fn:()=>void){fn();count++;console.log('PASS '+name);}
try{
 const anon=await fetch(base+'/hub/work');const anonText=await anon.text();check('normal owner sign-in, no bearer entry',()=>{assert.equal(anon.status,401);assert(anonText.includes('Sign in as the owner'));assert(!anonText.includes(process.env.HUB_STATE_DIR!));});
 const next='/hub/work?project=hub-demo';const login=await fetch(base+'/hub/login?next='+encodeURIComponent(next),{method:'POST',headers:{origin:base},redirect:'manual'});const cookie=login.headers.get('set-cookie')!.split(';')[0];check('sign-in returns directly to actual workroom',()=>{assert.equal(login.status,303);assert.equal(login.headers.get('location'),next);});
 const store=tr.projectStore('hub-demo')!;await store.transact(s=>{s.project.goal='Fixture UI test — no models or provider calls';});
 async function agent(name:string,scopes=['read','help:write']){
  const invite=await kd.issueInvitation({projectId:'hub-demo',displayName:name,scopes});const response=await tr.apiFetch('/api/v1/projects/hub-demo/enrollment/exchange',{method:'POST',headers:{authorization:'Bearer '+invite.token,'content-type':'application/json'},body:JSON.stringify({operationId:randomUUID(),adapter:'fixture-test',model:'no-model',provider:'fixture'})});assert.equal(response.status,201);return {id:invite.identityId,token:(await response.json() as any).token};
 }
 const worker=await agent('Fixture worker — no model');await agent('Read-only fixture',['read']);
 const get=async(path='/hub/work?project=hub-demo')=>{const r=await fetch(base+path,{headers:{cookie}});return {status:r.status,text:await r.text()};};
 const before=await store.read();const page=await get();const after=await store.read();check('workroom is owner-gated, named, fixture-labeled and non-recording',()=>{assert.equal(page.status,200);assert(page.text.includes('Fixture worker'));assert(page.text.includes('Fixture UI test'));assert(!page.text.includes('>Read-only fixture</option>'));assert.deepEqual(before,after);assert(!page.text.includes(process.env.HUB_STATE_DIR!));});
 const post=async(body:Record<string,unknown>,extra:Record<string,string>={})=>{const r=await fetch(base+'/hub/work/request',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json',...extra},body:JSON.stringify(body),redirect:'manual'});return {status:r.status,location:r.headers.get('location'),text:await r.text()};};
 const question='Fixture only: average(4,6) should be 5. <script>throw Error("untrusted")</script>';
 const body={projectId:'hub-demo',operationId:randomUUID(),expectedRevision:1,question,toId:worker.id};
 const saved=await post(body);check('browser route writes exact request through original owner session',()=>{assert.equal(saved.status,303,saved.text);assert(saved.location?.includes('&saved=1&savedOperation='));});
 let state=await store.read();const help=Object.values(state.help).find(h=>h.question===question)!;assert(help);const message=Object.values(state.messages).find(m=>m.helpId===help.id)!;
 check('actual domain has unchanged wording, correct parties and queued readstate',()=>{assert.equal(help.offeredById,'hub-owner');assert.equal(message.recipientId,worker.id);assert.equal(message.delivery,'queued');assert.equal(help.revision,1);});
 const again=await post(body);const stateAfter=await store.read();check('same operation replays one request, not duplicate work',()=>{assert.equal(again.status,303);assert.equal(again.location,saved.location);assert.equal(Object.keys(stateAfter.help).length,1);});
 const altered=await post({...body,question:'Different wording'});check('changed payload with same operation conflicts and preserves draft',()=>{assert.equal(altered.status,409);assert(altered.text.includes('Different wording'));assert(altered.text.includes(body.operationId));assert.equal(Object.keys(stateAfter.help).length,1);});
 const beforeReads=await store.read();const rendered=await get(saved.location!.split('#')[0]);const afterReads=await store.read();check('untrusted HTML escaped, actual read state unchanged by view',()=>{assert(rendered.text.includes('&lt;script&gt;'));assert(!rendered.text.includes('<script>throw'));assert(rendered.text.includes('Awaiting recipient read'));assert.deepEqual(beforeReads,afterReads);});
 const denied=await post({...body,operationId:randomUUID()},{origin:'https://unrelated.invalid'});check('cross-origin request refused without new help',()=>assert.equal(denied.status,403));
 const wrong=await post({...body,operationId:randomUUID(),projectId:'not-owned'});check('owner project authorization enforced',()=>assert.equal(wrong.status,403));
 const receiver=await post({...body,operationId:randomUUID(),toId:'not-enrolled'});check('invalid recipient refused with exact request identifier retained',()=>{assert.equal(receiver.status,422);assert(receiver.text.includes('Fixture only'));});
 const revision=await post({...body,operationId:randomUUID(),expectedRevision:2});check('domain creation revision retained, not bypassed',()=>assert.equal(revision.status,409));
 const missing=await post({...body,operationId:''});check('missing operation is not silently replaced',()=>assert.equal(missing.status,422));
 const blank=await post({...body,operationId:randomUUID(),question:'  '});check('blank question refused',()=>assert.equal(blank.status,422));
 const unknown=await get('/hub/work?project=hub-demo&help=absent');check('unknown request is explicit404',()=>assert.equal(unknown.status,404));
 const auth={authorization:'Bearer '+worker.token,'content-type':'application/json'};
 const read=await tr.apiFetch('/api/v1/projects/hub-demo/inbox',{headers:auth});assert.equal(read.status,200);await read.arrayBuffer();
 const answer='Fixture reply — no model used. <img src=x onerror=alert(1)>\n\nHOST BRIDGE CONTEXT (operator-only)\n/Users/private/not-for-film\nBearer super-secret-test-value';
 const reply=await tr.apiFetch('/api/v1/projects/hub-demo/help/'+help.id+'/answer',{method:'POST',headers:auth,body:JSON.stringify({operationId:randomUUID(),expectedRevision:1,answer})});assert.equal(reply.status,200,await reply.clone().text());await reply.arrayBuffer();
 const final=await get('/hub/work?project=hub-demo&help='+help.id);check('actual addressed answer/body/state rendered; hidden context marked',()=>{assert.equal(final.status,200);assert(final.text.includes('Answer returned'));assert(final.text.includes('Recipient read recorded'));assert(final.text.includes('Fixture reply'));assert(final.text.includes('&lt;img'));assert(!final.text.includes('/Users/private'));assert(!final.text.includes('super-secret-test-value'));assert(final.text.includes('Original records are unchanged'));});
 const finalState=await store.read();check('display redaction never rewrites original record',()=>assert.equal(finalState.help[help.id].answer,answer));
 const namespace=await get('/api/v1/projects');check('Hub does not expose embedded API namespace',()=>assert.equal(namespace.status,404));
 check('login next only accepts local exact workroom path',()=>{assert.equal(workReturn('https://evil.invalid'),undefined);assert.equal(workReturn('//evil.invalid'),undefined);assert.equal(workReturn('/hub/work-evil'),undefined);assert.equal(workReturn('/hub/work?project=x'),'/hub/work?project=x');});
 check('safe prose hides paths/tokens but keeps ordinary code',()=>{assert.equal(safeWorkText('return (a + b) / 2;').text,'return (a + b) / 2;');assert(!safeWorkText('at /home/private/file Bearer secretvalue').text.includes('/home/private'));});
 console.log(JSON.stringify({result:'PASS',checks:count,providerCalls:0,fixturesLabeled:true,stateDir:process.env.HUB_STATE_DIR}));
}finally{await hub.close();}
