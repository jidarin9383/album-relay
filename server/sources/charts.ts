import { load } from 'cheerio';
import type { Album, ChartCapture } from '../../shared/types.js';
import { albumId } from '../policy.js';
import { origins, parseReleaseDate, parseVotes, isChallenge } from './parsers.js';

export class CaptureError extends Error {}
function canonical(value:string, origin:string, pattern:RegExp, keepPage=false):string {
 const url=new URL(value,origin);
 if(url.origin!==origin||url.username||url.password||!pattern.test(url.pathname))throw new CaptureError('页面或专辑链接不属于受支持的来源');
 const page=url.searchParams.get('p');url.search='';url.hash='';
 if(keepPage&&page&&/^[1-9]\d{0,3}$/.test(page))url.searchParams.set('p',page);
 return url.href;
}
const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
/** Parse only the current public chart document, never fetch linked pages. */
export function parseChart(source:'rym'|'aoty',html:string,pageUrl:string):ChartCapture {
 const origin=origins[source];
 const page=canonical(pageUrl,origin,source==='rym'?/^\/charts\/(top|popular|esoteric)\/album\//:/^\/ratings\/user-highest-rated\//,source==='aoty');
 const $=load(html);$('script,style,noscript').remove();
 if(isChallenge($.root().text(),200))throw new CaptureError('当前页面仍需要验证，请在独立浏览器中完成后再收录');
 const localeText=(node:ReturnType<typeof $>)=>clean(node.find('.ui_name_locale_original').first().text()||node.find('.ui_name_locale').first().text()||node.text());
 const observedAt=new Date().toISOString(),warnings:string[]=[],records=new Map<string,Album>();
 const rows=$(source==='rym'?'.page_charts_section_charts_item.object_release':'.albumListRow').toArray();
 if(rows.length>60)warnings.push('本次只收录当前页面的前 60 个条目');
 for(const el of rows.slice(0,60)){
  const row=$(el);
  try{
   let artist='',title='',href='',released='',scoreText='',votesDisplay='',format:Album['format']='Unknown';
   if(source==='rym'){
    const link=row.find('.page_charts_section_charts_item_title a, .page_charts_section_charts_item_link').first();
    title=localeText(link);
    const primary=row.find('.page_charts_section_charts_item_credited_links_primary a.artist');
    const artistNodes=primary.length?primary:row.find('.page_charts_section_charts_item_credited_text a.artist');
    artist=artistNodes.toArray().map(n=>localeText($(n))).filter(Boolean).join(' / ');
    href=link.attr('href')??'';released=clean(row.find('.page_charts_section_charts_item_title_date_compact span').first().text());
    scoreText=row.find('.page_charts_section_charts_item_details_average_num').first().text().trim();
    votesDisplay=clean(row.find('.page_charts_section_charts_item_details_ratings').first().text()).replace(/^\/\s*/,'');
    format='LP';
   }else{
    const link=row.find('.albumListTitle a').first();const identity=clean(link.text());
    const parts=identity.split(' - ');if(parts.length!==2)throw new Error('歌手与专辑名称存在歧义');
    [artist,title]=parts as [string,string];href=link.attr('href')??'';
    released=clean(row.find('.albumListDate').text());
    const user=row.find('.albumListScoreContainer').filter((_,n)=>clean($(n).find('.scoreHeader').text()).toUpperCase()==='USER SCORE').first();
    scoreText=user.find('.scoreValue').text().trim();votesDisplay=clean(user.find('.scoreText').text()).replace(/\s+ratings?$/i,'');
    format=new URL(page).pathname.includes('/lp/')?'LP':'Unknown';
   }
   if(!href||!artist||!title||artist.length>500||title.length>500||!scoreText)throw new Error('缺少专辑身份或用户评分');
   const score=Number(scoreText),scale=source==='rym'?5:100;
   if(!Number.isFinite(score)||score<0||score>scale)throw new Error('评分范围无效');
   const url=canonical(href,origin,source==='rym'?/^\/release\/album\/[^/]+\/[^/]+\/?$/:/^\/album\/\d+[^/]*\.php$/);
   const votes=parseVotes(votesDisplay),votesApproximate=/\d\s*[km]\b/i.test(votesDisplay);
   records.set(url,{id:albumId(artist,title),artist,title,releaseDate:parseReleaseDate(released),format,genres:[],excluded:false,sources:[{source,url,score,scale,votes,votesDisplay,votesApproximate,observedAt,status:'ok',collectionMethod:'browser-capture',sourcePageUrl:page}]});
  }catch{warnings.push('一个条目无法可靠识别，已跳过；可打开专辑页核对身份与格式');}
 }
 if(!records.size)throw new CaptureError('未找到可收录的用户评分榜单。请打开 RYM 专辑榜或 AOTY 用户评分榜后重试');
 return {source,pageUrl:page,observedAt,albums:[...records.values()],warnings};
}
