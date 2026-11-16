import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import proxy from '@fastify/http-proxy';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConnectionStatus, Overview, RunMode, SourceName, SourceStatus } from '../shared/types.js';
import { AuthService, AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS } from './auth.js';
import { Store } from './store.js';
import { SourceService } from './sources/index.js';
import { NeteaseClient } from './netease.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { decide, todayInTimezone } from './policy.js';
import { saveCapture } from './capture.js';
import { CaptureError } from './sources/charts.js';

const names:SourceName[]=['aoty','rym','pitchfork'];
const number=(min:number,max:number)=>z.number().finite().min(min).max(max);
const integer=(min:number,max:number)=>number(min,max).int();
const settingsSchema=z.object({allowApproximateVotes:z.boolean().optional().default(false),lookbackDays:integer(1,365),minimumAgeDays:integer(0,365),minSources:integer(1,3),thresholds:z.object({aoty:z.object({score:number(0,100),votes:integer(0,100000000),negative:number(0,100)}),rym:z.object({score:number(0,5),votes:integer(0,100000000),negative:number(0,5)}),pitchfork:z.object({score:number(0,10),negative:number(0,10),allowBnm:z.boolean()})}),sources:z.object({aoty:z.boolean(),rym:z.boolean(),pitchfork:z.boolean()}),schedule:z.object({enabled:z.boolean(),weekday:integer(0,6),hour:integer(0,23),minute:integer(0,59),timezone:z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true}catch{return false}})}),playlist:z.object({namePattern:z.string().min(1).max(100).refine(v=>v.includes('YYYY-MM')),descriptionMaxChars:integer(1,1000)}),requestDelayMs:integer(6000,3600000)});
const source=(value:string):SourceName|null=>names.includes(value as SourceName)?value as SourceName:null;
export async function createApp(options:{dataDir:string;scheduler?:boolean;sources?:SourceService}) {
 const app=Fastify({logger:false,bodyLimit:32768,trustProxy:process.env.TRUST_PROXY==='true'});
 await app.register(cookie);
 const store=new Store(options.dataDir),auth=new AuthService(store),sources=options.sources??new SourceService(options.dataDir);
 const cli=resolve('node_modules/.bin/ncm-cli');
 const netease=new NeteaseClient(options.dataDir,existsSync(cli)?{executable:cli}:{});
 const runner=new Runner(store,sources,netease);
 runner.recoverInterrupted();
 store.recoverHttpLock();
 const scheduler=options.scheduler===false?null:new Scheduler(store,runner);
 let connection:ConnectionStatus={configured:store.getValue('netease-configured')==='true',loggedIn:false,message:'尚未检查网易云连接',loginState:'idle'};
 let checkPromise:Promise<ConnectionStatus>|undefined;
 const loginAttempts=new Map<string,{count:number;expires:number}>();
 const statuses=():SourceStatus[]=>names.map(s=>store.sourceStatuses().find(x=>x.source===s)??{source:s,status:'unknown',message:'尚未检查'});
 const sourceAction=async<T>(reply:FastifyReply,action:()=>Promise<T>)=>{
  const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务或来源操作正在运行，请等待完成后重试'});
  try{return await action();}finally{store.releaseLock(owner);}
 };
 app.addHook('onRequest',async(req,reply)=>{
  const pathname=req.url.split('?')[0]??'';
  if(!pathname.startsWith('/api/')&&!pathname.startsWith('/verification/'))return;
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
 app.get('/api/albums',async()=>store.albums());
 app.get('/api/captures',async()=>store.captures());
 app.post<{Params:{source:string}}>('/api/sources/:source/chart',async(req,reply)=>{
  const name=req.params.source;if(name!=='rym'&&name!=='aoty')return reply.code(400).send({error:'当前榜单收录支持 RYM 和 AOTY'});
  return sourceAction(reply,()=>sources.openChart(name));
 });
 app.post<{Params:{source:string}}>('/api/sources/:source/capture',async(req,reply)=>{
  const name=req.params.source;if(name!=='rym'&&name!=='aoty')return reply.code(400).send({error:'当前榜单收录支持 RYM 和 AOTY'});
  return sourceAction(reply,async()=>{try{return saveCapture(store,await sources.captureCurrent(name));}catch(e){return reply.code(400).send({error:e instanceof CaptureError?e.message:'未收录：请确认独立浏览器打开的是对应站点的用户评分榜，已完成验证和加载，再重试。'});}});
 });
 app.post<{Params:{id:string}}>('/api/albums/:id/exclude',async(req,reply)=>{const parsed=z.object({excluded:z.boolean()}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'参数无效'});const owner=`http-action:${randomUUID()}`;if(!store.acquireLock(owner))return reply.code(409).send({error:'任务运行中，请完成后再调整专辑'});try{const albums=store.albums(),album=albums.find(a=>a.id===req.params.id);if(!album)return reply.code(404).send({error:'专辑不存在'});const settings=store.settings();album.excluded=parsed.data.excluded;album.decision=decide(album,settings,todayInTimezone(settings.schedule.timezone));store.saveAlbums(albums);return album;}finally{store.releaseLock(owner);}});
 app.get('/api/runs',async()=>store.runs());
 app.get<{Params:{id:string}}>('/api/runs/:id',async(req,reply)=>store.runs().find(r=>r.id===req.params.id)??reply.code(404).send({error:'运行记录不存在'}));
 app.post('/api/runs',async(req,reply)=>{const parsed=z.object({mode:z.enum(['refresh','preview','sync'])}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'任务类型无效'});try{return runner.start(parsed.data.mode as RunMode);}catch(e){return reply.code(409).send({error:e instanceof Error?e.message:'无法启动任务'});}});
 app.get('/api/playlists',async()=>store.playlists());
 app.get('/api/connection',async()=>connection);
 app.post('/api/connection/configure',async(req,reply)=>{const parsed=z.object({appId:z.string().min(1).max(256),privateKey:z.string().min(1).max(16384)}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'请填写开发者凭据'});connection=await netease.configure(parsed.data.appId,parsed.data.privateKey);store.setValue('netease-configured','true');return connection;});
 app.post('/api/connection/login',async()=>{connection=await netease.login();return connection;});
 app.post('/api/connection/check',async()=>{checkPromise??=netease.status().then(c=>{if(c.configured)store.setValue('netease-configured','true');connection={...c,configured:c.configured||store.getValue('netease-configured')==='true'};return connection;}).finally(()=>{checkPromise=undefined;});return checkPromise;});
 app.post('/api/connection/cancel',async()=>{connection=await netease.cancelLogin();return connection;});
 app.get('/api/sources',async()=>statuses());
 app.post<{Params:{source:string}}>('/api/sources/:source/check',async(req,reply)=>{const name=source(req.params.source);if(!name)return reply.code(400).send({error:'来源无效'});return sourceAction(reply,async()=>{const result=await sources.check(name,store.settings());store.saveSourceStatuses(statuses().map(s=>s.source===name?result:s));return result;});});
 app.get<{Querystring:{source?:string}}>('/api/verification',async(req,reply)=>{const name=req.query.source?source(req.query.source):undefined;if(req.query.source&&!name)return reply.code(400).send({error:'来源无效'});return sourceAction(reply,()=>sources.verification(name??undefined));});
 if(process.env.BROWSER_UI_URL)await app.register(proxy,{upstream:process.env.BROWSER_UI_URL,prefix:'/verification',rewritePrefix:'',websocket:true});
 const webDir=resolve('dist/web');if(existsSync(resolve(webDir,'index.html')))await app.register(staticFiles,{root:webDir,prefix:'/'});
 app.addHook('onClose',async()=>{scheduler?.stop();await runner.wait();await sources.close();await netease.close();store.close();});
 return app;
}
