# Lanne Social Distribution — TikTok backend

This server keeps the TikTok client secret, access token and refresh token off GitHub Pages and implements the server-side OAuth and Content Posting API flow.

## Environment

Copy .env.example to .env and provide TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET. Keep the redirect URI as https://contactolanne.github.io/lanne-social-distribution/callback.html and never commit .env.

## Run

Run npm install and then npm start. Health check: GET /api/health.

## Implemented flow

1. /api/auth/tiktok/start creates a one-time OAuth state and redirects to TikTok Login Kit.
2. GitHub Pages receives code and state on callback.html.
3. /api/auth/tiktok/callback validates state and exchanges the code server-side.
4. Access and refresh tokens stay in backend memory and are represented to the browser by an opaque session token.
5. /api/tiktok/creator-info retrieves the latest Creator Info before Direct Post.
6. /api/tiktok/publish supports Direct Post (video.publish) and inbox upload (video.upload) using FILE_UPLOAD.
7. /api/tiktok/status fetches publishing status.
8. /api/tiktok/disconnect revokes the current access token.

For a durable production deployment, replace the in-memory session store with an encrypted persistent store.
