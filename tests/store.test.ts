import { it,expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Store, DB_FILENAME, LEGACY_DB_FILENAME } from '../server/store.js';
import { defaultSettings } from '../server/policy.js';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('persists changed settings after restart and prevents overlapping jobs',()=>{const dir=mkdtempSync(join(tmpdir(),'album-relay-'));try{let db=new Store(dir);db.saveSettings({...defaultSettings,lookbackDays:45});expect(db.acquireLock('one')).toBe(true);expect(db.acquireLock('two')).toBe(false);db.releaseLock('one');db.close();db=new Store(dir);expect(db.settings().lookbackDays).toBe(45);expect(db.acquireLock('two')).toBe(true);db.close()}finally{rmSync(dir,{recursive:true,force:true})}});
it('persists albums, job history, and playlist registry across restart',()=>{const dir=mkdtempSync(join(tmpdir(),'album-relay-'));try{let db=new Store(dir);db.setValue('probe','value');db.saveAlbums([{id:'id1',artist:'Artist',title:'Album',releaseDate:'2026-10-30',format:'LP',genres:[],sources:[],excluded:true}]);db.savePlaylist({month:'2026-11',id:'enc',originalId:123,name:'List',url:'https://example.com',albumIds:['id1'],trackCount:1,updatedAt:'2026-11-16'});db.saveRun({id:'run1',mode:'preview',status:'partial',stage:'match',message:'unavailable',startedAt:'2026-11-16',logs:[]});db.close();db=new Store(dir);expect(db.getValue('probe')).toBe('value');expect(db.albums()[0]?.excluded).toBe(true);expect(db.playlists()[0]?.originalId).toBe(123);expect(db.runs()[0]?.status).toBe('partial');db.close()}finally{rmSync(dir,{recursive:true,force:true})}});
it('rolls back an interrupted registry import transaction',()=>{const dir=mkdtempSync(join(tmpdir(),'relay-transaction-'));const db=new Store(dir);try{expect(()=>db.transaction(()=>{db.setValue('partial','written');throw new Error('simulated interruption');})).toThrow('simulated interruption');expect(db.getValue('partial')).toBeNull();}finally{db.close();rmSync(dir,{recursive:true,force:true});}});
it('uses listen-better.sqlite for fresh installs and keeps reading an existing album-relay.sqlite',()=>{
  const freshDir=mkdtempSync(join(tmpdir(),'listen-better-fresh-'));
  const legacyDir=mkdtempSync(join(tmpdir(),'listen-better-legacy-'));
  try{
    const fresh=new Store(freshDir);
    fresh.close();
    expect(existsSync(join(freshDir,DB_FILENAME))).toBe(true);
    expect(existsSync(join(freshDir,LEGACY_DB_FILENAME))).toBe(false);

    const seed=new DatabaseSync(join(legacyDir,LEGACY_DB_FILENAME));
    seed.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE job_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);');
    seed.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('probe','legacy-ok');
    seed.close();

    const migrated=new Store(legacyDir);
    try{
      expect(migrated.getValue('probe')).toBe('legacy-ok');
      expect(existsSync(join(legacyDir,DB_FILENAME))).toBe(false);
    }finally{migrated.close();}
  }finally{
    rmSync(freshDir,{recursive:true,force:true});
    rmSync(legacyDir,{recursive:true,force:true});
  }
});
