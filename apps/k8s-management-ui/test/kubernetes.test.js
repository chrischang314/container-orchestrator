"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  demoRawCluster,
  mapClusterSnapshot,
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
  assert.equal(snapshot.summary.deployments, 5);

  const worker = snapshot.nodes.find((node) => node.name === "mac-mini-worker");
  assert.equal(worker.role, "worker");
  assert.equal(worker.online, true);
  assert.equal(worker.podCount, 3);
  assert.equal(worker.containers.some((container) => container.name === "web"), true);
});

test("mapClusterSnapshot marks offline nodes", () => {
  const raw = demoRawCluster();
  raw.nodes.items[0].status.conditions = [{ type: "Ready", status: "False", reason: "KubeletStopped" }];
  const snapshot = mapClusterSnapshot(raw);
  const control = snapshot.nodes.find((node) => node.name === "rpi5-control");
  assert.equal(control.online, false);
  assert.equal(control.readyReason, "KubeletStopped");
});
