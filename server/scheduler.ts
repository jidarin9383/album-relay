import { Cron } from 'croner';
import type { Run, RunMode, Settings } from '../shared/types.js';
interface ScheduleStore {settings():Settings;runs():Run[]}
interface ScheduleRunner {start(mode:RunMode):Run;wait():Promise<void>;recoverInterrupted():void}
export class Scheduler {
 private cron?:Cron;private active=false;
 constructor(private readonly store:ScheduleStore,private readonly runner:ScheduleRunner){runner.recoverInterrupted();this.configure();}
 configure():void{this.stop();const s=this.store.settings().schedule;if(!s.enabled)return;this.cron=new Cron(`${s.minute} ${s.hour} * * ${s.weekday}`,{timezone:s.timezone,protect:true},async()=>{await this.tick();});}
 nextRun():string|null{return this.cron?.nextRun()?.toISOString()??null;}
 stop():void{this.cron?.stop();this.cron=undefined;}
 /** Scheduled authorization permits sync only after this occurrence's complete successful preview. */
 async tick():Promise<void>{if(this.active)return;this.active=true;try{const initial=this.runner.start('preview');await this.runner.wait();const result=this.store.runs().find(r=>r.id===initial.id);if(result?.status!=='succeeded'||!result.preview?.albums.some(a=>!a.admittedMonth&&a.decision?.status==='selected'&&a.match?.tracks.length))return;this.runner.start('sync');await this.runner.wait();}catch{/* Lock conflicts are owned by the active job. Never replay or claim this occurrence succeeded. */}finally{this.active=false;}}
}
