import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 8787);
const CLIENT_KEY = (process.env.TIKTOK_CLIENT_KEY || "").trim();
const CLIENT_SECRET = (process.env.TIKTOK_CLIENT_SECRET || "").trim();
const REDIRECT_URI = (process.env.TIKTOK_REDIRECT_URI || "https://contactolanne.github.io/lanne-social-distribution/callback.html").trim();
const SCOPES = (process.env.TIKTOK_SCOPES || "user.info.basic,video.publish,video.upload").trim();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://contactolanne.github.io").split(",").map(s => s.trim()).filter(Boolean);
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 250) * 1024 * 1024;

const states = new Map();
const sessions = new Map();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: maxUploadBytes } });

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"));
  },
  allowedHeaders: ["Content-Type", "X-Session-Token"],
  methods: ["GET","POST","OPTIONS"]
}));
app.use(express.json({ limit: "1mb" }));

function requireConfig() {
  if (!CLIENT_KEY || !CLIENT_SECRET) {
    const err = new Error("TikTok client credentials are not configured on the backend.");
    err.status = 503;
    throw err;
  }
}
function cleanup() {
  const now = Date.now();
  for (const [key, item] of states) if (item.expiresAt < now) states.delete(key);
  for (const [key, item] of sessions) if (item.sessionExpiresAt < now) sessions.delete(key);
}
setInterval(cleanup, 60000).unref();

function sessionFrom(req) {
  const id = req.header("X-Session-Token");
  if (!id || !sessions.has(id)) {
    const err = new Error("TikTok session is missing or expired.");
    err.status = 401;
    throw err;
  }
  return { id, session: sessions.get(id) };
}

async function tiktokJson(url, options={}) {
  const r = await fetch(url, options);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body.error && body.error.code && body.error.code !== "ok")) {
    const message = body.error_description || body.error?.message || body.error?.code || "TikTok API request failed (" + r.status + ")";
    const err = new Error(message);
    err.status = r.status >= 400 ? r.status : 502;
    err.detail = body;
    throw err;
  }
  return body;
}

async function refreshIfNeeded(session) {
  if (Date.now() < session.accessExpiresAt - 10 * 60000) return session.accessToken;
  const body = new URLSearchParams({
    client_key: CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: session.refreshToken
  });
  const data = await tiktokJson("https://open.tiktokapis.com/v2/oauth/token/", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body
  });
  session.accessToken = data.access_token;
  session.refreshToken = data.refresh_token || session.refreshToken;
  session.accessExpiresAt = Date.now() + Number(data.expires_in || 86400) * 1000;
  session.scopes = (data.scope || session.scopes.join(",")).split(",").filter(Boolean);
  return session.accessToken;
}

async function userInfo(session) {
  const token = await refreshIfNeeded(session);
  const fields = encodeURIComponent("open_id,union_id,avatar_url,display_name");
  const data = await tiktokJson("https://open.tiktokapis.com/v2/user/info/?fields=" + fields, {
    headers:{Authorization:"Bearer " + token}
  });
  return data.data?.user || {};
}

async function creatorInfo(session) {
  const token = await refreshIfNeeded(session);
  const data = await tiktokJson("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
    method:"POST",
    headers:{Authorization:"Bearer " + token,"Content-Type":"application/json; charset=UTF-8"},
    body:"{}"
  });
  return data.data || {};
}

function parseBool(value) { return String(value).toLowerCase() === "true"; }

function uploadPlan(size) {
  const chunk = Math.min(size, 64 * 1024 * 1024);
  const count = Math.ceil(size / chunk);
  return { chunkSize: chunk, totalChunkCount: Math.max(1, count) };
}

