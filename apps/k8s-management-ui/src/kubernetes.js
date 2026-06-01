"use strict";

const fs = require("node:fs");
const https = require("node:https");

const DEFAULT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const EXTERNAL_WORKER_COMPONENT = "external-worker-switch";
const TOP_PODS_LIMIT = 8;
const MEMORY_ELEVATED_PERCENT = 70;
const MEMORY_HIGH_PERCENT = 85;
const LOCAL_STORAGE_HINTS = ["local-path", "hostpath", "node-local"];
const LOCAL_STORAGE_PROVISIONERS = ["rancher.io/local-path", "kubernetes.io/no-provisioner"];
const NETWORK_STORAGE_HINTS = ["nfs", "synology", "longhorn", "ceph", "cinder", "efs", "azure", "gce", "gluster"];
const MEMORY_FACTORS = new Map([
  ["Ki", 1024],
  ["Mi", 1024 ** 2],
  ["Gi", 1024 ** 3],
  ["Ti", 1024 ** 4],
  ["Pi", 1024 ** 5],
  ["Ei", 1024 ** 6],
  ["K", 1000],
  ["M", 1000 ** 2],
  ["G", 1000 ** 3],
  ["T", 1000 ** 4],
  ["P", 1000 ** 5],
  ["E", 1000 ** 6]
]);

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

function parseCpuMillis(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)(n|u|m)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  switch (match[2]) {
    case "n":
      return amount / 1_000_000;
    case "u":
      return amount / 1_000;
    case "m":
      return amount;
    default:
      return amount * 1000;
  }
}

function parseMemoryBytes(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)([A-Za-z]+)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = match[2] || "";
  if (!suffix) return amount;
  if (suffix === "m") return amount / 1000;
  const factor = MEMORY_FACTORS.get(suffix);
  return factor ? amount * factor : null;
}

