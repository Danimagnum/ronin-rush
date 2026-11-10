// Fresh database and Redis DB for every e2e run, so rounds and balances start from a known state.
// Runs as part of the API web-server command (Playwright starts web servers before globalSetup)
// and reads the same DATABASE_URL / REDIS_URL the API is started with.
import Redis from 'ioredis';
import pg from 'pg';

const { DATABASE_URL, REDIS_URL } = process.env;
const db = DATABASE_URL.split('/').pop();
const admin = new pg.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${db}`);
await admin.end();
const redis = new Redis(REDIS_URL);
await redis.flushdb();
redis.disconnect();
console.log(`e2e: reset ${db} and ${REDIS_URL}`);
