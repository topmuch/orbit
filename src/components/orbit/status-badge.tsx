"use client";

// Orbit — StatusBadge : statut de tâche (todo / doing / done / archived), libellés FR.
// Conventions : « À faire » = neutre (outline), « En cours » = cyan de marque
// (texte assombri en clair pour le contraste AA, cyan clair en sombre),
// « Terminé » = emerald (convention succès conservée),
// « Archivé » = gris neutre (soft delete — masqué du Kanban par défaut).

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Archive, CheckCircle2, Circle, Timer } from "lucide-react";
import type { TaskStatus } from "@/lib/types";

const STATUS_META: Record<
  TaskStatus,
  { label: string; icon: React.ElementType; className: string }
> = {
  todo: {
    label: "À faire",
    icon: Circle,
    className: "border-border/70 text-muted-foreground",
  },
  doing: {
    label: "En cours",
    icon: Timer,
    className:
      "border-orbit-cyan/40 bg-orbit-cyan/15 text-orbit-cyan-strong dark:bg-orbit-cyan/20 dark:text-orbit-cyan-soft",
  },
  done: {
    label: "Terminé",
    icon: CheckCircle2,
    className:
      "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  archived: {
    label: "Archivé",
    icon: Archive,
    className:
      "border-muted-foreground/30 bg-muted/40 text-muted-foreground/80 dark:text-muted-foreground/90",
  },
};

function StatusBadge({
  status,
  className,
  ...props
}: React.ComponentProps<"span"> & { status: TaskStatus }) {
  const { label, icon: Icon, className: statusClass } = STATUS_META[status];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1", statusClass, className)}
      {...props}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

export { StatusBadge };
