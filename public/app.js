const state = {
  settings: null,
  currentVideo: null,
  cues: [], // { scent: 0-3, time: seconds, duration: seconds }
  selectedCue: null,
  firedThisPass: new Set(),
};

// ---------- helpers ----------
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2400);
}

// each browser gets its own id, so each person has their own devices and timelines
function clientId() {
  let id = localStorage.getItem("ascentClientId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("ascentClientId", id);
  }
  return id;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "x-client-id": clientId(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// ---------- tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- settings ----------
async function loadSettings() {
  const s = await api("/api/settings");
  state.settings = s;
  renderScentSettings(s.scents);
  renderScentButtons(s.scents);
  updateStatus(s.loggedIn);
}

// "loggedIn" now means: the ASCENT server is connected to eWeLink (done once by the admin)
function updateStatus(serverReady) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  dot.classList.remove("on", "off");
  if (serverReady) {
    dot.classList.add("on");
    text.textContent = "server ready";
  } else {
    dot.classList.add("off");
    text.textContent = "server not connected";
  }
}

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const scents = collectScentSettings();
  if (scents.some((scent) => !scent.deviceId.trim())) {
    toast("Enter a device ID for each device before saving");
    return;
  }
  try {
    const { config } = await api("/api/settings", { method: "POST", body: JSON.stringify({ scents }) });
    state.settings.scents = config.scents;
    toast("Settings saved");
    renderScentSettings(config.scents);
    renderScentButtons(config.scents);
    renderTracks();
  } catch (err) {
    toast("Couldn't save: " + err.message);
  }
});

// ---------- scent settings (settings tab) ----------
function renderScentSettings(scents) {
  const wrap = document.getElementById("scentSettingsList");
  wrap.innerHTML = "";
  scents.forEach((scent, i) => {
    const row = document.createElement("div");
    row.className = "scent-setting";
    row.innerHTML = `
      <input type="color" value="${escapeHtml(scent.color)}" data-field="color" />
      <label>Name
        <input type="text" value="${escapeHtml(scent.name)}" data-field="name" />
      </label>
      <label>Device
        <input type="text" value="${escapeHtml(scent.deviceId)}" data-field="deviceId" placeholder="Enter your device ID" />
      </label>
      <button type="button" class="delete-scent-btn" data-delete-scent="${i}" aria-label="Delete ${escapeHtml(scent.name)}">Delete</button>
      <div class="field-row">
        <label>Outlet
          <select data-field="outlet">
            ${[0, 1, 2, 3].map((outlet) => `<option value="${outlet}" ${Number(scent.outlet) === outlet ? "selected" : ""}>${outlet} — Scent ${outlet + 1}</option>`).join("")}
          </select>
        </label>
        <label>Pulse (ms)
          <input type="number" min="200" step="100" value="${escapeHtml(scent.pulseMs)}" data-field="pulseMs" />
        </label>
      </div>
    `;
    row.dataset.index = i;
    wrap.appendChild(row);
  });
}

document.getElementById("addScentBtn").addEventListener("click", () => {
  const scents = collectScentSettings();
  const deviceIdInput = document.getElementById("newDeviceId");
  const deviceId = deviceIdInput.value.trim();
  if (!deviceId) {
    toast("Enter a device ID first");
    deviceIdInput.focus();
    return;
  }

  const colors = ["#a8d5ba", "#bcdfc0", "#cfe8cd", "#e2f0da"];
  for (let outlet = 0; outlet < 4; outlet += 1) {
    scents.push({
      name: `Scent ${outlet + 1}`,
      color: colors[outlet],
      deviceId,
      outlet,
      pulseMs: 3000,
    });
  }
  deviceIdInput.value = "";
  renderScentSettings(scents);
  toast("Added four scent channels");
});

document.getElementById("scentSettingsList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-scent]");
  if (!button) return;
  await deleteScent(Number(button.dataset.deleteScent));
});

async function deleteScent(index) {
  const scents = collectScentSettings();
  const scent = scents[index];
  if (!scent) return;
  if (!window.confirm(`Delete "${scent.name}"? Its timeline cues will also be removed.`)) return;

  try {
    scents.splice(index, 1);
    const { config } = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ scents, removedScentIndex: index }),
    });
    const selectedCue = state.selectedCue === null ? null : state.cues[state.selectedCue];
    const selectedCueDeleted = selectedCue?.scent === index;
    state.cues = state.cues.filter((cue) => cue.scent !== index);
    state.cues.forEach((cue) => {
      if (cue.scent > index) cue.scent -= 1;
    });
    state.selectedCue = selectedCue && !selectedCueDeleted
      ? state.cues.indexOf(selectedCue)
      : null;
    state.firedThisPass.clear();
    state.settings = { ...state.settings, ...config };
    renderScentSettings(config.scents);
    renderScentButtons(config.scents);
    renderTracks();
    toast("Device deleted");
  } catch (err) {
    toast("Couldn't delete device: " + err.message);
  }
}

