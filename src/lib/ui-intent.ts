"use client";

// Orbit — Intentions UI globales (palette de commandes, raccourcis clavier)
// ─────────────────────────────────────────────────────────────────────────────
// L'application est une SPA mono-route : « créer un événement » depuis la
// palette (Ctrl+K) ou un raccourci (Ctrl+N) doit ouvrir le dialogue de la VUE
// COURANTE correspondante. Plutôt que de coupler la palette aux vues, un petit
// store Zustand expose des compteurs d'intentions : chaque vue s'abonne au
// compteur de son domaine et ouvre son dialogue quand il s'incrémente.
// Les événements window (palette/aide) restent découpés pour les composants
// auto-contenus.

import { useEffect, useRef } from "react";
import { create } from "zustand";

/** Domaines « création » pilotables globalement. */
export type NewIntentKind = "event" | "task" | "email";

type UiIntentState = {
  /** Compteurs incrémentés par requestNew() — les vues réagissent aux deltas. */
  requests: Record<NewIntentKind, number>;
  requestNew: (kind: NewIntentKind) => void;
};

export const useUiIntent = create<UiIntentState>((set) => ({
  requests: { event: 0, task: 0, email: 0 },
  requestNew: (kind) =>
    set((state) => ({
      requests: { ...state.requests, [kind]: state.requests[kind] + 1 },
    })),
}));

// ── Événements window découplés ─────────────────────────────────────────────

export const OPEN_COMMAND_PALETTE_EVENT = "orbit:open-command-palette";
export const TOGGLE_SHORTCUT_HELP_EVENT = "orbit:toggle-shortcut-help";

/** Ouvre la palette de commandes (bouton header, raccourci Ctrl+K…). */
export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}

/** Ouvre/ferme l'aide des raccourcis (raccourci « ? », lien settings…). */
export function toggleShortcutHelp(): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_SHORTCUT_HELP_EVENT));
}

// ── Hook d'abonnement pour les vues ─────────────────────────────────────────

/**
 * Dernier compteur CONSOMMÉ par domaine, au niveau MODULE : survit aux
 * démontages/remontages des vues (navigation SPA) → une intention déjà
 * traitée ne rouvre jamais le dialogue au retour sur la vue.
 */
const lastConsumed: Record<NewIntentKind, number> = { event: 0, task: 0, email: 0 };

/**
 * Réagit aux intentions « création » du domaine `kind` (palette Ctrl+K,
 * raccourcis Ctrl+N/T/E). `onIntent` est appelé UNE fois par incrément.
 *
 * Robustesse au lazy-loading : les vues sont chargées via next/dynamic —
 * l'intention peut être émise PENDANT le chargement (compteur déjà incrémenté
 * à l'abonnement). Un rattrapage initial (microtask, hors du corps synchrone
 * de l'effet — règle react-hooks/set-state-in-effect) compare le compteur
 * courant au dernier consommé MODULE : 1ʳᵉ intention rattrapée, intentions
 * déjà consommées ignorées.
 */
export function useNewIntent(kind: NewIntentKind, onIntent: () => void): void {
  // Référence stable : pas de re-souscription à chaque rendu du composant
  // (mise à jour du ref dans un effet — règle react-hooks/refs).
  const onIntentRef = useRef(onIntent);
  useEffect(() => {
    onIntentRef.current = onIntent;
  }, [onIntent]);

  useEffect(() => {
    const check = (state: UiIntentState, prev?: UiIntentState) => {
      const count = state.requests[kind];
      const baseline = prev
        ? Math.max(prev.requests[kind], lastConsumed[kind])
        : lastConsumed[kind];
      if (count > baseline) onIntentRef.current();
      lastConsumed[kind] = count;
    };
    const unsubscribe = useUiIntent.subscribe(check);
    // Rattrapage des intentions émises avant l'abonnement (dynamic import).
    queueMicrotask(() => check(useUiIntent.getState()));
    return unsubscribe;
  }, [kind]);
}
