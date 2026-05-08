#!/usr/bin/env bash
#
# Bring up the k3s-in-Lima VM and merge its kubeconfig into ~/.kube/config
# under the context name `lima-k3s-server`.
#
# Usage:
#   ./platform/k3s/up.sh                  # bring up the SERVER VM (first Mac Mini)
#   ./platform/k3s/up.sh --agent          # bring up an AGENT VM (additional Mac Mini)
#   ./platform/k3s/up.sh --kubeconfig     # only re-fetch the kubeconfig
#
# Idempotent: re-running on an existing VM only refreshes the kubeconfig.

set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

MODE="server"
KUBECONFIG_ONLY=0
case "${1:-}" in
  --agent)       MODE="agent" ;;
  --kubeconfig)  KUBECONFIG_ONLY=1 ;;
  "")            ;;
  *) echo "Unknown flag: $1"; exit 1 ;;
esac

VM_NAME="lima-k3s-${MODE}"
LIMA_YAML="$ROOT/platform/k3s/lima-${MODE}.yaml"

if ! command -v limactl >/dev/null 2>&1; then
  echo "Lima not found. Install with: brew install lima"
  exit 1
fi

if [[ "$KUBECONFIG_ONLY" -eq 1 ]]; then
  if ! limactl list --quiet 2>/dev/null | grep -qx "$VM_NAME"; then
    echo "VM '$VM_NAME' does not exist. Run without --kubeconfig first."
    exit 1
  fi
else
  if limactl list --quiet 2>/dev/null | grep -qx "$VM_NAME"; then
    STATUS="$(limactl list "$VM_NAME" --format '{{.Status}}' 2>/dev/null || true)"
    if [[ "$STATUS" != "Running" ]]; then
      echo "==> Starting existing VM $VM_NAME"
      limactl start "$VM_NAME"
    else
      echo "==> VM $VM_NAME already running"
    fi
  else
    echo "==> Creating VM $VM_NAME from $LIMA_YAML"
    limactl start --name="$VM_NAME" --tty=false "$LIMA_YAML"
  fi
fi

# Server-only: pull k3s.yaml back to the host and merge into ~/.kube/config
if [[ "$MODE" == "server" ]]; then
  echo "==> Extracting k3s kubeconfig from $VM_NAME"
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  limactl shell "$VM_NAME" sudo cat /etc/rancher/k3s/k3s.yaml >"$TMP"

  # k3s writes 127.0.0.1; Lima's port-forwarder maps that to localhost on the Mac.
  # Rename the context from "default" to lima-k3s-server before merging.
  /usr/bin/sed -i '' 's/name: default$/name: lima-k3s-server/' "$TMP"
  /usr/bin/sed -i '' 's/context: default$/context: lima-k3s-server/' "$TMP"
  /usr/bin/sed -i '' 's/current-context: default/current-context: lima-k3s-server/' "$TMP"
  /usr/bin/sed -i '' 's/cluster: default$/cluster: lima-k3s-server/' "$TMP"
  /usr/bin/sed -i '' 's/user: default$/user: lima-k3s-server/' "$TMP"

  mkdir -p "$HOME/.kube"
  if [[ -f "$HOME/.kube/config" ]]; then
    KUBECONFIG="$HOME/.kube/config:$TMP" kubectl config view --flatten >"$HOME/.kube/config.merged"
    mv "$HOME/.kube/config.merged" "$HOME/.kube/config"
  else
    cp "$TMP" "$HOME/.kube/config"
  fi
  chmod 600 "$HOME/.kube/config"
  echo "==> Merged context: lima-k3s-server"
  echo
  echo "Switch to it with:  kubectl config use-context lima-k3s-server"
  echo "Or:                 ./scripts/switch-cluster.sh"
fi

if [[ "$MODE" == "agent" ]]; then
  echo
  echo "Agent VM is up. Verify it joined the server with:"
  echo "  kubectl --context lima-k3s-server get nodes"
fi
