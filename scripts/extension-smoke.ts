// End-to-end smoke test for the Chrome extension against a real Album Relay server.
// Source sites are never contacted: Chromium resolves the source hostnames to a local HTTPS fixture server
// (--host-resolver-rules), so even tabs opened by the extension itself cannot reach the real sites.
// Run: npx tsx scripts/extension-smoke.ts   (SMOKE_CHROMIUM=/path/to/Chrome-for-Testing to use another Chromium build)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { aotyChart, rymChart } from '../tests/fixtures/charts.js';

const year=new Date().getFullYear();
const rymUrl=`https://rateyourmusic.com/charts/top/album/${year}/1/`;
const aotyUrl=`https://www.albumoftheyear.org/ratings/user-highest-rated/lp/${year}/`;
const challengeUrl='https://www.albumoftheyear.org/album/9-challenge.php';
const page=(body:string,title='Chart')=>`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const assert=(ok:unknown,message:string)=>{if(!ok)throw new Error(`FAILED: ${message}`);console.log(`ok - ${message}`);};
const waitFor=async<T>(fn:()=>Promise<T|undefined|null|false>,label:string,ms=150000):Promise<T>=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw new Error(`Timed out: ${label}`);await new Promise(r=>setTimeout(r,500));}};

const dataDir=mkdtempSync(join(tmpdir(),'relay-ext-smoke-'));
const extDir=mkdtempSync(join(tmpdir(),'relay-ext-build-'));
const profile=mkdtempSync(join(tmpdir(),'relay-ext-profile-'));
const app=await createApp({dataDir,scheduler:false});
await app.listen({host:'127.0.0.1',port:0});
const port=(app.server.address() as {port:number}).port;
const server=`http://127.0.0.1:${port}`;
// Test build: pre-grant the local server origin, which the real options page requests at runtime.
cpSync(resolve('extension'),extDir,{recursive:true});
const manifest=JSON.parse(readFileSync(join(extDir,'manifest.json'),'utf8'));
manifest.host_permissions=['http://127.0.0.1/*'];
writeFileSync(join(extDir,'manifest.json'),JSON.stringify(manifest));
// Local HTTPS fixture server standing in for rateyourmusic.com / www.albumoftheyear.org / pitchfork.com.
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture','-keyout',join(profile,'..',`${profile.split('/').pop()}-key.pem`),'-out',join(profile,'..',`${profile.split('/').pop()}-cert.pem`)],{stdio:'ignore'});
const keyPath=join(profile,'..',`${profile.split('/').pop()}-key.pem`),certPath=join(profile,'..',`${profile.split('/').pop()}-cert.pem`);
const fixtureHits:string[]=[];
const fixtures=createServer({key:readFileSync(keyPath),cert:readFileSync(certPath)},(req,res)=>{
 const url=`https://${req.headers.host}${req.url}`;fixtureHits.push(url);
 const body=url.startsWith(rymUrl)?page(rymChart):url.startsWith(aotyUrl)?page(aotyChart):url.startsWith(challengeUrl)?page('<div id="challenge-form">Verify you are human</div>','Just a moment...'):null;
 res.writeHead(body?200:404,{'content-type':'text/html'});res.end(body??'not found');
});
await new Promise<void>(r=>fixtures.listen(0,'127.0.0.1',r));
const fixturePort=(fixtures.address() as {port:number}).port;
const resolverRules=['rateyourmusic.com','www.albumoftheyear.org','pitchfork.com'].map(h=>`MAP ${h} 127.0.0.1:${fixturePort}`).concat('MAP * ~NOTFOUND','EXCLUDE 127.0.0.1').join(',');
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:process.env.SMOKE_CHROMIUM||undefined,headless:true,ignoreHTTPSErrors:true,args:['--no-proxy-server',`--host-resolver-rules=${resolverRules}`,'--ignore-certificate-errors',`--disable-extensions-except=${extDir}`,`--load-extension=${extDir}`]});
try{
 const setup=await fetch(`${server}/api/setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'extension-smoke-password'})});
 const cookie=setup.headers.get('set-cookie')!.split(';')[0]!;
 const admin=(path:string,init:RequestInit={})=>fetch(server+path,{...init,headers:{cookie,'content-type':'application/json',...(init.headers??{})}}).then(r=>r.json());
 const {token}=await admin('/api/extension/token',{method:'POST',body:'{}'});
 assert(typeof token==='string'&&token.startsWith('ar_'),'administrator issues a pairing token');
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 worker.on('console',m=>console.log('[worker]',m.text()));
 context.on('page',p=>p.on('console',m=>console.log('[page]',m.text())));
 const dump=async()=>console.log('[storage]',JSON.stringify(await worker.evaluate(()=>chrome.storage.local.get())).slice(0,2000));
 await worker.evaluate(async([s,t])=>{await chrome.storage.local.set({server:s,token:t});},[server,token]);

 // A: passive capture of a page the user opens.
 const tab=await context.newPage();
 await tab.goto(rymUrl);
 await waitFor(async()=>(await admin('/api/captures')).length===1,'RYM page captured',30000).catch(async e=>{await dump();console.log('[tab]',tab.url(),await tab.title());throw e;});
 assert(true,'RYM chart opened in the browser is captured into the library');
 const recent=await waitFor(async()=>{const r=await worker.evaluate(()=>chrome.storage.local.get('recent'));return (r.recent as {state:string}[]|undefined)?.[0];},'recent entry');
 assert(recent.state==='ok','extension records the successful capture');
 await tab.reload();
 await waitFor(async()=>{const r=await worker.evaluate(()=>chrome.storage.local.get('recent'));return (r.recent as {state:string}[]|undefined)?.[0]?.state==='skipped';},'revisit skipped');
 assert((await admin('/api/captures')).length===1,'a revisit within 30 minutes is not imported twice');
 await tab.goto(challengeUrl);
 await waitFor(async()=>(await admin('/api/extension')).reports.some((r:{state:string})=>r.state==='challenge'),'challenge reported',60000);
 assert(true,'a verification page is reported, not submitted');
 await tab.close();

 // B: scheduled refresh opens configured pages in background tabs, then stops at a challenge.
 await admin('/api/extension/refresh',{method:'PUT',body:JSON.stringify({enabled:true,hour:0,targets:[aotyUrl,challengeUrl,rymUrl]})});
 const started=await worker.evaluate(()=>(globalThis as unknown as {startRun:(m:boolean)=>Promise<unknown>}).startRun(true));
 assert(!(started as {error?:string}).error,'manual refresh run starts');
 const run=await waitFor(async()=>{const r=(await worker.evaluate(()=>chrome.storage.local.get('run'))).run as {status:string;results:{state:string}[]}|undefined;return r&&['challenge','done'].includes(r.status)?r:null;},'run finished',240000);
 assert((await admin('/api/captures')).some((c:{source:string})=>c.source==='aoty'),'refresh captured the AOTY chart in a background tab');
 assert(run.status==='challenge'&&run.results.map(r=>r.state).join(',')==='ok,challenge','refresh stops at the challenge instead of continuing');
 assert(context.pages().some(p=>p.url().startsWith(challengeUrl)),'challenge tab is left open for the user');
 assert(!context.pages().some(p=>p.url().startsWith(aotyUrl)),'completed refresh tabs are closed');
 const state=await admin('/api/extension');
 assert(state.lastSeen&&state.version===manifest.version,'server sees the extension heartbeat and version');
 assert(fixtureHits.length>0&&fixtureHits.every(u=>/^https:\/\/(rateyourmusic\.com|www\.albumoftheyear\.org|pitchfork\.com)\//.test(u)),`all source traffic stayed on the local fixture server (${fixtureHits.length} requests)`);
 console.log('\nAll extension smoke checks passed.');
}finally{
 await context.close();await app.close();fixtures.close();
 for(const d of [dataDir,extDir,profile,keyPath,certPath])rmSync(d,{recursive:true,force:true});
}
