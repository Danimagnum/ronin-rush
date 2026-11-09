import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Double-entry ledger + round persistence.
 *
 * Invariants enforced by the database itself (not only by application code):
 *  - every ledger transaction's postings sum to zero (deferred constraint trigger);
 *  - postings and ledger transactions are append-only (UPDATE/DELETE raise);
 *  - a user's cached balance can never go negative (CHECK);
 *  - an operation is applied at most once (UNIQUE idempotency_key);
 *  - one bet per user per round, one client key per user (UNIQUE).
 */
export class InitialSchema1762675200000 implements MigrationInterface {
  name = 'InitialSchema1762675200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username      text NOT NULL UNIQUE,
        password_hash text,
        external_id   text UNIQUE,             -- platform-core subject in PLATFORM_MODE
        is_bot        boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      CREATE TYPE account_kind AS ENUM ('user', 'escrow', 'house', 'mint');

      CREATE TABLE accounts (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind       account_kind NOT NULL,
        user_id    uuid UNIQUE REFERENCES users(id),
        -- Cached balance, user accounts only. System accounts have no cache on purpose:
        -- their balance is SUM(postings), so hot bets never serialise on one row.
        balance    bigint,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_account_has_owner CHECK ((kind = 'user') = (user_id IS NOT NULL)),
        CONSTRAINT user_account_has_cache CHECK ((kind = 'user') = (balance IS NOT NULL)),
        CONSTRAINT no_overdraft          CHECK (balance IS NULL OR balance >= 0)
      );
      CREATE UNIQUE INDEX one_system_account_per_kind ON accounts (kind) WHERE kind <> 'user';
      INSERT INTO accounts (kind) VALUES ('escrow'), ('house'), ('mint');

      CREATE TYPE ledger_tx_type AS ENUM ('GRANT', 'BET', 'CASHOUT', 'ROUND_LOSS');

      CREATE TABLE ledger_transactions (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type            ledger_tx_type NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        round_id        bigint,
        bet_id          uuid,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE postings (
        id             bigserial PRIMARY KEY,
        transaction_id uuid   NOT NULL REFERENCES ledger_transactions(id),
        account_id     uuid   NOT NULL REFERENCES accounts(id),
        amount         bigint NOT NULL CHECK (amount <> 0),   -- signed cents
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX postings_account_idx ON postings (account_id);
      CREATE INDEX postings_transaction_idx ON postings (transaction_id);

      CREATE FUNCTION assert_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE total bigint;
      BEGIN
        SELECT COALESCE(SUM(amount), 0) INTO total FROM postings WHERE transaction_id = NEW.transaction_id;
        IF total <> 0 THEN
          RAISE EXCEPTION 'unbalanced ledger transaction % (sum %)', NEW.transaction_id, total;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER postings_must_balance
        AFTER INSERT ON postings DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'the ledger is append-only (% on %)', TG_OP, TG_TABLE_NAME;
      END $$;
      CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
      CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

      -- Provably-fair chain. Seeds are secret until their round settles; only the leader reads them.
      CREATE TABLE fairness_chains (
        id          serial PRIMARY KEY,
        commitment  char(64) NOT NULL UNIQUE,
        length      integer  NOT NULL,
        public_salt text     NOT NULL,
        active      boolean  NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX one_active_chain ON fairness_chains (active) WHERE active;

      CREATE TABLE seed_chain (
        chain_id integer NOT NULL REFERENCES fairness_chains(id),
        round_id bigint  NOT NULL,
        seed     char(64) NOT NULL,
        PRIMARY KEY (chain_id, round_id)
      );

      -- Single-row fence: the leader bumps it on every phase transition; every write made on
      -- the leader's behalf checks it, so a paused ex-leader can no longer touch money or rounds.
      CREATE TABLE leader_fence (
        id    smallint PRIMARY KEY CHECK (id = 1),
        token bigint NOT NULL
      );
      INSERT INTO leader_fence (id, token) VALUES (1, 0);

      CREATE TYPE round_phase AS ENUM ('BETTING', 'RUNNING', 'CRASHED', 'SETTLED');

      -- Timestamps that decide money are epoch milliseconds as double precision: the nominal
      -- crash instant is fractional and must round-trip exactly.
      CREATE TABLE rounds (
        id               bigint PRIMARY KEY,           -- = position in the hash chain
        chain_id         integer NOT NULL REFERENCES fairness_chains(id),
        seed_hash        char(64) NOT NULL,
        seed             char(64),                     -- revealed at settlement
        crash_x100       bigint NOT NULL,
        phase            round_phase NOT NULL,
        betting_ends_at  double precision NOT NULL,
        started_at       double precision,
        crash_at         double precision,
        crashed_at       double precision,
        settled_at       double precision,
        fencing_token    bigint NOT NULL,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT seed_revealed_only_when_settled CHECK ((phase = 'SETTLED') = (seed IS NOT NULL))
      );
      CREATE INDEX rounds_settled_idx ON rounds (id DESC) WHERE phase = 'SETTLED';

      CREATE TYPE bet_status AS ENUM ('ACTIVE', 'CASHED_OUT', 'LOST');

      CREATE TABLE bets (
        id           uuid PRIMARY KEY,
        round_id     bigint NOT NULL REFERENCES rounds(id),
        user_id      uuid   NOT NULL REFERENCES users(id),
        amount       bigint NOT NULL CHECK (amount > 0),
        auto_x100    integer CHECK (auto_x100 IS NULL OR auto_x100 > 100),
        status       bet_status NOT NULL DEFAULT 'ACTIVE',
        cashout_x100 integer,
        payout       bigint,
        auto_cashout boolean,
        client_key   text NOT NULL,
        placed_at    double precision NOT NULL,
        cashed_at    double precision,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (round_id, user_id),
        UNIQUE (user_id, client_key),
        CONSTRAINT cashout_fields CHECK ((status = 'CASHED_OUT') = (cashout_x100 IS NOT NULL))
      );
      CREATE INDEX bets_user_idx ON bets (user_id, created_at DESC);

      -- Transactional outbox: written in the same transaction as the state change, published
      -- to Kafka by a relay. An event can never exist without its ledger entry, or vice versa.
      CREATE TABLE outbox (
        id           bigserial PRIMARY KEY,
        topic        text  NOT NULL,
        key          text  NOT NULL,
        payload      jsonb NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      );
      CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE IF EXISTS outbox, bets, rounds, leader_fence, seed_chain, fairness_chains,
        postings, ledger_transactions, accounts, users CASCADE;
      DROP FUNCTION IF EXISTS forbid_ledger_mutation, assert_transaction_balanced;
      DROP TYPE IF EXISTS bet_status, round_phase, ledger_tx_type, account_kind;
    `);
  }
}
