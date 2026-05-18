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
