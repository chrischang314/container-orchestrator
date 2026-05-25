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
  *k3s*)          echo "   Backend: k3s" ;;
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
helm repo add nfs-subdir-external-provisioner \
  https://kubernetes-sigs.github.io/nfs-subdir-external-provisioner/ >/dev/null 2>&1 || true
helm repo update >/dev/null

# 3. ingress-nginx ---------------------------------------------------------
step "Installing/upgrading ingress-nginx"
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f "$ROOT/platform/components/ingress-nginx/values.yaml" \
  --wait --timeout 5m

# 4. cert-manager ----------------------------------------------------------
step "Installing/upgrading cert-manager"
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  -f "$ROOT/platform/components/cert-manager/values.yaml" \
  --wait --timeout 5m

step "Applying cert-manager ClusterIssuers"
kubectl apply -f "$ROOT/platform/components/cert-manager/cluster-issuer.yaml"

# 5. Keel ------------------------------------------------------------------
step "Installing/upgrading Keel"
helm upgrade --install keel keel/keel \
  --namespace keel --create-namespace \
  -f "$ROOT/platform/components/keel/values.yaml" \
  --wait --timeout 3m

# 6. Synology NFS dynamic storage -----------------------------------------
if [[ "$CTX" != "docker-desktop" ]]; then
  step "Installing/upgrading Synology NFS provisioner"
  helm upgrade --install synology-nfs \
    nfs-subdir-external-provisioner/nfs-subdir-external-provisioner \
    --namespace storage --create-namespace \
    -f "$ROOT/platform/components/synology-nfs-provisioner/values.yaml" \
    --wait --timeout 5m

  if kubectl get storageclass local-path >/dev/null 2>&1; then
    kubectl patch storageclass local-path \
      --type=merge \
      -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' \
      >/dev/null
  fi
else
  warn "Skipping Synology NFS provisioner on Docker Desktop legacy backend"
fi

# 7. Summary ---------------------------------------------------------------
step "Bootstrap complete"
kubectl get pods -A --no-headers 2>/dev/null \
  | awk '$4 != "Running" && $4 != "Completed" {print "   not ready: " $0}' \
  || true

if ! kubectl get secret ghcr-creds -n default >/dev/null 2>&1; then
  echo
  echo "Note: no ghcr-creds secret exists in 'default' namespace."
  echo "      Public GHCR packages don't need it. For private images, run:"
  echo "        ./platform/components/ghcr-secret.sh"
  echo "      and add 'imagePullSecrets: [{name: ghcr-creds}]' to your app's values.yaml."
fi

echo
echo "Next:"
echo "  make deploy      # apply all apps under apps/"
echo "  make status      # show what's running and where to reach it"
