/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "Cascadia Code", "Consolas", "monospace"],
      },
      colors: {
        // Semantic colors per user_experience.md #36
        fvp: {
          bg: "#0e0f12",
          surface: "#16181d",
          surface2: "#1c1f26",
          border: "#2a2e38",
          text: "#e6e8ee",
          muted: "#8a8f9c",
          accent: "#4f8cff",
          ok: "#3fb950",
          warn: "#d29922",
          err: "#f85149",
        },
      },
    },
  },
  plugins: [],
};
