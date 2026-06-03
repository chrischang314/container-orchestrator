"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCapacitySnapshot,
  demoRawCluster,
  mapClusterSnapshot,
  memorySeverity,
  mapStorageReadiness,
  parseCpuMillis,
  parseMemoryBytes,
  parseCpuToMillicores,
  parseMemoryToBytes,
  shouldUseDemoMode
} = require("../src/kubernetes");

test("shouldUseDemoMode defaults to demo outside a cluster", () => {
  assert.equal(shouldUseDemoMode({}), true);
  assert.equal(shouldUseDemoMode({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }), false);
  assert.equal(shouldUseDemoMode({ K8S_UI_DEMO: "true", KUBERNETES_SERVICE_HOST: "10.0.0.1" }), true);
});

test("mapClusterSnapshot groups pods and containers by node", () => {
  const snapshot = mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
  assert.equal(snapshot.generatedAt, "2026-05-17T12:00:00.000Z");
  assert.equal(snapshot.summary.nodes, 2);
  assert.equal(snapshot.summary.onlineNodes, 2);
  assert.equal(snapshot.summary.controlPlaneNodes, 1);
  assert.equal(snapshot.summary.workerNodes, 1);
  assert.equal(snapshot.summary.externalWorkers, 1);
  assert.equal(snapshot.summary.externalWorkersOnline, 1);
  assert.equal(snapshot.summary.deployments, 6);
  assert.equal(snapshot.capacity.available, true);
  assert.equal(snapshot.capacity.nodes.length, 2);
  assert.equal(snapshot.capacity.topPods[0].name, "model-trading-bot-backend-8b9775d9bc-r5p7d");
  assert.equal(snapshot.storage.available, true);
  assert.equal(snapshot.storage.summary.pvcCount, 3);

  const worker = snapshot.nodes.find((node) => node.name === "mac-mini-worker");
  assert.equal(worker.role, "worker");
  assert.equal(worker.online, true);
  assert.equal(worker.podCount, 3);
  assert.equal(worker.containers.some((container) => container.name === "web"), true);

  const externalWorker = snapshot.externalWorkers.find((item) => item.name === "chris-pc-2");
  assert.equal(externalWorker.online, true);
  assert.equal(externalWorker.deployment, "chris-pc-2-ollama-switch");
  assert.equal(externalWorker.desiredState, "on");
});

test("mapStorageReadiness classifies PVC storage risk and workload consumers", () => {
  const raw = demoRawCluster();
  const storage = mapStorageReadiness(raw, raw.pods.items, raw.deployments.items);

  assert.equal(storage.available, true);
  assert.equal(storage.partial, false);
  assert.equal(storage.summary.pvcCount, 3);
  assert.equal(storage.summary.localPath, 2);
  assert.equal(storage.summary.network, 1);
  assert.equal(storage.summary.highRisk, 2);
  assert.equal(storage.summary.attention, 2);

  const localClaim = storage.claims.find((claim) => claim.name === "model-trading-bot-backend-data");
  assert.equal(localClaim.risk, "high");
  assert.equal(localClaim.storageType, "local");
  assert.deepEqual(localClaim.ownerWorkloads, ["Deployment/model-trading-bot-backend"]);
  assert.match(localClaim.riskReasons.join(" "), /node-local/);

  const nfsClaim = storage.claims.find((claim) => claim.name === "postgres-postgres-pgdata");
  assert.equal(nfsClaim.risk, "normal");
  assert.equal(nfsClaim.storageType, "network");

  const pendingClaim = storage.claims.find((claim) => claim.status === "Pending");
  assert.equal(pendingClaim.risk, "high");
  assert.match(pendingClaim.riskReasons.join(" "), /not bound/);
});

test("mapStorageReadiness keeps PVC inventory when PV and StorageClass reads are partial", () => {
  const raw = demoRawCluster();
  const storage = mapStorageReadiness({
    storageApi: {
      claims: raw.persistentVolumeClaims,
      volumes: null,
      classes: null,
      errors: [
        "/api/v1/persistentvolumes: forbidden",
        "/apis/storage.k8s.io/v1/storageclasses: forbidden"
      ]
    }
  }, raw.pods.items, raw.deployments.items);

  assert.equal(storage.available, true);
  assert.equal(storage.partial, true);
  assert.equal(storage.claims.length, 3);
  assert.equal(storage.errors.length, 2);
  assert.equal(storage.claims.every((claim) => claim.riskReasons.some((reason) => /unavailable/.test(reason))), true);
});

