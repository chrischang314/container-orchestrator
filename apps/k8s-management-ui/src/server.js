"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { actionToCommand, runKubectl } = require("./command");
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
  const allowMutations = String(env.K8S_UI_ALLOW_MUTATIONS || "false").toLowerCase() === "true";
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
          time: new Date().toISOString()
        });
      }

      if (req.method === "GET" && url.pathname === "/api/cluster") {
        const snapshot = await client.snapshot();
        return json(res, 200, snapshot);
      }

      if (req.method === "POST" && url.pathname === "/api/command") {
        const body = await readJson(req);
        const result = await commandRunner(body.command);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && url.pathname === "/api/action") {
        const body = await readJson(req);
        const command = actionToCommand(body.action, body);
        const result = await commandRunner(command);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, url.pathname);
      }

      return json(res, 405, { ok: false, error: "Method not allowed." });
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message });
    }
  });
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

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
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
  readJson
};
