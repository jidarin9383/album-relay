import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { albumId } from './policy.js';
import type { Album, Playlist } from '../shared/types.js';
const input=z.object({playlists:z.record(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),z.object({name:z.string().min(1),original_id:z.number().int().positive(),api_resource_id:z.string().min(1),url:z.string().url(),track_count:z.number().int().nonnegative(),admitted_albums:z.array(z.object({artist:z.string().min(1),title:z.string().min(1),release_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}))}))});
export function importRegistry(store:Store,value:unknown,apply:boolean):{playlists:number;albums:number}{
 const registry=input.parse(value);const owner=randomUUID();if(!store.acquireLock(owner))throw new Error('A job is running; import requires the job lock');try{const albums=store.albums(),playlists:Playlist[]=[];const existing=new Set(store.playlists().map(p=>p.month));
 for(const [month,p] of Object.entries(registry.playlists)){if(existing.has(month))throw new Error(`A playlist already exists for ${month}; refusing to overwrite it`);const ids:string[]=[];
  for(const item of p.admitted_albums){const id=albumId(item.artist,item.title);if(albums.some(a=>a.id===id))throw new Error('An imported album already exists; reconcile before importing');const a:Album={id,artist:item.artist,title:item.title,releaseDate:item.release_date,format:'LP',genres:[],sources:[],excluded:false,admittedMonth:month};albums.push(a);ids.push(id);}
  playlists.push({month,id:p.api_resource_id,originalId:p.original_id,name:p.name,url:p.url,albumIds:ids,trackCount:p.track_count,updatedAt:new Date().toISOString()});
 }
 if(apply)store.transaction(()=>{store.saveAlbums(albums);for(const playlist of playlists)store.savePlaylist(playlist);});
 return {playlists:playlists.length,albums:playlists.reduce((sum,p)=>sum+p.albumIds.length,0)};}finally{store.releaseLock(owner);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.argv[2];if(!file){console.error('Usage: import <registry.json> [--apply]');process.exitCode=1;}else {const store=new Store(resolve(process.env.ALBUM_RELAY_DATA_DIR??'./data'));try{const result=importRegistry(store,JSON.parse(readFileSync(resolve(file),'utf8')),process.argv.includes('--apply'));console.log(JSON.stringify({...result,applied:process.argv.includes('--apply')}));}finally{store.close();}}
}
