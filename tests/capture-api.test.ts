import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { NeteaseClient } from '../server/netease.js';
import { SourceService } from '../server/sources/index.js';
import { Store } from '../server/store.js';
import { aotyChart, rymChart } from './fixtures/charts.js';
import type { FastifyInstance } from 'fastify';
/** Pair a fake extension and return a function that pushes a rendered page like the real one does. */
async function extensionPush(app:FastifyInstance,cookie:string){
 const token=(await app.inject({method:'POST',url:'/api/extension/token',headers:{cookie}})).json().token as string;
 return (url:string,html:string)=>app.inject({method:'POST',url:'/api/ext/capture',headers:{authorization:`Bearer ${token}`,origin:'chrome-extension://test'},payload:{url,html}});
}
it('recovers a source action interrupted before any run was created',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-capture-restart-'));const before=new Store(dir);before.acquireLock('http-action:interrupted');before.close();
 const app=await createApp({dataDir:dir,scheduler:false});const after=new Store(dir);
 try{expect(after.acquireLock('next-run')).toBe(true);}finally{after.releaseLock('next-run');after.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
it('completes capture, library_preview and sync end-to-end through HTTP without scraping sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-library-preview-api-'));
 const release=new Date(Date.now()-20*86400000);
 const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const rymDate=`${release.getUTCDate()} ${months[release.getUTCMonth()]} ${release.getUTCFullYear()}`;
 const aotyDate=`${months[release.getUTCMonth()]} ${release.getUTCDate()}, ${release.getUTCFullYear()}`;
 const isoDate=release.toISOString().slice(0,10);
 const rymHtml=rymChart.replace('30 October 2026',rymDate);
 const aotyHtml=aotyChart.replace('October 30, 2026',aotyDate);
 const fetchMock=vi.fn(async()=>new Response('',{status:500}));vi.stubGlobal('fetch',fetchMock);
 let playlistName='',playlistDesc='';
 let tracks:{id:string;originalId:number;name:string}[]=[];
 const netease=new NeteaseClient(dir,{command:async(args)=>{
  const cmd=`${args[0]} ${args[1]}`;
  if(cmd==='search album')return {code:200,data:{records:[{id:'alb-1',originalId:101,name:'Moon',artists:[{name:'Stars'}],publishTime:Date.parse(`${isoDate}T00:00:00Z`)}]}};
  if(cmd==='album tracks')return {code:200,data:[{id:'tr-1',originalId:1001,name:'Track One'},{id:'tr-2',originalId:1002,name:'Track Two'}]};
  if(cmd==='playlist create'){const idx=args.indexOf('--playlistName');playlistName=idx>=0?args[idx+1]!:'';return {code:200,data:{id:'pl-1',originalId:5001}};}
  if(cmd==='playlist tracks')return {code:200,data:tracks};
  if(cmd==='playlist add'){const idx=args.indexOf('--songIdList');const ids=JSON.parse(args[idx+1]!) as string[];tracks=tracks.concat(ids.map((id,i)=>({id,originalId:1001+i,name:`Track ${i+1}`})));return {code:200,data:{}};}
  if(cmd==='playlist reorder'){const idx=args.indexOf('--trackIds');const ids=JSON.parse(args[idx+1]!) as string[];tracks=ids.map(id=>tracks.find(t=>t.id===id)!);return {code:200,data:{}};}
  if(cmd==='playlist updateDesc'){const idx=args.indexOf('--desc');playlistDesc=idx>=0?args[idx+1]!:'';return {code:200,data:{}};}
  if(cmd==='playlist get')return {code:200,data:{name:playlistName,describe:playlistDesc,trackCount:tracks.length}};
  throw new Error(`Unexpected command: ${cmd}`);
 }});
 const app=await createApp({dataDir:dir,scheduler:false,sources:new SourceService(dir),netease});
 const waitRun=async(id:string,cookie:string)=>{
  for(let i=0;i<50;i++){
   const res=await app.inject({url:`/api/runs/${id}`,headers:{cookie}});
   const run=res.json();
   if(!['queued','running'].includes(run.status))return run;
   await new Promise(r=>setTimeout(r,20));
  }
  throw new Error('Run timed out');
 };
 try{
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{password:'library-preview-pass-123'}});
  const cookie=setup.headers['set-cookie'] as string;
  const push=await extensionPush(app,cookie);
  expect((await push('https://rateyourmusic.com/charts/top/album/2026/1/',rymHtml)).statusCode).toBe(200);
  expect((await push('https://www.albumoftheyear.org/ratings/user-highest-rated/lp/2026/',aotyHtml)).statusCode).toBe(200);
  const settings=(await app.inject({url:'/api/settings',headers:{cookie}})).json();
  settings.allowApproximateVotes=true;
  expect((await app.inject({method:'PUT',url:'/api/settings',headers:{cookie},payload:settings})).statusCode).toBe(200);
  const previewStart=await app.inject({method:'POST',url:'/api/runs',headers:{cookie},payload:{mode:'library_preview'}});
  expect(previewStart.statusCode).toBe(200);
  const previewRun=await waitRun(previewStart.json().id,cookie);
  expect(previewRun.status).toBe('succeeded');
  expect(previewRun.preview.albums).toHaveLength(1);
  expect(previewRun.preview.trackCount).toBe(2);
  expect(fetchMock).not.toHaveBeenCalled();
  const syncStart=await app.inject({method:'POST',url:'/api/runs',headers:{cookie},payload:{mode:'sync'}});
  expect(syncStart.statusCode).toBe(200);
  const syncRun=await waitRun(syncStart.json().id,cookie);
  expect(syncRun.status).toBe('succeeded');
  const playlists=(await app.inject({url:'/api/playlists',headers:{cookie}})).json();
  expect(playlists).toHaveLength(1);
  expect(playlists[0]).toMatchObject({id:'pl-1',originalId:5001,trackCount:2});
  expect(playlists[0].albumIds).toHaveLength(1);
 }finally{
  vi.unstubAllGlobals();
  await app.close();
  rmSync(dir,{recursive:true,force:true});
 }
});
it('supports single-page RYM/AOTY/Pitchfork capture via the extension, conflict merge and listening status',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-phase1-complete-'));
 const d1=new Date(Date.now()-20*86400000);
 const d2=new Date(Date.now()-19*86400000);
 const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const fmtAoty=(d:Date)=>`${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
 const fmtRym=(d:Date)=>`${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
 const app=await createApp({dataDir:dir,scheduler:false,sources:new SourceService(dir)});
 try{
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{password:'phase1-complete-password-123'}});
  const cookie=setup.headers['set-cookie'] as string;

  const push=await extensionPush(app,cookie);
  // Search result pages are not capturable; the user opens the album page itself.
  const searchCap=await push('https://www.albumoftheyear.org/search/?q=Stars%20Moon','<div>Search results</div>');
  expect(searchCap.statusCode).toBe(400);

  // Non-LP AOTY chart -> Unknown format, upgraded by AOTY album detail capture -> LP
  const nonLpRes=await push('https://www.albumoftheyear.org/ratings/user-highest-rated/2026/',aotyChart.replace('October 30, 2026',fmtAoty(d1)));const nonLp={statusCode:nonLpRes.statusCode,json:()=>nonLpRes.json().receipt};
  expect(nonLp.statusCode).toBe(200);
  expect((await app.inject({url:'/api/albums',headers:{cookie}})).json()[0].format).toBe('Unknown');

  const aotyDetailRes=await push('https://www.albumoftheyear.org/album/1-stars-moon.php',`<div class="artist">Stars</div><div class="albumTitle">Moon</div><div class="albumUserScoreBox"><div class="albumUserScore">85</div><div class="text numReviews">Based on <strong>4,942</strong> ratings</div></div><div class="detailRow">${fmtAoty(d1)} / release date</div><div class="detailRow">LP / format</div>`);const aotyDetail={statusCode:aotyDetailRes.statusCode,json:()=>aotyDetailRes.json().receipt};
  expect(aotyDetail.statusCode).toBe(200);expect(aotyDetail.json()).toMatchObject({added:0,updated:1});
  expect((await app.inject({url:'/api/albums',headers:{cookie}})).json()[0].format).toBe('LP');

  // Pitchfork single review capture (empty releaseDate corroborates existing album without date conflict)
  const pfState={transformed:{review:{headerProps:{artists:[{name:'Stars'}],title:'Moon',musicRating:{rating:8.4,bestNewMusic:true,bestNewReissue:false}}}}};
  const pfResRes=await push('https://pitchfork.com/reviews/albums/stars-moon/',`<script>window.__PRELOADED_STATE__=${JSON.stringify(pfState)};</script>`);const pfRes={statusCode:pfResRes.statusCode,json:()=>pfResRes.json().receipt};
  expect(pfRes.statusCode).toBe(200);expect(pfRes.json()).toMatchObject({added:0,updated:1});
  let albums=(await app.inject({url:'/api/albums',headers:{cookie}})).json();
  expect(albums[0].sources).toHaveLength(2);
  expect(albums[0].decision.status).toBe('selected');

  // RYM single release capture with 1-day date difference triggers conflict, then manual merge resolves it
  const rymConflictRes=await push('https://rateyourmusic.com/release/album/stars/moon/',`<h1 class="album_title">Moon</h1><span class="album_artist"><a>Stars</a></span><span itemprop="ratingValue">3.9</span><span itemprop="ratingCount">6k</span><table><tr><th>Released</th><td>${fmtRym(d2)}</td></tr><tr><th>Type</th><td>Album</td></tr></table>`);const rymConflict={statusCode:rymConflictRes.statusCode,json:()=>rymConflictRes.json().receipt};
  expect(rymConflict.statusCode).toBe(200);
  const receipt=rymConflict.json();
  expect(receipt.updated).toBe(0);expect(receipt.conflicts).toHaveLength(1);
  expect(receipt.conflicts[0].sources[0]).toMatchObject({source:'rym',votes:6000,votesApproximate:true});

  const merged=await app.inject({method:'POST',url:`/api/captures/${receipt.id}/merge`,headers:{cookie},payload:{url:'https://rateyourmusic.com/release/album/stars/moon/'}});
  expect(merged.statusCode).toBe(200);
  expect(merged.json().updated).toBe(1);expect(merged.json().conflicts).toEqual([]);
  albums=(await app.inject({url:'/api/albums',headers:{cookie}})).json();
  expect(albums[0].sources).toHaveLength(3);

  // Listening status persistence & invalid rejection
  const id=albums[0].id as string;
  expect((await app.inject({method:'POST',url:`/api/albums/${id}/status`,headers:{cookie},payload:{listeningStatus:'invalid'}})).statusCode).toBe(400);
  const statusRes=await app.inject({method:'POST',url:`/api/albums/${id}/status`,headers:{cookie},payload:{listeningStatus:'liked'}});
  expect(statusRes.statusCode).toBe(200);expect(statusRes.json().listeningStatus).toBe('liked');
  expect((await app.inject({url:'/api/albums',headers:{cookie}})).json()[0].listeningStatus).toBe('liked');
 }finally{
  await app.close();
  rmSync(dir,{recursive:true,force:true});
 }
});
