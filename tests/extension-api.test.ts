import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { capturableSource } from '../server/extension.js';
import { SourceService } from '../server/sources/index.js';
import { Store } from '../server/store.js';
import { aotyChart, rymChart } from './fixtures/charts.js';

async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'relay-extension-'));
 const app=await createApp({dataDir:dir,scheduler:false,sources:new SourceService(dir)});
 const res=await app.inject({method:'POST',url:'/api/setup',payload:{password:'extension-test-password'}});
 const cookie=res.headers['set-cookie'] as string;
 return {dir,app,cookie,async done(){await app.close();rmSync(dir,{recursive:true,force:true});}};
}

it('accepts only supported chart, release and review pages',()=>{
 expect(capturableSource('https://rateyourmusic.com/charts/top/album/2026/1/')).toBe('rym');
 expect(capturableSource('https://rateyourmusic.com/release/album/stars/moon/')).toBe('rym');
 expect(capturableSource('https://www.albumoftheyear.org/ratings/user-highest-rated/lp/2026/?p=2')).toBe('aoty');
 expect(capturableSource('https://www.albumoftheyear.org/album/1-stars-moon.php')).toBe('aoty');
 expect(capturableSource('https://pitchfork.com/reviews/albums/stars-moon/')).toBe('pitchfork');
 expect(capturableSource('https://pitchfork.com/reviews/albums/')).toBe('pitchfork');
 expect(capturableSource('https://pitchfork.com/reviews/best/albums/')).toBe('pitchfork');
 expect(capturableSource('https://pitchfork.com/reviews/tracks/')).toBeNull();
 expect(capturableSource('https://rateyourmusic.com/search?searchterm=x')).toBeNull();
 expect(capturableSource('https://rateyourmusic.com.evil.example/charts/top/album/2026/')).toBeNull();
 expect(capturableSource('http://rateyourmusic.com/charts/top/album/2026/')).toBeNull();
 expect(capturableSource('not a url')).toBeNull();
});

it('pairs the extension with a bearer token that is isolated from session cookies',async()=>{
 const t=await setup();
 try{
  expect((await t.app.inject({url:'/api/extension'})).statusCode).toBe(401);
  expect((await t.app.inject({url:'/api/ext/config'})).statusCode).toBe(401);
  // A logged-in session cookie must not unlock extension endpoints.
  expect((await t.app.inject({url:'/api/ext/config',headers:{cookie:t.cookie}})).statusCode).toBe(401);
  expect((await t.app.inject({url:'/api/extension',headers:{cookie:t.cookie}})).json()).toMatchObject({paired:false});
  const first=(await t.app.inject({method:'POST',url:'/api/extension/token',headers:{cookie:t.cookie}})).json().token as string;
  expect(first).toMatch(/^ar_/);
  const ext={authorization:`Bearer ${first}`,origin:'chrome-extension://abcdefghijklmnop','x-album-relay-extension':'0.1.0'};
  const config=await t.app.inject({url:'/api/ext/config',headers:ext});
  expect(config.statusCode).toBe(200);
  expect(config.json().refresh).toMatchObject({enabled:false,hour:10});
  expect(config.json().refresh.targets[0]).toBe(`https://rateyourmusic.com/charts/top/album/${new Date().getFullYear()}/1/`);
  expect(config.json().refresh.targets).toContain('https://pitchfork.com/reviews/albums/');
  // The bearer token does not open administrator endpoints.
  expect((await t.app.inject({url:'/api/extension',headers:{authorization:ext.authorization}})).statusCode).toBe(401);
  const state=(await t.app.inject({url:'/api/extension',headers:{cookie:t.cookie}})).json();
  expect(state).toMatchObject({paired:true,version:'0.1.0'});expect(state.lastSeen).toBeTruthy();
  // Re-issuing revokes the previous token.
  const second=(await t.app.inject({method:'POST',url:'/api/extension/token',headers:{cookie:t.cookie}})).json().token as string;
  expect((await t.app.inject({url:'/api/ext/config',headers:ext})).statusCode).toBe(401);
  expect((await t.app.inject({url:'/api/ext/config',headers:{authorization:`Bearer ${second}`}})).statusCode).toBe(200);
  await t.app.inject({method:'DELETE',url:'/api/extension/token',headers:{cookie:t.cookie}});
  expect((await t.app.inject({url:'/api/ext/config',headers:{authorization:`Bearer ${second}`}})).statusCode).toBe(401);
 }finally{await t.done();}
});

