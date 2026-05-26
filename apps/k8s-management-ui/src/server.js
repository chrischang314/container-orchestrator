"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { actionToCommand, runKubectl, validateKubectlCommand } = require("./command");
const { createKubernetesClient, shouldUseDemoMode } = require("./kubernetes");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

function createServer(options = {}) {
  const env = options.env || process.env;
  const client = options.client || createKubernetesClient({ env });
  const demoMode = options.demoMode ?? shouldUseDemoMode(env);
  const publicStatus = env.K8S_UI_PUBLIC_STATUS === "true";
  const allowMutations = !publicStatus && env.K8S_UI_ALLOW_MUTATIONS === "true";
  const commandRunner = options.commandRunner || ((command) => runKubectl(command, { allowMutations, demoMode }));

  return http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(res);

      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, {
          ok: true,
          service: "k8s-management-ui",
          mode: client.mode,
          mutations: allowMutations,
          publicStatus,
          time: new Date().toISOString()
        });
      }

      if (req.method === "GET" && url.pathname === "/api/cluster") {
        const snapshot = await client.snapshot();
        return json(res, 200, publicStatus ? publicClusterSnapshot(snapshot) : snapshot);
      }

      if (req.method === "POST" && url.pathname === "/api/command") {
        if (publicStatus) return json(res, 403, { ok: false, error: "Command endpoints are disabled in public status mode." });
        const body = await readJson(req);
        requireMutationConfirmation(body.command, body, { allowMutations });
        const result = await commandRunner(body.command);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && url.pathname === "/api/action") {
        if (publicStatus) return json(res, 403, { ok: false, error: "Action endpoints are disabled in public status mode." });
        const body = await readJson(req);
        const command = actionToCommand(body.action, body);
        requireMutationConfirmation(command, body, { allowMutations });
        const result = await commandRunner(command);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, url.pathname, { publicStatus });
      }

      return json(res, 405, { ok: false, error: "Method not allowed." });
    } catch (error) {
      return json(res, error.statusCode || 500, {
        ok: false,
        error: error.message,
        command: error.command,
        requiresConfirmation: Boolean(error.requiresConfirmation),
        confirmationRequired: Boolean(error.requiresConfirmation)
      });
    }
  });
}

function requireMutationConfirmation(command, body = {}, options = {}) {
  if (!options.allowMutations) return;

  const validation = validateKubectlCommand(command, { allowMutations: true });
  if (!validation.ok || !validation.mutating || body.confirmed === true) return;

  const error = new Error("Mutating command requires confirmation.");
  error.statusCode = 409;
  error.command = String(command || "").trim();
  error.requiresConfirmation = true;
  throw error;
}

function publicClusterSnapshot(snapshot) {
  const rawNodes = snapshot.nodes || [];
  const rawDeployments = snapshot.deployments || [];
  const rawExternalWorkers = snapshot.externalWorkers || [];
  const rawPods = rawNodes.flatMap((node) => node.pods || []);
  const namespaces = new Map();

  for (const pod of rawPods) {
    const item = ensureNamespace(namespaces, pod.namespace || "default");
    item.pods += 1;
    if (pod.phase === "Running") item.runningPods += 1;
    item.restarts += Number(pod.restartCount || 0);
  }

  for (const deployment of rawDeployments) {
    const item = ensureNamespace(namespaces, deployment.namespace || "default");
    item.deployments += 1;
    item.replicas += Number(deployment.replicas || 0);
    item.readyReplicas += Number(deployment.readyReplicas || 0);
    if (isDeploymentReady(deployment)) item.readyDeployments += 1;
  }

  const nodes = rawNodes.map((node) => ({
    name: node.name,
    role: node.role,
    online: Boolean(node.online),
    readyReason: node.readyReason,
    schedulable: Boolean(node.schedulable),
    kubeletVersion: node.kubeletVersion,
    architecture: node.architecture,
    podCount: Number(node.podCount || 0),
    containerCount: Number(node.containerCount || 0)
  }));

  const namespaceRows = Array.from(namespaces.values()).sort((left, right) =>
    left.namespace.localeCompare(right.namespace)
  );
  const runningPods = namespaceRows.reduce((sum, item) => sum + item.runningPods, 0);
  const readyDeployments = rawDeployments.filter(isDeploymentReady).length;
  const onlineNodes = nodes.filter((node) => node.online).length;

  return {
    generatedAt: snapshot.generatedAt,
    mode: "public-status",
    summary: {
      nodes: nodes.length,
      onlineNodes,
      controlPlaneNodes: Number(snapshot.summary?.controlPlaneNodes || 0),
      workerNodes: Number(snapshot.summary?.workerNodes || 0),
      externalWorkers: rawExternalWorkers.length,
      externalWorkersOnline: rawExternalWorkers.filter((worker) => worker.online).length,
      pods: Number(snapshot.summary?.pods || rawPods.length),
      runningPods,
      containers: Number(snapshot.summary?.containers || 0),
      deployments: rawDeployments.length,
      readyDeployments,
      namespaces: namespaceRows.length
    },
    health: {
      nodes: onlineNodes === nodes.length ? "healthy" : "attention",
      workloads: readyDeployments === rawDeployments.length ? "healthy" : "attention"
    },
    nodes,
    externalWorkers: rawExternalWorkers.map((worker) => ({
      name: worker.name,
      online: Boolean(worker.online),
      desiredState: worker.desiredState,
      actualState: worker.actualState
    })),
    namespaces: namespaceRows
  };
}

function ensureNamespace(namespaces, namespace) {
  if (!namespaces.has(namespace)) {
    namespaces.set(namespace, {
      namespace,
      pods: 0,
      runningPods: 0,
      deployments: 0,
      readyDeployments: 0,
      replicas: 0,
      readyReplicas: 0,
      restarts: 0
    });
  }
  return namespaces.get(namespace);
}

function isDeploymentReady(deployment) {
  const replicas = Number(deployment.replicas || 0);
  return replicas > 0 && Number(deployment.readyReplicas || 0) === replicas;
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 16384) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON request."));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname, options = {}) {
  const indexFile = options.publicStatus ? "/public-status.html" : "/index.html";
  const safePath = pathname === "/" ? indexFile : pathname;
  const target = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!target.startsWith(PUBLIC_DIR)) {
    return json(res, 404, { ok: false, error: "Not found." });
  }

  fs.readFile(target, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const type = CONTENT_TYPES.get(path.extname(target)) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": content.length
    });
    if (req.method === "HEAD") return res.end();
    return res.end(content);
  });
}

function start() {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`k8s-management-ui listening on ${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  createServer,
  publicClusterSnapshot,
  requireMutationConfirmation,
  readJson
};
