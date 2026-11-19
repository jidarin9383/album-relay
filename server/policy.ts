import { createHash } from 'node:crypto';
import type { Album, Decision, Observation, Settings, SourceName } from '../shared/types.js';
export const SCRAPE_TTL_MS=6*3600000;
export const CAPTURE_TTL_MS=7*86400000;
export function isObservationFresh(o:Observation,now=Date.now()):boolean {
 const at=Date.parse(o.observedAt);
 if(!Number.isFinite(at))return false;
 return now-at<(o.collectionMethod==='browser-capture'?CAPTURE_TTL_MS:SCRAPE_TTL_MS);
}
export const defaultSettings: Settings = {
  allowApproximateVotes: true,
  allowSingleSourceAcclaim: true,
  autoSyncPlaylist: true,
  lookbackDays: 90,
  minimumAgeDays: 0,
  minSources: 2,
  thresholds: { aoty: { score: 80, votes: 100, negative: 70 }, rym: { score: 3.5, votes: 100, negative: 3 }, pitchfork: { score: 8, negative: 7, allowBnm: true } },
  sources: { aoty: true, rym: true, pitchfork: true },
  schedule: { enabled: false, weekday: 3, hour: 12, minute: 0, timezone: 'Asia/Taipei' },
  playlist: { namePattern: '高分新专辑｜YYYY-MM', descriptionMaxChars: 1000, aiCurated: true, aiDescription: true, maxAlbumsPerMonth: 12 },
  requestDelayMs: 6000
};
export function todayInTimezone(timezone:string,now=new Date()):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const part=(name:string)=>parts.find(p=>p.type===name)!.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
export function albumId(artist:string,title:string):string {const norm=(x:string)=>x.normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'');return createHash('sha256').update(`${norm(artist)}\0${norm(title)}`).digest('hex').slice(0,24)}
export function effectiveVotes(s:Observation,allowApproximate?:boolean):number {
 const m=/^\s*(\d+(?:\.\d+)?)\s*([km])\s*$/i.exec(s.votesDisplay??'');
 const unit=m?.[2]?.toLowerCase()==='m'?1_000_000:1_000;
 const point=s.votes??(m?Math.round(Number.parseFloat(m[1]!)*unit):0);
 const approx=Boolean(s.votesApproximate||m);
 if(!approx||allowApproximate)return point;
 if(m){
  const decimals=m[1]!.includes('.')?m[1]!.split('.')[1]!.length:0;
  const halfStep=(0.5*unit)/(10**decimals);
  return Math.max(0,Math.round(Number.parseFloat(m[1]!)*unit-halfStep));
 }
 return 0;
}
const SOURCE_DISPLAY_LABELS: Record<SourceName, string> = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'P4K' };

export function decide(album:Album,settings:Settings,today:string):Decision {
 const result=(status:Decision['status'],reasons:string[],qualifyingSources:SourceName[]=[],negativeSources?:SourceName[]):Decision=>({
  status,
  reasons,
  qualifyingSources,
  ...(negativeSources?.length?{negativeSources}:{})
 });
 if(album.excluded)return result('excluded',['已隐藏']);
 if(album.format==='Reissue')return result('format_conflict',['重制或再版专辑不计入新专筛选']);
 const date=Date.parse(`${album.releaseDate}T00:00:00Z`), now=Date.parse(`${today}T00:00:00Z`);
 const hasDate=Boolean(album.releaseDate)&&Number.isFinite(date)&&Number.isFinite(now);
 if(hasDate){
  const age=(now-date)/86400000;
  if(age<settings.minimumAgeDays)return result('too_new',['等待发行满指定天数']);
  if(age>settings.lookbackDays)return result('out_of_window',['超出发行时间范围']);
 }
 const passing=new Set<SourceName>(),negative=new Set<SourceName>(),strongSingle=new Set<SourceName>();
 const highLabels:string[]=[],lowLabels:string[]=[];
 const allowSingle=settings.allowSingleSourceAcclaim??true;
 for(const s of album.sources){
  if(s.status!=='ok'||s.score===null||!settings.sources[s.source])continue;
  const label=SOURCE_DISPLAY_LABELS[s.source];
  if(s.source==='pitchfork'){
   const t=settings.thresholds.pitchfork;
   if(s.score>=t.score||(t.allowBnm&&s.bestNewMusic)){
    passing.add(s.source);
    highLabels.push(`${label} ${s.score}${s.bestNewMusic?' BNM':''}（≥${t.score}）`);
   }
   if(s.score<t.negative){
    negative.add(s.source);
    lowLabels.push(`${label} ${s.score}（<${t.negative}）`);
   }
   if((t.allowBnm&&Boolean(s.bestNewMusic))||(hasDate&&s.score>=Math.max(t.score,8.3))){
    strongSingle.add(s.source);
   }
  }else{
   const t=settings.thresholds[s.source];
   const v=effectiveVotes(s,settings.allowApproximateVotes??true);
   if(t.votes===0||v>=t.votes){
    if(s.score>=t.score){
     passing.add(s.source);
     highLabels.push(`${label} ${s.score}（≥${t.score}）`);
    }
    if(s.score<t.negative){
     negative.add(s.source);
     lowLabels.push(`${label} ${s.score}（<${t.negative}）`);
    }
   }
   if(
    (hasDate||Boolean(s.collectionMethod))&&
    ((s.source==='rym'&&s.score>=Math.max(t.score,3.7)&&v>=Math.max(t.votes,300))||
     (s.source==='aoty'&&s.score>=Math.max(t.score,82)&&v>=Math.max(t.votes,250)))
   ){
    strongSingle.add(s.source);
   }
  }
 }
 const qualified=[...passing];
 const lowList=[...negative];
 if(negative.size&&passing.size){
  return result('disagreement',[`高分站：${highLabels.join('、')} vs 偏低站：${lowLabels.join('、')}`],qualified,lowList);
 }
 if(negative.size){
  return result('pending',[`仅收单站偏低评分：${lowLabels.join('、')}`],[],lowList);
 }
 if(passing.size>=settings.minSources){
  if(!hasDate&&album.sources.every(s=>s.source==='pitchfork'&&!s.bestNewMusic)){
   return result('pending',['等待确认发行时间'],qualified);
  }
  return result('selected',['跨站高分入选'],qualified);
 }
 if(allowSingle&&strongSingle.size>0){
  return result('selected',['高口碑佳作入选'],qualified.length?qualified:[...strongSingle]);
 }
 return result('pending',['未达入选门槛'],qualified);
}
