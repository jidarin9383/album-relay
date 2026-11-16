import { load } from 'cheerio';
import type { Album, ChartCapture, SourceName } from '../../shared/types.js';
import { albumId } from '../policy.js';
import { origins, parseReleaseDate, parseVotes, isChallenge, parseAoty, parseRym, parsePitchfork, parsePitchforkIndex, cleanImageUrl } from './parsers.js';

export class CaptureError extends Error {}
function canonical(value:string, origin:string, pattern:RegExp, pageParam?:string):string {
 const url=new URL(value,origin);
 if(url.origin!==origin||url.username||url.password||!pattern.test(url.pathname))throw new CaptureError('页面或专辑链接不属于受支持的来源');
 const page=pageParam?url.searchParams.get(pageParam):null;
 url.search='';url.hash='';
 if(pageParam&&page&&/^[1-9]\d{0,3}$/.test(page))url.searchParams.set(pageParam,page);
 return url.href;
}
const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
/** Parse only the current public chart document, never fetch linked pages. */
export function parseChart(source:'rym'|'aoty',html:string,pageUrl:string):ChartCapture {
 const origin=origins[source];
 const page=canonical(pageUrl,origin,source==='rym'?/^\/charts\/(top|popular|esoteric)\/album\//:/^\/ratings\/user-highest-rated\//,source==='aoty'?'p':undefined);
 const $=load(html);$('script,style,noscript').remove();
 if(isChallenge($.root().text(),200))throw new CaptureError('当前页面仍需要验证，请在独立浏览器中完成后再收录');
 const localeText=(node:ReturnType<typeof $>)=>clean(node.find('.ui_name_locale_original').first().text()||node.find('.ui_name_locale').first().text()||node.text());
 const observedAt=new Date().toISOString(),warnings:string[]=[],records=new Map<string,Album>();
 const rows=$(source==='rym'?'.page_charts_section_charts_item.object_release':'.albumListRow').toArray();
 if(rows.length>60)warnings.push('本次只收录当前页面的前 60 个条目');
 for(const el of rows.slice(0,60)){
  const row=$(el);
  try{
   let artist='',title='',href='',released='',scoreText='',votesDisplay='',format:Album['format']='Unknown',coverUrl:string|undefined;
   if(source==='rym'){
    const link=row.find('.page_charts_section_charts_item_title a, .page_charts_section_charts_item_link').first();
    title=localeText(link);
    const primary=row.find('.page_charts_section_charts_item_credited_links_primary a.artist');
    const artistNodes=primary.length?primary:row.find('.page_charts_section_charts_item_credited_text a.artist');
    artist=artistNodes.toArray().map(n=>localeText($(n))).filter(Boolean).join(' / ');
    href=link.attr('href')??'';released=clean(row.find('.page_charts_section_charts_item_title_date_compact span').first().text());
    scoreText=row.find('.page_charts_section_charts_item_details_average_num').first().text().trim();
    votesDisplay=clean(row.find('.page_charts_section_charts_item_details_ratings').first().text()).replace(/^\/\s*/,'');
    const coverEl=row.find('.page_charts_section_charts_item_image img, img').first();
    coverUrl=cleanImageUrl(coverEl.attr('data-src')||coverEl.attr('data-srcset')||coverEl.attr('src'));
    format='LP';
   }else{
    const link=row.find('.albumListTitle a').first();const identity=clean(link.text());
    const parts=identity.split(' - ');if(parts.length!==2)throw new Error('歌手与专辑名称存在歧义');
    [artist,title]=parts as [string,string];href=link.attr('href')??'';
    released=clean(row.find('.albumListDate').text());
    const user=row.find('.albumListScoreContainer').filter((_,n)=>clean($(n).find('.scoreHeader').text()).toUpperCase()==='USER SCORE').first();
    scoreText=user.find('.scoreValue').text().trim();votesDisplay=clean(user.find('.scoreText').text()).replace(/\s+ratings?$/i,'');
    const coverEl=row.find('.albumListCover img, img').first();
    coverUrl=cleanImageUrl(coverEl.attr('data-src')||coverEl.attr('src')||coverEl.attr('srcset'));
    format=new URL(page).pathname.includes('/lp/')?'LP':'Unknown';
   }
   if(!href||!artist||!title||artist.length>500||title.length>500||!scoreText)throw new Error('缺少专辑身份或用户评分');
   const score=Number(scoreText),scale=source==='rym'?5:100;
   if(!Number.isFinite(score)||score<0||score>scale)throw new Error('评分范围无效');
   const url=canonical(href,origin,source==='rym'?/^\/release\/album\/[^/]+\/[^/]+\/?$/:/^\/album\/\d+[^/]*\.php$/);
   const votes=parseVotes(votesDisplay),votesApproximate=/\d\s*[km]\b/i.test(votesDisplay);
   records.set(url,{id:albumId(artist,title),artist,title,releaseDate:parseReleaseDate(released),format,...(coverUrl?{coverUrl}:{}),genres:[],excluded:false,sources:[{source,url,score,scale,votes,votesDisplay,votesApproximate,observedAt,status:'ok',collectionMethod:'browser-capture',sourcePageUrl:page}]});
  }catch{warnings.push('一个条目无法可靠识别，已跳过；可打开专辑页核对身份与格式');}
 }
 if(!records.size)throw new CaptureError('未找到可收录的用户评分榜单。请打开 RYM 专辑榜或 AOTY 用户评分榜后重试');
 return {source,pageUrl:page,observedAt,albums:[...records.values()],warnings};
}

/** Parse either a supported public chart page or a single release/review detail page. */
export function parseCapturedPage(source:SourceName,html:string,pageUrl:string):ChartCapture {
 const origin=origins[source];
 let url:URL;
 try{url=new URL(pageUrl,origin);}catch{throw new CaptureError('页面或专辑链接不属于受支持的来源');}
 if(url.origin!==origin||url.username||url.password)throw new CaptureError('页面或专辑链接不属于受支持的来源');
 if(/^\/search\b/.test(url.pathname))throw new CaptureError('当前仍在搜索结果列表，请先点开目标专辑详情页后再收录');
 if(source==='rym'){
  if(/^\/charts\/(top|popular|esoteric)\/album\//.test(url.pathname))return parseChart('rym',html,pageUrl);
  const canonicalUrl=canonical(pageUrl,origin,/^\/release\/(?:album|ep|comp|single|mixtape|unauth|video|djmix|additional)\/[^/]+\/[^/]+\/?$/);
  const $=load(html);$('script,style,noscript').remove();
  if(isChallenge($.root().text(),200))throw new CaptureError('当前页面仍需要验证，请在独立浏览器中完成后再收录');
  const album=parseRym(html,canonicalUrl);
  if(!album||album.sources[0]?.score===null)throw new CaptureError('当前专辑页未识别到有效评分，请确认页面加载完成后重试');
  const observedAt=new Date().toISOString();
  album.sources[0]={...album.sources[0]!,observedAt,collectionMethod:'browser-capture',sourcePageUrl:canonicalUrl};
  return {source,pageUrl:canonicalUrl,observedAt,albums:[album],warnings:[]};
 }
 if(source==='aoty'){
  if(/^\/ratings\/user-highest-rated\//.test(url.pathname))return parseChart('aoty',html,pageUrl);
  const canonicalUrl=canonical(pageUrl,origin,/^\/album\/\d+[^/]*\.php$/);
  const $=load(html);$('script,style,noscript').remove();
  if(isChallenge($.root().text(),200))throw new CaptureError('当前页面仍需要验证，请在独立浏览器中完成后再收录');
  const album=parseAoty(html,canonicalUrl);
  if(!album||album.sources[0]?.score===null)throw new CaptureError('当前专辑页未识别到有效用户评分，请确认页面加载完成后重试');
  const observedAt=new Date().toISOString();
  album.sources[0]={...album.sources[0]!,observedAt,collectionMethod:'browser-capture',sourcePageUrl:canonicalUrl};
  return {source,pageUrl:canonicalUrl,observedAt,albums:[album],warnings:[]};
 }
 if(/^\/reviews\/(?:best\/)?albums\/?$/.test(url.pathname)){
  const canonicalUrl=canonical(pageUrl,origin,/^\/reviews\/(?:best\/)?albums\/?$/,'page');
  const $=load(html);$('script,style,noscript').remove();
  if(isChallenge($.root().text(),200))throw new CaptureError('当前页面仍需要验证，请在独立浏览器中完成后再收录');
  const {albums,warnings}=parsePitchforkIndex(html,canonicalUrl);
  if(!albums.length)throw new CaptureError('当前 Pitchfork 列表页未识别到有效专辑评分，请确认页面加载完成后重试');
  return {source,pageUrl:canonicalUrl,observedAt:albums[0]?.sources[0]?.observedAt??new Date().toISOString(),albums,warnings};
 }
 const canonicalUrl=canonical(pageUrl,origin,/^\/reviews\/albums\/[^/]+\/?$/);
 const $=load(html);$('script,style,noscript').remove();
 if(isChallenge($.root().text(),200))throw new CaptureError('当前页面仍需要验证，请在独立浏览器中完成后再收录');
 const album=parsePitchfork(html,canonicalUrl);
 if(!album||album.sources[0]?.score===null)throw new CaptureError('当前乐评页未识别到有效评分，请确认页面加载完成后重试');
 const observedAt=new Date().toISOString();
 album.sources[0]={...album.sources[0]!,observedAt,collectionMethod:'browser-capture',sourcePageUrl:canonicalUrl};
 return {source,pageUrl:canonicalUrl,observedAt,albums:[album],warnings:[]};
}
