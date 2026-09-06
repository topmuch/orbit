"use client";

// Orbit — Réglages · API publique & webhooks sortants (Task 20-e)
// ─────────────────────────────────────────────────────────────────────────────
// Carte de gestion : clés d'API (création → secret affiché UNE fois, révocation)
// et webhooks (URL https + événements + secret de signature, test, pause,
// suppression, journal des 5 dernières livraisons). Bloc doc curl + HMAC.
// Données : hooks React Query LOCAUX (["api-keys"], ["webhooks"]) sur les
// routes de gestion /api/keys* et /api/webhooks* (auth session).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow, parseISO } from "date-fns";
import { fr, enGB, es, type Locale } from "date-fns/locale";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n/provider";
import {
  Webhook,
  KeyRound,
  Plus,
  Trash2,
  Copy,
  TriangleAlert,
  ChevronDown,
  ChevronRight,
  Loader2,
  Send,
  X,
} from "lucide-react";

// ── Types (contrats des routes de gestion) ─────────────────────────────────

type ApiKeyDto = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  isActive: boolean;
  revokedAt: string | null;
};

type WebhookLogDto = {
  event: string;
  status: string;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
};

type WebhookDto = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  lastStatus: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  createdAt: string;
  logs: WebhookLogDto[];
};

type WebhookCreateInput = { url: string; events: string[]; description?: string };

type WebhookTestResult = { ok: boolean; statusCode: number | null; error: string | null };

/** Événements exposés au formulaire (clé i18n par événement). */
const EVENT_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: "task.created", labelKey: "api.eventTaskCreated" },
  { value: "task.updated", labelKey: "api.eventTaskUpdated" },
  { value: "task.deleted", labelKey: "api.eventTaskDeleted" },
  { value: "event.created", labelKey: "api.eventEventCreated" },
  { value: "event.updated", labelKey: "api.eventEventUpdated" },
  { value: "event.deleted", labelKey: "api.eventEventDeleted" },
];

/** Locales date-fns (import statique — pas de flash de langue). */
const DATE_FNS_LOCALES: Record<string, Locale> = { fr, en: enGB, es };

// ── Hooks React Query locaux ───────────────────────────────────────────────

function useApiKeys() {
  return useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<{ keys: ApiKeyDto[] }>("/api/keys"),
  });
}

function useApiKeyMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["api-keys"] });
  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ apiKey: ApiKeyDto; secret: string }>("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    // Rafraîchit la liste après création (la clé apparaît immédiatement).
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/keys/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  return { create, revoke };
}

function useWebhooks() {
  return useQuery({
    queryKey: ["webhooks"],
    queryFn: () => api<{ webhooks: WebhookDto[] }>("/api/webhooks"),
  });
}

function useWebhookMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["webhooks"] });
  const create = useMutation({
    mutationFn: (input: WebhookCreateInput) =>
      api<{ webhook: WebhookDto; secret: string }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    // Rafraîchit la liste après création.
    onSuccess: invalidate,
  });
  const toggle = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      api<{ webhook: WebhookDto }>(`/api/webhooks/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: vars.isActive }),
      }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/webhooks/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: (webhookId: string) =>
      api<WebhookTestResult>("/api/webhooks/test", {
        method: "POST",
        body: JSON.stringify({ webhookId }),
      }),
    onSuccess: invalidate, // rafraîchit logs + lastStatus
  });
  return { create, toggle, remove, test };
}

// ── Composants internes ────────────────────────────────────────────────────

/** Dialog « secret unique » (clé API ou secret de webhook). */
function SecretDialog({
  data,
  onClose,
  onCopy,
  copyLabel,
  closeLabel,
}: {
  data: { secret: string; title: string; warning: string } | null;
  onClose: () => void;
  onCopy: (secret: string) => void;
  copyLabel: string;
  closeLabel: string;
}) {
  return (
    <Dialog open={data !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{data?.title}</DialogTitle>
          <DialogDescription asChild>
            <p className="flex items-start gap-2 text-amber-500">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{data?.warning}</span>
            </p>
          </DialogDescription>
        </DialogHeader>
        <code className="block max-h-40 overflow-y-auto break-all rounded-lg bg-muted/60 p-3 font-mono text-xs select-all">
          {data?.secret}
        </code>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => data && onCopy(data.secret)}
            aria-label={copyLabel}
          >
            <Copy className="size-4" aria-hidden />
          </Button>
          <Button onClick={onClose} aria-label={closeLabel}>
            <X className="size-4" aria-hidden />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Carte principale ───────────────────────────────────────────────────────

export function ApiWebhooksCard() {
  const { t, locale } = useI18n();
  const dateLocale = DATE_FNS_LOCALES[locale] ?? fr;
  const keysQuery = useApiKeys();
  const { create: createKey, revoke: revokeKey } = useApiKeyMutations();
  const webhooksQuery = useWebhooks();
  const { create: createWebhook, toggle: toggleWebhook, remove: removeWebhook, test: testWebhook } =
    useWebhookMutations();

  // Formulaire clé API (inline)
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyName, setKeyName] = useState("");

  // Formulaire webhook (inline)
  const [showWebhookForm, setShowWebhookForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formEvents, setFormEvents] = useState<string[]>([]);

  // Dialog secret unique + confirmations de suppression
  const [secretDialog, setSecretDialog] = useState<{
    secret: string;
    title: string;
    warning: string;
  } | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<ApiKeyDto | null>(null);
  const [confirmDeleteWebhook, setConfirmDeleteWebhook] = useState<WebhookDto | null>(null);

  // Journal dépliable (un seul webhook ouvert à la fois)
  const [openLogs, setOpenLogs] = useState<string | null>(null);

  const keys = keysQuery.data?.keys ?? [];
  const webhooks = webhooksQuery.data?.webhooks ?? [];

  function formatRelative(iso: string): string {
    try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true, locale: dateLocale });
    } catch {
      return iso;
    }
  }

  /** Libellé localisé d'un événement webhook. */
  function eventLabel(event: string): string {
    const found = EVENT_OPTIONS.find((o) => o.value === event);
    return found ? t(found.labelKey) : event;
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  }

  // ── Clés : création ──────────────────────────────────────────────────────
  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    const name = keyName.trim();
    if (!name) return;
    try {
      const res = await createKey.mutateAsync(name);
      setKeyName("");
      setShowKeyForm(false);
      setSecretDialog({ secret: res.secret, title: res.apiKey.name, warning: t("api.keyOnce") });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleRevokeKey(key: ApiKeyDto) {
    setConfirmDeleteKey(null);
    try {
      await revokeKey.mutateAsync(key.id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // ── Webhooks : création ──────────────────────────────────────────────────
  async function handleCreateWebhook(e: React.FormEvent) {
    e.preventDefault();
    const url = formUrl.trim();
    // Validation côté client (le serveur revalide en Zod) : https strict,
    // http toléré pour localhost uniquement (récepteur local de dev/test).
    let urlOk = url.startsWith("https://") || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url);
    if (urlOk) {
      try {
        new URL(url);
      } catch {
        urlOk = false;
      }
    }
    if (!urlOk) {
      toast.error(t("api.invalidUrl"));
      return;
    }
    if (formEvents.length === 0) {
      toast.error(t("api.pickEvent"));
      return;
    }
    try {
      const res = await createWebhook.mutateAsync({
        url,
        events: [...formEvents],
        description: formDescription.trim() || undefined,
      });
      setFormUrl("");
      setFormDescription("");
      setFormEvents([]);
      setShowWebhookForm(false);
      setSecretDialog({ secret: res.secret, title: res.webhook.url, warning: t("api.secretOnce") });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleToggle(wh: WebhookDto, isActive: boolean) {
    try {
      await toggleWebhook.mutateAsync({ id: wh.id, isActive });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleTest(wh: WebhookDto) {
    try {
      const res = await testWebhook.mutateAsync(wh.id);
      if (res.ok) {
        toast.success(t("api.testSent"), {
          description: res.statusCode != null ? `HTTP ${res.statusCode}` : undefined,
        });
      } else {
        toast.error(res.error ?? t("common.error"));
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleRemoveWebhook(wh: WebhookDto) {
    setConfirmDeleteWebhook(null);
    try {
      await removeWebhook.mutateAsync(wh.id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Webhook className="size-4 text-primary" aria-hidden />
          {t("api.title")}
        </CardTitle>
        <CardDescription>{t("api.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ══════════ Sous-section : clés d'API ══════════ */}
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t("api.keysTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("api.keysDesc")}</p>
          </div>

          {keysQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            // Liste scrollable : div simple (max-h + overflow-y-auto) —
            // le ScrollArea Radix avec max-h sur le Root laisse le Viewport
            // déborder sur les éléments suivants (hauteur = contenu).
            <div className="orbit-scroll max-h-48 overflow-y-auto pr-3">
              {keys.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{t("api.noKeys")}</p>
              ) : (
                <ul className="space-y-2">
                  {keys.map((key) => (
                    <li
                      key={key.id}
                      className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
                    >
                      <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{key.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {key.keyPrefix}…
                          <span className="ml-2">
                            {t("api.lastUsed")}:{" "}
                            {key.lastUsedAt ? formatRelative(key.lastUsedAt) : t("api.never")}
                          </span>
                        </p>
                      </div>
                      {key.revokedAt || !key.isActive ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t("api.inactive")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-emerald-600/40 text-emerald-600">
                          {t("api.active")}
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmDeleteKey(key)}
                        disabled={key.revokedAt !== null || !key.isActive}
                        aria-label={t("common.delete")}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {showKeyForm ? (
            <form onSubmit={handleCreateKey} className="flex gap-2">
              <Input
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder={t("api.keyName")}
                maxLength={60}
                autoFocus
                className="h-9"
              />
              <Button
                type="submit"
                size="sm"
                disabled={createKey.isPending || keyName.trim().length === 0}
              >
                {createKey.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="size-4" aria-hidden />
                )}
                {t("common.create")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowKeyForm(false);
                  setKeyName("");
                }}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowKeyForm(true)}>
              <Plus className="size-4" aria-hidden />
              {t("api.createKey")}
            </Button>
          )}
        </section>

        <Separator />

        {/* ══════════ Sous-section : webhooks ══════════ */}
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t("api.webhooksTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("api.webhooksDesc")}</p>
          </div>

          {webhooksQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : webhooks.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t("api.noWebhooks")}</p>
          ) : (
            <ul className="space-y-3">
              {webhooks.map((wh) => (
                <li
                  key={wh.id}
                  className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate font-mono text-xs" title={wh.url}>
                        {wh.url}
                      </p>
                      {wh.description ? (
                        <p className="truncate text-xs text-muted-foreground">{wh.description}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-1">
                        {wh.events.map((event) => (
                          <Badge key={event} variant="secondary" className="text-[10px]">
                            {eventLabel(event)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex items-center gap-1">
                        {wh.isActive ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-600/40 text-emerald-600"
                          >
                            {t("api.active")}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            {t("api.inactive")}
                          </Badge>
                        )}
                        {wh.lastStatus ? (
                          <Badge
                            variant="outline"
                            className={
                              wh.lastStatus === "success"
                                ? "border-emerald-600/40 text-emerald-600"
                                : "border-red-600/40 text-red-600"
                            }
                          >
                            {wh.lastStatus === "success" ? t("api.delivered") : t("api.failed")}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleTest(wh)}
                          disabled={testWebhook.isPending}
                        >
                          {testWebhook.isPending && testWebhook.variables === wh.id ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Send className="size-3.5" aria-hidden />
                          )}
                          {t("api.test")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setConfirmDeleteWebhook(wh)}
                          aria-label={t("common.delete")}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                        <Switch
                          checked={wh.isActive}
                          onCheckedChange={(checked) => handleToggle(wh, checked)}
                          disabled={toggleWebhook.isPending}
                          aria-label={t("api.inactive")}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Journal des livraisons (dépliable) */}
                  <Collapsible
                    open={openLogs === wh.id}
                    onOpenChange={(open) => setOpenLogs(open ? wh.id : null)}
                  >
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                        {openLogs === wh.id ? (
                          <ChevronDown className="size-3.5" aria-hidden />
                        ) : (
                          <ChevronRight className="size-3.5" aria-hidden />
                        )}
                        {t("api.logs")}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      {wh.logs.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-muted-foreground">{t("api.noLogs")}</p>
                      ) : (
                        <ul className="space-y-1.5 px-2 py-1">
                          {wh.logs.map((log, index) => (
                            <li key={`${log.createdAt}-${index}`} className="flex items-center gap-2 text-xs">
                              <Badge
                                variant="outline"
                                className={
                                  log.status === "success"
                                    ? "border-emerald-600/40 text-emerald-600"
                                    : "border-red-600/40 text-red-600"
                                }
                              >
                                {log.status === "success" ? t("api.delivered") : t("api.failed")}
                              </Badge>
                              <span className="font-mono text-muted-foreground">{log.event}</span>
                              {log.statusCode != null ? (
                                <span className="text-muted-foreground">
                                  HTTP {log.statusCode}
                                </span>
                              ) : null}
                              <span className="ml-auto text-muted-foreground">
                                {formatRelative(log.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              ))}
            </ul>
          )}

          {showWebhookForm ? (
            <form onSubmit={handleCreateWebhook} className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-url">{t("api.url")}</Label>
                <Input
                  id="webhook-url"
                  type="url"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder={t("api.urlPlaceholder")}
                  autoComplete="url"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("api.events")}</Label>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {EVENT_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={formEvents.includes(option.value)}
                        onCheckedChange={(checked) =>
                          setFormEvents((prev) =>
                            checked
                              ? [...prev, option.value]
                              : prev.filter((v) => v !== option.value)
                          )
                        }
                      />
                      {t(option.labelKey)}
                    </label>
                  ))}
                </div>
              </div>
              <Input
                id="webhook-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                maxLength={200}
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={createWebhook.isPending || formUrl.trim().length === 0}
                >
                  {createWebhook.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Plus className="size-4" aria-hidden />
                  )}
                  {t("api.addWebhook")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowWebhookForm(false);
                    setFormUrl("");
                    setFormDescription("");
                    setFormEvents([]);
                  }}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowWebhookForm(true)}>
              <Plus className="size-4" aria-hidden />
              {t("api.addWebhook")}
            </Button>
          )}
        </section>

        <Separator />

        {/* ══════════ Bloc documentation ══════════ */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("api.docsTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("api.docsExample")}</p>
          <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs">
            {`curl -H "Authorization: Bearer orbit_votre_cle" \\
     -H "Content-Type: application/json" \\
     -d '{"title":"Tâche depuis l API"}' \\
     https://votre-domaine/api/v1/tasks`}
          </pre>
          <p className="text-xs text-muted-foreground">
            X-Orbit-Signature: sha256=&lt;hmac-sha256 du body avec le secret du webhook&gt;
          </p>
        </section>
      </CardContent>

      {/* Secret unique (clé API ou webhook) */}
      <SecretDialog
        data={secretDialog}
        onClose={() => setSecretDialog(null)}
        onCopy={copySecret}
        copyLabel={t("common.copy")}
        closeLabel={t("common.close")}
      />

      {/* Confirmation : révocation d'une clé */}
      <AlertDialog
        open={confirmDeleteKey !== null}
        onOpenChange={(open) => !open && setConfirmDeleteKey(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteKey?.name} — {confirmDeleteKey?.keyPrefix}…
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => confirmDeleteKey && handleRevokeKey(confirmDeleteKey)}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation : suppression d'un webhook */}
      <AlertDialog
        open={confirmDeleteWebhook !== null}
        onOpenChange={(open) => !open && setConfirmDeleteWebhook(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription className="break-all font-mono text-xs">
              {confirmDeleteWebhook?.url}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => confirmDeleteWebhook && handleRemoveWebhook(confirmDeleteWebhook)}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