function collectScentSettings() {
  const rows = document.querySelectorAll(".scent-setting");
  return Array.from(rows).map((row) => {
    const get = (f) => row.querySelector(`[data-field="${f}"]`).value;
    return {
      name: get("name"),
      color: get("color"),
      deviceId: get("deviceId"),
      outlet: Number(get("outlet")) || 0,
      pulseMs: Number(get("pulseMs")) || 3000,
    };
  });
}

// ---------- scents tab ----------
function renderScentButtons(scents) {
  const grid = document.getElementById("scentGrid");
  grid.innerHTML = "";
  if (!scents.length) {
    grid.textContent = "No devices added yet. Add a device ID in Settings to get started.";
    return;
  }
  scents.forEach((scent, i) => {
    const btn = document.createElement("button");
    btn.className = "scent-btn";
    btn.style.setProperty("--dot-color", scent.color);
    btn.innerHTML = `<div class="dot"></div>
      <div class="label">${escapeHtml(scent.name)}</div>
      <div class="sub">${(scent.pulseMs / 1000).toFixed(1)}s pulse</div>
      <label class="trigger-pulse" onclick="event.stopPropagation()">Pulse
        <input type="number" min="200" max="60000" step="100" value="${escapeHtml(scent.pulseMs)}" data-pulse-index="${i}" />
        <span>ms</span>
      </label>`;
    btn.querySelector(".dot").style.background = scent.color;
    btn.addEventListener("click", () => triggerScent(i, btn));
    btn.querySelector("[data-pulse-index]").addEventListener("change", (e) => updateTriggerPulse(i, e.target.value));
    grid.appendChild(btn);
  });
}

async function updateTriggerPulse(index, value) {
  const pulseMs = Math.min(60000, Math.max(200, Number(value) || 3000));
  state.settings.scents[index].pulseMs = pulseMs;
  renderScentButtons(state.settings.scents);
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ scents: state.settings.scents }),
    });
    toast("Trigger pulse updated");
  } catch (err) {
    toast("Couldn't save pulse: " + err.message);
  }
}

async function triggerScent(index, btnEl, overrideSeconds = null) {
  const pulseMs = state.settings.scents[index]?.pulseMs || 3000;
  const duration = overrideSeconds === null ? pulseMs : Math.max(200, Math.round(overrideSeconds * 1000));
  if (btnEl) {
    btnEl.classList.add("releasing");
    setTimeout(() => btnEl.classList.remove("releasing"), duration);
  }
  try {
    await api(`/api/scent/${index}/trigger`, { method: "POST", body: JSON.stringify({ duration }) });
  } catch (err) {
    if (btnEl) btnEl.classList.remove("releasing");
    toast("Trigger failed: " + err.message);
  }
}

// ---------- timeline tab ----------
const videoPlayer = document.getElementById("videoPlayer");
const ruler = document.getElementById("ruler");
const playhead = document.getElementById("playhead");
const tracksEl = document.getElementById("tracks");

// the video stays on the user's device; only the cue list is saved (by file name)
document.getElementById("videoUpload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  state.currentVideo = file.name;
  state.selectedCue = null;
  state.firedThisPass.clear();
  document.getElementById("videoName").textContent = file.name;
  videoPlayer.src = state.videoUrl;
  updateCueInspector();

  try {
    const timeline = await api(`/api/timeline/${encodeURIComponent(file.name)}`);
    state.cues = timeline.cues || [];
  } catch (err) {
    state.cues = [];
    toast("Couldn't load saved timeline: " + err.message);
  }
  renderTracks();
  videoPlayer.addEventListener("loadedmetadata", () => { renderRuler(); renderCues(); }, { once: true });
});

document.getElementById("saveTimelineBtn").addEventListener("click", async () => {
  if (!state.currentVideo) return toast("Choose a video first");
  try {
    await api(`/api/timeline/${encodeURIComponent(state.currentVideo)}`, {
      method: "POST",
      body: JSON.stringify({ cues: state.cues }),
    });
    toast("Timeline saved");
  } catch (err) {
    toast("Couldn't save timeline: " + err.message);
  }
});

function renderTracks() {
  tracksEl.innerHTML = "";
  const scents = state.settings.scents;
  scents.forEach((scent, i) => {
    const track = document.createElement("div");
    track.className = "track";
    track.innerHTML = `<span class="track-label">${escapeHtml(scent.name)}</span><div class="track-lane" data-scent="${i}"></div>`;
    tracksEl.appendChild(track);

    const lane = track.querySelector(".track-lane");
    lane.addEventListener("click", (e) => {
      if (e.target !== lane) return; // ignore clicks on existing cues
      const duration = videoPlayer.duration || 0;
      if (!duration) return toast("Choose a video first");
      const rect = lane.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const time = Math.max(0, ratio * duration);
      state.cues.push({ scent: i, time, duration: (scent.pulseMs || 3000) / 1000 });
      state.selectedCue = state.cues.length - 1;
      renderCues();
    });
  });
  renderCues();
}

