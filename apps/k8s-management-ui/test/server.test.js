"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../src/server");
const { mapClusterSnapshot, demoRawCluster } = require("../src/kubernetes");

test("server exposes health, cluster, and command endpoints", async () => {
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true" },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    },
    async commandRunner(command) {
      return {
        ok: true,
        code: 0,
        command,
        stdout: "ok",
        stderr: "",
        mutating: false
      };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await getJson(`${base}/api/health`);
    assert.equal(health.ok, true);
    assert.equal(health.service, "k8s-management-ui");

    const cluster = await getJson(`${base}/api/cluster`);
    assert.equal(cluster.summary.nodes, 2);
    assert.equal(cluster.capacity.available, true);
    assert.equal(cluster.capacity.topPods.length > 0, true);
    assert.equal(cluster.storage.available, true);
    assert.equal(cluster.storage.claims.length, 3);

    const command = await postJson(`${base}/api/command`, { command: "kubectl get nodes" });
    assert.equal(command.ok, true);
    assert.equal(command.stdout, "ok");
  } finally {
    await close(server);
  }
});

test("server requires confirmation before mutating command execution", async () => {
  const calls = [];
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true" },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    },
    async commandRunner(command) {
      calls.push(command);
      return {
        ok: true,
        code: 0,
        command,
        stdout: "ok",
        stderr: "",
        mutating: command.includes("cordon")
      };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const readOnly = await postJson(`${base}/api/command`, { command: "kubectl get nodes" });
    assert.equal(readOnly.ok, true);

    const blocked = await postJson(`${base}/api/command`, { command: "kubectl cordon mac-mini-worker" }, 409);
    assert.equal(blocked.requiresConfirmation, true);
    assert.equal(blocked.confirmationRequired, true);
    assert.equal(blocked.command, "kubectl cordon mac-mini-worker");
    assert.deepEqual(calls, ["kubectl get nodes"]);

    const confirmed = await postJson(`${base}/api/command`, {
      command: "kubectl cordon mac-mini-worker",
      confirmed: true
    });
    assert.equal(confirmed.ok, true);
    assert.deepEqual(calls, ["kubectl get nodes", "kubectl cordon mac-mini-worker"]);
  } finally {
    await close(server);
  }
});

test("server requires confirmation before mutating built-in actions", async () => {
  const calls = [];
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true" },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    },
    async commandRunner(command) {
      calls.push(command);
      return {
        ok: true,
        code: 0,
        command,
        stdout: "ok",
        stderr: "",
        mutating: command.includes("restart")
      };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const readOnly = await postJson(`${base}/api/action`, {
      action: "rollout-status",
      namespace: "default",
      name: "k8s-management-ui-web"
    });
    assert.equal(readOnly.ok, true);

    const blocked = await postJson(`${base}/api/action`, {
      action: "restart-deployment",
      namespace: "default",
      name: "k8s-management-ui-web"
    }, 409);
    assert.equal(blocked.requiresConfirmation, true);
    assert.equal(blocked.confirmationRequired, true);
    assert.equal(blocked.command, "kubectl rollout restart deployment/k8s-management-ui-web -n default");

    await postJson(`${base}/api/action`, {
      action: "restart-deployment",
      namespace: "default",
      name: "k8s-management-ui-web",
      confirmed: true
    });
    assert.deepEqual(calls, [
      "kubectl rollout status deployment/k8s-management-ui-web -n default",
      "kubectl rollout restart deployment/k8s-management-ui-web -n default"
    ]);
  } finally {
    await close(server);
  }
});

test("server reports disabled mutations without asking for confirmation", async () => {
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "false" },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await postJson(`${base}/api/command`, { command: "kubectl cordon mac-mini-worker" }, 400);

    assert.equal(result.requiresConfirmation, undefined);
    assert.equal(result.confirmationRequired, undefined);
    assert.match(result.stderr, /disabled/);
  } finally {
    await close(server);
  }
});

test("public status mode serves sanitized cluster data and blocks controls", async () => {
  const server = createServer({
    env: {
      K8S_UI_DEMO: "true",
      K8S_UI_ALLOW_MUTATIONS: "true",
      K8S_UI_PUBLIC_STATUS: "true"
    },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await getJson(`${base}/api/health`);
    assert.equal(health.publicStatus, true);
    assert.equal(health.mutations, false);

    const cluster = await getJson(`${base}/api/cluster`);
    assert.equal(cluster.mode, "public-status");
    assert.equal(cluster.summary.nodes, 2);
    assert.equal(cluster.summary.readyDeployments, 6);
    assert.equal(cluster.summary.externalWorkers, 1);
    assert.equal(cluster.capacity.available, true);
    assert.equal(cluster.capacity.topPods, undefined);
    assert.equal(cluster.storage.available, true);
    assert.equal(cluster.storage.summary.pvcCount, 3);
    assert.equal(cluster.storage.claims, undefined);
    assert.equal(cluster.nodes[0].capacity.memory.percentUsed, 73.5);
    assert.equal(cluster.externalWorkers[0].name, "chris-pc-2");
    assert.equal(cluster.capacity.available, true);
    assert.equal(cluster.capacity.nodePressure.length, 2);
    assert.equal(cluster.capacity.summary.elevatedNodes, 1);
    assert.equal(cluster.capacity.topPods, undefined);
    assert.equal(cluster.nodes[0].containers, undefined);
    assert.equal(cluster.containers, undefined);
    assert.equal(JSON.stringify(cluster).includes("pihole-6f9fb77c8d-n2z7x"), false);
    assert.equal(JSON.stringify(cluster).includes("model-trading-bot-backend-8b9775d9bc-r5p7d"), false);
    assert.equal(JSON.stringify(cluster).includes("model-trading-bot-backend-data"), false);
    assert.equal(JSON.stringify(cluster).includes("pvc-local-model-trading"), false);
    assert.equal(JSON.stringify(cluster).includes("ghcr.io"), false);

    const html = await getText(`${base}/`);
    assert.equal(html.includes("public-status.js"), true);
    assert.equal(html.includes("commandForm"), false);

    const command = await postJson(`${base}/api/command`, { command: "kubectl get nodes" }, 403);
    assert.equal(command.ok, false);
  } finally {
    await close(server);
  }
});

test("public status mode treats scaled-to-zero deployments as inactive", async () => {
  const raw = demoRawCluster();
  raw.deployments.items.push({
    metadata: { namespace: "local-agent-model-workers", name: "chris-pc-1-model-switch" },
    spec: { replicas: 0 },
    status: { readyReplicas: 0, updatedReplicas: 0, availableReplicas: 0 }
  });

  const server = createServer({
    env: {
      K8S_UI_DEMO: "true",
      K8S_UI_PUBLIC_STATUS: "true"
    },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(raw, new Date("2026-05-17T12:00:00Z"));
      }
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cluster = await getJson(`${base}/api/cluster`);

    assert.equal(cluster.summary.deployments, 7);
    assert.equal(cluster.summary.readyDeployments, 7);
    assert.equal(cluster.health.workloads, "healthy");
    const inactiveNamespace = cluster.namespaces.find((item) => item.namespace === "local-agent-model-workers");
    assert.equal(inactiveNamespace.readyDeployments, 1);
    assert.equal(inactiveNamespace.readyReplicas, 0);
    assert.equal(inactiveNamespace.replicas, 0);
  } finally {
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.text();
}

async function postJson(url, body, expectedStatus = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}
