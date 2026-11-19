import { expect, it, vi } from 'vitest';
import { NeteaseClient } from '../server/netease.js';
import type { Album } from '../shared/types.js';
const record={id:'encrypted',originalId:12,name:'Moon',artists:[{name:'Artist'}],publishTime:Date.parse('2026-11-01T00:00:00Z')};
const album={title:'Moon',artist:'Artist',releaseDate:'2026-11-01'} as Album;
it('rejects ambiguous matching albums before retrieving tracks',async()=>{const command=vi.fn(async()=>({code:200,data:{records:[record,{...record,id:'other'}]}}));const c=new NeteaseClient('/tmp/unused',{command});expect(await c.match(album)).toBeNull();expect(command).toHaveBeenCalledTimes(1);});
it('whitelists matching track fields and does not reject native playback flags',async()=>{const command=vi.fn().mockResolvedValueOnce({code:200,data:{records:[record]}}).mockResolvedValueOnce({code:200,data:[{id:'song',originalId:3,name:'Song',visible:false,playFlag:false,secret:'no'}]});const c=new NeteaseClient('/tmp/unused',{command});expect(await c.match(album)).toMatchObject({id:'encrypted',tracks:[{id:'song',originalId:3,name:'Song'}]});expect((await Promise.resolve(command.mock.results[1]?.value))?.secret).toBeUndefined();});
it('sanitizes upstream errors, including secrets in rejected command text',async()=>{const c=new NeteaseClient('/tmp/unused',{command:async()=>{throw new Error('private-secret');}});await expect(c.tracks('p')).rejects.toThrow('网易云');await expect(c.tracks('p')).rejects.not.toThrow('private-secret');});
it('never treats malformed or unverified login output as authorized',async()=>{const c=new NeteaseClient('/tmp/unused',{command:async()=>({code:200,data:{}})});expect((await c.status()).loggedIn).toBe(false);});

it('recognizes the verified official login check success flag without exposing the account message',async()=>{const c=new NeteaseClient('/tmp/unused',{command:async()=>({success:true,message:'private-account-identity'})});const result=await c.status();expect(result.loggedIn).toBe(true);expect(result.configured).toBe(true);expect(result.message).not.toContain('private-account-identity');});
it('treats official login check failure as unauthenticated',async()=>{const c=new NeteaseClient('/tmp/unused',{command:async()=>({success:false,message:'private-upstream-error'})});expect((await c.status()).loggedIn).toBe(false);});
it('keeps the QR visible while authorization is still pending',async()=>{const command=vi.fn().mockResolvedValueOnce({data:{qrCodeUrl:'https://example.test/qr.png'}}).mockResolvedValueOnce({success:false});const c=new NeteaseClient('/tmp/unused',{command});const initial=await c.login();expect(await c.status()).toMatchObject({configured:true,loggedIn:false,loginState:'waiting',qrCodeUrl:initial.qrCodeUrl});});
it('renders the official authorization link as a local QR image',async()=>{const command=vi.fn().mockResolvedValueOnce({qrCodeUrl:'https://example.test/authorize'});const c=new NeteaseClient('/tmp/unused',{command});const s=await c.login();expect(s.qrCodeUrl).toMatch(/^data:image\/png;base64,/);expect(s.qrCodeUrl).not.toContain('example.test');});

function catalogClient(records: unknown[]) {
  const command = vi.fn()
    .mockResolvedValueOnce({ code: 200, data: { records } })
    .mockResolvedValueOnce({ code: 200, data: [{ id: 'song', originalId: 3, name: 'Song' }] });
  return { client: new NeteaseClient('/tmp/unused', { command }), command };
}

it('prefers the exact China catalog date over a nearby edition', async () => {
  const near = { ...record, id: 'near', publishTime: Date.parse('2026-11-02T00:00:00Z') };
  const exact = { ...record, publishTime: Date.parse('2026-10-31T17:00:00Z') };
  const { client } = catalogClient([near, exact]);
  expect(await client.match(album)).toMatchObject({ id: 'encrypted', releaseDate: '2026-11-01' });
});

it('accepts a unique same-artist/title edition within two days and ignores invalid timestamps', async () => {
  const near = { ...record, publishTime: Date.parse('2026-10-30T00:00:00Z') };
  const { client } = catalogClient([
    near, { ...near, id: 'wrong-artist', artists: [{ name: 'Different' }] },
    { ...record, id: 'invalid', publishTime: Infinity }
  ]);
  expect(await client.match(album)).toMatchObject({ id: 'encrypted', releaseDate: '2026-10-30' });
});

it('rejects two nearby editions, even when one is closer', async () => {
  const { client, command } = catalogClient([
    { ...record, publishTime: Date.parse('2026-11-02T00:00:00Z') },
    { ...record, id: 'another', publishTime: Date.parse('2026-11-03T00:00:00Z') }
  ]);
  expect(await client.match(album)).toBeNull();
  expect(command).toHaveBeenCalledTimes(1);
});

it('requires a unique recent edition for an undated release and honors a configured lookback', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  try {
    const undated = { ...album, releaseDate: '' };
    const old = { ...record, id: 'archive', publishTime: Date.parse('1999-11-01T00:00:00Z') };
    const future = { ...record, id: 'future', publishTime: Date.parse('2026-11-21T00:00:00Z') };
    expect(await catalogClient([old, future, record]).client.match(undated))
      .toMatchObject({ id: 'encrypted', releaseDate: '2026-11-01' });
    expect(await catalogClient([record]).client.match(undated, 10)).toBeNull();
    expect(await catalogClient([record, { ...record, id: 'duplicate' }]).client.match(undated)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
