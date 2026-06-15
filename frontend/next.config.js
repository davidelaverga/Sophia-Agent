/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8001'
const appBuildId = process.env.NEXT_PUBLIC_APP_BUILD_ID
  || process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.RENDER_GIT_COMMIT
  || process.env.COMMIT_SHA
  || 'development'

const websocketUrl = (() => {
  if (apiUrl.startsWith('https://')) return apiUrl.replace('https://', 'wss://')
  if (apiUrl.startsWith('http://')) return apiUrl.replace('http://', 'ws://')
  return apiUrl
})()

const nextConfig = {
  // Enable static export for Capacitor mobile builds
  output: process.env.CAPACITOR_BUILD === 'true' ? 'export' : undefined,

  // Allow local Playwright runs against 127.0.0.1 without dev-origin warnings.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  
  // Disable image optimization for static export (Capacitor)
  images: process.env.CAPACITOR_BUILD === 'true' ? { unoptimized: true } : undefined,
  
  // Skip ESLint during builds (lint separately in CI)
  // Note: 'eslint' key removed in Next 16 — use CLI flags or separate lint step
  
  // Skip TypeScript errors during Capacitor builds
  typescript: process.env.CAPACITOR_BUILD === 'true' ? { ignoreBuildErrors: true } : undefined,
  
  // Environment variables (Vercel will handle these automatically)
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_BUILD_ID: appBuildId,
  },
  
  // Performance optimizations
  experimental: {
    optimizePackageImports: ['lucide-react', 'zustand'],
  },
  
  // Compiler optimizations
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },

  // Turbopack (default in Next 16) — webpack config below is kept for --webpack fallback
  turbopack: {},

  // Hide the Next.js dev indicator (floating badge) in development
  devIndicators: false,

  // ==========================================================================
  // SECURITY HEADERS
  // ==========================================================================
  async headers() {
    // Clickjacking defense is parameterized by frame policy so the artifact
    // preview content route can be framed SAME-ORIGIN by the Observatory while
    // every other route stays fully frame-denied. SAMEORIGIN / frame-ancestors
    // 'self' still blocks cross-origin embedding (the actual clickjacking
    // threat); it only permits the app to frame its own same-origin preview.
    const buildSecurityHeaders = ({ frameOptions, frameAncestors }) => [
      // Prevent MIME type sniffing
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      // Clickjacking defense
      { key: 'X-Frame-Options', value: frameOptions },
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
            'https://api.cartesia.ai', // Voice API
            'https://api.openai.com', // OpenAI Realtime browser SDP exchange
            'wss://generativelanguage.googleapis.com', // Gemini Live browser WebSocket
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
          `frame-ancestors ${frameAncestors}`, // Clickjacking defense (mirrors X-Frame-Options)
          "base-uri 'self'",
          "form-action 'self'",
          "upgrade-insecure-requests",
        ].join('; ')
      },
    ];

    return [
      {
        // All routes EXCEPT the artifact preview content route are fully
        // frame-denied. The negative lookahead is the Next.js-documented
        // "match all except" source form, so the content route is matched by
        // exactly one entry below (no header-precedence ambiguity).
        source: '/((?!api/artifacts/[^/]+/content).*)',
        headers: buildSecurityHeaders({ frameOptions: 'DENY', frameAncestors: "'none'" }),
      },
      {
        // Artifact preview content is rendered in a (sandboxed, for HTML)
        // same-origin <iframe> by the Observatory. Allow same-origin framing
        // here only; cross-origin embedding stays blocked.
        source: '/api/artifacts/:artifactId/content',
        headers: buildSecurityHeaders({ frameOptions: 'SAMEORIGIN', frameAncestors: "'self'" }),
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
    config.resolve = config.resolve || {}

    if (!isServer) {
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        axios: require.resolve('axios/dist/browser/axios.cjs'),
      }
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        http2: false,
      }
    }

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
