import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Store } from './store.js';
export const AUTH_COOKIE_NAME = 'listen_better_session';
export const AUTH_COOKIE_OPTIONS = { httpOnly:true, sameSite:'strict', path:'/', maxAge:12*60*60 } as const;
const PASSWORD_KEY='admin_password';
const SESSION_MS=12*60*60*1000;
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export class AuthService {
  private readonly sessions=new Map<string,number>();
  constructor(private readonly store:Store) {}
  setupRequired():boolean{return this.store.getValue(PASSWORD_KEY)===null;}
  setup(password:string):string {
    if(!this.setupRequired())throw new Error('管理员已经设置');
    if(typeof password!=='string'||password.length<12||password.length>1024)throw new Error('密码须为12至1024个字符');
    const salt=randomBytes(32).toString('hex');
    const hash=scryptSync(password,salt,64).toString('hex');
    this.store.setValue(PASSWORD_KEY,`scrypt$${salt}$${hash}`);
    return this.issueSession();
  }
  login(password:string):string {
    const encoded=this.store.getValue(PASSWORD_KEY);
    if(!encoded || typeof password!=='string'||password.length>1024)throw new Error('密码错误或尚未设置管理员');
    const [algorithm,salt,hash,...extra]=encoded.split('$');
    if(algorithm!=='scrypt'||!salt||!/^[a-f0-9]{64}$/.test(salt)||!hash||!/^[a-f0-9]{128}$/.test(hash)||extra.length)throw new Error('管理员密码记录无效');
    const supplied=scryptSync(password,salt,64);
    if(!timingSafeEqual(supplied,Buffer.from(hash,'hex')))throw new Error('密码错误');
    return this.issueSession();
  }
  authenticate(token?:string):boolean {
    if(!token||token.length>256)return false;
    const key=digest(token);const expires=this.sessions.get(key);
    if(!expires)return false;
    if(expires<=Date.now()){this.sessions.delete(key);return false;}
    return true;
  }
  logout(token?:string):void{if(token&&token.length<=256)this.sessions.delete(digest(token));}
  private issueSession():string {
    const now=Date.now();for(const [key,expires] of this.sessions)if(expires<=now)this.sessions.delete(key);
    // Bound memory even if a local administrator repeatedly logs in without logging out.
    if(this.sessions.size>=1000){const oldest=this.sessions.keys().next().value;if(oldest)this.sessions.delete(oldest);}
    const token=randomBytes(32).toString('base64url');this.sessions.set(digest(token),now+SESSION_MS);return token;
  }
}
