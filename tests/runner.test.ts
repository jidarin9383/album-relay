import { describe,it,expect,vi } from 'vitest';
import { Runner, type RunnerStore } from '../server/runner.js';
import { defaultSettings } from '../server/policy.js';
import type { Album,Playlist,Run,SourceStatus,Settings,SyncPreview } from '../shared/types.js';
function setup(){let albums:Album[]=[],playlists:Playlist[]=[],runs:Run[]=[],lock='';const values=new Map<string,string>();const store:RunnerStore={settings:()=>structuredClone(defaultSettings),albums:()=>structuredClone(albums),saveAlbums:a=>{albums=structuredClone(a);},playlists:()=>structuredClone(playlists),savePlaylist:p=>{playlists=playlists.filter(x=>x.id!==p.id).concat(structuredClone(p));},runs:()=>structuredClone(runs),saveRun:r=>{runs=runs.filter(x=>x.id!==r.id).concat(structuredClone(r));},acquireLock:o=>{if(lock)return false;lock=o;return true;},releaseLock:o=>{if(lock===o)lock='';},sourceStatuses:()=>[],saveSourceStatuses:(_s:SourceStatus[])=>{},getValue:k=>values.get(k),setValue:(k,v)=>{values.set(k,v);}};const sources={refresh:vi.fn(async(_s:Settings,_a:Album[],_p:(s:string)=>void):Promise<{albums:Album[];statuses:SourceStatus[]}>=>({albums:store.albums(),statuses:[]}))};const netease={match:vi.fn(async(a:Album)=>a.match??null),sync:vi.fn(async(_preview:SyncPreview,_checkpoint:(p:Playlist)=>void|Promise<void>,_progress:(s:string)=>void):Promise<Playlist|null>=>null)};return {store,sources,netease,runner:new Runner(store,sources,netease)};}
describe('Runner lifecycle',()=>{
 it('returns immediately, prevents concurrent jobs and releases the lock',async()=>{const x=setup();let finish!:()=>void;x.sources.refresh.mockImplementationOnce(async()=>{await new Promise<void>(r=>{finish=r;});return {albums:[],statuses:[]};});const run=x.runner.start('refresh');expect(run.status).toBe('queued');expect(()=>x.runner.start('preview')).toThrow(/运行/);await Promise.resolve();finish();await x.runner.wait();expect(x.store.runs()[0]?.status).toBe('succeeded');x.runner.start('refresh');await x.runner.wait();});
 it('records failure and permits a later run',async()=>{const x=setup();x.sources.refresh.mockRejectedValueOnce(new Error('offline'));x.runner.start('refresh');await x.runner.wait();expect(x.store.runs()[0]?.status).toBe('failed');x.runner.start('preview');await x.runner.wait();expect(x.store.runs().at(-1)?.status).toBe('succeeded');expect(x.netease.sync).not.toHaveBeenCalled();});
 it('requires a real current preview before writing',async()=>{const x=setup();x.runner.start('sync');await x.runner.wait();expect(x.store.runs()[0]?.status).toBe('failed');expect(x.netease.sync).not.toHaveBeenCalled();});
 it('holds blocked refresh for verification and does not claim success',async()=>{const x=setup();x.sources.refresh.mockResolvedValueOnce({albums:[],statuses:[{source:'rym',status:'blocked',message:'CAPTCHA'}]});x.runner.start('preview');await x.runner.wait();expect(x.store.runs()[0]?.status).toBe('waiting_verification');});
 it('recovers interrupted jobs without replaying writes',()=>{const x=setup();x.store.saveRun({id:'old',mode:'sync',status:'running',stage:'write',message:'',startedAt:'2026-01-01T00:00:00Z',logs:[]});x.store.acquireLock('old');x.runner.recoverInterrupted();expect(x.store.runs()[0]?.status).toBe('failed');expect(x.store.acquireLock('new')).toBe(true);expect(x.netease.sync).not.toHaveBeenCalled();});
});

