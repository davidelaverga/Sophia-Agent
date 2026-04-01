import type { CapacitorConfig } from '@capacitor/cli';

// Determine if we're in development mode
const isDev = process.env.NODE_ENV !== 'production';

const config: CapacitorConfig = {
  appId: 'com.sophia.companion',
  appName: 'Sophia',
  // For Capacitor with Next.js, we use live server mode
  // The webDir is only used when building a standalone APK/IPA
  webDir: '.next',
  
  // Server configuration
  server: {
    // For development with live reload, set your local IP:
    // Run: npm run dev:mobile
    // Then update this URL with your local IP
    url: isDev ? 'http://localhost:3000' : undefined,
    cleartext: isDev,
    
    // Allow navigation to external URLs (Supabase auth, Discord, etc.)
    allowNavigation: [
      'qtyqgvdkbhjfmnfkxyvm.supabase.co',
      'sophia-backend-g8fe.onrender.com',
      '*.discord.com',
      'discord.com',
    ],
  },
  
  // Android-specific configuration
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: true, // Set to false for production
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  
  // iOS-specific configuration
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'Sophia',
  },
  
  // Plugins configuration
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#0a0a0f',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a0f',
    },
    Haptics: {
      // Haptics are enabled by default
    },
  },
};

export default config;
