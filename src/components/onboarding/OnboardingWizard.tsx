"use client";

// Orbit — Wizard d'onboarding (première connexion)
// ─────────────────────────────────────────────────────────────────────────────
// Overlay plein écran monté par l'intégrateur (page.tsx) quand
// !user.onboardingCompleted. 5 écrans : 0 = bienvenue (logo), 1-4 = les
// fonctionnalités phares (emails, calendrier, tâches, IA locale).
// finish OU skip → POST /api/user/onboarding (drapeau User.preferences) puis
// onComplete() — un échec réseau/serveur ne bloque JAMAIS l'app : toast d'info
// + fermeture quand même (la mutation part en file offline le cas échéant).

import { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CalendarDays,
  Check,
  KanbanSquare,
  Loader2,
  Mail,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { OrbitLogo } from "@/components/orbit/logo";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/types";

/** Étape feature (écrans 1-4) : icône + pastille colorée + textes i18n. */
type OnboardingStep = {
  icon: LucideIcon;
  /** Couleur de l'icône (ex. text-emerald-500 — pas de bleu/indigo). */
  iconClass: string;
  /** Fond de la pastille circulaire (ex. bg-emerald-500/15). */
  badgeClass: string;
  titleKey: string;
  descKey: string;
};

const STEPS: OnboardingStep[] = [
  {
    icon: Mail,
    iconClass: "text-emerald-500",
    badgeClass: "bg-emerald-500/15",
    titleKey: "onboarding.step1Title",
    descKey: "onboarding.step1Desc",
  },
  {
    icon: CalendarDays,
    iconClass: "text-primary",
    badgeClass: "bg-primary/15",
    titleKey: "onboarding.step2Title",
    descKey: "onboarding.step2Desc",
  },
  {
    icon: KanbanSquare,
    iconClass: "text-orange-500",
    badgeClass: "bg-orange-500/15",
    titleKey: "onboarding.step3Title",
    descKey: "onboarding.step3Desc",
  },
  {
    icon: Sparkles,
    iconClass: "text-violet-500",
    badgeClass: "bg-violet-500/15",
    titleKey: "onboarding.step4Title",
    descKey: "onboarding.step4Desc",
  },
];

const TOTAL = STEPS.length;

// Garde-fou : api() met les mutations en file offline et ATTEND leur replay
// (jusqu'à 15 min). On borne l'attente pour que le wizard ne bloque jamais la
// première connexion — le POST continue alors en arrière-plan et passera au
// retour du réseau (drapeau synchronisé à la prochaine session).
const SUBMIT_TIMEOUT_MS = 8_000;

export function OnboardingWizard({
  user,
  onComplete,
}: {
  user: SessionUser;
  onComplete: () => void;
}) {
  const { t } = useI18n();
  /** 0 = écran de bienvenue, 1-4 = étapes features. */
  const [screen, setScreen] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const isLast = screen >= TOTAL;
  // L'accueil compte pour 0 %, les étapes 1-4 → 25/50/75/100 %.
  const progress = (screen / TOTAL) * 100;
  // Toujours défini (écran 0 → STEPS[0], valeur factice jamais affichée).
  const step = STEPS[Math.max(screen - 1, 0)];

  function handleNext() {
    if (submitting) return;
    if (isLast) void finalize();
    else setScreen(screen + 1);
  }

  /** finish/skip : persiste le drapeau puis referme — jamais bloquant. */
  async function finalize() {
    setSubmitting(true);
    try {
      await Promise.race([
        api("/api/user/onboarding", {
          method: "POST",
          body: JSON.stringify({ completed: true }),
        }),
        new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_TIMEOUT_MS)),
      ]);
    } catch {
      // Échec serveur/réseau immédiat : on informe… mais on referme quand
      // même — l'app reste pleinement utilisable sans le wizard.
      toast.error(t("common.error"));
    } finally {
      setSubmitting(false);
      onComplete();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("onboarding.welcome")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/10 p-4"
    >
      <div className="flex w-full flex-col items-center gap-5">
        <OrbitLogo size={48} animated />

        <Card className="w-full max-w-lg gap-0 border-border/60 bg-card/90 p-6 backdrop-blur sm:p-8">
          <Progress value={progress} className="mb-8 h-1.5" />

          <motion.div
            key={screen}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            {screen === 0 ? (
              <div className="text-center">
                <h1 className="text-2xl font-semibold sm:text-3xl">
                  {t("onboarding.welcome")}
                </h1>
                <p className="mt-3 text-muted-foreground">{t("onboarding.welcomeDesc")}</p>
                {/* Compte connecté (donnée, pas une chaîne UI) */}
                <p className="mt-1 text-xs text-muted-foreground/70">
                  {user.name ?? user.email}
                </p>
              </div>
            ) : (
              <div className="text-center">
                <div
                  className={cn(
                    "mx-auto flex size-16 items-center justify-center rounded-full",
                    step.badgeClass
                  )}
                >
                  <step.icon className={cn("size-8", step.iconClass)} />
                </div>
                <h2 className="mt-6 text-xl font-semibold">{t(step.titleKey)}</h2>
                <p className="mt-2 text-muted-foreground">{t(step.descKey)}</p>
              </div>
            )}
          </motion.div>

          {/* Points d'étape (décoratifs) + annonce « Étape X sur 4 » (lecteurs d'écran) */}
          <div className="mt-8 flex items-center justify-center gap-2">
            {STEPS.map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className={cn(
                  "size-3 rounded-full transition-colors",
                  screen === i + 1 ? "bg-primary" : screen > i + 1 ? "bg-primary/50" : "bg-muted"
                )}
              />
            ))}
            {screen >= 1 && (
              <span className="sr-only">
                {t("onboarding.stepOf", { current: screen, total: TOTAL })}
              </span>
            )}
          </div>

          <div className="mt-8 flex items-center justify-between gap-2">
            {screen >= 1 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void finalize()}
                disabled={submitting}
                className="h-11 px-4"
              >
                {t("onboarding.skip")}
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}

            <Button type="button" onClick={handleNext} disabled={submitting} className="h-11 px-6">
              {submitting ? (
                <Loader2 className="animate-spin" />
              ) : isLast ? (
                <Check />
              ) : (
                <ArrowRight />
              )}
              {isLast ? t("onboarding.finish") : t("onboarding.next")}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
