# Orbit — Worklog (journal des agents)

Projet : Orbit "OS Personnel" — Phase 1 (adaptée à l'environnement sandbox : Next.js 16 App Router, SQLite+Prisma, z-ai-web-dev-sdk pour l'IA, auth cookie signée).

Stack : Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui (src/components/ui) · Prisma SQLite · TanStack Query · dnd-kit · date-fns (fr) · sonner · z-ai-web-dev-sdk (backend uniquement).

Design : thème "cosmos" repensé (Task 7-a) — palette de marque **bleu profond #0A2540 / cyan #00D4FF / orange #FF6B35**, neutres #F5F5F7 → #1A1A1A (décision explicite de l'utilisateur, remplace l'ancien accent ambre). Tokens sémantiques shadcn + tokens de marque `orbit-*` dans globals.css (`@theme`), classes utilitaires `.orbit-cosmos`, `.orbit-stars`, `.orbit-scroll` conservées. Conventions conservées : emerald = succès, violet = IA, amber résiduel uniquement pour états d'avertissement (repli IA, retards).

---
Task ID: 1-6
Agent: main (Z.ai Code)
Task: Socle backend + foundation frontend d'Orbit

Work Log:
- prisma/schema.prisma : modèles User, Event, Task, EmailLog, PushSubscription (SQLite) — db push OK
- .env : DATABASE_URL + AUTH_SECRET générée
- src/lib/auth.ts : scrypt hash + session cookie httpOnly signée HMAC (30j)
- src/lib/types.ts : DTO partagés (EventDto, TaskDto, EmailDto, StatsDto, EventSuggestion, SessionUser)
- src/lib/validators.ts : schémas zod de toutes les entrées API
- src/lib/dto.ts : sérialiseurs Prisma → DTO
- src/lib/demo.ts : seed démo réaliste (dates relatives) + generateIncomingEmails (synchro IMAP simulée)
- APIs : /api/auth/{register,login,logout,session,demo}, /api/events[+/:id], /api/tasks[+/:id], /api/emails[+/:id,/sync], /api/stats, /api/profile, /api/push/subscribe, /api/ai/chat (streaming SSE→texte), /api/ai/analyze (extraction événement)
- Tests curl OK : demo login 200, stats 200, analyse IA (dentiste → suggestion 14:30-15:15 conf 0.95), chat streaming contextuel OK
- globals.css : tokens Orbit (ambre sur noir chaud, + variant clair), starfield, animations orbit/pulse, scrollbar fine
- layout.tsx : metadata PWA (manifest, icônes, themeColor, viewport cover), lang=fr
- providers.tsx : QueryClient + ThemeProvider (dark) + Toaster sonner + PwaRegister
- PWA : public/manifest.json, public/sw.js (network-first navigations, cache-first statiques, push handler), public/offline.html, icônes générées via sharp (scripts/generate-icons.mjs)
- src/lib/api-client.ts : hooks React Query (session, events, tasks, emails, stats, mutations, auth) — CONTRAT UNIQUE pour les vues
- src/components/orbit/logo.tsx, event-dialog.tsx, task-dialog.tsx : dialogs partagés (API : open/onOpenChange/event|task/defaultDate|defaultStatus)
- src/lib/pwa-store.ts + pwa-register.tsx : état install/online + capture beforeinstallprompt

Stage Summary:
- Backend 100% fonctionnel et testé (auth, CRUD, IA streaming + extraction)
- Contrats frontend figés : types (src/lib/types.ts) et hooks (src/lib/api-client.ts)
- Les vues doivent consommer EXCLUSIVEMENT ces hooks/dialogs — ne pas réimplémenter de fetch

---
Task ID: 8-b
Agent: full-stack-developer
Task: Vue Tâches Kanban Orbit (tasks-view.tsx)

