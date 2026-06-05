# container-orchestrator

Self-hosted Kubernetes platform for running containerized GitHub apps on a Mac
Mini, with automatic image-driven deployments from GHCR.

Project-specific Codex operating rules live in [`AGENTS.md`](AGENTS.md). Use them for adding worker nodes, deploying app containers, and verifying health after rollout.

For a point-in-time operator handoff with current nodes, URLs, storage, and
migration notes, see [`HANDOFF.md`](HANDOFF.md).

## Goals

- Raspberry Pi 5 control plane for high availability, with the Mac Mini and
  other machines joined as workers without rebuilding app manifests.
- Apps live in their own GitHub repos. CI builds an image, pushes it to GHCR,
  and the cluster picks it up on its next poll — no manual `kubectl apply`.
- Stateful apps survive rolling updates (PVCs).
- LAN-first by default, with the public portfolio served through the same
  ingress-nginx and cert-manager platform.

## Cluster backends

Two backends are supported via the same set of manifests, charts, and scripts.
Switching is a `kubectl config use-context` away.

| Backend | Status | When to use |
|---|---|---|
| **Docker Desktop K8s** | legacy | Original single-node setup; useful as a rollback reference |
| **k3s** | active | Raspberry Pi control plane plus Mac Mini / Pi workers |

The platform components (ingress-nginx, cert-manager, Keel) and all app
manifests are deliberately distro-agnostic — PVCs use the cluster's default
StorageClass and ingress is a controller we install ourselves. See
[`platform/k3s/MIGRATION.md`](platform/k3s/MIGRATION.md) for the switch-over
procedure.

## Quick start

```sh
make bootstrap     # one-time: install platform components on the active context
make deploy        # apply every app under apps/
make status        # show cluster + apps + ingress URLs
```

## Current LAN inventory

The active cluster is `rpi5-k3s`: Raspberry Pi 5 control plane, Mac Mini
compute worker, and a Raspberry Pi railroad edge worker. Pi-hole resolves
project hostnames to the ingress controller, so these URLs do not need port
numbers:

| URL | Workload | Placement |
|---|---|---|
| `http://projects.lan/` | Homelab launchpad and portfolio preview. `homewebsite.lan` redirects here. | Mac Mini worker |
| `http://homeassistant.lan/` | Home Assistant UI | Raspberry Pi 5 control plane |
| `http://homebridge.lan/` | Homebridge UI | Raspberry Pi 5 control plane |
| `http://k8s.lan/` | Kubernetes cluster management UI | Raspberry Pi 5 control plane |
| `http://localagent.lan/` | Local Agent control UI; backend uses a Recreate rollout to avoid Mac Mini memory-pressure surges. | Mac Mini worker |
| `http://localllm.lan/` | Local LLM chat frontend | Mac Mini worker |
| `http://modelrailroadautomation.lan/` | Railroad control web server with direct DCC-EX browser commands | Railroad Pi worker |
| `http://modeltradingbot.lan/` | Trading bot frontend | Mac Mini worker |
| `http://pihole.lan/` | Pi-hole web UI | Raspberry Pi 5 control plane |
| `http://recruitingapp.lan/` | Recruiting/search app frontend | Mac Mini worker |

Legacy LoadBalancer service ports such as `12000`, `13000`, `14000`, and
`15000` still exist for compatibility, but normal browser access should go
through the `.lan` ingress hostnames above.

`http://homewebsite.lan/` is kept as a compatibility alias and redirects to
`http://projects.lan/`.

## Public portfolio

`home-website-public` serves `https://chriswchang.com/` and
`https://www.chriswchang.com/` from the public `home-website:public` image. It
also has a hostless HTTP ingress rule so direct public-IP HTTP requests route to
the portfolio instead of nginx's default 404.

The domain's DNS A record must still point at the current home WAN IP. Run
`make status` to compare public DNS with the detected WAN IP and verify the
origin health path.

Recruiting app note: the scraper now requires a copied
`data/storage_state.json` for authenticated 1point3acres access. It uses the
Discuz mobile JSON endpoint plus rendered-page enrichment, with embeddings
enabled so full-post text and replies move into the searchable pipeline after
the full-content rebuild. OCR is currently paused on the Mac Mini because
PaddleOCR plus the BGE-M3 embedder can exceed the pod/node memory budget. If
the session returns `user_banned`
or "用户组: 不准访问", keep scraper replicas at 0 until a permitted
`storage_state.json` is copied into the scraper PVC.

