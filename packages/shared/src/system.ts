/**
 * Read-only views pushed to the System view.
 * Plain types: produced by the server, displayed by the browser, never trusted as input.
 */

export interface InstanceStatus {
  instanceId: string;
  leader: boolean;
  connections: number;
  /** This instance's offset to the shared Redis clock, from its last sync. */
  clockOffsetMs: number;
  clockRttMs: number;
  commandsForwarded: number;
  /** How long ago the instance last reported (heartbeats every second). */
  ageMs: number;
}

export interface LedgerEntryView {
  id: number;
  txType: 'GRANT' | 'BET' | 'CASHOUT' | 'ROUND_LOSS';
  account: string;
  amount: number;
  at: string;
}

export interface KafkaTapEntry {
  eventId: string;
  type: string;
  key: string;
  occurredAt: string;
  mode: 'kafka' | 'dry-run';
}

/** A record read back from Kafka by the game's own consumer group. */
export interface KafkaConsumedEntry {
  topic: string;
  partition: number;
  offset: string;
  key: string;
  eventId: string;
  /** From the outbox row's creation (same DB transaction as the ledger change) to consumption. */
  endToEndMs: number;
  consumedAt: string;
}

export interface SystemMetrics {
  serverTime: number;
  leader: string;
  fencingToken: number | null;
  round: { roundId: number; phase: string } | null;
  instances: InstanceStatus[];
  connections: number;
  betsPerSecond: number;
  cashoutsPerSecond: number;
  loop: { lastMs: number; p50Ms: number; p99Ms: number; maxMs: number; queueDepth: number };
  drain: { lastMs: number; timeouts: number };
  bus: { consumed: number };
  kafka: {
    mode: 'kafka' | 'dry-run';
    published: number;
    recent: KafkaTapEntry[];
    /** Null when no broker is configured or the consumer is disabled. */
    consumer: { groupId: string; consumed: number; lag: number | null; recent: KafkaConsumedEntry[] } | null;
  };
  ledger: { transactions: number; postings: number; sumOfPostings: number; recent: LedgerEntryView[] };
  /** PLATFORM_MODE only: stakes held in platform-core and captures waiting to be settled there. */
  platform: { pendingSettlements: number; settled: number; coreCalls: number; coreFailures: number; coreP95Ms: number } | null;
}
