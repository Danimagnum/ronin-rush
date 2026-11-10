#!/bin/sh
# One-time setup: folders, permissions and a .env with fresh random secrets.
#   sudo sh /volume1/docker/ronin-rush/init.sh
. "$(dirname "$0")/lib.sh"
need_root
mkdir -p data/postgres data/redis data/redpanda releases backups
# Redpanda runs as uid 101 inside its image.
chown 101:101 data/redpanda
# Your SSH user can upload release bundles without sudo.
[ -n "${SUDO_USER:-}" ] && chown "$SUDO_USER" releases
rnd() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ -f .env ]; then
  log ".env already exists: secrets left untouched"
else
  sed -e "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(rnd)/" -e "s/^JWT_SECRET=$/JWT_SECRET=$(rnd)/" env.example > .env
  log "created .env with random POSTGRES_PASSWORD and JWT_SECRET"
fi
chmod 600 .env
chmod 700 backups
log "ready. Upload a release to $ROOT/releases and run: sudo sh deploy.sh <tag>"
