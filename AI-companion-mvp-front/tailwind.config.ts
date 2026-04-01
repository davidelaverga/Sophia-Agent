import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // Safelist classes that might not be detected during build
  safelist: [
    'bg-sophia-surface',
    'bg-sophia-bubble',
    'text-sophia-text',
    'text-sophia-text2',
    'border-sophia-surface-border',
  ],
  theme: {
    // Custom breakpoints for better mobile handling
    screens: {
      'xs': '400px',  // Small phones
      'sm': '640px',  // Large phones / small tablets
      'md': '768px',  // Tablets
      'lg': '1024px', // Laptops
      'xl': '1280px', // Desktops
      '2xl': '1536px',
    },
    extend: {
      colors: {
        sophia: {
          purple: "var(--sophia-purple)",
          glow: "var(--sophia-glow)",
          bg: "var(--bg)",
          text: "var(--text)",
          text2: "var(--text-2)",
          user: "var(--user-bubble)",
          bubble: "var(--sophia-bubble)",
          reply: "var(--sophia-bubble)",
          btn: "var(--btn-active)",
          error: "var(--error)",
          surface: "var(--card-bg)",
          "surface-border": "var(--card-border)",
          input: "var(--input-bg)",
          "input-border": "var(--input-border)",
          button: "var(--button-bg)",
          "button-hover": "var(--button-hover)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      borderRadius: {
        md: "var(--radius-md)",
        xl: "var(--radius-xl)",
        "2xl": "1rem",
        "3xl": "1rem",
        "4xl": "1.25rem",
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(ellipse at center, var(--tw-gradient-stops))',
      },
      spacing: {
        page: "24px",
        bubble: "16px",
      },
      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "0.7" },
          "50%": { opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        fadeOut: {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        fadeInUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.8", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.02)" },
        },
        breatheSlow: {
          "0%, 100%": { opacity: "0.7", transform: "scale(1)" },
          "50%": { opacity: "0.95", transform: "scale(1.01)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-4px)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        glowBreathe: {
          "0%, 100%": { 
            opacity: "0.4",
            transform: "scale(0.95)",
            boxShadow: "0 0 8px rgba(139, 92, 246, 0.3)"
          },
          "50%": { 
            opacity: "1",
            transform: "scale(1.1)",
            boxShadow: "0 0 20px rgba(139, 92, 246, 0.6), 0 0 40px rgba(167, 139, 250, 0.3)"
          },
        },
        ringBreathe: {
          "0%, 100%": { 
            boxShadow: "0 0 0 2px rgba(139, 92, 246, 0.2), 0 0 20px rgba(139, 92, 246, 0.1)"
          },
          "50%": { 
            boxShadow: "0 0 0 2px rgba(139, 92, 246, 0.4), 0 0 40px rgba(139, 92, 246, 0.3), 0 0 60px rgba(167, 139, 250, 0.2)"
          },
        },
        confetti: {
          "0%": { 
            transform: "translateY(-20px) rotate(0deg)",
            opacity: "1"
          },
          "75%": {
            opacity: "1"
          },
          "100%": { 
            transform: "translateY(100vh) rotate(720deg)",
            opacity: "0"
          },
        },
        heartbeat: {
          "0%, 100%": { transform: "scale(1)" },
          "10%, 30%": { transform: "scale(1.1)" },
          "20%": { transform: "scale(1.2)" },
        },
        "pulse-slow": {
          "0%, 100%": { opacity: "0.4", transform: "scale(1)" },
          "50%": { opacity: "0.8", transform: "scale(1.1)" },
        },
        "badge-glow": {
          "0%, 100%": { 
            boxShadow: "0 4px 15px rgba(147, 51, 234, 0.3)"
          },
          "50%": { 
            boxShadow: "0 4px 25px rgba(147, 51, 234, 0.5), 0 0 40px rgba(192, 132, 252, 0.3)"
          },
        },
        "pulse-reply": {
          "0%, 100%": { 
            transform: "scale(1)",
            boxShadow: "0 0 0 0 rgba(139, 92, 246, 0.4)"
          },
          "50%": { 
            transform: "scale(1.08)",
            boxShadow: "0 0 0 8px rgba(139, 92, 246, 0)"
          },
        },
        "counter-pop": {
          "0%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.1)" },
          "100%": { transform: "scale(1)" },
        },
        "scaleIn": {
          "0%": { transform: "scale(0)", opacity: "0" },
          "50%": { transform: "scale(1.2)" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        // Memory Orbit animations
        "orbitFloat": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        "keepAscend": {
          "0%": { transform: "translateY(0) scale(1)", opacity: "1" },
          "100%": { transform: "translateY(-100px) scale(0.9)", opacity: "0" },
        },
        "discardDissolve": {
          "0%": { transform: "scale(1)", opacity: "1", filter: "blur(0)" },
          "100%": { transform: "scale(0.75)", opacity: "0", filter: "blur(8px)" },
        },
        "disperseParticle": {
          "0%": { 
            transform: "translate(0, 0) scale(1)", 
            opacity: "1" 
          },
          "100%": { 
            transform: "translate(var(--disperse-x, 50px), var(--disperse-y, -50px)) scale(0)", 
            opacity: "0" 
          },
        },
        "glowPulse": {
          "0%, 100%": { 
            opacity: "0.3",
            transform: "scale(1)"
          },
          "50%": { 
            opacity: "0.6",
            transform: "scale(1.1)"
          },
        },
        // Cosmic Background animations
        "cosmicTwinkle": {
          "0%, 100%": { opacity: "0.12" },
          "50%": { opacity: "0.3" },
        },
        "bloomBreathe": {
          "0%, 100%": { opacity: "0.6", transform: "translate(-50%, -50%) scale(1)" },
          "50%": { opacity: "0.85", transform: "translate(-50%, -50%) scale(1.08)" },
        },
        "bloomDrift": {
          "0%, 100%": { opacity: "0.5", transform: "translateX(0) scale(1)" },
          "33%": { opacity: "0.7", transform: "translateX(15px) scale(1.04)" },
          "66%": { opacity: "0.55", transform: "translateX(-10px) scale(0.97)" },
        },
        "bloomDriftReverse": {
          "0%, 100%": { opacity: "0.45", transform: "translateX(0) scale(1)" },
          "33%": { opacity: "0.6", transform: "translateX(-12px) scale(1.03)" },
          "66%": { opacity: "0.5", transform: "translateX(8px) scale(0.98)" },
        },
        "borderStreak": {
          "0%": { "--streak-angle": "0deg" },
          "100%": { "--streak-angle": "360deg" },
        },
        // Context-world particle animations
        "bokehFloat": {
          "0%, 100%": { transform: "translateY(0) translateX(0) scale(1)", opacity: "0.1" },
          "25%": { transform: "translateY(-12px) translateX(6px) scale(1.04)", opacity: "0.14" },
          "50%": { transform: "translateY(-6px) translateX(-8px) scale(0.97)", opacity: "0.08" },
          "75%": { transform: "translateY(-18px) translateX(4px) scale(1.02)", opacity: "0.12" },
        },
        "workFloat": {
          "0%, 100%": { transform: "translateY(0)", opacity: "0.03" },
          "50%": { transform: "translateY(-8px)", opacity: "0.045" },
        },
        "workScreenGlow": {
          "0%, 100%": { opacity: "0.6", transform: "scaleX(1)" },
          "40%": { opacity: "0.9", transform: "scaleX(1.05)" },
          "70%": { opacity: "0.5", transform: "scaleX(0.97)" },
        },
      },
      animation: {
        pulseSoft: "pulseSoft 2s ease-in-out infinite",
        fadeIn: "fadeIn 400ms ease-out",
        fadeOut: "fadeOut 300ms ease-out forwards",
        fadeInUp: "fadeInUp 500ms ease-out",
        breathe: "breathe 3s ease-in-out infinite",
        breatheSlow: "breatheSlow 4s ease-in-out infinite",
        float: "float 3s ease-in-out infinite",
        shimmer: "shimmer 3s ease-in-out infinite",
        glowBreathe: "glowBreathe 2.5s ease-in-out infinite",
        ringBreathe: "ringBreathe 3s ease-in-out infinite",
        confetti: "confetti 4s ease-out forwards",
        heartbeat: "heartbeat 1.5s ease-in-out infinite",
        "pulse-slow": "pulse-slow 3s ease-in-out infinite",
        "badge-glow": "badge-glow 2s ease-in-out infinite",
        "pulse-reply": "pulse-reply 1.5s ease-in-out infinite",
        "counter-pop": "counter-pop 200ms ease-out",
        "scaleIn": "scaleIn 300ms ease-out forwards",
        // Memory Orbit animations
        "orbitFloat": "orbitFloat 4s ease-in-out infinite",
        "keepAscend": "keepAscend 600ms ease-out forwards",
        "discardDissolve": "discardDissolve 500ms ease-out forwards",
        "glowPulse": "glowPulse 2s ease-in-out infinite",
        // Cosmic Background animations
        "cosmicTwinkle": "cosmicTwinkle 4s ease-in-out infinite",
        "bloomBreathe": "bloomBreathe 6s ease-in-out infinite",
        "bloomDrift": "bloomDrift 10s ease-in-out infinite",
        "bloomDriftReverse": "bloomDriftReverse 12s ease-in-out infinite",
        "borderStreak": "borderStreak 1.5s linear infinite",
        "bokehFloat": "bokehFloat 8s ease-in-out infinite",
        "workFloat": "workFloat 14s ease-in-out infinite",
        "workScreenGlow": "workScreenGlow 7s ease-in-out infinite",
      },
    },
  },
  plugins: [],
}

export default config
