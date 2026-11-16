import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService, AUTH_COOKIE_OPTIONS } from '../server/auth.js';
import { Store } from '../server/store.js';
const dirs:string[]=[];const stores:Store[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'album-auth-test-'));dirs.push(dir);const store=new Store(dir);stores.push(store);return {dir,store,auth:new AuthService(store)};}
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('requires initial setup, enforces minimum length and never persists plaintext',()=>{const {store,auth}=fixture();expect(auth.setupRequired()).toBe(true);expect(()=>auth.setup('short')).toThrow(/12/);const token=auth.setup('test-password-123');expect(auth.setupRequired()).toBe(false);expect(auth.authenticate(token)).toBe(true);expect(store.getValue('admin_password')).not.toContain('test-password-123');expect(()=>auth.setup('replacement-password')).toThrow();expect(AUTH_COOKIE_OPTIONS).toMatchObject({httpOnly:true,sameSite:'strict'});});
it('rejects wrong passwords and missing, forged or logged-out sessions',()=>{const {auth}=fixture();auth.setup('test-password-123');expect(()=>auth.login('incorrect-password')).toThrow(/密码/);expect(auth.authenticate()).toBe(false);expect(auth.authenticate('forged')).toBe(false);const token=auth.login('test-password-123');expect(auth.authenticate(token)).toBe(true);auth.logout(token);expect(auth.authenticate(token)).toBe(false);auth.logout();});
it('retains password across restart but invalidates old in-memory sessions',()=>{const {auth,store,dir}=fixture();const old=auth.setup('test-password-123');store.close();stores.splice(stores.indexOf(store),1);const reopened=new Store(dir);stores.push(reopened);const restarted=new AuthService(reopened);expect(restarted.setupRequired()).toBe(false);expect(restarted.authenticate(old)).toBe(false);expect(restarted.authenticate(restarted.login('test-password-123'))).toBe(true);});
it('generates independent salts and independent unpredictable session tokens',()=>{const a=fixture(),b=fixture();const first=a.auth.setup('same-password-123');const second=a.auth.login('same-password-123');b.auth.setup('same-password-123');expect(first).not.toBe(second);expect(first.length).toBeGreaterThanOrEqual(40);expect(a.store.getValue('admin_password')).not.toBe(b.store.getValue('admin_password'));});

it('expires sessions after twelve hours',()=>{const {auth}=fixture();const token=auth.setup('test-password-123');const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+12*60*60*1000+1);try{expect(auth.authenticate(token)).toBe(false);}finally{clock.mockRestore();}});
