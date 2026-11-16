import { randomUUID, createHash } from 'node:crypto';
import type { Album, MatchedAlbum, Playlist, Run, RunMode, Settings, SourceStatus, SyncPreview } from '../shared/types.js';
import { decide } from './policy.js';
import { planSync } from './planner.js';
export interface RunnerStore {
 settings():Settings; albums():Album[];saveAlbums(albums:Album[]):void;playlists():Playlist[];savePlaylist(playlist:Playlist):void;runs():Run[];saveRun(run:Run):void;
 acquireLock(owner:string):boolean;releaseLock(owner:string):void;sourceStatuses():SourceStatus[];saveSourceStatuses(statuses:SourceStatus[]):void;
 getValue(key:string):string|null|undefined;setValue(key:string,value:string):void;
}
interface Sources {refresh(settings:Settings,existing:Album[],progress:(message:string)=>void,onStatus?:(status:SourceStatus)=>void):Promise<{albums:Album[];statuses:SourceStatus[]}>}
interface Target {match(album:Album):Promise<MatchedAlbum|null>;sync(preview:SyncPreview,checkpoint:(p:Playlist)=>void|Promise<void>,progress:(s:string)=>void):Promise<Playlist|null>}
interface SavedPreview {runId:string;createdAt:string;settingsHash:string;albumsHash:string;preview:SyncPreview;usable:boolean}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp=()=>new Date().toISOString();
function today(settings:Settings):string{const p=new Intl.DateTimeFormat('en-US',{timeZone:settings.schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts();return `${p.find(x=>x.type==='year')!.value}-${p.find(x=>x.type==='month')!.value}-${p.find(x=>x.type==='day')!.value}`;}
export class Runner {
 private pending:Promise<void>=Promise.resolve();
 constructor(private readonly store:RunnerStore,private readonly sources:Sources,private readonly netease:Target){}
 start(mode:RunMode):Run {
  const run:Run={id:randomUUID(),mode,status:'queued',stage:'queued',message:'任务已排队',startedAt:stamp(),logs:[]};
  if(!this.store.acquireLock(run.id))throw new Error('已有任务正在运行，请等待完成');
  try{this.store.saveRun(run);}catch(e){this.store.releaseLock(run.id);throw e;}
  this.pending=Promise.resolve().then(()=>this.execute(run));return structuredClone(run);
 }
 async wait():Promise<void>{await this.pending;}
 recoverInterrupted():void {for(const run of this.store.runs()){if(!['queued','running','waiting_verification'].includes(run.status))continue;run.status='failed';run.finishedAt=stamp();run.message='服务重启中断任务，未自动重放写入；请检查歌单后重试';run.logs.push({at:stamp(),level:'warning',message:run.message});this.store.saveRun(run);this.store.releaseLock(run.id);}}
 private log(run:Run,message:string,level:'info'|'warning'|'error'='info'):void{run.message=message;run.logs.push({at:stamp(),level,message});this.store.saveRun(run);}
 private async execute(run:Run):Promise<void>{let checkpointed=false,writeStarted=false;try{
   run.status='running';run.stage='starting';this.log(run,'任务开始');const settings=this.store.settings();
   const progress=(message:string)=>this.log(run,message);
   if(run.mode==='sync'){
    run.stage='validate';this.log(run,'校验最近预览、当前设置与曲目');
    let saved:SavedPreview|undefined;try{const raw=this.store.getValue('latest-preview');saved=raw?JSON.parse(raw) as SavedPreview:undefined;}catch{throw new Error('已保存预览格式无效，请重新生成预览');}
    if(!saved?.usable||!saved.preview||Date.now()-Date.parse(saved.createdAt)>30*60000||!Number.isFinite(Date.parse(saved.createdAt)))throw new Error('没有30分钟内的有效预览，请重新生成预览');
    const stored=this.store.albums();if(saved.settingsHash!==hash(settings)||saved.albumsHash!==hash(stored))throw new Error('设置或专辑记录已变化，请重新生成预览');
    const reevaluated=stored.map(a=>({...a,decision:decide(a,settings,today(settings))}));const preview=planSync(reevaluated,settings,this.store.playlists());
    if(hash(preview)!==hash(saved.preview))throw new Error('入选条件、月份或歌单已变化，请重新生成预览');
    const fresh=preview.albums.filter(a=>!a.admittedMonth&&!preview.existingPlaylist?.albumIds.includes(a.id));
    for(const album of fresh){if(album.sources.some(o=>settings.sources[o.source]&&o.status==='ok'&&(!Number.isFinite(Date.parse(o.observedAt))||Date.now()-Date.parse(o.observedAt)>=6*3600000)))throw new Error('来源评分已过期，请重新生成预览');if(album.decision?.status!=='selected'||!album.match?.tracks.length)throw new Error('预览含未通过核验的专辑');const match=await this.netease.match(album);if(!match||hash(match)!==hash(album.match))throw new Error('网易云专辑或曲目已变化，请重新生成预览');}
    run.preview=preview;
    if(!fresh.length){run.status='succeeded';run.stage='complete';this.log(run,'没有新的可同步专辑，未创建空歌单');return;}
    // Consumes a preview before the first write; a retry must create a new one from persisted checkpoints.
    this.store.setValue('latest-preview',JSON.stringify({...saved,usable:false}));run.stage='write';this.log(run,'开始同步已核验专辑');
    writeStarted=true;const playlist=await this.netease.sync(preview,p=>{checkpointed=true;this.store.savePlaylist(p);this.store.setValue('sync-checkpoint',JSON.stringify({runId:run.id,playlist:p,at:stamp()}));},progress);
    if(!playlist)throw new Error('同步未返回已校验歌单，不能确认完成');
    this.store.savePlaylist(playlist);const admitted=new Set(playlist.albumIds);this.store.saveAlbums(stored.map(a=>admitted.has(a.id)?{...a,admittedMonth:a.admittedMonth??playlist.month}:a));
    run.status='succeeded';run.stage='complete';this.log(run,'同步与歌单回读校验完成');
   }else{
    run.stage='sources';this.log(run,'获取来源与交叉评分');const result=await this.sources.refresh(settings,this.store.albums(),progress,status=>{this.store.saveSourceStatuses([...this.store.sourceStatuses().filter(s=>s.source!==status.source),status]);});this.store.saveSourceStatuses(result.statuses);
    const albums=result.albums.map(a=>({...a,decision:decide(a,settings,today(settings))}));this.store.saveAlbums(albums);
    const blocked=result.statuses.some(s=>s.status==='blocked');let incomplete=result.statuses.some(s=>['error','blocked'].includes(s.status));
    if(run.mode==='preview'){
     run.stage='matching';this.log(run,'逐张匹配网易云完整专辑');
     for(const album of albums.filter(a=>a.decision?.status==='selected'&&!a.admittedMonth)){
      try{album.match=await this.netease.match(album);if(!album.match){incomplete=true;this.log(run,`${album.artist} — ${album.title}：没有唯一完整匹配，暂不写入`,'warning');}}
      catch{album.match=null;incomplete=true;this.log(run,`${album.artist} — ${album.title}：网易云匹配失败`,'warning');}
     }
     this.store.saveAlbums(albums);const preview=planSync(albums,settings,this.store.playlists());run.preview=preview;
     this.store.setValue('latest-preview',JSON.stringify({runId:run.id,createdAt:stamp(),settingsHash:hash(settings),albumsHash:hash(albums),preview,usable:!incomplete} satisfies SavedPreview));
    }
    const hasUsable=albums.some(a=>a.decision?.status==='selected');run.status=blocked&&!hasUsable?'waiting_verification':incomplete?'partial':'succeeded';run.stage=run.status==='waiting_verification'?'verification':'complete';this.log(run,run.status==='succeeded'?'任务完成':run.status==='waiting_verification'?'来源需要人工验证，完成后请重试':'部分来源或匹配尚未完成，未进行网易云写入',incomplete?'warning':'info');
   }
  }catch(e){run.status=writeStarted?'partial':'failed';run.stage=writeStarted?'partial_write':'error';const raw=e instanceof Error?e.message:'任务失败';const safe=/token|cookie|private.?key|authorization|secret/i.test(raw)?'连接请求失败，请检查配置':raw.slice(0,300);this.log(run,checkpointed?`歌单已留下检查点，部分步骤未完成：${safe}`:writeStarted?`写入可能已发生，请核对现有歌单后重试：${safe}`:safe,'error');}
  finally{run.finishedAt=stamp();try{this.store.saveRun(run);}finally{this.store.releaseLock(run.id);}}
 }
}
