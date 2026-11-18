import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Genera .next/standalone para la imagen Docker (en Vercel no afecta).
  output: "standalone",
  poweredByHeader: false,
  // react-leaflet reexporta todo desde su índice: Next lo convierte en imports directos (bundle-barrel-imports).
  experimental: {
    optimizePackageImports: ["react-leaflet"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "cache-control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
