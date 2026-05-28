"use strict";

const state = {
  snapshot: null,
  busy: false
};

const els = {
  clusterMode: document.querySelector("[data-testid='cluster-mode']"),
  summaryStrip: document.getElementById("summaryStrip"),
  attentionPanel: document.getElementById("attentionPanel"),
  lastUpdated: document.getElementById("lastUpdated"),
  namespaceCount: document.getElementById("namespaceCount"),
  namespaceRows: document.getElementById("namespaceRows"),
  nodeList: document.getElementById("nodeList"),
  refreshButton: document.getElementById("refreshButton")
};

async function refreshCluster() {
  setBusy(true);
  try {
    const snapshot = await fetchJson("/api/cluster");
    state.snapshot = snapshot;
    const nodeHealth = snapshot.health?.nodes === "healthy" ? "healthy" : "attention";
    const workloadHealth = snapshot.health?.workloads === "healthy" ? "healthy" : "attention";
    els.clusterMode.textContent = nodeHealth === "healthy" && workloadHealth === "healthy"
      ? "healthy"
      : "attention";
    render();
  } catch (error) {
    els.clusterMode.textContent = "unreachable";
    els.summaryStrip.innerHTML = `<div class="metric"><span>Status</span><strong>Offline</strong></div>`;
    els.attentionPanel.className = "attention-panel critical";
    els.attentionPanel.innerHTML = `
      <div class="attention-summary">
        <div>
          <h2>Active Attention</h2>
          <p>${escapeHtml(error.message)}</p>
        </div>
        <span class="status-pill critical">offline</span>
      </div>
    `;
    els.nodeList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    els.namespaceRows.innerHTML = `<tr><td colspan="5" class="empty-state">Cluster status unavailable</td></tr>`;
  } finally {
    setBusy(false);
  }
}

function render() {
  if (!state.snapshot) return;
  renderSummary();
  renderAttention();
  renderNodes();
  renderNamespaces();
}

function renderSummary() {
  const summary = state.snapshot.summary;
  const metrics = [
    ["Nodes", `${summary.onlineNodes}/${summary.nodes}`],
    ["Pods", `${summary.runningPods}/${summary.pods}`],
    ["Deployments", `${summary.readyDeployments}/${summary.deployments}`],
    ["Namespaces", summary.namespaces],
    ["Workers", summary.workerNodes],
    ["External", `${summary.externalWorkersOnline || 0}/${summary.externalWorkers || 0}`],
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
          <p>No public cluster status issues detected.</p>
        </div>
        <span class="status-pill ready">healthy</span>
      </div>
    `;
    return;
  }

  els.attentionPanel.innerHTML = `
    <div class="attention-summary">
      <div>
        <h2>Active Attention</h2>
        <p>${escapeHtml(total)} sanitized issue${total === 1 ? "" : "s"} visible from public status.</p>
      </div>
      <span class="status-pill ${escapeAttr(attention.highestSeverity || "warning")}">${escapeHtml(attention.highestSeverity || "warning")}</span>
    </div>
    <div class="attention-list">
      ${issues.slice(0, 4).map(issueRow).join("")}
    </div>
  `;
}

function issueRow(issue) {
  return `
    <article class="attention-item">
      <span class="status-pill ${escapeAttr(issue.severity)}">${escapeHtml(issue.severity)}</span>
      <div>
        <h3>${escapeHtml(issue.title)}</h3>
        <p>${escapeHtml(issue.detail)}</p>
      </div>
    </article>
  `;
}

function renderNodes() {
  const nodes = state.snapshot.nodes || [];
  if (!nodes.length) {
    els.nodeList.innerHTML = `<div class="empty-state">No node data available</div>`;
    return;
  }

  els.nodeList.innerHTML = nodes.map((node) => {
    const status = node.online ? "online" : "offline";
    const schedulable = node.schedulable ? "ready" : "paused";
    return `
      <article class="public-node-card">
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
          <span>${escapeHtml(node.podCount)} pods / ${escapeHtml(node.containerCount)} containers</span>
          <span class="status-pill ${schedulable}">${node.schedulable ? "schedulable" : "cordoned"}</span>
        </div>
      </article>
    `;
  }).join("");
}

function renderNamespaces() {
  const namespaces = state.snapshot.namespaces || [];
  els.namespaceCount.textContent = `${namespaces.length} total`;

  if (!namespaces.length) {
    els.namespaceRows.innerHTML = `<tr><td colspan="5" class="empty-state">No namespace data available</td></tr>`;
    return;
  }

  els.namespaceRows.innerHTML = namespaces.map((item) => {
    const deploymentsReady = item.readyDeployments === item.deployments;
    const replicasReady = item.readyReplicas === item.replicas;
    return `
      <tr>
        <td>${escapeHtml(item.namespace)}</td>
        <td><span class="status-pill ${item.runningPods === item.pods ? "ready" : "pending"}">${escapeHtml(item.runningPods)}/${escapeHtml(item.pods)}</span></td>
        <td><span class="status-pill ${deploymentsReady ? "ready" : "pending"}">${escapeHtml(item.readyDeployments)}/${escapeHtml(item.deployments)}</span></td>
        <td><span class="status-pill ${replicasReady ? "ready" : "pending"}">${escapeHtml(item.readyReplicas)}/${escapeHtml(item.replicas)}</span></td>
        <td>${escapeHtml(item.restarts)}</td>
      </tr>
    `;
  }).join("");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
  return data;
}

function setBusy(busy) {
  state.busy = busy;
  els.refreshButton.disabled = busy;
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
refreshCluster();
window.setInterval(refreshCluster, 15000);
