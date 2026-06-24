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
    ["Overall", summary.overall],
    ["Control Plane", summary.controlPlane],
    ["Workloads", summary.workloads],
    ["Storage", summary.storage],
    ["Capacity", summary.capacity],
    ["Automation", summary.externalAutomation]
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
  const attention = state.snapshot.attention || { total: 0, byKind: {} };
  const total = Number(attention.total || 0);
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
      ${issueGroupRows(attention.byKind || {}).join("")}
    </div>
  `;
}

function issueGroupRows(byKind) {
  return Object.entries(byKind)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([kind, count]) => issueRow(kind, count));
}

function issueRow(kind, count) {
  return `
    <article class="attention-item">
      <span class="status-pill warning">${escapeHtml(count)}</span>
      <div>
        <h3>${escapeHtml(kindLabel(kind))}</h3>
        <p>Details are intentionally hidden from the public status view.</p>
      </div>
    </article>
  `;
}

function renderNodes() {
  const health = state.snapshot.health || {};
  const capacity = state.snapshot.capacity || {};
  const storage = state.snapshot.storage || {};
  const cards = [
    ["Control plane", health.nodes || "unknown"],
    ["Workloads", health.workloads || "unknown"],
    ["Capacity", capacity.level || health.capacity || "unknown"],
    ["Storage", storage.risk?.high ? "high risk" : storage.risk?.attention ? "attention" : health.storage || "unknown"]
  ];

  els.nodeList.innerHTML = cards.map(([label, value]) => `
    <article class="public-node-card">
      <div class="node-topline">
        <span class="node-name">${escapeHtml(label)}</span>
        <span class="status-pill ${statusClass(value)}">${escapeHtml(value)}</span>
      </div>
      <div class="node-meta">
        <span>Public summary</span>
        <span>Inventory hidden</span>
      </div>
    </article>
  `).join("");
}

function renderNamespaces() {
  els.namespaceCount.textContent = "hidden";
  const storage = state.snapshot.storage || {};
  const capacity = state.snapshot.capacity || {};
  els.namespaceRows.innerHTML = `
    <tr>
      <td>Storage posture</td>
      <td><span class="status-pill ${storage.risk?.high ? "pending" : "ready"}">${storage.available ? "available" : "unavailable"}</span></td>
      <td><span class="status-pill ${storage.risk?.attention ? "pending" : "ready"}">${storage.risk?.attention ? "attention" : "normal"}</span></td>
      <td><span class="status-pill ${storage.profile?.hasPendingClaims ? "pending" : "ready"}">${storage.profile?.hasPendingClaims ? "pending" : "settled"}</span></td>
      <td>Hidden</td>
    </tr>
    <tr>
      <td>Capacity posture</td>
      <td><span class="status-pill ${statusClass(capacity.level)}">${escapeHtml(capacity.level || "unknown")}</span></td>
      <td><span class="status-pill ${capacity.pressure?.high ? "pending" : "ready"}">${capacity.pressure?.high ? "high" : "not high"}</span></td>
      <td><span class="status-pill ${capacity.pressure?.elevated ? "pending" : "ready"}">${capacity.pressure?.elevated ? "elevated" : "normal"}</span></td>
      <td>Hidden</td>
    </tr>
  `;
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

function kindLabel(kind) {
  return {
    node: "Node availability",
    workload: "Workload readiness",
    storage: "Storage posture",
    capacity: "Capacity posture",
    externalAutomation: "External automation"
  }[kind] || "Cluster attention";
}

function statusClass(value) {
  const text = String(value || "").toLowerCase();
  if (["healthy", "normal", "available"].includes(text)) return "ready";
  if (["attention", "elevated", "high risk", "high", "critical"].includes(text)) return "pending";
  return "paused";
}

els.refreshButton.addEventListener("click", refreshCluster);
refreshCluster();
window.setInterval(refreshCluster, 15000);
