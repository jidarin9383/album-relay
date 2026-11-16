import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings, Album, Playlist, Run, SourceStatus } from '../shared/types.js';
import { defaultSettings } from './policy.js';
export class Store {
 private db:DatabaseSync;
 constructor(dir:string){mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dir,'album-relay.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS job_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);');}
 settings():Settings {const r=this.db.prepare('SELECT value FROM config WHERE key=?').get('settings') as {value:string}|undefined;return r?JSON.parse(r.value) as Settings:structuredClone(defaultSettings)}
 saveSettings(settings:Settings):void{this.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('settings',JSON.stringify(settings))}
 acquireLock(owner:string):boolean{const r=this.db.prepare('INSERT OR IGNORE INTO job_lock(id,owner) VALUES(1,?)').run(owner);return Number(r.changes)===1}
 releaseLock(owner:string):void{this.db.prepare('DELETE FROM job_lock WHERE id=1 AND owner=?').run(owner)}
 getValue(key:string):string|null{const row=this.db.prepare('SELECT value FROM config WHERE key=?').get(key) as {value:string}|undefined;return row?.value??null}
 setValue(key:string,value:string):void{this.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
 private list<T>(key:string):T[]{const value=this.getValue(key);return value?JSON.parse(value) as T[]:[]}
 albums():Album[]{return this.list<Album>('albums')}
 saveAlbums(albums:Album[]):void{this.setValue('albums',JSON.stringify(albums))}
 playlists():Playlist[]{return this.list<Playlist>('playlists')}
 savePlaylist(playlist:Playlist):void{const current=this.playlists().filter(p=>p.month!==playlist.month);current.push(playlist);this.setValue('playlists',JSON.stringify(current))}
 runs():Run[]{return this.list<Run>('runs')}
 saveRun(run:Run):void{const current=this.runs().filter(r=>r.id!==run.id);current.unshift(run);this.setValue('runs',JSON.stringify(current.slice(0,500)))}
 sourceStatuses():SourceStatus[]{return this.list<SourceStatus>('sources')}
 saveSourceStatuses(statuses:SourceStatus[]):void{this.setValue('sources',JSON.stringify(statuses))}
 transaction<T>(operation:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 clearLock():void{this.db.exec('DELETE FROM job_lock')}
 close():void{this.db.close()}
}
