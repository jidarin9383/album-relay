import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Album, AlbumAiReview, ConnectionStatus, ExtensionCaptureResult, Overview, RunMode, Settings, SourceName, SourceStatus } from '../shared/types.js';
import type { CorroborationRunResult, PersonalOverview, RecommendationSet } from '../shared/personal.js';
import { AuthService, AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS } from './auth.js';
import { AutomationCoordinator } from './automation.js';
import { Store } from './store.js';
import { SourceService } from './sources/index.js';
import { NeteaseClient } from './netease.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { decide, todayInTimezone } from './policy.js';
import { saveCapture, mergeCaptureConflict } from './capture.js';
import { CaptureError, parseCapturedPage } from './sources/charts.js';
import { SERVER_FETCH_SOURCES, EXTENSION_ONLY_MESSAGE } from './sources/index.js';
import { ExtensionService, EXTENSION_PREFIX, MAX_REFRESH_TARGETS, capturableSource, resolveTarget } from './extension.js';
import { isDirectlyLoadableCover, resolvePublicCover } from './covers.js';
import { buildListenLinks, readListenLinksCacheMap, resolveAlbumListenLinks } from './links.js';
import { DefaultLlmClient, getAiApiKey, getAiSettings, saveAiSettings, type LlmClient } from './ai/client.js';
import { isSameAiEndpoint, normalizeAiBaseUrl } from '../shared/ai-endpoint.js';
import { buildMonthlyAiDraft, readLatestMonthlyDraft } from './ai/playlist.js';
import { generateAlbumAiReview, readAiReviewsMap, ReviewQueue } from './ai/reviews.js';
import { generateRecommendationsSmart, readLatestPersona } from './ai/curator.js';
import { importPersonalData, listImportBatches } from './personal/imports.js';
import { addManualFavorite, recordAlbumFeedback } from './personal/feedback.js';
import { buildCorroborationQueue, buildTasteProfile } from './personal/profile.js';
import { enrichArtistGenres, listArtistMetadataSummary, saveManualArtistGenres } from './personal/enrichment.js';
import { autoCorroborateAlbums } from './personal/corroborate.js';
import { listRecommendationSets } from './recommendations/ranker.js';

const EXTENSION_BODY_LIMIT=8*1024*1024;
const IMPORT_BODY_LIMIT=50*1024*1024;

