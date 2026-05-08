# Migrating from Docker Desktop K8s to k3s-in-Lima

When you add a second Mac Mini, this is the path to a real multi-node
cluster. The platform components, Helm chart, and app values do not change —
only the underlying cluster does.

## When to migrate

You're on Docker Desktop K8s today because it's the simplest single-node
option. You should migrate when:

- You add a second Mac Mini and want it to join the same cluster, OR
- You want to expose ingress on a LAN IP that's stable across Docker
  Desktop restarts, OR
- You want to run the cluster headless (Docker Desktop requires the GUI app
  to stay open).

## Pre-flight (one-time, on the server Mac)

```sh
brew install lima socket_vmnet

# socket_vmnet needs a sudoers rule so Lima can start the vmnet daemon
# without prompting for a password every boot
limactl sudoers >/tmp/lima.sudoers
sudo install -m 0440 /tmp/lima.sudoers /etc/sudoers.d/lima
```

Then enable LAN-routable networking by uncommenting the `networks:` block
in [`lima-server.yaml`](lima-server.yaml).

## 1. Bring up the k3s server VM

On Mac Mini #1:

```sh
make k3s-up                # ./platform/k3s/up.sh
```

This:
- Creates a Lima VM running Ubuntu 24.04 (arm64) via Apple Virtualization.
- Installs k3s as a server (Traefik disabled — we use ingress-nginx).
- Pulls the kubeconfig back to your Mac and merges it into
  `~/.kube/config` under the context name `lima-k3s-server`.

Verify:

```sh
kubectl --context lima-k3s-server get nodes
```

## 2. Reinstall platform components on k3s

```sh
kubectl config use-context lima-k3s-server
make bootstrap
```

Same script as Docker Desktop — installs ingress-nginx, cert-manager (CRDs),
Keel, and creates the GHCR pull secret.

## 3. Adjust app values for the new "host"

In Docker Desktop, pods reach the Mac host via `host.docker.internal`. In
Lima, the equivalent is `host.lima.internal`. For any app that talks to a
host-running service (e.g. Ollama):

```yaml
# apps/local-llm/values.yaml
- name: OLLAMA_URL
  value: http://host.lima.internal:11434     # was host.docker.internal
```

Or use the Mac's LAN IP directly to make it portable:

```yaml
- name: OLLAMA_URL
  value: http://192.168.x.y:11434
```

Then redeploy:

```sh
make deploy
```

## 4. Add a second Mac Mini

On the **server** Mac, capture the join token and the VM's LAN IP:

```sh
TOKEN=$(limactl shell lima-k3s-server sudo cat /var/lib/rancher/k3s/server/node-token)
SERVER_IP=$(limactl shell lima-k3s-server ip -4 -o addr show lima0 | awk '{print $4}' | cut -d/ -f1)
echo "K3S_URL=https://$SERVER_IP:6443"
echo "K3S_TOKEN=$TOKEN"
```

On **Mac Mini #2**, clone this repo, then edit
[`lima-agent.yaml`](lima-agent.yaml): replace
`CHANGE_ME_SERVER_LAN_IP` and `CHANGE_ME_NODE_TOKEN` with the values above.

Bring the agent up:

```sh
./platform/k3s/up.sh --agent
```

The new VM joins the server within ~30s. Verify from the server Mac:

```sh
kubectl --context lima-k3s-server get nodes      # should show 2 nodes Ready
```

Existing Deployments will start scheduling onto the new node automatically.

## Rolling back

The Docker Desktop context is untouched throughout this process. To return:

```sh
kubectl config use-context docker-desktop       # or: ./scripts/switch-cluster.sh
```

Your data on Docker Desktop persists (PVCs were never moved). To free
resources, you can stop the Lima VM with `limactl stop lima-k3s-server` —
all data inside the VM persists across stop/start.
