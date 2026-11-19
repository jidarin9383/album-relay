import { describe, it, expect } from 'vitest';
import { decide, defaultSettings, albumId } from '../server/policy.js';
import type { Album, Observation } from '../shared/types.js';

const obs = (source: Observation['source'], score: number, votes: number | null = 500): Observation => ({
  source,
  score,
  votes,
  scale: source === 'rym' ? 5 : source === 'aoty' ? 100 : 10,
  url: 'https://example.com',
  observedAt: '2026-11-16T00:00:00Z',
  status: 'ok'
});
const album = (sources: Observation[]): Album => ({
  id: 'a',
  artist: 'Artist',
  title: 'Album',
  releaseDate: '2026-10-30',
  format: 'LP',
  genres: [],
  excluded: false,
  sources
});

describe('cross-source & direct selection decisions', () => {
  it('admits single-source strong acclaim directly while holding moderate single-source scores', () => {
    const pfkBnm: Album = {
      id: 'pf-bnm',
      artist: 'Artist',
      title: 'Acclaimed LP',
      releaseDate: '',
      format: 'Unknown',
      genres: [],
      excluded: false,
      sources: [{ ...obs('pitchfork', 8.4, null), bestNewMusic: true }]
    };
    expect(decide(pfkBnm, defaultSettings, '2026-11-16').status).toBe('selected');
    expect(decide(album([obs('pitchfork', 8.3, null)]), defaultSettings, '2026-11-16').status).toBe('selected');
    expect(decide(album([obs('rym', 3.7, 300)]), defaultSettings, '2026-11-16').status).toBe('selected');
    expect(decide(album([obs('aoty', 82, 250)]), defaultSettings, '2026-11-16').status).toBe('selected');

    // Moderate single-source scores still require a second qualifying source
    expect(decide(album([obs('pitchfork', 8.1, null)]), defaultSettings, '2026-11-16').status).toBe('pending');
    expect(decide(album([obs('aoty', 81, 500)]), defaultSettings, '2026-11-16').status).toBe('pending');

    // Can opt out of single-source strong acclaim in settings
    expect(decide(album([obs('pitchfork', 9, null)]), { ...defaultSettings, allowSingleSourceAcclaim: false }, '2026-11-16').status).toBe('pending');
  });

  it('admits two qualifying communities and holds a known third-site disagreement without misclassifying solo low scores', () => {
    const a = album([obs('aoty', 81), obs('rym', 3.6)]);
    expect(decide(a, defaultSettings, '2026-11-16').status).toBe('selected');
    a.sources.push(obs('pitchfork', 6.9));
    const d = decide(a, defaultSettings, '2026-11-16');
    expect(d.status).toBe('disagreement');
    expect(d.qualifyingSources).toEqual(['aoty', 'rym']);
    expect(d.negativeSources).toEqual(['pitchfork']);
    expect(d.reasons[0]).toContain('高分站：');
    expect(d.reasons[0]).toContain('P4K 6.9');

    // A solo low Pitchfork score with no passing community is pending, not cross-site disagreement
    const soloLow = album([obs('pitchfork', 5.8, null)]);
    const soloDecision = decide(soloLow, defaultSettings, '2026-11-16');
    expect(soloDecision.status).toBe('pending');
    expect(soloDecision.negativeSources).toEqual(['pitchfork']);
    expect(soloDecision.reasons[0]).toContain('P4K 5.8');
  });

  it('does not treat inaccessible scores as positive or negative', () => {
    const o = obs('rym', 4);
    o.status = 'blocked';
    expect(decide(album([obs('aoty', 81), o]), defaultSettings, '2026-11-16').status).toBe('pending');
  });

  it('respects vote minimum, configured minimumAgeDays and persistent exclusion', () => {
    const strict = { ...defaultSettings, allowSingleSourceAcclaim: false, minimumAgeDays: 7 };
    const a = album([obs('aoty', 88, 57), obs('rym', 4)]);
    expect(decide(a, strict, '2026-11-16').status).toBe('pending');
    a.sources[0]!.votes = 100;
    a.releaseDate = '2026-11-15';
    expect(decide(a, strict, '2026-11-16').status).toBe('too_new');
    // Zero waiting period by default
    expect(decide(a, defaultSettings, '2026-11-16').status).toBe('selected');
    a.excluded = true;
    expect(decide(a, strict, '2026-11-16').status).toBe('excluded');
  });

  it('uses unique source votes, not duplicated observations', () => {
    const noSingle = { ...defaultSettings, allowSingleSourceAcclaim: false };
    expect(decide(album([obs('aoty', 90), obs('aoty', 89)]), noSingle, '2026-11-16').status).toBe('pending');
  });

  it('keeps unicode identities stable across normalization', () => {
    expect(albumId('Olēka', 'Human Error')).toBe(albumId('oleka', 'human error'));
  });

  it('holds undated non-BNM Pitchfork reviews until date confirmation while admitting EP and Unknown formats', () => {
    const pf: Album = {
      id: 'pf',
      artist: 'Artist',
      title: 'New LP',
      releaseDate: '',
      format: 'Unknown',
      genres: [],
      excluded: false,
      sources: [obs('pitchfork', 8.3, null)]
    };
    const d = decide(pf, defaultSettings, '2026-11-16');
    expect(d.status).toBe('pending');

    const ep: Album = { ...album([obs('aoty', 85), obs('rym', 3.9)]), format: 'EP' };
    const unknownDated: Album = { ...album([obs('pitchfork', 8.5, null)]), format: 'Unknown' };
    const reissue: Album = { ...album([obs('aoty', 85), obs('rym', 3.9)]), format: 'Reissue' };
    expect(decide(ep, defaultSettings, '2026-11-16').status).toBe('selected');
    expect(decide(unknownDated, defaultSettings, '2026-11-16').status).toBe('selected');
    expect(decide(reissue, defaultSettings, '2026-11-16').status).toBe('format_conflict');
  });
});
