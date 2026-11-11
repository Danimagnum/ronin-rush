/**
 * Sentry bootstrap, imported first in main.ts. The SDK is only loaded when SENTRY_DSN is set:
 * requiring it costs ~40 s of a cold start on the Synology NAS (measured 2026-11-11), and
 * without a DSN it would do nothing anyway. The exported facade is safe to call either way.
 */
import type * as SentrySdk from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;
let sdk: typeof SentrySdk | null = null;

if (dsn) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sdk = require('@sentry/nestjs') as typeof SentrySdk;
  sdk.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    serverName: process.env.INSTANCE_ID,
  });
}

export const Sentry = {
  enabled: sdk !== null,
  captureException: (e: unknown, context?: Parameters<typeof SentrySdk.captureException>[1]) => sdk?.captureException(e, context),
  captureMessage: (message: string, level?: Parameters<typeof SentrySdk.captureMessage>[1]) => sdk?.captureMessage(message, level),
};
