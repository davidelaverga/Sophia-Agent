/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8001'

const websocketUrl = (() => {
  if (apiUrl.startsWith('https://')) return apiUrl.replace('https://', 'wss://')
  if (apiUrl.startsWith('http://')) return apiUrl.replace('http://', 'ws://')
  return apiUrl
})()

const nextConfig = {
  // Enable static export for Capacitor mobile builds
  output: process.env.CAPACITOR_BUILD === 'true' ? 'export' : undefined,
  
  // Disable image optimization for static export (Capacitor)
  images: process.env.CAPACITOR_BUILD === 'true' ? { unoptimized: true } : undefined,
  
  // Skip ESLint during Capacitor builds (lint separately in CI)
  eslint: process.env.CAPACITOR_BUILD === 'true' ? { ignoreDuringBuilds: true } : undefined,
  
  // Skip TypeScript errors during Capacitor builds
  typescript: process.env.CAPACITOR_BUILD === 'true' ? { ignoreBuildErrors: true } : undefined,
  
  // Environment variables (Vercel will handle these automatically)
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  },
  
  // Performance optimizations
  experimental: {
    optimizePackageImports: ['lucide-react', '@supabase/supabase-js', 'zustand'],
  },
  
  // Compiler optimizations
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },

  // ==========================================================================
  // SECURITY HEADERS
  // ==========================================================================
  async headers() {
    return [
      {
        // Apply to all routes
        source: '/(.*)',
        headers: [
          // Prevent MIME type sniffing
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Prevent clickjacking
          { key: 'X-Frame-Options', value: 'DENY' },
          // XSS protection (legacy browsers)
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          // Control referrer information
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Prevent DNS prefetching leaks
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          // HTTPS enforcement (only in production)
          ...(process.env.NODE_ENV === 'production' 
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] 
            : []
          ),
          // Permissions Policy - restrict browser features
          { 
            key: 'Permissions-Policy', 
            value: 'camera=(self), microphone=(self), geolocation=(), interest-cohort=()' 
          },
          // Content Security Policy - the most critical XSS protection
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net", // Next.js requires these
              "style-src 'self' 'unsafe-inline'", // Tailwind/CSS-in-JS needs inline styles
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' " + [
                apiUrl,
                websocketUrl,
                gatewayUrl,
                ...(process.env.NODE_ENV !== 'production'
                  ? [
                      'http://127.0.0.1:8000', 'ws://127.0.0.1:8000', 'http://localhost:8000', 'ws://localhost:8000',
                      'http://127.0.0.1:8001', 'ws://127.0.0.1:8001', 'http://localhost:8001', 'ws://localhost:8001',
                    ]
                  : []),
                process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://*.supabase.co',
                'wss://*.supabase.co', // Supabase realtime
                'https://api.cartesia.ai', // Voice API
                'https://cdn.jsdelivr.net', // External CDN assets
                'https://*.mem0.ai', // Mem0 APIs
                'https://*.stream-io-api.com', // Stream Video REST API
                'wss://*.stream-io-api.com', // Stream Video WebSocket
                'https://*.stream-io-video.com', // Stream Video hint/SFU
                'wss://*.stream-io-video.com', // Stream SFU WebSocket signaling
                'https://*.getstream.io', // Stream CDN/edge
                'turn:*', // WebRTC TURN servers
                'stun:*', // WebRTC STUN servers
              ].join(' '),
              "media-src 'self' blob:", // Audio playback
              "worker-src 'self' blob:", // Web workers
              "frame-ancestors 'none'", // Prevent embedding (same as X-Frame-Options)
              "base-uri 'self'",
              "form-action 'self'",
              "upgrade-insecure-requests",
            ].join('; ')
          },
        ],
      },
      {
        // Extra security for API routes - no caching of sensitive data
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
    ];
  },

  // Suppress known warnings from OpenTelemetry instrumentation
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.ignoreWarnings = [
        { module: /node_modules\/require-in-the-middle/ },
        { module: /node_modules\/@opentelemetry\/instrumentation/ },
      ]
    }
    return config
  },
  
  // Bundle analyzer (uncomment to analyze)
  // webpack: (config, { isServer }) => {
  //   if (!isServer) {
  //     const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
  //     config.plugins.push(new BundleAnalyzerPlugin({ analyzerMode: 'static' }));
  //   }
  //   return config;
  // },
}

module.exports = nextConfig