"use client";

// Orbit — Providers globaux (React Query, thème, toasts, PWA)

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { PwaRegister } from "@/components/orbit/pwa-register";
import { I18nProvider } from "@/lib/i18n/provider";

export function Providers({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  /** Locale lue côté serveur (cookie NEXT_LOCALE) — zéro flash/mismatch. */
  initialLocale?: string;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  // Task 7 offline : la file d'attente des mutations rejouée avec succès
  // → les données serveur ont changé → on rafraîchit TOUTES les requêtes.
  useEffect(() => {
    const onSynced = () => {
      queryClient.invalidateQueries()
    };
    window.addEventListener("orbit:data-synced", onSynced);

    // Offline-first v2 : le moteur de sync a PULLÉ des changements (autre
    // appareil, service de rappels, sync IMAP…) → rafraîchissement des vues.
    const onPullCompleted = (event: Event) => {
      const detail = (event as CustomEvent<{ pulled?: number }>).detail;
      if (detail && typeof detail.pulled === "number" && detail.pulled > 0) {
        queryClient.invalidateQueries();
      }
    };
    window.addEventListener("orbit:sync-completed", onPullCompleted);

    return () => {
      window.removeEventListener("orbit:data-synced", onSynced);
      window.removeEventListener("orbit:sync-completed", onPullCompleted);
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Thème : suivi du PRÉFÉRENCE SYSTÈME par défaut (features avancées) —
          next-thèmes pose la classe .dark avant peinture (anti-flash) et
          bascule automatiquement quand l'OS change de mode. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <I18nProvider initialLocale={initialLocale}>
          {children}
          <Toaster richColors position="top-center" closeButton />
          <PwaRegister />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
