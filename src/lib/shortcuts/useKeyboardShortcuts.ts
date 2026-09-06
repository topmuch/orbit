"use client";

// Orbit — Raccourcis clavier globaux (palette, création, navigation, thème)
// ─────────────────────────────────────────────────────────────────────────────
// Unique propriétaire des raccourcis Ctrl/Cmd de l'application : la palette de
// commandes n'écoute QUE l'événement window OPEN_COMMAND_PALETTE_EVENT et la
// modale d'aide QUE TOGGLE_SHORTCUT_HELP_EVENT — tout transite par
// lib/ui-intent (couplage nul entre les composants).
// Ctrl+K reste actif même pendant une saisie (convention Raycast) ; tous les
// autres raccourcis sont neutralisés dans INPUT/TEXTAREA/SELECT/contenteditable.
// Les combos Ctrl+N/T/E ignorent Alt et Maj pour éviter les déclenchements
// accidentels (AltGr, Ctrl+Maj+lettre = bascule de thème).

import { useEffect } from "react";
import { useTheme } from "next-themes";
import type { OrbitView } from "@/lib/types";
import {
  openCommandPalette,
  toggleShortcutHelp,
  useUiIntent,
} from "@/lib/ui-intent";

/** Vues cibles de Ctrl/Cmd+1 → 6 (ordre de la barre de navigation). */
const VIEWS_BY_DIGIT: readonly OrbitView[] = [
  "dashboard",
  "calendar",
  "tasks",
  "emails",
  "assistant",
  "settings",
];

/** true si l'événement clavier provient d'un champ de saisie. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function useKeyboardShortcuts({
  onNavigate,
}: {
  onNavigate: (view: OrbitView) => void;
}): void {
  const { theme, setTheme } = useTheme();
  const requestNew = useUiIntent((state) => state.requestNew);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;

      // Ctrl/Cmd+K — ouverture de la palette : TOUJOURS actif, y compris
      // quand le focus est dans un champ de saisie.
      if (mod && !event.altKey && (key === "k" || key === "K")) {
        event.preventDefault();
        openCommandPalette();
        return;
      }

      // Tous les autres raccourcis sont ignorés pendant la saisie.
      if (isEditableTarget(event.target)) return;

      if (mod && !event.altKey) {
        // Ctrl/Cmd+Maj+L — bascule clair ↔ sombre (résout « system » via
        // prefers-color-scheme : dark → light, sinon dark).
        if (event.shiftKey && (key === "l" || key === "L")) {
          event.preventDefault();
          const prefersDark =
            typeof window === "undefined" ||
            window.matchMedia("(prefers-color-scheme: dark)").matches;
          const isDark =
            theme === "dark" || (theme !== "light" && prefersDark);
          setTheme(isDark ? "light" : "dark");
          return;
        }

        // Les combos lettres/chiffres refusent Maj (réservé à la bascule thème).
        if (event.shiftKey) return;

        const lower = key.toLowerCase();
        if (lower === "n") {
          event.preventDefault();
          requestNew("event");
          onNavigate("calendar");
          return;
        }
        if (lower === "t") {
          event.preventDefault();
          requestNew("task");
          onNavigate("tasks");
          return;
        }
        if (lower === "e") {
          event.preventDefault();
          requestNew("email");
          onNavigate("emails");
          return;
        }
        if (key >= "1" && key <= "6") {
          const view = VIEWS_BY_DIGIT[Number(key) - 1];
          if (view) {
            event.preventDefault();
            onNavigate(view);
          }
          return;
        }
        return;
      }

      if (event.altKey) return;

      // « ? » (Maj+/) — modale d'aide ; « / » — palette de commandes.
      if (key === "?") {
        event.preventDefault();
        toggleShortcutHelp();
        return;
      }
      if (key === "/") {
        event.preventDefault();
        openCommandPalette();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNavigate, requestNew, theme, setTheme]);
}
