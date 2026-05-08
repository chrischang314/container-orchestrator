#!/usr/bin/env bash
#
# Toggle the active kubectl context between docker-desktop and the k3s
# Lima context. Useful once a second Mac Mini joins.

set -euo pipefail

CURRENT="$(kubectl config current-context 2>/dev/null || echo "")"
CONTEXTS="$(kubectl config get-contexts -o name 2>/dev/null || true)"

has_ctx() {
  echo "$CONTEXTS" | grep -qx "$1"
}

K3S_CTX=""
for c in lima-k3s-server k3s lima-k3s; do
  if has_ctx "$c"; then K3S_CTX="$c"; break; fi
done

DD_CTX=""
if has_ctx "docker-desktop"; then DD_CTX="docker-desktop"; fi

echo "Current context: ${CURRENT:-(none)}"
echo "Available:"
[[ -n "$DD_CTX"  ]] && echo "  - $DD_CTX"
[[ -n "$K3S_CTX" ]] && echo "  - $K3S_CTX"

case "$CURRENT" in
  docker-desktop)
    if [[ -z "$K3S_CTX" ]]; then
      echo "No k3s context available. Run 'make k3s-up' first."
      exit 1
    fi
    echo "Switching to $K3S_CTX..."
    kubectl config use-context "$K3S_CTX"
    ;;
  lima-k3s-server|k3s|lima-k3s)
    if [[ -z "$DD_CTX" ]]; then
      echo "No docker-desktop context. Enable Kubernetes in Docker Desktop."
      exit 1
    fi
    echo "Switching to $DD_CTX..."
    kubectl config use-context "$DD_CTX"
    ;;
  *)
    # No current or unknown — pick one
    if [[ -n "$DD_CTX" ]]; then
      kubectl config use-context "$DD_CTX"
    elif [[ -n "$K3S_CTX" ]]; then
      kubectl config use-context "$K3S_CTX"
    else
      echo "Neither docker-desktop nor k3s contexts found."
      exit 1
    fi
    ;;
esac

echo "Now: $(kubectl config current-context)"
