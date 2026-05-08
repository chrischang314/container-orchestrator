# local-llm

Deploys [chrischang314/local-llm](https://github.com/chrischang314/local-llm)
as two K8s services (backend + frontend) on this platform. Ollama is **not**
deployed in-cluster — it runs natively on the Mac host so it gets Apple Metal
GPU acceleration, which is unavailable inside containers.

## One-time host setup (Ollama)

```sh
brew install ollama
brew services start ollama         # launchd; starts on boot
ollama pull llama3.2:3b
ollama pull qwen2.5:14b            # add models as desired
```

Verify reachable from inside the cluster (after `make bootstrap`):

```sh
kubectl run -it --rm curl --image=curlimages/curl --restart=Never -- \
  curl -s http://host.docker.internal:11434/api/tags
```

If you migrate to k3s-in-Lima, change `OLLAMA_URL` in `values.yaml` from
`host.docker.internal` to `host.lima.internal` (or the Mac's LAN IP).

## Access

After `make deploy`, add this to `/etc/hosts` on every device that should
reach the UI:

```
127.0.0.1   local-llm.lan          # on this Mac itself
192.168.x.y local-llm.lan          # on other devices on the LAN (Mac's IP)
```

Then visit <http://local-llm.lan>.

## Auto-deploy

When the upstream `local-llm` repo pushes a new image to
`ghcr.io/chrischang314/local-llm/backend:main` or `.../frontend:main`, Keel
polls every 5 minutes, sees the new digest, and rolls the Deployment.
Persistent chat history (`/app/data`) survives the rollover.

## Persistence

The backend has a 1 Gi PVC mounted at `/app/data` for chat history. Bump
`services[0].persistence[0].size` in `values.yaml` if you fill it up.
