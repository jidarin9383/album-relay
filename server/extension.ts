import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hasAlbumReviewEvidence } from '../shared/review-evidence.js';
import type { Album, ExtensionRefresh, ExtensionReport, ExtensionState, SourceName } from '../shared/types.js';
import type { Store } from './store.js';
import { origins } from './sources/parsers.js';
import { isCanonicalSourceDetailUrl } from './links.js';

const SOURCE_BACKFILL_PRIORITY: Record<SourceName, number> = { pitchfork: 0, aoty: 1, rym: 2 };

const TOKEN_KEY='extension-token';
const REFRESH_KEY='extension-refresh';
const STATE_KEY='extension-state';
export const EXTENSION_PREFIX='/api/ext/';
export const MAX_REFRESH_TARGETS=6;
/** Same page should not be re-imported more often than this when the user simply revisits it. */
export const RECAPTURE_INTERVAL_MS=30*60*1000;

export const DEFAULT_REFRESH:ExtensionRefresh={
 enabled:true,
 hour:10,
 detailBackfill:true,
 detailBatchSize:4,
 targets:[
  `${origins.rym}/charts/top/album/{year}/1/`,
  `${origins.rym}/charts/popular/album/{year}/1/`,
  `${origins.rym}/charts/top/album/{year}/2/`,
  `${origins.aoty}/ratings/user-highest-rated/lp/{year}/`,
  `${origins.aoty}/ratings/user-highest-rated/lp/{year}/?p=2`,
  `${origins.pitchfork}/reviews/albums/`
 ]
};

const digest=(token:string)=>createHash('sha256').update(token).digest();

