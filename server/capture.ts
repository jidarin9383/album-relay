import { randomUUID } from 'node:crypto';
import type { Album, ChartCapture, CaptureReceipt, Observation, SourceName } from '../shared/types.js';
import type { Store } from './store.js';
import { decide, todayInTimezone } from './policy.js';
import { normalizeIdentity } from './sources/parsers.js';

const COLLAB_SPLIT_RE = /\s*(?:&|\/|;|\bwith\b|\band\b|\bfeat\.?|\bft\.?)\s*/i;
const DETAIL_URL_RE = /\/release\/|\/album\/|\/reviews\/albums\//;

export function hasCollabSeparator(artist: string): boolean {
  return COLLAB_SPLIT_RE.test(artist);
}

export function primaryArtistNorm(artist: string): string {
  const first = artist.split(COLLAB_SPLIT_RE).map((p) => p.trim()).find(Boolean) ?? '';
  return normalizeIdentity(first);
}

export function isCollaborativeSameRelease(
  a: { artist: string; title: string; releaseDate: string; format: string },
  b: { artist: string; title: string; releaseDate: string; format: string }
): boolean {
  const titleA = normalizeIdentity(a.title);
  const titleB = normalizeIdentity(b.title);
  if (!titleA || titleA !== titleB) return false;
  if (!hasCollabSeparator(a.artist) && !hasCollabSeparator(b.artist)) return false;
  const primA = primaryArtistNorm(a.artist);
  const primB = primaryArtistNorm(b.artist);
  if (primA.length < 3 || primA !== primB) return false;
  if (a.format !== 'Unknown' && b.format !== 'Unknown' && a.format !== b.format) return false;
  if (a.releaseDate && b.releaseDate) return a.releaseDate === b.releaseDate;
  return titleA.length >= 2;
}

export function mergeObservation(oldObs: Observation | undefined, freshObs: Observation): Observation {
  const next = structuredClone(freshObs);
  if (oldObs?.detailCaptured && !next.detailCaptured) {
    next.detailCaptured = true;
    if (next.criticScore === undefined && oldObs.criticScore !== undefined) next.criticScore = oldObs.criticScore;
    if (next.criticVotes === undefined && oldObs.criticVotes !== undefined) next.criticVotes = oldObs.criticVotes;
    if (!next.descriptors?.length && oldObs.descriptors?.length) next.descriptors = [...oldObs.descriptors];
    if (!next.editorialSummary && oldObs.editorialSummary) next.editorialSummary = oldObs.editorialSummary;
    if (!next.reviewSnippets?.length && oldObs.reviewSnippets?.length) next.reviewSnippets = structuredClone(oldObs.reviewSnippets);
  }
  return next;
}

function pickPreferredObservation(a: Observation, b: Observation): Observation {
  const scoreRank = (o: Observation) => (o.status === 'ok' && o.score !== null ? 2 : DETAIL_URL_RE.test(o.url) ? 1 : 0);
  const [winner, loser] =
    scoreRank(b) !== scoreRank(a)
      ? scoreRank(b) > scoreRank(a)
        ? [b, a]
        : [a, b]
      : Date.parse(b.observedAt) >= Date.parse(a.observedAt)
        ? [b, a]
        : [a, b];
  return mergeObservation(loser, winner);
}

function mergeAlbumRecords(target: Album, incoming: Album): void {
  const bySource = new Map<SourceName, Observation>();
  for (const obs of target.sources) bySource.set(obs.source, obs);
  for (const obs of incoming.sources) {
    const prev = bySource.get(obs.source);
    bySource.set(obs.source, prev ? pickPreferredObservation(prev, obs) : structuredClone(obs));
  }
  target.sources = [...bySource.values()];
  if (!target.releaseDate && incoming.releaseDate) target.releaseDate = incoming.releaseDate;
  if (target.format === 'Unknown' && incoming.format !== 'Unknown') target.format = incoming.format;
  target.coverUrl ||= incoming.coverUrl;
  target.genres = [...new Set([...target.genres, ...incoming.genres])];
  if (incoming.descriptors?.length) {
    target.descriptors = [...new Set([...(target.descriptors ?? []), ...incoming.descriptors])];
  }
  if (incoming.capturedLinks) {
    target.capturedLinks = { ...target.capturedLinks, ...incoming.capturedLinks };
  }
  target.admittedMonth ||= incoming.admittedMonth;
  target.listeningStatus ||= incoming.listeningStatus;
  target.excluded ||= incoming.excluded;
  target.match ||= incoming.match;
}

