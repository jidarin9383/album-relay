import { load } from 'cheerio';
import { albumId } from '../policy.js';
import type { Album, SourceName } from '../../shared/types.js';
export const origins: Record<SourceName,string>={aoty:'https://www.albumoftheyear.org',rym:'https://rateyourmusic.com',pitchfork:'https://pitchfork.com'};
export function normalizeIdentity(s:string):string{return s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s*&\s*|\s+\/\s+/g,' and ').replace(/[^\p{L}\p{N}]/gu,'');}
export function parseVotes(value:string):number|null{const m=value.replace(/,/g,'').match(/(\d+(?:\.\d+)?)\s*([km])?/i);return m?Math.round(Number(m[1])*(m[2]?.toLowerCase()==='k'?1000:m[2]?.toLowerCase()==='m'?1000000:1)):null;}
export function isChallenge(html:string,status:number):boolean{return [403,429,503].includes(status)||/just a moment|verify (?:you are|that you)|checking your browser|cf-chl-|captcha|access denied|rate limit exceeded/i.test(html.slice(0,150000));}
function date(s:string):string{if(!s||!(/\d{4}-\d{2}-\d{2}/.test(s)||/[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}/.test(s)))return ''; const v=Date.parse(/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10)+"T00:00:00Z":s+" UTC");return Number.isFinite(v)?new Date(v).toISOString().slice(0,10):'';}
export function cleanImageUrl(raw?:string|null):string|undefined{
 if(!raw)return undefined;
 const first=raw.trim().split(',')[0]?.trim().split(/\s+/)[0]??'';
 if(!first||/^data:/i.test(first))return undefined;
 const normalized=first.startsWith('//')?`https:${first}`:first;
 try{const u=new URL(normalized);return u.protocol==='https:'?u.href:undefined;}catch{return undefined;}
}
function number(s:unknown,max:number):number|null{const n=typeof s==='number'?s:typeof s==='string'&&s.trim()?Number(s):NaN;return Number.isFinite(n)&&n>=0&&n<=max?n:null;}
function album(source:SourceName,url:string,artist:string,title:string,releaseDate:string,format:Album['format'],score:number|null,votes:number|null):Album|null{if(!artist.trim()||!title.trim())return null;return {id:albumId(artist,title),artist:artist.trim(),title:title.trim(),releaseDate,format,genres:[],sources:[{source,score,scale:source==='aoty'?100:source==='rym'?5:10,votes,url,observedAt:new Date().toISOString(),status:score===null?'missing':'ok'}],excluded:false};}
function format(s:string):Album['format']{if(/reissue|re-release/i.test(s))return 'Reissue';if(/\bEP\b/.test(s))return 'EP';return /\bLP\b|^Album$/i.test(s.trim())?'LP':'Unknown';}
export function parseAoty(html:string,url:string):Album|null{const $=load(html);const rows=$('.detailRow').toArray().map(e=>$(e).text().trim());const release=rows.find(s=>/release date/i.test(s))?.split('/')[0]?.trim()??'';const fmt=rows.find(s=>/\/\s*format/i.test(s))?.split('/')[0]??'';const user=$('.albumUserScoreBox').first().length?$('.albumUserScoreBox').first():$('.userScoreBox').first();const score=$('.albumUserScore').first().text().trim()||user.find('[itemprop="ratingValue"]').text().trim();const votes=user.text().match(/(?:based on\s*)?([\d,.]+\s*[km]?)\s*ratings/i)?.[1]??'';const a=album('aoty',url,$('.artist').first().text(),$('.albumTitle').first().text(),date(release),format(fmt),number(score,100),parseVotes(votes));if(a){a.sources[0]!.votesDisplay=votes;a.sources[0]!.votesApproximate=/\d\s*[km]\b/i.test(votes);const coverEl=$('.albumTopBox img, .albumArtwork img').first();const cover=cleanImageUrl(coverEl.attr('data-src')||coverEl.attr('src')||coverEl.attr('srcset'));if(cover)a.coverUrl=cover;a.genres=$('.detailRow a[href*="/genre/"]').toArray().map(e=>$(e).text().trim());}return a;}
export function parseRym(html:string,url:string):Album|null{const $=load(html);let released='',fmt='';$('tr').each((_,e)=>{const label=$(e).find('th,.info_hdr').text();if(/Released|Release date/i.test(label))released=$(e).find('td').last().text().trim();if(/^Type$/i.test(label.trim()))fmt=$(e).find('td').last().text().trim();});const score=$('[itemprop="ratingValue"], .avg_rating').first().text().trim();const el=$('[itemprop="ratingCount"], .num_ratings').first();const display=el.attr('content')||el.text().trim();const a=album('rym',url,$('.album_artist .artist, .album_artist a, [itemprop="byArtist"] [itemprop="name"]').first().text(),$('.album_title, h1[itemprop="name"]').first().clone().children('.album_shortcut').remove().end().text(),date(released),format(fmt||(/\/release\/album\//.test(url)?'Album':'')),number(score,5),parseVotes(display));if(a){a.sources[0]!.votesDisplay=display;a.sources[0]!.votesApproximate=/\d\s*[km]\b/i.test(display);a.genres=$('.release_pri_genres a').toArray().map(e=>$(e).text());const coverEl=$('.coverart img').first();const cover=cleanImageUrl(coverEl.attr('data-src')||coverEl.attr('data-srcset')||coverEl.attr('src'));if(cover)a.coverUrl=cover;}return a;}
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
export function parsePitchfork(html:string,url:string):Album|null{const $=load(html);const state=readPreloadedState($);const review=obj(obj(state.transformed).review);const header=obj(review.headerProps);const rating=obj(header.musicRating);const infoSlice=obj(header.infoSliceFields);const artists=Array.isArray(header.artists)?header.artists.map(a=>typeof a==='string'?a:str(obj(a).name)).filter(Boolean).join(' & '):str(header.artist);const title=str(header.title)||str(header.albumTitle)||load(str(header.dangerousHed)).text();const reissue=(rating.bestNewReissue===true||rating.isBestNewReissue===true)||header.isReissue===true;const explicitRelease=date(str(header.releaseDate)||str(review.releaseDate));const ry=Number(infoSlice.releaseYear);const pubYear=date(str(header.publishDate)||str(infoSlice.reviewDate)||str(header.modifiedDate)).slice(0,4);const refYear=pubYear?Number(pubYear):new Date().getUTCFullYear();const archivalRelease=!explicitRelease&&Number.isInteger(ry)&&ry>=1900&&ry<=refYear-2?`${ry}-01-01`:'';const releaseDate=explicitRelease||archivalRelease;const fmt:Album['format']=reissue?'Reissue':/\bEP$/i.test(title)?'EP':'Unknown';const a=album('pitchfork',url,artists,title,releaseDate,fmt,number(rating.rating??rating.score,10),null);if(a){a.sources[0]!.bestNewMusic=(rating.bestNewMusic===true||rating.isBestNewMusic===true)&&!reissue;a.sources[0]!.notes=archivalRelease?`Archival release year ${ry} extracted from Pitchfork review metadata.`:'Editorial review; release date remains unknown unless explicit release metadata or corroborating source supplies it.';const ledeSources=obj(obj(header.lede).sources);const cover=cleanImageUrl(str(obj(ledeSources.sm).url)||str(obj(ledeSources.md).url)||$('meta[property="og:image"]').attr('content'));if(cover)a.coverUrl=cover;if(typeof infoSlice.genre==='string')a.genres=infoSlice.genre.split(/[,/]/).map(s=>s.trim()).filter(Boolean);else if(Array.isArray(infoSlice.genre))a.genres=infoSlice.genre.map(g=>typeof g==='string'?g:str(obj(g).name)).filter(Boolean);}return a;}
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
    bestNewMusic:(rating.isBestNewMusic===true||rating.bestNewMusic===true)&&!reissue,
    url:reviewUrl,
    observedAt,
    status:'ok',
    collectionMethod:'browser-capture',
    sourcePageUrl:pageUrl,
    notes:'Editorial review list capture; release date awaits RYM/AOTY corroboration.'
   }]
  });
 }
 return {albums,warnings};
}
export function parseIndex(html:string,source:SourceName):string[]{const $=load(html);const links=new Set<string>();$('a[href]').each((_,e)=>{try{const u=new URL($(e).attr('href')!,origins[source]);if(u.origin!==origins[source])return;const valid=source==='aoty'?/^\/album\/\d+[^/]*\.php$/.test(u.pathname):source==='rym'?/^\/release\/(?:album|ep)\/[^/]+\/[^/]+\/?$/.test(u.pathname):/^\/reviews\/albums\/[^/]+\/$/.test(u.pathname);if(valid){u.search='';u.hash='';links.add(u.href);}}catch{}});return [...links];}

export { date as parseReleaseDate };
