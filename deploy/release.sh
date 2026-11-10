#!/usr/bin/env bash
# Same as release.ps1 for Linux/macOS/CI: build linux/amd64 images, docker save, SHA-256.
#   deploy/release.sh [--allow-dirty]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ "${1:-}" != "--allow-dirty" && -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes: commit first (or --allow-dirty)" >&2; exit 1
fi
TAG="$(git rev-parse --short=7 HEAD)"
[[ -n "$(git status --porcelain)" ]] && TAG="$TAG-dirty"
mkdir -p releases
for target in api web proxy; do
  # No provenance/SBOM: a plain image manifest, so `docker save` writes manifest.json (needed by Docker 20.10).
  docker buildx build --platform linux/amd64 --target "$target" --provenance=false --sbom=false --build-arg NEXT_PUBLIC_API_URL= \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" -t "ronin-rush-$target:$TAG" --load .
done
docker save -o "releases/ronin-rush-$TAG.tar" "ronin-rush-api:$TAG" "ronin-rush-web:$TAG" "ronin-rush-proxy:$TAG"
# Docker 20.10 (Synology) needs a Docker manifest.json; an OCI-only archive fails to load there.
tar -tf "releases/ronin-rush-$TAG.tar" | grep -qx manifest.json \
  || { rm -f "releases/ronin-rush-$TAG.tar"; echo "docker save produced an OCI-only archive (no manifest.json)" >&2; exit 1; }
gzip -f "releases/ronin-rush-$TAG.tar"
(cd releases && sha256sum "ronin-rush-$TAG.tar.gz" > "ronin-rush-$TAG.tar.gz.sha256")
echo "release $TAG: releases/ronin-rush-$TAG.tar.gz ($(du -h "releases/ronin-rush-$TAG.tar.gz" | cut -f1))"
cat "releases/ronin-rush-$TAG.tar.gz.sha256"
