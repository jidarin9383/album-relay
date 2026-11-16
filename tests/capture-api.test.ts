import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { SourceBrowser } from '../server/sources/browser.js';
import { CaptureError } from '../server/sources/charts.js';
import { SourceService } from '../server/sources/index.js';
import { Store } from '../server/store.js';
import { rymChart } from './fixtures/charts.js';
it('recovers a source action interrupted before any run was created',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-capture-restart-'));const before=new Store(dir);before.acquireLock('http-action:interrupted');before.close();
 const app=await createApp({dataDir:dir,scheduler:false});const after=new Store(dir);
 try{expect(after.acquireLock('next-run')).toBe(true);}finally{after.releaseLock('next-run');after.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
it('captures the already-open document through an authenticated, locked API without extra navigation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-capture-api-'));let reads=0;
 let html=rymChart,url='https://rateyourmusic.com/charts/top/album/2026/1/';
 let currentError:Error|null=null;
 const opened:{source?:string;targetUrl?:string}[]=[];
 const browser={connected:true,async read(){reads++;return {html,status:200}},async current(){if(currentError)throw currentError;return {html,url}},async verification(source?:string,targetUrl?:string){opened.push({source,targetUrl});return {available:true,active:true,source:source as 'rym'|'aoty'|undefined,url:'/verification/vnc.html',message:'Open browser'}},async close(){}};
 const service=new SourceService(dir,browser);
 const app=await createApp({dataDir:dir,scheduler:false,sources:service});const store=new Store(dir);
 try{
  expect((await app.inject({method:'POST',url:'/api/sources/rym/chart'})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/sources/rym/capture'})).statusCode).toBe(401);
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{password:'capture-test-password-123'}});const cookie=setup.headers['set-cookie'] as string;
  expect((await app.inject({method:'POST',url:'/api/sources/pitchfork/chart',headers:{cookie}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/sources/pitchfork/capture',headers:{cookie}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie,origin:'http://evil.example'}})).statusCode).toBe(403);
  store.acquireLock('other');
  expect((await app.inject({method:'POST',url:'/api/sources/rym/chart',headers:{cookie}})).statusCode).toBe(409);
  expect((await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie}})).statusCode).toBe(409);
  store.releaseLock('other');
  const year=new Date().getUTCFullYear();
  let res=await app.inject({method:'POST',url:'/api/sources/rym/chart',headers:{cookie}});
  expect(res.statusCode).toBe(200);
  res=await app.inject({method:'POST',url:'/api/sources/aoty/chart',headers:{cookie}});
  expect(res.statusCode).toBe(200);
  expect(opened).toEqual([
   {source:'rym',targetUrl:`https://rateyourmusic.com/charts/top/album/${year}/1/`},
   {source:'aoty',targetUrl:`https://www.albumoftheyear.org/ratings/user-highest-rated/lp/${year}/?p=1`}
  ]);
  res=await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie}});
  expect(res.statusCode).toBe(200);expect(res.json()).toMatchObject({added:1,updated:0});expect(reads).toBe(0);
  expect((await app.inject({url:'/api/captures',headers:{cookie}})).json()).toHaveLength(1);
  html='<h1>Verify you are human</h1>';
  res=await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie}});
  expect(res.statusCode).toBe(400);expect(res.json().error).toContain('验证');
  html=rymChart;url='https://example.com';
  res=await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie}});
  expect(res.statusCode).toBe(400);expect(res.json().error).toContain('受支持的来源');
  url='https://rateyourmusic.com/charts/top/album/2026/1/';
  currentError=new CaptureError('页面正在切换，请等待加载完成后再收录');
  res=await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie}});
  expect(res.statusCode).toBe(400);expect(res.json().error).toBe('页面正在切换，请等待加载完成后再收录');
  currentError=new Error('Playwright internal crash');
  res=await app.inject({method:'POST',url:'/api/sources/rym/capture',headers:{cookie}});
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe('未收录：请确认独立浏览器打开的是对应站点的用户评分榜，已完成验证和加载，再重试。');
  expect(store.captures()).toHaveLength(1);expect(store.albums()).toHaveLength(1);
  expect(store.runs()).toHaveLength(0);expect(store.playlists()).toHaveLength(0);
 }finally{store.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
it('reports interactive browser availability accurately across local, CDP and VNC modes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-browser-env-'));
 const saved={BROWSER_UI_URL:process.env.BROWSER_UI_URL,BROWSER_CDP_URL:process.env.BROWSER_CDP_URL,BROWSER_HEADLESS:process.env.BROWSER_HEADLESS};
 const restore=(key:keyof typeof saved,val:string|undefined)=>{if(val===undefined)delete process.env[key];else process.env[key]=val;};
 try{
  const browser=new SourceBrowser(dir);
  delete process.env.BROWSER_UI_URL;delete process.env.BROWSER_CDP_URL;process.env.BROWSER_HEADLESS='false';
  expect(await browser.verification()).toMatchObject({available:true,url:undefined});
  delete process.env.BROWSER_HEADLESS;process.env.BROWSER_CDP_URL='http://127.0.0.1:9222';
  expect(await browser.verification()).toMatchObject({available:true,url:undefined});
  process.env.BROWSER_UI_URL='http://browser:6080';
  const vnc=await browser.verification();
  expect(vnc.available).toBe(true);
  expect(vnc.url?.startsWith('/verification/vnc.html')).toBe(true);
  await browser.close();
 }finally{
  restore('BROWSER_UI_URL',saved.BROWSER_UI_URL);
  restore('BROWSER_CDP_URL',saved.BROWSER_CDP_URL);
  restore('BROWSER_HEADLESS',saved.BROWSER_HEADLESS);
  rmSync(dir,{recursive:true,force:true});
 }
});
