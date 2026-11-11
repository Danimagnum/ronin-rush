import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contract validation in the outbox relay (@danigil/platform-contracts 0.2.0). An event whose
 * payload does not match its published schema is set aside with the reason instead of being
 * published or retried forever; it stays in the table for inspection and is counted in /metrics.
 */
export class OutboxRejected1763251200000 implements MigrationInterface {
  name = 'OutboxRejected1763251200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE outbox ADD COLUMN rejected_at timestamptz, ADD COLUMN reject_reason text;
      DROP INDEX outbox_unpublished_idx;
      CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL AND rejected_at IS NULL;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP INDEX outbox_pending_idx;
      CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
      ALTER TABLE outbox DROP COLUMN rejected_at, DROP COLUMN reject_reason;
    `);
  }
}
