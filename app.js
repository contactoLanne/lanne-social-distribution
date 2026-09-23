(() => {
  const $ = id => document.getElementById(id);
  const SESSION_KEY = "lsd_tiktok_session";
  const BACKEND_KEY = "lsd_backend_url";
  let creator = null;
  let publishId = null;

  const configuredBackend = () => (localStorage.getItem(BACKEND_KEY) || window.LSD_CONFIG?.backendBaseUrl || "").replace(/\/+$/, "");
  const session = () => localStorage.getItem(SESSION_KEY) || "";

  function setStatus(el, message, kind="") {
    el.textContent = message;
    el.className = "status" + (kind ? " " + kind : "");
  }

  async function api(path, options={}) {
    const base = configuredBackend();
    if (!base) throw new Error("Save the secure backend URL first.");
    const headers = new Headers(options.headers || {});
    if (session()) headers.set("X-Session-Token", session());
    const response = await fetch(base + path, {...options, headers});
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body.error || body.message || "Request failed (" + response.status + ")");
    return body;
  }

  async function checkBackend() {
    try {
      setStatus($("backendStatus"), "Checking backend…");
      const health = await api("/api/health");
      setStatus($("backendStatus"), health.ok ? "Secure backend is online." : "Backend responded.", "ok");
    } catch (e) {
      setStatus($("backendStatus"), e.message, "err");
    }
  }

  async function loadSession() {
    if (!session()) {
      $("connected").classList.add("hidden");
      $("disconnected").classList.remove("hidden");
      setStatus($("accountStatus"), "Not connected.");
      updatePublishButton();
      return;
    }
    try {
      const data = await api("/api/session");
      $("disconnected").classList.add("hidden");
      $("connected").classList.remove("hidden");
      $("displayName").textContent = data.user?.display_name || "Connected TikTok creator";
      $("avatar").src = data.user?.avatar_url || "";
      $("scopeText").textContent = "Scopes: " + (data.scopes || []).join(", ");
      setStatus($("accountStatus"), "TikTok account connected.", "ok");
      await loadCreatorInfo();
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
      setStatus($("accountStatus"), e.message, "err");
      $("connected").classList.add("hidden");
      $("disconnected").classList.remove("hidden");
    }
    updatePublishButton();
  }

  async function loadCreatorInfo() {
    if ($("mode").value !== "direct") return;
    try {
      setStatus($("creatorEmpty"), "Loading latest Creator Info…");
      creator = await api("/api/tiktok/creator-info");
      $("creatorName").textContent = creator.creator_nickname || creator.creator_username || "Connected creator";
      $("maxDuration").textContent = creator.max_video_post_duration_sec ? creator.max_video_post_duration_sec + " seconds" : "Returned by TikTok";
      $("privacyList").textContent = (creator.privacy_level_options || []).join(", ") || "None returned";
      $("creatorInfo").classList.remove("hidden");
      $("creatorEmpty").classList.add("hidden");

      const privacy = $("privacy");
      privacy.innerHTML = '<option value="">Choose privacy manually</option>';
      (creator.privacy_level_options || []).forEach(level => {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = level;
        privacy.appendChild(option);
      });

      [["allowComment","comment_disabled"],["allowDuet","duet_disabled"],["allowStitch","stitch_disabled"]].forEach(([id, flag]) => {
        $(id).checked = false;
        $(id).disabled = !!creator[flag];
      });
      updatePublishButton();
    } catch (e) {
      creator = null;
      $("creatorInfo").classList.add("hidden");
      $("creatorEmpty").classList.remove("hidden");
      setStatus($("creatorEmpty"), e.message, "err");
      updatePublishButton();
    }
  }

  function updateMode() {
    const direct = $("mode").value === "direct";
    document.querySelectorAll(".direct-only").forEach(el => el.classList.toggle("hidden", !direct));
    $("publish").textContent = direct ? "Publish to TikTok" : "Upload to TikTok inbox";
    if (direct && session()) loadCreatorInfo();
    updatePublishButton();
  }

  function updatePublishButton() {
    const hasFile = !!$("video").files[0];
    const directReady = $("mode").value !== "direct" || (creator && $("privacy").value);
    $("publish").disabled = !(session() && hasFile && directReady && $("consent").checked);
  }

  async function publish() {
    const file = $("video").files[0];
    if (!file) return;
    const form = new FormData();
    form.append("video", file);
    form.append("mode", $("mode").value);
    form.append("caption", $("caption").value);
    form.append("privacy_level", $("privacy").value);
    form.append("allow_comment", String($("allowComment").checked));
    form.append("allow_duet", String($("allowDuet").checked));
    form.append("allow_stitch", String($("allowStitch").checked));
    form.append("brand_organic_toggle", String($("brandOrganic").checked));
    form.append("is_aigc", String($("isAigc").checked));
    form.append("creator_consent", "true");

    try {
      $("publish").disabled = true;
      setStatus($("publishStatus"), "Initializing upload and sending the video to TikTok…");
      const data = await api("/api/tiktok/publish", {method:"POST", body:form});
      publishId = data.publish_id;
      $("publishId").textContent = publishId;
      $("finalStatus").textContent = data.status?.status || "PROCESSING";
      $("resultCard").classList.remove("hidden");
      setStatus($("publishStatus"), "TikTok accepted the publishing request.", "ok");
    } catch (e) {
      setStatus($("publishStatus"), e.message, "err");
    } finally {
      updatePublishButton();
    }
  }

  async function refreshStatus() {
    if (!publishId) return;
    try {
      $("finalStatus").textContent = "Checking…";
      const data = await api("/api/tiktok/status?publish_id=" + encodeURIComponent(publishId));
      $("finalStatus").textContent = data.status || "UNKNOWN";
      if (data.fail_reason) $("finalStatus").textContent += " — " + data.fail_reason;
    } catch (e) {
      $("finalStatus").textContent = e.message;
    }
  }

  $("backendUrl").value = configuredBackend();
  $("saveBackend").onclick = () => {
    const value = $("backendUrl").value.trim().replace(/\/+$/, "");
    if (value) localStorage.setItem(BACKEND_KEY, value); else localStorage.removeItem(BACKEND_KEY);
    setStatus($("backendStatus"), value ? "Backend URL saved in this browser." : "Backend URL cleared.", value ? "ok" : "");
  };
  $("checkBackend").onclick = checkBackend;
  $("connectTikTok").onclick = () => {
    const base = configuredBackend();
    if (!base) return setStatus($("accountStatus"), "Save the backend URL first.", "err");
    location.href = base + "/api/auth/tiktok/start";
  };
  $("disconnectTikTok").onclick = async () => {
    try { await api("/api/tiktok/disconnect", {method:"POST"}); } catch {}
    localStorage.removeItem(SESSION_KEY);
    creator = null;
    publishId = null;
    $("resultCard").classList.add("hidden");
    await loadSession();
  };
  $("refreshCreator").onclick = loadCreatorInfo;
  $("mode").onchange = updateMode;
  $("privacy").onchange = updatePublishButton;
  $("consent").onchange = updatePublishButton;
  $("video").onchange = () => {
    const f = $("video").files[0];
    $("fileMeta").textContent = f ? f.name + " · " + (f.size/1024/1024).toFixed(1) + " MB · " + (f.type || "video") : "MP4, MOV or WebM.";
    updatePublishButton();
  };
  $("caption").oninput = () => $("captionCount").textContent = $("caption").value.length;
  $("publish").onclick = publish;
  $("refreshStatus").onclick = refreshStatus;

  updateMode();
  loadSession();
  if (configuredBackend()) checkBackend();
})();
