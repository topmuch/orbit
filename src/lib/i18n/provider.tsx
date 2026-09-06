"use client";

// Orbit — i18n : provider React (contexte client) + hook useI18n
// ─────────────────────────────────────────────────────────────────────────────
// t("domaine.clé", { params }) → traduction de la locale courante, repli sur le
// français (source de vérité), repli final sur la clé elle-même (débuggage).
// setLocale() persiste le cookie NEXT_LOCALE (1 an) et met à jour <html lang>
// sans rechargement — la valeur initiale vient du serveur (cookie lu dans
// layout.tsx) pour un rendu sans flash.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "./config";
import fr from "./locales/fr";
import en from "./locales/en";
import es from "./locales/es";

/** Dictionnaires chargés statiquement (3 langues ≈ 15 Ko — bundle raisonnable). */
const DICTS: Record<Locale, unknown> = { fr, en, es };

export type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Traduction avec repli FR puis clé. */
  t: (key: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/** Résout un chemin pointé ("command.newEvent") dans un dictionnaire. */
function lookupPath(dict: unknown, path: string): string | undefined {
  let node: unknown = dict;
  for (const seg of path.split(".")) {
    if (node && typeof node === "object" && seg in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  /** Locale lue côté serveur (cookie) — évite tout mismatch d'hydratation. */
  initialLocale?: string;
}) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    isLocale(initialLocale) ? initialLocale : defaultLocale
  );

  const setLocale = useCallback((next: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let str =
        lookupPath(DICTS[locale], key) ??
        lookupPath(DICTS[defaultLocale], key) ??
        key;
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          str = str.replaceAll(`{${name}}`, String(value));
        }
      }
      return str;
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Hook i18n — à utiliser dans tout composant client. */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n doit être utilisé sous <I18nProvider>");
  return ctx;
}
