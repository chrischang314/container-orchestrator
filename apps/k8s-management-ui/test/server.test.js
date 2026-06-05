"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../src/server");
const { mapClusterSnapshot, demoRawCluster } = require("../src/kubernetes");

const ADMIN_TOKEN = "test-admin-token";
const CSRF_TOKEN = "test-csrf-token";

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
    assert.equal(health.mutations, false);
    assert.equal(health.mutationAuthConfigured, false);

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
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true", K8S_UI_ADMIN_TOKEN: ADMIN_TOKEN },
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

    const blocked = await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker" },
      409,
      adminHeaders()
    );
    assert.equal(blocked.requiresConfirmation, true);
    assert.equal(blocked.confirmationRequired, true);
    assert.equal(blocked.command, "kubectl cordon mac-mini-worker");
    assert.deepEqual(calls, ["kubectl get nodes"]);

    const confirmed = await postJson(
      `${base}/api/command`,
      {
        command: "kubectl cordon mac-mini-worker",
        confirmed: true
      },
      200,
      adminHeaders()
    );
    assert.equal(confirmed.ok, true);
    assert.deepEqual(calls, ["kubectl get nodes", "kubectl cordon mac-mini-worker"]);
  } finally {
    await close(server);
  }
});

test("server requires confirmation before mutating built-in actions", async () => {
  const calls = [];
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true", K8S_UI_ADMIN_TOKEN: ADMIN_TOKEN },
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

    const blocked = await postJson(
      `${base}/api/action`,
      {
        action: "restart-deployment",
        namespace: "default",
        name: "k8s-management-ui-web"
      },
      409,
      adminHeaders()
    );
    assert.equal(blocked.requiresConfirmation, true);
    assert.equal(blocked.confirmationRequired, true);
    assert.equal(blocked.command, "kubectl rollout restart deployment/k8s-management-ui-web -n default");

    await postJson(
      `${base}/api/action`,
      {
        action: "restart-deployment",
        namespace: "default",
        name: "k8s-management-ui-web",
        confirmed: true
      },
      200,
      adminHeaders()
    );
    assert.deepEqual(calls, [
      "kubectl rollout status deployment/k8s-management-ui-web -n default",
      "kubectl rollout restart deployment/k8s-management-ui-web -n default"
    ]);
  } finally {
    await close(server);
  }
});

test("server fails closed when mutations are enabled without an admin token", async () => {
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
      return { ok: true, code: 0, command, stdout: "ok", stderr: "", mutating: true };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.mutations, false);
    assert.equal(health.mutationAuthConfigured, false);

    const result = await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker", confirmed: true },
      403
    );
    assert.match(result.error, /ADMIN_TOKEN/);
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test("server requires a valid admin token for mutating requests", async () => {
  const calls = [];
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true", K8S_UI_ADMIN_TOKEN: ADMIN_TOKEN },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    },
    async commandRunner(command) {
      calls.push(command);
      return { ok: true, code: 0, command, stdout: "ok", stderr: "", mutating: true };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.mutations, true);
    assert.equal(health.mutationAuthConfigured, true);

    const missing = await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker", confirmed: true },
      401
    );
    assert.match(missing.error, /admin token/);

    const invalid = await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker", confirmed: true },
      401,
      { "X-K8S-UI-Admin-Token": "wrong" }
    );
    assert.match(invalid.error, /admin token/);

    await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker", confirmed: true },
      200,
      adminHeaders()
    );
    assert.deepEqual(calls, ["kubectl cordon mac-mini-worker"]);
  } finally {
    await close(server);
  }
});

test("server rejects cross-origin mutating browser requests", async () => {
  const calls = [];
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true", K8S_UI_ADMIN_TOKEN: ADMIN_TOKEN },
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    },
    async commandRunner(command) {
      calls.push(command);
      return { ok: true, code: 0, command, stdout: "ok", stderr: "", mutating: true };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const blocked = await postJson(
      `${base}/api/action`,
      {
        action: "restart-deployment",
        namespace: "default",
        name: "k8s-management-ui-web",
        confirmed: true
      },
      403,
      { ...adminHeaders(), Origin: "https://attacker.example" }
    );
    assert.match(blocked.error, /same-origin/);
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test("server requires CSRF token pair for same-origin browser mutating requests", async () => {
  const calls = [];
  const server = createServer({
    env: { K8S_UI_DEMO: "true", K8S_UI_ALLOW_MUTATIONS: "true", K8S_UI_ADMIN_TOKEN: ADMIN_TOKEN },
    csrfToken: CSRF_TOKEN,
    client: {
      mode: "test",
      async snapshot() {
        return mapClusterSnapshot(demoRawCluster(), new Date("2026-05-17T12:00:00Z"));
      }
    },
    async commandRunner(command) {
      calls.push(command);
      return { ok: true, code: 0, command, stdout: "ok", stderr: "", mutating: true };
    }
  });

  await listen(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const appShell = await fetch(`${base}/`);
    const html = await appShell.text();
    const cookie = appShell.headers.get("set-cookie");
    assert.equal(html.includes("X-K8S-UI-CSRF-Token"), true);
    assert.match(cookie, /k8s_ui_csrf=test-csrf-token/);

    const blocked = await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker", confirmed: true },
      403,
      { ...adminHeaders(), Origin: base, Cookie: "k8s_ui_csrf=test-csrf-token" }
    );
    assert.match(blocked.error, /CSRF/);

    await postJson(
      `${base}/api/command`,
      { command: "kubectl cordon mac-mini-worker", confirmed: true },
      200,
      {
        ...adminHeaders(),
        Origin: base,
        Cookie: "k8s_ui_csrf=test-csrf-token",
        "X-K8S-UI-CSRF-Token": CSRF_TOKEN
      }
    );
    assert.deepEqual(calls, ["kubectl cordon mac-mini-worker"]);
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
    assert.equal(cluster.attention.total, 0);
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

test("public status mode exposes only sanitized attention issues", async () => {
  const raw = demoRawCluster();
  raw.deployments.items[0].status.readyReplicas = 0;
  raw.deployments.items[0].status.availableReplicas = 0;
  raw.pods.items[0].status.containerStatuses[0].ready = false;
  raw.pods.items[0].status.containerStatuses[0].restartCount = 9;

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

    assert.equal(cluster.attention.total, 1);
    assert.equal(cluster.attention.issues[0].kind, "deployment-unready");
    assert.equal(cluster.attention.issues[0].deployment, "k8s-management-ui-web");
    assert.equal(JSON.stringify(cluster.attention).includes("pihole-6f9fb77c8d-n2z7x"), false);
    assert.equal(JSON.stringify(cluster.attention).includes("container-not-ready"), false);
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

function adminHeaders() {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function postJson(url, body, expectedStatus = 200, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}
