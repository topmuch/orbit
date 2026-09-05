"use client";

/**
 * Orbit — Vue Tâches (Kanban)
 *
 * 3 colonnes « À faire / En cours / Terminé » avec drag & drop (dnd-kit),
 * mise à jour optimiste du cache React Query, recherche instantanée,
 * création/édition via TaskDialog et suppression confirmée via AlertDialog.
 */

import { useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { format, isBefore } from "date-fns";
import { fr } from "date-fns/locale";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  Flag,
  GripVertical,
  Inbox,
  ListTodo,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Timer,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskDialog } from "@/components/orbit/task-dialog";
import { useTaskMutations, useTasks } from "@/lib/api-client";
import type { TaskDto, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------- Constantes ----------

type ColumnDef = {
  id: TaskStatus;
  label: string;
  emptyLabel: string;
  icon: LucideIcon;
  pillClassName: string;
  badgeClassName: string;
};

const COLUMNS: ColumnDef[] = [
  {
    id: "todo",
    label: "À faire",
    emptyLabel: "Glissez une tâche ici",
    icon: Circle,
    pillClassName: "bg-foreground/10 text-foreground/70",
    badgeClassName: "border-foreground/15 bg-foreground/5 text-foreground/80",
  },
  {
    id: "doing",
    label: "En cours",
    emptyLabel: "Glissez une tâche ici",
    icon: Timer,
    pillClassName: "bg-primary/15 text-primary animate-pulse",
    badgeClassName: "border-primary/30 bg-primary/10 text-primary",
  },
  {
    id: "done",
    label: "Terminé",
    emptyLabel: "Rien de terminé",
    icon: CheckCircle2,
    pillClassName: "bg-emerald-500/15 text-emerald-500",
    badgeClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  },
];

const PRIORITY_META: Record<number, { label: string; className: string }> = {
  0: { label: "Priorité basse", className: "text-muted-foreground" },
  1: { label: "Priorité moyenne", className: "text-primary" },
  2: { label: "Priorité haute", className: "text-red-500" },
};
const PRIORITY_FALLBACK = {
  label: "Priorité inconnue",
  className: "text-muted-foreground",
};

/** Élargit la zone cliquable des petits boutons (~48px) sans gonfler le design. */
const HIT_AREA =
  "relative before:absolute before:-inset-2 before:rounded-md before:content-['']";

/** Seuil (px) au-delà duquel un pointerdown+click est considéré comme un drag. */
const DRAG_CLICK_THRESHOLD = 6;

/** Collision : priorité à ce qui est sous le curseur, sinon intersection géométrique. */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0
    ? pointerCollisions
    : rectIntersection(args);
};

// ---------- Utilitaires ----------

/** Recherche insensible à la casse et aux accents (É → e). */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue";
}

/** Ordre stable : priorité décroissante, échéance la plus proche, plus récente. */
function compareTasks(a: TaskDto, b: TaskDto): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  if (aDue !== bDue) return aDue - bDue;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** Regroupe et trie les tâches par statut (défensif si un statut inconnu arrive). */
function groupByStatus(list: TaskDto[]): Record<TaskStatus, TaskDto[]> {
  const groups: Record<TaskStatus, TaskDto[]> = {
    todo: [],
    doing: [],
    done: [],
  };
  for (const task of list) {
    if (task.status in groups) groups[task.status].push(task);
  }
  for (const status of Object.keys(groups) as TaskStatus[]) {
    groups[status].sort(compareTasks);
  }
  return groups;
}

// ---------- Sous-composants ----------

function ColumnSkeleton() {
  return (
    <Card className="h-full gap-0 rounded-xl bg-muted/40 py-0">
      <CardHeader className="flex-row items-center gap-2 p-3 pb-2">
        <Skeleton className="size-6 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto size-8 rounded-md" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-2 pt-0">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </CardContent>
    </Card>
  );
}

function GlobalEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-xl bg-card/60 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <ListTodo className="size-7" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold">Aucune tâche pour l&apos;instant</h3>
        <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted-foreground">
          Créez votre première tâche, puis faites-la glisser entre les colonnes
          pour suivre son avancement.
        </p>
      </div>
      <Button onClick={onCreate} className="h-11 gap-2 px-5">
        <Plus className="size-4" aria-hidden="true" />
        Créer ma première tâche
      </Button>
    </Card>
  );
}

type TaskCardContentProps = {
  task: TaskDto;
  /** Attributs/listeners dnd-kit — absents pour la version rendue dans le DragOverlay. */
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  overlay?: boolean;
  onEdit?: (task: TaskDto) => void;
  onMove?: (task: TaskDto, status: TaskStatus) => void;
  onDelete?: (task: TaskDto) => void;
};

