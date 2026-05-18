"use strict";

const { spawn } = require("node:child_process");

const READ_ONLY_VERBS = new Set([
  "api-resources",
  "api-versions",
  "auth",
  "cluster-info",
  "describe",
  "get",
  "logs",
  "top",
  "version"
]);

const MUTATING_VERBS = new Set(["cordon", "drain", "rollout", "scale", "uncordon"]);

const BLOCKED_FLAGS = new Set([
  "--as",
  "--as-group",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--context",
  "--kubeconfig",
  "--password",
  "--server",
  "--token",
  "--username"
]);

const NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

function splitCommand(input) {
  const source = String(input || "").trim();
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const ch of source) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) {
    const err = new Error("Unclosed quote in command.");
    err.code = "COMMAND_PARSE";
    throw err;
  }
  if (current) args.push(current);
  return args;
}

function flagName(arg) {
  if (!arg.startsWith("--")) return null;
  return arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
}

function validateKubectlCommand(input, options = {}) {
  const allowMutations = Boolean(options.allowMutations);
  const source = String(input || "").trim();

  if (!source) {
    return { ok: false, reason: "Enter a kubectl command." };
  }

  if (/[\r\n;&|><`$]/.test(source)) {
    return { ok: false, reason: "Shell operators are not supported." };
  }

  let parts;
  try {
    parts = splitCommand(source);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  if (parts[0] !== "kubectl") {
    return { ok: false, reason: "Commands must start with kubectl." };
  }

  const args = parts.slice(1);
  const verb = args[0];
  if (!verb) {
    return { ok: false, reason: "Add a kubectl verb." };
  }

  for (const arg of args) {
    const blocked = flagName(arg);
    if (blocked && BLOCKED_FLAGS.has(blocked)) {
      return { ok: false, reason: `${blocked} is managed by the service account.` };
    }
  }

  if (READ_ONLY_VERBS.has(verb)) {
    if (verb === "auth" && !["can-i", "whoami"].includes(args[1])) {
      return { ok: false, reason: "Only kubectl auth can-i and auth whoami are allowed." };
    }
    return { ok: true, args, mutating: false };
  }

  if (!MUTATING_VERBS.has(verb)) {
    return { ok: false, reason: `${verb} is not in the allowed command set.` };
  }

  if (verb === "rollout" && !["restart", "status", "history"].includes(args[1])) {
    return { ok: false, reason: "Only rollout restart, status, and history are allowed." };
  }

  const mutating = !(verb === "rollout" && ["status", "history"].includes(args[1]));
  if (mutating && !allowMutations) {
    return { ok: false, reason: "Mutating commands are disabled for this deployment." };
  }

  return { ok: true, args, mutating };
}

function assertName(value, field) {
  const name = String(value || "");
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return name;
}

function actionToCommand(action, payload = {}) {
  switch (action) {
    case "describe-node":
      return `kubectl describe node ${assertName(payload.nodeName, "nodeName")}`;
    case "cordon-node":
      return `kubectl cordon ${assertName(payload.nodeName, "nodeName")}`;
    case "uncordon-node":
      return `kubectl uncordon ${assertName(payload.nodeName, "nodeName")}`;
    case "restart-deployment": {
      const namespace = assertName(payload.namespace || "default", "namespace");
      const name = assertName(payload.name, "name");
      return `kubectl rollout restart deployment/${name} -n ${namespace}`;
    }
    case "rollout-status": {
      const namespace = assertName(payload.namespace || "default", "namespace");
      const name = assertName(payload.name, "name");
      return `kubectl rollout status deployment/${name} -n ${namespace}`;
    }
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

function truncateOutput(value, limit = 20000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[output truncated at ${limit} characters]`;
}

function runKubectl(input, options = {}) {
  const validation = validateKubectlCommand(input, {
    allowMutations: options.allowMutations
  });

  if (!validation.ok) {
    return Promise.resolve({
      ok: false,
      code: 400,
      command: String(input || "").trim(),
      stdout: "",
      stderr: validation.reason,
      mutating: false
    });
  }

  if (options.demoMode) {
    return Promise.resolve({
      ok: true,
      code: 0,
      command: String(input || "").trim(),
      stdout: demoCommandOutput(validation.args),
      stderr: "",
      mutating: validation.mutating
    });
  }

  const spawnImpl = options.spawnImpl || spawn;
  const kubectlPath = options.kubectlPath || process.env.KUBECTL_PATH || "kubectl";
  const timeoutMs = Number(options.timeoutMs || process.env.K8S_UI_COMMAND_TIMEOUT_MS || 15000);

  return new Promise((resolve) => {
    const child = spawnImpl(kubectlPath, validation.args, {
      shell: false,
      windowsHide: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        code: 124,
        command: String(input || "").trim(),
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(`${stderr}\nCommand timed out after ${timeoutMs}ms.`.trim()),
        mutating: validation.mutating
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: 500,
        command: String(input || "").trim(),
        stdout: "",
        stderr: error.message,
        mutating: validation.mutating
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        command: String(input || "").trim(),
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        mutating: validation.mutating
      });
    });
  });
}

function demoCommandOutput(args) {
  const verb = args[0];
  if (verb === "get" && args.includes("nodes")) {
    return [
      "NAME              STATUS                     ROLES           AGE   VERSION",
      "rpi5-control      Ready                      control-plane   29d   v1.34.1+k3s1",
      "mac-mini-worker   Ready,SchedulingDisabled   worker          28d   v1.34.1+k3s1"
    ].join("\n");
  }
  if (verb === "describe" && args[1] === "node") {
    return `Name:               ${args[2]}\nRoles:              worker\nConditions:\n  Ready             True`;
  }
  if (verb === "rollout" && args[1] === "restart") {
    return "deployment.apps/k8s-management-ui-web restarted";
  }
  return `demo kubectl ${args.join(" ")} completed`;
}

module.exports = {
  actionToCommand,
  splitCommand,
  runKubectl,
  validateKubectlCommand
};
