# Orbit — Guide des fonctionnalités IA

> L'IA d'Orbit est **locale et privée** : en production, toute l'inférence
> passe par Ollama sur votre machine (aucune donnée ne quitte le poste).
> Ce guide décrit les 4 fonctionnalités IA côté application, leur
> fonctionnement, et comment les tester.

## Vue d'ensemble

| Fonctionnalité | Où | Route API | Micro-service |
|---|---|---|---|
| 📧 Analyse d'emails | Boîte de réception | `POST /api/ai/analyze` | `/analyze-email` |
| ⚡ Suggestion de priorité | Modal de tâche | `POST /api/ai/suggest-priority` | `/suggest-priority` |
| 🤖 Assistant conversationnel | Vue Assistant | `POST /api/ai/chat` (streaming) | `/chat` |
| 📄 Synthèse de contenu | Emails + descriptions | `POST /api/ai/summarize` | `/summarize` |

Chaîne complète (identique pour les 4) :

```
navigateur → /api/ai/* (auth + Zod + rate limit 10/min + contexte DB)
           → micro-service :3031 (prompts/*.txt, cache 10 min, JSON robuste)
           → Ollama (llama3.1:8b) — en sandbox : repli z-ai-web-dev-sdk
```

## 1. Analyse d'emails (extraction de rendez-vous)

**Où** : Boîte de réception → sélectionner un email → bouton
« **Analyser avec l'IA** ».

**Ce que fait l'IA** : détecte un rendez-vous et extrait
titre, description, horaires (début/fin), durée, **lieu** et
**participants** (emails réellement cités, expéditeur inclus), avec un score
de confiance 0-100 %.

**Garde-fous intégrés** (le LLM n'est jamais pris au mot) :
- les dates sont ramenées dans un horizon raisonnable (−1 an / +2 ans) ;
- si l'année est absente de l'email, elle est résolue sur l'année courante
  (un RDV email est toujours futur) ;
- les participants inventés sont filtrés : seules les adresses présentes
  dans l'email source sont conservées ;
- l'heure manquante vaut 09:00, la durée par défaut 1 h.

**Ensuite** : la carte « Rendez-vous détecté » affiche le résultat
(lieu + participants inclus) ; « Créer l'événement » ouvre le dialog du
calendrier **pré-rempli** (titre, horaires, lieu, participants, fuseau) ;
« Ignorer » marque l'email comme traité sans création.

## 2. Suggestion de priorité des tâches

**Où** : modal de tâche (création **ou** édition) → bouton violet
« **Suggérer avec l'IA** » à côté du champ Priorité.

**Ce que fait l'IA** : analyse le titre, la description, l'échéance, et le
**contexte de charge réel** (nombre de tâches actives, urgentes, en retard —
calculé en base) puis suggère LOW / MEDIUM / HIGH / URGENT avec un score de
confiance et un **raisonnement court** (ex. « Deadline vendredi, client
externe, validation bloquée »).

**Deux modes** :
- **édition** ({ taskId }) : la suggestion est *persistée* sur la tâche
  (`aiSuggestedPriority` / `aiConfidence`) — elle reste affichée à la
  réouverture du modal jusqu'à décision ;
- **création** ({ title, description, dueDate }) : suggestion jetable
  appliquée au formulaire, rien n'est écrit en base avant « Créer ».

**Décision** : « Appliquer » met à jour la priorité (et efface la
suggestion), « Ignorer » la supprime (localement et en base en édition).
Changer la priorité à la main invalide automatiquement la suggestion.

## 3. Assistant conversationnel (streaming)

**Où** : vue **Assistant** (chat intégré).

**Ce que fait l'IA** : répond en **streaming token par token** (indicateur de
frappe, rendu Markdown) en s'appuyant sur votre **vrai contexte** injecté
côté serveur : agenda des 7 prochains jours (récurrences incluses, chaque
événement dans son fuseau) + 15 tâches actives triées par urgence.

**Bon à savoir** : suggestions de prompts prêtes à l'emploi (« Résume ma
journée », « Mes priorités », « Organiser demain »), historique jusqu'à 12
messages envoyés au modèle, « Réinitialiser » vide la conversation.

## 4. Synthèse de contenu

**Où** :
- Boîte de réception → bouton « **Résumer avec l'IA** » sous le corps de
  l'email ;
- Modal de tâche → bouton « **Résumer avec l'IA** » (n'apparaît que pour les
  descriptions ≥ 400 caractères).

**Ce que fait l'IA** : produit un résumé en **points clés** (styles
disponibles : points clés / paragraphe / faits marquants) qui conserve
dates, horaires, lieux, montants, noms et décisions. Le dialog affiche les
métriques (ex. 92 mots → 54 mots) ; un bouton « Réessayer » couvre les
échecs réseau. Les synthèses identiques sont **cachées 10 min** côté
micro-service.

## Tests rapides (curl)

```bash
# Santé du micro-service (provider réellement utilisé)
curl -s localhost:3031/health

# Suggestion de priorité directement sur le micro-service
curl -s localhost:3031/suggest-priority -H 'Content-Type: application/json' \
  -d '{"taskTitle":"Finaliser le devis client","dueDate":"2026-01-29T10:00:00Z",
       "userContext":{"totalTasks":12,"urgentTasks":2,"overdueTasks":1}}'
```

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `AI_SERVICE_URL` | `http://localhost:3031` | Adresse du micro-service IA |
| `AI_SERVICE_TIMEOUT_MS` | `120000` | Timeout côté Next.js |
| `OLLAMA_URL` | *(vide en sandbox)* | Active Ollama local en production |
| `OLLAMA_MODEL` | `llama3.1:8b` | Modèle d'inférence |
| `OLLAMA_TIMEOUT_MS` | `90000` | Timeout par inférence |
| `AI_CACHE_TTL_MS` | `600000` | TTL du cache mémoire des réponses |

## Dépannage

| Symptôme | Solution |
|---|---|
| « L'assistant est momentanément indisponible » | Micro-service :3031 éteint → `bun run dev` dans `mini-services/ai-service` (sandbox) ou `docker compose up -d` (production) |
| Réponses IA lentes | CPU seul : passer à `mistral:7b` ou activer le GPU ; sinon patienter (timeout 90 s) |
| 429 « Trop de requêtes » | Rate limit : 10 requêtes IA par minute et par utilisateur — patientez 60 s |
| Suggestion de priorité sans raisonnement | Le modèle a répondu en prose et seul le repli tolérant a trouvé la priorité — relancez la suggestion |
| Date de RDV étrange (année passée) | Vérifiez l'horloge système ; la correction automatique d'année ne s'applique qu'aux dates > 90 j dans le passé ramenables au futur |
| Pas de lieu/participants extraits | L'email ne les mentionne pas explicitement, ou le modèle ne les a pas détectés — relancez l'analyse (le cache expire après 10 min) |

Détails d'architecture et de déploiement Docker : [`docker/ai-service/README.md`](../docker/ai-service/README.md).
