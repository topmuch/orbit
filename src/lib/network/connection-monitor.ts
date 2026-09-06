"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Monitoring de connexion (offline-first v2)
// ───────────────────────────────────────────────────────────────────────────
// Source unique de vérité pour l'état en ligne/hors ligne de l'application :
//   • événements natifs « online »/« offline » du navigateur ;
//   • SIMULATION de coupure (réglages/QA) : navigator.onLine reste true mais
//     l'app se comporte EXACTEMENT comme hors ligne (mutations mises en file,
//     lectures servies par IndexedDB) — testable sans DevTools ;
//   • api() continue de se fier au TypeError de fetch (navigator.onLine ment
//     régulièrement) : la simulation court-circuite AVANT le fetch, la coupure
//     réelle est détectée PAR le fetch — les deux chemins convergent ici.
// Singleton : les listeners DOM ne sont posés qu'une fois, tous les hooks et
// le moteur de sync s'y abonnent (on/off).
// ═══════════════════════════════════════════════════════════════════════════

export type ConnectionEvent = "online" | "offline" | "change";

type Listener = () => void;

const isBrowser = typeof window !== "undefined";

class ConnectionMonitor {
  private online: boolean = isBrowser ? navigator.onLine : true;
  private simulatedOffline = false;
  private listeners = new Map<ConnectionEvent, Listener[]>();

  constructor() {
    if (!isBrowser) return;
    window.addEventListener("online", () => {
      this.online = true;
      this.emit("online");
      this.emit("change");
    });
    window.addEventListener("offline", () => {
      this.online = false;
      this.emit("offline");
      this.emit("change");
    });
  }

  /** Réseau réellement joignable (selon le navigateur). */
  isOnline(): boolean {
    return this.online;
  }

  /** Simulation de coupure active (réglages — démo/QA sans DevTools). */
  isSimulatedOffline(): boolean {
    return this.simulatedOffline;
  }

  /**
   * État EFFECTIF : ce que toute l'application doit considérer.
   * Hors ligne effectif = navigator.offline OU simulation active.
   */
  isEffectiveOnline(): boolean {
    return this.online && !this.simulatedOffline;
  }

  /** Active/désactive la simulation hors ligne (renvoie l'état effectif). */
  setSimulatedOffline(simulated: boolean): boolean {
    if (this.simulatedOffline === simulated) return this.isEffectiveOnline();
    const wasEffectiveOnline = this.isEffectiveOnline();
    this.simulatedOffline = simulated;
    const isNowEffectiveOnline = this.isEffectiveOnline();
    if (wasEffectiveOnline !== isNowEffectiveOnline) {
      this.emit(isNowEffectiveOnline ? "online" : "offline");
      this.emit("change");
    }
    return isNowEffectiveOnline;
  }

  /** Abonnement (online/offline/change — change couvre les deux). */
  on(event: ConnectionEvent, callback: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
  }

  off(event: ConnectionEvent, callback: Listener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const index = list.indexOf(callback);
    if (index > -1) list.splice(index, 1);
  }

  private emit(event: ConnectionEvent): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const callback of [...list]) {
      try {
        callback();
      } catch {
        // Un listener défaillant ne casse jamais les autres
      }
    }
  }
}

export const connectionMonitor = new ConnectionMonitor();

/** Raccourci pour api() : la mutation doit-elle court-circuiter le fetch ? */
export function isConnectionOffline(): boolean {
  return !connectionMonitor.isEffectiveOnline();
}
