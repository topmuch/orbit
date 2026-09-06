"use client";

// Orbit — Enregistrement du Service Worker + suivi en ligne/hors ligne + installation PWA
//            + REPLAY de la file d'attente offline (Task 7)
//            + moteur de synchronisation offline-first v2 (Dexie + Background Sync)

import { useEffect } from "react";
import { toast } from "sonner";
import {
  usePwaStore,
  captureInstallPrompt,
  getInstallPrompt,
  type InstallPromptEvent,
} from "@/lib/pwa-store";
import { replayQueue, refreshCount, importLegacyQueue } from "@/lib/offline-queue";
import { connectionMonitor } from "@/lib/network/connection-monitor";
import { startSyncEngine, triggerSync } from "@/lib/offline/sync-engine";

export function PwaRegister() {
  const setOnline = usePwaStore((s) => s.setOnline);
  const setCanInstall = usePwaStore((s) => s.setCanInstall);
  const setInstalled = usePwaStore((s) => s.setInstalled);
  const setSwReady = usePwaStore((s) => s.setSwReady);

  useEffect(() => {
    // 1. Service Worker — enregistré PARTOUT (dev inclus) : le sw.js v5
    //    limite son handler fetch en dev aux GET /api (cache offline) et à
    //    la navigation de secours → aucun risque de bundle gelé (bug 13-b :
    //    les chunks /_next/ dev ne sont JAMAIS mis en cache), mais les
    //    notifications push, la lecture offline ET le Background Sync
    //    restent testables en dev. En production, cache-first sûr (hash).
    let swMessageHandler: ((event: MessageEvent) => void) | null = null;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => setSwReady(true))
        .catch(() => setSwReady(false));

      // Background Sync / messages du SW → sync immédiate (tag orbit-sync).
      swMessageHandler = (event: MessageEvent) => {
        const data = event.data as { type?: string } | null;
        if (data?.type === "SYNC_REQUESTED") {
          void triggerSync();
        }
      };
      navigator.serviceWorker.addEventListener("message", swMessageHandler);
    }

    // 2. Connectivité (moniteur unique : événements navigateur + simulation
    //    des réglages) + replay de la file offline au retour du réseau.
    const updateOnline = () => {
      const online = connectionMonitor.isEffectiveOnline();
      setOnline(online);
      if (online) {
        toast.success("Connexion rétablie", {
          description: "Orbit resynchronise vos données.",
        });
        // Replay immédiat des mutations stockées pendant la coupure
        void replayQueue();
      } else {
        toast.warning("Mode hors ligne", {
          description:
            "Consultez vos données en cache — vos actions seront mises en file d'attente.",
        });
      }
    };
    setOnline(connectionMonitor.isEffectiveOnline());
    connectionMonitor.on("change", updateOnline);

    // 3. Moteur de synchronisation offline-first v2 :
    //    pull delta 30 s, fusion multi-appareils, conflits, tombstones.
    //    (sa propre écoute « online » déclenche la sync complète)
    startSyncEngine();

    // Au montage : migration de l'ancienne file IDB → Dexie, compteur de
    // file + replay silencieux du reste (page rechargée pendant la coupure).
    void importLegacyQueue();
    void refreshCount();
    if (connectionMonitor.isEffectiveOnline()) void replayQueue({ silent: true });
    // Garde périodique : une mutation mise en file par un autre onglet,
    // ou un réseau revenu sans déclencher l'événement « online »
    const replayGuard = setInterval(() => {
      if (connectionMonitor.isEffectiveOnline()) void replayQueue({ silent: true });
    }, 60_000);

    // 4. Installation PWA
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
      connectionMonitor.off("change", updateOnline);
      if (swMessageHandler) {
        navigator.serviceWorker.removeEventListener("message", swMessageHandler);
      }
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