Work Log:
- Lecture du worklog, de src/lib/types.ts, src/lib/api-client.ts, src/components/orbit/task-dialog.tsx et des composants shadcn (card, badge, dropdown-menu, alert-dialog, scroll-area, button, skeleton) + vérification des types exportés par @dnd-kit/core (DraggableAttributes, DraggableSyntheticListeners) et de la config tsconfig (strict)
- Création de src/components/orbit/tasks-view.tsx (859 lignes, 'use client', export unique TasksView())
- Kanban 3 colonnes (Card bg-muted/40, pastille icône Circle/Timer/CheckCircle2, Badge compteur, bouton « + ») — grid grid-cols-1 md:grid-cols-3 gap-4, ScrollArea md:max-h-[70vh] par colonne
- dnd-kit : DndContext global, useDroppable par colonne (data={{ column }}), SortableContext + useSortable par carte (verticalListSortingStrategy), PointerSensor(distance 6) + KeyboardSensor(sortableKeyboardCoordinates), collisionDetection pointerWithin→rectIntersection, DragOverlay rendant la carte (largeur mesurée via active.rect) avec rotation/ombre
- Clic sur carte → TaskDialog édition (détection drag vs clic par distance pointerdown→click > 6px) ; dropdown MoreVertical par carte : « Déplacer vers » (mêmes mutations que le drag, alternative clavier/tactile), Modifier, Supprimer (destructive + AlertDialog de confirmation)
- MAJ optimiste via qc.setQueryData(["tasks"], ...) AVANT update.mutateAsync({ id, input: { status } }) puis qc.invalidateQueries({ queryKey: ["tasks"] }) à la fin et onError + toast sonner ; suppression optimiste idem via remove.mutateAsync(id)
- Barre supérieure : recherche (fold NFD sans accents, titre+description), résumé « X en cours · Y terminées » (aria-live), bouton « Nouvelle tâche » ; états : 3 colonnes de 3 Skeletons, empty state par colonne (« Glissez une tâche ici » / « Rien de terminé »), empty state global « Créer ma première tâche », bandeau « Aucun résultat » si recherche infructueuse
- Accessibilité : announcements dnd-kit + screenReaderInstructions en FR, focus-visible ring sur cartes, aria-labels sur boutons (hit area ~48px via before:-inset-2 sur kebab/« + »), badges compteur + priorité en sr-only
- Vérifications : bunx eslint src/components/orbit/tasks-view.tsx → 0 erreur/0 warning ; bunx tsc --noEmit → 0 erreur pour le fichier ; dev.log OK (les 2 erreurs du lint global viennent de task-dialog.tsx d'un agent précédent, non touchées)

Stage Summary:
- tasks-view.tsx prêt à intégrer : export unique TasksView() sans prop, consomme uniquement useTasks/useTaskMutations/TaskDialog/TaskDto (contrats 8-a respectés)
- Tri stable par colonne : priorité desc → échéance asc (nulls last) → createdAt desc (pas de persistance d'ordre manuel : drop dans la même colonne = no-op, documenté dans le code)
- Aucune autre création/modification de fichier ; couleurs conformes (accent ambre, pastilles emerald pour « Terminé », rouge pour priorité haute/échéance dépassée, violet pour badge IA — aucun indigo/bleu)

---
Task ID: 8-a
Agent: full-stack-developer
Task: Vue Calendrier Orbit (calendar-view.tsx)

Work Log:
- Lecture du worklog, de src/lib/types.ts, src/lib/api-client.ts, event-dialog.tsx (API du dialog figée) et des composants shadcn (toggle-group, tooltip, card, badge, button, skeleton) + tokens globals.css (thème cosmos, .orbit-scroll)
- Création de src/components/orbit/calendar-view.tsx (880 lignes, 'use client', export unique CalendarView(), aucune prop)
- Toolbar : titre de période (format fr minuscules : « septembre 2025 » / « 31 août – 6 septembre 2025 » / « vendredi 4 septembre 2025 »), boutons ‹ › + « Aujourd'hui » (aria-labels dynamiques Mois/Semaine/Jour précédent/suivant), ToggleGroup Mois/Semaine/Jour + bouton « Nouvel événement » (label masqué < sm), wrap mobile avec titre pleine largeur
- Vue Mois : grille 7 colonnes (Lun..Dim), 6 lignes fixes (differenceInCalendarWeeks(endOfMonth, startOfMonth) + 1, max 6), gap-px bg-border/50 sur Card, cellules min-h-[64px] sm:min-h-[96px], weekStartsOn 1 ; jour courant = pastille ronde bg-primary text-primary-foreground ; hors mois = text-muted-foreground/40 ; week-ends très légèrement teintés (getDay) ; puces chips hidden sm:flex (max 3 + « +N autre(s) » → bascule vue Jour) remplacées sur mobile par points colorés sm:hidden (max 6 + « +N ») ; clic zone vide → EventDialog création defaultDate = jour + heure courante ; clic puce/point → édition (stopPropagation)
- Vue Semaine : colonnes Lundi→Dimanche, 16 lignes horaires 07:00→22:00 (h-11 = 44px), gouttière avec heure toutes les 2h (text-[10px] text-muted-foreground, centrée sur la ligne), événements en absolu (top = minutes depuis 7h / 60 × 44, hauteur = durée / 60 × 44, min 20px, heure de début masquée si hauteur < 34px), placement en couloirs (assignLanes : grappes transitives de chevauchement → largeur 100%/laneCount) ; clic ET double-clic sur créneau vide → création à la date/heure du point cliqué arrondie à la demi-heure (getBoundingClientRect + clientY) ; ligne « maintenant » rafraîchie chaque minute (60 s setInterval) ; mobile : overflow-x-auto orbit-scroll, min-w-[900px]
- Vue Jour : agenda vertical, créneaux horaires 07:00→22:00 en boutons min-h-[44px] (clic → création à l'heure), lignes d'événement = heure de début en gras (colonne fixe w-16 tabular-nums) + carte source (titre + description tronquée) + Badge outline avec icône (Mail/Sparkles) si source ≠ manual ; cas limites « Plus tôt »/« Plus tard » pour les événements hors 07h–22h ; vide → « Aucun événement ce jour-là » + bouton « Ajouter un événement »
- Couleurs par source (bordure gauche 3px + fond teinté, chips/carte/badge) : manual = ambre (primary), email_extract = émeraude, ai = violet — aucun indigo/bleu
- États : isLoading → 6 Skeletons (role=status + sr-only) ; 0 événement → empty state discret (icône CalendarDays, texte, bouton) ; isError → message + « Réessayer » (refetch, non demandé mais conforme aux standards UI)
- Mutations uniquement via EventDialog (event non-null = édition, null + defaultDate = création pré-remplie) — useEventMutations jamais appelé dans la vue
- Vérifications : bunx eslint calendar-view.tsx → 0 erreur ; bunx tsc --noEmit → 0 erreur sur le fichier ; test runtime complet via agent-browser (login démo) : rendu des 3 vues vérifié + screenshots QA visuelle (VLM), clic créneau 10:00 en vue Jour → dialog 10:00–11:00, clic créneau en vue Semaine → dialog 11:30 (arrondi demi-heure), clic événement → dialog d'édition pré-rempli, aucune erreur console ; page.tsx restauré à l'identique après test

Stage Summary:
- calendar-view.tsx prêt à intégrer : export unique CalendarView() sans prop, consomme uniquement useEvents()/EventDialog/EventDto (contrats respectés strictement)
- Implémentation 100 % custom (aucune lib calendrier) : date-fns v4 locale fr, thème sombre spatial accent ambre, Tooltip sur chaque puce/carte (titre + plage horaire), aria-labels FR sur tous les boutons icônes, cibles tactiles 44px sur la barre d'outils et les créneaux
- Décisions assumées : « +N autre(s) » bascule vers la vue Jour du jour concerné (affichage complet) ; événements multi-jours affichés sur leur jour de début (pas de continuation) ; touches « Plus tôt »/« Plus tard » pour les événements hors grille 07h–22h
- Aucun autre fichier créé/modifié (page.tsx touché uniquement pour un test runtime puis restauré byte-identique) ; lint global : 0 erreur sur ce fichier (les 2 erreurs restantes viennent de event-dialog/task-dialog, fichiers d'agents précédents, non touchés)

---
Task ID: 8-15
Agent: main (Z.ai Code)
Task: Vues restantes, intégration, QA end-to-end et corrections

Work Log:
- Correction des dialogs (event-dialog, task-dialog) : pattern composant interne remonté (suppression des setState dans useEffect — erreurs React Compiler)
- auth-view.tsx : écran connexion/inscription/démo, panneau orbital animé (3 anneaux CSS), footer sticky mobile
- app-shell.tsx : sidebar desktop + bottom nav mobile (safe-area iOS) + header (offline, install PWA, notifications, menu utilisateur) + footer desktop mt-auto
- notifications-center.tsx : Sheet calculé en direct (événements <24h, tâches en retard, emails à analyser)
- dashboard-view.tsx : 4 stats, graphe semaine à venir (custom), agenda du jour cliquable, priorités avec complétion 1 clic, derniers emails
- emails-view.tsx : inbox split-pane responsive + analyse IA → SuggestionCard (confiance, durée) → création événement
- assistant-view.tsx : chat streaming (ReadableStream client), markdown, suggestions, abort propre
- settings-view.tsx : profil, thème clair/sombre, notifications navigateur, installation PWA, carte architecture IA privée
- page.tsx : assembly SPA (auth gate → shell → vues) + fond cosmos (nébuleuses + étoiles)
- FIX UX : PATCH /api/emails/[id] efface suggestedEvent quand isProcessed=true (évite double création d'événement)

QA Agent Browser (tous validés) :
- login démo → dashboard complet (stats, agenda, priorités, emails, toast)
- complétion de tâche depuis dashboard → propagée au kanban
- création événement via clic jour vide → dialog pré-rempli → toast + affichage calendrier
- vue semaine + navigation mois
- drag & drop kanban todo→doing → PERSISTÉ en base (vérifié via API)
- emails : sélection, analyse IA Orange (→ échéance facture 10 sept., conf 95%), création événement (source email_extract), suggestion ignorée
- assistant : "Résume ma journée" → réponse markdown contextualisée (événements réels)
- thème clair ↔ sombre, viewport mobile 375px (bottom nav, emails mobile)
- PWA : SW actif, manifest + icônes 200, CHARGEMENT HORS-LIGNE OK, retour en ligne OK
- inscription nouveau compte (Marie) → empty states → déconnexion
- zéro erreur console, zéro erreur dev.log
- QA visuelle VLM : 8-9/10 (login/dashboard/semaine)

Stage Summary:
- Orbit Phase 1 (+ une bonne part des phases 2-4) livré et vérifié E2E
- 0 erreur lint, 0 erreur runtime, toutes les interactions testées au navigateur
- Prêt pour la suite : IMAP réel, Web Push VAPID, branchage Ollama (contrats /api/ai/* isolés)

---
Task ID: 16
Agent: main (Z.ai Code)
Task: Prompt 5 — Intégration IA locale : micro-service isolé (Ollama → fallback), branchage Next.js, docker-compose production, .env.example

Work Log:
- mini-services/ai-service/ (bun --hot, port 3031) : GET /health, POST /analyze-email (prompt d'extraction + parsing JSON tolérant + normalisation), POST /chat (streaming text/plain) — routeur de providers : Ollama (/api/generate, format json, NDJSON stream) si OLLAMA_URL, sinon z-ai-web-dev-sdk ; CORS permissif, chargement du .env parent, timeouts configurables
- src/lib/ai-prompts.ts : prompts d'extraction (source de vérité du fallback, duplicata documenté du mini-service)
- src/lib/ai-provider.ts : SEUL point de sortie IA de Next.js — extractEvent() + chatCompletionStream() via AI_SERVICE_URL (défaut http://localhost:3031) avec fallback SDK direct si service injoignable ; getLastAiProvider() pour l'observabilité
- /api/ai/analyze et /api/ai/chat rebranchés sur ai-provider (auth + contexte DB inchangés, bornes métier conservées) ; /api/ai/status (nouveau) expose l'état du micro-service
- api-client.ts : hooks useAIAnalysis (Prompt 5), useAIStatus + streamAssistant() (assistant-view.tsx refactorisé dessus, plus de fetch inline)
- settings-view.tsx : carte « Assistant IA & confidentialité » enrichie de badges en direct (« Micro-service IA en ligne », « Ollama local — modèle » / « Moteur de repli ») via useAIStatus
- Production : docker-compose.yml (ollama + ai-api FastAPI), docker/ollama/{Dockerfile,entrypoint.sh} (pull auto llama3), docker/ai-service/{main.py FastAPI complet, requirements.txt, Dockerfile, README.md avec instructions ollama pull llama3} — même contrat REST que le mini-service, aucun fallback cloud en prod (confidentialité stricte)
- .env.example complet (DB, AUTH, micro-service IA, Ollama, VAPID/IMAP/Resend pour Phase 3)
- tsconfig.json : exclude mini-services (projet bun indépendant)

QA E2E (agent-browser + curl) :
- mini-service : /health 200, /analyze-email direct (dentiste → 14:30-15:15, conf 0.95), /chat streaming OK
- app : login démo → emails → analyse « Dîner samedi soir ? » → suggestion → création événement « Dîner anniversaire Marc 20:00-23:00 » visible au calendrier
- assistant streaming contextuel (« Quels sont mes événements ce week-end ? » → réponse complète avec agenda réel)
- test de résilience : mini-service tué → /api/ai/analyze passe en provider=nextjs-fallback (extraction OK) → service relancé
- carte Réglages : badges d'état en direct vérifiés ; QA visuelle VLM 9/10
- 0 erreur lint global, 0 erreur console navigateur, 0 erreur dev.log ; mini-service et app UP

Stage Summary:
- Architecture Prompt 5 livrée et vérifiée : [navigateur] → /api/ai/* (Next.js) → micro-service :3031 → Ollama/fallback, avec repli Next.js si service down
- Bascule production Ollama = définir OLLAMA_URL + docker compose up (aucun changement applicatif)
- Reste (Phase 3+) : Web Push VAPID, IMAP réel, priorisation IA des tâches (aiPriority inutilisé)

---
Task ID: 7-a
Agent: full-stack-developer
Task: Design System complet d'Orbit — nouvelle palette bleu profond #0A2540 / cyan #00D4FF / orange #FF6B35 (remplacement explicite de l'ancien thème ambre "cosmos")

Work Log:
- Lecture du worklog + fichiers clés (globals.css, tailwind.config.ts, button/badge/input/card/skeleton/dialog, settings-view, page.tsx, providers, app-shell, dashboard-view, form.tsx, sonner.tsx, logo.tsx, types.ts)
- src/app/globals.css : refonte complète des tokens sémantiques shadcn (:root / .dark) en hex — clair : bg #F5F5F7, primary #0A2540, accent #DFF5FE, ring #00D4FF, destructive #DC2626, border/input #DCE1E8, muted-fg #5C6674 ; sombre : bg #071729, card #0D2942, primary #00D4FF, primary-fg #06182B, secondary #0E3352/#B8E8F7, accent #0F3B5F/#7FE6FF, muted #0C2A45, muted-fg #8CA3B8, destructive #F87171, border/input #143A5C + tokens popover/sidebar/chart pour les deux modes (charts adaptés au mode)
- globals.css : tokens de marque exposés en utilitaires Tailwind dans @theme inline : --color-orbit-deep/-cyan/-cyan-strong (#0074A0, AA sur clair)/-cyan-soft (#7FE6FF)/-accent (#FF6B35)/-accent-strong (#E8601F hover) + nouveau bloc @theme { --animate-orbit-shimmer + @keyframes orbit-shimmer }
- globals.css : .orbit-cosmos adapté — nébuleuses cyan (rgba(0,212,255, .05 clair / .10 sombre)) + orange (rgba(255,107,53, .03 / .06)) ; .orbit-stars teintes cyan ; .orbit-scroll / animations orbit-spin/orbit-pulse/caret-blink inchangés et fonctionnels
- tailwind.config.ts : theme.extend.colors complété — orbit { deep, cyan, cyan-strong, cyan-soft, accent, accent-strong } + échelle neutral 50→950 (#F5F5F7 → #1A1A1A), mappings sémantiques corrigés en var() directs, commentaire documentant que la source de vérité Tailwind 4 est @theme dans globals.css (aucun @config)
- src/components/ui/button.tsx : variante `accent` ajoutée (bg-orbit-accent #FF6B35, texte blanc, hover bg-orbit-accent-strong #E8601F) ; autres variants vérifiés avec la nouvelle palette (tokens sémantiques)
- src/components/orbit/status-badge.tsx (nouveau) : StatusBadge({ status: TaskStatus }) — todo = outline neutre « À faire » (Circle), doing = cyan de marque « En cours » (Timer, texte #0074A0 clair / #7FE6FF sombre sur fond cyan/15), done = emerald « Terminé » (CheckCircle2, convention succès conservée)
- src/components/ui/skeleton.tsx : bg-accent → bg-muted + léger shimmer (after:: gradient via-foreground/10, animate-orbit-shimmer 1.8s) au-dessus de la pulsation
- src/components/orbit/logo.tsx : dégradés SVG passés à la marque — planète bleu profond (#1E4E78→#0A2540→#06182B), anneau cyan (#7FE6FF→#00D4FF→#0074A0), étoile orange #FF6B35 + étoiles cyan/blanches (composant de marque, pas une vue)
- src/components/orbit/design-system-showcase.tsx (nouveau, 'use client', export unique) : carte repliable (Collapsible contrôlé, ouverte par défaut, trigger ≥44px) « Design System — aperçu des composants » — tous les variants/tailles/états de Button (dont accent, disabled, loading spinner), Card événement + Card tâche + rangée StatusBadge, Input email avec validation en direct (regex : neutre / valide bordure emerald + icône Check / invalide aria-invalid + message destructive), Dialog « Aperçu », toasts sonner succès + erreur, bascule Skeleton ↔ contenu chargé (1,5 s simulée), nuancier de 10 swatches (marque + tokens clés avec hex)
- src/components/orbit/settings-view.tsx : intégration du showcase en bas de la grille (après la carte IA, avant Déconnexion), wrapper div lg:col-span-2 — AUCUNE autre modification (carte Notifications push intacte)
- Vérifications : bunx eslint (7 fichiers touchés) → 0 erreur/0 warning ; bunx tsc --noEmit → 0 erreur dans src/ (erreurs préexistantes uniquement dans examples/skills/tests, hors périmètre) ; dev.log propre
- QA navigateur (agent-browser, login démo) : dashboard / calendrier / tâches / emails / assistant / réglages + showcase — thèmes clair ET sombre, viewport 375px (bottom nav + showcase pleine largeur) ; interactions testées : validation email (aria-invalid true/false + messages), Dialog, 2 toasts, simulation skeleton 1,5 s, replier/déplier le showcase ; 0 erreur console, 0 page error ; QA visuelle VLM : dashboard 9/10, kanban 9/10, calendrier 8.5/10, emails 9/10, assistant 9/10, showcase sombre 8.5/10, showcase clair 8.5/10, mobile sombre 7.5/10 (remarques = tailles sm shadcn standard + poids visuel du showcase, assumés) — contraste AA vérifié par calcul sur les tokens (muted-fg ≥ 5:1 sur les deux modes, primary/primary-fg ≥ 9:1)

Stage Summary:
- Design system livré : palette sémantique complète light/dark + tokens de marque orbit-* (utilitaires bg-/text-/border-orbit-*), nébuleuses cosmos cyan/orange, shimmer skeleton, variante Button accent, StatusBadge FR, showcase vivant intégré aux Réglages
- Décisions/ajustements vs recommandations : --destructive-foreground ajouté (blanc) ; charts sombres adaptés (chart-3 #7FE6FF, chart-4 #B8E8F7, chart-5 #8CA3B8) car #0A2540 invisible sur fond nuit ; cyan "doing" du StatusBadge assombri en #0074A0 en clair (#00D4FF pur = 1.8:1 illisible) ; tokens sidebar dérivés de la palette ; logo repassé aux couleurs de marque (fichier non listé dans les interdits, cohérence de marque) ; texte blanc sur bouton accent conservé tel que spécifié (2.8:1 — choix de marque explicite de l'utilisateur, reporté ici par transparence) ; neutres tailwind.config = documentation uniquement (Tailwind 4 CSS-first)
- Aucune vue modifiée (elles suivent les tokens automatiquement) ; conventions emerald (succès) / violet (IA) / amber (avertissements existants : repli IA, retards) conservées ; routes API, mini-services/, prisma/, SW intouchés

---
Task ID: 8
Agent: general-purpose
Task: Déblocage navigateur + QA E2E finale (push + design system)

Work Log:
- Déblocage : pkill agent-browser / chromium headless (dialog natif Notification.requestPermission bloquant) → shell OK
- Santé services : Next.js :3000 → 200 ; ai-service :3031 → ok (zai-fallback, uptime 2020 s) ; reminder :3032 → ok (runCount 26→33 en 65 s, errorCount stable 1) ; mock-push :3443 → 201. Aucun redémarrage nécessaire.
- QA navigateur (agent-browser, 1280×800 puis 375×667) : login démo → dashboard complet (stats/agenda/priorités/emails, screenshot /tmp/qa-dashboard.png) ; calendrier mois OK (événements visibles 1-9 sept) ; kanban 3 colonnes (2/3/4 cartes) ; emails liste + panneau détail + suggestion IA 95 % ; assistant « Résume ma journée » → réponse streamée contextualisée (~3 s) ; Réglages : carte « Rappels push » présente (badge « Permission non demandée », « 1 appareil abonné ») — bouton d'activation NON cliqué (interdit) ; showcase Design System présent (Boutons dont Accent orange, StatusBadge, champ email validation, Dialog, toasts, skeleton, palette 10 swatches) ; interactions testées : Dialog ouvert→fermé (via X), toast succès affiché, email invalide → « Format invalide — exemple attendu : prenom@exemple.fr » + aria-invalid=true, email valide → état neutre/valide ; screenshot /tmp/qa-showcase.png ; thème Clair vérifié dashboard lisible (/tmp/qa-light.png) puis retour Cosmos (dark restauré) ; mobile 375×667 : bottom nav 6 boutons + dashboard OK, screenshot /tmp/qa-mobile.png ; viewport remis 1280×800.
- BUG CORRIGÉ (bloquant QA mobile) : dashboard-view.tsx l.248 — `grid gap-4 lg:grid-cols-2` sans `grid-cols-1` de base → piste auto implicite sous lg dimensionnée à la min-content des descriptions `truncate` (white-space:nowrap) → overflow horizontal scrollWidth 1300 px vs 375 px. Fix minimal : `grid grid-cols-1 gap-4 lg:grid-cols-2` (= minmax(0,1fr)) + commentaire documenté. Vérifié live avant le patch (gridTemplateColumns minmax(0,1fr) → scrollWidth 375) puis rechargé avec le vrai code : sw=cw=375 sur les 6 vues. Les autres grids sans base grid-cols (settings-view l.122, assistant l.138, showcase l.210, emails l.364) mesurées SANS overflow à 375 px — non touchées (contenu wrappable).
- Note mineure (non bloquante, non corrigée) : dans le Dialog du showcase, le bouton « Compris » est un Button sans handler de fermeture (seuls « Fermer »/X/Esc ferment) — design volontaire du showcase, à améliorer si souhaité.
- Vérifications : `bun run lint` → 0 erreur ; `bunx tsc --noEmit` → 0 erreur dans src/ (préexistantes uniquement : examples/, skills/, tests/mock-push) ; tail dev.log → que des 200/prisma queries, 0 erreur runtime ; agent-browser errors/console vides à chaque étape (HMR/React info seulement).
- API push (session fraîche /tmp/qa-jar.txt) : POST /api/auth/demo → user Alex Martin ; GET /api/subscribe → configured:true + publicKey + subscriptions:1 ; POST /api/notify {"type":"test"} → sent:1/removed:0/failed:0 ; mock.log → « POST /push/orbit-e2e-001 — 264 octets chiffrés, TTL=2419200, aes128gcm » reçu.
- QA VLM (z-ai vision) : dashboard 8.5/10 (contraste/hiérarchie excellents, suggestion mineure : étiquettes du graphe semaine) ; showcase 8.5/10 ; mobile 8.5/10 (remarque « bottom nav tronquée » = faux positif vérifié programmatiquement : nav fullyVisible, bottom=667=vh, main pb-28=112 px > 56 px nav).

Stage Summary:
- QA E2E finale RÉUSSIE : 4/4 services up, 6 vues naviguées sans erreur console, push VAPID vérifié bout-en-bout (subscription en base + notify → mock chiffré aes128gcm), design system showcase fonctionnel, thèmes clair/sombre OK, mobile OK.
- 1 bug bloquant corrigé (overflow horizontal dashboard mobile, fix 1 ligne documenté dans le code) ; lint + tsc src/ propres après correction ; reminder-service actif (runCount croissant, 0 nouvelle erreur).
- Screenshots : /tmp/qa-dashboard.png, /tmp/qa-showcase.png, /tmp/qa-light.png, /tmp/qa-mobile.png ; verdicts VLM : /tmp/vlm-qa.json, /tmp/vlm-showcase.json, /tmp/vlm-mobile.json.

---
Task ID: 9 (main)
Agent: main (Z.ai Code)
Task: Notifications Push PWA complètes (VAPID, /api/subscribe, /api/notify, SW, rappels 15min/1h) — livrées et validées E2E

Work Log:
- web-push installé + clés VAPID générées (bunx web-push generate-vapid-keys) → .env + .env.example (VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT, REMINDER_SERVICE_SECRET)
- prisma/schema.prisma : reminderSentAt DateTime? sur Event et Task (anti-doublon de rappels) + db:push + régénération client (redémarrage dev server requis)
- src/lib/push.ts : couche VAPID unique — ensureWebPushConfigured, sendPushToUser (purge auto des subscriptions mortes 404/410), countSubscriptions, payload typé {title, body, tag, url, kind}
- /api/subscribe (GET statut+clé publique, POST upsert par endpoint, DELETE désinscription) remplace /api/push/subscribe (supprimée, non utilisée)
- /api/notify : POST {type:"test"} (session) ou {type:"reminders"} (header x-orbit-service-secret) — scan events <15 min + tasks non-done <1 h, envoi, marquage reminderSentAt (uniquement si l'utilisateur a des appareils : un abonnement tardif reçoit quand même son rappel)
- public/sw.js : push enrichi (renotify, tag, vibrate, requireInteraction pour event/task, actions « Ouvrir »/« Ignorer », deep link au clic + focus navigation)
- api-client.ts : usePushStatus, usePushMutations (enable : permission→subscribe→POST, disable : DELETE+unsubscribe, test), urlBase64ToUint8Array
- settings-view.tsx : carte « Rappels push » (badges permission/appareils, activer/désactiver/tester selon l'état)
- mini-services/reminder-service :3032 (bun --hot) : cycle 60 s → POST /api/notify avec secret, /health + POST /run manuel ; logs propres
- Harnais de test E2E : tests/mock-push/server.ts (mock de service push HTTPS :3443, cert auto-signé + NODE_EXTRA_CA_CERTS sur le dev server) — a permis de valider le chiffrement RÉEL (JWT VAPID + AES128GCM + TTL) sans infra FCM

Tests E2E backend (curl + mock push) :
- POST /api/subscribe fake → 201 ; subscription invalide → erreur web-push propre (validation p256dh 65 bytes)
- notify test → sent=1, mock reçoit POST aes128gcm 264 octets chiffrés
- rappels : event à +10 min + tâche à +40 min créés → POST :3032/run → eventsNotified=1, tasksNotified=1, sent=2 (2 push chiffrés reçus par le mock) ; re-run → 0 (idempotence OK)
- purge : subscriptions mortes supprimées via DELETE ; rapport {sent, removed, failed} toujours propre

Stage Summary:
- Push PWA complet : demande de permission → subscription → envoi VAPID chiffré → affichage SW → rappels automatiques 15 min/1 h anti-doublon, avec désinscription et purge automatiques
- reminder-service :3032 actif (cycle 60 s, POST /run pour tests) ; production : remplacer par un cron externe (curl POST /api/notify + secret) — aucun changement applicatif
- Limite sandbox documentée : le push réel jusqu'au navigateur exige FCM/Mozilla push + navigateur non headless ; tout le reste (chiffrement, TTL, signatures, purge, idempotence) est validé via mock HTTPS
- Design system (Task 7-a) et QA finale non-régression (Task 8) livrés par les subagents ; dashboard mobile overflow corrigé

---
Task ID: 10 (main)
Agent: main (Z.ai Code)
Task: Création du dépôt GitHub topmuch/orbit et publication du code

Work Log:
- Vérification du token GitHub fourni (GET /user → compte topmuch authentifié)
- Audit de l'index git : fichiers sensibles détectés comme trackés — .env (AUTH_SECRET, VAPID_PRIVATE_KEY, REMINDER_SERVICE_SECRET) et db/custom.db (hash de mots de passe) — plus artefacts sandbox (.zscripts/, examples/, tool-results/, download/, Caddyfile, __pycache__, tests/*.sh)
- .gitignore durci : .env/.env.* avec exception !.env.example, db/, *.db, .zscripts/, tool-results/, download/, examples/, Caddyfile, __pycache__/, *.pyc, *.pid, agent-ctx/
- git rm --cached des fichiers sensibles et artefacts (fichiers conservés sur disque — env/db locaux intacts, services vérifiés 200 après opération)
- Ajouts : README.md complet (FR : présentation, fonctionnalités, architecture ASCII, démarrage rapide, docker production, structure, lien .env.example) + docs/screenshots/ (8 captures QA : dashboard sombre/clair, calendrier, kanban, emails, assistant, mobile, showcase)
- Historique squashé en 1 commit propre via branche orpheline (13144bf) — garantit qu'AUCUN secret n'existe dans les objets git poussés (les anciens commits contenaient .env)
- Création du dépôt via API : POST /user/repos → topmuch/orbit (public, branche main, description FR)
- Push avec token en URL one-shot (remote configuré proprement ensuite : https://github.com/topmuch/orbit.git, sans token dans .git/config)

Vérifications (API GitHub contents) :
- .env, db/custom.db, .zscripts, tool-results → 404 (absents du dépôt — aucun secret exposé)
- README.md, .env.example, package.json, prisma/schema.prisma, screenshots, mini-services/ai-service, docker-compose.yml → 200
- 1 commit unique sur main à distance ; lint et services locaux inchangés (app 200, ai-service 200)

Stage Summary:
- Dépôt publié : https://github.com/topmuch/orbit (public — bascule private possible en 1 requête API si souhaité)
- Sécurité : secrets (VAPID, AUTH) et données utilisateurs (SQLite) exclus à la fois du tree ET de l'historique (squash orphelin) ; .env.example fourni comme gabarit
- Local : environnement de dev inchangé et fonctionnel (fichiers toujours sur disque)

---
Task ID: 11 (main)
Agent: main (Z.ai Code)
Task: Synchronisation version locale ↔ version GitHub

Work Log:
- Diagnostic : local en avance de 1 commit (62143f5, auto-commit plateforme 01:41) qui ré-ajoutait 3 scripts sandbox (tests/database-runtime-build.sh, tests/python-runtime-build.sh, tests/python-runtime-container.sh) volontairement exclus du dépôt ; et 147 fichiers « modifiés » = UNIQUEMENT des changements de mode 644→755 (artefact chmod sandbox, 0 insertion/0 suppression — contenu identique)
- git reset origin/main : commit auto-commit droppé, les 3 scripts restent sur disque en untracked (rien de perdu localement)
- git config core.fileMode false (config locale) : git ignore désormais le bruit de permissions du sandbox
- .gitignore : ajout de tests/*.sh avec exception !tests/mock-push/ (le harnais de test réel reste tracké) → statut git 100 % propre et les futurs auto-commits plateforme ne ré-incluront plus ces scripts
- Push du commit chore a5cd476 → local et distant synchronisés (rev-list 0/0)

Stage Summary:
- État final : main local == origin/main (a5cd476), git status propre, secrets toujours absents du dépôt, fichiers sandbox/env/db intacts sur disque
- Racine du désynchronisement identifiée et neutralisée : auto-commits plateforme + chmod 755 sandbox (core.fileMode=false)

---
Task ID: 11-bis (main)
Agent: main (Z.ai Code)
Task: Réparation post-restauration snapshot (.env vidé, reminder-service down) — suite de la synchronisation

Work Log:
- Symptôme : reminder-service :3032 injoignable → cause : .env réduit à DATABASE_URL seul (restauration snapshot de la plateforme) → REMINDER_SERVICE_SECRET manquant → arrêt immédiat du service
- Récupération des secrets originaux depuis l'objet store git (commit pré-squash 5daae0a accessible via reflog) : git show 5daae0a:.env → DATABASE_URL vérifiée identique (md5) puis restauration complète (AUTH_SECRET, VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT, REMINDER_SERVICE_SECRET, NEXT_PUBLIC_APP_NAME) — valeurs identiques à l'original, cookies de session existants toujours valides
- reminder-service relancé (bun run dev, log dans mini-services/reminder-service/reminder-service.log — couvert par *.log du .gitignore) → /health OK (runCount 1, errorCount 0, cycle 60 s actif)
- Vérifications : POST /api/auth/demo → Alex Martin + cookie OK ; GET /api/subscribe (session) → configured:true + publicKey VAPID (le process Next.js a bien les secrets en mémoire) ; DB intacte (1 user, 10 events, 9 tasks, 7 emails) ; pushSubscriptions:0 (la fake subscription des tests mock a disparu avec le snapshot — état plus propre)
- git status 100 % propre (0 entrée) ; local == origin/main

Stage Summary:
- Environnement local intégralement réparé : .env original restauré depuis l'historique git (aucun secret régénéré, aucune donnée perdue), 3 services UP (:3000, :3031, :3032), DB complète
- Local et GitHub parfaitement synchronisés sur d25915a (statut clean, 0/0)

---
Task ID: 12-a (main)
Agent: main (Z.ai Code)
Task: Backend complet du système d'événements étendu — fuseaux horaires UTC, récurrences expansées, participants, rappels par événement, iCal import/export, conflits, rate limiting

Work Log:
- prisma/schema.prisma : Event étendu (location, allDay, timezone IANA, color, recurrence Json, recurrenceExceptions Json, attendees Json, reminders Json, externalId, reminderLog Json, index [userId,endTime] + [userId,externalId]) + User.timezone — db:push OK, client Prisma régénéré, dev server redémarré
- src/lib/timezone.ts (nouveau, zéro dépendance, pure Intl) : isValidTimezone, tzOffsetMs, utcToWall/wallToUtc (convention « murale » = Date dont les champs UTC contiennent l'heure locale ; arithmétique de calendrier sans dérive DST), wallToFormatable (pour date-fns), formatInTz, dayKeyInTz, startOfDayInTz, getBrowserTimezone, timezoneLabel, COMMON_TIMEZONES
- src/lib/calendar.ts (nouveau) : expandEvent — expansion à la volée des récurrences daily/weekly(byDays)/monthly(jour du mois OU nth jour de semaine, -1 = dernier), until inclusif (date seule = fin de journée), count, exceptions filtrées, fast-forward quand pas de count, garde-fous 5000 itérations/300 occurrences ; findConflicts (chevauchement strict), clampRange (plage max 400 j), groupByDay
- src/lib/ical.ts (nouveau) : parseIcs — dépliage de lignes, propriétés+paramètres avec guillemets, VALUE=DATE / TZID / Z, RRULE→règle Orbit (BYDAY+préfixe nth, UNTIL, COUNT), EXDATE, ATTENDEE, VALARM TRIGGER (durées ISO8601 négatives), échappement texte, couleurs COLOR/X-APPLE-CALENDAR-COLOR ; buildIcs — VCALENDAR RFC 5545 (CRLF, repli 75 octets byte-safe, DTSTAMP, UID, RRULE, EXDATE, VALARM push, ATTENDEE PARTSTAT)
- src/lib/rate-limit.ts (nouveau) : fenêtre glissante en mémoire + balayage, tooManyRequests 429 + Retry-After
- src/lib/events-service.ts (nouveau) : loadExpandedEvents (chargement + expansion partagés), computeConflicts, appendException, isOccurrenceOfSeries, sanitizeText, toJsonInput (Prisma.DbNull)
- types.ts : RecurrenceRule, EventAttendee, EventReminder, EventSource +import, EventDto étendu (location/allDay/timezone/color/recurrence/attendees/reminders/externalId/isOccurrence/seriesId/occurrenceStart), EventCreateInput/EventUpdateInput (scope single|series), EventImportResult
- validators.ts : eventCreateSchema/eventUpdateSchema complets (hexColor, tz IANA, participants ≤20, rappels ≤5 [0 min..14 j], récurrence [byDays weekly/monthly seulement, nth monthly seulement, count XOR until], refine fin>début), icsJsonSchema
- dto.ts : toEventDto/toOccurrenceDto (occurrence virtuelle : id=master, isOccurrence, seriesId, occurrenceStart) + parseRecurrence/parseAttendees/parseReminders défensifs
- Routes : GET/POST /api/events (plage start/end + expansion, alias legacy from/to, conflits non bloquants en réponse) ; PATCH/DELETE /api/events/[id] (scope « series » = master + reset reminderLog si heure/rappels changent ; scope « single » = exception de série + événement détaché créé) ; POST /api/events/import (multipart ou JSON, idempotent par UID — y compris round-trip de notre export via UID orbit-<id>@orbit.local, cap 1 Mo/500) ; GET /api/events/export (text/calendar, RRULE+EXDATE préservés, plage optionnelle) — toutes : auth session, ownership, rate limit, sanitize
- /api/notify : rappels par événement (défaut 15 min push), occurrences expansées (clés occ::minutes::type, log ≤200, pont legacy reminderSentAt), type « email » → EmailLog synthétique « Orbit — rappels » dans la boîte locale (100 % privé)
- /api/stats : ?tz=IANA, jours regroupés dans le fuseau, agenda/todayEvents/nextEvent/weekLoad EXPANSÉS (weekLoad.date = clé yyyy-MM-dd)
- /api/profile : PATCH timezone (IANA validé) ; /api/ai/chat : agenda expansé, formatage dans le fuseau de chaque événement

QA curl (tout validé) :
- création riche (tz Paris, reminders push+email, participant) → 201 + conflit détecté (« Déjeuner avec Claire »)
- weekly byDays [1,3] count 8 → 8 occurrences mar/jeu 10:00Z (12:00 murale Paris) — BUG de double comptage timeOfDay corrigé (wallMonday incluat déjà l'heure) ; mensuel 31 (fév/avr/juin sautés), 2e lundi (nth), until inclusif, allDay bihebdo 2 jours, DST 25 oct (murale 09:00 stable)
- PATCH scope single → exception + événement détaché ( occurrence d'origine remplacée dans la plage) ; DELETE single → master vivant, occurrence disparue ; PATCH series → titre propagé
- export .ics : RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=TU,TH + 2×EXDATE + VALARM -PT30M + COLOR ; import du même fichier → 13/13 skipped après fix round-trip ; import externe Google-style (TZID, pliage, BYDAY=2SA, ATTENDEE CN+PARTSTAT, VALARM -PT1D, VALUE=DATE 2 jours) → 2 créés, re-import → 2 skipped
- rappel email E2E : event +4 min, rappel 5 min → POST :3032/run → emailsSent=1, email « Dans 5 min : QA Rappel email … (Africa/Dakar) » dans la boîte, re-run → 0 (idempotent)
- validation : titre/fin<début/couleur/tz/interval/byDays-sur-daily → messages FR ; rate limit import → 429 au 21e + Retry-After
- stats?tz=Africa/Dakar → weekLoad clés yyyy-MM-dd correctes ; assistant → agenda expansé avec récurrences
- bunx tsc --noEmit → 0 erreur src/ ; bun run lint → 0 erreur 0 warning ; dev.log propre

Stage Summary:
- Backend événements complet et testé : UTC en stockage, tz IANA par événement + préférence profil, récurrences expansées à la volée (jamais persistées), exceptions de série (édition/suppression d'une occurrence), conflits non bloquants, iCal import/export idempotent, rappels multi-canaux par événement, rate limiting
- Contrats gelés pour le frontend : EventDto (isOccurrence/seriesId/occurrenceStart), GET /api/events?start&end (expansé), POST {event, conflicts}, PATCH/DELETE ?scope&occurrenceStart, POST /api/events/import (multipart|JSON), GET /api/events/export, GET /api/stats?tz=, PATCH /api/profile {timezone}
- QA events de test en base (QA Standup, QA Sport série + détaché, QA Conseil d'administration mensuel 2e samedi, QA Séminaire allDay, QA Rappel email) — exploitables pour la QA frontend

---
Task ID: 12-b
Agent: full-stack-developer
Task: Couche données frontend + composants partagés + modal d'événement complet (fuseaux, récurrence, participants, rappels, portée série)

Work Log:
- src/lib/api-client.ts (étendu, rien cassé) : useEventsRange(start?, end?) → queryKey ["events","range", isoStart, isoEnd] (GET ?start&end) ; useEvents(from?, to?) conservé comme alias legacy sur la MÊME queryFn/queryKey (invalidation ["events"] cohérente) ; EventInput = EventCreateInput ; useEventMutations() → create (POST → {event, conflicts}), update ({id, input, scope?, occurrenceStart?} → PATCH avec scope/occurrenceStart DANS le body → {event, master?, conflicts}), remove ({id, scope?, occurrenceStart?} → DELETE en query string → {ok, master?}) — onSuccess invalide events+stats+emails (rappels email) ; useEventImport() (FormData champ "file", sans Content-Type JSON) ; exportEvents(range?) fonction async → blob → <a download> + revoke → nom de fichier ; useProfileMutation() accepte string (compat settings-view) OU {name?, timezone?}
- src/hooks/useTimezone.ts (nouveau) : timezone d'affichage init = getBrowserTimezone() (navigateur source de vérité au montage, pas de GET profil), setTimezone → état + PATCH /api/profile fire-and-forget avec toast discret ; helpers mémoïsés toWall/wallToUtcDate/fmt (utcToWall+wallToFormatable+date-fns fr)/dayKey — zéro réimplémentation de timezone.ts
- src/hooks/useCalendar.ts (nouveau) : viewMode month|week|day|agenda + cursor + range [start, end) EXCLUSIF en useMemo (semaine lundi→dimanche weekStartsOn 1 ; mois = 6 semaines pleines ; jour = 00:00→24:00 ; agenda = startOfDay(cursor) +14 j), goToday/prev/next (delta selon mode : mois/semaine/jour/14 j), setMode/setCursor — useState/useMemo uniquement
- src/components/orbit/timezone-selector.tsx (nouveau) : <TimezoneSelector value onChange id? disabled? className?> — Select shadcn sur COMMON_TIMEZONES + fuseau navigateur/valeur en tête si absents, libellés timezoneLabel (UTC+02:00 — Europe/Paris) ; FIX cosmétique : instant normalisé ms=0 passé à timezoneLabel pour éviter l'arrondi « +01:59 » (bug de troncature sous-seconde dans tzOffsetMs — lib 12-a non modifiée)
- src/components/orbit/datetime-picker.tsx (nouveau) : <DateTimePicker date time onDateChange onTimeChange label inputId? error? disabled? timeDisabled?> — deux Inputs contrôlés type date/time sur une ligne sm:grid-cols-[1fr_auto], chaînes MURALES (conversion tz = responsabilité du parent), Label lié, aria-invalid + role="alert", timeDisabled pour all-day
- src/components/orbit/color-picker.tsx (nouveau) : <ColorPicker value onChange disabled? className?> — 8 pastilles (cyan/orange/bleu nuit/émeraude/violet/ambre/rose/sarcelle) + Auto (null, Sparkles), size-11 (44px), aria-pressed, Tooltip FR, re-clic = retour Auto
- src/components/orbit/event-dialog.tsx (RÉÉCRITURE complète) : <EventDialog open onOpenChange event? defaultDate? defaultTimezone? occurrenceStart? source?> ; EventForm remonté par key (pattern existant, zéro setState dans useEffect) ; Dialog sm:max-w-2xl + ScrollArea max-h-[calc(100vh-16rem)] (~80vh en réservant header/footer) ; champs : titre+badge source FR, Switch toute la journée (masque heures, filtre push<60min au submit + info), Début/Fin DateTimePicker (fin<début même jour → +1 j au submit + avertissement « passe minuit »), TimezoneSelector + « Stocké : yyyy-MM-dd HH:mm UTC » (pédagogie règle d'or), lieu+MapPin, description, ColorPicker ; RÉCURRENCE : Select none/daily/weekly/monthly + interval 1–365 + chips hebdo L-D (jour de début pré-coché/VERROUILLÉ à la création, tooltip) + mensuel dom OU nth (1er..dernier + jour) + fin sans/après count 1–500/jusqu'au date murale (count XOR until, champ adverse disabled) + résumé humain aria-live (« Chaque semaine : mardi, jeudi, samedi, 12 fois ») ; PARTICIPANTS : Collapsible + Badge compteur, ajout email (validation inline + doublons + ≤20) + nom, ligne = nom/email + Badge status cliquable (cycle pending→accepted→declined) + X ; RAPPELS : Collapsible + chips rapides 5min/15min/1h/1jour + lignes [nombre][unité minutes/heures/jours][Push/Email][X], ≤5 ; PORTÉE : RadioGroup « Cette occurrence uniquement / Toute la série » en tête si isOccurrence (ou master + occurrenceStart) — scope single → récurrence masquée (détaché jamais récurrent) et non envoyée, note « L'heure s'applique à toutes les occurrences » en série ; SUPPRESSION : AlertDialog + RadioGroup de portée + textes différenciés (occurrence/série/événement) ; validation locale FR + eventCreateSchema/eventUpdateSchema .safeParse au submit (mapping issues zod → champs, focus premier champ en erreur, aria-invalid) ; conversions STRICTES : chargement utcToWall→getUTC*, submit Date.UTC murale→wallToUtc→toISOString, allDay début minuit/fin minuit lendemain (min 1 j, affichage inclusif fin−1) ; defaultDate = INSTANT (conversion utcToWall affichée — documenté en tête de fichier) ; conflits → toast.warning non bloquant ; toasts succès avec résumé mural via wallToFormatable (« mardi 15 septembre · 13:24–14:24 (UTC) · répété chaque semaine »)
- QA agent-browser (compte démo) : (a) création « Déjeuner QA Paris » 12:00–13:30 Europe/Paris + rappel 15 min push → 201, toast « dimanche 13 septembre · 12:00–13:30 (Europe/Paris) », stocké 2026-09-13T10:00Z/11:30Z + reminders[{15,push}] vérifiés via API, visible au calendrier ; (b) « Sport hebdo QA » hebdo 3 jours (mar pré-coché/verrouillé + jeu + sam) + après 12 occurrences → toast « · répété chaque semaine », 12 occurrences expansées vérifiées via API (15/17/19/22/24/26/29 sept + 1/3/6/8/10 oct) ; (c) édition « Dîner anniversaire Marc » 20:00→20:30 → toast « Événement mis à jour · mardi 8 septembre · 20:30–23:00 (UTC) » ; (d) titre vidé → erreur inline « Le titre est requis » + dialog ouvert ; master mensuel 2e samedi pré-rempli + résumé « Le 2e samedi de chaque mois » ; contrat scope single (payload exact du dialog : attendees []/reminders []/recurrence omis) testé via fetch → détaché + exception + série continue (occurrence 17 sept remplacée par l'événement décalé, 19 sept intact) ; participants (email invalide inline, ajout, cycle statut, retrait), chips rappels, all-day (heures masquées), AlertDialog suppression + annulation, « passe minuit », réglages profil legacy (PATCH name seul → 200) ; console 0 erreur ; bun run lint 0 erreur/0 warning ; bunx tsc --noEmit 0 erreur src/ ; dev.log propre

Stage Summary:
- Couche frontend complète du système d'événements étendu : hooks de données (plage, mutations avec portée, import/export iCal), fuseau d'affichage persisté, état de vue calendrier pur, 3 composants partagés et le modal d'événement riche entièrement réécrit
- API publiques exactes : useEventsRange(start?: Date, end?: Date) ; useEvents(from?: Date, to?: Date) (alias) ; useEventMutations() → {create: EventInput→{event,conflicts}, update: {id, input: Partial<EventInput>, scope?, occurrenceStart?}→{event, master?, conflicts}, remove: {id, scope?, occurrenceStart?}→{ok, master?}} ; useEventImport() → File→EventImportResult ; exportEvents(range?: {start, end}) → Promise<string> ; useProfileMutation() → string|{name?, timezone?} ; useTimezone() → {timezone, setTimezone, toWall, wallToUtcDate, fmt(date, pattern), dayKey} ; useCalendar(initial?) → {viewMode, cursor, range, setMode, setCursor, goToday, prev, next} ; <TimezoneSelector value onChange id? disabled? className?> ; <DateTimePicker date time onDateChange onTimeChange label inputId? error? disabled? timeDisabled?> ; <ColorPicker value onChange disabled? className?> ; <EventDialog open onOpenChange event? defaultDate? defaultTimezone? occurrenceStart? source?>
- Décisions/limites : ScrollArea max-h calc(100vh-16rem) au lieu de 80vh brut (évite le débordement header/footer, ~80vh sur écran courant) ; l'édition d'occurrence en scope « série » pré-remplit depuis l'occurrence (l'heure murale d'une occurrence = l'ancre de série dans la pratique ; le DTO master n'est pas disponible dans le dialog) ; date-picker grid [1fr_auto] (date flexible, heure fixe) — inversé de la suggestion auto_1fr pour l'ergonomie ; chemin d'édition d'occurrence non déclenchable depuis calendar-view actuel (il ne voit que les masters via useEvents() sans plage — les occurrences n'y sont pas expansées) → contrat scope single validé via fetch avec le payload exact du dialog, l'UI (RadioGroup portée) vérifiée par revue de code + rendu du master mensuel ; defaultDate traité comme INSTANT UTC (documenté) ; QA artifacts en base : « Déjeuner QA Paris », « Sport hebdo QA » + détaché « (décalé) » ; bug cosmétique timezoneLabel (+01:59) contourné dans TimezoneSelector (instant ms=0) — lib 12-a laissée intacte

---
Task ID: 12-c
Agent: full-stack-developer (complété et vérifié par main — l'agent a été interrompu par limite de tours après le code, avant QA/worklog)
Task: Vue Calendrier complète (mois/semaine/jour/agenda, drag & drop, resize, couleurs, all-day, recherche, filtres, import/export, conflits, fuseau d'affichage) + EventCard + intégrations (settings, dashboard, notifications, emails)

Work Log:
- src/components/orbit/calendar-view.tsx : RÉÉCRITURE complète (~2 060 lignes) — signature publique CalendarView() inchangée (page.tsx intact) ; toolbar : titre de période (fmt dans le fuseau d'affichage), ‹ › Aujourd'hui, ToggleGroup Mois/Semaine/Jour/Agenda, TimezoneSelector, recherche NFD (titre+description+lieu), Popover filtres (source/allDay/récurrents + Badge count + reset), boutons Importer (input file .ics caché → useEventImport) / Exporter (exportEvents sur la plage) / Nouvel événement
- Vue Mois : 6×7 (lun→dim), hors-moi estompé, week-ends teintés, chips max 3 + « +N » → vue Jour, couleur = event.color ?? par source, allDay chip pleine largeur, icône Repeat, points colorés mobile
- Vue Semaine : gouttière 07h–22h (44px), rangée all-day en tête, événements absolus dans le fuseau d'affichage (toWall), placement en couloirs (assignLanes), ligne « maintenant » 60 s, DnD dnd-kit (PointerSensor 6px, droppables par colonne, DragOverlay, snap 15 min, drop sur all-day → passage toute la journée), RESIZE par poignée basse accessible en SLIDER clavier (flèches ±15 min), conflits = liseré pointillé + TriangleAlert, updates optimistes (setQueryData ["events","range",…] + rollback), clic/double-clic créneau vide → création pré-remplie
- Vue Jour : all-day en tête, créneaux 44px cliquables, cartes riches (heure tabular-nums, description, lieu MapPin, badges Repeat/source/Users/TriangleAlert), « Plus tôt/Plus tard », DnD + resize identiques
- Vue Agenda (nouveau) : 14 jours groupés par jour (en-têtes « aujourd'hui » en primary), items EventCard, ScrollArea max-h-[70vh], empty state + CTA
- États : skeletons par mode (role=status), erreur + Réessayer, empty states, bandeau recherche vide ; tooltips : titre + plage + lieu + recurrenceSummary (résumé humain de règle) + fuseau de l'événement si ≠ affichage ; a11y : aria-labels FR, focus-visible, aria-live discret
- src/components/orbit/event-card.tsx (nouveau, ~215 lignes) : carte partagée horizontale — barre couleur 3px, heure fmt, Repeat, lieu, badges source/participants/all-day, muted (passé), prop fmt (fuseau du parent) ; exporte SOURCE_META/SOURCE_ICON/eventChipStyle/eventKeyOf partagés avec calendar-view
- notifications-center.tsx : événements <24 h via useEventsRange(now, +24h) (OCCURRENCES incluses), heures via fmt
- dashboard-view.tsx : agenda du jour via stats.todayEvents (expansé serveur) + fmt ; graphe semaine : labels par DÉCOUPAGE de la clé yyyy-MM-dd (pas de new Date(key) — décalage tz) ; pastilles couleur par événement
- emails-view.tsx : EventDialog de création avec defaultTimezone + defaultDate instant + source email_extract ; heure de suggestion via fmt
- settings-view.tsx : TimezoneSelector branché useTimezone (persistance profil PATCH) + explication de la règle d'or UTC
- Interdits respectés : aucune route page, aucune dépendance, api-client/hooks/routes non modifiés (12-c avait tout de même ajusté timezone.ts timezoneLabel rounding — repris et validé par main)

Stage Summary:
- Vue Calendrier complète livrée : 4 modes, DnD + resize persistés, couleurs personnalisées, all-day, récurrences expansées affichées, conflits visuels, recherche + filtres, import/export iCal, fuseau d'affichage commutable
- L'agent s'est interrompu (limite de tours) après le code et une QA partielle (import navigateur « QA Import 12c (navigateur) », détachement d'occurrence « Sport hebdo QA (décalé) », clic créneau) — la QA complète E2E a été reprise et finalisée par main (Task 12-d)

---
Task ID: 12-d (main)
Agent: main (Z.ai Code)
Task: QA E2E finale navigateur du système d'événements complet + finitions + publication GitHub

Work Log:
- Finition EventCard : événements finissant après minuit — 2e ligne « → HH:mm » dans la colonne heure + libellé a11y « (+N j) » / « le lendemain » (avant : « 16:00 – 15:00 » ambigu) ; dayDiff calculé par comparaison de clés yyyy-MM-dd dans le fuseau d'affichage
- QA navigateur agent-browser (compte démo, 1280×800) :
  • 4 modes + navigation prev/next/Aujourd'hui OK ; mois = événements réels visibles avec heures, chips « +N autres »
  • DRAG & DROP validé bout-en-bout (souris granulaire avec seuil d'activation 6px de dnd-kit) : « QA Test clic créneau » déplacé mar. 08:00 → mer. 14:00 (PERSISTÉ en base, affichage optimiste mis à jour) puis retour mar. 09:00 — round-trip OK ; la commande drag native (téléport) ne franchit pas le seuil du PointerSensor — documented
  • RESIZE : poignées slider « flèches haut/bas ±15 min » présentes sur chaque carte (accessibilité clavier)
  • Édition d'OCCURRENCE via Agenda : dialog avec RadioGroup « Cette occurrence uniquement / Toute la série » → heure modifiée → occurrence DÉTACHÉE en base (exception de série + événement autonome) ; pipeline murale→UTC vérifié (16:00 Europe/Paris → 14:00:00Z) ; comportement « passe minuit » (+1 j si fin<début) confirmé conforme spec avec avertissement
  • Conflits visuels : chevauchements samedi marqués « — conflit d'horaire » (Déjeuner avec Claire / QA Standup / QA Rappel email)
  • Fuseau : bascule UTC → Europe/Paris → TOUTES les heures décalées +2 dans l'UI (Agenda), préférence PERSISTÉE en base (User.timezone = Europe/Paris) ; retour à l'état en fin de QA
  • Export : clic → GET /api/events/export?start&end 200, aucun rejet console ; Import : déjà validé API + l'agent 12-c avait importé via le navigateur (« QA Import 12c (navigateur) », source=import)
  • Recherche (« standup » → filtrage, « zzzz » → vide) ; filtres source/allDay/récurrents présents
  • Dashboard : labels du graphe semaine par clés (sam/dim corrects), agenda du jour expansé
  • Mobile 375×667 : scrollWidth == clientWidth (0 overflow), modes accessibles, bottom nav intacte
  • console : 0 erreur (l'avertissement Fast Refresh venait des éditions HMR de 12-c, absent après reload propre) ; errors : vide
- QA visuelle VLM : vue semaine 8/10 (conflits bien signalés, texte tronqué mineur), dashboard 8/10 (hiérarchie/palette excellentes), mobile 7/10 (densité d'icônes toolbar — point de polish, assumé)
- Vérifications finales : bunx tsc --noEmit → 0 erreur src/ ; bun run lint → 0 erreur 0 warning ; dev.log → uniquement des 200 (events range, export, stats, notify, subscribe, ai/status)
- Publication : commit + push GitHub topmuch/orbit

Stage Summary:
- Système d'événements complet livré et vérifié E2E : CRUD riche, 4 vues calendrier, récurrences expansées + exceptions d'occurrence, fuseaux UTC/IANA, participants, rappels par événement (push + email local), iCal import/export idempotent, conflits, drag & drop et resize persistés, recherche/filtres, mobile OK
- Limites documentées : la commande drag instantanée d'agent-browser ne déclenche pas dnd-kit (seuil 6px — l'interaction souris granulaire fonctionne) ; recherche limitée à la plage chargée ; useTimezone = état par instance (le fuseau persisté en profil sera relu au prochain chargement via navigateur — amélioration possible : lecture GET profil au montage)
- Données QA en base : séries hebdo/mensuel + détachés + imports .ics — directement observables dans l'app

---
Task ID: 13-a
Agent: main (Z.ai Code)
Task: Backend complet du système de gestion des tâches — Kanban, sous-tâches, tags, priorités, positions, stats, rate limiting (adapté SQLite + auth cookie personnalisée)

Work Log:
- prisma/schema.prisma : Task étendu (status +« archived » (soft delete), priority String LOW/MEDIUM/HIGH/URGENT, position Int entiers espacés, completedAt, relations tags[]/subtasks[]/event (SetNull), aiSuggestedPriority+aiConfidence placeholder Phase 4, index [userId,dueDate]+[userId,priority]) + NOUVEAUX modèles SubTask (cascade, position) et Tag (unique [userId,name], color hex) + User.tags + Event.tasks — db:push OK (9 tâches legacy priority Int → strings invalides, remplacées par re-seed)
- scripts/seed-demo-tasks.mts (nouveau) : seed idempotent — purge + 14 tâches riches (statuts dont 1 archivée, 4 priorités, échéances en retard/aujourd'hui/demain/sans date, 6 tags, 12 sous-tâches, 1 suggestion IA HIGH/0.87, 1 lien eventId) — exécuté OK
- src/lib/tasks.ts (nouveau) : TASK_STATUSES/ACTIVE_TASK_STATUSES/TASK_PRIORITIES, priorityWeight, labels FR, POSITION_STEP=1000, endPosition/insertPosition/normalizePositions, subtaskProgress, sortTasks (position|dueDate|priority|createdAt|title), foldText (NFD), isTaskOverdue
- src/lib/dates.ts (nouveau) : dueState (overdue/today/soon/later/none), formatDueDate (« Aujourd'hui · 18:00 », « Demain », « En retard de N j », « Dans 3 jours »), formatDueDateLong, DUE_STATE_CLASSES/HEX, dueStateLabel
- src/lib/types.ts : TaskStatus +« archived », TaskPriority, TagDto, SubTaskDto, TaskDto étendu (position/completedAt/tags/subtasks/aiSuggestedPriority/aiConfidence/eventId), TaskCreateInput/TaskUpdateInput/TaskMoveInput, TaskStatsDto (total/byStatus/byPriority/overdue/completedThisWeek/completionRate/week 7j)
- src/lib/validators.ts : taskCreateSchema/taskUpdateSchema complets (tags ≤10 par nom+color optionnelle, subtasks ≤50, eventId nullable, aiSuggestedPriority), taskMoveSchema {status, position=indice}, subtaskCreateSchema/subtaskUpdateSchema, tagCreateSchema/tagUpdateSchema — messages FR
- src/lib/dto.ts : toTaskDto(TaskWithRelations) — tags+subtasks triés par position, priorité/statut défensifs (valeurs héritées → défaut), TaskWithRelations exporté
- src/lib/tasks-service.ts (nouveau) : TASK_INCLUDE, loadOwnedTask, upsertTags (upsert par userId+name, couleur rafraîchie si fournie, dédoublonnage), tagConnect (create : ids seuls) / tagSet (update), completedAtValue (done→now, sortie→null), nextEndPosition, moveTaskWithinColumn (TRANSACTION : insertion à l'indice + renormalisation 1000·2000·3000 de TOUTE la colonne), createTaskWithRelations, updateTaskWithRelations (tableaux = remplacement complet), listTasks, taskDto
- Routes API : GET/POST /api/tasks (filtres status/priority csv, tag par nom|id, search contains, dueBefore/dueAfter, overdue=1, sortBy+sortOrder, pagination page/limit+total ; POST transactionnel position=fin de colonne, ownership eventId) ; PATCH+PUT/DELETE /api/tasks/[id] (PUT alias ; DELETE soft→archived par défaut, hard=1|2e appel sur archivée→purge, mode « archived »|« deleted ») ; PATCH /api/tasks/[id]/move (transaction atomique, indice cible) ; POST /api/tasks/[id]/subtasks (cap 50, position fin) ; PATCH/DELETE /api/tasks/[id]/subtasks/[subtaskId] (PATCH position=indice → renormalisation transactionnelle) ; GET /api/tasks/stats (byStatus/byPriority/overdue/completedThisWeek/completionRate/week 7j complétions par jour) ; GET/POST /api/tags (GET +taskCount, POST 409 doublon) ; PATCH/DELETE /api/tags/[id] (renommage 409 conflit, DELETE détache sans toucher les tâches) — toutes : auth session + ownership + rate limit (30-120/min selon route) + messages FR
- Adaptations routes existantes : /api/stats (include relations, priorité via priorityWeight, statuts actifs = non archivées, priorityTasks.map(taskDto)) ; /api/notify (tâches : status notIn [done, archived]) ; /api/ai/chat (tri priorité en mémoire — l'ordre alphabétique SQL des Strings est faux)
- src/lib/demo.ts : seed démo réécrit côté tâches (12 tâches + 6 tags + sous-tâches + completedAt relatifs, priorités nouvelles, 1 en retard, 1 lien événement) — pour les NOUVEAUX comptes démo
- BUG corrigé en cours de route : Prisma « Unknown argument set » — nested create exige connect (ids seuls) à la création, set (ids seuls) à la mise à jour → tagConnect/tagSet distincts + demo.ts ; glitch Turbopack dev : 404 HTML persistant sur le segment [id]/subtasks/[subtaskId] fraîchement créé (manifeste de routes) → résolu après re-évaluation du segment (route sonde puis suppression) — route 100 % fonctionnelle depuis
- QA curl exhaustive (tout validé) : GET filtres (status csv, priority URGENT, tag Travail, search « présentation », overdue=1 → facture+Point projet), tri dueDate asc / position, pagination page=2 limit=3+total ; POST riche (pos 7000 fin de colonne, tags upsertés QA créé+Travail réutilisé, sous-tâches 1000/2000, eventId lié) ; PATCH done→completedAt auto / retour→null ; PATCH /move doing→todo indice 0 → renormalisation colonne entière vérifiée ; sous-tâches POST/PATCH(completed+reorder indice 0)/DELETE ; tags POST 409 doublon, PATCH couleur/renommage 409 conflit, DELETE détache (tâches intactes) ; stats (14 tâches, byStatus {6,3,4,1}, overdue 2, completedThisWeek 3, week dim→sam) ; DELETE soft→archived puis hard→deleted puis 404 ; validation Zod FR (titre vide, prio EXTREME, position -1, eventId inconnu) ; rate limit 35 POSTs → 29×201 puis 429×6 ; PUT alias OK
- bunx tsc --noEmit : 0 erreur src/lib+src/app+src/hooks (les erreurs restantes sont dans les composants frontend à réécrire en 13-b + tests/mock-push pré-existants)
- Base finale propre : 14 tâches (positions espacées, 6 tags, 12 sous-tâches, 1 IA placeholder, 1 lien calendrier)

Stage Summary:
- Backend tâches complet et testé : CRUD riche, move transactionnel avec renormalisation, sous-tâches ordonnables, tags partagés upsertés (jamais de doublon), soft/hard delete, stats, rate limiting, validation Zod FR
- Contrats gelés pour le frontend (13-b) :
  • GET /api/tasks[?status,priority,tag,search,dueBefore,dueAfter,overdue,sortBy,sortOrder,page,limit] → {tasks: TaskDto[], page, limit, total} (tri défaut statut+position ; TaskDto = {id,title,description,status,priority,position,dueDate,completedAt,tags[],subtasks[](triés),aiSuggestedPriority,aiConfidence,eventId,createdAt,updatedAt})
  • POST /api/tasks {TaskCreateInput} → {task} 201 (tags [{name,color?}] upsertés, subtasks [{title}], position auto fin de colonne)
  • PATCH|PUT /api/tasks/:id {TaskUpdateInput} → {task} (tableaux = remplacement complet ; status→done pose completedAt)
  • DELETE /api/tasks/:id[?hard=1] → {ok, mode: "archived"|"deleted"} (soft par défaut ; 2e DELETE d'une archivée = purge)
  • PATCH /api/tasks/:id/move {status, position: indice 0-based} → {task} (renormalisation serveur)
  • POST /api/tasks/:id/subtasks {title} → {task, subtask} ; PATCH /api/tasks/:id/subtasks/:sid {title?,completed?,position?} → {task} ; DELETE → {task}
  • GET /api/tasks/stats → {stats: TaskStatsDto} ; GET /api/tags → {tags: TagDto & {taskCount}[]} ; POST /api/tags {name,color} → {tag} (409 doublon) ; PATCH /api/tags/:id → {tag} ; DELETE /api/tags/:id → {ok}
  • Helpers frontend prêts : lib/tasks.ts (priorityWeight, TASK_STATUS/PRIORITY_LABELS, subtaskProgress, sortTasks, foldText, isTaskOverdue), lib/dates.ts (dueState, formatDueDate, DUE_STATE_*)
- Statuts : spec TODO/IN_PROGRESS/DONE/ARCHIVED ↔ app todo/doing/done/archived (continuité données + reminder-service + stats) ; priorités string (l'ancien Int 0-2 a disparu — les données démo ont été re-seedées)

---
Task ID: 13-b
Agent: full-stack-developer (code) + main (finitions, correctifs de bugs critiques et QA E2E — l'agent s'est interrompu par limite de contexte après avoir livré tout le code, avant QA/worklog)

Task: Frontend complet du système de tâches — Kanban 4 colonnes + drag & drop persistant, vue liste triable avec actions groupées, modal riche (tags, sous-tâches, IA, lien calendrier), stats, TagManager, filtres, responsive mobile

Work Log:
- src/components/orbit/tasks/ (NOUVEAU dossier, 10 composants) : task-board.tsx (Kanban DndContext 3+1 colonnes couleurs spec #3B82F6/#F97316/#22C55E/#6B7280, SortableContext+droppable par colonne, DragOverlay rotate-2, doMove optimiste snapshot/rollback + move {status, position=indice}, menu « Déplacer vers », ToggleGroup mobile une colonne à la fois) ; task-card.tsx (bordure gauche 4px priorité, badges, progression sous-tâches Progress, indicateur IA Sparkles, lien calendrier avec title, dropdown actions, HIT_AREA + seuil clic/drag 6px) ; task-modal.tsx (Dialog 2xl + ScrollArea, titre/desc/statut/priorité RadioGroup 4 cartes/datetime-local/tags Popover checkboxes+création à la volée/sous-tâches intégrées/Select événement + bouton « Créer un événement » ouvrant EventDialog/section IA violet avec Appliquer/AlertDialog suppression, remontée par key) ; task-list-view.tsx (table triable toutes colonnes, checkbox multi-select, barre groupée fixe bottom Terminer/Archiver/Supprimer) ; subtask-list.tsx (2 modes : serveur mutations immédiates optimistes / local création, checkboxes, ↑↓ réordonner, progression) ; tag-manager.tsx (Dialog, ColorPicker 8 pastilles, édition inline, 409 doublon) ; task-stats.tsx (4 mini-stats + cercle SVG complétion + barres 7 jours CSS) ; task-filters.tsx (recherche NFD, Popovers statut/priorité, Selects tag/échéance, compteur+reset, filterTasks exporté) ; priority-badge.tsx (PRIORITY_COLORS hex spec + point pulse URGENT) ; due-date-badge.tsx (dueState + formatDueDate + title long)
- tasks-view.tsx RÉÉCRITURE (455 lignes) : toolbar (filtres, ToggleGroup Kanban/Liste, Tags, Switch Archivées+compteur, Nouvelle tâche), TaskStats bandeau, board OU liste selon mode, skeletons par mode, GlobalEmptyState/FilteredEmptyState, TaskModal+TagManager+AlertDialog montés ici, eventTitles via useEvents stable
- api-client.ts : section Tâches réécrite — useTasks (TaskListResult page/limit/total), useTaskStats, useTags, useTaskMutations {create, update, move, archive, removeHard} compat update({id, input}) dashboard, useSubtaskMutations {add, patch, remove} avec replaceTask cache, useTagMutations, useInvalidateTaskData (tasks+task-stats+tags+stats)
- status-badge.tsx : entrée archived (Archive, gris) ; dashboard-view.tsx : PRIORITY_COLORS + TaskModal (task-dialog.tsx SUPPRIMÉ) ; page.tsx intact
- Correctifs main post-livraison (3 bugs bloquants) :
  • taskCreateSchema.description → nullable (le modal envoie null quand vide → 400 « Données invalides » à chaque création)
  • useEvents(addDays(new Date(), -60/+180)) à tasks-view + task-modal → useMemo stable (queryKey changeait à chaque render par les ms)
  • ROOT CAUSE boucle 2 427 requêtes /api/events : le SERVICE WORKER public/sw.js mettait en cache-first TOUS les chunks /_next/ (noms stables non hashés en dev) → le navigateur rejouait indéfiniment le bundle du premier chargement (code d'origine à queryKey instable), ignorant HMR ET les rechargements ; pwa-register.tsx enregistrait le SW même en dev → correctif : registration bloquée en NODE_ENV=development + bump CACHE orbit-v1→orbit-v2 (purge auto des caches v1 à l'activate) + api-client minuteKey() (queryKey tronquée à la minute, instants exacts conservés pour la requête) + staleTime 30s anti-burst
- Finition : formatDueDate(due, {completed}) → « Il y a N jours » neutre pour les tâches terminées (au lieu de « En retard ») ; DueDateBadge transmet completed
- QA E2E agent-browser (main, 1280×800 + 375×667) : DRAG & DROP validé granulaire (pointerdown → moves incrémentaux > seuil 6px → drop) : « Réserver un restaurant » À faire→En cours PERSISTÉ (doing pos 2000) puis réordonnancement intra-colonne vers position 1000 avec renormalisation 1000/2000/3000/4000 vérifiée en base + affichage conservé après rechargement ; modal édition « Préparer la présentation Orbit » : section « L'IA suggère : Priorité HAUTE (confiance 87 %) » → Appliquer → priority=HIGH + suggestion effacée en base ; création complète (titre, Urgente, 2 tags dont « QA navigateur » créé à la volée, sous-tâches) → 201 ; TagManager création+couleur+toast ; vue liste tri Priorité desc (Urgente→Haute→Moyenne), sélection 2 tâches → barre groupée → « Terminer » → completedAt posés ; filtres recherche « restaurant » (1 résultat) et URGENT (Étape 1) + reset (13) ; colonne Archivé au toggle (« Ancien projet ») ; TaskStats (total 15, taux 54→62 %, barres dim→sam) ; dashboard priorités adapté + complétion depuis le dashboard OK ; mobile 375×667 : tabs statut, une colonne, scrollWidth==clientWidth (0 overflow), changement d'onglet OK ; console 0 erreur 0 warning, 0 page error
- VÉRIFICATION boucle events POST-CORRECTIF : reload → Tâches → 5s → **1 requête** (vs 94 avant), 15s d'inactivité → 0 nouvelle, debug keys minute-tronquées confirmées puis retirées
- bunx tsc --noEmit : 0 erreur src/ ; bun run lint : 0 erreur 0 warning ; 6 captures docs/screenshots/qa-tasks-*.png ; VLM Kanban final : 9/10 (colonnes+compteurs, badges, stats lisibles, aucun défaut majeur)

Stage Summary:
- Système de tâches frontend complet : Kanban drag & drop persistant (positions renormalisées serveur), vue liste triable + actions groupées, modal riche (tags à la volée, sous-tâches mutables, suggestion IA applicable, lien/creation événement), stats vivantes, TagManager, filtres clients réactifs, responsive mobile par tabs — 100 % français, a11y complète (annonces dnd-kit, aria-labels, sr-only)
- 3 bugs critiques corrigés par main : Zod description nullable, queryKey useMemo, et surtout le SW qui gelait le bundle dev (cache-first des chunks non hashés) — le SW ne s'enregistre plus en dev (orbit-v2 en prod purge les anciens caches) ; minuteKey+staleTime rendent useEventsRange robuste aux plages new Date()
- Composants publics : <TaskBoard tasks showArchived eventTitles onEdit onArchiveToggle onDelete onCreate>, <TaskModal open onOpenChange task? defaultStatus?>, <TaskListView ...>, <SubTaskList taskId|null localItems? onLocalChange?>, <TagManager open onOpenChange>, <TaskStats />, <TaskFilters value onChange tags>, <PriorityBadge priority>, <DueDateBadge due completed?> ; hooks api-client : useTasks/useTaskStats/useTags/useTaskMutations{create,update,move,archive,removeHard}/useSubtaskMutations{add,patch,remove}/useTagMutations{create,update,remove}
- Décisions : suppression définitive via AlertDialog = hard=1 (soft archivage via les actions archive) ; drag tactile mobile garanti par le menu « Déplacer vers » (le drag pointeur reste fonctionnel) ; réordonnancement sous-tâches par boutons ↑↓ (PATCH position=indice) ; Étape/recréation : les tableaux tags/subtasks en PATCH = remplacement complet (sémantique put) — le modal n'envoie jamais subtasks en édition (mutations directes)

---
Task ID: 13-c
Agent: main (Z.ai Code)
Task: QA E2E finale + publication GitHub du système de tâches complet

Work Log:
- Reprise et complétion de la QA laissée inachevée par l'agent 13-b (limite de contexte) : diagnostic des 2 427 requêtes /api/events (décomposition : test causalité dev.log→HMR réfuté, analyse des plages, débogage par console.log instrumental, découverte du service worker contrôlant la page avec cache-first sur les chunks /_next/ dev)
- Correctifs : pwa-register (SW désactivé en dev), sw.js orbit-v2, api-client minuteKey + staleTime, validators description nullable, lib/dates formatDueDate completed — détail dans 13-b
- Vérifications finales : tsc 0 erreur src/, lint 0/0, dev.log propre (plus que des 200 + 2 requêtes events légitimes par navigation), 3 services UP (:3000 / :3031 / :3032), git local == origin/main (fea9a17)
- Publication : commit feat(tasks) 44 fichiers + push GitHub topmuch/orbit

Stage Summary:
- Système de gestion de tâches complet livré et vérifié bout-en-bout (backend curl + frontend navigateur) ; le point le plus sensible de la session : la boucle de refetch infinie /api/events était un symptôme de bundle dev gelé par le service worker (cache-first sur chunks non hashés) — résolu à la racine, plus jamais de bundle périmé en dev ; le rate limiting 429 servait de « garde-fou » involontaire qui masquait l'ampleur (2 427 requêtes)
- Prochaines briques possibles (prompts suivants de l'utilisateur) : Phase 4 IA locale (remplacer les placeholders aiSuggestedPriority via Ollama), prompts 5-8

---
Task ID: 14
Agent: main (Z.ai Code) — reprise et achèvement de l'agent interromu par limite de contexte (micro-service + intégration livrés, QA non faite)
Task: Système d'IA locale complet — Ollama Docker (production) + micro-service IA (:3031, bun sandbox / FastAPI prod) + intégration Next.js : analyse d'emails (RDV), suggestion de priorité, assistant conversationnel streaming, synthèse de contenus

Work Log:
- Audit de reprise : l'agent précédent avait livré le micro-service mini-services/ai-service (4 routeurs analyze-email/suggest-priority/chat/summarize + prompts/*.txt + cache LRU 10 min + JSON robuste réparable + timeout 60-120 s + Ollama→fallback z-ai-web-dev-sdk), les routes proxy Next.js /api/ai/{analyze,chat,status,suggest-priority,summarize} (auth getSessionUser + Zod + rate limit 10/min + contexte DB réel), le hook use-ai-chat (streaming + abort), les vues intégrées (assistant-view, emails-view, task-modal, ai-summary-dialog), et l'infra prod : docker-compose.yml (ollama + ai-api FastAPI, même contrat REST), docker/ollama (entrypoint pré-pull des modèles), docker/ai-service (FastAPI + README), .env.example
- BUG CRITIQUE corrigé (bloquant) : ai-provider.suggestTaskPriority lisait data.result.priority alors que le micro-service renvoie result.suggestedPriority → TOUTES les suggestions échouaient en 502 « aucune suggestion exploitable » (contrat aligné sur le FastAPI de production, vérifié des deux côtés)
- BUG React corrigé : TaskModal — SelectItem value={ev.id} en double pour les occurrences d'une série récurrente expansée (« Encountered two children with the same key ») ; déduplication par id maître (on garde la prochaine occurrence à venir, sinon la dernière passée), liste retriée chronologiquement — plus aucun warning console
- Polish : AiSummaryDialog rend le résumé en markdown (gras/listes) via react-markdown, cohérent avec la conversation de l'assistant
- QA curl E2E (proxy Next.js + session cookie) : analyze-email → RDV dentiste détecté (lieu 22 avenue Voltaire + participant, 14:30/45 min, confiance 0.9, suggestion persistée sur l'email) ; suggest-priority → URGENT 0.95 + raisonnement (après correctif) ; summarize → 159 mots → ~60 mots, 3 décisions + actions ; chat streaming → réponse avec l'agenda réel (6 j de rendez-vous cités)
- QA navigateur E2E (agent-browser, 1280×800 + 375×667) : login démo → Assistant « Quelles sont mes priorités cette semaine ? » → réponse streamée contextuelle (tâches réelles avec échéances + événements) ; Emails → « Analyser avec l'IA » → carte « Rendez-vous détecté par l'IA · confiance 90 % » (Les Choix d'Éléonore, mer. 9 sept. 20:00–22:00) → « Créer l'événement » → EventDialog prérempli (titre + badge « Extrait d'un email » + horaires) → Créer → toast + événement en base source=email_extract → purge du test ; « Résumer avec l'IA » → dialog Synthèse IA (style + mots avant/après + contenu) ; Tâches → modal « Suggérer avec l'IA » → « L'IA suggère : Priorité URGENTE (confiance 90 %) » + raisonnement → Appliquer → priorité persistée + toast + radios à jour + section effacée ; 0 erreur console, 0 overflow mobile (scrollWidth==clientWidth), footer visible
- Vérifications finales : bunx tsc --noEmit 0 erreur src/ ; bun run lint 0/0 ; dev.log propre ; 3 services UP (:3000 Next.js, :3031 ai-service, :3032 reminder-service)
- Captures : docs/screenshots/qa-ai-{assistant,email-analyze,priority-modal,mobile-tasks}.png
- Publication : squash du commit plateforme (UUID) + correctifs en un commit feat(ai) propre, push GitHub topmuch/orbit (URL jetable, token jamais écrit dans .git/config)

Stage Summary:
- Système d'IA local complet, vérifié bout-en-bout (curl + navigateur) : [navigateur] → /api/ai/* (Next.js : auth cookie + Zod + rate limit 10/min + contexte DB agenda/tâches/charge) → src/lib/ai-provider.ts (seul point de sortie IA) → micro-service :3031 (cache mémoire 10 min, JSON robuste try/catch + réparation, timeout, sanitization) → Ollama en production (docker compose : ollama llama3.1:8b + ai-api FastAPI, même contrat REST que le mini-service bun) / fallback z-ai-web-dev-sdk en sandbox
- Contrats : POST /api/ai/analyze {emailId} → {suggestion|message, email} (bornes -1 an/+2 ans, persistée jusqu'à décision) ; POST /api/ai/suggest-priority {taskId?|title+description?} → {suggestion{priority,confidence,reasoning,persisted}} (LOW..URGENT, persistance en édition, jetable en création) ; POST /api/ai/chat {messages} → text/plain stream (contexte serveur : agenda 7 j + 15 tâches triées) ; POST /api/ai/summarize {content,style?,maxLength?} → {summary{summary,originalLength,summaryLength,style}}
- Composants : <AssistantView> (suggestions, streaming caret, markdown), <AiSummaryDialog> (réutilisable emails + descriptions de tâches), carte suggestion emails → EventDialog prérempli source=email_extract, section IA du TaskModal (Appliquer/Ignorer)
- 2 bugs corrigés lors de la QA : contrat suggestedPriority (bloquant priorités) et clés Radix dupliquées du Select d'événements (séries récurrentes)
- Prochaines briques possibles : 5 Push notifications (VAPID déjà en .env), 6 emails réels IMAP, 7 offline PWA complet

---
Task ID: 15
Agent: main (Z.ai Code)
Task: Système complet de notifications push — VAPID, SW v3, préférences, heures calmes, historique in-app, deadlines, emails IA, alertes personnalisées

Work Log:
- Audit push existant : VAPID en .env + lib/push.ts (sendPushToUser, purge 404/410), /api/subscribe (upsert), /api/notify (test + reminders événements 15 min/tâches H-1 avec reminderLog anti-doublon), reminder-service :3032 (cycle 60 s → secret partagé), sw.js v2 (push/clic), centre de notifications CALCULÉ en direct (pas d'historique), settings push (permission/enable/disable/test)
- Prisma : PushSubscription étendu (userAgent, platform, isActive soft-delete, lastUsedAt, @@unique endpoint, index) + NOUVEAUX Notification (type String — SQLite sans enum, isRead/isSent/sentAt, data Json, index) et NotificationPreference (toggles 4 types, eventReminderTime, quiet hours) → db:push OK (données préservées)
- lib/push.ts réécrit : PushPayload étendu (type, data, actions, requireInteraction, silent), sanitization title 100/body 500, persistance Notification (id injecté au payload → mark-read SW), lastUsedAt à l'envoi, isQuietHours (fuseau utilisateur, plages traversant minuit, parse « HH:MM » Intl fr-FR), cleanupOldNotifications (> 30 j)
- Routes : /api/subscribe enrichi (Zod userAgent/platform, upsert isActive) ; /api/notifications (GET list+unread, DTO data blanchi view+ids) ; /api/notifications/mark-read (POST id|ids|all, idempotent, appelé par le SW) ; /api/notifications/preferences (GET/PUT upsert, cohérence quiet hours, Zod HH:MM) ; /api/notify étendu : type « custom » (alertes perso, rate limit 10/min), scan reminders enrichi (prefs par utilisateur, quiet hours sauf imminence < 15 min, rappel défaut = eventReminderTime utilisateur, TÂCHES « échéance aujourd'hui » 1×/jour anti-doublon Notification taskId + H-1 existant, EMAILS IMPORTANTS IA suggestedEvent non confirmé fenêtre 7 j 1×/email, purge 30 j, rate limit test)
- sw.js v3 (MISE À JOUR, pas remplacement) : payload enrichi (actions par type, TASK_DEADLINE → Voir/Terminée), notificationclick → focus + postMessage {orbit: navigate, view} (navigation SPA deep link) + action complete → PATCH /api/tasks/:id credentials include + fallback offline, notificationclose → mark-read, message skipWaiting ; BUG 13-B PRÉSERVÉ : IS_DEV détecté → handler fetch désactivé en dev (précachage minimal), pwa-register enregistre le SW partout désormais (push testable en dev, aucun gel de bundle)
- Frontend : useNotifications (poll 60 s) + useNotificationMutations (markRead optimiste) + useNotificationPreferences/Mutation + useCustomNotification ; subscribe enrichi (userAgent/platform auto) ; NotificationCenter RESTRUCTURÉ (section « À traiter » live + section « Historique » persistée : icônes par type, non-lues en surbrillance, clic = markRead + deep link data.view, « Tout lu », dates relatives fr, skeletons, badge = unread + live) ; carte « Préférences de notifications » dans Réglages (4 toggles, Select avance 0→1 j, switch quiet hours + 2 inputs time, sauvegarde PUT immédiate) ; app-shell écoute les messages SW → onNavigate (deep link)
- reminder-service : log enrichi (emailsNotified, quietBlocked) — redémarré (double-fork daemon) ainsi que Next.js (client Prisma régénéré : db.notificationPreference indisponible jusqu'au restart)
- QA curl E2E : prefs GET (défauts)→PUT (30 min/23:00→07:30)→reset ; GET notifications (3 IMPORTANT_EMAIL créées par le scan via :3032 automatique) ; mark-read all → 3 ; Zod 25:99 → 400 ; subscribe bidon upsert 201 → DELETE (soft) ; scan :3032/run A quiet actives 23:4x → quietBlocked:1 / eventsNotified:0, run B quiet off → envoi (failed:1 subscription bidon — Notification EVENT_REMINDER persistée, non marquée) ; custom → Notification CUSTOM + report ; DB finale propre (3 IMPORTANT_EMAIL légitimes, 0 subscription, prefs défaut)
- QA navigateur (agent-browser 1280×800 + 375×667) : SW v3 enregistré/activé/contrôlant en dev (première fois depuis 13-b) ; permission = denied en headless (limite Chromium, documentée) ; centre : 2 sections affichées + badge + clic historique → NAVIGUÉ_VERS_EMAILS ; Réglages : carte prefs présente, toggle « Suggestions IA » → PUT → aiSuggestion:true persisté, switch quiet → 2 champs time + défauts ; deep link simulé : dispatch MessageEvent {orbit:navigate,view:tasks} → vue Tâches ouverte ; rechargement post-SW : aucune régression (console 0 erreur, titre OK) ; mobile : sheet notifications NO_OVERFLOW ; 3 captures (qa-push-{center,mobile-center,preferences*}.png)
- Vérifications : tsc 0 erreur src/, lint 0/0, dev.log propre, 3 services UP ; docs/push-guide.md (installation, routes, scan, SW, tests, dépannage 7 cas)
- Publication : commit feat(push) + push GitHub topmuch/orbit

Stage Summary:
- Système de notifications complet et vérifié : [navigateur] → /api/subscribe (VAPID upsert, télémétrie légère) → /api/notify (test/custom session + reminders secret service) → lib/push (sanitization, persistance historique, envoi web-push, purge 404/410) → sw.js v3 (actions Voir/Terminée, deep link postMessage SPA, mark-read à la fermeture, PATCH tâche direct depuis la notif) ; planification par reminder-service :3032 (60 s)
- Le scan respecte les préférences par utilisateur : 4 types toggleables, avance par défaut configurable, heures calmes dans le fuseau utilisateur (imminence < 15 min passe outre — jamais rater un RDV), anti-doublons 3 niveaux (reminderLog occurrence, reminderSentAt H-1, Notification type+id mémoire — SQLite sans JSON path filter)
- Centre de notifications hybride : « À traiter » (live : événements imminents, tâches en retard, emails à analyser) + « Historique » (persisté, lu/non-lu, deep link, tout-marquer-lu) — badge cumulé
- Décisions : soft-delete subscriptions (isActive), data JSON blanchi dans les DTO (ids+vue seulement), tests/custom rate-limités 10/min, purge > 30 j automatique, permission demandée uniquement sur interaction (jamais à l'inscription)
- Limite documentée : la permission OS ne peut pas être accordée en navigateur headless (QA navigateur du flux push réel impossible en sandbox — toute la chaîne serveur validée par curl, le SW par dispatch/registration)

---
Task ID: 16
Agent: main (Z.ai Code)
Task: Emails réels IMAP (chiffrement des identifiants) + Offline complet (file de mutations IndexedDB, cache SW des GET /api, queue de notifications scheduledAt)

Work Log:
- Audit préalable : /api/emails/sync était une simulation démo ; Notification.scheduledAt présent mais jamais « flushé » ; SW v3 fetch handler désactivé en dev ; aucune file de mutations ; badge offline/toasts PWA déjà en place
- Schéma : EmailAccount (imapHost/port/secure/username, passwordEnc, allowSelfSigned, syncIntervalMin/fetchDays/maxMessages, isActive, télémétrie lastSync*) + EmailLog.accountId (SetNull : emails conservés à la suppression) + messageId global-unique → @@unique([userId, messageId]) (multi-comptes, dédoublonnage) — db:push OK, 11 emails préservés
- Chiffrement (lib/secret-box.ts) : AES-256-GCM authentifié, format v1:iv:tag:ct, clé SHA-256(AUTH_SECRET|orbit:secret-box:v1) — zéro secret supplémentaire ; server-only, jamais dans un DTO
- Connecteur (lib/imap.ts, imapflow+mailparser en serverExternalPackages — process Node) : testImapConnection (list + INBOX exists, sans stockage), syncEmailAccount (LECTURE SEULE BODY.PEEK[], fenêtre lastSyncAt−10min ou fetchDays, upsert idempotent par (userId,messageId), corps ≤ 20k, garde anti-concurrence, erreurs FR actionnalisées dont .response imapflow — mot de passe masqué par imapflow), syncUserAccounts, syncDueAccounts (intervalles par compte)
- Routes : GET/POST /api/email/accounts (test préalable OBLIGATOIRE à la création, 409 doublon, rate limit), PATCH/DELETE /api/email/accounts/[id] (password vierge = inchangé, re-test si identifiants modifiés), POST /test (aucun stockage), POST /[id]/sync ; /api/emails/sync RÉÉCRIT : vraie sync multi-comptes, fallback démo (demo:true) si aucun compte ; GET /api/emails inclut account → EmailDto.accountAddress
- Cycle automatique : reminder-service :3032 appelle désormais aussi POST /api/notify {type:"email-sync"} chaque 60 s (secret service) — la route ne traite que les comptes ÉCHUS ; supervision /health étendue (emailSync.*)
- Frontend comptes : EmailAccountsCard (Réglages) — liste + statut (Synchronisé/Erreur/Suspendu, count, host:port, intervalle, dernière sync relative), dialog ajout/édition (presets Gmail/Outlook/iCloud/Yahoo/Free/Orange, TLS/STARTTLS, certificat auto-signé, intervalle, historique initial), Tester la connexion, Synchroniser, suspendre, supprimer (AlertDialog, emails conservés) ; badge compte ambre dans l'en-tête du détail email ; CTA « Connecter un compte IMAP » dans le vide de la boîte ; toasts réels (comptes en échec listés) vs démo
- OFFLINE (Task 7) : lib/offline-queue.ts — outbox IndexedDB (orbit-offline/queue) FIFO, waiters pour les promesses api() en attente (l'UI reçoit la VRAIE réponse serveur après replay, timeout 15 min), replay (online/montage/garde 60 s) : 2xx→sync+invalidate tout via événement orbit:data-synced, 4xx→abandon signalé, 5xx/réseau→reste en file ; api() : TypeError de fetch same-origin sur mutation mettable en file → enqueue (SANS condition navigator.onLine — il ment : portail captif, WiFi mort ; découvert en QA via traces) ; exclusions IA/auth/push/IMAP/import-export ; badge « N en attente » cliquable (header + Réglages) ; hooks dev window.__orbitOffline
- SW v4 : GET /api/* network-first → cache de secours orbit-api-v4 (X-Orbit-Offline:1, ~150 entrées, jamais de Set-Cookie, session volontairement cachée = dernier état connu hors ligne) ; navigation réseau→cache/(prod)→offline.html (dev : offline.html UNIQUEMENT — bug 13-b impossible) ; handlers push v3 conservés à l'identique ; purge caches obsolètes à l'activate
- Queue planifiée : notificationSendSchema + scheduledAt (futur ≤ 7 j) ; /api/notify custom → Notification isSent=false en file ; flush dans le scan reminders (sendExistingNotification : push + marquage, sans appareil = livraison in-app marquée) ; UI « Programmer » dans le centre de notifications (dialog titre/message/datetime-local) + badge « planifiée » + heure d'envoi dans l'historique
- QA E2E IMAP (mock TLS : scripts/mock-imap-server.ts + certs auto-signés, bun, port 3993, 3 messages MIME : ASCII, UTF-8 base64+encoded-words, long) : mauvais mot de passe → message FR auth ; test OK (3 messages) ; création compte via curl (test auto) → passwordEnc v1:… en base (jamais en clair) ; AUTO-SYNC :3032 cycle → due:1, created:3 (Élodie Martin décodé des encoded-words, base64 parsé, dates) ; re-sync manuelle → 0 (idempotence) ; UI : carte comptes complète, dialog ajout E2E (2e compte créé via le formulaire, port saisi), suppression (emails conservés) ; compte QA suspendu en fin de session
- QA E2E offline (agent-browser + serveur tué) : file — mutation PATCH rejetée (fetch patché) → toast « Hors ligne — action mise en file » + badge « 1 en attente » + IndexedDB ; replay → {synced:1}, PATCH livré, DB isRead 0→1, invalidation React Query, queue 0 ; SW — serveur ARRÊTÉ : GET /api/tasks et /api/emails → 200 X-Orbit-Offline=1 (cache), reload → page « Orbit — Hors ligne » (offline.html), redémarrage → récupération totale, queue résiduelle 0 ; PIÈGE QA DOCUMENTÉ : l'émulation offline Playwright ne coupe pas le réseau du Service Worker (fuite CDP) — d'où le choix de ne PAS dépendre de navigator.onLine et de tester via fetch patché + arrêt réel du serveur ; alerte programmée « Appeler le garage » → badge planifiée + envoi dim. 6 sept. 02:16 (heure locale) ; scheduledSent:1 après flush forcé à l'échéance
- Vérifications : bunx tsc --noEmit 0 erreur src/ ; lint 0/0 ; console navigateur 0 erreur ; mobile 375×667 sans overflow horizontal, footer OK ; 7 captures (qa-imap-*, qa-offline-*) ; docs/email-imap-guide.md + docs/offline-guide.md
- Publication : commit feat(emails,offline) + push GitHub topmuch/orbit

Stage Summary:
- EMAILS RÉELS : chaîne IMAP complète et vérifiée (mock TLS en sandbox, imapflow/mailparser en production) — [Réglages] → POST /api/email/accounts (test préalable) → passwordEnc AES-256-GCM (AUTH_SECRET, aucun secret de plus) → sync manuelle OU reminder-service :3032 (comptes dus, 60 s) → upsert EmailLog (userId+messageId, lecture seule, BODY.PEEK[]) → boîte Orbit + badge compte + démo préservée sans compte
- OFFLINE COMPLET : lectures via SW v4 (network-first + cache API + X-Orbit-Offline, navigation offline.html, 13-b préservé par construction), écritures via outbox IndexedDB (FIFO, replay auto à la reconnexion, 4xx abandonné/5xx retenu, invalidation globale), notifications programmées via queue serveur scheduledAt (envoi à l'échéance exacte même app fermée) — les trois étages indépendants et documentés
- Décisions : ne JAMAIS se fier à navigator.onLine (mensonger : portail captif, émulation CDP fuyarde) ; session mise en cache délibérément (rester identifié hors ligne, logout = POST réseau) ; un 4xx au replay n'interrompt pas la file (seuls 5xx/réseau stoppent) ; suppression de compte = SetNull (emails consultables) ; l'heure choisie d'une alerte programmée prime sur les heures calmes (choix explicite)
- Limite sandbox documentée : la QA navigateur du push réel reste impossible en headless (permission OS) — la chaîne serveur a été validée par curl et le SW par enregistrement/contrôle des caches
