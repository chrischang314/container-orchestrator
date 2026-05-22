"use strict";

const fs = require("node:fs");
const https = require("node:https");

const DEFAULT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const EXTERNAL_WORKER_COMPONENT = "external-worker-switch";

function shouldUseDemoMode(env = process.env) {
  if (env.K8S_UI_DEMO === "true") return true;
  if (env.K8S_UI_DEMO === "false") return false;
  return !env.KUBERNETES_SERVICE_HOST;
}

function readyCondition(node) {
  return (node.status?.conditions || []).find((condition) => condition.type === "Ready");
}

function nodeRole(labels = {}) {
  if (labels["node-role.kubernetes.io/control-plane"] !== undefined || labels["node-role.kubernetes.io/master"] !== undefined) {
    return "control-plane";
  }
  if (labels["node-role.kubernetes.io/worker"] !== undefined) {
    return "worker";
  }
  return "worker";
}

function containerSummary(container, statuses = []) {
  const status = statuses.find((item) => item.name === container.name) || {};
  const stateName = Object.keys(status.state || {})[0] || "waiting";
  return {
    name: container.name,
    image: container.image,
    ready: Boolean(status.ready),
    restarts: Number(status.restartCount || 0),
    state: stateName,
    started: Boolean(status.started)
  };
}

function mapClusterSnapshot(raw, now = new Date()) {
  const podItems = raw.pods?.items || [];
  const deploymentItems = raw.deployments?.items || [];
  const podsByNode = new Map();

  for (const pod of podItems) {
    const nodeName = pod.spec?.nodeName || "unassigned";
    if (!podsByNode.has(nodeName)) podsByNode.set(nodeName, []);
    podsByNode.get(nodeName).push({
      namespace: pod.metadata?.namespace || "default",
      name: pod.metadata?.name || "",
      phase: pod.status?.phase || "Unknown",
      hostIP: pod.status?.hostIP || "",
      podIP: pod.status?.podIP || "",
      restartCount: (pod.status?.containerStatuses || []).reduce((sum, item) => sum + Number(item.restartCount || 0), 0),
      containers: (pod.spec?.containers || []).map((container) =>
        containerSummary(container, pod.status?.containerStatuses || [])
      )
    });
  }

  const nodes = (raw.nodes?.items || []).map((node) => {
    const labels = node.metadata?.labels || {};
    const ready = readyCondition(node);
    const role = nodeRole(labels);
    const pods = podsByNode.get(node.metadata?.name) || [];
    const containers = pods.flatMap((pod) =>
      pod.containers.map((container) => ({
        ...container,
        pod: pod.name,
        namespace: pod.namespace,
        phase: pod.phase
      }))
    );

    return {
      name: node.metadata?.name || "",
      role,
      online: ready?.status === "True",
      readyReason: ready?.reason || "Unknown",
      schedulable: !node.spec?.unschedulable,
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion || "",
      osImage: node.status?.nodeInfo?.osImage || "",
      architecture: node.status?.nodeInfo?.architecture || "",
      capacity: {
        cpu: node.status?.capacity?.cpu || "",
        memory: node.status?.capacity?.memory || ""
      },
      addresses: node.status?.addresses || [],
      pods,
      containers,
      podCount: pods.length,
      containerCount: containers.length
    };
  });

  const deployments = deploymentItems.map((deployment) => ({
    namespace: deployment.metadata?.namespace || "default",
    name: deployment.metadata?.name || "",
    replicas: Number(deployment.spec?.replicas || 0),
    readyReplicas: Number(deployment.status?.readyReplicas || 0),
    updatedReplicas: Number(deployment.status?.updatedReplicas || 0),
    availableReplicas: Number(deployment.status?.availableReplicas || 0)
  }));

  const externalWorkers = deploymentItems
    .filter((deployment) =>
      deployment.metadata?.labels?.["app.kubernetes.io/component"] === EXTERNAL_WORKER_COMPONENT
    )
    .map((deployment) => {
      const metadata = deployment.metadata || {};
      const labels = metadata.labels || {};
      const annotations = metadata.annotations || {};
      const replicas = Number(deployment.spec?.replicas || 0);
      const readyReplicas = Number(deployment.status?.readyReplicas || 0);
      const desiredState = annotations["local-llm.io/desired-state"] || (replicas > 0 ? "on" : "off");
      const actualState = annotations["local-llm.io/actual-state"] || "unknown";

      return {
        name: labels["local-llm.io/worker"] || metadata.name || "",
        namespace: metadata.namespace || "default",
        deployment: metadata.name || "",
        desiredReplicas: replicas,
        readyReplicas,
        availableReplicas: Number(deployment.status?.availableReplicas || 0),
        desiredState,
        actualState,
        optional: labels["local-llm.io/optional"] === "true",
        online: replicas > 0 && readyReplicas > 0 && actualState !== "off",
        lastObservedAt: annotations["local-llm.io/last-observed-at"] || "",
        controlHelp: annotations["local-llm.io/control-help"] || "",
        controlledBy: annotations["local-llm.io/controlled-by"] || ""
      };
    });

  const containers = nodes.flatMap((node) =>
    node.containers.map((container) => ({
      ...container,
      node: node.name
    }))
  );

  return {
    generatedAt: now.toISOString(),
    summary: {
      nodes: nodes.length,
      onlineNodes: nodes.filter((node) => node.online).length,
      controlPlaneNodes: nodes.filter((node) => node.role === "control-plane").length,
      workerNodes: nodes.filter((node) => node.role !== "control-plane").length,
      externalWorkers: externalWorkers.length,
      externalWorkersOnline: externalWorkers.filter((worker) => worker.online).length,
      pods: podItems.length,
      containers: containers.length,
      deployments: deployments.length
    },
    nodes,
    externalWorkers,
    deployments,
    containers
  };
}

