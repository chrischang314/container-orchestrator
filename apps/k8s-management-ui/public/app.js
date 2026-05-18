"use strict";

const state = {
  snapshot: null,
  selectedNode: null,
  busy: false
};

const els = {
  clusterMode: document.querySelector("[data-testid='cluster-mode']"),
  summaryStrip: document.getElementById("summaryStrip"),
  nodeMap: document.getElementById("nodeMap"),
  lastUpdated: document.getElementById("lastUpdated"),
  selectedNodeLabel: document.getElementById("selectedNodeLabel"),
  containerRows: document.getElementById("containerRows"),
  deploymentCount: document.getElementById("deploymentCount"),
  deploymentList: document.getElementById("deploymentList"),
  commandForm: document.getElementById("commandForm"),
  commandInput: document.getElementById("commandInput"),
  commandOutput: document.getElementById("commandOutput"),
  commandState: document.getElementById("commandState"),
  refreshButton: document.getElementById("refreshButton"),
  runCommandButton: document.getElementById("runCommandButton")
};

async function refreshCluster() {
  setBusy(true, "refreshing");
  try {
    const snapshot = await fetchJson("/api/cluster");
    state.snapshot = snapshot;
    if (!state.selectedNode || !snapshot.nodes.some((node) => node.name === state.selectedNode)) {
      state.selectedNode = snapshot.nodes[0]?.name || null;
    }
    els.clusterMode.textContent = `${snapshot.summary.onlineNodes}/${snapshot.summary.nodes} nodes online`;
    render();
  } catch (error) {
    els.commandOutput.textContent = error.message;
    els.clusterMode.textContent = "unreachable";
  } finally {
    setBusy(false, "idle");
  }
}

function render() {
  if (!state.snapshot) return;
  renderSummary();
  renderNodes();
  renderContainers();
  renderDeployments();
}