function roundMetric(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentUsed(usage, basis) {
  if (!Number.isFinite(usage) || !Number.isFinite(basis) || basis <= 0) return null;
  return roundMetric((usage / basis) * 100, 1);
}

function capacitySeverity(memoryPercent) {
  if (!Number.isFinite(memoryPercent)) return "unknown";
  if (memoryPercent >= MEMORY_HIGH_PERCENT) return "high";
  if (memoryPercent >= MEMORY_ELEVATED_PERCENT) return "elevated";
  return "normal";
}

function formatCpuMillis(value) {
  if (!Number.isFinite(value)) return "";
  if (value >= 1000) return `${roundMetric(value / 1000, 2)} cores`;
  return `${roundMetric(value, 1)}m`;
}

function formatMemoryBytes(value) {
  if (!Number.isFinite(value)) return "";
  const units = [
    ["Ti", 1024 ** 4],
    ["Gi", 1024 ** 3],
    ["Mi", 1024 ** 2],
    ["Ki", 1024]
  ];
  for (const [unit, factor] of units) {
    if (Math.abs(value) >= factor) return `${roundMetric(value / factor, 1)}${unit}`;
  }
  return `${roundMetric(value, 0)}B`;
}

function metricErrors(metricsApi = {}) {
  return (metricsApi.errors || []).filter(Boolean);
}

function unavailableCapacity(metricsApi = {}) {
  const errors = metricErrors(metricsApi);
  return {
    available: false,
    source: "metrics.k8s.io/v1beta1",
    message: errors.length ? "Metrics API unavailable." : "Metrics API returned no node or pod metrics.",
    errors,
    nodes: [],
    topPods: [],
    summary: {
      nodeCount: 0,
      topPodCount: 0,
      elevatedMemoryNodes: 0,
      highMemoryNodes: 0,
      maxMemoryPercent: null
    }
  };
}

function storageErrors(storageApi = {}) {
  return (storageApi.errors || []).filter(Boolean);
}

function unavailableStorage(storageApi = {}) {
  const errors = storageErrors(storageApi);
  return {
    available: false,
    partial: false,
    source: "api/v1 persistentvolumeclaims",
    message: errors.length ? "Storage inventory unavailable." : "No PVC inventory returned by the Kubernetes API.",
    errors,
    claims: [],
    namespaces: [],
    summary: emptyStorageSummary()
  };
}

function emptyStorageSummary() {
  return {
    pvcCount: 0,
    bound: 0,
    pending: 0,
    lost: 0,
    highRisk: 0,
    attention: 0,
    localPath: 0,
    network: 0,
    unknownStorage: 0,
    namespaces: 0,
    storageClasses: 0
  };
}

function mapStorageReadiness(raw, podItems = [], deploymentItems = []) {
  const storageApi = raw.storageApi || {};
  const pvcItems = storageApi.claims?.items || raw.persistentVolumeClaims?.items || [];
  if (!pvcItems.length && storageApi.claimsUnavailable) return unavailableStorage(storageApi);
  if (!pvcItems.length && !storageApi.claims && !raw.persistentVolumeClaims) return unavailableStorage(storageApi);

  const errors = storageErrors(storageApi);
  const pvItems = storageApi.volumes?.items || raw.persistentVolumes?.items || [];
  const storageClassItems = storageApi.classes?.items || raw.storageClasses?.items || [];
  const volumes = new Map(pvItems.map((item) => [item.metadata?.name || "", item]));
  const storageClasses = new Map(storageClassItems.map((item) => [item.metadata?.name || "", item]));
  const consumers = pvcConsumers(podItems, deploymentItems);

  const claims = pvcItems.map((pvc) => {
    const namespace = pvc.metadata?.namespace || "default";
    const name = pvc.metadata?.name || "";
    const status = pvc.status?.phase || "Unknown";
    const storageClass = pvcStorageClassName(pvc);
    const volumeName = pvc.spec?.volumeName || "";
    const volume = volumes.get(volumeName);
    const effectiveStorageClass = storageClass || volume?.spec?.storageClassName || "";
    const classObject = storageClasses.get(effectiveStorageClass);
    const storageType = classifyStorageType(effectiveStorageClass, classObject, volume);
    const risk = storageRisk(pvc, volume, classObject, storageType, {
      volumesAvailable: Boolean(storageApi.volumes || raw.persistentVolumes),
      storageClassesAvailable: Boolean(storageApi.classes || raw.storageClasses)
    });
    const ownerWorkloads = Array.from(consumers.get(`${namespace}/${name}`) || []).sort((left, right) =>
      left.localeCompare(right)
    );

    return {
      namespace,
      name,
      status,
      storageClass: effectiveStorageClass,
      requested: pvc.spec?.resources?.requests?.storage || "",
      accessModes: pvc.spec?.accessModes || [],
      volumeName,
      ownerWorkloads,
      storageType,
      risk: risk.level,
      riskReasons: risk.reasons
    };
  }).sort((left, right) =>
    left.namespace.localeCompare(right.namespace) ||
    (left.ownerWorkloads[0] || "").localeCompare(right.ownerWorkloads[0] || "") ||
    left.name.localeCompare(right.name)
  );

  const namespaceSummary = new Map();
  const classNames = new Set();
  for (const claim of claims) {
    if (claim.storageClass) classNames.add(claim.storageClass);
    const item = ensureStorageNamespace(namespaceSummary, claim.namespace);
    item.pvcCount += 1;
    if (claim.status === "Bound") item.bound += 1;
    if (claim.status === "Pending") item.pending += 1;
    if (claim.status === "Lost") item.lost += 1;
    if (claim.risk === "high") item.highRisk += 1;
    if (claim.risk !== "normal") item.attention += 1;
  }

  const namespaces = Array.from(namespaceSummary.values()).sort((left, right) =>
    left.namespace.localeCompare(right.namespace)
  );

  return {
    available: true,
    partial: errors.length > 0,
    source: "api/v1 persistentvolumeclaims",
    message: errors.length ? "Storage inventory partially available." : "Storage inventory available.",
    errors,
    claims,
    namespaces,
    summary: {
      pvcCount: claims.length,
      bound: claims.filter((claim) => claim.status === "Bound").length,
      pending: claims.filter((claim) => claim.status === "Pending").length,
      lost: claims.filter((claim) => claim.status === "Lost").length,
      highRisk: claims.filter((claim) => claim.risk === "high").length,
      attention: claims.filter((claim) => claim.risk !== "normal").length,
      localPath: claims.filter((claim) => claim.storageType === "local").length,
      network: claims.filter((claim) => claim.storageType === "network").length,
      unknownStorage: claims.filter((claim) => claim.storageType === "unknown").length,
      namespaces: namespaces.length,
      storageClasses: classNames.size
    }
  };
}

function ensureStorageNamespace(namespaces, namespace) {
  if (!namespaces.has(namespace)) {
    namespaces.set(namespace, {
      namespace,
      pvcCount: 0,
      bound: 0,
      pending: 0,
      lost: 0,
      highRisk: 0,
      attention: 0
    });
  }
  return namespaces.get(namespace);
}

function pvcStorageClassName(pvc) {
  return pvc.spec?.storageClassName || pvc.metadata?.annotations?.["volume.beta.kubernetes.io/storage-class"] || "";
}

function pvcConsumers(podItems = [], deploymentItems = []) {
  const deploymentsByNamespace = new Map();
  for (const deployment of deploymentItems) {
    const namespace = deployment.metadata?.namespace || "default";
    if (!deploymentsByNamespace.has(namespace)) deploymentsByNamespace.set(namespace, []);
    deploymentsByNamespace.get(namespace).push(deployment.metadata?.name || "");
  }
  for (const names of deploymentsByNamespace.values()) {
    names.sort((left, right) => right.length - left.length);
  }

  const consumers = new Map();
  for (const pod of podItems) {
    const namespace = pod.metadata?.namespace || "default";
    const workload = podWorkloadName(pod, deploymentsByNamespace.get(namespace) || []);
    for (const volume of pod.spec?.volumes || []) {
      const claimName = volume.persistentVolumeClaim?.claimName;
      if (!claimName) continue;
      const key = `${namespace}/${claimName}`;
      if (!consumers.has(key)) consumers.set(key, new Set());
      consumers.get(key).add(workload);
    }
  }
  return consumers;
}

function podWorkloadName(pod, deploymentNames = []) {
  const owner = (pod.metadata?.ownerReferences || []).find((item) => item.controller) ||
    (pod.metadata?.ownerReferences || [])[0];
  if (!owner?.kind || !owner?.name) return `Pod/${pod.metadata?.name || ""}`;
  if (owner.kind === "ReplicaSet") {
    const deployment = deploymentNames.find((name) => owner.name === name || owner.name.startsWith(`${name}-`));
    return deployment ? `Deployment/${deployment}` : `ReplicaSet/${owner.name}`;
  }
  return `${owner.kind}/${owner.name}`;
}

function classifyStorageType(storageClassName, storageClass, volume) {
  const provisioner = String(storageClass?.provisioner || "").toLowerCase();
  const className = String(storageClassName || "").toLowerCase();
  const volumeSpec = volume?.spec || {};
  const volumeText = JSON.stringify(volumeSpec).toLowerCase();
  if (
    LOCAL_STORAGE_HINTS.some((hint) => className.includes(hint) || volumeText.includes(hint)) ||
    LOCAL_STORAGE_PROVISIONERS.some((hint) => provisioner.includes(hint)) ||
    volumeSpec.local ||
    volumeSpec.hostPath ||
    volumeSpec.nodeAffinity
  ) {
    return "local";
  }
  if (
    NETWORK_STORAGE_HINTS.some((hint) => className.includes(hint) || provisioner.includes(hint) || volumeText.includes(hint)) ||
    volumeSpec.nfs
  ) {
    return "network";
  }
  return "unknown";
}

function storageRisk(pvc, volume, storageClass, storageType, availability = {}) {
  const status = pvc.status?.phase || "Unknown";
  const reasons = [];

  if (status === "Lost") reasons.push("PVC is lost.");
  if (status === "Pending") reasons.push("PVC is pending.");
  if (status !== "Bound") reasons.push("PVC is not bound.");
  if (!pvc.spec?.volumeName) reasons.push("No bound PV is recorded.");
  if (storageType === "local") reasons.push("Storage appears node-local.");
  if (storageType === "unknown") reasons.push("Storage type is unknown.");
  if (storageType === "unknown" && !storageClass) reasons.push("StorageClass details are unavailable.");
  if (availability.volumesAvailable && pvc.spec?.volumeName && !volume) reasons.push("Bound PV was not found.");
  if (!availability.volumesAvailable) reasons.push("PV inventory is unavailable.");
  if (!availability.storageClassesAvailable) reasons.push("StorageClass inventory is unavailable.");

  if (status === "Lost" || storageType === "local") return { level: "high", reasons };
  if (reasons.length) return { level: "attention", reasons };
  return { level: "normal", reasons: ["Network or non-local storage detected."] };
}

function mapCapacity(raw, podNodeNames = new Map()) {
  const metricsApi = raw.metricsApi || {};
  const nodeMetricItems = metricsApi.nodes?.items || [];
  const podMetricItems = metricsApi.pods?.items || [];
  const hasMetrics = nodeMetricItems.length > 0 || podMetricItems.length > 0;
  if (!hasMetrics) return unavailableCapacity(metricsApi);

  const nodeMetrics = new Map(nodeMetricItems.map((item) => [item.metadata?.name || "", item]));
  const nodes = (raw.nodes?.items || []).map((node) => {
    const name = node.metadata?.name || "";
    const metric = nodeMetrics.get(name);
    const allocatable = node.status?.allocatable || {};
    const capacity = node.status?.capacity || {};
    const cpuBasis = allocatable.cpu || capacity.cpu || "";
    const memoryBasis = allocatable.memory || capacity.memory || "";
    const cpuUsageMillis = parseCpuMillis(metric?.usage?.cpu);
    const cpuBasisMillis = parseCpuMillis(cpuBasis);
    const memoryUsageBytes = parseMemoryBytes(metric?.usage?.memory);
    const memoryBasisBytes = parseMemoryBytes(memoryBasis);
    const memoryPercent = percentUsed(memoryUsageBytes, memoryBasisBytes);

    return {
      name,
      cpu: {
        usage: metric?.usage?.cpu || "",
        usageDisplay: formatCpuMillis(cpuUsageMillis),
        usageMillis: roundMetric(cpuUsageMillis, 3),
        basis: cpuBasis,
        basisDisplay: formatCpuMillis(cpuBasisMillis),
        basisMillis: roundMetric(cpuBasisMillis, 3),
        percentUsed: percentUsed(cpuUsageMillis, cpuBasisMillis)
      },
      memory: {
        usage: metric?.usage?.memory || "",
        usageDisplay: formatMemoryBytes(memoryUsageBytes),
        usageBytes: roundMetric(memoryUsageBytes, 0),
        basis: memoryBasis,
        basisDisplay: formatMemoryBytes(memoryBasisBytes),
        basisBytes: roundMetric(memoryBasisBytes, 0),
        percentUsed: memoryPercent
      },
      severity: capacitySeverity(memoryPercent)
    };
  });

  const topPods = podMetricItems
    .map((podMetric) => {
      const namespace = podMetric.metadata?.namespace || "default";
      const name = podMetric.metadata?.name || "";
      const containers = podMetric.containers || [];
      const cpuUsageMillis = containers.reduce((sum, container) => {
        const value = parseCpuMillis(container.usage?.cpu);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      const memoryUsageBytes = containers.reduce((sum, container) => {
        const value = parseMemoryBytes(container.usage?.memory);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);

      return {
        namespace,
        name,
        nodeName: podNodeNames.get(`${namespace}/${name}`) || "",
        containers: containers.length,
        cpu: {
          usageDisplay: formatCpuMillis(cpuUsageMillis),
          usageMillis: roundMetric(cpuUsageMillis, 3)
        },
        memory: {
          usageDisplay: formatMemoryBytes(memoryUsageBytes),
          usageBytes: roundMetric(memoryUsageBytes, 0)
        }
      };
    })
    .sort((left, right) =>
      (right.memory.usageBytes || 0) - (left.memory.usageBytes || 0) ||
      left.namespace.localeCompare(right.namespace) ||
      left.name.localeCompare(right.name)
    )
    .slice(0, TOP_PODS_LIMIT);

  const memoryPercents = nodes
    .map((node) => node.memory.percentUsed)
    .filter((value) => Number.isFinite(value));

  return {
    available: true,
    source: "metrics.k8s.io/v1beta1",
    message: metricErrors(metricsApi).length ? "Metrics API partially available." : "Metrics API available.",
    errors: metricErrors(metricsApi),
    nodes,
    topPods,
    summary: {
      nodeCount: nodes.length,
      topPodCount: topPods.length,
      elevatedMemoryNodes: nodes.filter((node) => node.severity === "elevated").length,
      highMemoryNodes: nodes.filter((node) => node.severity === "high").length,
      maxMemoryPercent: memoryPercents.length ? Math.max(...memoryPercents) : null
    }
  };
}

function mapClusterSnapshot(raw, now = new Date()) {
  const podItems = raw.pods?.items || [];
  const deploymentItems = raw.deployments?.items || [];
  const podsByNode = new Map();
  const podNodeNames = new Map();

  for (const pod of podItems) {
    const nodeName = pod.spec?.nodeName || "unassigned";
    const namespace = pod.metadata?.namespace || "default";
    const name = pod.metadata?.name || "";
    podNodeNames.set(`${namespace}/${name}`, nodeName);
    if (!podsByNode.has(nodeName)) podsByNode.set(nodeName, []);
    podsByNode.get(nodeName).push({
      namespace,
      name,
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
        memory: node.status?.capacity?.memory || "",
        allocatableCpu: node.status?.allocatable?.cpu || "",
        allocatableMemory: node.status?.allocatable?.memory || ""
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
    containers,
    capacity: mapCapacity(raw, podNodeNames),
    storage: mapStorageReadiness(raw, podItems, deploymentItems)
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
      const [nodes, pods, deployments, nodeMetrics, podMetrics, persistentVolumeClaims, persistentVolumes, storageClasses] = await Promise.all([
        request("/api/v1/nodes"),
        request("/api/v1/pods"),
        request("/apis/apps/v1/deployments"),
        optionalRequest(request, "/apis/metrics.k8s.io/v1beta1/nodes"),
        optionalRequest(request, "/apis/metrics.k8s.io/v1beta1/pods"),
        optionalRequest(request, "/api/v1/persistentvolumeclaims"),
        optionalRequest(request, "/api/v1/persistentvolumes"),
        optionalRequest(request, "/apis/storage.k8s.io/v1/storageclasses")
      ]);
      return mapClusterSnapshot({
        nodes,
        pods,
        deployments,
        metricsApi: {
          nodes: nodeMetrics.data,
          pods: podMetrics.data,
          errors: [nodeMetrics.error, podMetrics.error].filter(Boolean)
        },
        storageApi: {
          claims: persistentVolumeClaims.data,
          volumes: persistentVolumes.data,
          classes: storageClasses.data,
          claimsUnavailable: Boolean(persistentVolumeClaims.error),
          errors: [persistentVolumeClaims.error, persistentVolumes.error, storageClasses.error].filter(Boolean)
        }
      }, new Date());
    }
  };
}

async function optionalRequest(request, path) {
  try {
    return { data: await request(path), error: "" };
  } catch (error) {
    return { data: null, error: `${path}: ${error.message}` };
  }
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
            allocatable: { cpu: "3800m", memory: "7240Mi" },
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
            allocatable: { cpu: "9500m", memory: "15360Mi" },
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
        ], {
          ownerReferences: [{ kind: "ReplicaSet", name: "model-trading-bot-backend-8b9775d9bc", controller: true }],
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "model-trading-bot-backend-data" } }]
        })
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
    },
    metricsApi: {
      nodes: {
        items: [
          nodeMetric("rpi5-control", "512m", "5320Mi"),
          nodeMetric("mac-mini-worker", "2200m", "10920Mi")
        ]
      },
      pods: {
        items: [
          podMetric("default", "pihole-6f9fb77c8d-n2z7x", [["pihole", "45m", "154Mi"]]),
          podMetric("default", "homebridge-5847b7d9b5-tfm2m", [["homebridge", "82m", "238Mi"]]),
          podMetric("default", "k8s-management-ui-web-6447596f7c-nx7qk", [["web", "31m", "72Mi"]]),
          podMetric("default", "local-llm-frontend-75dd47d6b8-bnlq8", [["frontend", "105m", "188Mi"]]),
          podMetric("default", "model-trading-bot-backend-8b9775d9bc-r5p7d", [["backend", "410m", "724Mi"]])
        ]
      },
      errors: []
    },
    persistentVolumeClaims: {
      items: [
        pvc("default", "model-trading-bot-backend-data", "Bound", "local-path", "20Gi", ["ReadWriteOnce"], "pvc-local-model-trading"),
        pvc("default", "postgres-postgres-pgdata", "Bound", "synology-nfs", "50Gi", ["ReadWriteOnce"], "pvc-nfs-postgres"),
        pvc("recruiting-app", "recruiting-app-scraper-cache", "Pending", "local-path", "10Gi", ["ReadWriteOnce"], "")
      ]
    },
    persistentVolumes: {
      items: [
        persistentVolume("pvc-local-model-trading", "local-path", "20Gi", {
          local: { path: "/var/lib/rancher/k3s/storage/pvc-local-model-trading" },
          nodeAffinity: {
            required: {
              nodeSelectorTerms: [{
                matchExpressions: [{
                  key: "kubernetes.io/hostname",
                  operator: "In",
                  values: ["mac-mini-worker"]
                }]
              }]
            }
          }
        }),
        persistentVolume("pvc-nfs-postgres", "synology-nfs", "50Gi", {
          nfs: { server: "192.168.4.33", path: "/volume1/k8s/postgres" }
        })
      ]
    },
    storageClasses: {
      items: [
        storageClass("local-path", "rancher.io/local-path"),
        storageClass("synology-nfs", "cluster.local/nfs-subdir-external-provisioner")
      ]
    }
  };
}

