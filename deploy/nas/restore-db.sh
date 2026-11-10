#!/bin/sh
# Replace the database with a dump. Stops the API meanwhile so nothing writes during the restore.
#   sudo sh restore-db.sh backups/<file>.dump
. "$(dirname "$0")/lib.sh"
need_root "$@"
FILE="${1:?usage: sudo sh restore-db.sh backups/<file>.dump}"
[ -s "$FILE" ] || die "no such dump: $FILE"
log "stopping api and proxy"
dc stop proxy api
dc up -d postgres
wait_healthy postgres 60 || die "postgres not healthy"
log "restoring $FILE"
dc exec -T postgres psql -U ronin -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ronin WITH (FORCE);" -c "CREATE DATABASE ronin OWNER ronin;"
dc exec -T postgres pg_restore -U ronin -d ronin --no-owner --exit-on-error < "$FILE"
# Live round state in Redis belongs to the old timeline: clear it so the leader starts clean.
dc exec -T redis redis-cli FLUSHDB >/dev/null
log "restore done; start with: sudo docker-compose -p $PROJECT up -d  (deploy/rollback do it for you)"
