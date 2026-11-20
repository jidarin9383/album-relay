import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { Album, Settings, SourceName, SourceStatus } from '../../shared/types.js';
import { normalizeIdentity, origins, isChallenge, parseAoty, parseRym, parsePitchfork, parseIndex } from './parsers.js';
import { SCRAPE_TTL_MS, isObservationFresh } from '../policy.js';
const names:SourceName[]=['aoty','rym','pitchfork'];
/** RYM, AOTY and Pitchfork are captured by the paired browser extension; the server does not crawl source sites. */
export const SERVER_FETCH_SOURCES:SourceName[]=[];
export const EXTENSION_ONLY_MESSAGE='由浏览器扩展收录：在你的 Chrome 中打开榜单或专辑页即可，服务端不直接访问该站点。';
const parsers={aoty:parseAoty,rym:parseRym,pitchfork:parsePitchfork};
const MAX_DETAILS=24, MAX_LOOKUPS=40, PAGES=3, TTL=SCRAPE_TTL_MS;
class Blocked extends Error{}
interface CacheEntry { at:number; album:Album }
/** Bounded public-source acquisition. No account credentials or full articles are stored. */
export class SourceService {
 private blocked=new Set<SourceName>();private last=new Map<SourceName,number>();private cache:Record<string,CacheEntry>={};private loaded=false;
 private readonly serverFetch:SourceName[];
 constructor(private readonly dataDir:string,options:{serverFetch?:SourceName[]}={}){this.serverFetch=options.serverFetch??SERVER_FETCH_SOURCES;}
 private async load():Promise<void>{if(this.loaded)return;this.loaded=true;try{this.cache=JSON.parse(await readFile(join(this.dataDir,'source-cache-v2.json'),'utf8')) as Record<string,CacheEntry>;}catch{this.cache={};}}
 private async save():Promise<void>{await mkdir(this.dataDir,{recursive:true,mode:0o700});const path=join(this.dataDir,'source-cache-v2.json');await writeFile(path,JSON.stringify(this.cache),{mode:0o600});await chmod(path,0o600);}
 private async html(source:SourceName,url:string,settings:Settings):Promise<string>{
  if(new URL(url).origin!==origins[source])throw new Error('Refusing a source URL outside its canonical origin');
  if(this.blocked.has(source))throw new Blocked(`${source}: blocked; complete verification before retrying`);
  const wait=Math.max(1200,settings.requestDelayMs)-(Date.now()-(this.last.get(source)??0));if(wait>0)await new Promise(r=>setTimeout(r,wait));this.last.set(source,Date.now());
  const response=await fetch(url,{headers:{'User-Agent':'ListenBetter/0.1 (+self-hosted personal album curation)','Accept':'text/html'},signal:AbortSignal.timeout(25000),redirect:'follow'});
  const status=response.status,html=await response.text();
  if(isChallenge(html,status)){this.blocked.add(source);throw new Blocked(`${source}: HTTP ${status} or verification challenge; site chain stopped`);}
  if(status>=400)throw new Error(`${source}: HTTP ${status}`);
  return html;
 }
 private async detail(source:SourceName,url:string,settings:Settings):Promise<Album|null>{const cached=this.cache[url];if(cached&&Date.now()-cached.at<TTL)return structuredClone(cached.album);const result=parsers[source](await this.html(source,url,settings),url);if(result)this.cache[url]={at:Date.now(),album:result};return result;}
 private indexUrl(source:SourceName,year:number,page:number):string {if(source==='aoty')return `${origins.aoty}/ratings/user-highest-rated/lp/${year}/?p=${page}`;if(source==='rym')return `${origins.rym}/charts/top/album/${year}/${page}/`;return `${origins.pitchfork}/reviews/albums/?page=${page}`;}
 private querySearchUrl(source:SourceName,query:string):string{const q=encodeURIComponent(query);return source==='aoty'?`${origins.aoty}/search/?q=${q}`:source==='rym'?`${origins.rym}/search?searchterm=${q}&searchtype=l`:`${origins.pitchfork}/search/?q=${q}`;}
 private searchUrl(source:SourceName,album:Album):string{return this.querySearchUrl(source,`${album.artist} ${album.title}`);}
 private merge(map:Map<string,Album>,fresh:Album):void{
  const key=normalizeIdentity(fresh.artist)+'|'+normalizeIdentity(fresh.title);const old=map.get(key);
  if(!old){map.set(key,fresh);return;}
  const conflict=old.releaseDate&&fresh.releaseDate&&old.releaseDate!==fresh.releaseDate;
  const formatConflict=old.format!=='Unknown'&&fresh.format!=='Unknown'&&old.format!==fresh.format;
  if(conflict||formatConflict){fresh.sources[0]!.notes=[fresh.sources[0]!.notes,'Release date or format conflicts with another source; manual review required.'].filter(Boolean).join(' ');old.format='Unknown';old.releaseDate='';old.rationale='Source release date or format conflict; verify metadata before admission.';}
  else if(!old.rationale?.includes('Source release date or format conflict')){old.releaseDate||=fresh.releaseDate;if(old.format==='Unknown')old.format=fresh.format;}
  old.coverUrl||=fresh.coverUrl;old.genres=[...new Set([...old.genres,...fresh.genres])];old.sources=old.sources.filter(o=>o.source!==fresh.sources[0]!.source).concat(fresh.sources);
 }
 async refresh(settings:Settings,existing:Album[],progress:(message:string)=>void,onStatus?:(status:SourceStatus)=>void):Promise<{albums:Album[];statuses:SourceStatus[]}>{
  await this.load();this.blocked.clear();const map=new Map<string,Album>();for(const a of existing){const copy=structuredClone(a);for(const o of copy.sources){if(settings.sources[o.source]&&o.status==='ok'&&!isObservationFresh(o)){o.status='error';o.notes=[o.notes,o.collectionMethod==='browser-capture'?'浏览器收录记录已超过 7 天有效期，保留历史证据但需重新收录或核验。':'Observation is older than the 6h refresh window; retained as historical evidence until reverified.'].filter(Boolean).join(' ');}}map.set(normalizeIdentity(a.artist)+'|'+normalizeIdentity(a.title),copy);}
  const statuses:SourceStatus[]=[];const active=names.filter(s=>settings.sources[s]&&this.serverFetch.includes(s));const cutoff=new Date(Date.now()-settings.lookbackDays*86400000).toISOString().slice(0,10);const nowYear=new Date().getUTCFullYear();const years=[...new Set([nowYear,Number(cutoff.slice(0,4))])];
  for(const source of active){progress(`Discovering ${source}: bounded recent chart/index pages`);let details=0,errors=0;let message='';try{const urls=new Set<string>();for(const year of source==='pitchfork'?[nowYear]:years){for(let page=1;page<=PAGES;page++){const links=parseIndex(await this.html(source,this.indexUrl(source,year,page),settings),source);for(const u of links)urls.add(u);if(!links.length)break;}}
    const detailUrls=[...urls].slice(0,MAX_DETAILS);for(const [index,url] of detailUrls.entries()){progress(`Reading ${source} album ${index+1}/${detailUrls.length}`);try{const a=await this.detail(source,url,settings);if(a){details++;if(!a.releaseDate||a.releaseDate>=cutoff)this.merge(map,a);}else errors++;}catch(e){if(e instanceof Blocked)throw e;errors++;}}
    message=details?`${details} album detail records parsed${errors?`; ${errors} unavailable or unrecognized`:''}`:'No recognized album details; source layout or access needs review.';
   }catch(e){message=e instanceof Error?e.message:'Source request failed';errors++;}
   statuses.push({source,status:this.blocked.has(source)?'blocked':details&&!errors?'ok':'error',checkedAt:new Date().toISOString(),message,coverage:`Sample only: at most ${PAGES} pages per relevant year, ${MAX_DETAILS} detail records; not exhaustive. Metadata cache TTL 6h retains original observation dates.`});onStatus?.(statuses[statuses.length-1]!);
  }
  // Search every candidate missing this source, including imported/pending albums and candidates discovered elsewhere.
  for(const source of active){if(this.blocked.has(source))continue;const status=statuses.find(s=>s.source===source)!;const candidates=[...map.values()].filter(a=>(!a.releaseDate||a.releaseDate>=cutoff)&&!a.sources.some(o=>o.source===source&&o.status==='ok'&&isObservationFresh(o)));let checked=0,matched=0;progress(`Cross-checking ${source}: up to ${MAX_LOOKUPS} exact artist/title lookups`);
   for(const candidate of candidates.slice(0,MAX_LOOKUPS)){checked++;progress(`Cross-checking ${source} candidate ${checked}/${Math.min(candidates.length,MAX_LOOKUPS)}`);try{const known=candidate.sources.find(o=>o.source===source&&o.url&&!new URL(o.url).pathname.startsWith('/search'))?.url;const urls=known?[known]:parseIndex(await this.html(source,this.searchUrl(source,candidate),settings),source).slice(0,4);let found=false;for(const url of urls){const a=await this.detail(source,url,settings);if(!a){status.status='error';status.message+='; an album detail could not be parsed';}if(a&&normalizeIdentity(a.artist)===normalizeIdentity(candidate.artist)&&normalizeIdentity(a.title)===normalizeIdentity(candidate.title)){this.merge(map,a);matched++;found=true;break;}}
     if(!found&&!candidate.sources.some(o=>o.source===source&&o.status==='ok')){candidate.sources=candidate.sources.filter(o=>o.source!==source);candidate.sources.push({source,score:null,scale:source==='aoty'?100:source==='rym'?5:10,votes:null,url:this.searchUrl(source,candidate),observedAt:new Date().toISOString(),status:'missing',notes:'No exact artist/title match within bounded public search results. Missing does not mean a low score.'});}
    }catch(e){if(e instanceof Blocked){status.status='blocked';status.message=e.message;break;}status.status='error';status.message+='; a cross-check request failed';}}
   status.coverage+=` Cross-checks: ${checked}/${candidates.length} candidates, ${matched} exact matches; maximum ${MAX_LOOKUPS} searches and 4 detail results per search.`;onStatus?.(status);
  }
  for(const source of this.blocked){for(const a of map.values()){const obs=a.sources.find(o=>o.source===source);if(obs&&!(obs.collectionMethod==='browser-capture'&&obs.status==='ok'&&isObservationFresh(obs))){obs.status='blocked';obs.notes=[obs.notes,'Refresh blocked; score and observation date retained from previous evidence.'].filter(Boolean).join(' ');}}}
  for(const source of names.filter(s=>settings.sources[s]&&!this.serverFetch.includes(s)))statuses.push({source,status:'unknown',checkedAt:new Date().toISOString(),message:EXTENSION_ONLY_MESSAGE});
  for(const source of names.filter(s=>!settings.sources[s]))statuses.push({source,status:'unknown',message:'Disabled in settings.'});await this.save();return {albums:[...map.values()],statuses};
 }
 async check(source:SourceName,settings:Settings):Promise<SourceStatus>{if(!this.serverFetch.includes(source))return {source,status:'unknown',checkedAt:new Date().toISOString(),message:EXTENSION_ONLY_MESSAGE};this.blocked.delete(source);try{const html=await this.html(source,this.indexUrl(source,new Date().getUTCFullYear(),1),settings);const count=parseIndex(html,source).length;return {source,status:count?'ok':'error',checkedAt:new Date().toISOString(),message:count?`Public index accessible; ${count} links recognized. Not a full refresh.`:'Page accessible but expected source layout not recognized.'};}catch(e){return {source,status:e instanceof Blocked?'blocked':'error',checkedAt:new Date().toISOString(),message:e instanceof Error?e.message:'Source unavailable'};}}
 async close():Promise<void>{}
}