While 1point3acres is blocked, the deployed scraper runs the full public-source
profile: GeeksforGeeks, Code360, Stack Exchange, DEV, Nowcoder, Hacker News,
and Reddit. The in-cluster scraper and both optional PC workers use a
30-minute crawl interval, 10 configured in-flight requests, 0.5-1.25 seconds
between request starts, deeper per-source page limits, and expanded
company-specific interview queries. Keep the in-cluster scraper at 1 replica
because each pod runs the full scheduler.

Recruiting PostgreSQL runs on the `postgres-postgres-pgdata` Synology NFS PVC.
It uses readiness and startup probes, but no liveness probe, because killing a
stateful Postgres pod during NFS recovery or a restore can extend an outage.
The pod has a 1 GiB memory limit for pgvector-backed recruiting queries.

Local Agent runs on Synology-backed PVCs for its app data and shared auth. Its
backend readiness probe stays dependency-aware at `/api/health/ready`, with a
longer timeout because those checks can touch NFS-backed paths. Its liveness
probe is intentionally a TCP socket check with a longer failure window so short
NFS or application stalls do not restart an otherwise recoverable control-plane
backend. The backend uses a `Recreate` rollout because the Mac Mini worker does
not have enough spare requested memory to run a second backend pod during a
rolling update.

Model Trading Bot also has a PVC-backed backend on the Mac Mini worker. Keep it
on a `Recreate` rollout, dependency-aware `/health` readiness, and TCP liveness
so brief NFS or data-provider stalls do not cause liveness restarts while the
frontend remains available through `modeltradingbot.lan`.

Projects LAN apps share one server-side SSO contract through the platform-owned
`shared-auth-nfs` PVC mounted at `/shared-auth`. `make deploy` applies
`platform/shared-auth-pvc.yaml` before Helm upgrades apps, then participating
server-side backends mount `/shared-auth/auth.db` through `existingClaim` and
read/write the HttpOnly `projects_lan_session` cookie against shared `users` and
`auth_sessions` rows. The reliable browser surface is `projects.lan/<app>` path
proxying with a host-scoped cookie; the home launchpad should link users to
those routes by default. Direct `.lan` hostnames remain useful diagnostics, but
do not assume a browser will accept a cookie for the pseudo-domain `.lan`.
Model railroad is intentionally not a shared-SSO participant; its browser route
is a direct command surface for DCC-EX.

## Day-1 setup, end to end

1. **Enable Kubernetes in Docker Desktop** —
   see [`platform/docker-desktop/enable-k8s.md`](platform/docker-desktop/enable-k8s.md).

2. **Wire CI in each app repo first** — `make deploy` pulls images from
   GHCR, so they have to exist. Drop the workflow from
   [`ci/templates/install.md`](ci/templates/install.md) into each app repo,
   customize the matrix, and push. The first push builds and publishes
   the images.

3. **Bootstrap the platform.** `make bootstrap` installs ingress-nginx,
   cert-manager (dormant), and Keel. If your GHCR packages are public, no
   credentials needed. For private images, run
   `./platform/components/ghcr-secret.sh` afterward (asks for a PAT with
   `read:packages` scope) and uncomment `imagePullSecrets` in your app's
   `values.yaml`.

4. **Configure each app.** Add a directory under `apps/<name>/` with a
   `values.yaml` modeled on
   [`apps/local-llm/values.yaml`](apps/local-llm/values.yaml).

5. **Deploy.** `make deploy` runs `helm upgrade --install` for every app.
   `make status` prints the ingress hostnames and the Mac's LAN IP.

6. **Make hostnames resolve.** Pi-hole serves the LAN DNS records for app
   hostnames like `recruitingapp.lan` and `modeltradingbot.lan`. Visit
   `http://<host>` with no port number; ingress-nginx owns the normal web
   ports `80/443`.

For `home-website`, keep browser-facing app links on the `.lan` names but set
server-side proxy and health URLs to Kubernetes service DNS in
`apps/home-website/values.yaml`. Pods cannot rely on Pi-hole-only hostnames.
The public recruiting demo proxy points at the internal
`recruiting-app-frontend-public` service with the `/recruiting-app` upstream
path so the base-path-aware Next.js build receives the route it expects.

In `charts/app`, use `selectorLabels` only when adopting a full legacy
selector. Use `extraSelectorLabels` when a service needs the standard
app/instance/component selector plus one more stable label, such as the
recruiting app's optional PC scraper switches.

## Repo layout