test("mapStorageReadiness reports unavailable storage when PVC reads fail", () => {
  const storage = mapStorageReadiness({
    storageApi: {
      claims: null,
      claimsUnavailable: true,
      errors: ["/api/v1/persistentvolumeclaims: forbidden"]
    }
  });

  assert.equal(storage.available, false);
  assert.equal(storage.summary.pvcCount, 0);
  assert.match(storage.message, /unavailable/);
});

test("quantity parsers handle Kubernetes CPU and memory suffixes", () => {
  assert.equal(parseCpuMillis("250m"), 250);
  assert.equal(parseCpuMillis("2"), 2000);
  assert.equal(parseCpuMillis("125000000n"), 125);
  assert.equal(parseCpuToMillicores("250u"), 0.25);
  assert.equal(parseMemoryBytes("512Mi"), 536870912);
  assert.equal(parseMemoryBytes("2Gi"), 2147483648);
  assert.equal(parseMemoryBytes("1000"), 1000);
  assert.equal(parseMemoryToBytes("1000K"), 1000 * 1000);
});

test("mapClusterSnapshot computes node pressure and sorted top pods", () => {
  const raw = demoRawCluster();
  raw.metricsApi.nodes.items[1].usage.memory = "14000Mi";
  raw.metricsApi.pods.items.push({
    metadata: { namespace: "default", name: "large-api-123" },
    containers: [
      { name: "api", usage: { cpu: "900m", memory: "1800Mi" } },
      { name: "sidecar", usage: { cpu: "50m", memory: "200Mi" } }
    ]
  });
  raw.pods.items.push({
    metadata: { namespace: "default", name: "large-api-123" },
    spec: { nodeName: "mac-mini-worker", containers: [{ name: "api", image: "example/api" }] },
    status: { phase: "Running", containerStatuses: [] }
  });

  const snapshot = mapClusterSnapshot(raw);
  const workerCapacity = snapshot.capacity.nodes.find((node) => node.name === "mac-mini-worker");

  assert.equal(workerCapacity.severity, "high");
  assert.equal(workerCapacity.memory.percentUsed, 91.1);
  assert.equal(snapshot.capacity.summary.highMemoryNodes, 1);
  assert.equal(snapshot.capacity.topPods[0].name, "large-api-123");
  assert.equal(snapshot.capacity.topPods[0].nodeName, "mac-mini-worker");
  assert.equal(snapshot.capacity.topPods[0].memory.usageDisplay, "2Gi");
});

test("mapClusterSnapshot keeps cluster snapshot available when metrics are missing", () => {
  const raw = demoRawCluster();
  raw.metricsApi = {
    nodes: null,
    pods: null,
    errors: ["metrics.k8s.io forbidden"]
  };

  const snapshot = mapClusterSnapshot(raw);

  assert.equal(snapshot.summary.nodes, 2);
  assert.equal(snapshot.capacity.available, false);
  assert.equal(snapshot.capacity.message, "Metrics API unavailable.");
  assert.deepEqual(snapshot.capacity.topPods, []);
});

test("buildCapacitySnapshot accepts branch metrics shape", () => {
  const raw = demoRawCluster();
  const snapshot = buildCapacitySnapshot({
    ...raw,
    metrics: {
      nodes: raw.metricsApi.nodes,
      pods: raw.metricsApi.pods
    }
  }, raw.pods.items);

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.topPods[0].nodeName, "mac-mini-worker");
});

test("memorySeverity classifies node pressure thresholds", () => {
  assert.equal(memorySeverity(69.9), "normal");
  assert.equal(memorySeverity(70), "elevated");
  assert.equal(memorySeverity(85), "high");
  assert.equal(memorySeverity(null), "unknown");
});

test("mapClusterSnapshot marks offline nodes", () => {
  const raw = demoRawCluster();
  raw.nodes.items[0].status.conditions = [{ type: "Ready", status: "False", reason: "KubeletStopped" }];
  const snapshot = mapClusterSnapshot(raw);
  const control = snapshot.nodes.find((node) => node.name === "rpi5-control");
  assert.equal(control.online, false);
  assert.equal(control.readyReason, "KubeletStopped");
});
