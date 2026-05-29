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
  readiness and TCP liveness; do not point liveness at `/api/health/ready`
  unless there is a proven restart-safe failure mode.
- Local Agent's backend is a singleton on `mac-mini-worker` and uses
  `strategy.type: Recreate`; a default surge rollout can leave upgrades stuck
  because the node may not fit a second backend pod.
