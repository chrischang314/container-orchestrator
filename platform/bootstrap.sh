#!/usr/bin/env bash
#
# Bootstrap platform components on the active kubectl context.
# Works on Docker Desktop K8s and k3s — same components, same versions.
# Idempotent: re-run any time to upgrade or recover.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
step()  { echo; echo "$(color "1;36" "==>") $(color 1 "$*")"; }
warn()  { echo "$(color "1;33" "WARN") $*"; }
err()   { echo "$(color "1;31" "ERR ") $*" >&2; }

# 1. Sanity checks ---------------------------------------------------------
if ! command -v kubectl >/dev/null 2>&1; then
  err "kubectl not found in PATH"
  exit 1
fi

CTX="$(kubectl config current-context 2>/dev/null || true)"
if [[ -z "$CTX" ]]; then
  err "No active kubectl context. Enable Kubernetes in Docker Desktop, or run 'make k3s-up' to start the k3s VM."
  exit 1
fi

step "Active context: $CTX"
case "$CTX" in
  docker-desktop) echo "   Backend: Docker Desktop Kubernetes" ;;
  lima-k3s*|k3s*) echo "   Backend: k3s (Lima)" ;;
  *)              warn "Unrecognized context name; continuing anyway" ;;
esac

if ! kubectl cluster-info >/dev/null 2>&1; then
  err "kubectl cannot reach the cluster on context '$CTX'"
  exit 1
fi

# 2. Helm ------------------------------------------------------------------
if ! command -v helm >/dev/null 2>&1; then
  step "Installing helm via Homebrew"
  brew install helm
fi

step "Adding helm repos"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo add jetstack      https://charts.jetstack.io                >/dev/null 2>&1 || true
helm repo add keel          https://charts.keel.sh                    >/dev/null 2>&1 || true
helm repo update >/dev/null

# 3. ingress-nginx ---------------------------------------------------------
step "Installing/upgrading ingress-nginx"
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f "$ROOT/platform/components/ingress-nginx/values.yaml" \
  --wait --timeout 5m

# 4. cert-manager (dormant) ------------------------------------------------
step "Installing/upgrading cert-manager (CRDs + controller, no ClusterIssuer yet)"
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  -f "$ROOT/platform/components/cert-manager/values.yaml" \
  --wait --timeout 5m

# 5. Keel ------------------------------------------------------------------
step "Installing/upgrading Keel"
helm upgrade --install keel keel/keel \
  --namespace keel --create-namespace \
  -f "$ROOT/platform/components/keel/values.yaml" \
  --wait --timeout 3m

# 6. GHCR pull secret ------------------------------------------------------
step "Ensuring GHCR image-pull secret in default namespace"
if kubectl get secret ghcr-creds -n default >/dev/null 2>&1; then
  echo "   ghcr-creds already exists; leaving as-is"
  echo "   (re-run platform/components/ghcr-secret.sh to rotate)"
else
  "$ROOT/platform/components/ghcr-secret.sh"
fi

# 7. Summary ---------------------------------------------------------------
step "Bootstrap complete"
kubectl get pods -A --no-headers 2>/dev/null \
  | awk '$4 != "Running" && $4 != "Completed" {print "   not ready: " $0}' \
  || true
echo
echo "Next:"
echo "  make deploy      # apply all apps under apps/"
echo "  make status      # show what's running and where to reach it"
