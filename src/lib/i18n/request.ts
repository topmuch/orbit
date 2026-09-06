// Orbit — i18n : résolution de langue côté serveur
// ─────────────────────────────────────────────────────────────────────────────
// Équivalent « request.ts » de la spec : lit le cookie NEXT_LOCALE (posé par
// le provider client) pour servir <html lang> correct dès le premier rendu.
// Priorité : cookie > français. (Accept-Language écarté : l'utilisateur choisit
// explicitement sa langue dans l'UI — pas de négociation implicite.)

import "server-only";
import { cookies } from "next/headers";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "./config";

export async function getRequestLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const value = cookieStore.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : defaultLocale;
}