/** Rendu visuel d'une carte (utilisé en place et dans le DragOverlay). */
function TaskCardContent({
  task,
  attributes,
  listeners,
  overlay = false,
  onEdit,
  onMove,
  onDelete,
}: TaskCardContentProps) {
  const interactive = !overlay;
  const pointerDown = useRef<{ x: number; y: number } | null>(null);

  const priority = PRIORITY_META[task.priority] ?? PRIORITY_FALLBACK;
  const dueDate = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = dueDate !== null && isBefore(dueDate, new Date());

  /** Enregistre le point de départ puis transmet le pointerdown à dnd-kit. */
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerDown.current = { x: event.clientX, y: event.clientY };
    listeners?.onPointerDown?.(event);
  };

  /** Ouvre l'édition au clic simple, mais ignore les clics issus d'un drag. */
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const origin = pointerDown.current;
    pointerDown.current = null;
    if (
      origin &&
      (Math.abs(event.clientX - origin.x) > DRAG_CLICK_THRESHOLD ||
        Math.abs(event.clientY - origin.y) > DRAG_CLICK_THRESHOLD)
    ) {
      return; // il s'agissait d'un déplacement, pas d'un clic
    }
    onEdit?.(task);
  };

  return (
    <div
      {...(interactive ? attributes : undefined)}
      {...(interactive ? listeners : undefined)}
      onPointerDown={interactive ? handlePointerDown : undefined}
      onClick={interactive ? handleClick : undefined}
      className={cn(
        "group/card relative rounded-lg border bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,opacity,transform] duration-150",
        interactive
          ? "cursor-grab select-none hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          : "pointer-events-none cursor-grabbing rotate-2 scale-[1.02] border-primary/60 shadow-2xl shadow-black/40",
        task.status === "done" && "opacity-75",
      )}
    >
      {/* Ligne 1 : priorité, titre, menu contextuel */}
      <div className="flex items-start gap-2">
        <Flag
          className={cn("mt-0.5 size-3.5 shrink-0", priority.className)}
          aria-hidden="true"
        />
        <span className="sr-only">{priority.label}.</span>
        <span
          className={cn(
            "min-w-0 flex-1 text-sm font-medium leading-snug",
            task.status === "done" &&
              "text-muted-foreground line-through decoration-muted-foreground/60",
          )}
        >
          {task.title}
        </span>

        {interactive ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  HIT_AREA,
                  "-m-1 size-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                onClick={(event) => event.stopPropagation()}
                aria-label={`Actions pour la tâche « ${task.title} »`}
              >
                <MoreVertical className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Déplacer vers</DropdownMenuLabel>
              {COLUMNS.map((column) => {
                const MoveIcon = column.icon;
                return (
                  <DropdownMenuItem
                    key={column.id}
                    disabled={column.id === task.status}
                    onClick={() => onMove?.(task, column.id)}
                  >
                    <MoveIcon
                      className={cn(
                        "size-4",
                        column.id === task.status && "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                    {column.label}
                    {column.id === task.status ? (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        actuelle
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onEdit?.(task)}>
                <Pencil className="size-4" aria-hidden="true" />
                Modifier
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete?.(task)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Supprimer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* Description tronquée sur une ligne */}
      {task.description ? (
        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
          {task.description}
        </p>
      ) : null}

      {/* Métadonnées : échéance, badge IA, poignée de saisie */}
      <div className="mt-2.5 flex items-center gap-2 text-xs">
        {dueDate ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium tabular-nums",
              overdue ? "text-red-500" : "text-muted-foreground",
            )}
            title={format(dueDate, "EEEE d MMMM 'à' HH:mm", { locale: fr })}
          >
            <CalendarClock className="size-3.5" aria-hidden="true" />
            {format(dueDate, "d MMM · HH:mm", { locale: fr })}
          </span>
        ) : null}

        {task.aiPriority !== null ? (
          <Badge
            variant="outline"
            className="gap-1 border-purple-500/40 bg-purple-500/10 px-1.5 text-[10px] font-medium text-purple-400"
            title={`Priorité estimée par l'IA : ${task.aiPriority}`}
          >
            <Sparkles className="size-3" aria-hidden="true" />
            IA
          </Badge>
        ) : null}

        <GripVertical
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-opacity",
            interactive
              ? "opacity-0 group-hover/card:opacity-70"
              : "opacity-70",
          )}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

type TaskCardProps = {
  task: TaskDto;
  onEdit: (task: TaskDto) => void;
  onMove: (task: TaskDto, status: TaskStatus) => void;
  onDelete: (task: TaskDto) => void;
};

/** Carte sortable (dans une colonne du Kanban). */
function TaskCard({ task, onEdit, onMove, onDelete }: TaskCardProps) {
  const { attributes, isDragging, listeners, setNodeRef } = useSortable({
    id: task.id,
    data: { type: "task", column: task.status },
  });

  return (
    <li ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <TaskCardContent
        task={task}
        attributes={attributes}
        listeners={listeners}
        onEdit={onEdit}
        onMove={onMove}
        onDelete={onDelete}
      />
    </li>
  );
}

type KanbanColumnProps = {
  column: ColumnDef;
  tasks: TaskDto[];
  onEdit: (task: TaskDto) => void;
  onMove: (task: TaskDto, status: TaskStatus) => void;
  onDelete: (task: TaskDto) => void;
  onCreate: (status: TaskStatus) => void;
};

/** Colonne droppable du Kanban (accepte le drop même vide). */
function KanbanColumn({
  column,
  tasks,
  onEdit,
  onMove,
  onDelete,
  onCreate,
}: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
    data: { type: "column", column: column.id },
  });
  const ColumnIcon = column.icon;

  return (
    <div ref={setNodeRef} className="flex h-full">
      <Card
        className={cn(
          "h-full w-full gap-0 rounded-xl border-border/60 bg-muted/40 py-0 transition-colors",
          isOver && "border-primary/50 bg-primary/5",
        )}
      >
        <CardHeader className="flex-row items-center gap-2 p-3 pb-2">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full",
              column.pillClassName,
            )}
            aria-hidden="true"
          >
            <ColumnIcon className="size-3.5" />
          </span>
          <CardTitle className="text-sm font-medium">
            {column.label}
          </CardTitle>
          <Badge
            variant="outline"
            className={cn("ml-1 tabular-nums", column.badgeClassName)}
            aria-label={`${tasks.length} ${tasks.length > 1 ? "tâches" : "tâche"}`}
          >
            {tasks.length}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HIT_AREA,
              "-m-1 ml-auto size-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-primary",
            )}
            onClick={() => onCreate(column.id)}
            aria-label={`Ajouter une tâche dans « ${column.label} »`}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </CardHeader>

        <CardContent className="p-2 pt-0">
          <ScrollArea className="md:max-h-[70vh]">
            <SortableContext
              items={tasks.map((task) => task.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-2 pb-0.5 pr-0.5">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onEdit={onEdit}
                    onMove={onMove}
                    onDelete={onDelete}
                  />
                ))}
                {tasks.length === 0 ? (
                  <li className="pointer-events-none flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/25 p-4 text-center">
                    <Inbox
                      className="size-4 text-muted-foreground/60"
                      aria-hidden="true"
                    />
                    <p className="text-xs text-muted-foreground">
                      {column.emptyLabel}
                    </p>
                  </li>
                ) : null}
              </ul>
            </SortableContext>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Vue principale ----------