function renderRuler() {
  ruler.innerHTML = "";
  const duration = videoPlayer.duration || 0;
  if (!duration) return;
  const step = duration > 120 ? 30 : duration > 40 ? 10 : 5;
  for (let t = 0; t <= duration; t += step) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${(t / duration) * 100}%`;
    tick.innerHTML = `<span>${fmtTime(t)}</span>`;
    ruler.appendChild(tick);
  }
  // assigned (not added) so it never stacks up when a new video is loaded
  ruler.onclick = (e) => {
    const rect = ruler.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    videoPlayer.currentTime = ratio * duration;
  };
}

function renderCues() {
  document.querySelectorAll(".track-lane").forEach((lane) => {
    lane.querySelectorAll(".cue").forEach((c) => c.remove());
  });
  const duration = videoPlayer.duration || 0;
  if (!duration) return;
  state.cues.forEach((cue, cueIndex) => {
    const lane = document.querySelector(`.track-lane[data-scent="${cue.scent}"]`);
    if (!lane) return;
    const scent = state.settings.scents[cue.scent];
    const el = document.createElement("div");
    el.className = "cue";
    el.style.background = scent?.color || "#ccc";
    const leftPct = (cue.time / duration) * 100;
    const widthPct = ((cue.duration || 1) / duration) * 100;
    el.style.left = `${leftPct}%`;
    el.style.width = `${Math.max(widthPct, 1)}%`;
    el.title = `${scent?.name || "scent"} @ ${fmtTime(cue.time)}`;

    if (cueIndex === state.selectedCue) el.classList.add("selected");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedCue = cueIndex;
      updateCueInspector();
      renderCues();
    });

    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      state.cues.splice(cueIndex, 1);
      state.selectedCue = null;
      state.firedThisPass.clear();
      updateCueInspector();
      renderCues();
    });

    el.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      const laneRect = lane.getBoundingClientRect();
      const onMove = (moveEvt) => {
        const ratio = (moveEvt.clientX - laneRect.left) / laneRect.width;
        cue.time = Math.min(Math.max(0, ratio * duration), duration - (cue.duration || 0));
        el.style.left = `${(cue.time / duration) * 100}%`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    lane.appendChild(el);
  });
  updateCueInspector();
}

function updateCueInspector() {
  const inspector = document.getElementById("timelineInspector");
  const cue = state.selectedCue === null ? null : state.cues[state.selectedCue];
  inspector.hidden = !cue;
  if (!cue) return;
  const scent = state.settings.scents[cue.scent];
  document.getElementById("selectedCueLabel").textContent = `${scent?.name || "Scent"} cue timing`;
  document.getElementById("cueTimeInput").value = Number(cue.time || 0).toFixed(1);
  document.getElementById("cueDurationInput").value = Number(cue.duration || 0.2).toFixed(1);
}

document.getElementById("applyCueTimingBtn").addEventListener("click", () => {
  const cue = state.selectedCue === null ? null : state.cues[state.selectedCue];
  const duration = videoPlayer.duration || 0;
  if (!cue || !duration) return;
  const pulseSeconds = Math.max(0.2, Number(document.getElementById("cueDurationInput").value) || 0.2);
  cue.duration = Math.min(pulseSeconds, duration);
  cue.time = Math.min(Math.max(0, Number(document.getElementById("cueTimeInput").value) || 0), duration - cue.duration);
  renderCues();
  toast("Cue timing updated");
});

// playhead + playback-triggered scent firing
function tick() {
  const duration = videoPlayer.duration || 0;
  if (duration) {
    const ratio = videoPlayer.currentTime / duration;
    playhead.style.left = `${ratio * 100}%`;

    if (!videoPlayer.paused) {
      state.cues.forEach((cue, idx) => {
        const key = idx;
        const within = videoPlayer.currentTime >= cue.time && videoPlayer.currentTime < cue.time + 0.35;
        if (within && !state.firedThisPass.has(key)) {
          state.firedThisPass.add(key);
          triggerScent(cue.scent, null, cue.duration);
        }
        if (!within && videoPlayer.currentTime < cue.time) {
          state.firedThisPass.delete(key);
        }
      });
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

videoPlayer.addEventListener("seeked", () => state.firedThisPass.clear());

// ---------- init ----------
(async function init() {
  try {
    await loadSettings();
  } catch (err) {
    updateStatus(false);
    toast("Couldn't load settings: " + err.message);
  }
})();