async function uploadVideo(uploadUrl, filePath, mimeType, size, chunkSize, totalChunkCount) {
  const handle = await fs.open(filePath, "r");
  try {
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const endExclusive = Math.min(start + chunkSize, size);
      const length = endExclusive - start;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, start);
      const response = await fetch(uploadUrl, {
        method:"PUT",
        headers:{
          "Content-Type": mimeType || "video/mp4",
          "Content-Length": String(length),
          "Content-Range": "bytes " + start + "-" + (endExclusive - 1) + "/" + size
        },
        body: buffer
      });
      if (![200,201,206].includes(response.status)) {
        const text = await response.text().catch(() => "");
        const err = new Error("TikTok media upload failed (" + response.status + "). " + text);
        err.status = 502;
        throw err;
      }
    }
  } finally {
    await handle.close();
  }
}

async function fetchStatus(session, publishId) {
  const token = await refreshIfNeeded(session);
  const data = await tiktokJson("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method:"POST",
    headers:{Authorization:"Bearer " + token,"Content-Type":"application/json; charset=UTF-8"},
    body:JSON.stringify({publish_id: publishId})
  });
  return data.data || {};
}

app.get("/api/health", (_req,res) => {
  res.json({ok:true, service:"Lanne Social Distribution backend", configured:Boolean(CLIENT_KEY && CLIENT_SECRET)});
});

app.get("/api/auth/tiktok/diagnostics", (_req,res) => {
  const clientKeySha256 = CLIENT_KEY ? crypto.createHash("sha256").update(CLIENT_KEY, "utf8").digest("hex") : null;
  res.json({
    client_key_present: Boolean(CLIENT_KEY),
    client_key_length: CLIENT_KEY.length,
    client_key_sha256: clientKeySha256,
    client_key_matches_expected: clientKeySha256 === "b68faf11013383ab8c6bdb60d1e9b78ff6d7a4b3ffc82da121e20b4394463984",
    redirect_uri: REDIRECT_URI,
    scopes: SCOPES,
    authorize_endpoint: "https://www.tiktok.com/v2/auth/authorize/"
  });
});

app.get("/api/auth/tiktok/start", (req,res,next) => {
  try {
    requireConfig();
    const state = crypto.randomBytes(32).toString("hex");
    states.set(state, {expiresAt: Date.now() + 10 * 60000});
    const query = new URLSearchParams({
      client_key: CLIENT_KEY,
      response_type: "code",
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state
    });
    res.redirect("https://www.tiktok.com/v2/auth/authorize/?" + query.toString());
  } catch (e) { next(e); }
});

app.post("/api/auth/tiktok/callback", async (req,res,next) => {
  try {
    requireConfig();
    const {code,state} = req.body || {};
    const pending = states.get(state);
    if (!code || !state || !pending || pending.expiresAt < Date.now()) {
      return res.status(400).json({error:"Invalid or expired OAuth state. Start TikTok authorization again."});
    }
    states.delete(state);
    const body = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI
    });
    const data = await tiktokJson("https://open.tiktokapis.com/v2/oauth/token/", {
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body
    });
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    sessions.set(sessionToken, {
      accessToken:data.access_token,
      refreshToken:data.refresh_token,
      accessExpiresAt:Date.now()+Number(data.expires_in||86400)*1000,
      sessionExpiresAt:Date.now()+7*24*60*60000,
      scopes:(data.scope||"").split(",").filter(Boolean),
      openId:data.open_id
    });
    res.json({session_token:sessionToken, scopes:(data.scope||"").split(",").filter(Boolean)});
  } catch (e) { next(e); }
});

app.get("/api/session", async (req,res,next) => {
  try {
    const {session} = sessionFrom(req);
    const user = await userInfo(session);
    res.json({connected:true, scopes:session.scopes, user:{display_name:user.display_name, avatar_url:user.avatar_url}});
  } catch (e) { next(e); }
});

app.get("/api/tiktok/creator-info", async (req,res,next) => {
  try {
    const {session} = sessionFrom(req);
    res.json(await creatorInfo(session));
  } catch (e) { next(e); }
});

