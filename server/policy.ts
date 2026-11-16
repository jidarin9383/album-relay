import { createHash } from 'node:crypto';
import type { Album, Decision, Observation, Settings, SourceName } from '../shared/types.js';
export const SCRAPE_TTL_MS=6*3600000;
export const CAPTURE_TTL_MS=7*86400000;
export function isObservationFresh(o:Observation,now=Date.now()):boolean {
 const at=Date.parse(o.observedAt);
 if(!Number.isFinite(at))return false;
 return now-at<(o.collectionMethod==='browser-capture'?CAPTURE_TTL_MS:SCRAPE_TTL_MS);
}
export const defaultSettings: Settings = { allowApproximateVotes:false, lookbackDays:90, minimumAgeDays:7, minSources:2, thresholds:{aoty:{score:80,votes:100,negative:70},rym:{score:3.5,votes:100,negative:3},pitchfork:{score:8,negative:7,allowBnm:true}},sources:{aoty:true,rym:true,pitchfork:true},schedule:{enabled:false,weekday:3,hour:12,minute:0,timezone:'Asia/Taipei'},playlist:{namePattern:'高分新专辑｜YYYY-MM',descriptionMaxChars:1000},requestDelayMs:6000};
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
export function decide(album:Album,settings:Settings,today:string):Decision {
 const result=(status:Decision['status'],reasons:string[],qualifyingSources:SourceName[]=[]):Decision=>({status,reasons,qualifyingSources});
 if(album.excluded)return result('excluded',['手动排除']);
 if(album.format==='EP'||album.format==='Reissue')return result('format_conflict',[album.format==='EP'?'EP 短专辑不计入全长专辑筛选':'重制或再版专辑不计入新专筛选']);
 const date=Date.parse(`${album.releaseDate}T00:00:00Z`), now=Date.parse(`${today}T00:00:00Z`);
 const hasDate=Boolean(album.releaseDate)&&Number.isFinite(date)&&Number.isFinite(now);
 if(hasDate){
  const age=(now-date)/86400000;
  if(age<settings.minimumAgeDays)return result('too_new',['等待发行满指定天数']);
  if(age>settings.lookbackDays)return result('out_of_window',['超出发行时间范围']);
 }
 const passing=new Set<SourceName>(),negative=new Set<SourceName>();
 for(const s of album.sources){if(s.status!=='ok'||s.score===null||!settings.sources[s.source])continue;
  if(s.source==='pitchfork'){const t=settings.thresholds.pitchfork;if(s.score>=t.score||(t.allowBnm&&s.bestNewMusic))passing.add(s.source);if(s.score<t.negative)negative.add(s.source)}
  else {const t=settings.thresholds[s.source];const v=effectiveVotes(s,settings.allowApproximateVotes);if(t.votes===0||v>=t.votes){if(s.score>=t.score)passing.add(s.source);if(s.score<t.negative)negative.add(s.source)}}
 }
 const qualified=[...passing];if(negative.size)return result('disagreement',[`存在明显分歧：${[...negative].join('、')}`],qualified);
 if(passing.size<settings.minSources){
  if(!hasDate&&album.format==='Unknown')return result('pending',['单站乐评待印证（收录 RYM 或 AOTY 后自动补全发行日期与 LP 格式）'],qualified);
  return result('pending',['等待更多站点评分或评分人数'],qualified);
 }
 if(!hasDate)return result('pending',['发行日期待确认'],qualified);
 if(album.format!=='LP')return result('format_conflict',['已达评分条件，但专辑格式尚未确认为 LP'],qualified);
 return result('selected',['跨站评分达到入选条件'],qualified);
}
