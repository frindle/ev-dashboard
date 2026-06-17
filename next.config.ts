import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/.well-known/appspecific/com.tesla.3p.public-key.pem',
        destination: '/api/tesla-public-key',
      },
    ];
  },
};

export default nextConfig;
