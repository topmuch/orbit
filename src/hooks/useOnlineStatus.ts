"use client";

// Orbit — Statut de connexion en ligne/hors ligne (offline-first v2)
// Source : connectionMonitor (événements navigateur + simulation réglages).

import { useEffect, useState } from "react";
import { connectionMonitor } from "@/lib/network/connection-monitor";

/**
 * true = en ligne EFFECTIF (réseau présent ET simulation désactivée).
 * Souscrit au moniteur : re-render immédiat au basculement.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof window === "undefined" ? true : connectionMonitor.isEffectiveOnline()
  );

  useEffect(() => {
    const update = () => setOnline(connectionMonitor.isEffectiveOnline());
    update();
    connectionMonitor.on("change", update);
    return () => connectionMonitor.off("change", update);
  }, []);

  return online;
}

/** État détaillé : réseau réel + simulation (réglages/QA). */
export function useConnectionInfo(): { online: boolean; simulated: boolean } {
  const [state, setState] = useState(() => ({
    online: typeof window === "undefined" ? true : connectionMonitor.isEffectiveOnline(),
    simulated: typeof window === "undefined" ? false : connectionMonitor.isSimulatedOffline(),
  }));

  useEffect(() => {
    const update = () =>
      setState({
        online: connectionMonitor.isEffectiveOnline(),
        simulated: connectionMonitor.isSimulatedOffline(),
      });
    update();
    connectionMonitor.on("change", update);
    return () => connectionMonitor.off("change", update);
  }, []);

  return state;
}

/** Bascule la simulation hors ligne (réglages — démo/QA sans DevTools). */
export function setSimulatedOffline(simulated: boolean): void {
  connectionMonitor.setSimulatedOffline(simulated);
}
