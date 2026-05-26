# Kubernetes Cluster Handoff

This is the operator handoff for the active home Kubernetes cluster as of
2026-05-18. It is written for another LLM or human operator taking over the
same Mac Mini / Raspberry Pi / Synology homelab.

## Current Cluster

- Active kube context: `rpi5-k3s`
- Control plane: `rpi5-control` at `192.168.4.56`
- Mac Mini worker: `mac-mini-worker` at `192.168.4.34`
- Railroad edge worker: `railroad-pi3` at `192.168.4.57`
- Synology NAS storage backend: `Synology.local` at `192.168.4.33`

Node labels:

| Node | Role | Important labels |
|---|---|---|
| `rpi5-control` | K3s control plane and always-on home infra | `workload-tier=home-infra`, `hardware=raspberry-pi` |
| `mac-mini-worker` | Main compute and web app worker | `workload-tier=compute`, `hardware=mac-mini` |
| `railroad-pi3` | Train-control edge worker | `workload-tier=edge`, `hardware=raspberry-pi`, `railroad-csb1-updater=true` |

The three active Kubernetes nodes are also labeled
`svccontroller.k3s.cattle.io/enablelb=true`. This puts K3s ServiceLB in
allow-list mode so a future NAS/storage node does not try to host LoadBalancer
pods or bind ports already owned by DSM.

Do not commit or print the K3s node token. If it is needed, read it on the
control plane from `/var/lib/rancher/k3s/server/node-token` over SSH.

## DNS And Ingress

Pi-hole is the LAN DNS authority. The router should hand out `192.168.4.56` as
the DNS server. Pi-hole custom host records currently map these hostnames to the
cluster ingress address:

| Hostname | URL |
|---|---|
| `projects.lan` | `http://projects.lan/` |
| `homewebsite.lan` | redirects to `http://projects.lan/` |
| `homeassistant.lan` | `http://homeassistant.lan/` |
| `homebridge.lan` | `http://homebridge.lan/` |
| `k8s.lan` | `http://k8s.lan/` |
| `localllm.lan` | `http://localllm.lan/` |
| `modelrailroadautomation.lan` | `http://modelrailroadautomation.lan/` |
| `modeltradingbot.lan` | `http://modeltradingbot.lan/` |
| `pihole.lan` | `http://pihole.lan/` |
| `recruitingapp.lan` | `http://recruitingapp.lan/` |

Ingress is `ingress-nginx` with a `LoadBalancer` service on normal web ports:

- HTTP: `80`
- HTTPS: `443`
- External IPs: `192.168.4.34`, `192.168.4.56`, `192.168.4.57`

The public portfolio is managed by the `home-website-public` Helm release. It
routes `chriswchang.com`, `www.chriswchang.com`, and unmatched HTTP hosts to
the sanitized public image. Public DNS is outside the cluster; `make status`
compares the domain's A record with the current WAN IP.

Pi-hole DNS is exposed separately as a `LoadBalancer` service on TCP/UDP `53`.
The Pi-hole web UI is a separate ClusterIP service named `pihole-web` and is
routed through ingress at `pihole.lan`.

DNS cannot remove or rewrite port numbers by itself. The no-port URLs work
because ingress-nginx owns port `80`, and Pi-hole only resolves hostnames.

Useful checks:

```sh
make status
kubectl get nodes -o wide
kubectl get ingress -A
kubectl get svc -n ingress-nginx ingress-nginx-controller
kubectl exec deploy/pihole-pihole -- pihole-FTL --config dns.hosts
```

## Workload Inventory

