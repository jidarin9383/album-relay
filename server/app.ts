import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Album, ConnectionStatus, ExtensionCaptureResult, Overview, RunMode, SourceName, SourceStatus } from '../shared/types.js';
import { AuthService, AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS } from './auth.js';
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

const EXTENSION_BODY_LIMIT=8*1024*1024;

const names:SourceName[]=['aoty','rym','pitchfork'];
const number=(min:number,max:number)=>z.number().finite().min(min).max(max);
const integer=(min:number,max:number)=>number(min,max).int();
const settingsSchema=z.object({allowApproximateVotes:z.boolean().optional().default(false),lookbackDays:integer(1,365),minimumAgeDays:integer(0,365),minSources:integer(1,3),thresholds:z.object({aoty:z.object({score:number(0,100),votes:integer(0,100000000),negative:number(0,100)}),rym:z.object({score:number(0,5),votes:integer(0,100000000),negative:number(0,5)}),pitchfork:z.object({score:number(0,10),negative:number(0,10),allowBnm:z.boolean()})}),sources:z.object({aoty:z.boolean(),rym:z.boolean(),pitchfork:z.boolean()}),schedule:z.object({enabled:z.boolean(),weekday:integer(0,6),hour:integer(0,23),minute:integer(0,59),timezone:z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true}catch{return false}})}),playlist:z.object({namePattern:z.string().min(1).max(100).refine(v=>v.includes('YYYY-MM')),descriptionMaxChars:integer(1,1000)}),requestDelayMs:integer(6000,3600000)});
const source=(value:string):SourceName|null=>names.includes(value as SourceName)?value as SourceName:null;
export async function createApp(options:{dataDir:string;scheduler?:boolean;sources?:SourceService;netease?:NeteaseClient}) {
 const app=Fastify({logger:false,bodyLimit:32768,trustProxy:process.env.TRUST_PROXY==='true'});
 await app.register(cookie);
 const store=new Store(options.dataDir),auth=new AuthService(store),extension=new ExtensionService(store),sources=options.sources??new SourceService(options.dataDir);
 const cli=resolve('node_modules/.bin/ncm-cli');
 const netease=options.netease??new NeteaseClient(options.dataDir,existsSync(cli)?{executable:cli}:{});
 const runner=new Runner(store,sources,netease);
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
 const scheduler=options.scheduler===false?null:new Scheduler(store,runner);
 let connection:ConnectionStatus={configured:store.getValue('netease-configured')==='true',loggedIn:false,message:'尚未检查网易云连接',loginState:'idle'};
 let checkPromise:Promise<ConnectionStatus>|undefined;
 const loginAttempts=new Map<string,{count:number;expires:number}>();
 const coverMisses=new Map<string,number>();
 const coverInFlight=new Map<string,Promise<string|null>>();
 const presentAlbum=(album:Album,covers:Record<string,string>):Album=>{
  const cover=isDirectlyLoadableCover(album.coverUrl)?album.coverUrl:covers[album.id];
  const copy={...album};
  if(cover)copy.coverUrl=cover;else delete copy.coverUrl;
  return copy;
 };
 const presentAlbums=():Album[]=>{
  const covers=store.covers();
  return store.albums().map(a=>presentAlbum(a,covers));
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
   const expected=`${req.protocol}://${req.headers.host}`;
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
 app.put('/api/settings',async(req,reply)=>{const parsed=settingsSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'设置无效：请检查分数、时区、月份占位符及采集间隔（至少 6000 毫秒）'});const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务运行中，请完成后再修改规则'});try{store.transaction(()=>{store.saveSettings(parsed.data);const today=todayInTimezone(parsed.data.schedule.timezone);store.saveAlbums(store.albums().map(a=>({...a,decision:decide(a,parsed.data,today)})));store.setValue('latest-preview','');});scheduler?.configure();return parsed.data;}finally{store.releaseLock(owner);}});
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
  return sourceAction(reply,async()=>{try{return mergeCaptureConflict(store,req.params.id,parsed.data.url);}catch{return reply.code(404).send({error:'待合并记录不存在或已处理'});}});
 });
 const withAlbumLock=async(reply:FastifyReply,fn:()=>unknown)=>{
  const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务运行中，请完成后再调整专辑'});
  try{return fn();}finally{store.releaseLock(owner);}
 };
 app.post<{Params:{id:string}}>('/api/albums/:id/exclude',async(req,reply)=>{const parsed=z.object({excluded:z.boolean()}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'参数无效'});return withAlbumLock(reply,()=>{const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);if(!album)return reply.code(404).send({error:'专辑不存在'});const settings=store.settings();album.excluded=parsed.data.excluded;album.decision=decide(album,settings,todayInTimezone(settings.schedule.timezone));store.saveAlbums(albums);return presentAlbum(album,store.covers());});});
 app.post<{Params:{id:string}}>('/api/albums/:id/status',async(req,reply)=>{const parsed=z.object({listeningStatus:z.enum(['unheard','saved','listened','liked','disliked','skipped'])}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'听歌状态无效'});return withAlbumLock(reply,()=>{const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);if(!album)return reply.code(404).send({error:'专辑不存在'});album.listeningStatus=parsed.data.listeningStatus;store.saveAlbums(albums);return presentAlbum(album,store.covers());});});
 app.post<{Params:{id:string}}>('/api/albums/:id/format',async(req,reply)=>{const parsed=z.object({format:z.enum(['LP','EP','Reissue','Unknown'])}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'专辑格式无效'});return withAlbumLock(reply,()=>{const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);if(!album)return reply.code(404).send({error:'专辑不存在'});const settings=store.settings();album.format=parsed.data.format;album.decision=decide(album,settings,todayInTimezone(settings.schedule.timezone));store.saveAlbums(albums);store.setValue('latest-preview','');return presentAlbum(album,store.covers());});});
 app.get('/api/runs',async()=>store.runs());
 // Administrator side of the Chrome extension: pairing and scheduled refresh settings.
 app.get('/api/extension',async()=>extension.state());
 app.post('/api/extension/token',async()=>({token:extension.issueToken()}));
 app.delete('/api/extension/token',async()=>{extension.revoke();return extension.state();});
 const refreshSchema=z.object({enabled:z.boolean(),hour:integer(0,23),targets:z.array(z.string().trim().min(1).max(300)).max(MAX_REFRESH_TARGETS)});
 app.put('/api/extension/refresh',async(req,reply)=>{
  const parsed=refreshSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:`定时刷新设置无效：时间为 0–23 点，最多 ${MAX_REFRESH_TARGETS} 个页面`});
  const invalid=parsed.data.targets.find(t=>capturableSource(resolveTarget(t))===null);
  if(invalid)return reply.code(400).send({error:`不支持的页面：${invalid}。仅支持 RYM/AOTY 榜单与专辑页，以及 Pitchfork 乐评列表或单篇乐评`});
  extension.saveRefresh(parsed.data);return extension.state();
 });
 // Extension side (bearer token, see onRequest hook).
 app.get('/api/ext/config',async(req)=>{const version=req.headers['x-album-relay-extension'];extension.seen(typeof version==='string'?version:undefined);return extension.config();});
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
 app.post('/api/runs',async(req,reply)=>{const parsed=z.object({mode:z.enum(['refresh','preview','library_preview','sync'])}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'任务类型无效'});try{return runner.start(parsed.data.mode as RunMode);}catch(e){return reply.code(409).send({error:e instanceof Error?e.message:'无法启动任务'});}});
 app.get('/api/playlists',async()=>store.playlists());
 app.get('/api/connection',async()=>connection);
 app.post('/api/connection/configure',async(req,reply)=>{const parsed=z.object({appId:z.string().min(1).max(256),privateKey:z.string().min(1).max(16384)}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'请填写开发者凭据'});connection=await netease.configure(parsed.data.appId,parsed.data.privateKey);store.setValue('netease-configured','true');return connection;});
 app.post('/api/connection/login',async()=>{connection=await netease.login();return connection;});
 app.post('/api/connection/check',async()=>{checkPromise??=netease.status().then(c=>{if(c.configured)store.setValue('netease-configured','true');connection={...c,configured:c.configured||store.getValue('netease-configured')==='true'};return connection;}).finally(()=>{checkPromise=undefined;});return checkPromise;});
 app.post('/api/connection/cancel',async()=>{connection=await netease.cancelLogin();return connection;});
 app.get('/api/sources',async()=>statuses());
 app.post<{Params:{source:string}}>('/api/sources/:source/check',async(req,reply)=>{const name=source(req.params.source);if(!name)return reply.code(400).send({error:'来源无效'});return sourceAction(reply,async()=>{const result=await sources.check(name,store.settings());store.saveSourceStatuses(statuses().map(s=>s.source===name?result:s));return result;});});
 const webDir=resolve('dist/web');if(existsSync(resolve(webDir,'index.html')))await app.register(staticFiles,{root:webDir,prefix:'/'});
 app.addHook('onClose',async()=>{scheduler?.stop();await runner.wait();await sources.close();await netease.close();store.close();});
 return app;
}
