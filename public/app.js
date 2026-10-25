const state = {
  settings: { scents: [] },
  currentVideo: null,
  videoUrl: null,
  renderedFor: null,
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
  state.settings = { scents: s.scents || [] };
  renderScentSettings(state.settings.scents);
  renderScentButtons(state.settings.scents);
  updateStatus(s.loggedIn);
}

// "loggedIn" means: the ASCENT server is connected to eWeLink (done once by the admin)
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
    const res = await api("/api/settings", { method: "POST", body: JSON.stringify({ scents }) });
    console.log("save response:", res);
    const saved = res?.config?.scents;
    if (!Array.isArray(saved) || saved.length !== scents.length) {
      throw new Error("Server didn't return the saved devices");
    }
    state.settings.scents = saved;
    renderScentSettings(saved);
    renderScentButtons(saved);
    renderTracks();
    toast("Settings saved");
  } catch (err) {
    console.error(err);
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
        <label>Outlet (0-3 for a 4-ch relay)
          <input type="number" min="0" max="3" value="${escapeHtml(scent.outlet)}" data-field="outlet" />
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
  const colors = ["#a8d5ba", "#bcdfc0", "#cfe8cd", "#e2f0da"];
  scents.push({
    name: `Device ${scents.length + 1}`,
    color: colors[scents.length % colors.length],
    deviceId: "",
    outlet: 0,
    pulseMs: 3000,
  });
  renderScentSettings(scents);
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
    state.settings = { ...state.settings, scents: config.scents };
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

// ---------- media adapter: local file or YouTube ----------
const media = {
  type: "file", // "file" | "youtube"
  yt: null,
  ytReady: false,
  pendingId: null,
  duration() {
    return this.type === "youtube" ? (this.yt?.getDuration?.() || 0) : (videoPlayer.duration || 0);
  },
  time() {
    return this.type === "youtube" ? (this.yt?.getCurrentTime?.() || 0) : (videoPlayer.currentTime || 0);
  },
  playing() {
    return this.type === "youtube" ? this.yt?.getPlayerState?.() === 1 : !videoPlayer.paused;
  },
  seek(t) {
    if (this.type === "youtube") this.yt?.seekTo?.(t, true);
    else videoPlayer.currentTime = t;
  },
};

let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { ytApiPromise = null; reject(new Error("YouTube API failed to load")); };
      document.head.appendChild(s);
    });
  }
  return ytApiPromise;
}

function parseYouTubeId(input) {
  const text = input.trim();
  const m = text.match(/(?:youtu\.be\/|[?&]v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : null;
}

function useFileMode() {
  media.type = "file";
  try { media.yt?.pauseVideo?.(); } catch {}
  document.getElementById("ytWrap").hidden = true;
  videoPlayer.hidden = false;
  state.renderedFor = null;
}

// local file: the video stays on the user's device; only the cue list is saved (by file name)
document.getElementById("videoUpload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  useFileMode();
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
});

// YouTube link
document.getElementById("ytBtn").addEventListener("click", async () => {
  const url = window.prompt("Paste a YouTube link:");
  if (!url) return;
  const id = parseYouTubeId(url);
  if (!id) return toast("That doesn't look like a YouTube link");

  try {
    await loadYouTubeApi();
  } catch (err) {
    return toast(err.message);
  }

  videoPlayer.pause();
  videoPlayer.hidden = true;
  document.getElementById("ytWrap").hidden = false;
  media.type = "youtube";
  state.currentVideo = "yt_" + id;
  state.selectedCue = null;
  state.firedThisPass.clear();
  state.renderedFor = null;
  document.getElementById("videoName").textContent = "YouTube: " + id;
  updateCueInspector();

  media.pendingId = id;
  if (!media.yt) {
    media.yt = new YT.Player("ytPlayer", {
      width: "100%",
      height: "100%",
      playerVars: { rel: 0, playsinline: 1 },
      events: {
        onReady: (e) => {
          media.ytReady = true;
          if (media.pendingId) e.target.cueVideoById(media.pendingId);
        },
        onError: () => toast("This video can't be played here (embedding may be disabled)"),
      },
    });
  } else if (media.ytReady) {
    media.yt.cueVideoById(id);
  }

  try {
    const timeline = await api(`/api/timeline/${encodeURIComponent(state.currentVideo)}`);
    state.cues = timeline.cues || [];
  } catch (err) {
    state.cues = [];
    toast("Couldn't load saved timeline: " + err.message);
  }
  renderTracks();
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
      const duration = media.duration();
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
  const duration = media.duration();
  if (!duration) return;
  const step = duration > 120 ? 30 : duration > 40 ? 10 : 5;
  for (let t = 0; t <= duration; t += step) {
    const tickEl = document.createElement("div");
    tickEl.className = "tick";
    tickEl.style.left = `${(t / duration) * 100}%`;
    tickEl.innerHTML = `<span>${fmtTime(t)}</span>`;
    ruler.appendChild(tickEl);
  }
  // assigned (not added) so it never stacks up when a new video is loaded
  ruler.onclick = (e) => {
    const rect = ruler.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    media.seek(ratio * duration);
  };
}

function renderCues() {
  document.querySelectorAll(".track-lane").forEach((lane) => {
    lane.querySelectorAll(".cue").forEach((c) => c.remove());
  });
  const duration = media.duration();
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
  const duration = media.duration();
  if (!cue || !duration) return;
  const pulseSeconds = Math.max(0.2, Number(document.getElementById("cueDurationInput").value) || 0.2);
  cue.duration = Math.min(pulseSeconds, duration);
  cue.time = Math.min(Math.max(0, Number(document.getElementById("cueTimeInput").value) || 0), duration - cue.duration);
  renderCues();
  toast("Cue timing updated");
});

// playhead + playback-triggered scent firing
let lastMediaTime = 0;
function tick() {
  const duration = media.duration();
  if (duration) {
    // draw ruler and cues once the duration is known (YouTube reports it late)
    if (state.renderedFor !== state.currentVideo) {
      state.renderedFor = state.currentVideo;
      renderRuler();
      renderCues();
    }

    const now = media.time();
    if (Math.abs(now - lastMediaTime) > 1) state.firedThisPass.clear(); // user jumped around
    lastMediaTime = now;
    playhead.style.left = `${(now / duration) * 100}%`;

    if (media.playing()) {
      state.cues.forEach((cue, idx) => {
        const within = now >= cue.time && now < cue.time + 0.35;
        if (within && !state.firedThisPass.has(idx)) {
          state.firedThisPass.add(idx);
          triggerScent(cue.scent, null, cue.duration);
        }
        if (!within && now < cue.time) state.firedThisPass.delete(idx);
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