| App | Repo/image | LAN URL | Placement | Notes |
|---|---|---|---|---|
| `home-website` | `ghcr.io/chrischang314/home-website:main` | `projects.lan` | `mac-mini-worker` | LAN launchpad. `homewebsite.lan` redirects here. User-facing links use `.lan`; status probes use internal K8s service DNS. |
| `home-website-public` | `ghcr.io/chrischang314/home-website:public` | `chriswchang.com` | `mac-mini-worker` | Public portfolio with TLS via `letsencrypt-http01`; also catches direct public-IP HTTP requests. |
| `home-assistant` | `ghcr.io/home-assistant/home-assistant:stable` | `homeassistant.lan` | `rpi5-control` | Uses `hostNetwork: true` for discovery/integrations. Config path is `/srv/home-assistant` on the Pi. |
| `homebridge` | `homebridge/homebridge:latest` | `homebridge.lan` | `rpi5-control` | Uses `hostNetwork: true` for HomeKit/mDNS reliability. Config path is `/srv/homebridge` on the Pi. |
| `k8s-management-ui` | `ghcr.io/chrischang314/container-orchestrator/k8s-management-ui:main` | `k8s.lan` | `rpi5-control` | LAN control panel for nodes, containers, deployments, and allowlisted kubectl controls. Mutating controls require UI confirmation and backend `confirmed: true` before execution. Uses cluster-scoped RBAC. |
| `k8s-cluster-status` | `ghcr.io/chrischang314/container-orchestrator/k8s-management-ui:main` | internal only | `rpi5-control` | Read-only public-status service for the portfolio `/cluster-status/` proxy. Uses read-only RBAC and sanitized aggregate output. |
| `local-llm` | `ghcr.io/chrischang314/local-llm/*:main` | `localllm.lan` | `mac-mini-worker` | Backend reaches Ollama on the Mac host through `host.lima.internal:11434`, aliasing to `192.168.5.2`. |
| `model-railroad-automation` | `ghcr.io/chrischang314/model-railroad-automation/web-control:main` | `modelrailroadautomation.lan` | `railroad-pi3` | Train web server; talks to DCC-EX at `192.168.4.22:2560`. |
| `model-trading-bot` | `ghcr.io/chrischang314/model-trading-bot/*:main` | `modeltradingbot.lan` | `mac-mini-worker` | Frontend plus backend with local data PVC. |
| `pihole` | `pihole/pihole:latest` | `pihole.lan` | `rpi5-control` | DNS on port 53, web via ingress. Config paths are `/srv/pihole/etc-pihole` and `/srv/pihole/etc-dnsmasq.d`. |
| `postgres` | `pgvector/pgvector:pg16` | internal only | `mac-mini-worker` | Shared PostgreSQL/pgvector database for recruiting app. |
| `recruiting-app` | `ghcr.io/chrischang314/recruiting-app/*:main` | `recruitingapp.lan` | `mac-mini-worker` | API, frontend, scraper. 1point3acres requires a copied `data/storage_state.json`, but it is disabled while the current session returns `user_banned` / "用户组: 不准访问". Active scraper sources are Hacker News + Reddit with embeddings/OCR enabled and a faster public-source profile. |
| `csb1-ota-updater` | `ghcr.io/chrischang314/model-railroad-csb1-updater:latest` | none | `railroad-pi3` | Runs in namespace `railroad`; used for train hardware support. |

Legacy LoadBalancer service ports still exist for compatibility:

| Service | Port |
|---|---:|
| `local-llm-frontend` | `12000` |
| `recruiting-app-frontend` | `13000` |
| `model-trading-bot-frontend` | `14000` |
| `model-railroad-automation-web-control` | `15000` |

Prefer the `.lan` ingress URLs for browser access.

## Deployment Model

Application repos build and push Linux/ARM64 images to GHCR. The orchestrator
repo owns Helm values under `apps/<project>/values.yaml`; the generic chart is
`charts/app`.

Typical app deployment:

```sh
kubectl config use-context rpi5-k3s
helm lint charts/app -f apps/<project>/values.yaml
helm upgrade --install <project> charts/app \
  -f apps/<project>/values.yaml \
  --namespace default --create-namespace --wait --timeout 5m
```

`make deploy` loops all `apps/*/values.yaml` files and runs the same pattern.
Keel is installed and polls tagged images when a service has `autoDeploy`
enabled. Most private GHCR images use the `ghcr-creds` image pull secret.

## Storage

The default StorageClass is `local-path`. It is the Mac-mini cache/default tier
for public/demo workloads and small rebuildable caches. `synology-nfs` is an
explicit primary-storage tier that dynamically provisions directories under the
NAS NFS export `192.168.4.33:/volume1/k8s` through the
`nfs-subdir-external-provisioner` Helm chart. The provisioner values are tracked
in
[`platform/components/synology-nfs-provisioner/values.yaml`](platform/components/synology-nfs-provisioner/values.yaml).
The fallback architecture is documented in
[`docs/storage-fallback.md`](docs/storage-fallback.md).

Important storage classes:

| StorageClass | Purpose | Notes |
|---|---|---|
| `local-path` | Default Mac-mini cache tier | `WaitForFirstConsumer`; pin public/demo pods to the node that owns the cache. |
| `synology-nfs` | Explicit NAS-backed primary data | Reclaim policy is `Retain`; directories are preserved if a PVC is deleted. |

Operational checks:

```sh
kubectl get sc
kubectl get pods -n storage -o wide
kubectl logs -n storage deploy/synology-nfs-nfs-subdir-external-provisioner --tail=50
```

NFS mount smoke tests have passed from `mac-mini-worker` and `railroad-pi3`.
The provisioner itself is pinned to `rpi5-control`, where NFS client support is
also present.

Current local-cache PVC-backed workloads:

| PVC | Current purpose |
|---|---|
| `postgres-postgres-pgdata` | Recruiting PostgreSQL database |
| `model-trading-bot-backend-data` | Trading bot backend data |
| `local-llm-backend-data` | Local LLM app data |
| `recruiting-app-api-hf-cache` | Recruiting embedding cache |
| `recruiting-app-scraper-data` | Scraper state/images |
| `recruiting-app-scraper-hf-cache` | Scraper embedding/cache data |

Do not move a stateful Deployment by only changing `nodeSelector`; with
local-path PVCs that can leave the pod pending or detached from its data. Do
not delete these PVCs to force reprovisioning unless a backup has already been
verified. For PostgreSQL, use logical backup/restore (`pg_dump` / restore) or a
careful cold copy with the database stopped. For app caches, decide whether
they can be rebuilt before migrating.

