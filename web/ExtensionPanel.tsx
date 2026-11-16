import { Fragment, useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Puzzle, Unplug } from 'lucide-react';
import type { ExtensionState, SourceName } from '../shared/types';

interface Props { request<T>(path:string,body?:unknown,method?:string):Promise<T>; onChanged():Promise<void> }
const label:Record<SourceName,string>={rym:'RYM',aoty:'AOTY',pitchfork:'Pitchfork'};
const stateLabel={ok:'正常',challenge:'需要验证',error:'失败'} as const;
const time=(at?:string)=>at?new Date(at).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'从未';
const ONLINE_MS=65*60*1000; // extension checks in every 30 minutes

export function ExtensionPanel({request,onChanged}:Props){
 const [state,setState]=useState<ExtensionState|null>(null);
 const [token,setToken]=useState('');
 const [copied,setCopied]=useState('');
 const [draft,setDraft]=useState<{enabled:boolean;hour:number;targets:string}|null>(null);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const load=useCallback(async()=>{const s=await request<ExtensionState>('/extension');setState(s);setDraft(d=>d??{enabled:s.refresh.enabled,hour:s.refresh.hour,targets:s.refresh.targets.join('\n')});},[request]);
 useEffect(()=>{void load().catch(()=>setError('扩展状态暂时无法加载'));const t=window.setInterval(()=>void load().catch(()=>{}),15000);return()=>window.clearInterval(t);},[load]);
 async function act(key:string,fn:()=>Promise<void>){setBusy(key);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy('');}}
 async function copy(key:string,value:string){try{await navigator.clipboard.writeText(value);setCopied(key);window.setTimeout(()=>setCopied(''),1500);}catch{setError('无法写入剪贴板，请手动选中复制');}}
 const online=state?.lastSeen&&Date.now()-new Date(state.lastSeen).getTime()<ONLINE_MS;
 const challenges=state?.reports.filter(r=>r.state==='challenge')??[];
 return <section className="capture-panel panel" aria-labelledby="extension-heading">
  <div className="section-heading"><div><span className="eyebrow">YOUR OWN BROWSER</span><h2 id="extension-heading">浏览器扩展</h2></div><span className={`pill ${online?'green':''}`}>{!state?'…':!state.paired?'未配对':online?'在线':'离线'}</span></div>
  <p className="capture-lead">在你平时用的 Chrome 里打开 RYM / AOTY 榜单、专辑页或 Pitchfork 乐评，扩展会自动把页面送进资料库，不用再点「收录」。遇到站点验证时由你亲自完成，扩展不会代点。</p>
  {challenges.map(r=><div className="inline-note" role="alert" key={r.source}><strong>{label[r.source]} 需要验证：</strong>请在 Chrome 中打开 <a href={r.url} target="_blank" rel="noreferrer">这个页面</a> 手动完成一次，之后会自动继续。（{time(r.at)}）</div>)}
  {state?.paired&&<dl className="extension-facts"><dt>最后在线</dt><dd>{time(state.lastSeen)}{state.version?` · v${state.version}`:''}</dd>{state.reports.map(r=><Fragment key={r.source}><dt>{label[r.source]}</dt><dd>{stateLabel[r.state]} · {r.message} · {time(r.at)}</dd></Fragment>)}</dl>}
  <div className="extension-pairing">
   <div><strong>{state?.paired?'重新配对':'配对扩展'}</strong><small>生成令牌后填到扩展设置页。重新生成会让旧令牌立即失效。</small></div>
   <div className="capture-actions">
    <button className="button primary" disabled={!!busy} onClick={()=>void act('token',async()=>{const r=await request<{token:string}>('/extension/token',{});setToken(r.token);await load();})}>{busy==='token'?<LoaderCircle size={15} className="spin"/>:<KeyRound size={15}/>}{state?.paired?'重新生成令牌':'生成配对令牌'}</button>
    {state?.paired&&<button className="button" disabled={!!busy} onClick={()=>void act('revoke',async()=>{setToken('');setState(await request<ExtensionState>('/extension/token',undefined,'DELETE'));})}><Unplug size={15}/>解除配对</button>}
   </div>
  </div>
  {token&&<div className="capture-result" role="status">
   <strong>令牌只显示这一次</strong>
   <p>在扩展设置页填写下面两项，然后点「保存并测试连接」。</p>
   <label className="field"><span>Album Relay 地址</span><div className="copy-row"><input readOnly value={location.origin} onFocus={e=>e.currentTarget.select()}/><button type="button" className="button" onClick={()=>void copy('origin',location.origin)}>{copied==='origin'?<Check size={14}/>:<Copy size={14}/>}复制</button></div></label>
   <label className="field"><span>配对令牌</span><div className="copy-row"><input readOnly value={token} onFocus={e=>e.currentTarget.select()}/><button type="button" className="button" onClick={()=>void copy('token',token)}>{copied==='token'?<Check size={14}/>:<Copy size={14}/>}复制</button></div></label>
  </div>}
  {draft&&<form className="extension-refresh" onSubmit={e=>{e.preventDefault();void act('refresh',async()=>{const targets=draft.targets.split('\n').map(t=>t.trim()).filter(Boolean);const s=await request<ExtensionState>('/extension/refresh',{enabled:draft.enabled,hour:draft.hour,targets},'PUT');setState(s);setNotice('定时刷新设置已保存，扩展会在 30 分钟内读取。');await onChanged();});}}>
   <label className="check-label schedule-check"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/><strong>每天自动刷新榜单</strong><span className="muted">由你的 Chrome 在后台标签页打开下列页面，每页间隔 30–75 秒；遇到验证立即停下等你处理。</span></label>
   <div className="field-grid two">
    <label className="field"><span>每天几点之后</span><input type="number" min={0} max={23} required value={draft.hour} onChange={e=>setDraft({...draft,hour:Number(e.target.value)})}/><small>按这台 Mac 的本地时间；Chrome 需开着。</small></label>
    <label className="field"><span>刷新页面（每行一个，最多 6 个）</span><textarea rows={4} value={draft.targets} onChange={e=>setDraft({...draft,targets:e.target.value})}/><small>{'{year}'} 会自动替换为当年。仅支持 RYM/AOTY 榜单、专辑页和 Pitchfork 单篇乐评。</small></label>
   </div>
   <p className="muted">注意：AOTY 的使用条款限制自动采集。定时刷新默认关闭，开启前请自行评估。</p>
   <button className="button" disabled={!!busy}>{busy==='refresh'?<LoaderCircle size={15} className="spin"/>:<Puzzle size={15}/>}保存定时刷新</button>
  </form>}
  {error&&<p className="inline-note" role="alert">{error}</p>}
  {notice&&<p className="inline-note" role="status">{notice}</p>}
 </section>;
}
