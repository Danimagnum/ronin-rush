<#
  Build the production images for linux/amd64, export them with docker save and write the SHA-256.
  Run from the repo root on Windows (Docker Desktop):

    powershell -ExecutionPolicy Bypass -File deploy\release.ps1
    powershell -ExecutionPolicy Bypass -File deploy\release.ps1 -NasUser daniel

  Output: releases\ronin-rush-<tag>.tar.gz and .sha256 (tag = short git commit).
#>
param(
  [string]$NasUser = "TU_USUARIO",
  [string]$NasHost = "192.168.1.39",
  [string]$NasDir = "/volume1/docker/ronin-rush",
  [switch]$AllowDirty
)
$ErrorActionPreference = "Stop"
Set-Location (git rev-parse --show-toplevel)

if (-not $AllowDirty -and (git status --porcelain)) { throw "Uncommitted changes: commit first so the tag matches the code (or pass -AllowDirty)." }
$tag = (git rev-parse --short=7 HEAD).Trim()
if ($AllowDirty -and (git status --porcelain)) { $tag = "$tag-dirty" }
New-Item -ItemType Directory -Force releases | Out-Null

foreach ($target in "api", "web", "proxy") {
  Write-Host "==> building ronin-rush-${target}:$tag (linux/amd64)" -ForegroundColor Cyan
  # Empty NEXT_PUBLIC_API_URL: the browser calls /api and /socket.io on its own origin (nginx).
  # --provenance/--sbom off: one plain image manifest instead of an index with attestations,
  # so `docker save` writes manifest.json and the NAS's Docker 20.10 can `docker load` it.
  docker buildx build --platform linux/amd64 --target $target `
    --provenance=false --sbom=false `
    --build-arg NEXT_PUBLIC_API_URL= `
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" `
    -t "ronin-rush-${target}:$tag" --load .
  if ($LASTEXITCODE -ne 0) { throw "build failed: $target" }
}

$tar = "releases\ronin-rush-$tag.tar"
Write-Host "==> docker save -> $tar.gz" -ForegroundColor Cyan
docker save -o $tar "ronin-rush-api:$tag" "ronin-rush-web:$tag" "ronin-rush-proxy:$tag"
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }
# Docker 20.10 (Synology) only loads archives with a Docker manifest.json; without it, it falls
# back to the legacy format and fails with "open .../repositories: no such file or directory".
if (-not ((tar -tf $tar) -contains "manifest.json")) {
  Remove-Item $tar
  throw "docker save produced an OCI-only archive (no manifest.json) that the NAS cannot load. Images must be built with --provenance=false --sbom=false."
}
tar -czf "$tar.gz" -C releases "ronin-rush-$tag.tar"   # Windows 10+ ships bsdtar
Remove-Item $tar

$hash = (Get-FileHash -Algorithm SHA256 "$tar.gz").Hash.ToLower()
# sha256sum format, with a Unix newline so the NAS reads it cleanly.
[IO.File]::WriteAllText("$PWD\$tar.gz.sha256", "$hash  ronin-rush-$tag.tar.gz`n")

$size = "{0:N0} MB" -f ((Get-Item "$tar.gz").Length / 1MB)
Write-Host ""
Write-Host "Release $tag ready ($size), SHA-256 $hash" -ForegroundColor Green
Write-Host "Upload:  scp releases\ronin-rush-$tag.tar.gz releases\ronin-rush-$tag.tar.gz.sha256 ${NasUser}@${NasHost}:$NasDir/releases/"
Write-Host "Deploy:  ssh ${NasUser}@${NasHost}   then   cd $NasDir && sudo sh deploy.sh $tag"
