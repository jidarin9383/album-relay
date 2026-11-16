import {it,expect} from 'vitest';
import {importRegistry} from '../server/import.js';
import {Store} from '../server/store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
it('imports a reviewed playlist and admissions without touching the target platform',()=>{const dir=mkdtempSync(join(tmpdir(),'relay-import-'));const s=new Store(dir);try{const registry={playlists:{'2026-11':{name:'Monthly',original_id:123,api_resource_id:'resource',url:'https://music.163.com/#/playlist?id=123',track_count:2,admitted_albums:[{artist:'Artist',title:'Album',release_date:'2026-11-01'}]}}};expect(importRegistry(s,registry,false)).toMatchObject({playlists:1,albums:1});expect(s.playlists()).toHaveLength(0);importRegistry(s,registry,true);expect(s.playlists()[0]?.albumIds).toHaveLength(1);expect(s.albums()[0]?.admittedMonth).toBe('2026-11');expect(()=>importRegistry(s,registry,true)).toThrow();}finally{s.close();rmSync(dir,{recursive:true,force:true});}});
it('refuses import while a background job owns the data lock',()=>{const dir=mkdtempSync(join(tmpdir(),'relay-import-lock-'));const s=new Store(dir);try{s.acquireLock('background-job');expect(()=>importRegistry(s,{playlists:{}},true)).toThrow(/running|lock/i);}finally{s.releaseLock('background-job');s.close();rmSync(dir,{recursive:true,force:true});}});