```
platform/
  bootstrap.sh             entry point — detects context, installs components
  docker-desktop/          notes for enabling DD's built-in K8s
  k3s/                     Lima VM configs + migration doc (dormant today)
  components/              cluster add-ons applied by bootstrap.sh
    synology-nfs-provisioner/  Helm values for Synology-backed PVCs
charts/app/                generic reusable Helm chart for an "app"
apps/<name>/values.yaml    per-app config consumed by charts/app
.github/workflows/         in-repo image builds, including k8s-management-ui
ci/templates/              drop-in GitHub Actions workflow for app repos
scripts/                   deploy / status / switch-cluster
```

## Pi-hole on the Raspberry Pi

Pi-hole runs as a K8s Deployment on the always-on Raspberry Pi with a
`LoadBalancer` service that holds port 53 (TCP + UDP) for DNS and is restricted
to the LAN CIDR in Helm values. Its web UI is a separate ClusterIP service
routed through LAN-scoped ingress at `http://pihole.lan/`. Config is mounted
from Pi host paths under `/srv/pihole`.

**One-time setup (run once before first deploy):**

```sh
kubectl create secret generic pihole-secret \
  --from-literal=webpassword='<your-password>'

ssh chrischang@192.168.4.56 'sudo mkdir -p /srv/pihole/etc-pihole /srv/pihole/etc-dnsmasq.d && sudo chown -R 1000:1000 /srv/pihole'
rsync -av /Users/chrischang/Projects/pihole/etc-pihole/ chrischang@192.168.4.56:/srv/pihole/etc-pihole/
rsync -av /Users/chrischang/Projects/pihole/etc-dnsmasq.d/ chrischang@192.168.4.56:/srv/pihole/etc-dnsmasq.d/
```

**Deploy:**

```sh
kubectl config use-context rpi5-k3s
helm upgrade --install pihole charts/app -f apps/pihole/values.yaml \
  --namespace default --create-namespace --wait
dig @192.168.4.56 google.com
```

After verification, point the router's DNS/DHCP settings at `192.168.4.56`.
Do not expose the Pi-hole web service directly; keep admin access through
`pihole.lan`.

**Notes:**

- Keel polls `pihole/pihole:latest` daily and recreates the pod when the digest
  changes.
- Pi-hole custom DNS records map the project hostnames to the cluster ingress
  address, so app URLs do not need port numbers.
- Keep `localagent.lan` and `homeassistant.lan` in `dns.hosts` whenever those
  apps are enabled on the launchpad.
- Pi-hole keeps rate limiting enabled, but `apps/pihole/values.yaml` raises the
  per-client limit to `10000` queries per `60` seconds because K3s
  ServiceLB/NAT can collapse many clients behind one pod-facing address.
- Home Assistant browser access is ingress-only; the pod no longer uses
  `hostNetwork`, so `192.168.4.56:8123` should not be reachable.
- DHCP (port 67) is not exposed in K8s by default. If you use Pi-hole for DHCP,
  add `- name: dhcp / port: 67 / protocol: UDP` to `extraPorts`.

## Cloudflare Tunnel And Access

`apps/cloudflared/values.yaml` is a dormant Tunnel connector scaffold. It stays
at `replicas: 0` until the Cloudflare tunnel token and Access policies are ready.
Create the token secret, configure the public hostname in Cloudflare to route to
`http://home-website-public.default.svc.cluster.local`, then scale the connector:

```sh
kubectl create secret generic cloudflared-tunnel \
  --from-literal=token='<cloudflare-tunnel-token>'
kubectl create secret generic cloudflare-access-home-website-public \
  --from-literal=aud='<cloudflare-access-application-aud>' \
  --from-literal=team-domain='<team>.cloudflareaccess.com'
```

After the Access application is live, set
`CLOUDFLARE_ACCESS_REQUIRED=true` in
`apps/home-website-public/values.yaml` and scale `cloudflared` to `1`.
The public app proxy validates `Cf-Access-Jwt-Assertion` at the origin before
forwarding sensitive app routes. Model railroad is excluded from origin-side
Access validation so `/railroad-automation/` can pass browser DCC-EX command
requests directly to the railroad service.

## Homebridge on the Raspberry Pi

Homebridge runs on the Raspberry Pi host network for HomeKit/mDNS reliability.
Its seed config lives in the private `chrischang314/homebridge` repo and is
copied to `/srv/homebridge` before the first deploy.

```sh
kubectl config use-context rpi5-k3s
helm upgrade --install homebridge charts/app -f apps/homebridge/values.yaml \
  --namespace default --create-namespace --wait
```

