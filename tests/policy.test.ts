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
 it('treats uncorroborated Pitchfork reviews with unknown date and format as pending, not format_conflict',()=>{
  const pf:Album={id:'pf',artist:'Artist',title:'New LP',releaseDate:'',format:'Unknown',genres:[],excluded:false,sources:[obs('pitchfork',8.3,null)]};
  const d=decide(pf,defaultSettings,'2026-11-16');
  expect(d.status).toBe('pending');
  expect(d.reasons[0]).toContain('待印证');
 });
 it('rejects EP and Reissue formats as format_conflict and blocks unknown format when minSources=1',()=>{
  const ep:Album={...album([obs('aoty',85),obs('rym',3.9)]),format:'EP'};
  const reissue:Album={...album([obs('aoty',85),obs('rym',3.9)]),format:'Reissue'};
  expect(decide(ep,defaultSettings,'2026-11-16').status).toBe('format_conflict');
  expect(decide(reissue,defaultSettings,'2026-11-16').status).toBe('format_conflict');
  const unknownDated:Album={...album([obs('pitchfork',8.5,null)]),format:'Unknown'};
  expect(decide(unknownDated,{...defaultSettings,minSources:1},'2026-11-16').status).toBe('format_conflict');
 });
});
