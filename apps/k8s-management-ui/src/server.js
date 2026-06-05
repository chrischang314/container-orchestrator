"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
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
  const adminToken = options.adminToken ?? readAdminToken(env);
  const allowMutations = !publicStatus && env.K8S_UI_ALLOW_MUTATIONS === "true" && Boolean(adminToken);
  const csrfToken = options.csrfToken || crypto.randomBytes(32).toString("base64url");
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
          mutationAuthConfigured: Boolean(adminToken),
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
        requireMutationAuth(req, body.command, {
          adminToken,
          csrfToken,
          publicStatus,
          requestedMutations: env.K8S_UI_ALLOW_MUTATIONS === "true"
        });
        requireMutationConfirmation(body.command, body, { allowMutations });
        const result = await commandRunner(body.command);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && url.pathname === "/api/action") {
        if (publicStatus) return json(res, 403, { ok: false, error: "Action endpoints are disabled in public status mode." });
        const body = await readJson(req);
        const command = actionToCommand(body.action, body);
        requireMutationAuth(req, command, {
          adminToken,
          csrfToken,
          publicStatus,
          requestedMutations: env.K8S_UI_ALLOW_MUTATIONS === "true"
        });
        requireMutationConfirmation(command, body, { allowMutations });
        const result = await commandRunner(command);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, url.pathname, { csrfToken, publicStatus });
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

function readAdminToken(env) {
  const direct = String(env.K8S_UI_ADMIN_TOKEN || "").trim();
  if (direct) return direct;

  const tokenFile = String(env.K8S_UI_ADMIN_TOKEN_FILE || "").trim();
  if (!tokenFile) return "";

  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function requireMutationAuth(req, command, options = {}) {
  if (options.publicStatus) return;

  const validation = validateKubectlCommand(command, { allowMutations: true });
  if (!validation.ok || !validation.mutating) return;

  if (!options.requestedMutations) return;

  if (!options.adminToken) {
    const error = new Error("Mutations are disabled until K8S_UI_ALLOW_MUTATIONS=true and K8S_UI_ADMIN_TOKEN are configured.");
    error.statusCode = 403;
    throw error;
  }

  if (!isJsonRequest(req)) {
    const error = new Error("Mutating requests must use application/json.");
    error.statusCode = 415;
    throw error;
  }

  if (!isSameOrigin(req)) {
    const error = new Error("Mutating browser requests must be same-origin.");
    error.statusCode = 403;
    throw error;
  }

  if (!hasValidCsrfToken(req, options.csrfToken)) {
    const error = new Error("Mutating browser requests require a valid CSRF token.");
    error.statusCode = 403;
    throw error;
  }

  if (!matchesAdminToken(extractAdminToken(req), options.adminToken)) {
    const error = new Error("Mutating requests require a valid admin token.");
    error.statusCode = 401;
    throw error;
  }
}

function extractAdminToken(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (bearer) return bearer[1].trim();
  return String(req.headers["x-k8s-ui-admin-token"] || "").trim();
}

function matchesAdminToken(provided, expected) {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && crypto.timingSafeEqual(providedBytes, expectedBytes);
}

function isJsonRequest(req) {
  return /^application\/json(?:;|$)/i.test(String(req.headers["content-type"] || ""));
}

function isSameOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return true;

  const origin = String(req.headers.origin || "").trim();
  if (origin) return sameOriginHost(origin, host);

  const referer = String(req.headers.referer || "").trim();
  if (referer) return sameOriginHost(referer, host);

  return true;
}

function hasValidCsrfToken(req, expected) {
  if (!isBrowserStylePost(req)) return true;

  const provided = String(req.headers["x-k8s-ui-csrf-token"] || "").trim();
  const cookieToken = parseCookies(req.headers.cookie || "").k8s_ui_csrf || "";
  return matchesAdminToken(provided, expected) && matchesAdminToken(cookieToken, expected);
}

function isBrowserStylePost(req) {
  return Boolean(req.headers.origin || req.headers.referer || parseCookies(req.headers.cookie || "").k8s_ui_csrf);
}

function parseCookies(value) {
  const cookies = {};
  for (const part of String(value || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const cookieValue = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(cookieValue);
  }
  return cookies;
}

function sameOriginHost(value, host) {
  try {
    return new URL(value).host.toLowerCase() === host;
  } catch {
    return false;
  }
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
  const rawPods = snapshot.pods || rawNodes.flatMap((node) => node.pods || []);
  const namespaces = new Map();
  const capacityByNode = new Map((snapshot.capacity?.nodes || []).map((node) => [node.name, node]));

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
    containerCount: Number(node.containerCount || 0),
    capacity: publicNodeCapacity(capacityByNode.get(node.name))
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
    attention: publicAttention(snapshot.attention),
    nodes,
    storage: publicStorageSnapshot(snapshot.storage),
    externalWorkers: rawExternalWorkers.map((worker) => ({
      name: worker.name,
      online: Boolean(worker.online),
      desiredState: worker.desiredState,
      actualState: worker.actualState
    })),
    namespaces: namespaceRows,
    capacity: publicCapacitySnapshot(snapshot.capacity)
  };
}

