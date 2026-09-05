"use client";

// Orbit — État PWA (installation, connexion)
import { create } from "zustand";

type PwaState = {
  online: boolean;
  canInstall: boolean;
  installed: boolean;
  swReady: boolean;
  setOnline: (online: boolean) => void;
  setCanInstall: (can: boolean) => void;
  setInstalled: (installed: boolean) => void;
  setSwReady: (ready: boolean) => void;
};

export const usePwaStore = create<PwaState>((set) => ({
  online: true,
  canInstall: false,
  installed: false,
  swReady: false,
  setOnline: (online) => set({ online }),
  setCanInstall: (canInstall) => set({ canInstall }),
  setInstalled: (installed) => set({ installed }),
  setSwReady: (swReady) => set({ swReady }),
}));

/** Prompt natif d'installation (beforeinstallprompt capturé au chargement) */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: InstallPromptEvent | null = null;
export function captureInstallPrompt(e: InstallPromptEvent) {
  deferredPrompt = e;
}
export function getInstallPrompt(): InstallPromptEvent | null {
  return deferredPrompt;
}