const names:SourceName[]=['aoty','rym','pitchfork'];
const number=(min:number,max:number)=>z.number().finite().min(min).max(max);
const integer=(min:number,max:number)=>number(min,max).int();
const settingsSchema=z.object({allowApproximateVotes:z.boolean().optional().default(true),allowSingleSourceAcclaim:z.boolean().optional().default(true),autoSyncPlaylist:z.boolean().optional().default(true),lookbackDays:integer(1,365),minimumAgeDays:integer(0,365),minSources:integer(1,3),thresholds:z.object({aoty:z.object({score:number(0,100),votes:integer(0,100000000),negative:number(0,100)}),rym:z.object({score:number(0,5),votes:integer(0,100000000),negative:number(0,5)}),pitchfork:z.object({score:number(0,10),negative:number(0,10),allowBnm:z.boolean()})}),sources:z.object({aoty:z.boolean(),rym:z.boolean(),pitchfork:z.boolean()}),schedule:z.object({enabled:z.boolean(),weekday:integer(0,6),hour:integer(0,23),minute:integer(0,59),timezone:z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true}catch{return false}})}),playlist:z.object({namePattern:z.string().min(1).max(100).refine(v=>v.includes('YYYY-MM')),descriptionMaxChars:integer(1,1000),aiCurated:z.boolean().optional().default(true),aiDescription:z.boolean().optional().default(true),maxAlbumsPerMonth:integer(1,50).optional().default(12)}),requestDelayMs:integer(6000,3600000)});
const source=(value:string):SourceName|null=>names.includes(value as SourceName)?value as SourceName:null;
export async function createApp(options:{dataDir:string;scheduler?:boolean;sources?:SourceService;netease?:NeteaseClient;ai?:LlmClient}) {
 const app=Fastify({logger:false,bodyLimit:32768,trustProxy:process.env.TRUST_PROXY==='true'});
 await app.register(cookie);
 const store=new Store(options.dataDir),auth=new AuthService(store),extension=new ExtensionService(store),sources=options.sources??new SourceService(options.dataDir);
 const aiClient=options.ai??new DefaultLlmClient();
 const reviewQueue=new ReviewQueue();
 const cli=resolve('node_modules/.bin/ncm-cli');
 const netease=options.netease??new NeteaseClient(options.dataDir,existsSync(cli)?{executable:cli}:{});
 const runner=new Runner(store,sources,netease,aiClient);
 runner.recoverInterrupted();
 store.recoverHttpLock();
 if(store.getValue('policy-migrated-v2')!=='true'){
  const settings=store.settings();
  const today=todayInTimezone(settings.schedule.timezone);
  const current=store.albums();
  let changed=false;
  const updated=current.map(a=>{
   const next=structuredClone(a);
   if(next.format==='Unknown'&&/\bEP$/i.test(next.title))next.format='EP';
   next.decision=decide(next,settings,today);
   if(next.format!==a.format||JSON.stringify(next.decision)!==JSON.stringify(a.decision))changed=true;
   return next;
  });
  store.transaction(()=>{
   if(changed){store.saveAlbums(updated);store.setValue('latest-preview','');}
   store.setValue('policy-migrated-v2','true');
  });
 }
 if(store.getValue('policy-migrated-v3')!=='true'){
  const migratedSettings:Settings={
   ...store.settings(),
   allowApproximateVotes:true,
   allowSingleSourceAcclaim:true,
   autoSyncPlaylist:true,
   minimumAgeDays:0
  };
  const today=todayInTimezone(migratedSettings.schedule.timezone);
  const updated=store.albums().map(a=>({...structuredClone(a),decision:decide(a,migratedSettings,today)}));
  store.transaction(()=>{
   store.saveSettings(migratedSettings);
   store.saveAlbums(updated);
   store.setValue('latest-preview','');
   store.setValue('policy-migrated-v3','true');
  });
 }
 if(store.getValue('policy-migrated-v4')!=='true'){
  const curSettings=store.settings();
  const migratedSettings:Settings={
   ...curSettings,
   playlist:{
    ...curSettings.playlist,
    aiCurated:curSettings.playlist.aiCurated??true,
    aiDescription:curSettings.playlist.aiDescription??true,
    maxAlbumsPerMonth:curSettings.playlist.maxAlbumsPerMonth??12
   }
  };
  const today=todayInTimezone(migratedSettings.schedule.timezone);
  const updated=store.albums().map(a=>({...structuredClone(a),decision:decide(a,migratedSettings,today)}));
  store.transaction(()=>{
   store.saveSettings(migratedSettings);
   store.saveAlbums(updated);
   store.setValue('latest-preview','');
   store.setValue('policy-migrated-v4','true');
  });
 }
 const automation=options.scheduler===false?null:new AutomationCoordinator({store,aiClient,reviewQueue,runner,netease});
 const scheduler=automation?new Scheduler(store,()=>automation.triggerNow()):null;
 automation?.bootstrapIfNeeded();
 let connection:ConnectionStatus={configured:store.getValue('netease-configured')==='true',loggedIn:false,message:'尚未检查网易云连接',loginState:'idle'};
 let checkPromise:Promise<ConnectionStatus>|undefined;
 const loginAttempts=new Map<string,{count:number;expires:number}>();
 const coverMisses=new Map<string,number>();
 const coverInFlight=new Map<string,Promise<string|null>>();
 const presentAlbum=(
  album:Album,
  covers:Record<string,string>,
  linksMap?:Map<string,{spotify_url:string|null;youtube_music_url:string|null}>,
  reviewsMap?:Map<string,AlbumAiReview>
 ):Album=>{
  const cover=isDirectlyLoadableCover(album.coverUrl)?album.coverUrl:covers[album.id];
  const copy:Album={...album};
  if(cover)copy.coverUrl=cover;else delete copy.coverUrl;
  copy.listenLinks=buildListenLinks(copy,linksMap?.get(album.id));
  copy.aiReview=reviewsMap?.get(album.id)??null;
  return copy;
 };
 const presentAlbums=():Album[]=>{
  const covers=store.covers();
  const linksMap=readListenLinksCacheMap(store);
  const reviewsMap=readAiReviewsMap(store);
  return store.albums().map(a=>presentAlbum(a,covers,linksMap,reviewsMap));
 };
 // RYM/AOTY status comes from the extension's latest report; the server never fetches them.
 const statuses=():SourceStatus[]=>names.map(s=>{
  if(!SERVER_FETCH_SOURCES.includes(s)){
   const r=extension.state().reports.find(x=>x.source===s);
   if(!r)return {source:s,status:'unknown',message:EXTENSION_ONLY_MESSAGE};
   return {source:s,status:r.state==='ok'?'ok':r.state==='challenge'?'blocked':'error',checkedAt:r.at,message:r.state==='challenge'?`需要验证：请在 Chrome 中打开 ${r.url} 手动完成一次`:`浏览器扩展：${r.message}`};
  }
  return store.sourceStatuses().find(x=>x.source===s)??{source:s,status:'unknown',message:'尚未检查'};
 });
 const sourceAction=async<T>(reply:FastifyReply,action:()=>Promise<T>)=>{
  const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务或来源操作正在运行，请等待完成后重试'});
  try{return await action();}finally{store.releaseLock(owner);}
 };
 app.addHook('onRequest',async(req,reply)=>{
  const pathname=req.url.split('?')[0]??'';
  if(pathname.startsWith(EXTENSION_PREFIX)){
   // The paired extension authenticates with its bearer token only; session cookies are never accepted here.
   if(!extension.authenticate(req.headers.authorization))return reply.code(401).send({error:'扩展未配对或令牌已失效，请在 Album Relay 重新生成配对令牌'});
   return;
  }
  if(!pathname.startsWith('/api/'))return;
  if(req.headers.origin){
   const expected=`${req.protocol}://${req.host}`;
   if(req.headers.origin!==expected)return reply.code(403).send({error:'请求来源不受信任'});
  }
  if(['/api/session','/api/setup','/api/login'].includes(pathname))return;
  if(!auth.authenticate(req.cookies[AUTH_COOKIE_NAME]))return reply.code(401).send({error:'请先登录'});
 });
 app.setErrorHandler((error,_req,reply)=>{const e=error as {statusCode?:number;message?:string};const status=e.statusCode&&e.statusCode>=400&&e.statusCode<500?e.statusCode:500;reply.code(status).send({error:status===500?'操作失败，请检查配置和运行记录':e.message??'请求无效'});});
 app.get('/api/session',async(req)=>({authenticated:auth.authenticate(req.cookies[AUTH_COOKIE_NAME]),setupRequired:auth.setupRequired()}));
 const password=z.object({password:z.string().min(12).max(1024)});
 app.post('/api/setup',async(req,reply)=>{const parsed=password.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'密码须为 12 至 1024 个字符'});try{const token=auth.setup(parsed.data.password);reply.setCookie(AUTH_COOKIE_NAME,token,{...AUTH_COOKIE_OPTIONS,secure:req.protocol==='https'});return {authenticated:true,setupRequired:false};}catch{return reply.code(409).send({error:'管理员已设置或密码无效'});}});
 app.post('/api/login',async(req,reply)=>{const now=Date.now();for(const [ip,entry] of loginAttempts)if(entry.expires<=now)loginAttempts.delete(ip);const existing=loginAttempts.get(req.ip);if(existing&&existing.count>=10)return reply.code(429).send({error:'登录尝试过多，请五分钟后重试'});const failed=()=>{if(!existing&&loginAttempts.size>=1000)loginAttempts.delete(loginAttempts.keys().next().value!);loginAttempts.set(req.ip,{count:(existing?.count??0)+1,expires:existing?.expires??now+5*60*1000});return reply.code(401).send({error:'密码错误'});};const parsed=password.safeParse(req.body);if(!parsed.success)return failed();try{const token=auth.login(parsed.data.password);loginAttempts.delete(req.ip);reply.setCookie(AUTH_COOKIE_NAME,token,{...AUTH_COOKIE_OPTIONS,secure:req.protocol==='https'});return {authenticated:true,setupRequired:false};}catch{return failed();}});
 app.post('/api/logout',async(req,reply)=>{auth.logout(req.cookies[AUTH_COOKIE_NAME]);reply.clearCookie(AUTH_COOKIE_NAME,{path:'/'});return {authenticated:false};});
 app.get('/api/settings',async()=>store.settings());
 app.put('/api/settings',async(req,reply)=>{const parsed=settingsSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'设置无效：请检查分数、时区、月份占位符及采集间隔（至少 6000 毫秒）'});const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务运行中，请完成后再修改规则'});try{store.transaction(()=>{store.saveSettings(parsed.data);const today=todayInTimezone(parsed.data.schedule.timezone);store.saveAlbums(store.albums().map(a=>({...a,decision:decide(a,parsed.data,today)})));store.setValue('latest-preview','');});scheduler?.configure();automation?.scheduleAfterTasteChange(false);return parsed.data;}finally{store.releaseLock(owner);}});
 app.get('/api/overview',async()=>{const albums=store.albums();const result:Overview={albums:albums.length,selected:albums.filter(a=>a.decision?.status==='selected').length,pending:albums.filter(a=>a.decision?.status==='pending').length,disagreements:albums.filter(a=>a.decision?.status==='disagreement').length,playlists:store.playlists(),lastRun:store.runs()[0]??null,nextRun:scheduler?.nextRun()??null,sourceStatuses:statuses(),connection};return result;});
 app.get('/api/albums',async()=>presentAlbums());
 app.get<{Params:{id:string}}>('/api/albums/:id/cover',async(req,reply)=>{
  const album=store.albums().find(a=>a.id===req.params.id);
  if(!album)return reply.code(404).send({error:'专辑不存在'});
  if(isDirectlyLoadableCover(album.coverUrl)){
   reply.header('Cache-Control','private, max-age=86400');
   return reply.redirect(album.coverUrl!,302);
  }
  const cached=store.covers()[album.id];
  if(isDirectlyLoadableCover(cached)){
   reply.header('Cache-Control','private, max-age=86400');
   return reply.redirect(cached!,302);
  }
  const missedAt=coverMisses.get(album.id);
  if(missedAt&&Date.now()-missedAt<3600_000)return reply.code(404).send({error:'暂无可用封面'});
  let pending=coverInFlight.get(album.id);
  if(!pending){
   pending=resolvePublicCover(album.artist,album.title).finally(()=>{coverInFlight.delete(album.id);});
   coverInFlight.set(album.id,pending);
  }
  const resolved=await pending;
  if(!resolved){
   if(coverMisses.size>=1000)coverMisses.delete(coverMisses.keys().next().value!);
   coverMisses.set(album.id,Date.now());
   return reply.code(404).send({error:'暂无可用封面'});
  }
  store.saveCover(album.id,resolved);
  reply.header('Cache-Control','private, max-age=86400');
  return reply.redirect(resolved,302);
 });
 app.get('/api/captures',async()=>store.captures());
 app.post<{Params:{id:string}}>('/api/captures/:id/merge',async(req,reply)=>{
  const parsed=z.object({url:z.string().url().max(500)}).safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'合并参数无效'});
  return sourceAction(reply,async()=>{try{const receipt=mergeCaptureConflict(store,req.params.id,parsed.data.url);automation?.scheduleAfterCapture();return receipt;}catch{return reply.code(404).send({error:'待合并记录不存在或已处理'});}});
 });
 const withAlbumLock=async(reply:FastifyReply,fn:()=>unknown)=>{
  const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务运行中，请完成后再调整专辑'});
  try{return fn();}finally{store.releaseLock(owner);}
 };
 app.post<{Params:{id:string}}>('/api/albums/:id/exclude',async(req,reply)=>{const parsed=z.object({excluded:z.boolean()}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'参数无效'});return withAlbumLock(reply,()=>{const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);if(!album)return reply.code(404).send({error:'专辑不存在'});const settings=store.settings();album.excluded=parsed.data.excluded;album.decision=decide(album,settings,todayInTimezone(settings.schedule.timezone));store.saveAlbums(albums);automation?.scheduleAfterTasteChange(false);return presentAlbum(album,store.covers(),readListenLinksCacheMap(store),readAiReviewsMap(store));});});
 app.post<{Params:{id:string}}>('/api/albums/:id/status',async(req,reply)=>{
  const parsed=z.object({listeningStatus:z.enum(['unheard','saved','listened','liked','disliked','skipped']),reaction:z.enum(['liked','neutral','disliked']).optional()}).safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'听歌状态无效'});
  return withAlbumLock(reply,()=>{
   const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);
   if(!album)return reply.code(404).send({error:'专辑不存在'});
   album.listeningStatus=parsed.data.listeningStatus;
   store.transaction(()=>{
    store.saveAlbums(albums);
    recordAlbumFeedback(store,album,parsed.data.listeningStatus,parsed.data.reaction);
    if(parsed.data.listeningStatus==='disliked'||parsed.data.listeningStatus==='skipped'||parsed.data.reaction==='disliked'){
     store.setValue('latest-preview','');
    }
   });
   automation?.scheduleAfterTasteChange(false);
   return presentAlbum(album,store.covers(),readListenLinksCacheMap(store),readAiReviewsMap(store));
  });
 });
 const presentRecommendationSet=(set:RecommendationSet):RecommendationSet=>{
  const covers=store.covers();
  const linksMap=readListenLinksCacheMap(store);
  const reviewsMap=readAiReviewsMap(store);
  const liveAlbums=new Map(store.albums().map(a=>[a.id,a]));
  const playlists=store.playlists();
  return {
   ...set,
   items:set.items.map(item=>{
    const live=liveAlbums.get(item.album.id);
    const playlistMonth=playlists.find(p=>p.albumIds.includes(item.album.id))?.month;
    const merged:Album=live
     ?{
       ...item.album,
       format:live.format,
       listeningStatus:live.listeningStatus,
       admittedMonth:live.admittedMonth??playlistMonth,
       match:live.match??item.album.match,
       capturedLinks:live.capturedLinks??item.album.capturedLinks,
       sources:live.sources.length?live.sources:item.album.sources
      }
     :playlistMonth?{...item.album,admittedMonth:item.album.admittedMonth??playlistMonth}:item.album;
    return {...item,album:presentAlbum(merged,covers,linksMap,reviewsMap)};
   })
  };
 };
 const getPersonalOverview=():PersonalOverview=>{
  const covers=store.covers();
  const linksMap=readListenLinksCacheMap(store);
  const reviewsMap=readAiReviewsMap(store);
  const profile=buildTasteProfile(store);
  return {
   profile,
   batches:listImportBatches(store),
   recommendations:listRecommendationSets(store).map(presentRecommendationSet),
   artistMetadata:listArtistMetadataSummary(store),
   corroborationQueue:buildCorroborationQueue(store).map(c=>({...c,album:presentAlbum(c.album,covers,linksMap,reviewsMap)})),
   persona:readLatestPersona(store,profile.revision),
   aiEnabled:getAiSettings(store).enabled
  };
 };
 app.get('/api/personal/overview',async():Promise<PersonalOverview>=>getPersonalOverview());
 app.post('/api/personal/corroborate',async(_req,reply)=>{
  return sourceAction(reply,async():Promise<CorroborationRunResult>=>{
   const stats=await autoCorroborateAlbums(store);
   const aiCfg=getAiSettings(store);
   if(aiCfg.enabled&&aiCfg.autoReviewSelected&&stats.newlySelectedCount>0){
    reviewQueue.enqueueSelected(store,aiClient);
   }
   return {...stats,overview:getPersonalOverview()};
  });
 });
 app.post('/api/personal/enrich',async(_req,reply)=>{
  return sourceAction(reply,async()=>enrichArtistGenres(store));
 });
 app.post<{Params:{artistNorm:string}}>('/api/personal/artists/:artistNorm/genres',async(req,reply)=>{
  const parsed=z.object({artistName:z.string().trim().min(1).max(200),genres:z.array(z.string().trim().min(1).max(60)).min(1).max(20)}).safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'请填写有效的艺人名和至少一个流派标签'});
  return withAlbumLock(reply,()=>{
   try{
    saveManualArtistGenres(store,{artistNorm:req.params.artistNorm,artistName:parsed.data.artistName,genres:parsed.data.genres});
    automation?.scheduleAfterTasteChange(false);
    return {profile:buildTasteProfile(store),artistMetadata:listArtistMetadataSummary(store)};
   }catch(e){
    return reply.code(400).send({error:e instanceof Error?e.message:'保存流派失败'});
   }
  });
 });
 const importSchema=z.object({
  source:z.enum(['netease','spotify','youtube_music','rym_export','generic']),
  accountAlias:z.string().max(64).optional(),
  fileName:z.string().min(1).max(200),
  content:z.string().min(1).max(IMPORT_BODY_LIMIT)
 });
 app.post('/api/personal/imports',{bodyLimit:IMPORT_BODY_LIMIT},async(req,reply)=>{
  const parsed=importSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'导入请求参数或文件大小超出限制'});
  return sourceAction(reply,async()=>{
   try{
    const batch=importPersonalData(store,parsed.data);
    automation?.scheduleAfterTasteChange(true);
    return {batch,profile:buildTasteProfile(store)};
   }catch(e){
    return reply.code(400).send({error:e instanceof Error?e.message:'导入解析失败'});
   }
  });
 });
 app.post('/api/personal/favorites',async(req,reply)=>{
  const parsed=z.object({artist:z.string().trim().min(1).max(200),title:z.string().trim().max(200).optional(),genres:z.array(z.string().trim().min(1).max(60)).max(20).optional()}).safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'请填写有效的艺人或专辑名称'});
  return withAlbumLock(reply,()=>{
   addManualFavorite(store,parsed.data);
   automation?.scheduleAfterTasteChange(true);
   return {profile:buildTasteProfile(store)};
  });
 });
 app.get('/api/recommendations',async()=>listRecommendationSets(store).map(presentRecommendationSet));
 app.post('/api/recommendations/generate',async(req,reply)=>{
  const parsed=z.object({preferenceSlots:integer(1,20).optional(),explorationSlots:integer(0,10).optional()}).safeParse(req.body??{});
  if(!parsed.success)return reply.code(400).send({error:'推荐数量参数无效'});
  const generated=await generateRecommendationsSmart(store,parsed.data,aiClient);
  return presentRecommendationSet(generated);
 });
 app.get('/api/ai',async()=>({settings:getAiSettings(store)}));
 const aiSettingsSchema=z.object({
  enabled:z.boolean(),
  provider:z.enum(['ollama','gemini','openai_compatible']),
  baseUrl:z.string().trim().min(1).max(500),
  model:z.string().trim().min(1).max(120),
  autoReviewSelected:z.boolean().optional().default(true),
  timeoutMs:integer(5000,180000).optional().default(45000),
  apiKey:z.string().max(1024).optional(),
  clearApiKey:z.boolean().optional()
 });
 app.put('/api/ai',async(req,reply)=>{
  const parsed=aiSettingsSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'AI 配置无效：请检查模型服务地址、模型名称与超时时间（5000–180000ms）'});
  try{
   const settings=saveAiSettings(store,parsed.data);
   return {settings};
  }catch(e){
   return reply.code(400).send({error:e instanceof Error?e.message:'AI 配置保存失败'});
  }
 });
 app.post('/api/ai/check',async(req,reply)=>{
  const draftSchema=z.object({
   provider:z.enum(['ollama','gemini','openai_compatible']).optional(),
   baseUrl:z.string().trim().min(1).max(500).optional(),
   model:z.string().trim().min(1).max(120).optional(),
   apiKey:z.string().max(1024).optional(),
   clearApiKey:z.boolean().optional()
  });
  const parsed=draftSchema.safeParse(req.body??{});
  if(!parsed.success)return reply.code(400).send({error:'模型连接测试参数无效'});
  const saved=getAiSettings(store);
  try{
   const provider=parsed.data.provider??saved.provider;
   const baseUrl=parsed.data.baseUrl?normalizeAiBaseUrl(parsed.data.baseUrl,provider):saved.baseUrl;
   const model=parsed.data.model??saved.model;
   const draft={...saved,provider,baseUrl,model};
   const savedKey=isSameAiEndpoint(saved,draft)?getAiApiKey(store):null;
   const apiKey=parsed.data.clearApiKey?null:parsed.data.apiKey?.trim()||savedKey;
   return await aiClient.checkConnection({...draft,hasApiKey:Boolean(apiKey)},apiKey);
  }catch(e){
   return reply.code(400).send({error:e instanceof Error?e.message:'模型地址无效'});
  }
 });
 app.post<{Params:{id:string}}>('/api/albums/:id/review',async(req,reply)=>{
  const parsed=z.object({force:z.boolean().optional()}).safeParse(req.body??{});
  if(!parsed.success)return reply.code(400).send({error:'请求参数无效'});
  const album=store.albums().find(a=>a.id===req.params.id);
  if(!album)return reply.code(404).send({error:'专辑不存在'});
  try{
   const review=await generateAlbumAiReview(store,album,aiClient,{force:parsed.data.force});
   return {review,album:presentAlbum(album,store.covers(),readListenLinksCacheMap(store),readAiReviewsMap(store))};
  }catch(e){
   const message=e instanceof Error?e.message:'AI 评论生成失败';
   return reply.code(/启用并配置/.test(message)?400:502).send({error:message});
  }
 });
 app.post('/api/ai/reviews/generate-selected',async(_req,reply)=>{
  if(!getAiSettings(store).enabled)return reply.code(400).send({error:'请先启用并保存 AI 策展引擎配置'});
  return reviewQueue.enqueueSelected(store,aiClient);
 });
 app.post<{Params:{id:string}}>('/api/albums/:id/resolve-links',async(req,reply)=>{
  const album=store.albums().find(a=>a.id===req.params.id);
  if(!album)return reply.code(404).send({error:'专辑不存在'});
  await resolveAlbumListenLinks(store,album);
  let latestAlbum=album;
  if(connection.loggedIn&&!album.match){
   try{
    const matched=await netease.match(album, store.settings().lookbackDays);
    if(matched){
     const owner=`http-action:${randomUUID()}`;
     if(store.acquireLock(owner)){
      try{
       const current=store.albums();
       const target=current.find(a=>a.id===album.id);
       if(target&&!target.match){
        target.match=matched;
        store.saveAlbums(current);
        latestAlbum=target;
       }
      }finally{store.releaseLock(owner);}
     }
    }
   }catch{
    // Ignore transient NetEase lookup error when resolving public links.
   }
  }
  return presentAlbum(latestAlbum,store.covers(),readListenLinksCacheMap(store),readAiReviewsMap(store));
 });
 app.post<{Params:{id:string}}>('/api/albums/:id/format',async(req,reply)=>{const parsed=z.object({format:z.enum(['LP','EP','Reissue','Unknown'])}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'专辑格式无效'});return withAlbumLock(reply,()=>{const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);if(!album)return reply.code(404).send({error:'专辑不存在'});const settings=store.settings();album.format=parsed.data.format;album.decision=decide(album,settings,todayInTimezone(settings.schedule.timezone));store.saveAlbums(albums);store.setValue('latest-preview','');automation?.scheduleAfterCapture(2000);return presentAlbum(album,store.covers(),readListenLinksCacheMap(store),readAiReviewsMap(store));});});
 app.get('/api/runs',async()=>store.runs());
 // Administrator side of the Chrome extension: pairing and scheduled refresh settings.
 app.get('/api/extension',async()=>extension.state(store.albums()));
 app.post('/api/extension/token',async()=>({token:extension.issueToken()}));
 app.delete('/api/extension/token',async()=>{extension.revoke();return extension.state(store.albums());});
 const refreshSchema=z.object({enabled:z.boolean(),hour:integer(0,23),targets:z.array(z.string().trim().min(1).max(300)).max(MAX_REFRESH_TARGETS),detailBackfill:z.boolean().optional(),detailBatchSize:integer(1,6).optional()});
 app.put('/api/extension/refresh',async(req,reply)=>{
  const parsed=refreshSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:`定时刷新设置无效：时间为 0–23 点，最多 ${MAX_REFRESH_TARGETS} 个页面`});
  const invalid=parsed.data.targets.find(t=>capturableSource(resolveTarget(t))===null);
  if(invalid)return reply.code(400).send({error:`不支持的页面：${invalid}。仅支持 RYM/AOTY 榜单与专辑页，以及 Pitchfork 乐评列表或单篇乐评`});
  extension.saveRefresh(parsed.data);return extension.state(store.albums());
 });
 // Extension side (bearer token, see onRequest hook).
 app.get('/api/ext/config',async(req)=>{const version=req.headers['x-album-relay-extension'];extension.seen(typeof version==='string'?version:undefined);return extension.config(store.albums());});
 const extensionPage=z.object({url:z.string().url().max(2000),html:z.string().min(1).max(EXTENSION_BODY_LIMIT)});
 app.post('/api/ext/capture',{bodyLimit:EXTENSION_BODY_LIMIT},async(req,reply)=>{
  const parsed=extensionPage.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'页面内容无效'});
  const {url,html}=parsed.data,name=capturableSource(url);
  if(!name)return reply.code(400).send({error:'页面不属于受支持的榜单、专辑页或乐评页'});
  const key=url.split('#')[0]!;
  if(extension.recentlyCaptured(key))return {status:'skipped',reason:'recent'} satisfies ExtensionCaptureResult;
  const at=new Date().toISOString();
  return sourceAction(reply,async()=>{
   try{
    const receipt=saveCapture(store,parseCapturedPage(name,html,url));
    extension.markCaptured(key);
    extension.report({source:name,state:'ok',message:`收录 ${receipt.albums.length} 条评分证据，新增 ${receipt.added}、更新 ${receipt.updated}`,url:receipt.pageUrl,at});
    if(automation){
     automation.scheduleAfterCapture();
    }else{
     const aiCfg=getAiSettings(store);
     if(aiCfg.enabled&&aiCfg.autoReviewSelected)reviewQueue.enqueueSelected(store,aiClient);
    }
    return {status:'captured',receipt} satisfies ExtensionCaptureResult;
   }catch(e){
    const message=e instanceof CaptureError?e.message:'页面解析失败';
    extension.report({source:name,state:/验证/.test(message)?'challenge':'error',message,url:key,at});
    return reply.code(422).send({error:message});
   }
  });
 });
 const reportSchema=z.object({source:z.enum(['aoty','rym','pitchfork']),state:z.enum(['challenge','error']),message:z.string().trim().min(1).max(300),url:z.string().url().max(2000)});
 app.post('/api/ext/report',async(req,reply)=>{
  const parsed=reportSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'报告无效'});
  extension.report({...parsed.data,at:new Date().toISOString()});return {ok:true};
 });
 app.get<{Params:{id:string}}>('/api/runs/:id',async(req,reply)=>store.runs().find(r=>r.id===req.params.id)??reply.code(404).send({error:'运行记录不存在'}));
 app.post('/api/runs',async(req,reply)=>{
  const parsed=z.object({
   mode:z.enum(['refresh','preview','library_preview','sync','auto_sync']),
   selection:z.object({recommendationSetId:z.string().max(100).optional(),albumIds:z.array(z.string().min(1).max(100)).min(1).max(50)}).optional()
  }).safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'任务类型或入选专辑参数无效'});
  if(parsed.data.selection&&parsed.data.mode!=='library_preview')return reply.code(400).send({error:'仅生成歌单预览支持指定入选专辑列表'});
  try{return runner.start(parsed.data.mode as RunMode,parsed.data.selection);}catch(e){return reply.code(409).send({error:e instanceof Error?e.message:'无法启动任务'});}
 });
 app.post('/api/automation/run',async()=>{automation?.triggerNow();return {ok:true};});
 app.get('/api/playlists',async()=>store.playlists());
 app.get('/api/playlists/draft',async()=>({draft:readLatestMonthlyDraft(store)}));
 app.post('/api/playlists/preview-ai',async()=>{const draft=await buildMonthlyAiDraft(store,aiClient);return {draft};});
 app.get('/api/connection',async()=>connection);
 app.post('/api/connection/configure',async(req,reply)=>{const parsed=z.object({appId:z.string().min(1).max(256),privateKey:z.string().min(1).max(16384)}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'请填写开发者凭据'});connection=await netease.configure(parsed.data.appId,parsed.data.privateKey);store.setValue('netease-configured','true');return connection;});
 app.post('/api/connection/login',async()=>{connection=await netease.login();return connection;});
 app.post('/api/connection/check',async()=>{checkPromise??=netease.status().then(c=>{if(c.configured)store.setValue('netease-configured','true');connection={...c,configured:c.configured||store.getValue('netease-configured')==='true'};return connection;}).finally(()=>{checkPromise=undefined;});return checkPromise;});
 app.post('/api/connection/cancel',async()=>{connection=await netease.cancelLogin();return connection;});
 app.get('/api/sources',async()=>statuses());
 app.post<{Params:{source:string}}>('/api/sources/:source/check',async(req,reply)=>{const name=source(req.params.source);if(!name)return reply.code(400).send({error:'来源无效'});return sourceAction(reply,async()=>{const result=await sources.check(name,store.settings());store.saveSourceStatuses(statuses().map(s=>s.source===name?result:s));return result;});});
 const webDir=resolve('dist/web');if(existsSync(resolve(webDir,'index.html')))await app.register(staticFiles,{root:webDir,prefix:'/'});
 app.addHook('onClose',async()=>{scheduler?.stop();await automation?.stop();await reviewQueue.stop();await runner.wait();await sources.close();await netease.close();store.close();});
 return app;
}
