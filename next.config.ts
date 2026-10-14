import type { NextConfig } from "next";
const config: NextConfig = {
  // PGlite ships WebAssembly and data files that must load from node_modules.
  serverExternalPackages: ["sharp", "@electric-sql/pglite"],
  // The server renders slides with the bundled TikTok fonts, which it reads
  // from public/; serverless functions only contain files listed here.
  outputFileTracingIncludes: {
    "/api/**/*": ["./public/fonts/**/*"],
  },
  devIndicators: false,
  poweredByHeader: false,
  headers() {
    // The API guard only covers /api. Refuse framing everywhere so another
    // site cannot load the studio in an iframe and redirect clicks into it.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};
export default config;
