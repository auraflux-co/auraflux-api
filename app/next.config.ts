import path from 'path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Required for New Relic APM instrumentation (instrumentation.ts)
  experimental: {
    instrumentationHook: true,
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
