import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { SourceName, VerificationStatus } from '../../shared/types.js';
import { origins } from './parsers.js';
import { CaptureError } from './charts.js';
export interface BrowserReader {
 readonly connected:boolean;
 read(url:string):Promise<{html:string;status:number}>;
 current():Promise<{html:string;url:string}>;
 verification(source?:SourceName,targetUrl?:string):Promise<VerificationStatus>;
 close():Promise<void>;
}
/** Service-owned profile only; never accesses desktop browser profiles or solves challenges. */
export class SourceBrowser {
 private browser?:Browser; private context?:BrowserContext; private page?:Page; private source?:SourceName;
 constructor(private readonly dataDir:string){}
 private async connect():Promise<BrowserContext>{
  if(this.context)return this.context;
  if(process.env.BROWSER_CDP_URL){const endpoint=new URL(process.env.BROWSER_CDP_URL);if(endpoint.hostname!=='localhost'&&!isIP(endpoint.hostname)){endpoint.hostname=(await lookup(endpoint.hostname,{family:4})).address;}this.browser=await chromium.connectOverCDP(endpoint.toString(),{timeout:15000});this.context=this.browser.contexts()[0]??await this.browser.newContext();}
  else {await mkdir(join(this.dataDir,'browser'),{recursive:true,mode:0o700});this.context=await chromium.launchPersistentContext(join(this.dataDir,'browser'),{headless:process.env.BROWSER_HEADLESS!=='false',timeout:15000});}
  return this.context;
 }
 async read(url:string):Promise<{html:string;status:number}>{const context=await this.connect();if(!this.page||this.page.isClosed())this.page=context.pages().find(p=>!p.isClosed())??await context.newPage();const response=await this.page.goto(url,{timeout:25000,waitUntil:'domcontentloaded'});return {html:await this.page.content(),status:response?.status()??200};}
 async current():Promise<{html:string;url:string}>{
  if((!this.page||this.page.isClosed())&&this.context)this.page=this.context.pages().find(p=>!p.isClosed());
  if(!this.page||this.page.isClosed())throw new CaptureError('请先打开来源榜单，在独立浏览器中完成加载');
  const url=this.page.url(),html=await this.page.content();
  if(url!==this.page.url())throw new CaptureError('页面正在切换，请等待加载完成后再收录');
  return {url,html};
 }
 async verification(source?:SourceName,targetUrl?:string):Promise<VerificationStatus>{
  const url=process.env.BROWSER_UI_URL?'/verification/vnc.html?autoconnect=true&resize=scale&path=verification%2Fwebsockify':undefined;
  const interactive=Boolean(url||process.env.BROWSER_CDP_URL||process.env.BROWSER_HEADLESS==='false');
  try{if(source){this.source=source;const target=targetUrl??origins[source];if(new URL(target).origin!==origins[source])throw new Error('Unsupported source origin');await this.read(target);await this.page?.bringToFront().catch(()=>{});}return {available:interactive,active:!!this.page,source:this.source,url,message:url?'在独立浏览器中完成加载或验证，再回到应用收录当前榜单。':interactive?'已在浏览器打开榜单，请完成加载或验证后再回到应用收录。':'未配置独立浏览器窗口，请配置浏览器服务后重试。'};}
  catch{return {available:false,active:false,source,message:'Browser unavailable. Install Playwright Chromium or configure the private browser sidecar.'};}
 }
 get connected():boolean{return !!this.context;}
 async close():Promise<void>{if(this.browser)await this.browser.close();else if(this.context)await this.context.close();this.context=undefined;this.browser=undefined;this.page=undefined;}
}
