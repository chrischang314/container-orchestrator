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
- `/api/cluster` includes a derived `attention` summary for operator triage:
  offline or cordoned nodes, offline external workers, unready deployments,
  failed or pending pods, not-ready containers, and high restart counts.
- Mutating built-in actions and typed mutating commands open a confirmation
  dialog before any network request is sent.
- The backend still enforces safety: mutating `/api/action` and `/api/command`
  requests require `confirmed: true`, and unsupported commands, blocked
  credentials flags, shell operators, and arbitrary verbs are rejected.
- Public status mode remains read-only and returns sanitized cluster data plus
  a sanitized attention subset without command or action controls.

## Rollback Notes

If the confirmation UI blocks normal operations, revert the selected
`k8s-management-ui` commit and redeploy the previous image digest. If the UI is
the only problem, preserve the backend allowlist and confirmation checks unless
they are the direct cause of the outage.
