import { useEffect, useState } from 'react';
import { ArrowDownToLine, ExternalLink, LoaderCircle, Play } from 'lucide-react';
import type { CaptureReceipt, VerificationStatus } from '../shared/types';

interface Props {
 request<T>(path:string,body?:unknown,method?:string):Promise<T>;
 onCaptured():Promise<void>;
 onPreviewLibrary?:()=>void;
 runBusy?:boolean;
}
const label=(source:string)=>source==='rym'?'RYM':'AOTY';
const time=(at:string)=>new Date(at).toLocaleString('zh-CN');
export function CapturePanel({request,onCaptured,onPreviewLibrary,runBusy}:Props){
 const [history,setHistory]=useState<CaptureReceipt[]>([]);
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 const [browser,setBrowser]=useState<VerificationStatus|null>(null);
 const [latest,setLatest]=useState<CaptureReceipt|null>(null);
 useEffect(()=>{void request<CaptureReceipt[]>('/captures').then(setHistory).catch(()=>setError('收录历史暂时无法加载，请刷新后重试'));},[request]);
 async function act(source:'rym'|'aoty',command:'chart'|'capture'){
  setBusy(source+'-'+command);setError('');
  try{
   if(command==='chart'){const result=await request<VerificationStatus>(`/sources/${source}/chart`,{});setBrowser(result);if(!result.available)setError(result.message);}
   else{const result=await request<CaptureReceipt>(`/sources/${source}/capture`,{});setLatest(result);setHistory(await request<CaptureReceipt[]>('/captures'));await onCaptured();}
  }catch(e){setError(e instanceof Error?e.message:'收录失败，请重试');}finally{setBusy('');}
 }
 return <section className="capture-panel panel" aria-labelledby="capture-heading">
  <div className="section-heading"><div><span className="eyebrow">BRING YOUR OWN DISCOVERY</span><h2 id="capture-heading">从你信赖的榜单收录</h2></div><div className="capture-heading-side">{!latest&&history.length>0&&onPreviewLibrary&&<button className="button" disabled={!!busy||!!runBusy} onClick={onPreviewLibrary}><Play size={14}/>资料库预览</button>}<span className="pill">半自动收录</span></div></div>
  <p className="capture-lead">打开榜单，在独立浏览器中完成加载或验证，再回来收录。只读取当前页面，不逐张请求详情。</p>
  <div className="capture-sources">{(['rym','aoty'] as const).map(source=><div className="capture-source" key={source}>
   <div><span className={`source-logo ${source}`}>{label(source)}</span><strong>{source==='rym'?'Rate Your Music':'Album of the Year'}</strong><small>本年度{source==='aoty'?' LP 用户评分':'专辑'}榜</small></div>
   <div className="capture-actions"><button className="button" disabled={!!busy} onClick={()=>void act(source,'chart')}>{busy===source+'-chart'?<LoaderCircle size={15} className="spin"/>:<ExternalLink size={15}/>}打开榜单</button><button className="button primary" disabled={!!busy} onClick={()=>void act(source,'capture')}>{busy===source+'-capture'?<LoaderCircle size={15} className="spin"/>:<ArrowDownToLine size={15}/>}收录当前榜单</button></div>
  </div>)}</div>
  {browser?.available&&<div className="capture-browser"><span>{browser.url?`${label(browser.source??'')} 榜单已打开，先进入浏览器确认页面加载完成。`:`${label(browser.source??'')}：${browser.message}`}</span>{browser.url&&<a className="button" href={browser.url} target="_blank" rel="noreferrer">进入独立浏览器 <ExternalLink size={14}/></a>}</div>}
  {error&&<p className="inline-note" role="alert">{error}</p>}
  {latest&&<div className="capture-result" role="status"><strong>{label(latest.source)} 收录完成</strong><p>{latest.albums.length} 条评分证据 · 新增 {latest.added} 张 · 更新 {latest.updated} 张</p>{latest.warnings.length>0&&<details><summary>{latest.warnings.length} 条待核对提示</summary><ul>{latest.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}<div className="capture-result-foot"><small>已保存到专辑资料库；没有写入网易云歌单。</small>{onPreviewLibrary&&<button className="button" disabled={!!busy||!!runBusy} onClick={onPreviewLibrary}><Play size={14}/>资料库预览</button>}</div></div>}
  <details className="capture-history"><summary>收录历史 <span>{history.length?`最近 ${history.length} 次`:'暂无收录'}</span></summary>
   {history.length?<ol>{history.map(item=><li key={item.id}><div><strong>{label(item.source)}</strong><time>{time(item.observedAt)}</time><a href={item.pageUrl} target="_blank" rel="noreferrer" aria-label="查看收录来源"><ExternalLink size={13}/></a></div><p>新增 {item.added} · 更新 {item.updated} · {item.albums.length} 条证据</p>{item.warnings.length>0&&<small>{item.warnings.length} 条待核对提示</small>}</li>)}</ol>:<p>成功收录后，这里会保留来源、时间和处理结果。</p>}
  </details>
 </section>;
}
