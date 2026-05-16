# container-orchestrator

Self-hosted Kubernetes platform for running containerized GitHub apps on a Mac
Mini, with automatic image-driven deployments from GHCR.

## Goals

- One Mac Mini today; cluster grows by adding more Mac Minis later, without
  rebuilding anything.
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
| **Docker Desktop K8s** | active | Single Mac Mini, simplest setup |
| **k3s in Lima** | scaffolded, dormant | Once you add a second Mac Mini |

The platform components (ingress-nginx, cert-manager, Keel) and all app
manifests are deliberately distro-agnostic — PVCs use the cluster's default
StorageClass, ingress is a controller we install ourselves, no LoadBalancer
services. See [`platform/k3s/MIGRATION.md`](platform/k3s/MIGRATION.md) for the
switch-over procedure.

## Quick start

```sh
make bootstrap     # one-time: install platform components on the active context
make deploy        # apply every app under apps/
make status        # show cluster + apps + ingress URLs
```

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

6. **Make hostnames resolve.** Add ingress hosts to `/etc/hosts` on the
   Mac (`127.0.0.1`) and on any LAN device that should reach the apps
   (the Mac's LAN IP). Visit `http://<host>:8080` — the ingress is on
   `8080/8443` by default to avoid port conflicts with other common Mac
   services like Pi-hole; change in
   [`platform/components/ingress-nginx/values.yaml`](platform/components/ingress-nginx/values.yaml)
   to use the conventional `80/443`.

## Repo layout

```
platform/
  bootstrap.sh             entry point — detects context, installs components
  docker-desktop/          notes for enabling DD's built-in K8s
  k3s/                     Lima VM configs + migration doc (dormant today)
  components/              cluster add-ons applied by bootstrap.sh
charts/app/                generic reusable Helm chart for an "app"
apps/<name>/values.yaml    per-app config consumed by charts/app
ci/templates/              drop-in GitHub Actions workflow for app repos
scripts/                   deploy / status / switch-cluster
```

## Pi-hole on the Raspberry Pi

Pi-hole runs as a K8s Deployment on the always-on Raspberry Pi with a
`LoadBalancer` service that holds ports 53 (TCP + UDP) and 80. Its config is
mounted from Pi host paths under `/srv/pihole`.

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
- If you later want a `pihole.lan` hostname in the browser, add an Ingress
  entry (port 80 to service `pihole`); the web UI is already on port 80 via
  the LoadBalancer so it also works at `http://192.168.4.56/admin`.
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

Homebridge UI is available at `http://192.168.4.56:8581`. Keel polls
`homebridge/homebridge:latest` daily and recreates the pod when the digest
changes.

## Auto-deploy flow

1. Push to `main` in an app repo → GitHub Actions runs tests, builds a
   `linux/arm64` image, pushes to `ghcr.io/<owner>/<repo>[/<service>]:main` and
   `:sha-<short>`.
2. [Keel](https://keel.sh) polls GHCR every 5 minutes. When `:main`'s digest
   changes, Keel triggers a rolling update of the matching Deployment.
3. Stateful pods retain their PVCs across the rollout.

When you go public, the polling can be replaced by a webhook from Actions for
near-instant deploys.
