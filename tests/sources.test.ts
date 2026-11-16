import { describe, expect, it } from 'vitest';
import { parseAoty, parseRym, parsePitchfork, parseIndex, parseVotes, normalizeIdentity, isChallenge } from '../server/sources/parsers.js';
describe('source extraction (sanitized structural fixtures)', () => {
 it('reads current AOTY user vote counts without borrowing critic review counts', () => {
 const a = parseAoty('<div class="artist">Example Artist</div><div class="albumTitle">Example Album</div><div class="albumCriticScoreBox"><div class="albumCriticScore">88</div><div class="text numReviews">Based on <strong>13</strong> reviews</div></div><div class="albumUserScoreBox"><div class="albumUserScore"><a title="84.6">85</a></div><div class="text numReviews">Based on <a><strong>4,942</strong>&nbsp;ratings</a></div></div>', 'https://www.albumoftheyear.org/album/1-example.php');
 expect(a?.sources[0]).toMatchObject({score:85,scale:100,votes:4942});
 });
 it('keeps AOTY community score separate from critics and parses real release date', () => {
 const a = parseAoty('<div class="artist"><a>The Artist</a></div><div class="albumTitle">The Album</div><div class="albumCriticScore">96</div><div class="albumUserScore">82</div><div class="userScoreBox">Based on 1,230 ratings</div><div class="detailRow">October 30, 2026 / release date</div><div class="detailRow">LP / format</div>', 'https://www.albumoftheyear.org/album/1-a.php');
 expect(a).toMatchObject({artist:'The Artist',title:'The Album',releaseDate:'2026-10-30',format:'LP'}); expect(a?.sources[0]).toMatchObject({score:82,votes:1230,scale:100});
 });
 it('does not invent missing community scores or dates', () => { const a=parseAoty('<div class="artist">A</div><div class="albumTitle">B</div><div class="albumCriticScore">90</div>', 'https://www.albumoftheyear.org/album/1.php'); expect(a?.releaseDate).toBe(''); expect(a?.sources[0]?.score).toBeNull(); });
 it('parses RYM abbreviated votes retaining display text', () => {
 const a=parseRym('<h1 class="album_title">Moon</h1><span class="album_artist"><a>Stars</a></span><span itemprop="ratingValue">3.75</span><span itemprop="ratingCount">1.2k</span><table><tr><th>Released</th><td>4 September 2026</td></tr><tr><th>Type</th><td>Album</td></tr></table>', 'https://rateyourmusic.com/release/album/stars/moon/');
 expect(a).toMatchObject({artist:'Stars',title:'Moon',releaseDate:'2026-09-04',format:'LP'}); expect(a?.sources[0]).toMatchObject({score:3.75,votes:1200,votesDisplay:'1.2k'}); expect(parseVotes('12,345 ratings')).toBe(12345);
 });
 it('reads editorial state and never treats review publication date as release date', () => {
 const state={transformed:{review:{headerProps:{artists:[{name:'Artist'}],title:'Album',musicRating:{rating:8.4,bestNewMusic:true,bestNewReissue:false}},datePublished:'2026-11-13'}}};
 const a=parsePitchfork(`<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script>`, 'https://pitchfork.com/reviews/albums/artist-album/');
 expect(a).toMatchObject({artist:'Artist',title:'Album',releaseDate:'',format:'Unknown'}); expect(a?.sources[0]).toMatchObject({score:8.4,bestNewMusic:true});
 });
 it('excludes best new reissues from BNM',()=>{const a=parsePitchfork('<script>window.__PRELOADED_STATE__={"transformed":{"review":{"headerProps":{"artists":[{"name":"A"}],"title":"B","musicRating":{"rating":9,"bestNewMusic":true,"bestNewReissue":true}}}}};</script>','https://pitchfork.com/reviews/albums/a-b/');expect(a?.format).toBe('Reissue');expect(a?.sources[0]?.bestNewMusic).toBe(false);});
 it('extracts bounded source-specific links and detects challenges',()=>{expect(parseIndex('<a href="/album/1-test.php">A</a><a href="/album/1-test.php">A</a><a href="https://evil.test/album/2.php">B</a>','aoty')).toEqual(['https://www.albumoftheyear.org/album/1-test.php']);expect(isChallenge('Just a moment... Checking your browser',200)).toBe(true);expect(isChallenge('normal',403)).toBe(true);});
 it('normalizes Unicode punctuation without conflating editions',()=>{expect(normalizeIdentity('Beyoncé — Moon')).toBe(normalizeIdentity('Beyonce Moon'));expect(normalizeIdentity('Moon Deluxe')).not.toBe(normalizeIdentity('Moon'));});
});

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { SourceService } from '../server/sources/index.js';
import type { Settings, Album } from '../shared/types.js';
it('parses the real current Pitchfork metadata shape, keeping review and release dates distinct',async()=>{const a=parsePitchfork(await readFile(new URL('./fixtures/source-pitchfork.html',import.meta.url),'utf8'),'https://pitchfork.com/reviews/albums/aesop-rock-blockhead-trouble-mountain/');expect(a).toMatchObject({artist:'Aesop Rock & Blockhead',title:'Trouble Mountain',releaseDate:''});expect(a?.sources[0]).toMatchObject({score:7.1,bestNewMusic:false});});
it('stops a blocked site chain, preserving previous observation dates and values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'album-sources-'));const fetchMock=vi.fn().mockResolvedValue(new Response('Verification required',{status:403}));vi.stubGlobal('fetch',fetchMock);
 const settings={sources:{aoty:true,rym:false,pitchfork:false},lookbackDays:90,requestDelayMs:0} as Settings;
 const old:Album={id:'old',artist:'A',title:'B',releaseDate:'2026-10-01',format:'LP',genres:[],excluded:false,sources:[{source:'aoty',score:81,scale:100,votes:200,url:'https://www.albumoftheyear.org/album/1.php',observedAt:'2026-10-01T00:00:00Z',status:'ok'}]};
 const service=new SourceService(dir);
 try{const updates=vi.fn();const result=await service.refresh(settings,[old],()=>{},updates);expect(updates).toHaveBeenCalledWith(expect.objectContaining({source:'aoty',status:'blocked'}));expect(fetchMock).toHaveBeenCalledTimes(1);expect(result.statuses.find(s=>s.source==='aoty')?.status).toBe('blocked');expect(result.albums[0]?.sources[0]).toMatchObject({score:81,status:'blocked',observedAt:'2026-10-01T00:00:00Z'});expect(old.sources[0]?.status).toBe('ok');}finally{vi.unstubAllGlobals();await service.close();await rm(dir,{recursive:true,force:true});}
});
it('marks a source incomplete when a cross-check request fails after discovery',async()=>{const dir=await mkdtemp(join(tmpdir(),'source-error-'));const mock=vi.fn().mockResolvedValueOnce(new Response('<a href="/album/1-test.php">A</a>')).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response('<div class="artist">Other</div><div class="albumTitle">Record</div><div class="albumUserScore">85</div><div class="userScoreBox">200 ratings</div><div class="detailRow">October 30, 2026 / release date</div><div class="detailRow">LP / format</div>')).mockRejectedValue(new Error('network'));vi.stubGlobal('fetch',mock);const settings={sources:{aoty:true,rym:false,pitchfork:false},lookbackDays:90,requestDelayMs:0} as Settings;const candidate:Album={id:'candidate',artist:'A',title:'B',releaseDate:new Date().toISOString().slice(0,10),format:'LP',genres:[],excluded:false,sources:[]};const service=new SourceService(dir);try{const result=await service.refresh(settings,[candidate],()=>{});expect(result.statuses.find(s=>s.source==='aoty')?.status).toBe('error');}finally{vi.unstubAllGlobals();await service.close();await rm(dir,{recursive:true,force:true});}});
