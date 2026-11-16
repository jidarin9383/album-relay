import type { Album, Settings } from '../shared/types.js';
const labels = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'Pitchfork' };
export function generateDescription(albums: Album[], settings?: Pick<Settings,'playlist'>): string {
  const limit = Math.max(0, Math.min(1000, settings?.playlist.descriptionMaxChars ?? 1000));
  const heading = '新专辑精选｜依据公开评分与已核验来源筛选，非试听评价。';
  const rows = albums.map(a => {
    const evidence = a.sources.filter(s => s.status === 'ok' && s.score !== null)
      .map(s => `${labels[s.source]} ${s.score}/${s.scale}${s.votes !== null ? `（${s.votes}票）` : ''}${s.bestNewMusic ? ' BNM' : ''}`).join('；');
    const qualifying = a.decision?.status === 'selected' ? a.decision.qualifyingSources.map(source => labels[source]).join('、') : '';
    const reason = qualifying ? `入选理由：${qualifying} 达标` : '此前已收录，最新评分待核验';
    return `${a.artist} — ${a.title}${a.genres.length ? `｜${a.genres.join(' / ')}` : ''}｜${reason}｜${evidence || '公开来源信息待补充'}`;
  });
  let result = heading.slice(0, limit);
  for (const row of rows) { if (result.length + row.length + 1 > limit) break; result += `\n${row}`; }
  return result;
}