it('imports pages pushed by the extension, deduplicates revisits and records challenges',async()=>{
 const t=await setup();const store=new Store(t.dir);
 try{
  const token=(await t.app.inject({method:'POST',url:'/api/extension/token',headers:{cookie:t.cookie}})).json().token as string;
  const headers={authorization:`Bearer ${token}`,origin:'chrome-extension://abcdefghijklmnop'};
  const url='https://rateyourmusic.com/charts/top/album/2026/1/';
  // Pages larger than the regular 32 KB API limit are accepted.
  const big=rymChart+`<div>${'x'.repeat(200000)}</div>`;
  let res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url,html:big}});
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({status:'captured',receipt:{source:'rym',added:1}});
  res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url,html:rymChart}});
  expect(res.json()).toEqual({status:'skipped',reason:'recent'});
  expect(store.captures()).toHaveLength(1);
  res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url:'https://www.albumoftheyear.org/ratings/user-highest-rated/lp/2026/',html:aotyChart}});
  expect(res.json()).toMatchObject({status:'captured',receipt:{source:'aoty',updated:1}});
  res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url:'https://www.albumoftheyear.org/album/9-other.php',html:'<title>Just a moment...</title><h1>Verify you are human</h1>'}});
  expect(res.statusCode).toBe(422);
  res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url:'https://example.com/charts/top/album/2026/',html:rymChart}});
  expect(res.statusCode).toBe(400);
  res=await t.app.inject({method:'POST',url:'/api/ext/report',headers,payload:{source:'rym',state:'challenge',message:'需要完成验证',url:'https://rateyourmusic.com/charts/top/album/2026/1/'}});
  expect(res.statusCode).toBe(200);
  const state=(await t.app.inject({url:'/api/extension',headers:{cookie:t.cookie}})).json();
  expect(state.reports.map((r:{source:string;state:string})=>`${r.source}:${r.state}`)).toEqual(['rym:challenge','aoty:challenge']);
  // Source cards reflect extension reports for RYM/AOTY instead of server fetches.
  const statuses=(await t.app.inject({url:'/api/sources',headers:{cookie:t.cookie}})).json() as {source:string;status:string}[];
  expect(statuses.find(s=>s.source==='rym')?.status).toBe('blocked');
  expect(statuses.find(s=>s.source==='pitchfork')?.status).toBe('unknown');
  // A running job holds the shared lock; the extension is told to retry.
  store.acquireLock('busy');
  res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url:'https://rateyourmusic.com/release/album/stars/moon/',html:rymChart}});
  expect(res.statusCode).toBe(409);
  store.releaseLock('busy');
  // Regular administrator endpoints keep the small body limit.
  res=await t.app.inject({method:'PUT',url:'/api/extension/refresh',headers:{cookie:t.cookie},payload:{enabled:true,hour:9,targets:['x'.repeat(40000)]}});
  expect(res.statusCode).toBe(413);
 }finally{store.close();await t.done();}
});

it('validates scheduled refresh targets on the server',async()=>{
 const t=await setup();
 try{
  let res=await t.app.inject({method:'PUT',url:'/api/extension/refresh',headers:{cookie:t.cookie},payload:{enabled:true,hour:9,targets:['https://example.com/charts/']}});
  expect(res.statusCode).toBe(400);
  res=await t.app.inject({method:'PUT',url:'/api/extension/refresh',headers:{cookie:t.cookie},payload:{enabled:true,hour:24,targets:[]}});
  expect(res.statusCode).toBe(400);
  res=await t.app.inject({method:'PUT',url:'/api/extension/refresh',headers:{cookie:t.cookie},payload:{enabled:true,hour:9,targets:Array(7).fill('https://rateyourmusic.com/charts/top/album/{year}/1/')}});
  expect(res.statusCode).toBe(400);
  res=await t.app.inject({method:'PUT',url:'/api/extension/refresh',headers:{cookie:t.cookie},payload:{enabled:true,hour:9,targets:['https://rateyourmusic.com/charts/top/album/{year}/2/','https://pitchfork.com/reviews/best/albums/']}});
  expect(res.statusCode).toBe(200);
  const token=(await t.app.inject({method:'POST',url:'/api/extension/token',headers:{cookie:t.cookie}})).json().token as string;
  const config=(await t.app.inject({url:'/api/ext/config',headers:{authorization:`Bearer ${token}`}})).json();
  expect(config).toEqual({refresh:{enabled:true,hour:9,targets:[`https://rateyourmusic.com/charts/top/album/${new Date().getFullYear()}/2/`,'https://pitchfork.com/reviews/best/albums/']}});
 }finally{await t.done();}
});
it('captures Pitchfork review index pages through /api/ext/capture and updates source status',async()=>{
 const t=await setup();
 try{
  const token=(await t.app.inject({method:'POST',url:'/api/extension/token',headers:{cookie:t.cookie}})).json().token as string;
  const headers={authorization:`Bearer ${token}`,origin:'chrome-extension://abcdefghijklmnop'};
  const pfState={transformed:{bundle:{containers:[{items:[{contentType:'review',subHed:{name:'Stars'},dangerousHed:'<em>Moon</em>',url:'/reviews/albums/stars-moon/',ratingValue:{score:8.4,isBestNewMusic:true,isBestNewReissue:false},rubric:[{name:'Indie Rock'}],image:{sources:{sm:{url:'https://media.pitchfork.com/photos/moon.jpg'}}}}]}]}}};
  const res=await t.app.inject({method:'POST',url:'/api/ext/capture',headers,payload:{url:'https://pitchfork.com/reviews/albums/',html:`<script>window.__PRELOADED_STATE__=${JSON.stringify(pfState)};</script>`}});
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({status:'captured',receipt:{source:'pitchfork',added:1}});
  const statuses=(await t.app.inject({url:'/api/sources',headers:{cookie:t.cookie}})).json() as {source:string;status:string}[];
  expect(statuses.find(s=>s.source==='pitchfork')?.status).toBe('ok');
  const albums=(await t.app.inject({url:'/api/albums',headers:{cookie:t.cookie}})).json();
  expect(albums[0]).toMatchObject({artist:'Stars',title:'Moon',coverUrl:'https://media.pitchfork.com/photos/moon.jpg'});
 }finally{await t.done();}
});
