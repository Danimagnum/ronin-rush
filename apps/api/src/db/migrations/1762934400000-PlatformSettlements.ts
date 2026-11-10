import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PLATFORM_MODE support and platform-standard events.
 *
 *  - bets.external_hold_id: the platform-core wallet hold that backs a player's stake. When set,
 *    money lives in Core; the local ledger records the bet but writes no postings for it.
 *  - platform_settlements: a command outbox. The cash-out or loss decision commits locally
 *    together with a PENDING row; a worker captures the hold in Core (idempotent key) and
 *    marks it DONE. Core being slow or down never blocks or reverses a decision.
 *  - outbox.event_id: stable UUID per event, required by the platform event envelope.
 */
export class PlatformSettlements1762934400000 implements MigrationInterface {
  name = 'PlatformSettlements1762934400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE bets ADD COLUMN external_hold_id text;

      CREATE TABLE platform_settlements (
        bet_id          uuid PRIMARY KEY REFERENCES bets(id),
        hold_id         text   NOT NULL,
        external_user   text   NOT NULL,
        payout          bigint NOT NULL CHECK (payout >= 0),
        idempotency_key text   NOT NULL UNIQUE,
        status          text   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
        attempts        integer NOT NULL DEFAULT 0,
        last_error      text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at      timestamptz NOT NULL DEFAULT now(),
        settled_at      timestamptz
      );
      CREATE INDEX platform_settlements_pending_idx ON platform_settlements (next_attempt_at) WHERE status = 'PENDING';

      ALTER TABLE outbox ADD COLUMN event_id uuid NOT NULL DEFAULT gen_random_uuid();
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE outbox DROP COLUMN event_id;
      DROP TABLE platform_settlements;
      ALTER TABLE bets DROP COLUMN external_hold_id;
    `);
  }
}
