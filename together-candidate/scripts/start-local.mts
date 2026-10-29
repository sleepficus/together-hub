// Fresh, loopback-only demo. Imports the unchanged Together API; no Git,
// Docker, companion, provider, or existing private state is configured.
import {mkdirSync, mkdtempSync, writeFileSync, lstatSync, chmodSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {createServer as createViteServer} from 'vite';
import react from '@vitejs/plugin-react';
import {startLocalServer} from '../cloud/local-server.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host='127.0.0.1';
function cliPort(value:string, name:string):number {
  if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>65535)throw new Error(`${name} must be 1..65535`);
  return Number(value);
}
export function parseOptions(args:string[], env:NodeJS.ProcessEnv=process.env){
  let port=cliPort(env.TOGETHER_DEMO_PORT??'8928','UI port');
  let apiPort=cliPort(env.TOGETHER_DEMO_API_PORT??'8937','API port');
  for(let i=0;i<args.length;i++){
    if(args[i]==='--port')port=cliPort(args[++i]??'','UI port');
    else if(args[i]==='--api-port')apiPort=cliPort(args[++i]??'','API port');
    else throw new Error('Use: npm start -- [--port 8928] [--api-port 8937]');
  }
  if(port===apiPort)throw new Error('UI and API ports must differ');
  return {port,apiPort};
}
async function portAvailable(port:number){
  if(port===0)return; // Programmatic smoke requests an OS-assigned disposable port.
  const server=createNetServer();
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(port,host,yes);});
  await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));
}
export async function startDemo(options:{port:number;apiPort:number}){
  await portAvailable(options.port);await portAvailable(options.apiPort);
  const runtime=resolve(root,'.runtime');
  mkdirSync(runtime,{recursive:true,mode:0o700});
  const stat=lstatSync(runtime);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))throw new Error('.runtime must be an owned regular directory');
  chmodSync(runtime,0o700);
  const stateDir=mkdtempSync(resolve(runtime,'demo-'));chmodSync(stateDir,0o700);
  const token=randomBytes(32).toString('hex');
  writeFileSync(resolve(stateDir,'owner-token'),token,{flag:'wx',mode:0o600});
  const projectId='local-demo';
  // The demo UI is a different origin from the API (separate ports), and the
  // API pins cookie-authenticated writes to its own origin plus explicit
  // allowedOrigins entries. The UI origin is exactly one explicit entry:
  // the array is filled in below once vite reports the port it bound, and
  // the API reads it per request.
  const demoAllowedOrigins:string[]=[];
  const local=startLocalServer({port:options.apiPort,ownerTokens:[{ownerId:'demo-owner',token}],stateDir,allowedOrigins:demoAllowedOrigins,
    seedProjects:[{id:projectId,goal:'Fresh local Together demo — live records, no connected agents or compute'}]});
  let vite:Awaited<ReturnType<typeof createViteServer>>|undefined;
  const close=async()=>{
    await vite?.close();
    local.server.closeAllConnections();
    if(local.server.listening)await new Promise<void>((done,fail)=>local.server.close(error=>error?fail(error):done()));
  };
  try{
    const apiPort=await local.listening;
    let origin='';
    const destination=`/projects/${encodeURIComponent('live:'+projectId)}`;
    vite=await createViteServer({root,configFile:false,plugins:[react(),{
      name:'together-disposable-local-login',
      configureServer(server){server.middlewares.use(async(req,res,next)=>{
        if(req.url!=='/local-login')return next();
        res.setHeader('cache-control','no-store');
        if(req.method==='GET'){
          res.setHeader('content-type','text/html; charset=utf-8');
          res.end(`<!doctype html><html><title>Together local demo</title><body><h1>Together local demo</h1><p>Signing into a fresh live workspace. No agents, Git or Docker are connected. Sample mode remains available at <a href="/">Overview</a>.</p><p id="status"></p><script>fetch('/local-login',{method:'POST',credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error('Local sign-in failed');location.replace(${JSON.stringify(destination)})}).catch(e=>document.getElementById('status').textContent=e.message)</script></body></html>`);
          return;
        }
        if(req.method!=='POST'||req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){
          res.statusCode=403;res.end('Same-origin local sign-in required');return;
        }
        try{
          const reply=await local.api.fetch(new Request(`http://${host}:${apiPort}/api/v1/session`,{
            method:'POST',headers:{authorization:`Bearer ${token}`,origin}}));
          res.statusCode=reply.status;
          const cookie=reply.headers.get('set-cookie');if(cookie)res.setHeader('set-cookie',cookie);
          res.setHeader('content-type','application/json');res.end(JSON.stringify({signedIn:reply.ok,destination}));
        }catch{res.statusCode=500;res.end('Local sign-in unavailable');}
      });}
    }],server:{host,port:options.port,strictPort:true,allowedHosts:['127.0.0.1','localhost'],
      proxy:{'/api':`http://${host}:${apiPort}`}},build:{target:'es2022'},
      optimizeDeps:{include:['react','react-dom/client']}});
    await vite.listen();
    // Finish dependency scanning before exposing startup/shutdown to callers.
    await vite.environments.client.depsOptimizer?.scanProcessing;
    const address=vite.httpServer!.address();
    const port=typeof address==='object'&&address?address.port:options.port;
    origin=`http://${host}:${port}`;
    demoAllowedOrigins.push(origin,`http://localhost:${port}`);
    return {origin,apiOrigin:`http://${host}:${apiPort}`,stateDir,projectId,close};
  }catch(error){await close();throw error;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const demo=await startDemo(parseOptions(process.argv.slice(2)));
    console.log(`Together fresh live demo: ${demo.origin}/local-login`);
    console.log(`Sample mode: ${demo.origin}/ — sample activity stays separate.`);
    console.log('No agents or Git/Docker compute are connected. Ctrl-C stops both local servers.');
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;await demo.close();};
    process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  }catch(error){console.error(error instanceof Error?error.message:'Local startup failed');process.exitCode=1;}
}
