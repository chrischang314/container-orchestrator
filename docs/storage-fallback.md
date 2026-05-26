# Storage Fallback Architecture

The cluster uses two storage tiers:

| Tier | StorageClass | Role |
|---|---|---|
| Mac-mini cache | `local-path` | Default for public/demo workloads and small rebuildable caches. Pods must be pinned to the node that owns the data. |
| Synology primary | `synology-nfs` | Explicit opt-in for large or shared NAS-backed data. Existing PVs retain data when PVCs are removed. |

The default StorageClass is intentionally `local-path`. That keeps new public
or demo PVCs off the NAS unless a workload explicitly asks for
`storageClassName: synology-nfs`.

Use `synology-nfs` only for data that needs NAS capacity or cross-node RWX
semantics. Use Mac-mini `local-path` for enough cached state to keep the public
portfolio and demos looking functional while the NAS is down.

## Degraded Mode Rules

1. Public ingress targets must not require a Synology mount to start.
2. Public/demo pods using `local-path` must have a stable `nodeSelector` for
   `kubernetes.io/hostname: mac-mini-worker`.
3. Large source-of-truth data can stay on Synology, but the public surface should
   be able to bootstrap or serve a small local cache.
4. Do not move a bound `local-path` PVC by only changing `nodeSelector`; create a
   new PVC or perform an explicit backup/restore.

## Current Public Cache Decisions

| Workload | Public path | Fallback storage |
|---|---|---|
| `home-website-public` | `chriswchang.com` | Stateless image; no PVC. |
| `model-trading-bot` | `/model-trading-bot/` | Mac-mini `local-path` backend cache. |
| `trading-bot` | `/trading-bot/` | `trading-bot-public-cache` Mac-mini `local-path` PVC, reconciled back to the NAS by `trading-bot-cache-sync`. |
| `local-llm` Helm app | `/local-llm/` | Mac-mini `local-path` app data plus Mac host Ollama. |
| `k8s-cluster-status` | `/cluster-status/` | Stateless read-only service. |

Synology-backed PVCs still exist for source-of-truth or high-capacity data:

- `trading-bot/trading-bot-parquet`
- `trading-bot/redis-data-redis-0`
- `local-llm/local-llm-chat-data`
- `local-llm/ollama-model-cache`

These should not be on the critical path for public demo startup.

## Cache Reconciliation

Mac-mini caches are partial replicas. Sync jobs must copy cache data back to the
NAS without treating the cache as a complete mirror:

1. Never use delete/prune behavior from cache to NAS.
2. Copy only files that are new or newer in the cache.
3. Skip recently modified files and let the next run pick them up.
4. Keep the sync job pinned to the node that owns the `local-path` PVC.

The `trading-bot` overlay includes `trading-bot-cache-sync`, a CronJob that
mounts both `trading-bot-public-cache` and `trading-bot-parquet`. If the NAS is
down, its pod cannot mount the NAS PVC and the job fails or times out. The next
scheduled run retries automatically; when the NAS mount succeeds, new stable
files from the Mac-mini cache are copied back to Synology.
