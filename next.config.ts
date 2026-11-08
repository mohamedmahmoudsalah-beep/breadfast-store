import type { NextConfig } from "next";

/**
 * Static export: the site is plain HTML/JS/CSS hosted on Cloudflare Pages (free).
 * All business logic and security live in Supabase (Postgres functions, RLS, Edge Functions).
 */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