function hasSourceUrlConflict(a: Album, b: Album): boolean {
  for (const oa of a.sources) {
    if (oa.status !== 'ok' && oa.score === null) continue;
    if (!DETAIL_URL_RE.test(oa.url)) continue;
    const ob = b.sources.find((x) => x.source === oa.source && DETAIL_URL_RE.test(x.url) && (x.status === 'ok' || x.score !== null));
    if (ob && ob.url !== oa.url) return true;
  }
  return false;
}

export function dedupeCollaborativeAlbums(albums: Album[]): { albums: Album[]; mergedCount: number } {
  const out: Album[] = [];
  let mergedCount = 0;
  for (const raw of albums) {
    const item = structuredClone(raw);
    const existing = out.find((a) => {
      const exact = normalizeIdentity(a.artist) === normalizeIdentity(item.artist) && normalizeIdentity(a.title) === normalizeIdentity(item.title);
      if (!exact && !isCollaborativeSameRelease(a, item)) return false;
      if (a.releaseDate && item.releaseDate && a.releaseDate !== item.releaseDate) return false;
      if (a.format !== 'Unknown' && item.format !== 'Unknown' && a.format !== item.format) return false;
      return !hasSourceUrlConflict(a, item);
    });
    if (existing) {
      mergeAlbumRecords(existing, item);
      mergedCount++;
    } else {
      out.push(item);
    }
  }
  return { albums: out, mergedCount };
}

/** The HTTP caller holds the shared job lock. All persistent changes are atomic. */
export function saveCapture(store:Store,input:ChartCapture):CaptureReceipt {
 return store.transaction(()=>{
  const albums=store.albums(),settings=store.settings();
  const receipt:CaptureReceipt={...structuredClone(input),id:randomUUID(),added:0,updated:0};
  for(const fresh of input.albums){
   let same=albums.filter(a=>normalizeIdentity(a.artist)===normalizeIdentity(fresh.artist)&&normalizeIdentity(a.title)===normalizeIdentity(fresh.title));
   if(!same.length){
    const collab=albums.filter(a=>isCollaborativeSameRelease(a,fresh));
    if(collab.length===1)same=collab;
   }
   const old=same[0];
   const oldSource=old?.sources.find(o=>o.source===input.source&&DETAIL_URL_RE.test(o.url));
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
    const prevObs=old.sources.find(o=>o.source===input.source);
    const mergedObs=fresh.sources.map(f=>mergeObservation(prevObs,f));
    old.sources=old.sources.filter(o=>o.source!==input.source).concat(mergedObs);
    if(!old.releaseDate&&fresh.releaseDate)old.releaseDate=fresh.releaseDate;
    if(old.format==='Unknown')old.format=fresh.format;
    old.coverUrl||=fresh.coverUrl;
    old.genres=[...new Set([...old.genres,...fresh.genres])];
    if(fresh.descriptors?.length)old.descriptors=[...new Set([...(old.descriptors??[]),...fresh.descriptors])];
    if(fresh.capturedLinks)old.capturedLinks={...old.capturedLinks,...fresh.capturedLinks};
    receipt.updated++;
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
  let same=albums.filter(a=>normalizeIdentity(a.artist)===normalizeIdentity(item.artist)&&normalizeIdentity(a.title)===normalizeIdentity(item.title));
  if(!same.length){
   const collab=albums.filter(a=>isCollaborativeSameRelease(a,item));
   if(collab.length===1)same=collab;
  }
  const old=same[0];
   if(old){
   mergeAlbumRecords(old, item);
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
