import "./globals.css"
import { Providers } from "./providers"
import { inter, cormorant } from "./fonts"
import { ThemeBootstrap } from "./ThemeBootstrap"
import { LocaleProvider } from "./components/LocaleProvider"
import { CapacitorInit } from "./components/CapacitorInit"
import { SessionCaptureBridge } from "./components/SessionCaptureBridge"
import { UiToast } from "./components/UiToast"
import { getRequestLocale, getServerCopy } from "./copy/server"

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
    { media: '(prefers-color-scheme: dark)', color: '#1e1b2e' },
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
      data-sophia-theme="light"
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
                  var DARK_THEMES = ['moonlit-embrace', 'moonlit', 'dark', 'accessible-indigo', 'accessible-slate', 'accessible-charcoal'];
                  var theme = localStorage.getItem('sophia-theme') || 'light';
                  document.documentElement.dataset.sophiaTheme = theme;
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
