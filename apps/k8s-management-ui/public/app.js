"use strict";

const state = {
  snapshot: null,
  selectedNode: null,
  busy: false,
  pendingConfirmation: null
};

const els = {
  clusterMode: document.querySelector("[data-testid='cluster-mode']"),
  summaryStrip: document.getElementById("summaryStrip"),
  attentionPanel: document.getElementById("attentionPanel"),
  capacityStatus: document.getElementById("capacityStatus"),
  capacityNodeList: document.getElementById("capacityNodeList"),
  topPodRows: document.getElementById("topPodRows"),
  storageStatus: document.getElementById("storageStatus"),
  storageSummary: document.getElementById("storageSummary"),
  storageRows: document.getElementById("storageRows"),
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
  runCommandButton: document.getElementById("runCommandButton"),
  confirmationBackdrop: document.getElementById("confirmationBackdrop"),
  confirmationTitle: document.getElementById("confirmationTitle"),
  confirmationMode: document.getElementById("confirmationMode"),
  confirmationImpact: document.getElementById("confirmationImpact"),
  confirmationCommand: document.getElementById("confirmationCommand"),
  cancelConfirmationButton: document.getElementById("cancelConfirmationButton"),
  confirmExecutionButton: document.getElementById("confirmExecutionButton")
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
  renderAttention();
  renderCapacity();
  renderStorage();
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
    ["External", summary.externalWorkers || 0],
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

function renderAttention() {
  const attention = state.snapshot.attention || { total: 0, issues: [] };
  const issues = attention.issues || [];
  const total = Number(attention.total || issues.length);
  els.attentionPanel.className = `attention-panel ${total ? attention.highestSeverity || "warning" : "healthy"}`;

  if (!total) {
    els.attentionPanel.innerHTML = `
      <div class="attention-summary">
        <div>
          <h2>Active Attention</h2>
          <p>No active cluster issues detected.</p>
        </div>
        <span class="status-pill ready">healthy</span>
      </div>
    `;
    return;
  }

  const visibleIssues = issues.slice(0, 6);
  const remaining = total - visibleIssues.length;
  els.attentionPanel.innerHTML = `
    <div class="attention-summary">
      <div>
        <h2>Active Attention</h2>
        <p>${escapeHtml(total)} issue${total === 1 ? "" : "s"} need operator review.</p>
      </div>
      <span class="status-pill ${escapeAttr(attention.highestSeverity || "warning")}">${escapeHtml(attention.highestSeverity || "warning")}</span>
    </div>
    <div class="attention-list">
      ${visibleIssues.map(issueRow).join("")}
      ${remaining > 0 ? `<div class="attention-more">${escapeHtml(remaining)} more issue${remaining === 1 ? "" : "s"} in cluster tables</div>` : ""}
    </div>
  `;
}

function issueRow(issue) {
  const meta = issueMeta(issue);
  return `
    <article class="attention-item">
      <span class="status-pill ${escapeAttr(issue.severity)}">${escapeHtml(issue.severity)}</span>
      <div>
        <h3>${escapeHtml(issue.title)}</h3>
        <p>${escapeHtml(issue.detail)}</p>
        ${meta ? `<p class="attention-meta">${escapeHtml(meta)}</p>` : ""}
      </div>
    </article>
  `;
}

function issueMeta(issue) {
  return [
    issue.namespace && issue.name ? `${issue.namespace}/${issue.name}` : "",
    issue.deployment ? `deployment ${issue.deployment}` : "",
    issue.node ? `node ${issue.node}` : "",
    issue.container ? `container ${issue.container}` : ""
  ].filter(Boolean).join(" - ");
}

function renderCapacity() {
  const capacity = state.snapshot.capacity;
  if (!capacity) {
    els.capacityStatus.textContent = "metrics unavailable";
    els.capacityStatus.className = "status-pill pending";
    els.capacityNodeList.innerHTML = `<div class="empty-state">No capacity data available</div>`;
    els.topPodRows.innerHTML = `<tr><td colspan="5" class="empty-state">No pod metrics available</td></tr>`;
    return;
  }

  const severity = capacity.summary?.highMemoryNodes > 0
    ? "high"
    : capacity.summary?.elevatedMemoryNodes > 0
      ? "elevated"
      : "normal";
  els.capacityStatus.textContent = capacity.available ? `${capacity.summary?.nodeCount || 0} nodes` : "metrics unavailable";
  els.capacityStatus.className = `status-pill ${capacity.available ? severityClass(severity) : "pending"}`;

  const nodes = capacity.nodes || [];
  if (!nodes.length) {
    const message = capacity.message || "No node metrics available";
    els.capacityNodeList.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  } else {
    els.capacityNodeList.innerHTML = nodes.map(capacityNodeRow).join("");
  }

  const topPods = capacity.topPods || [];
  if (!topPods.length) {
    els.topPodRows.innerHTML = `<tr><td colspan="5" class="empty-state">No pod metrics available</td></tr>`;
    return;
  }

  els.topPodRows.innerHTML = topPods.map((pod) => `
    <tr>
      <td>${escapeHtml(pod.namespace)}</td>
      <td>${escapeHtml(pod.name)}</td>
      <td>${escapeHtml(pod.nodeName || "--")}</td>
      <td>${escapeHtml(pod.memory?.usageDisplay || "--")}</td>
      <td>${escapeHtml(pod.cpu?.usageDisplay || "--")}</td>
    </tr>
  `).join("");
}

function capacityNodeRow(node) {
  const memoryPercent = boundedPercent(node.memory?.percentUsed);
  const cpuPercent = boundedPercent(node.cpu?.percentUsed);
  const severity = severityClass(node.severity);
  return `
    <article class="capacity-node-row ${severity}">
      <div class="node-topline">
        <span class="node-name">${escapeHtml(node.name)}</span>
        <span class="status-pill ${severity}">${escapeHtml(node.severity || "unknown")}</span>
      </div>
      ${capacityMeter("Memory", node.memory?.usageDisplay, node.memory?.basisDisplay, memoryPercent, node.memory?.percentUsed)}
      ${capacityMeter("CPU", node.cpu?.usageDisplay, node.cpu?.basisDisplay, cpuPercent, node.cpu?.percentUsed)}
    </article>
  `;
}

function capacityMeter(label, usage, basis, width, percent) {
  const value = Number.isFinite(percent) ? `${percent}%` : "--";
  return `
    <div class="capacity-meter">
      <div class="capacity-meter-label">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(usage || "--")} / ${escapeHtml(basis || "--")} (${escapeHtml(value)})</span>
      </div>
      <div class="capacity-bar" aria-hidden="true"><span style="width: ${width}%"></span></div>
    </div>
  `;
}

function boundedPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function severityClass(severity) {
  if (severity === "high") return "blocked";
  if (severity === "elevated") return "pending";
  if (severity === "normal") return "ready";
  return "paused";
}

function renderStorage() {
  const storage = state.snapshot.storage;
  if (!storage) {
    els.storageStatus.textContent = "storage unavailable";
    els.storageStatus.className = "status-pill pending";
    els.storageSummary.innerHTML = `<div class="empty-state">No storage inventory available</div>`;
    els.storageRows.innerHTML = `<tr><td colspan="7" class="empty-state">No PVC inventory available</td></tr>`;
    return;
  }

  const summary = storage.summary || {};
  const statusClass = !storage.available
    ? "pending"
    : summary.highRisk > 0
      ? "blocked"
      : summary.attention > 0 || storage.partial
        ? "pending"
        : "ready";
  els.storageStatus.textContent = storage.available
    ? `${summary.pvcCount || 0} claims`
    : "storage unavailable";
  els.storageStatus.className = `status-pill ${statusClass}`;

  const summaryRows = [
    ["PVCs", summary.pvcCount || 0, "ready"],
    ["High risk", summary.highRisk || 0, summary.highRisk > 0 ? "blocked" : "ready"],
    ["Attention", summary.attention || 0, summary.attention > 0 ? "pending" : "ready"],
    ["Local", summary.localPath || 0, summary.localPath > 0 ? "blocked" : "ready"],
    ["Network", summary.network || 0, "ready"],
    ["Unknown", summary.unknownStorage || 0, summary.unknownStorage > 0 ? "pending" : "ready"]
  ];
  els.storageSummary.innerHTML = summaryRows.map(([label, value, tone]) => `
    <div class="storage-summary-item">
      <span>${escapeHtml(label)}</span>
      <strong class="status-pill ${tone}">${escapeHtml(value)}</strong>
    </div>
  `).join("");

  const claims = storage.claims || [];
  if (!storage.available) {
    els.storageRows.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(storage.message || "Storage inventory unavailable")}</td></tr>`;
    return;
  }
  if (!claims.length) {
    els.storageRows.innerHTML = `<tr><td colspan="7" class="empty-state">No persistent volume claims found</td></tr>`;
    return;
  }

  els.storageRows.innerHTML = claims.map((claim) => {
    const owner = (claim.ownerWorkloads || []).join(", ") || "unclaimed";
    const riskClass = storageRiskClass(claim.risk);
    const reasons = (claim.riskReasons || []).join(" ");
    return `
      <tr>
        <td>${escapeHtml(claim.namespace)}</td>
        <td>${escapeHtml(claim.name)}</td>
        <td>${escapeHtml(owner)}</td>
        <td>${escapeHtml(claim.storageClass || "--")}</td>
        <td>${escapeHtml(claim.requested || "--")}</td>
        <td><span class="status-pill ${claim.status === "Bound" ? "ready" : "pending"}">${escapeHtml(claim.status)}</span></td>
        <td>
          <span class="status-pill ${riskClass}" title="${escapeAttr(reasons)}">${escapeHtml(claim.risk || "unknown")}</span>
        </td>
      </tr>
    `;
  }).join("");
}

function storageRiskClass(risk) {
  if (risk === "high") return "blocked";
  if (risk === "attention") return "pending";
  if (risk === "normal") return "ready";
  return "paused";
}

function renderNodes() {
  const control = state.snapshot.nodes.filter((node) => node.role === "control-plane");
  const workers = state.snapshot.nodes.filter((node) => node.role !== "control-plane");
  const externalWorkers = state.snapshot.externalWorkers || [];
  els.nodeMap.innerHTML = [
    lane("Control Plane", control),
    lane("Worker Nodes", workers),
    externalWorkerLane("External Workers", externalWorkers)
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

function externalWorkerLane(title, workers) {
  const cards = workers.length
    ? workers.map(externalWorkerCard).join("")
    : `<div class="empty-state">No ${escapeHtml(title.toLowerCase())}</div>`;
  return `
    <div class="node-lane">
      <h3>${escapeHtml(title)}</h3>
      <div class="node-list">${cards}</div>
    </div>
  `;
}

function externalWorkerCard(worker) {
  const enabled = worker.desiredReplicas > 0;
  const status = worker.online ? "online" : enabled ? "pending" : "paused";
  const nextReplicas = enabled ? 0 : 1;
  const nextLabel = enabled ? "Turn off" : "Turn on";
  const lastObserved = worker.lastObservedAt ? `Last sync ${formatTime(worker.lastObservedAt)}` : "No sync yet";
  return `
    <article class="external-worker-card" data-testid="external-worker-${escapeAttr(worker.name)}">
      <div class="node-topline">
        <span class="node-name">${escapeHtml(worker.name)}</span>
        <span class="status-pill ${status}">${escapeHtml(worker.actualState || status)}</span>
      </div>
      <div class="node-meta">
        <span>external llm worker</span>
        <span>${escapeHtml(worker.namespace)}/${escapeHtml(worker.deployment)}</span>
      </div>
      <div class="node-stats">
        <span>${escapeHtml(worker.readyReplicas)}/${escapeHtml(worker.desiredReplicas)} switch replicas</span>
        <span class="status-pill ${enabled ? "ready" : "paused"}">desired ${escapeHtml(worker.desiredState)}</span>
      </div>
      <div class="node-meta">
        <span>${escapeHtml(lastObserved)}</span>
      </div>
      <div class="node-actions">
        <button type="button" data-action="scale-deployment" data-namespace="${escapeAttr(worker.namespace)}" data-name="${escapeAttr(worker.deployment)}" data-replicas="${nextReplicas}">${nextLabel}</button>
        <button type="button" data-action="rollout-status" data-namespace="${escapeAttr(worker.namespace)}" data-name="${escapeAttr(worker.deployment)}">Status</button>
      </div>
    </article>
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

async function runCommand(command, options = {}) {
  const detail = commandDetail(command);
  if (detail.mutating && !options.confirmed) {
    return showConfirmation({
      title: "Confirm Command",
      impact: "Typed command changes cluster state.",
      command: detail.command,
      onConfirm: () => runCommand(command, { confirmed: true })
    });
  }

  setBusy(true, "running");
  els.commandOutput.textContent = "";
  try {
    const result = await fetchJson("/api/command", {
      method: "POST",
      body: JSON.stringify({ command, confirmed: options.confirmed === true })
    });
    showCommandResult(result);
    if (result.mutating) await refreshCluster();
  } catch (error) {
    els.commandOutput.textContent = error.message;
  } finally {
    setBusy(false, "idle");
  }
}

async function runAction(action, payload, options = {}) {
  const detail = actionDetail(action, payload);
  if (detail.mutating && !options.confirmed) {
    return showConfirmation({
      title: "Confirm Action",
      impact: detail.impact,
      command: detail.command,
      onConfirm: () => runAction(action, payload, { confirmed: true })
    });
  }

  setBusy(true, "running");
  els.commandOutput.textContent = "";
  try {
    const result = await fetchJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ action, ...payload, confirmed: options.confirmed === true })
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
  const status = result.ok ? "succeeded" : "failed";
  const kind = result.mutating ? "mutating" : "read-only";
  const out = [
    `[${formatTime(new Date().toISOString())}] ${kind} command ${status}`,
    `$ ${result.command}`,
    `receipt: ${result.ok ? "completed" : "failed"} | ${result.mutating ? "mutating" : "read-only"} | code ${result.code}`,
    result.stdout || "",
    result.stderr ? `[stderr]\n${result.stderr}` : ""
  ].filter(Boolean).join("\n");
  els.commandOutput.textContent = out;
}

function showConfirmation(detail) {
  state.pendingConfirmation = detail;
  els.confirmationTitle.textContent = detail.title;
  els.confirmationMode.textContent = "mutating";
  els.confirmationImpact.textContent = detail.impact;
  els.confirmationCommand.textContent = detail.command;
  els.confirmationBackdrop.classList.remove("hidden");
  els.confirmExecutionButton.focus();
}

function clearConfirmation() {
  state.pendingConfirmation = null;
  els.confirmationBackdrop.classList.add("hidden");
}

async function confirmPendingExecution() {
  const pending = state.pendingConfirmation;
  if (!pending) return;
  clearConfirmation();
  await pending.onConfirm();
}

function actionDetail(action, payload = {}) {
  const namespace = payload.namespace || "default";
  const nodeName = payload.nodeName || "";
  const name = payload.name || "";
  switch (action) {
    case "describe-node":
      return {
        mutating: false,
        command: `kubectl describe node ${nodeName}`,
        impact: `Read node ${nodeName}.`
      };
    case "cordon-node":
      return {
        mutating: true,
        command: `kubectl cordon ${nodeName}`,
        impact: `Mark node ${nodeName} unschedulable.`
      };
    case "uncordon-node":
      return {
        mutating: true,
        command: `kubectl uncordon ${nodeName}`,
        impact: `Allow new workloads on node ${nodeName}.`
      };
    case "restart-deployment":
      return {
        mutating: true,
        command: `kubectl rollout restart deployment/${name} -n ${namespace}`,
        impact: `Restart deployment ${namespace}/${name}.`
      };
    case "rollout-status":
      return {
        mutating: false,
        command: `kubectl rollout status deployment/${name} -n ${namespace}`,
        impact: `Read rollout status for ${namespace}/${name}.`
      };
    case "scale-deployment":
      return {
        mutating: true,
        command: `kubectl scale deployment/${name} -n ${namespace} --replicas=${payload.replicas}`,
        impact: `Scale deployment ${namespace}/${name} to ${payload.replicas} replicas.`
      };
    default:
      return {
        mutating: false,
        command: action,
        impact: "Run selected action."
      };
  }
}

function commandDetail(command) {
  const clean = String(command || "").trim();
  const parts = clean.split(/\s+/);
  const verb = parts[0] === "kubectl" ? parts[1] : "";
  const subcommand = parts[2];
  const mutating =
    ["cordon", "drain", "scale", "uncordon"].includes(verb) ||
    (verb === "rollout" && subcommand === "restart");

  return {
    mutating,
    command: clean,
    impact: mutating ? "Change cluster state." : "Read cluster state."
  };
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
  els.confirmExecutionButton.disabled = busy;
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
els.cancelConfirmationButton.addEventListener("click", clearConfirmation);
els.confirmExecutionButton.addEventListener("click", confirmPendingExecution);
els.confirmationBackdrop.addEventListener("click", (event) => {
  if (event.target === els.confirmationBackdrop) clearConfirmation();
});
els.nodeMap.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) {
    runAction(button.dataset.action, {
      nodeName: button.dataset.node,
      namespace: button.dataset.namespace,
      name: button.dataset.name,
      replicas: button.dataset.replicas
    });
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
