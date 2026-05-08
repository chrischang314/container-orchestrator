# Enable Kubernetes in Docker Desktop

One-time, GUI-only step. Once enabled, `kubectl` immediately picks it up via
the `docker-desktop` context.

1. Open **Docker Desktop** → **Settings** (gear icon).
2. Sidebar → **Kubernetes**.
3. Tick **Enable Kubernetes**. Leave **Show system containers** off.
4. Click **Apply & Restart**. First start downloads images and takes a few
   minutes — wait for the green "Kubernetes is running" indicator.
5. Verify in a terminal:

   ```sh
   kubectl config current-context   # → docker-desktop
   kubectl get nodes                # → 1 node, Ready
   ```

If `kubectl config get-contexts` shows multiple entries (e.g. you've used
minikube or kind before), set the active one:

```sh
kubectl config use-context docker-desktop
```

## Resource budget

Docker Desktop's default VM gets 2 CPU / 8 GB RAM, which is enough for the
ingress + cert-manager + Keel platform components plus a small app. If you
plan to run something memory-heavy (large LLMs in-cluster, multiple stateful
services), bump the VM allocation in **Settings → Resources** — the Mac Mini
will share the rest with macOS and Ollama-on-host.

## When you're done

`./platform/bootstrap.sh` (or `make bootstrap` from the repo root) installs
the platform on top.
