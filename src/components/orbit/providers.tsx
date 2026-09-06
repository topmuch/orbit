"use client";

// Orbit — Providers globaux (React Query, thème, toasts, PWA)

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { PwaRegister } from "@/components/orbit/pwa-register";

export function Providers({ children }: { children: React.ReactNode }) {
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
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem={false}
        disableTransitionOnChange
      >
        {children}
        <Toaster richColors position="top-center" closeButton />
        <PwaRegister />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