Synology-backed PVCs are currently `trading-bot/trading-bot-parquet`,
`trading-bot/redis-data-redis-0`, `local-llm/local-llm-chat-data`, and
`local-llm/ollama-model-cache`. Public ingress targets should be able to start
without mounting those volumes.

## Synology Worker Status

The NAS is reachable at `192.168.4.33`, SSH is enabled, and the DSM admin user
can run sudo. Hardware and OS:

- Model family observed by the kernel: `synology_geminilakenk_ds225+`
- OS: DSM 7.3.2
- Architecture: `x86_64`
- LAN interface: `eth0` at `192.168.4.33`

Direct K3s worker attempt result:

- K3s agent install succeeded and was able to reach `rpi5-control`.
- containerd started under `/volume1/k3s`.
- kubelet failed before registering the node because `/proc/cgroups` has no
  `pids` controller.
- Tried `pod-max-pids=-1`, `cgroups-per-qos=false`,
  `enforce-node-allocatable=`, and old PID feature gates; K3s still failed at
  its default kubelet config preflight with `pids cgroup controller not found`.
- The failed K3s install was cleaned up, including the token-bearing systemd
  env file and `/volume1/k3s`.

Do not retry a direct DSM-hosted K3s worker unless Synology ships a kernel with
`CONFIG_CGROUP_PIDS`, or unless the worker runs inside a real Linux VM on the
NAS. Containers on DSM share the DSM kernel, so a containerized K3s worker would
hit the same cgroup limit.

The practical storage path is NFS, and the first four steps are complete:

1. NFS service is enabled in DSM.
2. DSM exports `/volume1/k8s` to `192.168.4.0/22`.
3. `synology-nfs` is installed and set as the default StorageClass.
4. Mounts have been tested from each active worker node.
5. Remaining work: migrate existing local-path PVC data into new
   Synology-backed PVCs.

Recommended first migration target: `postgres`. Storage-adjacent caches can
move later if the NAS proves reliable and performant.

## Learned Nuances

- Pi-hole hostnames solve naming, not ports. Ingress on `80/443` is what makes
  `http://project.lan/` work without a suffix.
- Pi-hole web and Pi-hole DNS should be split: DNS keeps the `LoadBalancer`
  port 53, while web is a ClusterIP routed through ingress.
- The Mac Mini worker is a Lima VM. Its bridged network must use the active LAN
  interface; here that is `en1`, configured in
  `/Users/chrischang/.lima/_config/networks.yaml`.
- K3s pod DNS on the Lima worker depends on a sane resolver file. The working
  setup uses K3S_RESOLV_CONF with `/run/systemd/resolve/resolv.conf`.
- The home website server runs inside Kubernetes, so its health checks and
  proxied demo routes cannot rely on Pi-hole `.lan` DNS. It uses internal
  service DNS for probes/proxies and `.lan` URLs for user-facing links.
- Homebridge uses host networking because HomeKit discovery depends on LAN
  multicast/mDNS.
- Railroad control is intentionally placed on the Pi near the train hardware.
- Synology DSM 7.3.2 on this DS225+ cannot run a direct K3s worker because its
  kernel lacks the `pids` cgroup controller.
- Synology is still useful as the cluster storage backend through NFS-backed
  PVCs; use `synology-nfs` for new persistent workloads.
- Do not commit kubeconfigs, K3s tokens, Pi-hole passwords, NAS credentials, or
  Homebridge pairing secrets.

## Quick Recovery Commands

```sh
# Verify all main app hostnames from a client using Pi-hole DNS.
for h in projects homeassistant homebridge k8s localllm modelrailroadautomation modeltradingbot pihole recruitingapp; do
  curl -I --max-time 5 "http://${h}.lan/" | sed -n "1p"
done

# Re-deploy one app after editing values.
helm upgrade --install home-website charts/app \
  -f apps/home-website/values.yaml \
  --namespace default --create-namespace --wait --timeout 5m

# Check a rollout.
kubectl rollout status deployment/home-website-web --timeout=120s

# Verify Synology-backed dynamic storage.
kubectl get sc synology-nfs
kubectl get pods -n storage -o wide

# Check the launchpad and proxied public-preview routes.
curl.exe -I http://projects.lan/
curl.exe -I http://projects.lan/model-trading-bot/
curl.exe -I http://projects.lan/trading-bot/
curl.exe -I http://projects.lan/local-llm/
curl.exe -I http://projects.lan/railroad-automation/
curl.exe -I http://projects.lan/cluster-status/
```
## Agent Operating Policy

Project-specific Codex rules now live in `AGENTS.md`. Use them before adding worker nodes or deploying containers. The important rule is simple: after any deployment, verify Helm lint, rollout status, pod health/logs when needed, and the LAN or health endpoint before calling the work complete.

## K8s UI Mutation Safety

The LAN `k8s-management-ui` requires a confirmation dialog before built-in
mutating actions or typed mutating `kubectl` commands send a network request.
The backend also rejects unconfirmed mutating `/api/action` and `/api/command`
calls with HTTP 409, while read-only controls stay one-click. Receipts show the
exact command, mutating/read-only classification, exit code, stdout, and stderr.
