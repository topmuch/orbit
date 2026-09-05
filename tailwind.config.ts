import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

/**
 * ⚠️ Tailwind CSS 4 — configuration « CSS-first » :
 * la SOURCE DE VÉRITÉ de la palette est le bloc `@theme` de
 * `src/app/globals.css` (aucune directive `@config` ne charge ce fichier).
 * Ce fichier JS documente la palette de marque pour référence :
 *
 *   Orbit — bleu profond #0A2540 (primaire clair) · cyan #00D4FF
 *   (secondaire / action en sombre) · orange #FF6B35 (accent)
 *   + neutres #F5F5F7 → #1A1A1A (intermédiaires gris).
 *
 * Les mappings sémantiques ci-dessous pointent vers les variables CSS
 * définies dans globals.css (`:root` et `.dark`).
 */
const config: Config = {
    darkMode: "class",
    content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
        extend: {
                colors: {
                        /* ---- Couleurs de marque Orbit ---- */
                        orbit: {
                                deep: "#0A2540", // bleu profond — primaire (mode clair)
                                cyan: "#00D4FF", // cyan — action / ring
                                "cyan-strong": "#0074A0", // cyan foncé — texte AA sur fond clair
                                "cyan-soft": "#7FE6FF", // cyan clair — texte sur fond sombre
                                accent: "#FF6B35", // orange — accent de marque
                                "accent-strong": "#E8601F", // orange foncé — hover
                        },
                        /* ---- Neutres Orbit (#F5F5F7 → #1A1A1A) ---- */
                        neutral: {
                                50: "#F5F5F7",
                                100: "#EBEBEE",
                                200: "#D6D6DB",
                                300: "#B8B8BF",
                                400: "#8E8E96",
                                500: "#6C6C75",
                                600: "#4E4E56",
                                700: "#3A3A40",
                                800: "#2A2A2F",
                                900: "#232326",
                                950: "#1A1A1A",
                        },
                        /* ---- Sémantique (variables CSS de globals.css) ---- */
                        background: "var(--background)",
                        foreground: "var(--foreground)",
                        card: {
                                DEFAULT: "var(--card)",
                                foreground: "var(--card-foreground)",
                        },
                        popover: {
                                DEFAULT: "var(--popover)",
                                foreground: "var(--popover-foreground)",
                        },
                        primary: {
                                DEFAULT: "var(--primary)",
                                foreground: "var(--primary-foreground)",
                        },
                        secondary: {
                                DEFAULT: "var(--secondary)",
                                foreground: "var(--secondary-foreground)",
                        },
                        muted: {
                                DEFAULT: "var(--muted)",
                                foreground: "var(--muted-foreground)",
                        },
                        accent: {
                                DEFAULT: "var(--accent)",
                                foreground: "var(--accent-foreground)",
                        },
                        destructive: {
                                DEFAULT: "var(--destructive)",
                                foreground: "var(--destructive-foreground)",
                        },
                        border: "var(--border)",
                        input: "var(--input)",
                        ring: "var(--ring)",
                        chart: {
                                "1": "var(--chart-1)",
                                "2": "var(--chart-2)",
                                "3": "var(--chart-3)",
                                "4": "var(--chart-4)",
                                "5": "var(--chart-5)",
                        },
                },
                borderRadius: {
                        lg: "var(--radius)",
                        md: "calc(var(--radius) - 2px)",
                        sm: "calc(var(--radius) - 4px)",
                },
        },
  },
  plugins: [tailwindcssAnimate],
};
export default config;
