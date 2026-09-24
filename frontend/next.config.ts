import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // Production: static export to out/, served by FastAPI on the same origin.
  // Development: `next dev` proxies /api/* to the backend (rewrites are not
  // supported with output: "export", so they only apply in dev).
  ...(isDev
    ? {
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
        },
      }
    : { output: "export" as const }),
  // gzip in the dev proxy buffers the SSE stream, so events never arrive.
  compress: false,
  images: { unoptimized: true },
  trailingSlash: false,
  devIndicators: false,
};

export default nextConfig;