/** Pages the extension may submit. Mirrors the routes accepted by parseCapturedPage. */
const capturable:Record<SourceName,RegExp[]>={
 rym:[/^\/charts\/(top|popular|esoteric)\/album\//,/^\/release\/(?:album|ep|comp|single|mixtape|unauth|video|djmix|additional)\/[^/]+\/[^/]+\/?$/],
 aoty:[/^\/ratings\/user-highest-rated\//,/^\/album\/\d+[^/]*\.php$/],
 pitchfork:[/^\/reviews\/(?:best\/)?albums\/?$/,/^\/reviews\/albums\/[^/]+\/?$/]
};
export function capturableSource(value:string):SourceName|null{
 let url:URL;try{url=new URL(value);}catch{return null;}
 if(url.username||url.password)return null;
 for(const [source,patterns] of Object.entries(capturable) as [SourceName,RegExp[]][]){
  if(url.origin===origins[source]&&patterns.some(p=>p.test(url.pathname)))return source;
 }
 return null;
}
export const resolveTarget=(template:string,now=new Date())=>template.replaceAll('{year}',String(now.getFullYear()));

export function selectDetailBackfillTargets(
 albums: Album[],
 batchSize: number,
 isRecent: (url: string) => boolean
): { targets: string[]; pendingCount: number } {
 const cappedBatch = Math.max(1, Math.min(6, batchSize));
 const active = albums.filter((a) => !a.excluded);
 const priorityRank = (a: Album): number => {
  if (a.decision?.status === 'selected' && !a.admittedMonth) return 0;
  if (a.decision?.status === 'selected') return 1;
  if (a.decision?.status === 'pending' && (a.decision.qualifyingSources?.length ?? 0) >= 1) return 2;
  return 99;
 };
 const prioritized = active
  .filter((a) => priorityRank(a) < 99)
  .sort((a, b) => {
   const rankDiff = priorityRank(a) - priorityRank(b);
   if (rankDiff !== 0) return rankDiff;
   const missingEvidenceDiff = Number(hasAlbumReviewEvidence(a)) - Number(hasAlbumReviewEvidence(b));
   if (missingEvidenceDiff !== 0) return missingEvidenceDiff;
   return a.id.localeCompare(b.id);
  });

 const selectedPending = new Set<string>();
 const albumCandidates: { album: Album; urls: string[] }[] = [];

 for (const album of prioritized) {
  const isSelected = album.decision?.status === 'selected';
  const sortedSources = [...album.sources].sort(
   (a, b) => SOURCE_BACKFILL_PRIORITY[a.source] - SOURCE_BACKFILL_PRIORITY[b.source]
  );
  const urls: string[] = [];
  for (const obs of sortedSources) {
   if (obs.detailCaptured) continue;
   if (!isCanonicalSourceDetailUrl(obs.source, obs.url)) continue;
   if (isSelected) selectedPending.add(obs.url);
   urls.push(obs.url);
  }
  if (urls.length) albumCandidates.push({ album, urls });
 }

 const targets: string[] = [];
 const seenTargets = new Set<string>();
 const canSchedule = (url: string) => !seenTargets.has(url) && !isRecent(url);

 // Pass 1: Cover as many zero-evidence albums as possible (1 primary source per album first).
 for (const { album, urls } of albumCandidates) {
  if (targets.length >= cappedBatch) break;
  if (hasAlbumReviewEvidence(album)) continue;
  const primary = urls.find(canSchedule);
  if (primary) {
   seenTargets.add(primary);
   targets.push(primary);
  }
 }

 // Pass 2: Fill remaining batch capacity with secondary sources and already-evidenced albums.
 for (const { urls } of albumCandidates) {
  if (targets.length >= cappedBatch) break;
  for (const url of urls) {
   if (targets.length >= cappedBatch) break;
   if (!canSchedule(url)) continue;
   seenTargets.add(url);
   targets.push(url);
  }
 }

 return { targets, pendingCount: selectedPending.size };
}

/** Pairing token and scheduled-refresh configuration for the user's own browser extension. */
export class ExtensionService {
 private readonly recent=new Map<string,number>();
 constructor(private readonly store:Store){}
 paired():boolean{return this.store.getValue(TOKEN_KEY)!==null;}
 issueToken():string{
  const token=`lb_${randomBytes(32).toString('base64url')}`;
  this.store.setValue(TOKEN_KEY,digest(token).toString('hex'));
  this.store.setValue(STATE_KEY,JSON.stringify({reports:[]} satisfies Partial<ExtensionState>));
  return token;
 }
 revoke():void{this.store.deleteValue(TOKEN_KEY);this.store.deleteValue(STATE_KEY);}
 authenticate(header?:string):boolean{
  const stored=this.store.getValue(TOKEN_KEY);
  if(!stored||!header)return false;
  const match=/^Bearer ((?:lb|ar)_[A-Za-z0-9_-]{20,100})$/.exec(header);
  if(!match)return false;
  const expected=Buffer.from(stored,'hex'),supplied=digest(match[1]!);
  return expected.length===supplied.length&&timingSafeEqual(expected,supplied);
 }
 refresh():ExtensionRefresh{
  const raw=this.store.getValue(REFRESH_KEY);
  if(!raw)return structuredClone(DEFAULT_REFRESH);
  try{
   const saved=JSON.parse(raw) as Partial<ExtensionRefresh>;
   return {
    enabled:saved.enabled??true,
    hour:saved.hour??10,
    targets:saved.targets??structuredClone(DEFAULT_REFRESH.targets),
    ...(saved.detailBackfill!==undefined?{detailBackfill:saved.detailBackfill}:{}),
    ...(saved.detailBatchSize!==undefined?{detailBatchSize:saved.detailBatchSize}:{})
   };
  }catch{return structuredClone(DEFAULT_REFRESH);}
 }
 saveRefresh(value:ExtensionRefresh):void{this.store.setValue(REFRESH_KEY,JSON.stringify(value));}
 state(albums?:Album[]):ExtensionState{
  let saved:Partial<ExtensionState>={};
  try{saved=JSON.parse(this.store.getValue(STATE_KEY)??'{}') as Partial<ExtensionState>;}catch{}
  const refresh=this.refresh();
  const base:ExtensionState={paired:this.paired(),lastSeen:saved.lastSeen,version:saved.version,reports:saved.reports??[],refresh};
  if(albums){
   base.pendingDetailCount=selectDetailBackfillTargets(albums,refresh.detailBatchSize??4,u=>this.recentlyCaptured(u)).pendingCount;
  }
  return base;
 }
 private update(change:(state:ExtensionState)=>void):void{
  const state=this.state();change(state);
  this.store.setValue(STATE_KEY,JSON.stringify({lastSeen:state.lastSeen,version:state.version,reports:state.reports}));
 }
 seen(version?:string):void{this.update(s=>{s.lastSeen=new Date().toISOString();if(version&&/^[\w.-]{1,20}$/.test(version))s.version=version;});}
 report(report:ExtensionReport):void{
  this.update(s=>{s.lastSeen=report.at;s.reports=[report,...s.reports.filter(r=>r.source!==report.source)].slice(0,3);});
 }
 /** Resolved targets handed to the extension; the server is the single source of truth. */
 config(albums?:Album[]){
  const refresh=this.refresh();
  const resolved={
   refresh:{
    enabled:refresh.enabled,
    hour:refresh.hour,
    targets:refresh.targets.map(t=>resolveTarget(t)).filter(t=>capturableSource(t)!==null)
   }
  } as {
   refresh:{enabled:boolean;hour:number;targets:string[]};
   detailBackfill?:{enabled:boolean;batchSize:number;targets:string[];pendingCount:number};
  };
  if(refresh.detailBackfill===true){
   const batchSize=Math.max(1,Math.min(6,refresh.detailBatchSize??4));
   const selected=selectDetailBackfillTargets(albums??[],batchSize,u=>this.recentlyCaptured(u));
   resolved.detailBackfill={enabled:true,batchSize,targets:selected.targets,pendingCount:selected.pendingCount};
  }
  return resolved;
 }
 recentlyCaptured(url:string,now=Date.now()):boolean{
  for(const [key,at] of this.recent)if(now-at>=RECAPTURE_INTERVAL_MS)this.recent.delete(key);
  return this.recent.has(url);
 }
 markCaptured(url:string,now=Date.now()):void{
  if(this.recent.size>=500)this.recent.delete(this.recent.keys().next().value!);
  this.recent.set(url,now);
 }
}
