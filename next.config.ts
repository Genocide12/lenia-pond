import type { NextConfig } from "next";

/** Статический экспорт для GitHub Pages: EXPORT_STATIC=1 [REPO_NAME=name] bun run build:export */
const isExport = process.env.EXPORT_STATIC === "1";
const REPO_NAME = process.env.REPO_NAME || "lenia-pond";

const nextConfig: NextConfig = {
  ...(isExport
    ? {
        output: "export",
        basePath: `/${REPO_NAME}`,
        trailingSlash: true,
        images: { unoptimized: true },
        distDir: ".next-export", // не конфликтует с запущенным next dev
      }
    : { output: "standalone" }),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