function createKubernetesClient(options = {}) {
  const env = options.env || process.env;
  const demoMode = options.demoMode ?? shouldUseDemoMode(env);

  if (demoMode) {
    return {
      mode: "demo",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date());
      }
    };
  }

  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT || "443";
  const tokenPath = options.tokenPath || env.K8S_SERVICE_ACCOUNT_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const caPath = options.caPath || env.K8S_SERVICE_ACCOUNT_CA_PATH || DEFAULT_CA_PATH;
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const ca = fs.readFileSync(caPath);
  const baseUrl = options.baseUrl || `https://${host}:${port}`;
  const requestImpl = options.requestImpl || ((path) => httpsJson(`${baseUrl}${path}`, token, ca));

  async function request(path) {
    return requestImpl(path);
  }

  return {
    mode: "cluster",
    async snapshot() {
      const [nodes, pods, deployments] = await Promise.all([
        request("/api/v1/nodes"),
        request("/api/v1/pods"),
        request("/apis/apps/v1/deployments")
      ]);
      return mapClusterSnapshot({ nodes, pods, deployments }, new Date());
    }
  };
}

function httpsJson(url, token, ca) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), {
      ca,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      method: "GET"
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Kubernetes API ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Kubernetes API returned invalid JSON: ${error.message}`));
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error("Kubernetes API request timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

function demoRawCluster() {
  return {
    nodes: {
      items: [
        {
          metadata: {
            name: "rpi5-control",
            labels: {
              "node-role.kubernetes.io/control-plane": ""
            }
          },
          spec: {},
          status: {
            capacity: { cpu: "4", memory: "7864320Ki" },
            addresses: [{ type: "InternalIP", address: "192.168.4.56" }],
            conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
            nodeInfo: { kubeletVersion: "v1.34.1+k3s1", osImage: "Debian GNU/Linux 12", architecture: "arm64" }
          }
        },
        {
          metadata: {
            name: "mac-mini-worker",
            labels: {
              "node-role.kubernetes.io/worker": ""
            }
          },
          spec: { unschedulable: false },
          status: {
            capacity: { cpu: "10", memory: "16777216Ki" },
            addresses: [{ type: "InternalIP", address: "192.168.4.24" }],
            conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
            nodeInfo: { kubeletVersion: "v1.34.1+k3s1", osImage: "Ubuntu 24.04 LTS", architecture: "arm64" }
          }
        }
      ]
    },
    pods: {
      items: [
        pod("default", "pihole-6f9fb77c8d-n2z7x", "rpi5-control", "Running", [
          ["pihole", "pihole/pihole:latest", true, 0, "running"]
        ]),
        pod("default", "homebridge-5847b7d9b5-tfm2m", "rpi5-control", "Running", [
          ["homebridge", "homebridge/homebridge:latest", true, 1, "running"]
        ]),
        pod("default", "k8s-management-ui-web-6447596f7c-nx7qk", "mac-mini-worker", "Running", [
          ["web", "ghcr.io/chrischang314/container-orchestrator/k8s-management-ui:main", true, 0, "running"]
        ]),
        pod("default", "local-llm-frontend-75dd47d6b8-bnlq8", "mac-mini-worker", "Running", [
          ["frontend", "ghcr.io/chrischang314/local-llm/frontend:main", true, 0, "running"]
        ]),
        pod("default", "model-trading-bot-backend-8b9775d9bc-r5p7d", "mac-mini-worker", "Running", [
          ["backend", "ghcr.io/chrischang314/model-trading-bot/backend:main", true, 0, "running"]
        ])
      ]
    },
    deployments: {
      items: [
        deployment("default", "k8s-management-ui-web", 1, 1),
        deployment("default", "pihole-pihole", 1, 1),
        deployment("default", "homebridge-homebridge", 1, 1),
        deployment("default", "local-llm-frontend", 1, 1),
        deployment("default", "model-trading-bot-backend", 1, 1),
        externalWorkerDeployment("local-llm", "chris-pc-2-ollama-switch", "chris-pc-2", 1, 1)
      ]
    }
  };
}

function pod(namespace, name, nodeName, phase, containers) {
  return {
    metadata: { namespace, name },
    spec: {
      nodeName,
      containers: containers.map(([containerName, image]) => ({ name: containerName, image }))
    },
    status: {
      phase,
      podIP: "10.42.0.12",
      hostIP: "192.168.4.24",
      containerStatuses: containers.map(([containerName, image, ready, restartCount, state]) => ({
        name: containerName,
        image,
        ready,
        restartCount,
        started: ready,
        state: { [state]: {} }
      }))
    }
  };
}

function deployment(namespace, name, replicas, readyReplicas) {
  return {
    metadata: { namespace, name },
    spec: { replicas },
    status: {
      readyReplicas,
      updatedReplicas: readyReplicas,
      availableReplicas: readyReplicas
    }
  };
}

function externalWorkerDeployment(namespace, name, worker, replicas, readyReplicas) {
  const state = replicas > 0 ? "on" : "off";
  return {
    metadata: {
      namespace,
      name,
      labels: {
        "app.kubernetes.io/component": EXTERNAL_WORKER_COMPONENT,
        "local-llm.io/worker": worker,
        "local-llm.io/optional": "true"
      },
      annotations: {
        "local-llm.io/desired-state": state,
        "local-llm.io/actual-state": readyReplicas > 0 ? "on" : state,
        "local-llm.io/last-observed-at": "2026-05-17T12:00:00.000Z",
        "local-llm.io/control-help": "Scale replicas to 1 to enable, or 0 to disable."
      }
    },
    spec: { replicas },
    status: {
      readyReplicas,
      updatedReplicas: readyReplicas,
      availableReplicas: readyReplicas
    }
  };
}

module.exports = {
  createKubernetesClient,
  demoRawCluster,
  httpsJson,
  mapClusterSnapshot,
  shouldUseDemoMode
};
