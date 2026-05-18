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

    const command = await postJson(`${base}/api/command`, { command: "kubectl get nodes" });
    assert.equal(command.ok, true);
    assert.equal(command.stdout, "ok");
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
    assert.equal(cluster.summary.readyDeployments, 5);
    assert.equal(cluster.nodes[0].containers, undefined);
    assert.equal(cluster.containers, undefined);
    assert.equal(JSON.stringify(cluster).includes("pihole-6f9fb77c8d-n2z7x"), false);
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
