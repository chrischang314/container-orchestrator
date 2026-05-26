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
| `http://localllm.lan/` | Local LLM chat frontend | Mac Mini worker |
| `http://modelrailroadautomation.lan/` | Railroad control web server | Railroad Pi worker |
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
Discuz mobile JSON endpoint plus rendered-page enrichment, with embeddings and
OCR enabled so full-post text, replies, images, and OCR move into the searchable
pipeline after the full-content rebuild. If the session returns `user_banned`
or "用户组: 不准访问", keep scraper replicas at 0 until a permitted
`storage_state.json` is copied into the scraper PVC.

While 1point3acres is blocked, the deployed scraper runs Hacker News + Reddit
only with a faster public-source profile: 6 configured in-flight requests,
1-2 seconds between request starts, 100 Hacker News results per query, 50
Reddit results per query, and a 1-hour crawl interval. Keep replicas at 1
because each pod runs the full scheduler.

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
`LoadBalancer` service that holds port 53 (TCP + UDP) for DNS. Its web UI is
routed through ingress at `http://pihole.lan/`. Config is mounted from Pi host
paths under `/srv/pihole`.

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

**Notes:**

- Keel polls `pihole/pihole:latest` daily and recreates the pod when the digest
  changes.
- Pi-hole custom DNS records map the project hostnames to the cluster ingress
  address, so app URLs do not need port numbers.
- DHCP (port 67) is not exposed in K8s by default. If you use Pi-hole for DHCP,
  add `- name: dhcp / port: 67 / protocol: UDP` to `extraPorts`.

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

The in-repo `k8s-management-ui` workflow builds and pushes
`ghcr.io/chrischang314/container-orchestrator/k8s-management-ui:main` from this
repository before Keel rolls the UI in-cluster. The same image also powers the
internal `k8s-cluster-status` read-only service used by the public portfolio's
`/cluster-status/` proxy.

For faster public deploys, the polling can be replaced by a webhook from
Actions.

The LAN `k8s-management-ui` requires an explicit confirmation step for
mutating cluster actions and typed mutating `kubectl` commands. The backend
also rejects unconfirmed mutations, so the dialog is an operator-safety layer on
top of server-side enforcement.