export function TasksView() {
  const { data, isLoading } = useTasks();
  const { update, remove } = useTaskMutations();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskDto | null>(null);
  const [dialogStatus, setDialogStatus] = useState<TaskStatus>("todo");
  const [taskToDelete, setTaskToDelete] = useState<TaskDto | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTask, setActiveTask] = useState<TaskDto | null>(null);
  const [activeWidth, setActiveWidth] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const tasks = useMemo(() => data?.tasks ?? [], [data]);

  const filtered = useMemo(() => {
    const query = fold(search.trim());
    if (!query) return tasks;
    return tasks.filter(
      (task) =>
        fold(task.title).includes(query) ||
        fold(task.description ?? "").includes(query),
    );
  }, [tasks, search]);

  const byStatus = useMemo(() => groupByStatus(tasks), [tasks]);

  const visibleByStatus = useMemo(
    () => groupByStatus(filtered),
    [filtered],
  );

  const doingCount = byStatus.doing.length;
  const doneCount = byStatus.done.length;

  // ----- Dialogs -----

  const openCreate = (status: TaskStatus) => {
    setEditingTask(null);
    setDialogStatus(status);
    setDialogOpen(true);
  };

  const openEdit = (task: TaskDto) => {
    setEditingTask(task);
    setDialogStatus(task.status);
    setDialogOpen(true);
  };

  // ----- Mutations optimistes -----

  /** Déplace une tâche (drag, menu « Déplacer vers ») avec MAJ optimiste du cache. */
  const moveTask = async (task: TaskDto, status: TaskStatus) => {
    if (task.status === status) return;
    qc.setQueryData(["tasks"], (old: { tasks: TaskDto[] } | undefined) =>
      old
        ? {
            tasks: old.tasks.map((t) =>
              t.id === task.id ? { ...t, status } : t,
            ),
          }
        : old,
    );
    try {
      await update.mutateAsync({ id: task.id, input: { status } });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    } catch (err) {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.error("Déplacement impossible", {
        description: errMessage(err),
      });
    }
  };

  const deleteTask = async (task: TaskDto) => {
    setIsDeleting(true);
    qc.setQueryData(["tasks"], (old: { tasks: TaskDto[] } | undefined) =>
      old ? { tasks: old.tasks.filter((t) => t.id !== task.id) } : old,
    );
    try {
      await remove.mutateAsync(task.id);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("Tâche supprimée", {
        description: `« ${task.title} » a été supprimée.`,
      });
      setTaskToDelete(null);
    } catch (err) {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.error("Suppression impossible", { description: errMessage(err) });
    } finally {
      setIsDeleting(false);
    }
  };

  // ----- Drag & drop -----

  const taskTitleOf = (id: string | number): string =>
    tasks.find((t) => t.id === id)?.title ?? "la tâche";

  const columnLabelOf = (id: string | number): string => {
    const column = COLUMNS.find((c) => c.id === id);
    if (column) return column.label;
    const task = tasks.find((t) => t.id === id);
    const status = task
      ? COLUMNS.find((c) => c.id === task.status)?.label
      : undefined;
    return status ?? "cette zone";
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTask(
      tasks.find((t) => t.id === String(event.active.id)) ?? null,
    );
    setActiveWidth(event.active.rect.current.initial?.width ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    setActiveWidth(null);
    const { active, over } = event;
    if (!over) return;

    const sourceColumn = (
      active.data.current as { column?: TaskStatus } | undefined
    )?.column;
    const targetColumn = (
      over.data.current as { column?: TaskStatus } | undefined
    )?.column;
    if (!sourceColumn || !targetColumn || sourceColumn === targetColumn) {
      return; // même colonne : pas de réordonnancement persisté
    }

    const task = tasks.find((t) => t.id === String(active.id));
    if (task) void moveTask(task, targetColumn);
  };

  const handleDragCancel = () => {
    setActiveTask(null);
    setActiveWidth(null);
  };

  // ----- Rendu -----

  return (
    <section aria-label="Tâches" className="flex flex-col gap-4">
      {/* Barre supérieure : recherche, résumé, création */}
      {isLoading || tasks.length > 0 ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Rechercher une tâche…"
              className="h-11 pl-9"
              aria-label="Rechercher une tâche par titre ou description"
            />
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <p
              className="text-xs text-muted-foreground tabular-nums sm:text-sm"
              aria-live="polite"
            >
              {doingCount} en cours · {doneCount} terminées
            </p>
            <Button
              onClick={() => openCreate("todo")}
              className="h-11 gap-2 px-4"
            >
              <Plus className="size-4" aria-hidden="true" />
              Nouvelle tâche
            </Button>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((column) => (
            <ColumnSkeleton key={column.id} />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <GlobalEmptyState onCreate={() => openCreate("todo")} />
      ) : (
        <>
          {!isLoading &&
          search.trim() !== "" &&
          filtered.length === 0 ? (
            <p
              role="status"
              className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground"
            >
              Aucune tâche ne correspond à « {search.trim()} ».
            </p>
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
            accessibility={{
              announcements: {
                onDragStart: ({ active }) =>
                  `Tâche saisie : ${taskTitleOf(active.id)}. Utilisez les touches fléchées pour la déplacer, puis Espace pour la déposer.`,
                onDragOver: ({ over }) =>
                  over ? `Zone survolée : ${columnLabelOf(over.id)}.` : "",
                onDragEnd: ({ over }) =>
                  over
                    ? `Tâche déposée dans « ${columnLabelOf(over.id)} ».`
                    : "Déplacement annulé.",
                onDragCancel: () => "Déplacement annulé.",
              },
              screenReaderInstructions: {
                draggable:
                  "Pour saisir une tâche au clavier, placez-vous dessus avec Tab, appuyez sur Espace, déplacez-la avec les flèches, puis déposez-la avec Espace ou annulez avec Échap.",
              },
            }}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {COLUMNS.map((column) => (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  tasks={visibleByStatus[column.id]}
                  onEdit={openEdit}
                  onMove={(task, status) => void moveTask(task, status)}
                  onDelete={(task) => setTaskToDelete(task)}
                  onCreate={openCreate}
                />
              ))}
            </div>

            <DragOverlay>
              {activeTask ? (
                <div style={{ width: activeWidth ?? undefined }}>
                  <TaskCardContent task={activeTask} overlay />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </>
      )}

      {/* Création / édition */}
      <TaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        task={editingTask}
        defaultStatus={dialogStatus}
      />

      {/* Confirmation de suppression */}
      <AlertDialog
        open={taskToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setTaskToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette tâche ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {taskToDelete?.title} » sera définitivement supprimée. Cette
              action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive"
              disabled={isDeleting}
              onClick={() => {
                if (taskToDelete) void deleteTask(taskToDelete);
              }}
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
