import { load } from 'cheerio';
import { sanitizeReviewSnippet } from '../../shared/review-evidence.js';
import { albumId } from '../policy.js';
import type { Album, CapturedStreamingLinks, ReviewSnippet, SourceName } from '../../shared/types.js';
export const origins: Record<SourceName,string>={aoty:'https://www.albumoftheyear.org',rym:'https://rateyourmusic.com',pitchfork:'https://pitchfork.com'};
export function normalizeIdentity(s:string):string{return s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s*&\s*|\s+\/\s+/g,' and ').replace(/[^\p{L}\p{N}]/gu,'');}
export function parseVotes(value:string):number|null{const m=value.replace(/,/g,'').match(/(\d+(?:\.\d+)?)\s*([km])?/i);return m?Math.round(Number(m[1])*(m[2]?.toLowerCase()==='k'?1000:m[2]?.toLowerCase()==='m'?1000000:1)):null;}
const CHALLENGE_RE = /just a moment|verify (?:you are|that you)|checking your browser|checking if the site connection is secure|performing security verification|complete the security check|ip address is temporarily blocked|error 1015|error 1020|too many requests|cf-chl-|captcha|access denied|rate limit exceeded|请稍候|請稍候|请验证您是真人|确认您是真人|验证您(?:是否)?是真人|正在验证您(?:是否)?是真人|請驗證您是真人|驗證您是人類|請確認您是真人|確認您是真人|正在检查您的浏览器|正在檢查您的瀏覽器|需要检查您的连接安全性|需要檢查您的連線安全性|安全验证|安全驗證/i;
export function isChallenge(html:string,status:number):boolean{return [403,429,503].includes(status)||CHALLENGE_RE.test(html.slice(0,150000));}
function date(s:string):string{if(!s||!(/\d{4}-\d{2}-\d{2}/.test(s)||/[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}/.test(s)))return ''; const v=Date.parse(/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10)+"T00:00:00Z":s+" UTC");return Number.isFinite(v)?new Date(v).toISOString().slice(0,10):'';}
export function cleanImageUrl(raw?:string|null):string|undefined{
 if(!raw)return undefined;
 const first=raw.trim().split(',')[0]?.trim().split(/\s+/)[0]??'';
 if(!first||/^data:/i.test(first))return undefined;
 const normalized=first.startsWith('//')?`https:${first}`:first;
 try{const u=new URL(normalized);return u.protocol==='https:'?u.href:undefined;}catch{return undefined;}
}
export function normalizeSpotifyAlbumUrl(raw?:string|null):string|undefined{
 if(!raw)return undefined;
 const normalized=raw.trim().startsWith('//')?`https:${raw.trim()}`:raw.trim();
 try{
  const u=new URL(normalized);
  if(u.protocol!=='https:'||u.username||u.password||u.hostname.toLowerCase()!=='open.spotify.com')return undefined;
  const m=/^(?:\/intl-[a-z-]+)?\/album\/([A-Za-z0-9]{10,40})(?:\/.*)?$/i.exec(u.pathname);
  return m?`https://open.spotify.com/album/${m[1]}`:undefined;
 }catch{return undefined;}
}
export function normalizeYoutubeMusicUrl(raw?:string|null):string|undefined{
 if(!raw)return undefined;
 const normalized=raw.trim().startsWith('//')?`https:${raw.trim()}`:raw.trim();
 try{
  const u=new URL(normalized);
  if(u.protocol!=='https:'||u.username||u.password)return undefined;
  const host=u.hostname.toLowerCase();
  if(host==='music.youtube.com'){
   if(u.pathname==='/playlist'&&u.searchParams.get('list')){
    return `https://music.youtube.com/playlist?list=${encodeURIComponent(u.searchParams.get('list')!)}`;
   }
   if(u.pathname==='/watch'&&u.searchParams.get('v')){
    return `https://music.youtube.com/watch?v=${encodeURIComponent(u.searchParams.get('v')!)}`;
   }
   if(/^\/(?:browse|channel)\/[^/]+/.test(u.pathname)){
    u.search='';u.hash='';
    return u.href;
   }
   return undefined;
  }
  if(host==='www.youtube.com'||host==='youtube.com'){
   const list=u.searchParams.get('list');
   if(u.pathname==='/playlist'&&list){
    return list.startsWith('OLAK5uy_')
     ?`https://music.youtube.com/playlist?list=${encodeURIComponent(list)}`
     :`https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
   }
   const v=u.searchParams.get('v');
   if(u.pathname==='/watch'&&v){
    return `https://music.youtube.com/watch?v=${encodeURIComponent(v)}`;
   }
  }
  return undefined;
 }catch{return undefined;}
}
export function normalizeAppleMusicUrl(raw?:string|null):string|undefined{
 if(!raw)return undefined;
 const normalized=raw.trim().startsWith('//')?`https:${raw.trim()}`:raw.trim();
 try{
  const u=new URL(normalized);
  if(u.protocol!=='https:'||u.username||u.password||u.hostname.toLowerCase()!=='music.apple.com')return undefined;
  if(!/\/album\//.test(u.pathname))return undefined;
  u.search='';u.hash='';
  return u.href;
 }catch{return undefined;}
}
export function normalizeBandcampUrl(raw?:string|null):string|undefined{
 if(!raw)return undefined;
 const normalized=raw.trim().startsWith('//')?`https:${raw.trim()}`:raw.trim();
 try{
  const u=new URL(normalized);
  if(u.protocol!=='https:'||u.username||u.password)return undefined;
  if(!/^[a-z0-9-]+\.bandcamp\.com$/i.test(u.hostname)||!/^\/album\/[^/]+/.test(u.pathname))return undefined;
  u.search='';u.hash='';
  return u.href;
 }catch{return undefined;}
}
export function extractStreamingLinks($:ReturnType<typeof load>,scope?:ReturnType<typeof $>):CapturedStreamingLinks|undefined{
 const links:CapturedStreamingLinks={};
 const nodes=(scope??$.root()).find('a[href]');
 nodes.each((_,e)=>{
  const href=$(e).attr('href');
  if(!href)return;
  if(!links.spotify){const sp=normalizeSpotifyAlbumUrl(href);if(sp)links.spotify=sp;}
  if(!links.youtubeMusic){const yt=normalizeYoutubeMusicUrl(href);if(yt)links.youtubeMusic=yt;}
  if(!links.appleMusic){const am=normalizeAppleMusicUrl(href);if(am)links.appleMusic=am;}
  if(!links.bandcamp){const bc=normalizeBandcampUrl(href);if(bc)links.bandcamp=bc;}
 });
 return Object.keys(links).length?links:undefined;
}
function cleanSnippet(value:string,max=280):string{
 const s=value.replace(/\s+/g,' ').trim();
 if(!s)return '';
 return s.length>max?`${s.slice(0,max-1).trim()}…`:s;
}
function number(s:unknown,max:number):number|null{const n=typeof s==='number'?s:typeof s==='string'&&s.trim()?Number(s):NaN;return Number.isFinite(n)&&n>=0&&n<=max?n:null;}
function album(source:SourceName,url:string,artist:string,title:string,releaseDate:string,format:Album['format'],score:number|null,votes:number|null):Album|null{if(!artist.trim()||!title.trim())return null;return {id:albumId(artist,title),artist:artist.trim(),title:title.trim(),releaseDate,format,genres:[],sources:[{source,score,scale:source==='aoty'?100:source==='rym'?5:10,votes,url,observedAt:new Date().toISOString(),status:score===null?'missing':'ok'}],excluded:false};}
function format(s:string):Album['format']{if(/reissue|re-release/i.test(s))return 'Reissue';if(/\bEP\b/.test(s))return 'EP';return /\bLP\b|^Album$/i.test(s.trim())?'LP':'Unknown';}
export function parseAoty(html:string,url:string):Album|null{
 const $=load(html);
 const rows=$('.detailRow').toArray().map(e=>$(e).text().trim());
 const release=rows.find(s=>/release date/i.test(s))?.split('/')[0]?.trim()??'';
 const fmt=rows.find(s=>/\/\s*format/i.test(s))?.split('/')[0]??'';
 const user=$('.albumUserScoreBox').first().length?$('.albumUserScoreBox').first():$('.userScoreBox').first();
 const score=$('.albumUserScore').first().text().trim()||user.find('[itemprop="ratingValue"]').text().trim();
 const votes=user.text().match(/(?:based on\s*)?([\d,.]+\s*[km]?)\s*ratings/i)?.[1]??'';
 const a=album('aoty',url,$('.artist').first().text(),$('.albumTitle').first().text(),date(release),format(fmt),number(score,100),parseVotes(votes));
 if(a){
  const obs=a.sources[0]!;
  obs.votesDisplay=votes;
  obs.votesApproximate=/\d\s*[km]\b/i.test(votes);
  obs.detailCaptured=true;
  const criticBox=$('.albumCriticScoreBox').first();
  const criticScoreText=$('.albumCriticScore').first().text().trim()||criticBox.find('[itemprop="ratingValue"]').text().trim();
  const criticScore=number(criticScoreText,100);
  if(criticScore!==null)obs.criticScore=criticScore;
  const criticVotesText=criticBox.text().match(/(?:based on\s*)?([\d,]+)\s*reviews?/i)?.[1]??'';
  const criticVotes=parseVotes(criticVotesText);
  if(criticVotes!==null)obs.criticVotes=criticVotes;

  const coverEl=$('.albumTopBox img, .albumArtwork img').first();
  const cover=cleanImageUrl(coverEl.attr('data-src')||coverEl.attr('src')||coverEl.attr('srcset'));
  if(cover)a.coverUrl=cover;
  a.genres=[...new Set($('.detailRow a[href*="/genre/"]').toArray().map(e=>$(e).text().trim()).filter(Boolean))];
  const descriptors=[...new Set($('.detailRow a[href*="/tag/"], .detailRow a[href*="/vibe/"], .detailRow a[href*="/mood/"], .tags a').toArray().map(e=>$(e).text().trim()).filter(Boolean))].slice(0,15);
  if(descriptors.length){obs.descriptors=descriptors;a.descriptors=descriptors;}

  const snippets:ReviewSnippet[]=[];
  $('#critic-reviews .albumReviewRow, .criticReviews .albumReviewRow, #criticReviews .albumReviewRow').each((_,el)=>{
   if(snippets.filter(s=>s.kind==='critic').length>=5)return;
   const row=$(el);
   const text=cleanSnippet(row.find('.albumReviewText').text());
   if(!text)return;
   const publication=cleanSnippet(row.find('.albumReviewPublication, .publication').first().text(),80);
   const author=cleanSnippet(row.find('.albumReviewAuthor, .author').first().text(),80);
   const rating=number(row.find('.albumReviewRating').first().text().trim(),100);
   const sanitized=sanitizeReviewSnippet({kind:'critic',...(publication?{publication}:{}),...(author?{author}:{}),...(rating!==null?{score:rating}:{}),text},'aoty');
   if(sanitized)snippets.push(sanitized);
  });
  $('#user-reviews .albumReviewRow, .userReviews .albumReviewRow, #popularUserReviews .albumReviewRow, .userReviewRow').each((_,el)=>{
   if(snippets.filter(s=>s.kind==='user').length>=4)return;
   const row=$(el);
   const text=cleanSnippet(row.find('.albumReviewText, .reviewText').text());
   if(!text)return;
   const author=cleanSnippet(row.find('.albumReviewAuthor, .userReviewName, a[href*="/user/"]').first().text(),80);
   const rating=number(row.find('.albumReviewRating, .rating').first().text().trim(),100);
   const sanitized=sanitizeReviewSnippet({kind:'user',...(author?{author}:{}),...(rating!==null?{score:rating}:{}),text},'aoty');
   if(sanitized)snippets.push(sanitized);
  });
  if(snippets.length)obs.reviewSnippets=snippets;

  const linkScope=$('.albumTopBox, .musicLinks, .buyButtons, #centerContent');
  const links=extractStreamingLinks($,linkScope.length?linkScope:undefined)??extractStreamingLinks($);
  if(links)a.capturedLinks=links;
 }
 return a;
}
function rymLocaleText($:ReturnType<typeof load>,node:ReturnType<typeof $>):string{
 const orig=node.find('.ui_name_locale_original').first().text().replace(/\s+/g,' ').trim();
 return orig||node.text().replace(/\s+/g,' ').trim();
}
export function parseRym(html:string,url:string):Album|null{
 const $=load(html);
 let released='',fmt='',infoArtist='',infoRatingText='';
 const infoGenres:string[]=[],infoDescriptors:string[]=[];
 $('table.album_info tr, tr').each((_,e)=>{
  const label=$(e).find('th,.info_hdr').first().text().replace(/\s+/g,' ').trim();
  if(!label)return;
  const td=$(e).find('td').last();
  if(!td.length)return;
  if(!released&&/Released|Release date/i.test(label))released=td.text().replace(/\s+/g,' ').trim();
  else if(!fmt&&/^Type$/i.test(label))fmt=td.text().replace(/\s+/g,' ').trim();
  else if(!infoArtist&&/^Artist$/i.test(label)){
   const links=td.find('a.artist, a').toArray().map(n=>rymLocaleText($,$(n))).filter(Boolean);
   infoArtist=links.length?links.join(' / '):rymLocaleText($,td);
  }else if(/Genres?$/i.test(label)){
   infoGenres.push(...td.find('a.genre, a').toArray().map(n=>$(n).text().replace(/\s+/g,' ').trim()).filter(Boolean));
  }else if(/Descriptors?$/i.test(label)){
   infoDescriptors.push(...td.text().split(',').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean));
  }else if(!infoRatingText&&/RYM Rating/i.test(label)){
   infoRatingText=td.text().replace(/\s+/g,' ').trim();
  }
 });
 const docTitleMatch=$('title').first().text().replace(/\s+/g,' ').trim().match(/^(.*?)\s+by\s+(.*?)\s+\(([^)]+)\):/i);
 const docTitle=docTitleMatch?.[1]?.trim()??'';
 const docArtist=docTitleMatch?.[2]?.trim()??'';
 const artistNode=$('.album_artist .artist, .album_artist a, .releaseartist a, [itemprop="byArtist"] [itemprop="name"]').first();
 const artist=(artistNode.length?rymLocaleText($,artistNode):'')||infoArtist||rymLocaleText($,$('.album_info a.artist').first())||docArtist;
 const titleEl=$('.album_title, h1.release_title, h1[itemprop="name"]').first().clone();
 titleEl.find('.album_shortcut, .album_artist, input').remove();
 titleEl.find('span').filter((_,s)=>$(s).find('a.artist').length>0).remove();
 let rawTitle=rymLocaleText($,titleEl);
 if(artist){
  const escapedArtist=artist.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  rawTitle=rawTitle.replace(new RegExp(`\\s+By\\s+${escapedArtist}$`,'i'),'').trim();
 }
 const title=rawTitle||docTitle;

 const aggregateRatingEl=$('[itemprop="ratingValue"]').filter((_,el)=>$(el).closest('.review, .reviews_shell').length===0).first();
 const ratingCandidates=[
  $('.avg_rating').first().text().trim(),
  aggregateRatingEl.attr('content')?.trim()??'',
  aggregateRatingEl.text().trim(),
  infoRatingText
 ];
 let scoreText='';
 for(const candidate of ratingCandidates){
  const m=candidate.match(/(\d(?:\.\d+)?)/);
  if(m){scoreText=m[1]!;break;}
 }
 const countEl=$('[itemprop="ratingCount"]').filter((_,el)=>$(el).closest('.review, .reviews_shell').length===0).first();
 const rawDisplay=
  $('.num_ratings').first().text().replace(/\s+/g,' ').trim()||
  countEl.attr('content')?.trim()||
  countEl.text().replace(/\s+/g,' ').trim()||
  (infoRatingText.match(/from\s+([\d,.]+\s*[km]?)\s+ratings?/i)?.[1]?.trim()??'');
 const display=rawDisplay.replace(/^from\s+/i,'').replace(/\s+ratings?$/i,'').trim();
 const a=album('rym',url,artist,title,date(released),format(fmt||(/\/release\/album\//.test(url)?'Album':'')),number(scoreText,5),parseVotes(display));
 if(a){
  const obs=a.sources[0]!;
  obs.votesDisplay=display;
  obs.votesApproximate=/\d\s*[km]\b/i.test(display);
  obs.detailCaptured=true;
  const domGenres=$('.release_pri_genres a, .release_sec_genres a').toArray().map(e=>$(e).text().trim()).filter(Boolean);
  a.genres=[...new Set(domGenres.length?domGenres:infoGenres)];
  const descriptorText=$('.release_pri_descriptors .comma_separated, .release_pri_descriptors').toArray().map(e=>$(e).text()).join(',');
  const descriptorList=descriptorText?descriptorText.split(','):infoDescriptors;
  const descriptors=[...new Set(descriptorList.map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean))].slice(0,15);
  if(descriptors.length){obs.descriptors=descriptors;a.descriptors=descriptors;}

  const snippets:ReviewSnippet[]=[];
  const seenReviewNodes=new Set<unknown>();
  const seenSnippetKeys=new Set<string>();
  $('.review, .review_body').each((_,el)=>{
   if(snippets.length>=4)return;
   const node=$(el);
   const reviewEl=node.hasClass('review')?node:node.closest('.review');
   const bodyEl=node.hasClass('review_body')?node:node.find('.review_body').first();
   const targetEl=bodyEl.length?bodyEl:reviewEl.length?reviewEl:node;
   const keyNode=reviewEl.length?reviewEl[0]:targetEl[0];
   if(!keyNode||seenReviewNodes.has(keyNode))return;
   seenReviewNodes.add(keyNode);

   const statusScope=reviewEl.length?reviewEl:targetEl;
   const publishStatusText=statusScope.find('.review_publish_status').text().replace(/\s+/g,' ').trim();
   if(/\bnot\s+published\b|\bunpublished\b/i.test(publishStatusText))return;
   if(statusScope.is('.not_published, .unpublished')||statusScope.find('.not_published, .unpublished').length>0)return;
   const isOwnReviewBox=statusScope.closest('#my_review, #saved_review, .saved_review').length>0||targetEl.hasClass('my_review')||reviewEl.hasClass('my_review');
   if(isOwnReviewBox&&!/^published\b/i.test(publishStatusText))return;

   const cleanBody=targetEl.clone();
   cleanBody.find('.review_publish_status, .album_shortcut, input, button, script, style, .review_header, .review_user, .review_date, .review_rating, .review_actions').remove();
   cleanBody.find('br').replaceWith(' ');
   const descEl=cleanBody.find('[itemprop="description"]');
   const rawText=descEl.length?descEl.text():cleanBody.text();
   const text=cleanSnippet(rawText);
   if(!text)return;

   const metaScope=reviewEl.length?reviewEl:node;
   const author=cleanSnippet(metaScope.find('.review_user, a.user').first().text(),80);
   const ratingText=metaScope.find('.review_rating, [itemprop="ratingValue"]').first().text().trim();
   const rating=number(ratingText,5);
   const sanitized=sanitizeReviewSnippet({kind:'user',...(author?{author}:{}),...(rating!==null?{score:rating}:{}),text},'rym');
   if(!sanitized||sanitized.text.length<12)return;

   const dedupeKey=`${(sanitized.author??'').toLowerCase()}\0${sanitized.text.toLowerCase()}`;
   if(seenSnippetKeys.has(dedupeKey))return;
   seenSnippetKeys.add(dedupeKey);
   snippets.push(sanitized);
  });
  if(snippets.length)obs.reviewSnippets=snippets;

  const coverEl=$('.coverart img, img.coverart_img, .page_release_art_frame img, #coverart_img').first();
  const cover=cleanImageUrl(coverEl.attr('data-src')||coverEl.attr('data-srcset')||coverEl.attr('src'));
  if(cover)a.coverUrl=cover;
  const linkScope=$('.ui_media_links_container, .release_media_links');
  const links=extractStreamingLinks($,linkScope.length?linkScope:undefined)??extractStreamingLinks($);
  if(links)a.capturedLinks=links;
 }
 return a;
}
type ObjectMap=Record<string,unknown>;
function obj(v:unknown):ObjectMap{return v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectMap:{};}
function str(v:unknown):string{return typeof v==='string'?v:'';}
function readPreloadedState($:ReturnType<typeof load>):ObjectMap{
 let state:ObjectMap={};
 $('script').each((_,e)=>{
  const text=$(e).html()??'';
  const marker=text.indexOf('__PRELOADED_STATE__');
  if(marker<0)return;
  const start=text.indexOf('{',marker);
  if(start<0)return;
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
   const c=text[i];
   if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
   else if(c==='"')quoted=true;
   else if(c==='{')depth++;
   else if(c==='}'&&--depth===0){try{state=obj(JSON.parse(text.slice(start,i+1)));}catch{}break;}
  }
 });
 return state;
}
export function parsePitchfork(html:string,url:string):Album|null{
 const $=load(html);const state=readPreloadedState($);const review=obj(obj(state.transformed).review);const header=obj(review.headerProps);const rating=obj(header.musicRating);const infoSlice=obj(header.infoSliceFields);
 const artists=Array.isArray(header.artists)?header.artists.map(a=>typeof a==='string'?a:str(obj(a).name)).filter(Boolean).join(' & '):str(header.artist);
 const title=str(header.title)||str(header.albumTitle)||load(str(header.dangerousHed)).text();
 const reissue=(rating.bestNewReissue===true||rating.isBestNewReissue===true)||header.isReissue===true;
 const explicitRelease=date(str(header.releaseDate)||str(review.releaseDate));
 const ry=Number(infoSlice.releaseYear);
 const pubYear=date(str(header.publishDate)||str(infoSlice.reviewDate)||str(header.modifiedDate)).slice(0,4);
 const refYear=pubYear?Number(pubYear):new Date().getUTCFullYear();
 const archivalRelease=!explicitRelease&&Number.isInteger(ry)&&ry>=1900&&ry<=refYear-2?`${ry}-01-01`:'';
 const releaseDate=explicitRelease||archivalRelease;
 const fmt:Album['format']=reissue?'Reissue':/\bEP$/i.test(title)?'EP':'Unknown';
 const a=album('pitchfork',url,artists,title,releaseDate,fmt,number(rating.rating??rating.score,10),null);
 if(a){
  const obs=a.sources[0]!;
  obs.bestNewMusic=(rating.bestNewMusic===true||rating.isBestNewMusic===true)&&!reissue;
  obs.notes=archivalRelease?`Archival release year ${ry} extracted from Pitchfork review metadata.`:'Editorial review; release date remains unknown unless explicit release metadata or corroborating source supplies it.';
  obs.detailCaptured=true;
  if(obs.score!==null){obs.criticScore=obs.score;obs.criticVotes=1;}
  const dekRaw=str(header.dangerousDek)||str(header.dek)||str(review.dek);
  const dekText=dekRaw?load(dekRaw).text():($('meta[name="description"]').attr('content')??'');
  const summary=cleanSnippet(dekText,360);
  if(summary)obs.editorialSummary=summary;

  const snippets:ReviewSnippet[]=[];
  $('article p, .body__inner-container p, [class*="BodyWrapper"] p').each((_,el)=>{
   if(snippets.length>=3)return;
   const text=cleanSnippet($(el).text(),300);
   if(text.length>=40)snippets.push({kind:'critic',publication:'Pitchfork',...(obs.score!==null?{score:obs.score}:{}),text});
  });
  if(!snippets.length&&Array.isArray(review.body)){
   for(const block of review.body){
    if(snippets.length>=3)break;
    const raw=typeof block==='string'?block:str(obj(block).text)||str(obj(block).html);
    const text=cleanSnippet(raw?load(raw).text():'',300);
    if(text.length>=40)snippets.push({kind:'critic',publication:'Pitchfork',...(obs.score!==null?{score:obs.score}:{}),text});
   }
  }
  if(snippets.length)obs.reviewSnippets=snippets;

  const ledeSources=obj(obj(header.lede).sources);
  const cover=cleanImageUrl(str(obj(ledeSources.sm).url)||str(obj(ledeSources.md).url)||$('meta[property="og:image"]').attr('content'));
  if(cover)a.coverUrl=cover;
  if(typeof infoSlice.genre==='string')a.genres=infoSlice.genre.split(/[,/]/).map(s=>s.trim()).filter(Boolean);
  else if(Array.isArray(infoSlice.genre))a.genres=infoSlice.genre.map(g=>typeof g==='string'?g:str(obj(g).name)).filter(Boolean);
 }
 return a;
}
export function parsePitchforkIndex(html:string,pageUrl:string):{albums:Album[];warnings:string[]}{
 const $=load(html),state=readPreloadedState($),bundle=obj(obj(state.transformed).bundle);
 const containers=Array.isArray(bundle.containers)?bundle.containers:[];
 const items=containers.flatMap(c=>Array.isArray(obj(c).items)?obj(c).items as unknown[]:[]);
 const byUrl=new Map<string,ObjectMap>();
 for(const raw of items){
  const item=obj(raw),rawUrl=str(item.url);
  if(!rawUrl)continue;
  try{
   const u=new URL(rawUrl,origins.pitchfork);
   if(u.origin!==origins.pitchfork||!/^\/reviews\/albums\/[^/]+\/?$/.test(u.pathname))continue;
   u.search='';u.hash='';
   if(!u.pathname.endsWith('/'))u.pathname+='/';
   if(!byUrl.has(u.href))byUrl.set(u.href,item);
  }catch{}
 }
 const warnings:string[]=[];
 const entries=[...byUrl.entries()];
 if(entries.length>60)warnings.push('本次只收录当前页面的前 60 个条目');
 const observedAt=new Date().toISOString();
 const albums:Album[]=[];
 for(const [reviewUrl,item] of entries.slice(0,60)){
  const subHed=obj(item.subHed);
  const artist=str(subHed.name).trim()||(Array.isArray(item.artists)?item.artists.map(a=>typeof a==='string'?a:str(obj(a).name)).filter(Boolean).join(' & '):str(item.artist).trim());
  const title=load(str(item.dangerousHed)).text().trim()||str(obj(item.source).hed).replace(/^\*+|\*+$/g,'').trim();
  const rating=obj(item.ratingValue??item.musicRating);
  const score=number(rating.score??rating.rating,10);
  if(!artist||!title||score===null)continue;
  const reissue=rating.isBestNewReissue===true||rating.bestNewReissue===true;
  const fmt:Album['format']=reissue?'Reissue':/\bEP$/i.test(title)?'EP':'Unknown';
  const imgSources=obj(obj(item.image).sources);
  const cover=cleanImageUrl(str(obj(imgSources.sm).url)||str(obj(imgSources.md).url));
  const genres=Array.isArray(item.rubric)?[...new Set(item.rubric.map(r=>str(obj(r).name).trim()).filter(g=>g&&!/^albums?$/i.test(g)))]:[];
  const dekRaw=str(item.dangerousDek)||str(item.dek)||str(obj(item.promoHed).dek);
  const editorialSummary=dekRaw?cleanSnippet(load(dekRaw).text(),300):'';
  albums.push({
   id:albumId(artist,title),
   artist,
   title,
   releaseDate:'',
   format:fmt,
   ...(cover?{coverUrl:cover}:{}),
   genres,
   excluded:false,
   sources:[{
    source:'pitchfork',
    score,
    scale:10,
    votes:null,
    criticScore:score,
    criticVotes:1,
    bestNewMusic:(rating.isBestNewMusic===true||rating.bestNewMusic===true)&&!reissue,
    url:reviewUrl,
    observedAt,
    status:'ok',
    collectionMethod:'browser-capture',
    sourcePageUrl:pageUrl,
    ...(editorialSummary?{editorialSummary}:{}),
    notes:'Editorial review list capture; release date awaits RYM/AOTY corroboration.'
   }]
  });
 }
 return {albums,warnings};
}
export function parseIndex(html:string,source:SourceName):string[]{const $=load(html);const links=new Set<string>();$('a[href]').each((_,e)=>{try{const u=new URL($(e).attr('href')!,origins[source]);if(u.origin!==origins[source])return;const valid=source==='aoty'?/^\/album\/\d+[^/]*\.php$/.test(u.pathname):source==='rym'?/^\/release\/(?:album|ep)\/[^/]+\/[^/]+\/?$/.test(u.pathname):/^\/reviews\/albums\/[^/]+\/$/.test(u.pathname);if(valid){u.search='';u.hash='';links.add(u.href);}}catch{}});return [...links];}

export { date as parseReleaseDate };
