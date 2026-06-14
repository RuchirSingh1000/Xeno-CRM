import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow access from 127.0.0.1 in dev (Next.js 15 blocks it by default).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
