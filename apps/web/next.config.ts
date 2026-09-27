import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@studyly/core", "@studyly/db"],
};

export default nextConfig;
