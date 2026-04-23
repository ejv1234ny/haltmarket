/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@haltmarket/ledger-client', '@haltmarket/shared-types'],
  // Privy ships optional integrations (Farcaster / Solana / etc.) that webpack
  // tries to resolve at build time even when we only use Ethereum on Base.
  // Alias them to false so the bundle builds without installing every SDK.
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      '@farcaster/mini-app-solana': false,
      '@farcaster/miniapp-wagmi-connector': false,
      '@farcaster/miniapp-sdk': false,
      'pino-pretty': false,
      encoding: false,
    };
    return config;
  },
};

export default nextConfig;
