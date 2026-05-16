#!/usr/bin/env bash
#
# Snapshot of cluster + platform + apps. Read-only.

set -euo pipefail

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
hdr()   { echo; echo "$(color 1 "$*")"; printf '%.0s-' {1..60}; echo; }

CTX="$(kubectl config current-context 2>/dev/null || echo "")"
if [[ -z "$CTX" ]]; then
  echo "No active kubectl context. Enable Docker Desktop K8s or run 'make k3s-up'."
  exit 0
fi
echo "Context: $CTX"

if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "Cluster on '$CTX' is not reachable."
  exit 1
fi

hdr "Nodes"
kubectl get nodes -o wide

hdr "Platform components"
for ns in ingress-nginx cert-manager keel; do
  if kubectl get ns "$ns" >/dev/null 2>&1; then
    echo "[$ns]"
    kubectl -n "$ns" get pods --no-headers 2>/dev/null \
      | awk '{printf "  %-55s %-10s %s\n", $1, $2, $3}'
  else
    echo "[$ns]  (not installed — run make bootstrap)"
  fi
done

hdr "Helm releases"
helm ls -A 2>/dev/null || echo "(helm not available)"

hdr "App deployments"
kubectl get deployments -A --no-headers 2>/dev/null \
  | awk '$1 !~ /^(kube-system|ingress-nginx|cert-manager|keel)$/ {
      printf "  %-15s %-35s %s/%s\n", $1, $2, $3, $4
    }'

hdr "Ingress endpoints"
INGRESS_PORT=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.spec.ports[?(@.name=="http")].port}' 2>/dev/null || echo "80")
kubectl get ingress -A -o json 2>/dev/null | INGRESS_PORT="$INGRESS_PORT" python3 -c "
import json, os, sys
port = os.environ.get('INGRESS_PORT', '80')
suffix = '' if port in ('80', '') else f':{port}'
data = json.load(sys.stdin)
items = data.get('items', [])
if not items:
    print('  (no ingress resources)')
for it in items:
    ns   = it['metadata']['namespace']
    name = it['metadata']['name']
    for r in it.get('spec', {}).get('rules', []) or []:
        host = r.get('host', '*')
        for p in (r.get('http', {}) or {}).get('paths', []) or []:
            path = p.get('path', '/')
            print(f'  http://{host}{suffix}{path}   (ns={ns}, name={name})')
"

hdr "Ingress address"
INGRESS_ADDRS="$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{range .status.loadBalancer.ingress[*]}{.ip}{.hostname}{" "}{end}' 2>/dev/null | xargs || true)"
if [[ -z "$INGRESS_ADDRS" ]]; then
  INGRESS_ADDRS="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
fi
echo "  ${INGRESS_ADDRS:-(no ingress address detected)}"
echo
echo "  Add to /etc/hosts on other devices to reach ingress hosts:"
FIRST_INGRESS_ADDR="${INGRESS_ADDRS%% *}"
echo "    ${FIRST_INGRESS_ADDR:-<ingress-address>}   <ingress-host>"
