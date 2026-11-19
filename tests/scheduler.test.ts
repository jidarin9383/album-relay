import { afterEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../server/policy.js';
import { Scheduler } from '../server/scheduler.js';

afterEach(() => vi.useRealTimers());

it('stays disabled by default and dispatches an enabled legacy schedule to the coordinator at its configured local time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T03:59:59Z'));
  const settings = structuredClone(defaultSettings);
  const run = vi.fn(async () => {});
  const scheduler = new Scheduler({ settings: () => settings }, run);
  try {
    expect(scheduler.nextRun()).toBeNull();
    settings.schedule = { enabled: true, weekday: 3, hour: 12, minute: 0, timezone: 'Asia/Taipei' };
    scheduler.configure();
    expect(scheduler.nextRun()).toBe('2026-11-18T04:00:00.000Z');
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(8 * 86400000);
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    scheduler.stop();
  }
});
