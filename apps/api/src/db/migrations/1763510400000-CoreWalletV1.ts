import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Core /api/v1 wallet (contracts 0.3.0).
 *  - users.external_wallet_id: the player's Core wallet, returned by the player-session activation.
 *  - platform_settlements.status FAILED: Core answered something no retry can fix (e.g. the
 *    settlement grace window passed); the row is parked for reconciliation instead of looping.
 */
export class CoreWalletV11763510400000 implements MigrationInterface {
  name = 'CoreWalletV11763510400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE users ADD COLUMN external_wallet_id text;
      ALTER TABLE platform_settlements DROP CONSTRAINT platform_settlements_status_check;
      ALTER TABLE platform_settlements ADD CONSTRAINT platform_settlements_status_check CHECK (status IN ('PENDING', 'DONE', 'FAILED'));
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE platform_settlements SET status = 'PENDING' WHERE status = 'FAILED';
      ALTER TABLE platform_settlements DROP CONSTRAINT platform_settlements_status_check;
      ALTER TABLE platform_settlements ADD CONSTRAINT platform_settlements_status_check CHECK (status IN ('PENDING', 'DONE'));
      ALTER TABLE users DROP COLUMN external_wallet_id;
    `);
  }
}
