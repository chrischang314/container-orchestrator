# Container Orchestrator Handbook

This repo is the source of truth for the LAN Kubernetes platform and the app
deployments behind `projects.lan`.

## Deployment Model

- App definitions live in `apps/<app>/values.yaml` and are rendered by the
  shared `charts/app` Helm chart.
- The normal deploy path is Helm lint, Helm upgrade, rollout status, then a LAN
  health or browser/API check.
- App images normally come from GHCR with `:main` tags. When an image changes,
  verify the running pod image digest before treating the rollout as current.

## K8s Management UI Safety

`apps/k8s-management-ui` is a LAN-only operations console for cluster state and
allowlisted `kubectl` controls.

- `/api/cluster` includes a read-only `capacity` object when Metrics API access
  is available. It reports node CPU/memory pressure and top memory-consuming
  pods; if `metrics.k8s.io` is unavailable or denied, the API still returns the
  rest of the cluster snapshot with `capacity.available=false`.
- `/api/cluster` includes a read-only `storage` object when PVC access is
  available. It inventories PVCs, joins PV and StorageClass metadata when RBAC
  allows it, infers consuming workloads from pod volume mounts, and labels
  local-path or node-local storage as high risk. Pending, lost, unbound, or
  partially inventoried claims stay visible as attention items instead of
  failing the whole cluster snapshot.
- The public `k8s-cluster-status` deployment may show node-level capacity
  summaries, but it must not expose detailed top-pod names.
- Public status treats deployments scaled to `0` replicas as inactive instead
  of unhealthy, which avoids false attention for dormant worker switches and
  sandbox placeholders.
- The public `k8s-cluster-status` deployment may show aggregate storage counts,
  but it must not expose PVC names, PV names, or workload-specific storage
  details.
- Read-only commands and status actions run directly.
- Mutating built-in actions and typed mutating commands open a confirmation
  dialog before any network request is sent.
- The backend still enforces safety: mutating `/api/action` and `/api/command`
  requests require `confirmed: true`, and unsupported commands, blocked
  credentials flags, shell operators, and arbitrary verbs are rejected.
- Public status mode remains read-only and returns sanitized cluster data.
- Capacity data is read from the Kubernetes Metrics API, not by shelling out to
  `kubectl top`. Metrics failures are non-fatal: the normal cluster snapshot
  still returns, and public status mode receives only node-pressure aggregates
  without detailed pod names.

## Rollback Notes

If the confirmation UI blocks normal operations, revert the selected
`k8s-management-ui` commit and redeploy the previous image digest. If the UI is
the only problem, preserve the backend allowlist and confirmation checks unless
they are the direct cause of the outage.

## Operating Notes

- PostgreSQL is stateful and should stay on the `postgres-postgres-pgdata`
  claim backed by the default `synology-nfs` StorageClass. Keep
  `imagePullPolicy: IfNotPresent` for `pgvector/pgvector:pg16`
  because node-side Docker Hub DNS failures should not prevent a restart when
  the image is already cached. Use readiness and startup probes only; a
  liveness probe can kill Postgres during NFS recovery, restores, or temporary
  pgvector-heavy read pressure and make the outage longer.
- Pi-hole runs behind K3s ServiceLB, where many DNS clients can be seen by FTL
  as the same pod-facing source address. Keep the `dns.rateLimit` override high
  enough for aggregate LAN bursts, and verify with both `pihole status` and
  `Resolve-DnsName <host> -Server 192.168.4.56` before treating the web UI's
  diagnosis banner as an active DNS outage.
- Local Agent starts with backend and frontend only. Leave the worker scaled to
  zero until a `ghcr.io/chrischang314/local-agent/worker:main` image exists and
  execution features are deliberately enabled. Its backend uses dependency-aware
  readiness with an extended timeout and TCP liveness; do not point liveness at
  `/api/health/ready` unless there is a proven restart-safe failure mode.
- Local Agent's backend is a singleton on `mac-mini-worker` and uses
  `strategy.type: Recreate`; a default surge rollout can leave upgrades stuck
  because the node may not fit a second backend pod.
- Local LLM's backend is a PVC-backed singleton using SQLite plus a persisted
  JWT signing key under `/app/data`; keep `strategy.type: Recreate` so Keel
  updates never overlap two pods on the same account/session volume.
- Model Trading Bot's backend is a Synology-NFS-backed singleton. Keep it on
  `rpi5-control` during Mac Mini outages, and keep `strategy.type: Recreate`,
  `/health` readiness, and TCP liveness so transient Synology NFS or provider
  stalls do not cause liveness restart loops.

## Projects LAN Shared SSO

The LAN app suite uses a shared server-side auth contract. Participating
backends mount the platform-owned `shared-auth-nfs` RWX PVC at `/shared-auth`
and set `SHARED_AUTH_DB=/shared-auth/auth.db`. `make deploy` applies
`platform/shared-auth-pvc.yaml` before any Helm app upgrade so a fresh cluster
can create the claim before pods mount it. The database stores app-neutral
`users` and hashed `auth_sessions`; browsers prove identity with the HttpOnly
`projects_lan_session` cookie.

Prefer `projects.lan/<app>` path-proxied routes for human navigation and
first-pass SSO verification, because a host-scoped cookie on `projects.lan` is
reliable. Direct legacy hosts such as `localllm.lan` and `modeltradingbot.lan`
can stay available as diagnostics, but do not assume a broad `.lan` cookie will
work in every browser. A future
`*.projects.lan` subdomain layout can use a parent `.projects.lan` cookie if
DNS and ingress are updated together.

SQLite writes to the shared auth DB should stay low-volume. Keep backend
replicas at one where they write sessions, preserve `Recreate` rollout strategy
for PVC-backed singleton backends, and make app code use busy timeouts/WAL where
available. Never mount `shared-auth-nfs` into public-only frontends, public
internet deployments, or app-specific private secret paths unless there is an
explicit security decision.
