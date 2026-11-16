import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, ExternalLink, LoaderCircle, Play, Search } from 'lucide-react';
import type { CaptureReceipt, SourceName, VerificationStatus } from '../shared/types';

interface Props {
 request<T>(path:string,body?:unknown,method?:string):Promise<T>;
 onCaptured():Promise<void>;
 onPreviewLibrary?:()=>void;
 runBusy?:boolean;
}
const label=(source:string)=>source==='rym'?'RYM':source==='aoty'?'AOTY':'Pitchfork';
const logo=(source:string)=>source==='pitchfork'?'Pf.':label(source);
const names:Record<SourceName,string>={rym:'Rate Your Music',aoty:'Album of the Year',pitchfork:'Pitchfork'};
const desc:Record<SourceName,string>={rym:'专辑榜 · 单张发行页',aoty:'LP 用户榜 · 专辑详情页',pitchfork:'最新乐评 · 单篇乐评页'};
const time=(at:string)=>new Date(at).toLocaleString('zh-CN');
export function CapturePanel({request,onCaptured,onPreviewLibrary,runBusy}:Props){
 const [history,setHistory]=useState<CaptureReceipt[]>([]);
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 const [browser,setBrowser]=useState<VerificationStatus|null>(null);
 const [latest,setLatest]=useState<CaptureReceipt|null>(null);
 const [query,setQuery]=useState('');
 useEffect(()=>{void request<CaptureReceipt[]>('/captures').then(setHistory).catch(()=>setError('收录历史暂时无法加载，请刷新后重试'));},[request]);
 async function act(source:SourceName,command:'chart'|'capture'|'search'){
  if(command==='search'&&!query.trim()){setError('请输入专辑或艺人名称');return;}
  setBusy(source+'-'+command);setError('');
  try{
   if(command==='chart'){const result=await request<VerificationStatus>(`/sources/${source}/chart`,{});setBrowser(result);if(!result.available)setError(result.message);}
   else if(command==='search'){const result=await request<VerificationStatus>(`/sources/${source}/search`,{query:query.trim()});setBrowser(result);if(!result.available)setError(result.message);}
   else{const result=await request<CaptureReceipt>(`/sources/${source}/capture`,{});setLatest(result);setHistory(await request<CaptureReceipt[]>('/captures'));await onCaptured();}
  }catch(e){setError(e instanceof Error?e.message:'收录失败，请重试');}finally{setBusy('');}
 }
 async function merge(captureId:string,url:string){
  setBusy('merge-'+url);setError('');
  try{
   const updated=await request<CaptureReceipt>(`/captures/${encodeURIComponent(captureId)}/merge`,{url});
   if(latest?.id===captureId)setLatest(updated);
   setHistory(await request<CaptureReceipt[]>('/captures'));
   await onCaptured();
  }catch(e){setError(e instanceof Error?e.message:'合并失败，请重试');}finally{setBusy('');}
 }
 return <section className="capture-panel panel" aria-labelledby="capture-heading">
  <div className="section-heading"><div><span className="eyebrow">BRING YOUR OWN DISCOVERY</span><h2 id="capture-heading">从你信赖的来源收录</h2></div><div className="capture-heading-side">{!latest&&history.length>0&&onPreviewLibrary&&<button className="button" disabled={!!busy||!!runBusy} onClick={onPreviewLibrary}><Play size={14}/>资料库预览</button>}<span className="pill">半自动收录</span></div></div>
  <p className="capture-lead">打开榜单或按名称搜索单张专辑，在独立浏览器中点开目标页面或完成验证后回来收录。只读取当前页面，不自动爬全站。</p>
  <form className="capture-search" onSubmit={e=>{e.preventDefault();if(query.trim())void act('aoty','search');}}>
   <label className="search"><Search size={16}/><input aria-label="按专辑或艺人名称查找" placeholder="输入专辑或艺人名称，在独立浏览器中搜索并打开详情页…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
   <div className="capture-search-actions">{(['rym','aoty','pitchfork'] as const).map(source=><button type="button" className="button" key={source} disabled={!!busy||!query.trim()} onClick={()=>void act(source,'search')}>{busy===source+'-search'?<LoaderCircle size={14} className="spin"/>:<Search size={14}/>}搜 {label(source)}</button>)}</div>
  </form>
  <div className="capture-sources">{(['rym','aoty','pitchfork'] as const).map(source=><div className="capture-source" key={source}>
   <div><span className={`source-logo ${source}`}>{logo(source)}</span><strong>{names[source]}</strong><small>{desc[source]}</small></div>
   <div className="capture-actions"><button className="button" disabled={!!busy} onClick={()=>void act(source,'chart')}>{busy===source+'-chart'?<LoaderCircle size={15} className="spin"/>:<ExternalLink size={15}/>}打开页面</button><button className="button primary" disabled={!!busy} onClick={()=>void act(source,'capture')}>{busy===source+'-capture'?<LoaderCircle size={15} className="spin"/>:<ArrowDownToLine size={15}/>}收录当前页面</button></div>
  </div>)}</div>
  {browser?.available&&<div className="capture-browser"><span>{browser.url?`${label(browser.source??'')} 页面已打开，先进入浏览器确认页面加载完成。`:`${label(browser.source??'')}：${browser.message}`}</span>{browser.url&&<a className="button" href={browser.url} target="_blank" rel="noreferrer">进入独立浏览器 <ExternalLink size={14}/></a>}</div>}
  {error&&<p className="inline-note" role="alert">{error}</p>}
  {latest&&<div className="capture-result" role="status"><strong>{label(latest.source)} 收录完成</strong><p>{latest.albums.length} 条评分证据 · 新增 {latest.added} 张 · 更新 {latest.updated} 张</p>{latest.warnings.length>0&&<details><summary>{latest.warnings.length} 条待核对提示</summary><ul>{latest.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}{latest.conflicts&&latest.conflicts.length>0&&<div className="capture-conflicts"><strong>待确认合并（{latest.conflicts.length}）</strong><ul>{latest.conflicts.map(c=>{const obs=c.sources[0];const url=obs?.url??'';return <li key={url}><span>{c.artist} — {c.title} · {c.releaseDate||'日期未知'} · {c.format}{obs?.score!=null?` · ${obs.score}/${obs.scale}`:''}</span><button className="button" disabled={!!busy} onClick={()=>void merge(latest.id,url)}><Check size={14}/>确认合并</button></li>;})}</ul></div>}<div className="capture-result-foot"><small>已保存到专辑资料库；没有写入网易云歌单。</small>{onPreviewLibrary&&<button className="button" disabled={!!busy||!!runBusy} onClick={onPreviewLibrary}><Play size={14}/>资料库预览</button>}</div></div>}
  <details className="capture-history"><summary>收录历史 <span>{history.length?`最近 ${history.length} 次`:'暂无收录'}</span></summary>
   {history.length?<ol>{history.map(item=><li key={item.id}><div><strong>{label(item.source)}</strong><time>{time(item.observedAt)}</time><a href={item.pageUrl} target="_blank" rel="noreferrer" aria-label="查看收录来源"><ExternalLink size={13}/></a></div><p>新增 {item.added} · 更新 {item.updated} · {item.albums.length} 条证据</p>{item.warnings.length>0&&<small>{item.warnings.length} 条待核对提示</small>}{item.conflicts&&item.conflicts.length>0&&<div className="capture-conflicts">{item.conflicts.map(c=>{const url=c.sources[0]?.url??'';return <div key={url}><span>{c.artist} — {c.title}（{c.releaseDate||'日期未知'}）</span><button className="text-button" disabled={!!busy} onClick={()=>void merge(item.id,url)}>确认合并</button></div>;})}</div>}</li>)}</ol>:<p>成功收录后，这里会保留来源、时间和处理结果。</p>}
  </details>
 </section>;
}
