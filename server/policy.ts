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
export function decide(album:Album,settings:Settings,today:string):Decision {
 const result=(status:Decision['status'],reasons:string[],qualifyingSources:SourceName[]=[]):Decision=>({status,reasons,qualifyingSources});
 if(album.excluded)return result('excluded',['手动排除']);
 if(album.format!=='LP')return result('format_conflict',['专辑格式待确认']);
 const date=Date.parse(`${album.releaseDate}T00:00:00Z`), now=Date.parse(`${today}T00:00:00Z`);
 if(!Number.isFinite(date)||!Number.isFinite(now))return result('pending',['发行日期待确认']);
 const age=(now-date)/86400000;
 if(age<settings.minimumAgeDays)return result('too_new',['等待发行满指定天数']);
 if(age>settings.lookbackDays)return result('out_of_window',['超出发行时间范围']);
 const passing=new Set<SourceName>(),negative=new Set<SourceName>();
 for(const s of album.sources){if(s.status!=='ok'||s.score===null||!settings.sources[s.source])continue;
  const votes=s.votes??(s.votesDisplay&&/^\d+(?:\.\d+)?k$/i.test(s.votesDisplay)?Number.parseFloat(s.votesDisplay)*1000:0);
  if(s.source==='pitchfork'){const t=settings.thresholds.pitchfork;if(s.score>=t.score||(t.allowBnm&&s.bestNewMusic))passing.add(s.source);if(s.score<t.negative)negative.add(s.source)}
  else {const t=settings.thresholds[s.source];if((!(s.votesApproximate||/\d\s*[km]\b/i.test(s.votesDisplay??''))||settings.allowApproximateVotes||t.votes===0)&&votes>=t.votes){if(s.score>=t.score)passing.add(s.source);if(s.score<t.negative)negative.add(s.source)}}
 }
 const qualified=[...passing];if(negative.size)return result('disagreement',[`存在明显分歧：${[...negative].join('、')}`],qualified);
 if(passing.size>=settings.minSources)return result('selected',['跨站评分达到入选条件'],qualified);
 return result('pending',['等待更多站点评分或评分人数'],qualified);
}
