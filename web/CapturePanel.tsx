import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Play, Search } from 'lucide-react';
import type { CaptureReceipt, SourceName } from '../shared/types';

interface Props {
 request<T>(path:string,body?:unknown,method?:string):Promise<T>;
 onCaptured():Promise<void>;
 onPreviewLibrary?:()=>void;
 runBusy?:boolean;
}
const sourceList=['rym','aoty','pitchfork'] as const;
const label=(source:string)=>source==='rym'?'RYM':source==='aoty'?'AOTY':'Pitchfork';
const logo=(source:string)=>source==='pitchfork'?'Pf.':label(source);
const names:Record<SourceName,string>={rym:'Rate Your Music',aoty:'Album of the Year',pitchfork:'Pitchfork'};
const desc:Record<SourceName,string>={rym:'专辑榜 · 单张发行页',aoty:'LP 用户榜 · 专辑详情页',pitchfork:'最新乐评列表 · Best New · 单篇乐评'};
const time=(at:string)=>new Date(at).toLocaleString('zh-CN');
// Pages open in the user's own browser; the paired extension captures them once loaded.
const chartUrl=(source:SourceName,year=new Date().getFullYear())=>source==='rym'?`https://rateyourmusic.com/charts/top/album/${year}/1/`:source==='aoty'?`https://www.albumoftheyear.org/ratings/user-highest-rated/lp/${year}/`:'https://pitchfork.com/reviews/albums/';
const searchUrl=(source:SourceName,query:string)=>{const q=encodeURIComponent(query);return source==='aoty'?`https://www.albumoftheyear.org/search/?q=${q}`:source==='rym'?`https://rateyourmusic.com/search?searchterm=${q}&searchtype=l`:`https://pitchfork.com/search/?query=${q}`;};

export function CapturePanel({request,onCaptured,onPreviewLibrary,runBusy}:Props){
 const [history,setHistory]=useState<CaptureReceipt[]>([]);
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 const [query,setQuery]=useState('');
 const load=useCallback(()=>request<CaptureReceipt[]>('/captures').then(setHistory),[request]);
 useEffect(()=>{void load().catch(()=>setError('收录历史暂时无法加载，请刷新后重试'));const t=window.setInterval(()=>void load().catch(()=>{}),15000);return()=>window.clearInterval(t);},[load]);
 async function merge(captureId:string,url:string){
  setBusy('merge-'+url);setError('');
  try{await request<CaptureReceipt>(`/captures/${encodeURIComponent(captureId)}/merge`,{url});await load();await onCaptured();}
  catch(e){setError(e instanceof Error?e.message:'合并失败，请重试');}finally{setBusy('');}
 }
 const pending=history.reduce((n,item)=>n+(item.conflicts?.length??0),0);
 return <section className="capture-panel panel" aria-labelledby="capture-heading">
  <div className="section-heading"><div><span className="eyebrow">BRING YOUR OWN DISCOVERY</span><h2 id="capture-heading">从你信赖的来源收录</h2></div><div className="capture-heading-side">{history.length>0&&onPreviewLibrary&&<button className="button" disabled={!!busy||!!runBusy} onClick={onPreviewLibrary}><Play size={14}/>生成歌单预览</button>}<span className="pill">扩展自动收录</span></div></div>
  <p className="capture-lead">在你的 Chrome 中打开榜单、专辑页或乐评，浏览器扩展会在页面加载完成后自动收录，不需要回到这里点击。下面的按钮和搜索都在新标签页中打开。</p>
  <form className="capture-search" onSubmit={e=>{e.preventDefault();if(query.trim())window.open(searchUrl('rym',query.trim()),'_blank','noopener');}}>
   <label className="search"><Search size={16}/><input aria-label="按专辑或艺人名称查找" placeholder="输入专辑或艺人名称，在新标签页中搜索，再点开专辑详情页…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
   <div className="capture-search-actions">{sourceList.map(source=><a key={source} className={`button ${query.trim()?'':'is-disabled'}`} aria-disabled={!query.trim()} href={query.trim()?searchUrl(source,query.trim()):undefined} target="_blank" rel="noreferrer"><Search size={14}/>搜 {label(source)}</a>)}</div>
  </form>
  <div className="capture-sources">{sourceList.map(source=><div className="capture-source" key={source}>
   <div><span className={`source-logo ${source}`}>{logo(source)}</span><strong>{names[source]}</strong><small>{desc[source]}</small></div>
   <div className="capture-actions"><a className="button" href={chartUrl(source)} target="_blank" rel="noreferrer"><ExternalLink size={15}/>{source==='pitchfork'?'打开最新乐评':'打开今年榜单'}</a>{source==='pitchfork'&&<a className="button" href="https://pitchfork.com/reviews/best/albums/" target="_blank" rel="noreferrer"><ExternalLink size={15}/>Best New</a>}</div>
  </div>)}</div>
  {error&&<p className="inline-note" role="alert">{error}</p>}
  <details className="capture-history" open={pending>0}><summary>收录历史 <span>{history.length?`最近 ${history.length} 次${pending?` · ${pending} 条待确认合并`:''}`:'暂无收录'}</span></summary>
   {history.length?<ol>{history.map(item=><li key={item.id}><div><strong>{label(item.source)}</strong><time>{time(item.observedAt)}</time><a href={item.pageUrl} target="_blank" rel="noreferrer" aria-label="查看收录来源"><ExternalLink size={13}/></a></div><p>新增 {item.added} · 更新 {item.updated} · {item.albums.length} 条证据</p>{item.warnings.length>0&&<small>{item.warnings.length} 条待核对提示</small>}{item.conflicts&&item.conflicts.length>0&&<div className="capture-conflicts">{item.conflicts.map(c=>{const url=c.sources[0]?.url??'';return <div key={url}><span>{c.artist} — {c.title}（{c.releaseDate||'日期未知'}）</span><button className="text-button" disabled={!!busy} onClick={()=>void merge(item.id,url)}>确认合并</button></div>;})}</div>}</li>)}</ol>:<p>扩展收录后，这里会保留来源、时间和处理结果。</p>}
  </details>
 </section>;
}