function renderSummary() {
  const summary = state.snapshot.summary;
  const metrics = [
    ["Nodes", summary.nodes],
    ["Online", summary.onlineNodes],
    ["Control", summary.controlPlaneNodes],
    ["Workers", summary.workerNodes],
    ["Pods", summary.pods],
    ["Containers", summary.containers]
  ];

  els.summaryStrip.innerHTML = metrics.map(([label, value]) => `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
  els.lastUpdated.textContent = formatTime(state.snapshot.generatedAt);
}

function renderNodes() {
  const control = state.snapshot.nodes.filter((node) => node.role === "control-plane");
  const workers = state.snapshot.nodes.filter((node) => node.role !== "control-plane");
  els.nodeMap.innerHTML = [
    lane("Control Plane", control),
    lane("Worker Nodes", workers)
  ].join("");
}

function lane(title, nodes) {
  const cards = nodes.length
    ? nodes.map(nodeCard).join("")
    : `<div class="empty-state">No ${escapeHtml(title.toLowerCase())}</div>`;
  return `
    <div class="node-lane">
      <h3>${escapeHtml(title)}</h3>
      <div class="node-list">${cards}</div>
    </div>
  `;
}

function nodeCard(node) {
  const selected = node.name === state.selectedNode ? " selected" : "";
  const status = node.online ? "online" : "offline";
  const schedulable = node.schedulable ? "ready" : "paused";
  const nextAction = node.schedulable ? "cordon-node" : "uncordon-node";
  const nextLabel = node.schedulable ? "Cordon" : "Uncordon";
  return `
    <article class="node-card${selected}" data-node="${escapeAttr(node.name)}" data-testid="node-card-${escapeAttr(node.name)}">
      <div class="node-topline">
        <span class="node-name">${escapeHtml(node.name)}</span>
        <span class="status-pill ${status}">${status}</span>
      </div>
      <div class="node-meta">
        <span>${escapeHtml(node.role)}</span>
        <span>${escapeHtml(node.kubeletVersion || "unknown")}</span>
        <span>${escapeHtml(node.architecture || "arch")}</span>
      </div>
      <div class="node-stats">
        <span>${node.podCount} pods / ${node.containerCount} containers</span>
        <span class="status-pill ${schedulable}">${node.schedulable ? "schedulable" : "cordoned"}</span>
      </div>
      <div class="node-actions">
        <button type="button" data-action="describe-node" data-node="${escapeAttr(node.name)}">Describe</button>
        <button type="button" data-action="${nextAction}" data-node="${escapeAttr(node.name)}">${nextLabel}</button>
      </div>
    </article>
  `;
}

function renderContainers() {
  const node = state.snapshot.nodes.find((item) => item.name === state.selectedNode);
  els.selectedNodeLabel.textContent = node ? node.name : "--";
  const rows = node?.containers || [];

  if (!rows.length) {
    els.containerRows.innerHTML = `<tr><td colspan="6" class="empty-state">No containers on selected node</td></tr>`;
    return;
  }

  els.containerRows.innerHTML = rows.map((container) => `
    <tr>
      <td>${escapeHtml(container.namespace)}</td>
      <td>${escapeHtml(container.pod)}</td>
      <td>${escapeHtml(container.name)}</td>
      <td class="image-cell">${escapeHtml(container.image)}</td>
      <td><span class="status-pill ${container.ready ? "ready" : "pending"}">${escapeHtml(container.state)}</span></td>
      <td>${escapeHtml(container.restarts)}</td>
    </tr>
  `).join("");
}

function renderDeployments() {
  const deployments = state.snapshot.deployments;
  els.deploymentCount.textContent = `${deployments.length} total`;
  if (!deployments.length) {
    els.deploymentList.innerHTML = `<div class="empty-state">No deployments found</div>`;
    return;
  }

  els.deploymentList.innerHTML = deployments.map((deployment) => {
    const ready = deployment.readyReplicas === deployment.replicas && deployment.replicas > 0;
    return `
      <article class="deployment-row">
        <div class="deployment-topline">
          <span class="deployment-name">${escapeHtml(deployment.name)}</span>
          <span class="status-pill ${ready ? "ready" : "pending"}">${deployment.readyReplicas}/${deployment.replicas}</span>
        </div>
        <div class="deployment-meta">
          <span>${escapeHtml(deployment.namespace)}</span>
          <span>${deployment.availableReplicas} available</span>
          <span>${deployment.updatedReplicas} updated</span>
        </div>
        <div class="deployment-actions">
          <button type="button" data-action="rollout-status" data-namespace="${escapeAttr(deployment.namespace)}" data-name="${escapeAttr(deployment.name)}">Status</button>
          <button type="button" data-action="restart-deployment" data-namespace="${escapeAttr(deployment.namespace)}" data-name="${escapeAttr(deployment.name)}">Restart</button>
        </div>
      </article>
    `;
  }).join("");
}

async function submitCommand(event) {
  event.preventDefault();
  await runCommand(els.commandInput.value);
}

async function runCommand(command) {
  setBusy(true, "running");
  els.commandOutput.textContent = "";
  try {
    const result = await fetchJson("/api/command", {
      method: "POST",
      body: JSON.stringify({ command })
    });
    showCommandResult(result);
    if (result.mutating) await refreshCluster();
  } catch (error) {
    els.commandOutput.textContent = error.message;
  } finally {
    setBusy(false, "idle");
  }
}

async function runAction(action, payload) {
  setBusy(true, "running");
  els.commandOutput.textContent = "";
  try {
    const result = await fetchJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ action, ...payload })
    });
    showCommandResult(result);
    if (result.mutating) await refreshCluster();
  } catch (error) {
    els.commandOutput.textContent = error.message;
  } finally {
    setBusy(false, "idle");
  }
}

function showCommandResult(result) {
  const out = [
    `$ ${result.command}`,
    result.stdout || "",
    result.stderr ? `[stderr]\n${result.stderr}` : ""
  ].filter(Boolean).join("\n");
  els.commandOutput.textContent = out;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.stderr || `Request failed with ${response.status}`);
  }
  return data;
}

function setBusy(busy, label) {
  state.busy = busy;
  els.commandState.textContent = label;
  els.refreshButton.disabled = busy;
  els.runCommandButton.disabled = busy;
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.disabled = busy;
  });
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch {
    return "--";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

els.refreshButton.addEventListener("click", refreshCluster);
els.commandForm.addEventListener("submit", submitCommand);
els.nodeMap.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) {
    runAction(button.dataset.action, { nodeName: button.dataset.node });
    return;
  }
  const card = event.target.closest(".node-card");
  if (card) {
    state.selectedNode = card.dataset.node;
    render();
  }
});
els.deploymentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  runAction(button.dataset.action, {
    namespace: button.dataset.namespace,
    name: button.dataset.name
  });
});

refreshCluster();
window.setInterval(refreshCluster, 15000);
