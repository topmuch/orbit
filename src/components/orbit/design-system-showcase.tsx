"use client";

// Orbit — Design System : aperçu vivant des composants et de la palette.
// Intégré en bas des Réglages (pleine largeur). Auto-contenu : aucune
// dépendance métier, sert de référence visuelle light/dark.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/orbit/status-badge";
import { cn } from "@/lib/utils";
import {
  CalendarDays,
  Check,
  ChevronDown,
  Eye,
  Flag,
  Loader2,
  MapPin,
  Palette,
  Plus,
  RefreshCw,
  Sparkles,
  Bell,
} from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Nuancier : couleurs de marque + tokens clés des deux modes */
const SWATCHES: { name: string; hex: string; className: string }[] = [
  { name: "Bleu profond · primaire", hex: "#0A2540", className: "bg-[#0A2540]" },
  { name: "Cyan · action", hex: "#00D4FF", className: "bg-[#00D4FF]" },
  { name: "Cyan clair · texte sombre", hex: "#7FE6FF", className: "bg-[#7FE6FF]" },
  { name: "Orange · accent", hex: "#FF6B35", className: "bg-[#FF6B35]" },
  { name: "Fond clair", hex: "#F5F5F7", className: "bg-[#F5F5F7]" },
  { name: "Nuit · fond sombre", hex: "#071729", className: "bg-[#071729]" },
  { name: "Carte sombre", hex: "#0D2942", className: "bg-[#0D2942]" },
  { name: "Gris · texte secondaire", hex: "#5C6674", className: "bg-[#5C6674]" },
  { name: "Erreur", hex: "#DC2626", className: "bg-[#DC2626]" },
  { name: "Succès", hex: "#10B981", className: "bg-[#10B981]" },
];

function ShowcaseSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function DesignSystemShowcase() {
  // Carte repliable (ouverte par défaut)
  const [open, setOpen] = useState(true);

  // Validation email en direct
  const [email, setEmail] = useState("");
  const trimmed = email.trim();
  const emailState =
    trimmed === "" ? "empty" : EMAIL_RE.test(trimmed) ? "valid" : "invalid";

  // Bascule skeleton ↔ contenu chargé (simulation 1,5 s)
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  function startLoadingDemo() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setDemoLoaded(false);
    setLoadingDemo(true);
    timerRef.current = setTimeout(() => {
      setLoadingDemo(false);
      setDemoLoaded(true);
    }, 1500);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Palette className="size-4 text-primary" aria-hidden />
            Design System — aperçu des composants
          </CardTitle>
          <CardDescription>
            Palette de marque, boutons, statuts, cartes, champs, dialog,
            notifications et skeletons — tokens sémantiques clair/sombre.
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-11 gap-1.5 px-3"
                aria-label={
                  open
                    ? "Replier l'aperçu du design system"
                    : "Déplier l'aperçu du design system"
                }
              >
                {open ? "Replier" : "Déplier"}
                <ChevronDown
                  className={cn(
                    "size-4 transition-transform",
                    open && "rotate-180"
                  )}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-6">
            {/* ---------- Boutons ---------- */}
            <ShowcaseSection
              title="Boutons"
              hint="Variants (dont accent orange #FF6B35), tailles et états."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button>Primaire</Button>
                <Button variant="accent">Accent</Button>
                <Button variant="secondary">Secondaire</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
                <Button variant="destructive">Destructif</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">
                  <Plus className="size-4" aria-hidden />
                  Petit
                </Button>
                <Button size="default">
                  <Plus className="size-4" aria-hidden />
                  Défaut
                </Button>
                <Button size="lg">
                  <Plus className="size-4" aria-hidden />
                  Large
                </Button>
                <Button size="icon" aria-label="Exemple de bouton icône">
                  <Plus />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled>Désactivé</Button>
                <Button disabled aria-label="Chargement en cours, veuillez patienter">
                  <Loader2 className="animate-spin" aria-hidden />
                  Chargement…
                </Button>
              </div>
            </ShowcaseSection>

            <Separator />

            {/* ---------- Cartes & statuts ---------- */}
            <ShowcaseSection
              title="Cartes & statuts"
              hint="Exemple événement + exemple tâche (StatusBadge : À faire / En cours / Terminé)."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <CalendarDays className="size-4 text-primary" aria-hidden />
                      Rendez-vous dentiste
                    </CardTitle>
                    <CardDescription>Aujourd&apos;hui · 14:30 – 15:15</CardDescription>
                    <CardAction>
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <Sparkles className="size-2.5" aria-hidden />
                        IA
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="size-4 shrink-0" aria-hidden />
                      Cabinet Dupont · 12 rue des Lilas
                    </p>
                  </CardContent>
                  <CardFooter className="gap-2">
                    <Button variant="outline" size="sm">Modifier</Button>
                    <Button variant="accent" size="sm">
                      <Bell className="size-4" aria-hidden />
                      Rappel
                    </Button>
                  </CardFooter>
                </Card>

                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <Flag className="size-4 text-primary" aria-hidden />
                      Préparer la présentation
                    </CardTitle>
                    <CardDescription>Échéance demain · 18:00</CardDescription>
                    <CardAction>
                      <StatusBadge status="doing" />
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Slides client + budget — priorité{" "}
                      <span className="font-medium text-red-500">haute</span>.
                    </p>
                  </CardContent>
                  <CardFooter className="gap-2">
                    <Button variant="outline" size="sm">Ouvrir</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-emerald-600 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                    >
                      <Check className="size-4" aria-hidden />
                      Terminer
                    </Button>
                  </CardFooter>
                </Card>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">StatusBadge :</span>
                <StatusBadge status="todo" />
                <StatusBadge status="doing" />
                <StatusBadge status="done" />
              </div>
            </ShowcaseSection>

            <Separator />

            {/* ---------- Champ avec validation ---------- */}
            <ShowcaseSection
              title="Champ avec validation en direct"
              hint="Vide = neutre · valide = bordure émeraude + icône · invalide (aria-invalid) = bordure destructive + message — même pattern que react-hook-form."
            >
              <div className="max-w-md space-y-2">
                <Label htmlFor="showcase-email">Adresse email</Label>
                <div className="relative">
                  <Input
                    id="showcase-email"
                    type="email"
                    placeholder="prenom@exemple.fr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={emailState === "invalid"}
                    aria-describedby={
                      emailState === "invalid"
                        ? "showcase-email-error"
                        : undefined
                    }
                    className={cn(
                      "pr-10",
                      emailState === "valid" &&
                        "border-emerald-500 focus-visible:border-emerald-500 focus-visible:ring-emerald-500/25"
                    )}
                  />
                  {emailState === "valid" && (
                    <Check
                      className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-emerald-500"
                      aria-hidden
                    />
                  )}
                </div>
                {emailState === "invalid" && (
                  <p
                    id="showcase-email-error"
                    className="text-sm text-destructive"
                    role="alert"
                  >
                    Format invalide — exemple attendu : prenom@exemple.fr
                  </p>
                )}
              </div>
            </ShowcaseSection>

            <Separator />

            {/* ---------- Dialog & notifications ---------- */}
            <ShowcaseSection
              title="Dialog & notifications"
              hint="Dialog modal + toasts sonner (succès / erreur)."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">
                      <Eye className="size-4" aria-hidden />
                      Ouvrir l&apos;aperçu
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Aperçu</DialogTitle>
                      <DialogDescription>
                        Un dialog exemple : titre, description, contenu et
                        actions.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-lg border border-border/60 bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">
                      Fonds, bordures et textes suivent les tokens sémantiques
                      de la palette Orbit — ils s&apos;adaptent automatiquement
                      au thème clair et sombre.
                    </div>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">Fermer</Button>
                      </DialogClose>
                      <Button>Compris</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Button
                  variant="outline"
                  onClick={() =>
                    toast.success("Événement enregistré", {
                      description: "Rendez-vous dentiste · aujourd'hui 14:30 – 15:15",
                    })
                  }
                >
                  Toast succès
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    toast.error("Enregistrement impossible", {
                      description: "Vérifiez votre connexion puis réessayez.",
                    })
                  }
                >
                  Toast erreur
                </Button>
              </div>
            </ShowcaseSection>

            <Separator />

            {/* ---------- Skeleton ---------- */}
            <ShowcaseSection
              title="Skeleton (chargement)"
              hint="Pulsation + léger shimmer pendant 1,5 s, puis contenu chargé."
            >
              <div className="space-y-3">
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-11"
                  onClick={startLoadingDemo}
                  disabled={loadingDemo}
                >
                  {loadingDemo ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden />
                  )}
                  {loadingDemo ? "Chargement…" : "Simuler un chargement (1,5 s)"}
                </Button>
                <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                  {loadingDemo ? (
                    <div className="space-y-2" role="status" aria-label="Chargement en cours">
                      <Skeleton className="h-5 w-2/3" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-1/2" />
                    </div>
                  ) : demoLoaded ? (
                    <div className="space-y-1.5">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <Check className="size-4 text-emerald-500" aria-hidden />
                        Contenu chargé
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Trois lignes ont été « récupérées » — le skeleton laisse
                        place au contenu réel.
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Cliquez pour alterner entre skeleton et contenu chargé.
                    </p>
                  )}
                </div>
              </div>
            </ShowcaseSection>

            <Separator />

            {/* ---------- Palette ---------- */}
            <ShowcaseSection
              title="Palette"
              hint="Bleu profond #0A2540 · cyan #00D4FF · orange #FF6B35 — neutres #F5F5F7 → #1A1A1A."
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                {SWATCHES.map((swatch) => (
                  <div key={swatch.hex} className="space-y-1.5">
                    <div
                      className={cn(
                        "h-12 rounded-lg border border-border/60",
                        swatch.className
                      )}
                      aria-hidden
                    />
                    <p className="text-xs font-medium">{swatch.name}</p>
                    <code className="text-[11px] text-muted-foreground">
                      {swatch.hex}
                    </code>
                  </div>
                ))}
              </div>
            </ShowcaseSection>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
