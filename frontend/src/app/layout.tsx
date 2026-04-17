import "./globals.css"
import { CapacitorInit } from "./components/CapacitorInit"
import { LocaleProvider } from "./components/LocaleProvider"
import { SessionCaptureBridge } from "./components/SessionCaptureBridge"
import { UiToast } from "./components/UiToast"
import { getRequestLocale, getServerCopy } from "./copy/server"
import { inter, cormorant } from "./fonts"
import { Providers } from "./providers"
import {
  COSMIC_THEME_ID,
  DARK_THEMES,
  LEGACY_THEME_ALIASES,
  SOPHIA_THEME_STORAGE_KEY,
} from "./theme"
import { ThemeBootstrap } from "./ThemeBootstrap"
import { VisualTierBootstrap } from "./VisualTierBootstrap"

export async function generateMetadata() {
  const locale = await getRequestLocale()
  const copy = await getServerCopy(locale)

  return {
    title: `${copy.brand.name} – ${copy.brand.tagline}`,
    description: copy.auth.subtitle,
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icon.png", type: "image/png" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-icon.png", type: "image/png" }],
    },
    manifest: "/manifest.json",
  }
}

// Viewport configuration for mobile optimization
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f7fa' },
    { media: '(prefers-color-scheme: dark)', color: '#030308' },
  ],
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const locale = await getRequestLocale()

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${cormorant.variable}`}
      data-sophia-theme={COSMIC_THEME_ID}
      suppressHydrationWarning
    >
      <head>
        {/* DNS prefetch for external resources */}
        <link rel="dns-prefetch" href="https://api.openai.com" />
        <link rel="preconnect" href="https://api.openai.com" crossOrigin="anonymous" />
        
        {/* Preload critical theme script */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var STORAGE_KEY = ${JSON.stringify(SOPHIA_THEME_STORAGE_KEY)};
                  var DARK_THEMES = ${JSON.stringify(DARK_THEMES)};
                  var LEGACY_THEME_ALIASES = ${JSON.stringify(LEGACY_THEME_ALIASES)};
                  var storedTheme = localStorage.getItem(STORAGE_KEY);
                  var theme = LEGACY_THEME_ALIASES[storedTheme] || storedTheme || ${JSON.stringify(COSMIC_THEME_ID)};
                  document.documentElement.dataset.sophiaTheme = theme;
                  if (storedTheme !== theme) {
                    localStorage.setItem(STORAGE_KEY, theme);
                  }
                  if (DARK_THEMES.indexOf(theme) !== -1) {
                    document.documentElement.classList.add('dark');
                  } else {
                    document.documentElement.classList.remove('dark');
                  }
                } catch {
                  // localStorage may be unavailable (private browsing, SSR)
                  // Fallback to light theme is already applied via || 'light'
                }
              })();
            `,
          }}
        />
      </head>
      <body className="bg-sophia-bg text-sophia-text antialiased">
        <LocaleProvider initialLocale={locale}>
          <Providers>
            <ThemeBootstrap />
            <VisualTierBootstrap />
            <CapacitorInit />
            <SessionCaptureBridge />
            <UiToast />
            <div className="min-h-[100svh]">{children}</div>
          </Providers>
        </LocaleProvider>
      </body>
    </html>
  )
}
