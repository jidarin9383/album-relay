import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { SourceName, VerificationStatus } from '../../shared/types.js';
import { origins } from './parsers.js';
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
 async read(url:string):Promise<{html:string;status:number}>{const context=await this.connect();this.page??=await context.newPage();const response=await this.page.goto(url,{timeout:25000,waitUntil:'domcontentloaded'});return {html:await this.page.content(),status:response?.status()??200};}
 async verification(source?:SourceName):Promise<VerificationStatus>{
  const url=process.env.BROWSER_UI_URL||process.env.BROWSER_CDP_URL?'/verification/vnc.html?autoconnect=true&resize=scale&path=verification%2Fwebsockify':undefined;
  try{if(source){this.source=source;await this.read(origins[source]);}return {available:!!url,active:!!this.page,source:this.source,url,message:url?'Complete any site verification in the private browser, then retry refresh. Challenges are never solved automatically.':'No remote browser UI configured. Set BROWSER_CDP_URL and BROWSER_UI_URL for interactive verification.'};}
  catch{return {available:false,active:false,source,message:'Browser unavailable. Install Playwright Chromium or configure the private browser sidecar.'};}
 }
 get connected():boolean{return !!this.context;}
 async close():Promise<void>{if(this.browser)await this.browser.close();else if(this.context)await this.context.close();this.context=undefined;this.browser=undefined;this.page=undefined;}
}
