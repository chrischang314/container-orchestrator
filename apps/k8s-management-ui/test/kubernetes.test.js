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
  assert.equal(snapshot.summary.externalWorkers, 1);
  assert.equal(snapshot.summary.externalWorkersOnline, 1);
  assert.equal(snapshot.summary.deployments, 6);
  assert.equal(snapshot.attention.total, 0);

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

test("mapClusterSnapshot marks offline nodes", () => {
  const raw = demoRawCluster();
  raw.nodes.items[0].status.conditions = [{ type: "Ready", status: "False", reason: "KubeletStopped" }];
  const snapshot = mapClusterSnapshot(raw);
  const control = snapshot.nodes.find((node) => node.name === "rpi5-control");
  assert.equal(control.online, false);
  assert.equal(control.readyReason, "KubeletStopped");
});

test("mapClusterSnapshot derives active attention issues", () => {
  const raw = demoRawCluster();
  raw.nodes.items[0].status.conditions = [{ type: "Ready", status: "False", reason: "KubeletStopped" }];
  raw.nodes.items[1].spec.unschedulable = true;

  const externalWorker = raw.deployments.items.find((item) => item.metadata.name === "chris-pc-2-ollama-switch");
  externalWorker.status.readyReplicas = 0;
  externalWorker.status.availableReplicas = 0;
  externalWorker.metadata.annotations["local-llm.io/actual-state"] = "pending";

  raw.deployments.items.push({
    metadata: { namespace: "default", name: "unstable-api" },
    spec: { replicas: 2 },
    status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 }
  });
  raw.pods.items.push({
    metadata: { namespace: "default", name: "unstable-api-7d9c4f", ownerReferences: [{ kind: "ReplicaSet" }] },
    spec: {
      nodeName: "mac-mini-worker",
      containers: [{ name: "api", image: "example/api:latest" }]
    },
    status: {
      phase: "Pending",
      containerStatuses: [{
        name: "api",
        image: "example/api:latest",
        ready: false,
        restartCount: 7,
        started: false,
        state: { waiting: { reason: "CrashLoopBackOff" } }
      }]
    }
  });
  raw.pods.items.push({
    metadata: { namespace: "default", name: "completed-job-abc", ownerReferences: [{ kind: "Job" }] },
    spec: {
      nodeName: "mac-mini-worker",
      containers: [{ name: "job", image: "example/job:latest" }]
    },
    status: {
      phase: "Succeeded",
      containerStatuses: [{
        name: "job",
        image: "example/job:latest",
        ready: false,
        restartCount: 0,
        started: false,
        state: { terminated: { reason: "Completed" } }
      }]
    }
  });

  const snapshot = mapClusterSnapshot(raw);
  const kinds = new Set(snapshot.attention.issues.map((item) => item.kind));

  assert.equal(snapshot.pods.some((pod) => pod.name === "unstable-api-7d9c4f"), true);
  assert.equal(snapshot.attention.critical, 1);
  assert.equal(snapshot.attention.highestSeverity, "critical");
  assert.equal(kinds.has("node-offline"), true);
  assert.equal(kinds.has("node-cordoned"), true);
  assert.equal(kinds.has("external-worker-offline"), true);
  assert.equal(kinds.has("deployment-unready"), true);
  assert.equal(kinds.has("pod-phase"), true);
  assert.equal(kinds.has("container-not-ready"), true);
  assert.equal(kinds.has("container-restarts-high"), true);
  assert.equal(snapshot.attention.issues.some((item) => item.name === "completed-job-abc"), false);

  const workerIssue = snapshot.attention.issues.find((item) => item.kind === "external-worker-offline");
  assert.equal(workerIssue.namespace, "local-llm");
  assert.equal(workerIssue.deployment, "chris-pc-2-ollama-switch");
});