function nodeMetric(name, cpu, memory) {
  return {
    metadata: { name },
    usage: { cpu, memory }
  };
}

function podMetric(namespace, name, containers) {
  return {
    metadata: { namespace, name },
    containers: containers.map(([containerName, cpu, memory]) => ({
      name: containerName,
      usage: { cpu, memory }
    }))
  };
}

function pvc(namespace, name, phase, storageClassName, requested, accessModes, volumeName) {
  return {
    metadata: { namespace, name },
    spec: {
      storageClassName,
      resources: { requests: { storage: requested } },
      accessModes,
      volumeName
    },
    status: { phase }
  };
}

function persistentVolume(name, storageClassName, capacity, sourceSpec) {
  return {
    metadata: { name },
    spec: {
      storageClassName,
      capacity: { storage: capacity },
      ...sourceSpec
    },
    status: { phase: "Bound" }
  };
}

function storageClass(name, provisioner) {
  return {
    metadata: { name },
    provisioner
  };
}

function pod(namespace, name, nodeName, phase, containers, options = {}) {
  return {
    metadata: {
      namespace,
      name,
      ...(options.ownerReferences ? { ownerReferences: options.ownerReferences } : {})
    },
    spec: {
      nodeName,
      volumes: options.volumes || [],
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
  capacitySeverity,
  createKubernetesClient,
  demoRawCluster,
  httpsJson,
  mapCapacity,
  mapClusterSnapshot,
  mapStorageReadiness,
  parseCpuMillis,
  parseMemoryBytes,
  shouldUseDemoMode
};
