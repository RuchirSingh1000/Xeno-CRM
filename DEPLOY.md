# Deployment guide

This project deploys as **three services**:

- **Frontend** — Next.js → Vercel
- **CRM API** — FastAPI → Render
- **Channel Simulator** — FastAPI → Render (same Blueprint, separate service)

All three platforms have generous free tiers; no card needed. Render free
services spin down after 15 min idle and take ~30s to wake — fine for a demo
URL. For a smoother demo, upgrade Render to Starter ($7/mo) or use Railway.

Total time: ~20 minutes once you start clicking.

---

## 1. Push to GitHub

From the repo root:

```powershell
git add .
git commit -m "ready to deploy"

# Create an empty repo on https://github.com/new (DO NOT add a README)
# Then:
git remote add origin https://github.com/YOUR_USERNAME/xeno-crm.git
git branch -M main
git push -u origin main
```

---

## 2. Deploy the backend (Render Blueprint)

Render reads `render.yaml` and creates both backend services in one go.

1. Go to <https://dashboard.render.com/blueprints> → **New Blueprint Instance**
2. Connect your GitHub if you haven't, then pick `xeno-crm`
3. Render scans `render.yaml`, shows the two services, asks for secrets:
   - **GEMINI_API_KEY** — paste your Gemini key (get one free at <https://aistudio.google.com/apikey>)
   - **GROQ_API_KEY** — paste your Groq key (get one free at <https://console.groq.com>)
   - **ANTHROPIC_API_KEY**, **OPENAI_API_KEY** — leave blank if unused
4. Click **Apply**. Render builds both services. First build ~5 min.

Once green you'll have two URLs:
- `https://xeno-crm-api.onrender.com` — the CRM API
- `https://xeno-channel-simulator.onrender.com` — the simulator

Smoke test:

```powershell
curl https://xeno-crm-api.onrender.com/health
curl https://xeno-channel-simulator.onrender.com/health
```

Both should return `{"status":"ok",...}`. If one comes back slow, that's the cold-start wakeup; retry.

---

## 3. Deploy the frontend (Vercel)

1. Go to <https://vercel.com/new>
2. **Import** the `xeno-crm` repo
3. **Root Directory**: set to `frontend`
4. **Framework Preset** should auto-detect as Next.js
5. Under **Environment Variables**, add:
   - `NEXT_PUBLIC_CRM_API_URL` = `https://xeno-crm-api.onrender.com`
   - `NEXT_PUBLIC_CHANNEL_SIM_URL` = `https://xeno-channel-simulator.onrender.com`
6. **Deploy**

You get something like `https://xeno-crm.vercel.app`. Done.

---

## 4. Update CORS on the backend

The CRM API ships with CORS allowing `localhost:3000` plus a placeholder. Now
that you know the real Vercel URL, edit it:

1. In Render dashboard → `xeno-crm-api` → **Environment**
2. Edit `ALLOWED_ORIGINS` to: `http://localhost:3000,https://YOUR_VERCEL_URL.vercel.app`
3. Save — Render redeploys automatically

If you skip this, the frontend will hit CORS errors when calling the API.

---

## 5. Verify

Open the Vercel URL in a fresh incognito window:

1. **Overview** loads with stats populated
2. **Ingest** → click **Seed all sources** → then **Run resolution** (re-seeds the demo data in production)
3. **Customers** shows ~1,600 rows
4. **Campaigns** → open one → **Campaign autopilot** button works
5. **Reliability** → **+ Simulate failure** → **Replay** works
6. **Ask Xeno** (✦ button) answers a question
7. **AI evals** loads the cached run
8. **AI runs** shows recent rows

If any of these fail, the most likely culprit is a missing env var. Check
Render's "Logs" tab for stack traces.

---

## Common deploy gotchas

| Symptom | Fix |
|---|---|
| Frontend loads but every API call CORS-fails | Add the Vercel URL to `ALLOWED_ORIGINS` on Render |
| Backend cold-start takes 60s+ | Render free-tier spinup; the first request after idle is always slow |
| `crm.db` data resets on every push | Render free filesystem is ephemeral. Either re-seed via UI, or attach a Render Postgres (free tier) and set `DATABASE_URL` |
| AI runs say `validation_status=fallback_used` | API key for the primary provider is missing or invalid. Check Render env vars |
| `WEBHOOK_HMAC_SECRET` mismatch | Both services must share the same secret. The Blueprint wires this automatically via `fromService`; don't override one and not the other |
| Frontend builds locally but fails on Vercel | Usually a missing env var or a TypeScript error that `next dev` is lenient about. Check the Vercel build log |

---

## Switching to Postgres (optional)

For persistence across redeploys:

1. In Render dashboard → **New → Postgres** → free tier
2. Copy the **Internal Database URL** (looks like `postgresql://user:pass@host/db`)
3. In `xeno-crm-api` → **Environment** → set `DATABASE_URL` to that URL
4. Redeploy. The schema auto-creates on boot.

Seed data won't carry over from SQLite — re-run **Seed all sources** in the UI.

---

## What I prepared for you

- `render.yaml` — defines both Render services declaratively, wires the shared HMAC secret and inter-service URLs
- `.gitignore` — already keeps `.env`, `crm.db`, `node_modules`, `.next` out of the repo
- This file — the actual steps

Run the 5 steps above and you're live.
