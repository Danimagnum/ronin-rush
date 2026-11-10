/**
 * Sentry bootstrap. Must be imported before anything else in main.ts so its instrumentation
 * hooks load first. Completely inert unless SENTRY_DSN is set.
 */
import * as Sentry from '@sentry/nestjs';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    serverName: process.env.INSTANCE_ID,
  });
}

export { Sentry };
