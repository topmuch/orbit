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
    // 1. Service Worker — JAMAIS en dev : le SW met en cache-first les
    //    chunks /_next/ (noms stables non hashés en dev) → le navigateur
    //    rejouerait indéfiniment le bundle du premier chargement, ignorant
    //    les rechargements/HMR (boucles de refetch fantômes). En production
    //    les chunks sont hashés par contenu → cache-first sûr.
    if ("serviceWorker" in navigator && process.env.NODE_ENV !== "development") {
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
