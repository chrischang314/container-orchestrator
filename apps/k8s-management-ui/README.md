# K8s Management UI

Small LAN-only control panel for the container-orchestrator Kubernetes cluster.

## Local development

```sh
node apps/k8s-management-ui/src/server.js
```

Outside Kubernetes the server uses demo cluster data unless `K8S_UI_DEMO=false`
and in-cluster service-account environment variables are present.

## Runtime controls

- `GET /api/cluster` reads nodes, pods, containers, deployments, and read-only
  Metrics API capacity data through the Kubernetes API. If Metrics API access
  is unavailable, the cluster snapshot still returns with `capacity.available`
  set to `false`.
- `POST /api/action` runs built-in node and deployment controls through a
  validated `kubectl` invocation. Mutating actions require a UI confirmation
  and a backend `confirmed: true` receipt before execution.
- `POST /api/command` accepts allowlisted `kubectl` commands. Shell operators,
  kubeconfig overrides, token overrides, and arbitrary verbs are rejected before
  execution. Typed mutating commands such as `cordon`, `uncordon`, `scale`, and
  `rollout restart` require confirmation before the backend runs them.
- Mutating results render a receipt with the exact command, mutating/read-only
  classification, exit code, stdout, and stderr.

## Public status mode

Set `K8S_UI_PUBLIC_STATUS=true` for the status-only public deployment. In this
mode the root page serves a read-only dashboard, `GET /api/cluster` returns a
sanitized aggregate snapshot, and command/action endpoints return `403`.
Capacity data in public status mode is limited to node-level pressure
aggregates and does not include top pod names.
