#!/bin/sh
# Load a release bundle and roll it out (backup first if the database already exists).
#   sudo sh deploy.sh <tag>          e.g. sudo sh deploy.sh 3f9c2ab
. "$(dirname "$0")/lib.sh"
need_root "$@"
TAG="${1:?usage: sudo sh deploy.sh <tag>}"
BUNDLE="releases/ronin-rush-$TAG.tar.gz"
[ -f "$BUNDLE" ] || die "missing $BUNDLE (upload it with scp first)"
[ -f "$BUNDLE.sha256" ] || die "missing $BUNDLE.sha256"
[ -f .env ] || die "no .env: run init.sh first"

expected="$(cut -d' ' -f1 "$BUNDLE.sha256" | tr 'A-F' 'a-f')"
actual="$(sha256_of "$BUNDLE")"
[ "$expected" = "$actual" ] || die "SHA-256 mismatch: expected $expected, got $actual"
log "SHA-256 verified ($actual)"

log "loading images"
docker load -i "$BUNDLE"
for img in api web proxy; do docker image inspect "ronin-rush-$img:$TAG" >/dev/null || die "image ronin-rush-$img:$TAG not in bundle"; done

PREV="$(current_tag)"
if [ -n "$PREV" ] && [ -n "$(dc ps -q postgres 2>/dev/null)" ]; then
  log "backing up the database before the rollout (current tag $PREV)"
  sh ./backup-db.sh
fi
[ -n "$PREV" ] && [ "$PREV" != "$TAG" ] && echo "$PREV" > .previous-tag

set_tag "$TAG"
log "starting tag $TAG"
dc $(kafka_profile) up -d --remove-orphans
wait_healthy api 180 || die "API did not become healthy: sudo docker-compose -p $PROJECT logs --tail 80 api  (rollback: sudo sh rollback.sh)"
wait_healthy proxy 60 || die "proxy did not become healthy (rollback: sudo sh rollback.sh)"
sh ./smoke.sh
log "deployed $TAG (previous: ${PREV:-none})"
