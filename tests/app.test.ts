import {it,expect,vi} from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
it('protects settings behind first-run login and persists real changes',async()=>{const dir=mkdtempSync(join(tmpdir(),'album-relay-http-'));const app=await createApp({dataDir:dir,scheduler:false});try{let res=await app.inject({method:'GET',url:'/api/session'});expect(res.json()).toEqual({authenticated:false,setupRequired:true});res=await app.inject({method:'GET',url:'/api/settings'});expect(res.statusCode).toBe(401);res=await app.inject({method:'POST',url:'/api/setup',payload:{password:'sufficiently-long-password'}});expect(res.statusCode).toBe(200);const cookie=res.headers['set-cookie'] as string;expect(cookie).toContain('HttpOnly');res=await app.inject({method:'GET',url:'/api/settings',headers:{cookie}});const settings=res.json();settings.lookbackDays=45;res=await app.inject({method:'PUT',url:'/api/settings',headers:{cookie,origin:'http://evil.example',host:'localhost'},payload:settings});expect(res.statusCode).toBe(403);res=await app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:settings});expect(res.statusCode).toBe(200);expect(res.json().lookbackDays).toBe(45);res=await app.inject({method:'GET',url:'/api/settings',headers:{cookie}});expect(res.json().lookbackDays).toBe(45)}finally{await app.close();rmSync(dir,{recursive:true,force:true})}});
it('does not let an exclusion overwrite an active job snapshot',async()=>{const {Store}=await import('../server/store.js');const dir=mkdtempSync(join(tmpdir(),'relay-lock-http-'));const app=await createApp({dataDir:dir,scheduler:false});const other=new Store(dir);try{const res=await app.inject({method:'POST',url:'/api/setup',payload:{password:'synthetic-local-password'}});const cookie=res.headers['set-cookie'] as string;expect(other.acquireLock('running-job')).toBe(true);const result=await app.inject({method:'POST',url:'/api/albums/any/exclude',headers:{cookie},payload:{excluded:true}});expect(result.statusCode).toBe(409);}finally{other.releaseLock('running-job');other.close();await app.close();rmSync(dir,{recursive:true,force:true});}});
it('remembers a configured connection without storing or returning credentials',async()=>{const {Store}=await import('../server/store.js');const dir=mkdtempSync(join(tmpdir(),'relay-connection-http-'));const store=new Store(dir);store.setValue('netease-configured','true');store.close();const app=await createApp({dataDir:dir,scheduler:false});try{const res=await app.inject({method:'POST',url:'/api/setup',payload:{password:'{{SECRET_fld3ilpc}}'}});const cookie=res.headers['set-cookie'] as string;expect((await app.inject({url:'/api/connection',headers:{cookie}})).json()).toMatchObject({configured:true,loggedIn:false});}finally{await app.close();rmSync(dir,{recursive:true,force:true});}});
it('limits repeated wrong administrator logins',async()=>{const dir=mkdtempSync(join(tmpdir(),'relay-login-limit-'));const app=await createApp({dataDir:dir,scheduler:false});try{await app.inject({method:'POST',url:'/api/setup',payload:{password:'login-test-correct-passphrase'}});for(let n=0;n<10;n++){const r=await app.inject({method:'POST',url:'/api/login',payload:{password:'login-test-incorrect-passphrase'}});expect(r.statusCode).toBe(401);}const blocked=await app.inject({method:'POST',url:'/api/login',payload:{password:'login-test-correct-passphrase'}});expect(blocked.statusCode).toBe(429);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}});
it('resolves public covers without mutating saved album snapshots and supports manual format updates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-covers-format-'));
 const releaseDate=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
 const store=new Store(dir);
 store.saveAlbums([{
  id:'alb-1',artist:'Stars',title:'Moon',releaseDate,format:'Unknown',
  coverUrl:'https://cdn2.albumoftheyear.org/375x0/album/blocked.jpg',
  genres:[],excluded:false,
  sources:[{source:'pitchfork',score:8.4,scale:10,votes:null,url:'https://pitchfork.com/reviews/albums/stars-moon/',observedAt:new Date().toISOString(),status:'ok',bestNewMusic:true},{source:'rym',score:3.9,scale:5,votes:6000,votesDisplay:'6k',votesApproximate:true,url:'https://rateyourmusic.com/release/album/stars/moon/',observedAt:new Date().toISOString(),status:'ok'}]
 }]);
 store.setValue('latest-preview','sentinel');
 const originalAlbums=store.albums();
 store.close();
 const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(
  String(url).includes('itunes.apple.com')
   ? {results:[{artistName:'Stars',collectionName:'Moon',artworkUrl100:'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg'}]}
   : {data:[]}
 ),{status:200,headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',fetchMock);
 const app=await createApp({dataDir:dir,scheduler:false});
 try{
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{password:'cover-format-test-password'}});
  const cookie=setup.headers['set-cookie'] as string;
  // Startup migration marks Unknown format on a ready LP candidate as format_conflict (when minSources met & dated)
  const listedBefore=(await app.inject({url:'/api/albums',headers:{cookie}})).json();
  expect(listedBefore[0].coverUrl).toBeUndefined();
  expect(listedBefore[0].decision.status).toBe('format_conflict');
  // Cover route resolves a public cover and redirects 302 without mutating store.albums()
  const coverRes=await app.inject({url:'/api/albums/alb-1/cover',headers:{cookie}});
  expect(coverRes.statusCode).toBe(302);
  expect(coverRes.headers.location).toBe('https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg');
  const listedAfter=(await app.inject({url:'/api/albums',headers:{cookie}})).json();
  expect(listedAfter[0].coverUrl).toBe('https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg');
  const verifyStore=new Store(dir);
  try{
   expect(verifyStore.albums()[0]?.coverUrl).toBe(originalAlbums[0]?.coverUrl);
   expect(verifyStore.covers()['alb-1']).toBe('https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg');
  }finally{verifyStore.close();}
  // Manual format update promotes LP to selected and clears latest-preview
  expect((await app.inject({method:'POST',url:'/api/albums/alb-1/format',headers:{cookie},payload:{format:'INVALID'}})).statusCode).toBe(400);
  const formatted=await app.inject({method:'POST',url:'/api/albums/alb-1/format',headers:{cookie},payload:{format:'LP'}});
  expect(formatted.statusCode).toBe(200);
  expect(formatted.json()).toMatchObject({format:'LP',coverUrl:'https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg',decision:{status:'selected'}});
 }finally{
  vi.unstubAllGlobals();
  await app.close();
  rmSync(dir,{recursive:true,force:true});
 }
});