app.post("/api/tiktok/publish", upload.single("video"), async (req,res,next) => {
  let path;
  try {
    const {session} = sessionFrom(req);
    if (!req.file) return res.status(400).json({error:"Select a video file."});
    path = req.file.path;
    if (!parseBool(req.body.creator_consent)) return res.status(400).json({error:"Explicit creator confirmation is required."});
    if (!["video/mp4","video/quicktime","video/webm"].includes(req.file.mimetype)) {
      return res.status(400).json({error:"Use MP4, MOV or WebM video."});
    }

    const mode = req.body.mode === "inbox" ? "inbox" : "direct";
    const token = await refreshIfNeeded(session);
    const {chunkSize,totalChunkCount} = uploadPlan(req.file.size);
    const sourceInfo = {
      source:"FILE_UPLOAD",
      video_size:req.file.size,
      chunk_size:chunkSize,
      total_chunk_count:totalChunkCount
    };

    let endpoint;
    let payload;
    if (mode === "direct") {
      const latest = await creatorInfo(session);
      const privacy = req.body.privacy_level;
      if (!privacy || !(latest.privacy_level_options || []).includes(privacy)) {
        return res.status(400).json({error:"Choose a privacy level currently returned by TikTok Creator Info."});
      }
      payload = {
        post_info:{
          title:String(req.body.caption || "").slice(0,2200),
          privacy_level:privacy,
          disable_comment:latest.comment_disabled ? true : !parseBool(req.body.allow_comment),
          disable_duet:latest.duet_disabled ? true : !parseBool(req.body.allow_duet),
          disable_stitch:latest.stitch_disabled ? true : !parseBool(req.body.allow_stitch),
          brand_organic_toggle:parseBool(req.body.brand_organic_toggle),
          is_aigc:parseBool(req.body.is_aigc)
        },
        source_info:sourceInfo
      };
      endpoint = "https://open.tiktokapis.com/v2/post/publish/video/init/";
    } else {
      payload = {source_info:sourceInfo};
      endpoint = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
    }

    const init = await tiktokJson(endpoint, {
      method:"POST",
      headers:{Authorization:"Bearer " + token,"Content-Type":"application/json; charset=UTF-8"},
      body:JSON.stringify(payload)
    });
    const publishId = init.data?.publish_id;
    const uploadUrl = init.data?.upload_url;
    if (!publishId || !uploadUrl) {
      const err = new Error("TikTok did not return an upload URL and publish ID.");
      err.status = 502;
      throw err;
    }

    await uploadVideo(uploadUrl, req.file.path, req.file.mimetype, req.file.size, chunkSize, totalChunkCount);
    let status = {};
    try { status = await fetchStatus(session, publishId); } catch {}
    res.json({publish_id:publishId, status});
  } catch (e) { next(e); }
  finally { if (path) fs.unlink(path).catch(()=>{}); }
});

app.get("/api/tiktok/status", async (req,res,next) => {
  try {
    const {session} = sessionFrom(req);
    const publishId = String(req.query.publish_id || "");
    if (!publishId) return res.status(400).json({error:"publish_id is required."});
    res.json(await fetchStatus(session,publishId));
  } catch (e) { next(e); }
});

app.post("/api/tiktok/disconnect", async (req,res,next) => {
  try {
    const {id,session} = sessionFrom(req);
    try {
      const token = await refreshIfNeeded(session);
      const body = new URLSearchParams({client_key:CLIENT_KEY,client_secret:CLIENT_SECRET,token});
      await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", {
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body
      });
    } catch {}
    sessions.delete(id);
    res.json({ok:true});
  } catch (e) { next(e); }
});

app.use((err,_req,res,_next) => {
  const status = Number(err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500));
  const message = err.code === "LIMIT_FILE_SIZE" ? "Video exceeds the configured upload limit." : (err.message || "Unexpected server error.");
  if (status >= 500) console.error("[server]", message);
  res.status(status).json({error:message});
});

app.listen(PORT, () => {
  console.log("Lanne Social Distribution backend listening on :" + PORT);
});
