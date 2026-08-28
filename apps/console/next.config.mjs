/** @type {import('next').NextConfig} */
export default {
  // The console imports @autopilot/core straight from source. One TypeScript build for the
  // whole repo, no separate compile step for the package (ADR 0001).
  transpilePackages: ["@autopilot/core"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};
