# container-orchestrator

Self-hosted Kubernetes platform for running containerized GitHub apps on a Mac
Mini, with automatic image-driven deployments from GHCR.

For a point-in-time operator handoff with current nodes, URLs, storage, and
migration notes, see [`HANDOFF.md`](HANDOFF.md).

## Goals

- Raspberry Pi 5 control plane for high availability, with the Mac Mini and
  other machines joined as workers without rebuilding app manifests.
- Apps live in their own GitHub repos. CI builds an image, pushes it to GHCR,
  and the cluster picks it up on its next poll — no manual `kubectl apply`.
- Stateful apps survive rolling updates (PVCs).
- LAN-only today; opening to the public is a config flip later (cert-manager
  is pre-installed but dormant).

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
| `http://homewebsite.lan/` | Homelab launchpad and portfolio preview | Mac Mini worker |
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

## Repo layout

```
platform/
  bootstrap.sh             entry point — detects context, installs components
  docker-desktop/          notes for enabling DD's built-in K8s
  k3s/                     Lima VM configs + migration doc (dormant today)
  components/              cluster add-ons applied by bootstrap.sh
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

Current storage-heavy workloads are `postgres-postgres`,
`model-trading-bot-backend`, `local-llm-backend`, and the recruiting app's
scraper/API cache PVCs. PostgreSQL should move by backup/restore, not by simply
changing a node selector, because current PVCs use K3s `local-path` storage.

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

When you go public, the polling can be replaced by a webhook from Actions for
near-instant deploys.
