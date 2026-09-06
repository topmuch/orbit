"use client";

// Orbit — Modale d'aide des raccourcis clavier (raccourci « ? »)
// ─────────────────────────────────────────────────────────────────────────────
// Auto-contenue : bascule son état interne à l'écoute de l'événement window
// TOGGLE_SHORTCUT_HELP_EVENT (dispatché par le hook global des raccourcis ou
// par un lien des réglages). ESC / clic à l'extérieur referment via
// onOpenChange du Dialog shadcn.

import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/provider";
import { TOGGLE_SHORTCUT_HELP_EVENT } from "@/lib/ui-intent";

const KBD_CLASS = "rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]";

interface ShortcutRow {
  /** Clé i18n du libellé de l'action. */
  actionKey: string;
  /** Touches affichées (une pastille kbd par touche). */
  keys: readonly string[];
}

/** Registre affiché — doit refléter useKeyboardShortcuts (src/lib/shortcuts). */
const SHORTCUTS: readonly ShortcutRow[] = [
  { actionKey: "shortcuts.openPalette", keys: ["Ctrl", "K"] },
  { actionKey: "shortcuts.newEvent", keys: ["Ctrl", "N"] },
  { actionKey: "shortcuts.newTask", keys: ["Ctrl", "T"] },
  { actionKey: "shortcuts.newEmail", keys: ["Ctrl", "E"] },
  { actionKey: "shortcuts.viewDashboard", keys: ["Ctrl", "1"] },
  { actionKey: "shortcuts.viewCalendar", keys: ["Ctrl", "2"] },
  { actionKey: "shortcuts.viewTasks", keys: ["Ctrl", "3"] },
  { actionKey: "shortcuts.viewEmails", keys: ["Ctrl", "4"] },
  { actionKey: "shortcuts.viewAssistant", keys: ["Ctrl", "5"] },
  { actionKey: "shortcuts.viewSettings", keys: ["Ctrl", "6"] },
  { actionKey: "shortcuts.toggleTheme", keys: ["Ctrl", "⇧", "L"] },
  { actionKey: "shortcuts.help", keys: ["?"] },
];

export function ShortcutHelpModal() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onToggle = () => setOpen((previous) => !previous);
    window.addEventListener(TOGGLE_SHORTCUT_HELP_EVENT, onToggle);
    return () =>
      window.removeEventListener(TOGGLE_SHORTCUT_HELP_EVENT, onToggle);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.desc")}</DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-md border">
          <div className="flex items-center justify-between gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>{t("shortcuts.action")}</span>
            <span>{t("shortcuts.key")}</span>
          </div>
          <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {SHORTCUTS.map((row) => (
              <li
                key={row.actionKey}
                className="flex items-center justify-between gap-4 px-4 py-2.5"
              >
                <span className="text-sm">{t(row.actionKey)}</span>
                <span
                  className="flex shrink-0 items-center gap-1"
                  aria-label={`${t(row.actionKey)} : ${row.keys.join(" ")}`}
                >
                  {row.keys.map((key, index) => (
                    <kbd
                      key={`${row.actionKey}-${index}`}
                      className={KBD_CLASS}
                    >
                      {key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">{t("shortcuts.note")}</p>
      </DialogContent>
    </Dialog>
  );
}
