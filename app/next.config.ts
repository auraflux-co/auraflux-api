import path from 'path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // instrumentation.ts is supported natively in Next.js 15+ — no config flag needed
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
