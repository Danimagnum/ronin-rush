#!/bin/sh
# Consistent logical backup (pg_dump custom format). Keeps the 10 most recent.
#   sudo sh backup-db.sh
. "$(dirname "$0")/lib.sh"
need_root
mkdir -p backups
FILE="backups/ronin-$(date +%Y%m%d-%H%M%S)-$(current_tag).dump"
dc exec -T postgres pg_dump -U ronin -d ronin -Fc > "$FILE"
[ -s "$FILE" ] || die "backup is empty: $FILE"
chmod 600 "$FILE"
ls -1t backups/*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f
log "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
