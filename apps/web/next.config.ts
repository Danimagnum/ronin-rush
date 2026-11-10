import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Self-contained server for the Docker image; tracing from the monorepo root picks up workspace deps.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
