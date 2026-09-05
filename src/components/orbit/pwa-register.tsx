"use client";

// Orbit — Enregistrement du Service Worker + suivi en ligne/hors ligne + installation PWA

import { useEffect } from "react";
import { toast } from "sonner";
import {
  usePwaStore,
  captureInstallPrompt,
  getInstallPrompt,
  type InstallPromptEvent,
} from "@/lib/pwa-store";

export function PwaRegister() {
  const setOnline = usePwaStore((s) => s.setOnline);
  const setCanInstall = usePwaStore((s) => s.setCanInstall);
  const setInstalled = usePwaStore((s) => s.setInstalled);
  const setSwReady = usePwaStore((s) => s.setSwReady);

  useEffect(() => {
    // 1. Service Worker — enregistré PARTOUT (dev inclus) : le sw.js v3
    //    DÉSACTIVE son handler fetch en dev (localhost) → aucun risque de
    //    bundle gelé (bug 13-b : cache-first des chunks /_next/ non hashés),
    //    mais les notifications push restent testables en développement.
    //    En production, cache-first sûr (chunks hashés par contenu).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => setSwReady(true))
        .catch(() => setSwReady(false));
    }

    // 2. Connectivité
    const updateOnline = () => {
      const online = navigator.onLine;
      setOnline(online);
      if (online) toast.success("Connexion rétablie", { description: "Orbit resynchronise vos données." });
      else toast.warning("Mode hors ligne", { description: "Consultez vos données en cache local." });
    };
    setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    // 3. Installation PWA
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      captureInstallPrompt(e as InstallPromptEvent);
      setCanInstall(true);
    };
    const onInstalled = () => {
      setInstalled(true);
      setCanInstall(false);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia("(display-mode: standalone)").matches) setInstalled(true);

    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [setOnline, setCanInstall, setInstalled, setSwReady]);

  return null;
}

/** Déclenche l'invite d'installation native — retourne le choix utilisateur */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = getInstallPrompt();
  if (!prompt) return "unavailable";
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}
