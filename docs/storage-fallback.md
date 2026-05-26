# Storage Fallback Architecture

The cluster uses two storage tiers:

| Tier | StorageClass | Role |
|---|---|---|
| Synology primary | `synology-nfs` | Default backend storage for persistent app data. Existing PVs retain data when PVCs are removed. |
| Mac-mini cache | `local-path` | Explicit fallback/cache tier for public degraded mode. Pods must be pinned to the node that owns the data. |

The default StorageClass is intentionally `synology-nfs`. That keeps backend
storage on the NAS when it is healthy. Workloads that need degraded-mode
Mac-mini cache must explicitly ask for `storageClassName: local-path`.

Use `synology-nfs` for normal backend storage. Use Mac-mini `local-path` only
for enough cached state to keep the public portfolio and demos looking
functional while the NAS is down, or for software that cannot safely run on NFS.

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
| `model-trading-bot` | `/model-trading-bot/` | Primary backend data is on `synology-nfs`; old local PVC is retained only as rollback data. |
| `trading-bot` | `/trading-bot/` | Primary parquet data is on `synology-nfs`; `trading-bot-public-cache` remains as the Mac-mini degraded-mode cache and is reconciled by `trading-bot-cache-sync`. |
| `local-llm` Helm app | `/local-llm/` | Primary app data is on `synology-nfs` plus Mac host Ollama. |
| `k8s-cluster-status` | `/cluster-status/` | Stateless read-only service. |

Synology-backed PVCs still exist for source-of-truth or high-capacity data:

- `trading-bot/trading-bot-parquet`
- `trading-bot/redis-data-redis-0`
- `default/postgres-postgres-pgdata-nfs`
- `default/model-trading-bot-backend-data-nfs`
- `default/local-llm-backend-data-nfs`
- `default/recruiting-app-*-nfs`
- `local-llm/local-llm-chat-data`
- `local-llm/ollama-model-cache`

These should not be on the critical path for public demo startup.

`trading-bot/questdb-data-questdb-0` is an intentional `local-path` exception.
QuestDB 8.1.1 detects NFS for its database root and exits because NFS is not a
supported filesystem for QuestDB data files.

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
