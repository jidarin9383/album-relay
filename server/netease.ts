import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Album, ConnectionStatus, MatchedAlbum, Playlist, SyncPreview, Track } from '../shared/types.js';
import { executePlan } from './planner.js';
import QRCode from 'qrcode';
type ObjectValue = Record<string, unknown>;
export type CommandRunner = (args: readonly string[])=>Promise<unknown>;
interface ClientOptions { delayMs?:number; executable?:string; useDesktopAccount?:boolean; command?:CommandRunner }
const object = (v:unknown):ObjectValue => v && typeof v==='object' && !Array.isArray(v) ? v as ObjectValue : {};
const normalized = (v:string)=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 8 * 3_600_000;

function chinaCatalogDay(timestamp: number): number {
  return Math.floor((timestamp + CHINA_OFFSET_MS) / DAY_MS);
}

function track(v:unknown):Track { const t=object(v); if(typeof t.id!=='string'||typeof t.originalId!=='number'||typeof t.name!=='string') throw new Error('网易云曲目格式不兼容');return {id:t.id,originalId:t.originalId,name:t.name,...(typeof t.duration==='number'?{duration:t.duration}:{})}; }
export class NeteaseClient {
  private queue:Promise<unknown>=Promise.resolve(); private lastFinished=0; private children=new Set<ChildProcess>(); private closed=false;
  private connection:ConnectionStatus={configured:false,loggedIn:false,message:'尚未连接网易云',loginState:'idle'};
  private generation=0; private setup:Promise<void>|null=null;
  constructor(private dataDir:string,private options:ClientOptions={}) {}
  private async initialize():Promise<void> {
    if(this.options.useDesktopAccount || this.options.command) return;
    this.setup ??= (async()=>{
      await mkdir(path.join(this.dataDir,'account'),{recursive:true,mode:0o700});
      await writeFile(path.join(this.dataDir,'account-home.cjs'),"const os=require('node:os'); const p=process.env.LISTEN_BETTER_ACCOUNT_HOME || process.env.ALBUM_RELAY_ACCOUNT_HOME; if(!p)throw new Error('Missing account home');os.homedir=()=>p;\n",{mode:0o600});
    })(); await this.setup;
  }
  private async spawnCommand(args:readonly string[]):Promise<unknown> {
    await this.initialize();
    const env={...process.env};
    if(!this.options.useDesktopAccount) {env.LISTEN_BETTER_ACCOUNT_HOME=path.resolve(this.dataDir,'account');env.NODE_OPTIONS=`${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(path.resolve(this.dataDir,'account-home.cjs'))}`.trim();}
    return new Promise((resolve,reject)=>{
      const child=spawn(this.options.executable ?? 'ncm-cli',[...args],{shell:false,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
      this.children.add(child);let output='';let bytes=0;let settled=false;
      const stop=()=>{try {if(child.pid && process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{ /* already exited */ }};
      const fail=()=>{if(settled)return;settled=true;stop();reject(new Error('网易云命令失败，请检查连接或重新授权'));};
      const timeout=setTimeout(fail,60_000);
      child.stdout?.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*1024*1024)fail();else output+=chunk.toString();});
      child.stderr?.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*1024*1024)fail();});
      child.on('error',fail);child.on('close',code=>{clearTimeout(timeout);this.children.delete(child);if(settled)return;settled=true;if(code!==0){reject(new Error('网易云命令失败，请检查连接或重新授权'));return;}try{resolve(args[0]==='config'?{code:200}:JSON.parse(output));}catch{reject(new Error('网易云返回格式不兼容'));}});
    });
  }
  private call(args:string[], raw=false):Promise<unknown> {
    const operation=this.queue.then(async()=>{
      if(this.closed)throw new Error('网易云连接已关闭');
      // Injected transports are deterministic fixture runners; production requests always wait >=6s.
      if(!this.options.command){const wait=Math.max(6000,this.options.delayMs ?? 6000)-(Date.now()-this.lastFinished);if(wait>0)await new Promise(r=>setTimeout(r,wait));}
      try {
        const response=await (this.options.command ? this.options.command(args) : this.spawnCommand(args));
        const body=object(response);if(body.code!==undefined && body.code!==200)throw new Error('upstream');
        return raw?body:body.data;
      } catch {throw new Error('网易云请求失败，请检查配置、授权或稍后重试');} finally {this.lastFinished=Date.now();}
    });this.queue=operation.catch(()=>{});return operation;
  }
  private api(command:string[],params:string[]):Promise<unknown>{return this.call([...command,...params,'--userInput','同步已核验的新专辑精选','--output','json']);}
  async status():Promise<ConnectionStatus>{
    try {const body=object(await this.call(['login','--check','--output','json'],true));const data=object(body.data);const loggedIn=body.success===true||data.loggedIn===true||body.loggedIn===true||data.isLoggedIn===true;const configured=loggedIn||this.connection.configured||data.configured===true||body.configured===true;if(!loggedIn&&this.connection.loginState==='waiting')return {...this.connection};this.connection={configured,loggedIn,message:loggedIn?'网易云已连接':configured?'请扫码连接网易云':'请配置网易云开发者凭据',loginState:loggedIn?'authorized':'idle'};}
    catch {this.connection={...this.connection,loggedIn:false,message:'无法验证网易云连接，请检查配置或重新授权'};}return {...this.connection};
  }
  async configure(appId:string,privateKey:string):Promise<ConnectionStatus>{
    if(!appId.trim()||!privateKey.trim()||appId.length>256||privateKey.length>16384)throw new Error('请填写有效的开发者凭据');
    // Official CLI offers no documented stdin secret setter. Values are never logged or returned.
    await this.call(['config','set','appId',appId]);await this.call(['config','set','privateKey',privateKey]);
    this.connection={configured:true,loggedIn:false,message:'配置已保存，请扫码授权',loginState:'idle'};return {...this.connection};
  }
  async login():Promise<ConnectionStatus>{
    const generation=++this.generation;
    const body=object(await this.call(['login','--background','--output','json'],true));
    const data=object(body.data);const url=data.qrCodeUrl??body.qrCodeUrl;
    if(generation!==this.generation)return {...this.connection};
    if(typeof url!=='string'||!/^https:\/\//i.test(url))throw new Error('网易云未返回有效二维码，请重试');
    const qrCodeUrl=await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:2,width:256});if(generation!==this.generation)return {...this.connection};this.connection={configured:true,loggedIn:false,message:'使用网易云音乐 App 扫码授权',loginState:'waiting',qrCodeUrl};return {...this.connection};
  }
  async cancelLogin():Promise<ConnectionStatus>{this.generation++;await this.killChildren();this.connection={configured:this.connection.configured,loggedIn:false,message:'已关闭二维码；上游授权轮询可能仍在继续，请勿扫描旧二维码',loginState:'idle'};return {...this.connection};}
  private async killChildren():Promise<void>{for(const child of this.children){try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}}this.children.clear();}
  async match(album: Album, lookbackDays = 180): Promise<MatchedAlbum | null> {
    const data=object(await this.api(['search','album'],['--keyword',`${album.artist} ${album.title}`,'--limit','20','--offset','0']));
    const records=Array.isArray(data.records)?data.records:[];
    const title = normalized(album.title);
    const artist = normalized(album.artist);
    const candidates = records.map(object).flatMap((record) => {
      const { id, originalId, name, artists, publishTime } = record;
      if (
        typeof id !== 'string' || typeof originalId !== 'number' ||
        typeof name !== 'string' || normalized(name) !== title ||
        !Array.isArray(artists) || !artists.some((a) => normalized(String(object(a).name ?? '')) === artist) ||
        typeof publishTime !== 'number' || !Number.isFinite(new Date(publishTime + CHINA_OFFSET_MS).getTime())
      ) return [];
      return [{ id, originalId, name, day: chinaCatalogDay(publishTime) }];
    });

    let matches;
    if (album.releaseDate) {
      const sourceDay = Date.parse(`${album.releaseDate}T00:00:00Z`) / DAY_MS;
      const exact = candidates.filter((candidate) => candidate.day === sourceDay);
      matches = exact.length ? exact : candidates.filter((candidate) => Math.abs(candidate.day - sourceDay) <= 2);
    } else {
      const today = chinaCatalogDay(Date.now());
      matches = candidates.filter((candidate) => candidate.day <= today && candidate.day >= today - lookbackDays);
    }
    if (matches.length !== 1) return null;
    const found = matches[0]!;
    const releaseDate = new Date(found.day * DAY_MS).toISOString().slice(0, 10);
    const dataTracks=await this.api(['album','tracks'],['--albumId',String(found.id)]);
    if(!Array.isArray(dataTracks)||!dataTracks.length)return null;const tracks=dataTracks.map(track);
    if(new Set(tracks.map(t=>t.id)).size!==tracks.length)return null;
    return { id: found.id, originalId: found.originalId, name: found.name, artist: album.artist, releaseDate, tracks };
  }
  async tracks(id:string):Promise<Track[]>{const result:Track[]=[];for(let offset=0;offset<100000;offset+=500){const data=await this.api(['playlist','tracks'],['--playlistId',id,'--limit','500','--offset',String(offset)]);if(!Array.isArray(data))throw new Error('网易云歌单格式不兼容');result.push(...data.map(track));if(data.length<500)return result;}throw new Error('网易云歌单过大，停止同步以保护原内容');}
  async create(name:string):Promise<{id:string;originalId:number}>{const data=object(await this.api(['playlist','create'],['--playlistName',name]));if(typeof data.id!=='string'||typeof data.originalId!=='number')throw new Error('网易云未返回歌单编号');return {id:data.id,originalId:data.originalId};}
  async add(id:string,ids:string[]):Promise<void>{if(ids.length>100)throw new Error('每批最多添加100首曲目');if(ids.length)await this.api(['playlist','add'],['--playlistId',id,'--songIdList',JSON.stringify(ids)]);}
  async reorder(id:string,ids:string[]):Promise<void>{await this.api(['playlist','reorder'],['--playlistId',id,'--trackIds',JSON.stringify(ids)]);}
  async describe(id:string,desc:string):Promise<void>{await this.api(['playlist','updateDesc'],['--playlistId',id,'--desc',desc]);}
  async details(id:string):Promise<{name:string;describe:string;trackCount:number}>{const data=object(await this.api(['playlist','get'],['--playlistId',id]));if(typeof data.name!=='string'||typeof data.describe!=='string'||typeof data.trackCount!=='number')throw new Error('网易云歌单详情格式不兼容');return {name:data.name,describe:data.describe,trackCount:data.trackCount};}
  async sync(preview:SyncPreview,checkpoint:(p:Playlist)=>void|Promise<void>,progress:(s:string)=>void):Promise<Playlist|null>{return executePlan(preview,this,checkpoint,progress);}
  async close():Promise<void>{this.closed=true;this.generation++;await this.killChildren();}
}
