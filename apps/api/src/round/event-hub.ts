import { Injectable, Logger } from '@nestjs/common';
import type { RoundEvent } from '@ronin/shared';

type Listener = (event: RoundEvent) => void | Promise<void>;

/**
 * In-process fan-out of the leader's round events to the socket gateway, read model, bots and
 * leaderboard. Listeners are isolated: one failing never affects the engine or the others.
 */
@Injectable()
export class EventHub {
  private readonly log = new Logger('EventHub');
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: RoundEvent): void {
    for (const l of this.listeners) {
      try {
        const r = l(event);
        if (r instanceof Promise) r.catch((e: Error) => this.log.warn(`${event.type} listener failed: ${e.message}`));
      } catch (e) {
        this.log.warn(`${event.type} listener failed: ${(e as Error).message}`);
      }
    }
  }
}
