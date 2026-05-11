#!/usr/bin/env bash
#
# Helm-upgrade-install every app under apps/<name>/values.yaml against the
# active kubectl context. Idempotent.
#
# Per-app override: drop a values.local.yaml next to values.yaml — it is
# gitignored and applied as a second `-f` to helm.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

command -v helm    >/dev/null 2>&1 || { echo "ERROR: helm not found"    >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "ERROR: kubectl not found" >&2; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || true)"
if [[ -z "$CTX" ]]; then
  echo "ERROR: no active kubectl context. Enable Docker Desktop K8s or run 'make k3s-up'." >&2
  exit 1
fi
echo "Deploying to context: $CTX"

shopt -s nullglob
APPS=("$ROOT"/apps/*/values.yaml)
if [[ ${#APPS[@]} -eq 0 ]]; then
  echo "No apps found under apps/. Nothing to do."
  exit 0
fi

for VALUES in "${APPS[@]}"; do
  APP_DIR="$(dirname "$VALUES")"
  APP_NAME="$(basename "$APP_DIR")"

  NS="$(awk '/^namespace:/ {print $2; exit}' "$VALUES" | tr -d '"'"'")"
  NS="${NS:-default}"

  EXTRA=()
  if [[ -f "$APP_DIR/values.local.yaml" ]]; then
    EXTRA+=(-f "$APP_DIR/values.local.yaml")
    echo "   overlay: $APP_DIR/values.local.yaml"
  fi

  echo
  echo "==> $APP_NAME  (namespace: $NS)"
  helm upgrade --install "$APP_NAME" "$ROOT/charts/app" \
    -f "$VALUES" "${EXTRA[@]+"${EXTRA[@]}"}" \
    --namespace "$NS" --create-namespace \
    --wait --timeout 5m
done

echo
echo "Done. Run 'make status' to verify and see ingress URLs."
