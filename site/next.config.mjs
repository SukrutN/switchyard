// The site exports static files so GitHub Pages can serve it from CI.
// basePath applies only in CI builds (Pages serves the repo under its
// own name); local dev and local builds ride the root, like dev should.
const isCI = process.env.GITHUB_ACTIONS === "true";
const BASE_PATH = "/switchyard-site";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: isCI ? BASE_PATH : "",
  images: { unoptimized: true },
};

export default nextConfig;