function selected():Album {const date=new Date(Date.now()-20*86400000).toISOString().slice(0,10);return {id:'a',artist:'Artist',title:'Album',releaseDate:date,format:'LP',genres:[],excluded:false,sources:[{source:'aoty',score:85,scale:100,votes:1000,url:'https://www.albumoftheyear.org/album/1.php',observedAt:new Date().toISOString(),status:'ok'},{source:'rym',score:3.8,scale:5,votes:1000,url:'https://rateyourmusic.com/release/album/a/b/',observedAt:new Date().toISOString(),status:'ok'}],match:{id:'album',originalId:1,name:'Album',artist:'Artist',releaseDate:date,tracks:[{id:'track',originalId:2,name:'Song'}]}};}
it('generates a genuine preview then rechecks matching before sync and marks admissions',async()=>{const x=setup();x.store.saveAlbums([selected()]);x.runner.start('preview');await x.runner.wait();expect(x.store.runs().at(-1)?.preview?.trackCount).toBe(1);x.netease.sync.mockImplementationOnce(async(p,checkpoint)=>{const playlist:Playlist={month:p.month,id:'playlist',originalId:3,name:p.playlistName,url:'https://music.163.com/#/playlist?id=3',albumIds:['a'],trackCount:1,updatedAt:new Date().toISOString()};await checkpoint(playlist);return playlist;});x.runner.start('sync');await x.runner.wait();expect(x.netease.match).toHaveBeenCalledTimes(2);expect(x.netease.sync).toHaveBeenCalledTimes(1);expect(x.store.runs().at(-1)?.status).toBe('succeeded');expect(x.store.albums()[0]?.admittedMonth).toMatch(/^\d{4}-\d{2}$/);});
it('refuses changed exclusions after preview and makes no writes',async()=>{const x=setup();x.store.saveAlbums([selected()]);x.runner.start('preview');await x.runner.wait();const albums=x.store.albums();albums[0]!.excluded=true;x.store.saveAlbums(albums);x.runner.start('sync');await x.runner.wait();expect(x.store.runs().at(-1)?.status).toBe('failed');expect(x.netease.sync).not.toHaveBeenCalled();});
it('persists a checkpoint and marks a subsequent write failure partial',async()=>{const x=setup();x.store.saveAlbums([selected()]);x.runner.start('preview');await x.runner.wait();x.netease.sync.mockImplementationOnce(async(p,checkpoint)=>{await checkpoint({month:p.month,id:'playlist',originalId:3,name:p.playlistName,url:'',albumIds:[],trackCount:0,updatedAt:new Date().toISOString()});throw new Error('readback failed');});x.runner.start('sync');await x.runner.wait();expect(x.store.runs().at(-1)?.status).toBe('partial');expect(x.store.playlists()[0]?.id).toBe('playlist');expect(x.store.albums()[0]?.admittedMonth).toBeUndefined();});
it('marks uncertain remote writes partial even when no new checkpoint was returned',async()=>{const x=setup();x.store.saveAlbums([selected()]);x.runner.start('preview');await x.runner.wait();x.netease.sync.mockRejectedValueOnce(new Error('response lost after write'));x.runner.start('sync');await x.runner.wait();expect(x.store.runs().at(-1)?.status).toBe('partial');});
it('rejects a preview when its qualifying source observations have aged out',async()=>{vi.useFakeTimers();try{const x=setup(),a=selected();a.sources.forEach(s=>s.observedAt=new Date(Date.now()-5*3600000-50*60000).toISOString());x.store.saveAlbums([a]);x.runner.start('preview');await x.runner.wait();vi.advanceTimersByTime(20*60000);x.runner.start('sync');await x.runner.wait();expect(x.store.runs().at(-1)?.status).toBe('failed');expect(x.netease.sync).not.toHaveBeenCalled();}finally{vi.useRealTimers();}});
it('previews and syncs saved browser-capture albums without refreshing sources and skips unmatched catalog misses',async()=>{
 const x=setup();
 const date=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
 const capturedAt=new Date(Date.now()-2*86400000).toISOString();
 const a1:Album={...selected(),id:'a1',artist:'Artist 1',title:'Album 1',releaseDate:date,match:undefined};
 a1.sources.forEach(s=>{s.observedAt=capturedAt;s.collectionMethod='browser-capture';});
 const a2:Album={...selected(),id:'a2',artist:'Artist 2',title:'Album 2',releaseDate:date,match:undefined};
 a2.sources.forEach(s=>{s.observedAt=capturedAt;s.collectionMethod='browser-capture';});
 x.store.saveAlbums([a1,a2]);
 x.netease.match.mockImplementation(async(a)=>a.id==='a1'?{id:'m1',originalId:11,name:a.title,artist:a.artist,releaseDate:date,tracks:[{id:'t1',originalId:21,name:'Song 1'}]}:null);
 const previewRun=x.runner.start('library_preview');
 await x.runner.wait();
 expect(x.sources.refresh).not.toHaveBeenCalled();
 const completedPreview=x.store.runs().find(r=>r.id===previewRun.id);
 expect(completedPreview?.status).toBe('succeeded');
 expect(completedPreview?.preview?.albums.map(a=>a.id)).toEqual(['a1']);
 expect(completedPreview?.preview?.warnings).toContain('Artist 2 — Album 2：没有唯一完整匹配，暂不写入');
 x.netease.sync.mockImplementationOnce(async(p,checkpoint)=>{
  const playlist:Playlist={month:p.month,id:'pl-1',originalId:33,name:p.playlistName,url:'https://music.163.com/#/playlist?id=33',albumIds:p.albums.map(a=>a.id),trackCount:p.trackCount,updatedAt:new Date().toISOString()};
  await checkpoint(playlist);
  return playlist;
 });
 const syncRun=x.runner.start('sync');
 await x.runner.wait();
 expect(x.store.runs().find(r=>r.id===syncRun.id)?.status).toBe('succeeded');
 expect(x.netease.sync).toHaveBeenCalledTimes(1);
 expect(x.store.albums().find(a=>a.id==='a1')?.admittedMonth).toMatch(/^\d{4}-\d{2}$/);
 expect(x.store.albums().find(a=>a.id==='a2')?.admittedMonth).toBeUndefined();
});
it('expires browser-capture evidence older than 7 days and marks transport match failures partial',async()=>{
 const x=setup();
 const date=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
 const stale=selected();stale.id='stale';stale.releaseDate=date;stale.match=undefined;
 stale.sources.forEach(s=>{s.observedAt=new Date(Date.now()-8*86400000).toISOString();s.collectionMethod='browser-capture';});
 const fresh=selected();fresh.id='fresh';fresh.releaseDate=date;fresh.match=undefined;
 fresh.sources.forEach(s=>{s.observedAt=new Date(Date.now()-86400000).toISOString();s.collectionMethod='browser-capture';});
 x.store.saveAlbums([stale,fresh]);
 x.netease.match.mockRejectedValueOnce(new Error('CLI network error'));
 const run=x.runner.start('library_preview');
 await x.runner.wait();
 expect(x.sources.refresh).not.toHaveBeenCalled();
 const savedStale=x.store.albums().find(a=>a.id==='stale');
 expect(savedStale?.decision?.status).toBe('pending');
 expect(savedStale?.sources.every(s=>s.status==='error')).toBe(true);
 expect(x.store.runs().find(r=>r.id===run.id)?.status).toBe('partial');
 const syncRun=x.runner.start('sync');
 await x.runner.wait();
 expect(x.store.runs().find(r=>r.id===syncRun.id)?.status).toBe('failed');
 expect(x.netease.sync).not.toHaveBeenCalled();
});
it('auto_sync evaluates, matches and writes the playlist in one run without prior preview',async()=>{
 const x=setup();
 const a=selected();a.match=undefined;
 const dismissed={...selected(),id:'d',artist:'Dismissed',title:'Skipped LP',listeningStatus:'skipped' as const};
 x.store.saveAlbums([a,dismissed]);
 x.netease.match.mockImplementation(async(alb)=>({id:`m-${alb.id}`,originalId:99,name:alb.title,artist:alb.artist,releaseDate:alb.releaseDate,tracks:[{id:'t1',originalId:201,name:'Song'}]}));
 x.netease.sync.mockImplementationOnce(async(p,checkpoint)=>{
  const playlist:Playlist={month:p.month,id:'pl-auto',originalId:888,name:p.playlistName,url:'https://music.163.com/#/playlist?id=888',albumIds:p.albums.map(al=>al.id),trackCount:p.trackCount,updatedAt:new Date().toISOString()};
  await checkpoint(playlist);
  return playlist;
 });
 const run=x.runner.start('auto_sync');
 await x.runner.wait();
 expect(x.netease.match).toHaveBeenCalledTimes(1);
 expect(x.netease.sync).toHaveBeenCalledTimes(1);
 expect(x.store.runs().find(r=>r.id===run.id)?.status).toBe('succeeded');
 expect(x.store.albums().find(al=>al.id==='a')?.admittedMonth).toMatch(/^\d{4}-\d{2}$/);
 expect(x.store.playlists()[0]?.albumIds).toEqual(['a']);
});
