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
  Kubernetes API.
- `POST /api/action` runs built-in node and deployment controls through a
  validated `kubectl` invocation.
- `POST /api/command` accepts allowlisted `kubectl` commands. Shell operators,
  kubeconfig overrides, token overrides, and arbitrary verbs are rejected before
  execution.
- Mutating actions and typed mutating commands require confirmation before the
  browser sends the request. The server also rejects mutating requests unless
  the JSON body includes `confirmed: true`; read-only commands remain one-click.
- Command output includes a receipt line with the run time, read-only/mutating
  classification, command, stdout, stderr, and status.

## Public status mode

Set `K8S_UI_PUBLIC_STATUS=true` for the status-only public deployment. In this
mode the root page serves a read-only dashboard, `GET /api/cluster` returns a
sanitized aggregate snapshot, and command/action endpoints return `403`.
