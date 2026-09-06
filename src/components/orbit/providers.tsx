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
    return () => window.removeEventListener("orbit:data-synced", onSynced);
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
