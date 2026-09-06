# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════
# Orbit — image de sauvegarde (SQLite + pièces jointes emails)
# ───────────────────────────────────────────────────────────────────────────
# Utilisée par le service `backup` de docker-compose.prod.yml :
#   orbit_db       → /data     (lecture seule)
#   orbit_storage  → /storage  (lecture seule)
#   orbit_backups  → /backups  (écriture)
#
# Le conteneur tourne en boucle (BACKUP_INTERVAL_SECONDS, 24 h par défaut) :
#   • snapshot SQL cohérent de la base via l'API sqlite3 ".backup" (jamais
#     une copie brute de la base vivante — WAL/journal safe), puis gzip ;
#   • archive tar.gz des pièces jointes (/storage) ;
#   • copies hebdomadaires (dimanche) et mensuelles (1er du mois) ;
#   • purge par âge : 7 jours (daily/), 4 semaines (weekly/), 6 mois
#     (monthly/).
#
# Déclenchement manuel (backup immédiat, sans attendre le cycle) :
#   docker compose -f docker-compose.prod.yml exec backup /backup.sh now
#   (ou : docker compose -f docker-compose.prod.yml run --rm backup now)
#
# Alpine : image minuscule, sqlite + tzdata (fuseau horaire pour la
# planification hebdo/mensuelle, variable TZ).
# ═══════════════════════════════════════════════════════════════════════════
FROM alpine:3.20

# sqlite  → CLI sqlite3 (API .backup)
# tzdata  → fuseaux horaires pour TZ (Europe/Paris par défaut)
RUN apk add --no-cache sqlite tzdata

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

ENV TZ=Europe/Paris \
    BACKUP_INTERVAL_SECONDS=86400

# Pas d'EXPOSE : ce conteneur ne sert rien sur le réseau, il planifie.
# Tourne en root pour écrire dans /backups et lire les volumes montés
# en lecture seule (la base appartient à l'utilisateur orbit du web).
ENTRYPOINT ["/backup.sh"]
CMD ["loop"]
