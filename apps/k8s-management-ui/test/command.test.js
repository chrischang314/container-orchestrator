"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  actionToCommand,
  splitCommand,
  validateKubectlCommand
} = require("../src/command");

test("splitCommand preserves quoted arguments", () => {
  assert.deepEqual(splitCommand("kubectl get pods -n 'kube system'"), [
    "kubectl",
    "get",
    "pods",
    "-n",
    "kube system"
  ]);
});

test("validateKubectlCommand allows read-only kubectl commands", () => {
  const result = validateKubectlCommand("kubectl get pods -A");
  assert.equal(result.ok, true);
  assert.equal(result.mutating, false);
  assert.deepEqual(result.args, ["get", "pods", "-A"]);
});

test("validateKubectlCommand blocks shell operators", () => {
  const result = validateKubectlCommand("kubectl get pods; cat /var/run/secrets/token");
  assert.equal(result.ok, false);
  assert.match(result.reason, /Shell operators/);
});

test("validateKubectlCommand blocks mutating commands unless enabled", () => {
  const blocked = validateKubectlCommand("kubectl cordon mac-mini-worker");
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /disabled/);

  const allowed = validateKubectlCommand("kubectl cordon mac-mini-worker", {
    allowMutations: true
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.mutating, true);
});

test("validateKubectlCommand rejects kubeconfig overrides", () => {
  const result = validateKubectlCommand("kubectl get pods --kubeconfig /tmp/admin");
  assert.equal(result.ok, false);
  assert.match(result.reason, /service account/);
});

test("actionToCommand creates stable kubectl commands", () => {
  assert.equal(actionToCommand("describe-node", { nodeName: "rpi5-control" }), "kubectl describe node rpi5-control");
  assert.equal(
    actionToCommand("restart-deployment", { namespace: "default", name: "k8s-management-ui-web" }),
    "kubectl rollout restart deployment/k8s-management-ui-web -n default"
  );
  assert.equal(
    actionToCommand("scale-deployment", { namespace: "local-llm", name: "chris-pc-2-ollama-switch", replicas: 0 }),
    "kubectl scale deployment/chris-pc-2-ollama-switch -n local-llm --replicas=0"
  );
});

test("actionToCommand rejects names with spaces", () => {
  assert.throws(
    () => actionToCommand("describe-node", { nodeName: "bad node" }),
    /unsupported characters/
  );
});
