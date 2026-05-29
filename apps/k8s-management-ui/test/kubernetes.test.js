"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  demoRawCluster,
  mapClusterSnapshot,
  memorySeverity,
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

  const worker = snapshot.nodes.find((node) => node.name === "mac-mini-worker");
  assert.equal(worker.role, "worker");
  assert.equal(worker.online, true);
  assert.equal(worker.podCount, 3);
  assert.equal(worker.containers.some((container) => container.name === "web"), true);
  assert.equal(worker.allocatable.cpu, "9400m");

  const externalWorker = snapshot.externalWorkers.find((item) => item.name === "chris-pc-2");
  assert.equal(externalWorker.online, true);
  assert.equal(externalWorker.deployment, "chris-pc-2-ollama-switch");
  assert.equal(externalWorker.desiredState, "on");
});

test("quantity parsers handle Kubernetes CPU and memory units", () => {
  assert.equal(parseCpuToMillicores("2"), 2000);
  assert.equal(parseCpuToMillicores("250m"), 250);
  assert.equal(parseCpuToMillicores("1000000n"), 1);
  assert.equal(parseCpuToMillicores("250u"), 0.25);
  assert.equal(parseMemoryToBytes("1Gi"), 1024 ** 3);
  assert.equal(parseMemoryToBytes("512Mi"), 512 * 1024 ** 2);
  assert.equal(parseMemoryToBytes("1000K"), 1000 * 1000);
});

test("mapClusterSnapshot derives capacity from Metrics API data", () => {
  const snapshot = mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));

  assert.equal(snapshot.capacity.available, true);
  assert.equal(snapshot.capacity.nodes.length, 2);
  assert.equal(snapshot.capacity.nodes[0].name, "mac-mini-worker");
  assert.equal(snapshot.capacity.nodes[0].memory.severity, "elevated");
  assert.equal(snapshot.capacity.nodes[0].memory.basisType, "allocatable");
  assert.equal(snapshot.capacity.nodes[0].memory.percentUsed, 74.9);
  assert.equal(snapshot.capacity.topPods[0].name, "model-trading-bot-backend-8b9775d9bc-r5p7d");
  assert.equal(snapshot.capacity.topPods[0].node, "mac-mini-worker");
  assert.equal(snapshot.capacity.topPods[0].memory.usageBytes, 740 * 1024 ** 2);
});

test("mapClusterSnapshot keeps cluster data available when metrics are unavailable", () => {
  const raw = demoRawCluster();
  raw.metrics = { error: "Kubernetes API 403: forbidden" };
  const snapshot = mapClusterSnapshot(raw);

  assert.equal(snapshot.summary.nodes, 2);
  assert.equal(snapshot.capacity.available, false);
  assert.match(snapshot.capacity.reason, /403/);
  assert.deepEqual(snapshot.capacity.nodes, []);
  assert.deepEqual(snapshot.capacity.topPods, []);
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
