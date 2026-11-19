import { Cron } from 'croner';
import type { Settings } from '../shared/types.js';

/** Preserve schedules saved by older installs and run them through the capture coordinator. */
export class Scheduler {
  private cron?: Cron;

  constructor(
    private readonly store: { settings(): Settings },
    private readonly run: () => Promise<void>
  ) {
    this.configure();
  }

  configure(): void {
    this.stop();
    const { enabled, minute, hour, weekday, timezone } = this.store.settings().schedule;
    if (!enabled) return;
    this.cron = new Cron(`${minute} ${hour} * * ${weekday}`, { timezone, protect: true }, this.run);
  }

  nextRun(): string | null {
    return this.cron?.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    this.cron?.stop();
    this.cron = undefined;
  }
}
