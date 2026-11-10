# Shared helpers for the NAS scripts. Sourced, not executed.
set -eu
# DSM's sudo keeps a short secure_path: make docker and docker-compose reachable.
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PROJECT=ronin-rush
compose_files() {
  # PLATFORM_KAFKA=true in .env joins the platform stack's network (see docker-compose.platform-kafka.yml).
  if [ -f .env ] && grep -q '^PLATFORM_KAFKA=true' .env; then
    echo "-f docker-compose.yml -f docker-compose.platform-kafka.yml"
  else
    echo "-f docker-compose.yml"
  fi
}
dc() { docker-compose -p "$PROJECT" $(compose_files) "$@"; }
log() { printf '\033[36m[ronin]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[ronin] %s\033[0m\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run with sudo: sudo $0 $*"; }
current_tag() { sed -n 's/^RONIN_TAG=//p' .env | tail -1; }
set_tag() {
  if grep -q '^RONIN_TAG=' .env; then sed -i "s/^RONIN_TAG=.*/RONIN_TAG=$1/" .env; else echo "RONIN_TAG=$1" >> .env; fi
}
kafka_profile() {
  # Start the bundled broker only when .env points at it.
  if grep -q '^KAFKA_BROKERS=kafka:9092' .env; then echo "--profile kafka"; fi
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else openssl dgst -sha256 "$1" | sed 's/.*= //'; fi
}
wait_healthy() {
  # $1 = container service name, $2 = timeout seconds
  local id status i=0
  id="$(dc ps -q "$1")"
  [ -n "$id" ] || die "service $1 is not running"
  while [ $i -lt "$2" ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && return 1
    sleep 2; i=$((i + 2))
  done
  return 1
}
