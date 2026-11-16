import { randomUUID } from 'node:crypto';
import type { ChartCapture, CaptureReceipt } from '../shared/types.js';
import type { Store } from './store.js';
import { decide, todayInTimezone } from './policy.js';
import { normalizeIdentity } from './sources/parsers.js';

/** The HTTP caller holds the shared job lock. All persistent changes are atomic. */
export function saveCapture(store:Store,input:ChartCapture):CaptureReceipt {
 return store.transaction(()=>{
  const albums=store.albums(),settings=store.settings();
  const receipt:CaptureReceipt={...structuredClone(input),id:randomUUID(),added:0,updated:0};
  for(const fresh of input.albums){
   const same=albums.filter(a=>normalizeIdentity(a.artist)===normalizeIdentity(fresh.artist)&&normalizeIdentity(a.title)===normalizeIdentity(fresh.title));
   const old=same[0];
   const oldSource=old?.sources.find(o=>o.source===input.source&&/\/release\/|\/album\//.test(o.url));
   const urlConflict=oldSource&&oldSource.url!==fresh.sources[0]?.url;
   if(same.length>1||urlConflict||(old&&(!old.releaseDate||!fresh.releaseDate||old.releaseDate!==fresh.releaseDate||(old.format!=='Unknown'&&fresh.format!=='Unknown'&&old.format!==fresh.format)))){
    receipt.warnings.push(`${fresh.artist} — ${fresh.title}：日期或版本待核对，保留采集证据但未合并`);continue;
   }
   if(old){
    old.sources=old.sources.filter(o=>o.source!==input.source).concat(structuredClone(fresh.sources));
    if(old.format==='Unknown')old.format=fresh.format;
    old.genres=[...new Set([...old.genres,...fresh.genres])];receipt.updated++;
   }else{albums.push(structuredClone(fresh));receipt.added++;}
  }
  const today=todayInTimezone(settings.schedule.timezone,new Date(input.observedAt));
  for(const a of albums)a.decision=decide(a,settings,today);
  store.saveAlbums(albums);store.saveCapture(receipt);store.setValue('latest-preview','');return receipt;
 });
}
