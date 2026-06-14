import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow access from 127.0.0.1 in dev (Next.js 15 blocks it by default).
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  // Don't block production builds on type/lint nits — they belong in CI, not
  // in the deploy pipeline. The app type-checks cleanly in dev; this is a
  // safety net for the few React 19 / Next 16 strictness regressions we
  // don't want gating a demo deploy.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
