import { describe, expect, it } from 'vitest';
import { parseAoty, parseRym, parsePitchfork, parsePitchforkIndex, parseIndex, parseVotes, normalizeIdentity, isChallenge } from '../server/sources/parsers.js';
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
 it('parses modern RYM release table.album_info DOM with meta ratingValue and no .album_artist', () => {
  const html = `<!doctype html><html><head><title>The Same Place by The Olivia Tremor Control (Album, Neo-Psychedelia): Reviews, Ratings, Credits, Song list - Rate Your Music</title></head><body>
    <meta itemprop="ratingValue" content="3.74" />
    <div class="page_release_art_frame"><img class="coverart_img" src="//e.snmc.io/i/600/s/same-place.jpg" /></div>
    <div class="album_title">The Same Place <input class="album_shortcut" value="[Album123]" /></div>
    <table class="album_info">
      <tr><th class="info_hdr">Artist</th><td><a class="artist" href="/artist/the-olivia-tremor-control">The Olivia Tremor Control</a></td></tr>
      <tr><th class="info_hdr">Type</th><td>Album</td></tr>
      <tr><th class="info_hdr">Released</th><td>23 October 2026</td></tr>
      <tr><th class="info_hdr">RYM Rating</th><td><span class="avg_rating">3.74</span> / 5.0 from <span class="num_ratings"><b>3,000</b> ratings</span></td></tr>
      <tr><th class="info_hdr">Genres</th><td><a class="genre">Neo-Psychedelia</a>, <a class="genre">Psychedelic Pop</a></td></tr>
      <tr><th class="info_hdr">Descriptors</th><td>psychedelic, kaleidoscopic, warm</td></tr>
    </table>
  </body></html>`;
  const a = parseRym(html, 'https://rateyourmusic.com/release/album/the-olivia-tremor-control/the-same-place/');
  expect(a).toMatchObject({
    artist: 'The Olivia Tremor Control',
    title: 'The Same Place',
    releaseDate: '2026-10-23',
    format: 'LP',
    genres: ['Neo-Psychedelia', 'Psychedelic Pop'],
    descriptors: ['psychedelic', 'kaleidoscopic', 'warm'],
    coverUrl: 'https://e.snmc.io/i/600/s/same-place.jpg'
  });
  expect(a?.sources[0]).toMatchObject({ score: 3.74, votes: 3000, votesDisplay: '3,000', detailCaptured: true });
 });
 it('reads editorial state and never treats review publication date as release date', () => {
 const state={transformed:{review:{headerProps:{artists:[{name:'Artist'}],title:'Album',publishDate:'November 14, 2026',musicRating:{rating:8.4,bestNewMusic:true,bestNewReissue:false},infoSliceFields:{genre:'Electronic, Ambient',releaseYear:'2026'},lede:{sources:{sm:{url:'https://media.pitchfork.com/photos/cover-1.jpg'}}}},datePublished:'2026-11-13'}}};
 const a=parsePitchfork(`<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script>`, 'https://pitchfork.com/reviews/albums/artist-album/');
 expect(a).toMatchObject({artist:'Artist',title:'Album',releaseDate:'',format:'Unknown',genres:['Electronic','Ambient'],coverUrl:'https://media.pitchfork.com/photos/cover-1.jpg'}); expect(a?.sources[0]).toMatchObject({score:8.4,bestNewMusic:true});
 });
 it('extracts EP suffix and archival Pitchfork releaseYear while keeping current-year dates open for corroboration', () => {
  const archival={transformed:{review:{headerProps:{artists:[{name:'Pearl Jam'}],title:'Yield',publishDate:'November 15, 2026',musicRating:{rating:8.5,bestNewMusic:false,bestNewReissue:false},infoSliceFields:{genre:'Rock',releaseYear:'1998'}}}}};
  const ep={transformed:{review:{headerProps:{artists:[{name:'Sun Araw'}],title:'Rapid Response EP',publishDate:'November 15, 2026',musicRating:{rating:7.5,bestNewMusic:false,bestNewReissue:false},infoSliceFields:{genre:'Experimental',releaseYear:'2026'}}}}};
  expect(parsePitchfork(`<script>window.__PRELOADED_STATE__=${JSON.stringify(archival)};</script>`,'https://pitchfork.com/reviews/albums/pearl-jam-yield/')).toMatchObject({releaseDate:'1998-01-01',format:'Unknown',genres:['Rock']});
  expect(parsePitchfork(`<script>window.__PRELOADED_STATE__=${JSON.stringify(ep)};</script>`,'https://pitchfork.com/reviews/albums/sun-araw-rapid-response-ep/')).toMatchObject({releaseDate:'',format:'EP',genres:['Experimental']});
 });
 it('excludes best new reissues from BNM',()=>{const a=parsePitchfork('<script>window.__PRELOADED_STATE__={"transformed":{"review":{"headerProps":{"artists":[{"name":"A"}],"title":"B","musicRating":{"rating":9,"bestNewMusic":true,"bestNewReissue":true}}}}};</script>','https://pitchfork.com/reviews/albums/a-b/');expect(a?.format).toBe('Reissue');expect(a?.sources[0]?.bestNewMusic).toBe(false);});
 it('extracts bounded source-specific links and detects challenges',()=>{
  expect(parseIndex('<a href="/album/1-test.php">A</a><a href="/album/1-test.php">A</a><a href="https://evil.test/album/2.php">B</a>','aoty')).toEqual(['https://www.albumoftheyear.org/album/1-test.php']);
  expect(isChallenge('Just a moment... Checking your browser',200)).toBe(true);
  expect(isChallenge('normal',403)).toBe(true);
  expect(isChallenge('<title>请稍候…</title><p>请验证您是真人</p>',200)).toBe(true);
  expect(isChallenge('<p>正在验证您是否是真人</p>',200)).toBe(true);
  expect(isChallenge('<p>需要检查您的连接安全性</p>',200)).toBe(true);
  expect(isChallenge('<title>請稍候…</title><p>驗證您是人類</p>',200)).toBe(true);
  expect(isChallenge('<p>Performing security verification</p>',200)).toBe(true);
  expect(isChallenge('<div class="albumTitle">Normal Album Page</div><div class="albumUserScore">85</div>',200)).toBe(false);
 });
 it('normalizes Unicode punctuation and slash/ampersand collaborations without conflating editions',()=>{
  expect(normalizeIdentity('Beyoncé — Moon')).toBe(normalizeIdentity('Beyonce Moon'));
  expect(normalizeIdentity('Aesop Rock / Blockhead')).toBe(normalizeIdentity('Aesop Rock & Blockhead'));
  expect(normalizeIdentity('Moon Deluxe')).not.toBe(normalizeIdentity('Moon'));
 });
 it('parses Pitchfork review index containers with scores, covers, genres, EP and Reissue flags',()=>{
  const state={transformed:{bundle:{containers:[{items:[
   {contentType:'review',subHed:{name:'Aesop Rock / Blockhead'},dangerousHed:'<em>Trouble Mountain</em>',url:'/reviews/albums/aesop-rock-blockhead-trouble-mountain/',ratingValue:{score:7.1,isBestNewMusic:false,isBestNewReissue:false},rubric:[{name:'Rap'},{name:'Rap'}],image:{sources:{sm:{url:'https://media.pitchfork.com/photos/1.jpg'}}}},
   {contentType:'review',subHed:{name:'Armand Hammer'},dangerousHed:'<em>Snakes &amp; Ladders</em>',url:'/reviews/albums/armand-hammer-snakes-and-ladders/',ratingValue:{score:8.3,isBestNewMusic:true,isBestNewReissue:false},rubric:[{name:'Rap'}]},
   {contentType:'review',subHed:{name:'Armand Hammer'},dangerousHed:'<em>Snakes &amp; Ladders</em>',url:'/reviews/albums/armand-hammer-snakes-and-ladders/',ratingValue:{score:8.3,isBestNewMusic:true,isBestNewReissue:false}},
   {contentType:'review',subHed:{name:'Sun Araw'},dangerousHed:'<em>Rapid Response EP</em>',url:'/reviews/albums/sun-araw-rapid-response-ep/',ratingValue:{score:7.5,isBestNewMusic:false,isBestNewReissue:false}},
   {contentType:'review',subHed:{name:'Classic Band'},dangerousHed:'<em>Old LP</em>',url:'/reviews/albums/classic-band-old-lp/',ratingValue:{score:9.0,isBestNewMusic:true,isBestNewReissue:true}}
  ]}]}}};
  const parsed=parsePitchforkIndex(`<script>window.__PRELOADED_STATE__=${JSON.stringify(state)};</script>`,'https://pitchfork.com/reviews/albums/');
  expect(parsed.albums).toHaveLength(4);
  expect(parsed.albums[0]).toMatchObject({artist:'Aesop Rock / Blockhead',title:'Trouble Mountain',format:'Unknown',genres:['Rap'],coverUrl:'https://media.pitchfork.com/photos/1.jpg'});
  expect(parsed.albums[1]?.sources[0]).toMatchObject({score:8.3,bestNewMusic:true,collectionMethod:'browser-capture'});
  expect(parsed.albums[2]?.format).toBe('EP');
  expect(parsed.albums[3]).toMatchObject({format:'Reissue'});
  expect(parsed.albums[3]?.sources[0]?.bestNewMusic).toBe(false);
 });
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
 const service=new SourceService(dir,{serverFetch:['aoty','rym','pitchfork']});
 try{const updates=vi.fn();const result=await service.refresh(settings,[old],()=>{},updates);expect(updates).toHaveBeenCalledWith(expect.objectContaining({source:'aoty',status:'blocked'}));expect(fetchMock).toHaveBeenCalledTimes(1);expect(result.statuses.find(s=>s.source==='aoty')?.status).toBe('blocked');expect(result.albums[0]?.sources[0]).toMatchObject({score:81,status:'blocked',observedAt:'2026-10-01T00:00:00Z'});expect(old.sources[0]?.status).toBe('ok');}finally{vi.unstubAllGlobals();await service.close();await rm(dir,{recursive:true,force:true});}
});
it('marks a source incomplete when a cross-check request fails after discovery',async()=>{const dir=await mkdtemp(join(tmpdir(),'source-error-'));const mock=vi.fn().mockResolvedValueOnce(new Response('<a href="/album/1-test.php">A</a>')).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response('<div class="artist">Other</div><div class="albumTitle">Record</div><div class="albumUserScore">85</div><div class="userScoreBox">200 ratings</div><div class="detailRow">October 30, 2026 / release date</div><div class="detailRow">LP / format</div>')).mockRejectedValue(new Error('network'));vi.stubGlobal('fetch',mock);const settings={sources:{aoty:true,rym:false,pitchfork:false},lookbackDays:90,requestDelayMs:0} as Settings;const candidate:Album={id:'candidate',artist:'A',title:'B',releaseDate:new Date().toISOString().slice(0,10),format:'LP',genres:[],excluded:false,sources:[]};const service=new SourceService(dir,{serverFetch:['aoty','rym','pitchfork']});try{const result=await service.refresh(settings,[candidate],()=>{});expect(result.statuses.find(s=>s.source==='aoty')?.status).toBe('error');}finally{vi.unstubAllGlobals();await service.close();await rm(dir,{recursive:true,force:true});}});
it('preserves fresh browser-capture observations when background refresh is blocked',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'source-capture-preserve-'));
 const fetchMock=vi.fn().mockResolvedValue(new Response('Verification required',{status:403}));
 vi.stubGlobal('fetch',fetchMock);
 const settings={sources:{aoty:true,rym:false,pitchfork:false},lookbackDays:90,requestDelayMs:0} as Settings;
 const recentCapture=new Date(Date.now()-2*86400000).toISOString();
 const captured:Album={id:'cap',artist:'Stars',title:'Moon',releaseDate:new Date(Date.now()-20*86400000).toISOString().slice(0,10),format:'LP',genres:[],excluded:false,sources:[{source:'aoty',score:85,scale:100,votes:4942,url:'https://www.albumoftheyear.org/album/1-stars-moon.php',observedAt:recentCapture,status:'ok',collectionMethod:'browser-capture'}]};
 const service=new SourceService(dir,{serverFetch:['aoty','rym','pitchfork']});
 try{
  const result=await service.refresh(settings,[captured],()=>{});
  expect(result.statuses.find(s=>s.source==='aoty')?.status).toBe('blocked');
  expect(result.albums[0]?.sources[0]).toMatchObject({score:85,status:'ok',collectionMethod:'browser-capture',observedAt:recentCapture});
 }finally{vi.unstubAllGlobals();await service.close();await rm(dir,{recursive:true,force:true});}
});
it('never fetches RYM, AOTY or Pitchfork from the server by default; all sources are extension-only',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'source-extension-only-'));const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 const settings={sources:{aoty:true,rym:true,pitchfork:true},lookbackDays:90,requestDelayMs:0} as Settings;
 const captured:Album={id:'cap',artist:'Stars',title:'Moon',releaseDate:new Date(Date.now()-20*86400000).toISOString().slice(0,10),format:'LP',genres:[],excluded:false,sources:[{source:'rym',score:3.9,scale:5,votes:6000,url:'https://rateyourmusic.com/release/album/stars/moon/',observedAt:new Date().toISOString(),status:'ok',collectionMethod:'browser-capture'}]};
 const service=new SourceService(dir);
 try{
  const result=await service.refresh(settings,[captured],()=>{});
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.statuses.map(s=>s.source).sort()).toEqual(['aoty','pitchfork','rym']);
  expect(result.statuses.find(s=>s.source==='rym')?.message).toContain('浏览器扩展');
  expect(result.statuses.find(s=>s.source==='pitchfork')?.message).toContain('浏览器扩展');
  expect(result.albums[0]?.sources).toEqual(captured.sources);
  expect((await service.check('aoty',settings)).message).toContain('浏览器扩展');
  expect((await service.check('pitchfork',settings)).message).toContain('浏览器扩展');
  expect(fetchMock).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals();await rm(dir,{recursive:true,force:true});}
});
