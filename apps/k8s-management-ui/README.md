# K8s Management UI

Small LAN-only control panel for the container-orchestrator Kubernetes cluster.

## Local development

```sh
node apps/k8s-management-ui/src/server.js
```

Outside Kubernetes the server uses demo cluster data unless `K8S_UI_DEMO=false`
and in-cluster service-account environment variables are present.

## Runtime controls

- `GET /api/cluster` reads nodes, pods, containers, and deployments through the
  Kubernetes API. When Metrics API access is available, the same payload also
  includes read-only capacity data: node CPU/memory pressure and the top
  memory-consuming pods.
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
Capacity summaries remain available in public status mode, but detailed top-pod
names are omitted.
