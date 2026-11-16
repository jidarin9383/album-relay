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
   const oldSource=old?.sources.find(o=>o.source===input.source&&/\/release\/|\/album\/|\/reviews\/albums\//.test(o.url));
   const urlConflict=oldSource&&oldSource.url!==fresh.sources[0]?.url;
   const oldOnlyEditorial=Boolean(old&&!old.releaseDate&&old.sources.every(o=>o.source==='pitchfork'));
   const dateConflict=Boolean(old&&((old.releaseDate&&fresh.releaseDate&&old.releaseDate!==fresh.releaseDate)||(!fresh.releaseDate&&input.source!=='pitchfork')||(!old.releaseDate&&!oldOnlyEditorial)));
   const formatConflict=Boolean(old&&old.format!=='Unknown'&&fresh.format!=='Unknown'&&old.format!==fresh.format);
   if(same.length>1||urlConflict||dateConflict||formatConflict){
    receipt.warnings.push(`${fresh.artist} — ${fresh.title}：日期或版本待核对，保留采集证据但未合并`);
    if(same.length<=1)(receipt.conflicts??=[]).push(structuredClone(fresh));
    continue;
   }
   if(old){
    old.sources=old.sources.filter(o=>o.source!==input.source).concat(structuredClone(fresh.sources));
    if(!old.releaseDate&&fresh.releaseDate)old.releaseDate=fresh.releaseDate;
    if(old.format==='Unknown')old.format=fresh.format;
    old.coverUrl||=fresh.coverUrl;
    old.genres=[...new Set([...old.genres,...fresh.genres])];receipt.updated++;
   }else{albums.push(structuredClone(fresh));receipt.added++;}
  }
  const today=todayInTimezone(settings.schedule.timezone,new Date(input.observedAt));
  for(const a of albums)a.decision=decide(a,settings,today);
  store.saveAlbums(albums);store.saveCapture(receipt);store.setValue('latest-preview','');return receipt;
 });
}

export function mergeCaptureConflict(store:Store,captureId:string,observationUrl:string):CaptureReceipt {
 return store.transaction(()=>{
  const receipt=store.getCapture(captureId);
  const item=receipt?.conflicts?.find(c=>c.sources[0]?.url===observationUrl);
  if(!receipt||!item)throw new Error('待合并记录不存在');
  const albums=store.albums(),settings=store.settings();
  const same=albums.filter(a=>normalizeIdentity(a.artist)===normalizeIdentity(item.artist)&&normalizeIdentity(a.title)===normalizeIdentity(item.title));
  const old=same[0];
  if(old){
   const src=item.sources[0]!.source;
   old.sources=old.sources.filter(o=>o.source!==src).concat(structuredClone(item.sources));
   if(!old.releaseDate&&item.releaseDate)old.releaseDate=item.releaseDate;
   if(old.format==='Unknown'&&item.format!=='Unknown')old.format=item.format;
   old.coverUrl||=item.coverUrl;
   old.genres=[...new Set([...old.genres,...item.genres])];
   old.rationale='已人工确认版本并合并跨站评分证据';
   receipt.updated++;
  }else{
   albums.push(structuredClone(item));
   receipt.added++;
  }
  receipt.conflicts=(receipt.conflicts??[]).filter(c=>c.sources[0]?.url!==observationUrl);
  const today=todayInTimezone(settings.schedule.timezone);
  for(const a of albums)a.decision=decide(a,settings,today);
  store.saveAlbums(albums);store.updateCapture(receipt);store.setValue('latest-preview','');return receipt;
 });
}
