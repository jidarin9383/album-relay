import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExtensionRefresh, ExtensionReport, ExtensionState, SourceName } from '../shared/types.js';
import type { Store } from './store.js';
import { origins } from './sources/parsers.js';

const TOKEN_KEY='extension-token';
const REFRESH_KEY='extension-refresh';
const STATE_KEY='extension-state';
export const EXTENSION_PREFIX='/api/ext/';
export const MAX_REFRESH_TARGETS=6;
/** Same page should not be re-imported more often than this when the user simply revisits it. */
export const RECAPTURE_INTERVAL_MS=30*60*1000;

export const DEFAULT_REFRESH:ExtensionRefresh={
 enabled:false,
 hour:10,
 targets:[
  `${origins.rym}/charts/top/album/{year}/1/`,
  `${origins.aoty}/ratings/user-highest-rated/lp/{year}/`,
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

/** Pairing token and scheduled-refresh configuration for the user's own browser extension. */
export class ExtensionService {
 private readonly recent=new Map<string,number>();
 constructor(private readonly store:Store){}
 paired():boolean{return this.store.getValue(TOKEN_KEY)!==null;}
 issueToken():string{
  const token=`ar_${randomBytes(32).toString('base64url')}`;
  this.store.setValue(TOKEN_KEY,digest(token).toString('hex'));
  this.store.setValue(STATE_KEY,JSON.stringify({reports:[]} satisfies Partial<ExtensionState>));
  return token;
 }
 revoke():void{this.store.deleteValue(TOKEN_KEY);this.store.deleteValue(STATE_KEY);}
 authenticate(header?:string):boolean{
  const stored=this.store.getValue(TOKEN_KEY);
  if(!stored||!header)return false;
  const match=/^Bearer (ar_[A-Za-z0-9_-]{20,100})$/.exec(header);
  if(!match)return false;
  const expected=Buffer.from(stored,'hex'),supplied=digest(match[1]!);
  return expected.length===supplied.length&&timingSafeEqual(expected,supplied);
 }
 refresh():ExtensionRefresh{
  const raw=this.store.getValue(REFRESH_KEY);
  if(!raw)return structuredClone(DEFAULT_REFRESH);
  try{return {...structuredClone(DEFAULT_REFRESH),...JSON.parse(raw) as ExtensionRefresh};}catch{return structuredClone(DEFAULT_REFRESH);}
 }
 saveRefresh(value:ExtensionRefresh):void{this.store.setValue(REFRESH_KEY,JSON.stringify(value));}
 state():ExtensionState{
  let saved:Partial<ExtensionState>={};
  try{saved=JSON.parse(this.store.getValue(STATE_KEY)??'{}') as Partial<ExtensionState>;}catch{}
  return {paired:this.paired(),lastSeen:saved.lastSeen,version:saved.version,reports:saved.reports??[],refresh:this.refresh()};
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
 config(){
  const refresh=this.refresh();
  return {refresh:{enabled:refresh.enabled,hour:refresh.hour,targets:refresh.targets.map(t=>resolveTarget(t)).filter(t=>capturableSource(t)!==null)}};
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
