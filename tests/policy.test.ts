import { describe,it,expect } from 'vitest';
import { decide, defaultSettings, albumId } from '../server/policy.js';
import type { Album, Observation } from '../shared/types.js';
const obs=(source:Observation['source'],score:number,votes:number|null=500):Observation=>({source,score,votes,scale:source==='rym'?5:source==='aoty'?100:10,url:'https://example.com',observedAt:'2026-11-16T00:00:00Z',status:'ok'});
const album=(sources:Observation[]):Album=>({id:'a',artist:'Artist',title:'Album',releaseDate:'2026-10-30',format:'LP',genres:[],excluded:false,sources});
describe('cross-source decisions',()=>{
 it('requires corroboration rather than a single enthusiastic reviewer',()=>{expect(decide(album([obs('pitchfork',9)]),defaultSettings,'2026-11-16').status).toBe('pending');});
 it('admits two qualifying communities and holds a known third-site disagreement',()=>{const a=album([obs('aoty',84),obs('rym',3.8)]);expect(decide(a,defaultSettings,'2026-11-16').status).toBe('selected');a.sources.push(obs('pitchfork',6.9));expect(decide(a,defaultSettings,'2026-11-16').status).toBe('disagreement');});
 it('does not treat inaccessible scores as positive or negative',()=>{const o=obs('rym',4);o.status='blocked';expect(decide(album([obs('aoty',85),o]),defaultSettings,'2026-11-16').status).toBe('pending');});
 it('respects vote minimum, release age and persistent exclusion',()=>{const a=album([obs('aoty',88,57),obs('rym',4)]);expect(decide(a,defaultSettings,'2026-11-16').status).toBe('pending');a.sources[0]!.votes=100;a.releaseDate='2026-11-15';expect(decide(a,defaultSettings,'2026-11-16').status).toBe('too_new');a.excluded=true;expect(decide(a,defaultSettings,'2026-11-16').status).toBe('excluded');});
 it('uses unique source votes, not duplicated observations',()=>{expect(decide(album([obs('aoty',90),obs('aoty',89)]),defaultSettings,'2026-11-16').status).toBe('pending');});
 it('keeps unicode identities stable across normalization',()=>{expect(albumId('Olēka','Human Error')).toBe(albumId('oleka','human error'));});
});
