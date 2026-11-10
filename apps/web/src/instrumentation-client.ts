/**
 * Browser-side Sentry, loaded by Next.js before the app. Inert unless NEXT_PUBLIC_SENTRY_DSN is
 * set, and imported lazily so the SDK (~70 kB) never ships to players when it is not configured.
 * (Source-map upload via withSentryConfig is left out on purpose: it needs an auth token at build time.)
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void import('@sentry/nextjs').then((Sentry) =>
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'development',
      tracesSampleRate: 0.1,
      // Noise from browser extensions and WebGL context loss on tab switches.
      ignoreErrors: [/ResizeObserver loop/, /WebGL context lost/],
    }),
  );
}
