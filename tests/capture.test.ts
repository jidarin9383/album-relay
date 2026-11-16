import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseChart } from '../server/sources/charts.js';
import { saveCapture } from '../server/capture.js';
import { Store } from '../server/store.js';
import { decide, defaultSettings } from '../server/policy.js';
import { parseRym } from '../server/sources/parsers.js';

const rymUrl='https://rateyourmusic.com/charts/top/album/2026/1/';
const aotyUrl='https://www.albumoftheyear.org/ratings/user-highest-rated/lp/2026/';
import { rymChart, aotyChart } from './fixtures/charts.js';
describe('current chart capture',()=>{
 it('extracts one RYM record per release and preserves rounded vote precision',()=>{
  const result=parseChart('rym',rymChart,rymUrl+'?temporary=discard');
  expect(result.albums).toHaveLength(1);
  expect(result.pageUrl).toBe(rymUrl);
  expect(result.albums[0]).toMatchObject({artist:'Stars',title:'Moon',format:'LP',releaseDate:'2026-10-30'});
  expect(result.albums[0]?.sources[0]).toMatchObject({score:3.9,votes:6000,votesDisplay:'6k',votesApproximate:true,collectionMethod:'browser-capture'});
 });
 it('extracts AOTY users separately and only infers LP from an explicit chart filter',()=>{
  const result=parseChart('aoty',aotyChart,aotyUrl);
  expect(result.albums[0]).toMatchObject({artist:'Stars',title:'Moon',format:'LP'});
  expect(result.albums[0]?.sources[0]).toMatchObject({score:85,votes:4942,votesApproximate:false,scale:100});
  expect(parseChart('aoty',aotyChart,aotyUrl.replace('/lp/','/')).albums[0]?.format).toBe('Unknown');
  expect(()=>parseChart('aoty',aotyChart.replace('USER SCORE','CRITIC SCORE'),aotyUrl)).toThrow();
 });
 it('rejects foreign URLs, challenges and unsupported pages without guessing',()=>{
  expect(()=>parseChart('rym',rymChart,'https://evil.example/charts/top/album/2026/')).toThrow();
  expect(()=>parseChart('aoty','<h1>Verify you are human</h1>',aotyUrl)).toThrow();
  expect(()=>parseChart('rym','<p>Nothing here</p>',rymUrl)).toThrow();
  expect(()=>parseChart('rym',rymChart.replace('/release/album/stars/moon/','https://evil.example/album'),rymUrl)).toThrow();
 });
 it('requires an explicit opt-in before rounded counts satisfy a vote minimum',()=>{
  const r=parseChart('rym',rymChart,rymUrl).albums[0]!;
  const a=parseChart('aoty',aotyChart,aotyUrl).albums[0]!;
  r.sources.push(...a.sources);
  expect(decide(r,defaultSettings,'2026-11-16').status).toBe('pending');
  expect(decide(r,{...defaultSettings,allowApproximateVotes:true},'2026-11-16').status).toBe('selected');
 });
 it('keeps safe pagination provenance while discarding challenge and tracking parameters',()=>{
  const result=parseChart('aoty',aotyChart,aotyUrl+'?p=2&temporary=discard');
  expect(result.pageUrl).toBe(aotyUrl+'?p=2');expect(result.albums[0]?.sources[0]?.sourcePageUrl).toBe(result.pageUrl);
 });
 it('does not bypass vote precision through existing detail parsers or historical display values',()=>{
  const a=parseRym('<h1 class="album_title">Moon</h1><span class="album_artist"><a>Stars</a></span><span itemprop="ratingValue">3.9</span><span itemprop="ratingCount">1.2k</span><table><tr><th>Released</th><td>30 October 2026</td></tr></table>','https://rateyourmusic.com/release/album/stars/moon/')!;
  expect(a.sources[0]?.votesApproximate).toBe(true);
  delete a.sources[0]!.votesApproximate;
  expect(decide(a,{...defaultSettings,minSources:1},'2026-11-16').status).toBe('pending');
 });
 it('persists corroboration and history across restart without losing exclusions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-capture-'));let store=new Store(dir);
  try{
   saveCapture(store,parseChart('rym',rymChart,rymUrl));
   const albums=store.albums();albums[0]!.excluded=true;store.saveAlbums(albums);
   const second=saveCapture(store,parseChart('aoty',aotyChart,aotyUrl));
   expect(second).toMatchObject({added:0,updated:1});
   saveCapture(store,parseChart('aoty',aotyChart,aotyUrl));
   store.close();store=new Store(dir);
   expect(store.albums()).toHaveLength(1);
   expect(store.albums()[0]).toMatchObject({excluded:true,decision:{status:'excluded'}});
   expect(store.albums()[0]?.sources).toHaveLength(2);
   expect(store.captures()).toHaveLength(3);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('retains conflicting evidence for review without merging different releases',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-conflict-'));const store=new Store(dir);
  try{
   saveCapture(store,parseChart('rym',rymChart,rymUrl));
   const result=saveCapture(store,parseChart('aoty',aotyChart.replace('October 30, 2026','October 31, 2026'),aotyUrl));
   expect(result.warnings.length).toBeGreaterThan(0);expect(result.updated).toBe(0);
   expect(store.albums()[0]?.sources).toHaveLength(1);
   expect(store.captures()[0]?.albums[0]?.sources[0]?.source).toBe('aoty');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('does not replace a known same-site release URL with another edition sharing its metadata',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-edition-'));const store=new Store(dir);
  try{
   saveCapture(store,parseChart('rym',rymChart,rymUrl));
   const saved=store.albums();saved[0]!.sources[0]!.status='blocked';store.saveAlbums(saved);
   const result=saveCapture(store,parseChart('rym',rymChart.replace('/stars/moon/','/stars/moon-2/'),rymUrl));
   expect(result.updated).toBe(0);expect(result.warnings.length).toBeGreaterThan(0);
   expect(store.albums()[0]?.sources[0]?.url).toBe('https://rateyourmusic.com/release/album/stars/moon/');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('prefers localized primary RYM artist and title spans and corroborates matching Unicode records',()=>{
  const rymLocalized=`<div class="page_charts_section_charts_item object_release"><div class="page_charts_section_charts_item_title"><a class="page_charts_section_charts_item_link" href="/release/album/ichiko-aoba/windswept-adan/"><span class="ui_name_locale"><span class="ui_name_locale_original">アダンの風</span><span class="ui_name_locale_language">Windswept Adan</span></span></a></div><div class="page_charts_section_charts_item_credited_text"><span class="page_charts_section_charts_item_credited_links_primary"><a class="artist"><span class="ui_name_locale"><span class="ui_name_locale_original">青葉市子</span><span class="ui_name_locale_language">Ichiko Aoba</span></span></a></span><span class="page_charts_section_charts_item_credited_links_secondary">feat. <a class="artist">Featured Guest</a></span></div><div class="page_charts_section_charts_item_title_date_compact"><span>30 October 2026</span></div><span class="page_charts_section_charts_item_details_average_num">3.95</span><span class="page_charts_section_charts_item_details_ratings">/ 500</span></div>`;
  const aotyLocalized=`<div class="albumListRow"><h2 class="albumListTitle"><a href="/album/99-ichiko-aoba-windswept-adan.php">青葉市子 - アダンの風</a></h2><div class="albumListDate">October 30, 2026</div><div class="albumListScoreContainer"><div class="scoreHeader">USER SCORE</div><div class="scoreValue">88</div><div class="scoreText">450 ratings</div></div></div>`;
  const rymParsed=parseChart('rym',rymLocalized,rymUrl);
  expect(rymParsed.albums[0]).toMatchObject({artist:'青葉市子',title:'アダンの風'});
  const dir=mkdtempSync(join(tmpdir(),'relay-locale-'));const store=new Store(dir);
  try{
   expect(saveCapture(store,rymParsed)).toMatchObject({added:1,updated:0});
   expect(saveCapture(store,parseChart('aoty',aotyLocalized,aotyUrl))).toMatchObject({added:0,updated:1});
   expect(store.albums()).toHaveLength(1);
   expect(store.albums()[0]?.sources).toHaveLength(2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('caps current-page capture at 60 rows with an explicit warning',()=>{
  const many=Array.from({length:65},(_,i)=>rymChart.replace('/stars/moon/',`/stars/moon-${i}/`).replace('Moon',`Moon ${i}`)).join('');
  const result=parseChart('rym',many,rymUrl);
  expect(result.albums).toHaveLength(60);
  expect(result.warnings).toContain('本次只收录当前页面的前 60 个条目');
 });
 it('lists the latest 100 capture receipts while retaining older stored history in SQLite',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-history-105-'));const store=new Store(dir);
  try{
   for(let i=1;i<=105;i++){
    saveCapture(store,parseChart('aoty',aotyChart,`${aotyUrl}?p=${i}`));
   }
   const listed=store.captures();
   expect(listed).toHaveLength(100);
   expect(listed[0]?.pageUrl).toBe(`${aotyUrl}?p=105`);
   expect(listed[99]?.pageUrl).toBe(`${aotyUrl}?p=6`);
   const db=new DatabaseSync(join(dir,'album-relay.sqlite'));
   try{
    const row=db.prepare('SELECT COUNT(*) AS count FROM captures').get() as {count:number};
    expect(row.count).toBe(105);
   }finally{db.close();}
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});
