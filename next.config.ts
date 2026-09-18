import type { NextConfig } from 'next'
import { validateV2DeploymentEnvironment } from './src/lib/v2-runtime-safety'

validateV2DeploymentEnvironment()

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000'],
    },
  },
}

export default nextConfig
