/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@haltmarket/ledger-client', '@haltmarket/shared-types'],
};

export default nextConfig;
