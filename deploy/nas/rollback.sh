#!/bin/sh
# Go back to the previous image tag (or a given one). Images stay loaded, so this takes seconds.
#   sudo sh rollback.sh            → tag stored in .previous-tag
#   sudo sh rollback.sh <tag>
#   sudo sh rollback.sh <tag> backups/<file>.dump   → also restore the database dump
. "$(dirname "$0")/lib.sh"
need_root "$@"
TAG="${1:-$(cat .previous-tag 2>/dev/null || true)}"
[ -n "$TAG" ] || die "no previous tag recorded; pass one: sudo sh rollback.sh <tag>"
for img in api web proxy; do docker image inspect "ronin-rush-$img:$TAG" >/dev/null 2>&1 || die "image ronin-rush-$img:$TAG is not loaded"; done
CUR="$(current_tag)"
if [ -n "${2:-}" ]; then
  set_tag "$TAG"
  sh ./restore-db.sh "$2"
fi
set_tag "$TAG"
[ -n "$CUR" ] && [ "$CUR" != "$TAG" ] && echo "$CUR" > .previous-tag
log "rolling back $CUR → $TAG"
dc $(kafka_profile) up -d --remove-orphans
wait_healthy api 180 || die "API not healthy after rollback: sudo docker-compose -p $PROJECT logs --tail 80 api"
sh ./smoke.sh
log "now running $TAG"