Homebridge UI is available at `http://homebridge.lan`. Keel polls
`homebridge/homebridge:latest` daily and recreates the pod when the digest
changes.

## Synology storage path

The Synology NAS is reachable at `192.168.4.33` / `Synology.local` and SSH
works with an administrator DSM account. A direct K3s worker install was tested
on DSM 7.3.2 / x86_64 and cleaned up afterward. The agent can install, contact
the control plane, and start containerd, but kubelet exits because the DSM
kernel does not expose the `pids` cgroup controller. Kubelet PID-limit
workarounds did not bypass K3s's preflight check.

Do not move database or PVC-backed workloads to the NAS as a direct worker
unless Synology provides a kernel with `CONFIG_CGROUP_PIDS`, or unless a Linux
VM is created on the NAS and joined as the worker instead. The safer near-term
storage path is to export NAS storage over NFS and use an NFS-backed
StorageClass while the pods continue to run on Kubernetes-capable nodes.

That safer path is installed. DSM exports `192.168.4.33:/volume1/k8s` over
NFS, and the cluster has a `synology-nfs` StorageClass from
[`platform/components/synology-nfs-provisioner/values.yaml`](platform/components/synology-nfs-provisioner/values.yaml).
`synology-nfs` is the cluster default and primary backend storage tier.
Use `storageClassName: local-path` explicitly only for Mac-mini degraded-mode
caches.
QuestDB is the current exception: it exits when its database root is on NFS, so
its data PVC stays on `local-path`.
The fallback model is documented in
[`docs/storage-fallback.md`](docs/storage-fallback.md).

The provisioner pod is pinned to `rpi5-control`. NFS mounts have been smoke
tested from `mac-mini-worker` and `railroad-pi3`, so future PVC-backed pods can
mount Synology storage from any current Kubernetes node.

Public/demo workloads should keep enough small local cache on the Mac-mini to
start when the NAS is unavailable. Large source-of-truth data can stay on
Synology, but it should not be on the critical startup path for
`chriswchang.com` or its demo links.

## Auto-deploy flow

1. Push to `main` in an app repo → GitHub Actions runs tests, builds a
   `linux/arm64` image, pushes to `ghcr.io/<owner>/<repo>[/<service>]:main` and
   `:sha-<short>`.
2. [Keel](https://keel.sh) polls GHCR every 5 minutes. When `:main`'s digest
   changes, Keel triggers a rolling update of the matching Deployment.
3. Stateful pods retain their PVCs across the rollout.

Local Agent and Model Trading Bot are exceptions to the default rolling-update
strategy: their backends are singleton PVC-backed services pinned to
`mac-mini-worker`, so their app values use `strategy.type: Recreate` to prevent
a second backend pod from being scheduled during a surge or mounting the same
data claim.

The in-repo `k8s-management-ui` workflow builds and pushes
`ghcr.io/chrischang314/container-orchestrator/k8s-management-ui:main` from this
repository before Keel rolls the UI in-cluster. The same image also powers the
internal `k8s-cluster-status` read-only service used by the public portfolio's
`/cluster-status/` proxy.

`k8s.lan` includes a read-only capacity panel backed by the Kubernetes Metrics
API. `/api/cluster` reports node CPU/memory pressure and top memory-consuming
pods when `metrics.k8s.io` is available, and keeps the rest of the cluster
snapshot online with a clear unavailable state if Metrics API access fails. The
public status deployment keeps detailed pod names out of its sanitized payload
and treats `replicas: 0` deployments as inactive rather than unhealthy.
It also includes read-only storage readiness data for PVCs, PVs, and
StorageClasses when those Kubernetes API reads are allowed. The LAN dashboard
shows PVC risk details, while the public status deployment exposes only
aggregate storage counts.

For faster public deploys, the polling can be replaced by a webhook from
Actions.

The LAN `k8s-management-ui` requires an explicit confirmation step for
mutating cluster actions and typed mutating `kubectl` commands. The backend
also rejects unconfirmed mutations, so the dialog is an operator-safety layer on
top of server-side enforcement.

The same UI also exposes a read-only capacity panel from the Kubernetes Metrics
API. `GET /api/cluster` includes node CPU and memory pressure plus top memory
pods when `metrics.k8s.io` is available, and falls back to
`capacity.available=false` without breaking the rest of the snapshot when
metrics are unavailable. The public `k8s-cluster-status` deployment receives
only sanitized node-pressure aggregates, not detailed pod names.
