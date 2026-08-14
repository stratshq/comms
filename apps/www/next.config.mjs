import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Trace from the monorepo root so pnpm's symlinked node_modules resolve.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
