"use client";

// Orbit — Enregistrement du Service Worker + suivi en ligne/hors ligne + installation PWA
//            + REPLAY de la file d'attente offline (Task 7)

import { useEffect } from "react";
import { toast } from "sonner";
import {
  usePwaStore,
  captureInstallPrompt,
  getInstallPrompt,
  type InstallPromptEvent,
} from "@/lib/pwa-store";
import { replayQueue, refreshCount } from "@/lib/offline-queue";

export function PwaRegister() {
  const setOnline = usePwaStore((s) => s.setOnline);
  const setCanInstall = usePwaStore((s) => s.setCanInstall);
  const setInstalled = usePwaStore((s) => s.setInstalled);
  const setSwReady = usePwaStore((s) => s.setSwReady);

  useEffect(() => {
    // 1. Service Worker — enregistré PARTOUT (dev inclus) : le sw.js v4
    //    limite son handler fetch en dev aux GET /api (cache offline) et à
    //    la navigation de secours → aucun risque de bundle gelé (bug 13-b :
    //    les chunks /_next/ dev ne sont JAMAIS mis en cache), mais les
    //    notifications push ET la lecture offline restent testables en dev.
    //    En production, cache-first sûr (chunks hashés par contenu).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => setSwReady(true))
        .catch(() => setSwReady(false));
    }

    // 2. Connectivité + replay de la file offline
    const updateOnline = () => {
      const online = navigator.onLine;
      setOnline(online);
      if (online) {
        toast.success("Connexion rétablie", { description: "Orbit resynchronise vos données." });
        // Replay immédiat des mutations stockées pendant la coupure
        void replayQueue();
      } else {
        toast.warning("Mode hors ligne", {
          description: "Consultez vos données en cache — vos actions seront mises en file d'attente.",
        });
      }
    };
    setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    // Au montage : compteur de file + replay silencieux du reste (page
    // rechargée pendant la coupure, ou replay interrompu par un 5xx)
    void refreshCount();
    if (navigator.onLine) void replayQueue({ silent: true });
    // Garde périodique : une mutation mise en file par un autre onglet,
    // ou un réseau revenu sans déclencher l'événement « online »
    const replayGuard = setInterval(() => {
      if (navigator.onLine) void replayQueue({ silent: true });
    }, 60_000);

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
      clearInterval(replayGuard);
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
