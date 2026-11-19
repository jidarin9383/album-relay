import type { Album, Settings, Playlist, SyncPreview, SyncSelection, Track } from '../shared/types.js';
import { generateDescription } from './reasons.js';
export function playlistName(pattern: string, month: string): string { return pattern.replace(/\{(?:month|YYYY-MM)\}/g, month).replace(/YYYY-MM/g, month); }
export function planSync(albums: Album[], settings: Settings, playlists: Playlist[], now = new Date(), selection?: SyncSelection): SyncPreview {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: settings.schedule.timezone, year:'numeric',month:'2-digit' }).formatToParts(now);
  const month = `${parts.find(p=>p.type==='year')!.value}-${parts.find(p=>p.type==='month')!.value}`;
  const existing = playlists.find(p=>p.month===month) ?? null;
  const current = new Set(existing?.albumIds ?? []);
  const other = new Set(playlists.filter(p=>p.month!==month).flatMap(p=>p.albumIds));
  const selectedIds = selection?.albumIds?.length ? new Set(selection.albumIds) : null;
  const retained = albums.filter(a=>current.has(a.id) || a.admittedMonth===month);
  const fresh = albums.filter(a=>!current.has(a.id) && !a.admittedMonth && !other.has(a.id) && !a.excluded && a.decision?.status==='selected' && a.match?.tracks.length && (!selectedIds || selectedIds.has(a.id)));
  const unmatched = albums.filter(a=>!current.has(a.id) && !a.admittedMonth && !other.has(a.id) && !a.excluded && a.decision?.status==='selected' && !a.match?.tracks.length && (!selectedIds || selectedIds.has(a.id)));
  const combined = [...retained, ...fresh].filter((a,i,all)=>all.findIndex(b=>b.id===a.id)===i);
  return { descriptionMaxChars:settings.playlist.descriptionMaxChars, month, playlistName:playlistName(settings.playlist.namePattern,month), albums:combined,
    trackCount:new Set(combined.flatMap(a=>a.match?.tracks.map(t=>t.id) ?? [])).size, existingPlaylist:existing,
    warnings:[
      ...retained.filter(a=>!a.match?.tracks.length).map(a=>`${a.artist} — ${a.title}：已在本月歌单（${month}）中，保留现有歌单内容，无需重复写入`),
      ...unmatched.map(a=>`${a.artist} — ${a.title}：没有唯一完整匹配，暂不写入`)
    ],
    ...(selection ? { selection } : {}) };
}
export interface PlaylistClient {
  tracks(id:string):Promise<Track[]>; create(name:string):Promise<{id:string;originalId:number}>;
  add(id:string,ids:string[]):Promise<void>; reorder(id:string,ids:string[]):Promise<void>;
  describe(id:string,desc:string):Promise<void>; details(id:string):Promise<{name:string;describe:string;trackCount:number}>;
}
export async function executePlan(preview: SyncPreview, client: PlaylistClient, checkpoint:(playlist:Playlist)=>void|Promise<void>, progress:(message:string)=>void): Promise<Playlist|null> {
  if (!preview.albums.length && !preview.existingPlaylist) return null;
  let playlist = preview.existingPlaylist;
  if (!playlist) {
    progress('创建本月歌单'); const created = await client.create(preview.playlistName);
    playlist = {...created,month:preview.month,name:preview.playlistName,url:`https://music.163.com/#/playlist?id=${created.originalId}`,albumIds:[],trackCount:0,updatedAt:new Date().toISOString()};
    await checkpoint(playlist); // A retry must recover this ID before any track write.
  }
  const before = await client.tracks(playlist.id);
  const expected = [...new Set(preview.albums.flatMap(a=>a.match?.tracks.map(t=>t.id) ?? []))];
  const present = new Set(before.map(t=>t.id));
  const missing = expected.filter(id=>!present.has(id));
  for(let offset=0;offset<missing.length;offset+=100) { progress(`添加曲目 ${offset+1}–${Math.min(offset+100,missing.length)}`); await client.add(playlist.id,missing.slice(offset,offset+100)); }
  // Read again so songs added by the owner during the write are preserved too.
  const afterAdd = await client.tracks(playlist.id);
  const ordered = [...expected,...new Set([...before,...afterAdd].map(t=>t.id).filter(id=>!expected.includes(id)))];
  if(ordered.length) await client.reorder(playlist.id,ordered);
  const maxChars = Math.max(0, Math.min(1000, preview.descriptionMaxChars ?? 1000));
  const description = preview.description?.trim()
    ? preview.description.trim().slice(0, maxChars)
    : generateDescription(preview.albums,{playlist:{namePattern:preview.playlistName,descriptionMaxChars:maxChars}});
  await client.describe(playlist.id,description);
  const actual = await client.tracks(playlist.id);
  const details = await client.details(playlist.id);
  if (actual.length!==ordered.length || actual.some((t,i)=>t.id!==ordered[i]) || new Set(actual.map(t=>t.id)).size!==actual.length || details.describe!==description || details.trackCount!==actual.length) throw new Error('网易云写入后校验失败；已保留歌单记录，请重试同步');
  const result = {...playlist,description,albumIds:[...new Set([...playlist.albumIds,...preview.albums.map(a=>a.id)])],trackCount:actual.length,updatedAt:new Date().toISOString()};
  await checkpoint(result); progress('曲目顺序与推荐说明校验通过'); return result;
}
