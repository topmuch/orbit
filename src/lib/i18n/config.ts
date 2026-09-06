// Orbit — i18n : configuration des locales
// ─────────────────────────────────────────────────────────────────────────────
// Application mono-route (SPA `/`) → i18n côté client (cookie NEXT_LOCALE),
// SANS restructuration des routes en /fr /en /es. La préférence persiste en
// cookie (lisible côté serveur pour <html lang>) et le français reste la
// langue par défaut.
// Adaptation de la spec « next-intl » : même découpage (config / request /
// locales), implémentation provider maison sans middleware ni [locale].

export const locales = ["fr", "en", "es"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "fr";

export const localeNames: Record<Locale, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
};

export const localeFlags: Record<Locale, string> = {
  fr: "🇫🇷",
  en: "🇬🇧",
  es: "🇪🇸",
};

/** Nom de langue dans sa propre langue (labels des switchers). */
export const localeSelfNames: Record<Locale, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
};

export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Valide une locale arbitraire (cookie, query…). */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/** Locale date-fns correspondante (formats de dates localisés). */
export async function dateFnsLocale(locale: Locale) {
  switch (locale) {
    case "en": {
      const { enGB } = await import("date-fns/locale");
      return enGB;
    }
    case "es": {
      const { es } = await import("date-fns/locale");
      return es;
    }
    default: {
      const { fr } = await import("date-fns/locale");
      return fr;
    }
  }
}
