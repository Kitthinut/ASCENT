const state = {
  settings: null,
  devices: [],
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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
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

// ---------- tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- settings / connection ----------
async function loadSettings() {
  const s = await api("/api/settings");
  state.settings = s;
  document.getElementById("deviceId").value = s.deviceId || "";
  renderScentSettings(s.scents);
  renderScentButtons(s.scents);
  updateStatus(s.loggedIn, s.region);
}

function updateStatus(loggedIn, region) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  dot.classList.remove("on", "off");
  if (loggedIn) {
    dot.classList.add("on");
    text.textContent = region ? `connected · ${region}` : "connected";
  } else {
    dot.classList.add("off");
    text.textContent = "not connected";
  }
}

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const deviceId = document.getElementById("deviceId").value.trim();
  const scents = collectScentSettings();
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify({ deviceId, scents }) });
    state.settings.deviceId = deviceId;
    state.settings.scents = scents;
    toast("Settings saved");
    renderScentButtons(scents);
  } catch (err) {
    toast("Couldn't save: " + err.message);
  }
});

document.getElementById("loginBtn").addEventListener("click", () => {
  window.location.href = "/auth/login";
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  updateStatus(false, null);
  toast("Disconnected from eWeLink");
});

document.getElementById("fetchDevicesBtn").addEventListener("click", async () => {
  const hint = document.getElementById("deviceFetchHint");
  hint.textContent = "Fetching…";
  try {
    const { devices } = await api("/api/devices");
    state.devices = devices;
    hint.textContent = `Found ${devices.length} device${devices.length === 1 ? "" : "s"} — pick one per scent below.`;
    renderScentSettings(state.settings.scents);
  } catch (err) {
    hint.textContent = "Couldn't fetch: " + err.message;
  }
});

// ---------- scent settings (settings tab) ----------
function renderScentSettings(scents) {
  const wrap = document.getElementById("scentSettingsList");
  wrap.innerHTML = "";
  scents.forEach((scent, i) => {
    const row = document.createElement("div");
    row.className = "scent-setting";
    const deviceOptions = state.devices.length
      ? state.devices.map((d) => `<option value="${d.id}" ${d.id === scent.deviceId ? "selected" : ""}>${d.name} (${d.id.slice(-5)})</option>`).join("")
      : "";
    row.innerHTML = `
      <input type="color" value="${scent.color}" data-field="color" />
      <label>Name
        <input type="text" value="${scent.name}" data-field="name" />
      </label>
      <label>Device
        ${deviceOptions
          ? `<select data-field="deviceId">${deviceOptions}</select>`
          : `<input type="text" value="${scent.deviceId}" data-field="deviceId" placeholder="device ID" />`}
      </label>
      <button type="button" class="delete-scent-btn" data-delete-scent="${i}" aria-label="Delete ${scent.name}">Delete</button>
      <div class="field-row">
        <label>Outlet (0-3 for a 4-ch relay)
          <input type="number" min="0" max="3" value="${scent.outlet}" data-field="outlet" />
        </label>
        <label>Pulse (ms)
          <input type="number" min="200" step="100" value="${scent.pulseMs}" data-field="pulseMs" />
        </label>
        <div></div>
      </div>
    `;
    row.dataset.index = i;
    wrap.appendChild(row);
  });
}

document.getElementById("scentSettingsList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-scent]");
  if (!button) return;
  await deleteScent(Number(button.dataset.deleteScent));
});

async function deleteScent(index) {
  const scents = collectScentSettings();
  const scent = scents[index];
  if (!scent) return;
  if (scents.length === 1) {
    toast("Keep at least one scent");
    return;
  }
  if (!window.confirm(`Delete "${scent.name}"? Its timeline cues will also be removed.`)) return;

  try {
    const { config } = await api(`/api/settings/scents/${index}`, {
      method: "DELETE",
      body: JSON.stringify({
        deviceId: document.getElementById("deviceId").value.trim(),
        scents,
      }),
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
    toast("Scent deleted");
  } catch (err) {
    toast("Couldn't delete scent: " + err.message);
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
  scents.forEach((scent, i) => {
    const btn = document.createElement("button");
    btn.className = "scent-btn";
    btn.style.setProperty("--dot-color", scent.color);
    btn.innerHTML = `<div class="dot" style="background:${scent.color}"></div>
      <div class="label">${scent.name}</div>
      <div class="sub">${(scent.pulseMs / 1000).toFixed(1)}s pulse</div>
      <label class="trigger-pulse" onclick="event.stopPropagation()">Pulse
        <input type="number" min="200" max="60000" step="100" value="${scent.pulseMs}" data-pulse-index="${i}" />
        <span>ms</span>
      </label>`;
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
    toast("Trigger failed: " + err.message);
  }
}

// ---------- timeline tab ----------
const videoPlayer = document.getElementById("videoPlayer");
const ruler = document.getElementById("ruler");
const playhead = document.getElementById("playhead");
const tracksEl = document.getElementById("tracks");

document.getElementById("videoUpload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("video", file);
  toast("Uploading video…");
  try {
    const res = await fetch("/api/video/upload", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast("Video uploaded");
    await loadVideoList();
    document.getElementById("videoSelect").value = data.filename;
    selectVideo(data.filename);
  } catch (err) {
    toast("Upload failed: " + err.message);
  }
});

document.getElementById("videoSelect").addEventListener("change", (e) => selectVideo(e.target.value));

document.getElementById("saveTimelineBtn").addEventListener("click", async () => {
  if (!state.currentVideo) return toast("Upload or pick a video first");
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

async function loadVideoList() {
  const { videos } = await api("/api/videos");
  const select = document.getElementById("videoSelect");
  select.innerHTML = `<option value="">Select a video…</option>` + videos.map((v) => `<option value="${v.filename}">${v.filename}</option>`).join("");
}

async function selectVideo(filename) {
  if (!filename) return;
  state.currentVideo = filename;
  state.selectedCue = null;
  updateCueInspector();
  videoPlayer.src = `/uploads/${filename}`;
  const timeline = await api(`/api/timeline/${encodeURIComponent(filename)}`);
  state.cues = timeline.cues || [];
  renderTracks();
  videoPlayer.addEventListener("loadedmetadata", () => { renderRuler(); renderCues(); }, { once: true });
}

function renderTracks() {
  tracksEl.innerHTML = "";
  const scents = state.settings.scents;
  scents.forEach((scent, i) => {
    const track = document.createElement("div");
    track.className = "track";
    track.innerHTML = `<span class="track-label">${scent.name}</span><div class="track-lane" data-scent="${i}"></div>`;
    tracksEl.appendChild(track);

    const lane = track.querySelector(".track-lane");
    lane.addEventListener("click", (e) => {
      if (e.target !== lane) return; // ignore clicks on existing cues
      const duration = videoPlayer.duration || 0;
      if (!duration) return toast("Load a video first");
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
  ruler.addEventListener("click", (e) => {
    const rect = ruler.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    videoPlayer.currentTime = ratio * duration;
  });
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
  await loadSettings();
  await loadVideoList();
})();