function publicCapacitySnapshot(capacity = {}) {
  const nodes = capacity.nodes || [];
  return {
    available: Boolean(capacity.available),
    source: capacity.source,
    message: capacity.available ? capacity.message : "Metrics API unavailable.",
    reason: capacity.available ? "" : capacity.reason || capacity.message || "Metrics API unavailable.",
    nodePressure: nodes.map((node) => ({
      name: node.name,
      cpuPercentUsed: node.cpu?.percentUsed ?? null,
      memoryPercentUsed: node.memory?.percentUsed ?? null,
      memorySeverity: node.memory?.severity || node.severity || "unknown"
    })),
    summary: {
      normalNodes: nodes.filter((node) => (node.memory?.severity || node.severity) === "normal").length,
      elevatedNodes: nodes.filter((node) => (node.memory?.severity || node.severity) === "elevated").length,
      highNodes: nodes.filter((node) => (node.memory?.severity || node.severity) === "high").length,
      nodeCount: Number(capacity.summary?.nodeCount || nodes.length),
      topPodCount: Number(capacity.summary?.topPodCount || 0),
      elevatedMemoryNodes: Number(capacity.summary?.elevatedMemoryNodes || 0),
      highMemoryNodes: Number(capacity.summary?.highMemoryNodes || 0),
      maxMemoryPercent: capacity.summary?.maxMemoryPercent ?? null
    }
  };
}

function publicNodeCapacity(capacity) {
  if (!capacity) return undefined;
  return {
    cpu: {
      usageDisplay: capacity.cpu?.usageDisplay || "",
      percentUsed: capacity.cpu?.percentUsed ?? null
    },
    memory: {
      usageDisplay: capacity.memory?.usageDisplay || "",
      percentUsed: capacity.memory?.percentUsed ?? null
    },
    severity: capacity.severity || "unknown"
  };
}

function publicStorageSnapshot(storage) {
  if (!storage) return undefined;
  return {
    available: Boolean(storage.available),
    partial: Boolean(storage.partial),
    source: storage.source,
    message: storage.available ? storage.message : "Storage inventory unavailable.",
    summary: {
      pvcCount: Number(storage.summary?.pvcCount || 0),
      bound: Number(storage.summary?.bound || 0),
      pending: Number(storage.summary?.pending || 0),
      lost: Number(storage.summary?.lost || 0),
      highRisk: Number(storage.summary?.highRisk || 0),
      attention: Number(storage.summary?.attention || 0),
      localPath: Number(storage.summary?.localPath || 0),
      network: Number(storage.summary?.network || 0),
      unknownStorage: Number(storage.summary?.unknownStorage || 0),
      namespaces: Number(storage.summary?.namespaces || 0),
      storageClasses: Number(storage.summary?.storageClasses || 0)
    }
  };
}

function publicAttention(attention = {}) {
  const issues = (attention.issues || [])
    .filter((item) => ["node-offline", "node-cordoned", "external-worker-offline", "deployment-unready", "pod-phase"].includes(item.kind))
    .map((item) => ({
      id: item.id,
      severity: item.severity,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      namespace: item.namespace,
      name: item.name,
      node: item.node,
      deployment: item.deployment
    }));

  return {
    total: issues.length,
    critical: issues.filter((item) => item.severity === "critical").length,
    warning: issues.filter((item) => item.severity === "warning").length,
    info: issues.filter((item) => item.severity === "info").length,
    highestSeverity: issues[0]?.severity || "healthy",
    issues
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
  return replicas === 0 || Number(deployment.readyReplicas || 0) === replicas;
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
    const isAppShell = !options.publicStatus && path.basename(target) === "index.html";
    const responseContent = isAppShell ? injectCsrfBootstrap(content, options.csrfToken) : content;
    if (isAppShell) {
      res.setHeader("Set-Cookie", `k8s_ui_csrf=${encodeURIComponent(options.csrfToken)}; Path=/; SameSite=Strict`);
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": responseContent.length
    });
    if (req.method === "HEAD") return res.end();
    return res.end(responseContent);
  });
}

function injectCsrfBootstrap(content, csrfToken) {
  const html = content.toString("utf8");
  const escapedToken = JSON.stringify(csrfToken);
  const bootstrap = `<script>
(() => {
  const csrfToken = ${escapedToken};
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    if (url.origin === window.location.origin && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      const headers = new Headers(init.headers || {});
      headers.set("X-K8S-UI-CSRF-Token", csrfToken);
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };
})();
</script>`;
  return Buffer.from(html.replace("</head>", `${bootstrap}</head>`));
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
  publicCapacitySnapshot,
  publicAttention,
  publicClusterSnapshot,
  requireMutationAuth,
  requireMutationConfirmation,
  readJson
};
