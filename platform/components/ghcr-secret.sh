#!/usr/bin/env bash
#
# Create or refresh the GHCR image-pull secret in the target namespace.
# Idempotent: safe to re-run.
#
# Inputs (env vars or interactive prompt):
#   GHCR_USERNAME  — your GitHub username
#   GHCR_TOKEN     — a Personal Access Token with the read:packages scope
#                    (classic PAT or fine-grained token granting "Packages: read")
#
# Optional:
#   NAMESPACE     — k8s namespace (default: default)
#   SECRET_NAME   — secret name (default: ghcr-creds)

set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
SECRET_NAME="${SECRET_NAME:-ghcr-creds}"

if [[ -z "${GHCR_USERNAME:-}" ]]; then
  read -r -p "GitHub username: " GHCR_USERNAME
fi

if [[ -z "${GHCR_TOKEN:-}" ]]; then
  read -r -s -p "GHCR Personal Access Token (read:packages): " GHCR_TOKEN
  echo
fi

if [[ -z "$GHCR_USERNAME" || -z "$GHCR_TOKEN" ]]; then
  echo "ERROR: GHCR_USERNAME and GHCR_TOKEN must be non-empty" >&2
  exit 1
fi

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

kubectl create secret docker-registry "$SECRET_NAME" \
  --namespace "$NAMESPACE" \
  --docker-server=ghcr.io \
  --docker-username="$GHCR_USERNAME" \
  --docker-password="$GHCR_TOKEN" \
  --docker-email="${GHCR_USERNAME}@users.noreply.github.com" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret $NAMESPACE/$SECRET_NAME ready (registry: ghcr.io, user: $GHCR_USERNAME)"
