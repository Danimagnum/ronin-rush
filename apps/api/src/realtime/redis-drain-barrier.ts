import type { DrainBarrier } from '../round/ports';
import { compareStreamIds, type CommandBus } from './command-bus';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Settlement gate for multi-instance deployments (see CommandBus). Resolves when every live
 * edge has forwarded everything received before the crash and the leader has consumed the
 * command stream up to its tip. Dead instances drop out when their watermark key expires.
 */
export class RedisDrainBarrier implements DrainBarrier {
  lastDrainMs = 0;
  timeouts = 0;

  constructor(
    private readonly bus: CommandBus,
    private readonly onTimeout: (lagging: string[]) => void = () => undefined,
  ) {}

  async waitUntilDrained(crashedAt: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lagging: string[] = [];
    while (Date.now() < deadline) {
      const wms = await this.bus.liveWatermarks().catch(() => []);
      lagging = wms.filter((w) => w.watermark < crashedAt).map((w) => w.instanceId);
      if (lagging.length === 0) {
        const tip = await this.bus.streamTip().catch(() => null);
        while (tip && compareStreamIds(this.bus.lastConsumedId, tip) < 0 && Date.now() < deadline) await sleep(2);
        this.lastDrainMs = Date.now() - started;
        return;
      }
      await sleep(5);
    }
    this.timeouts++;
    this.lastDrainMs = Date.now() - started;
    this.onTimeout(lagging);
  }
}
