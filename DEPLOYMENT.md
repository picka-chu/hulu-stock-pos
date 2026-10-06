# Hulu Stock Production Deployment Guide

## Before You Deploy — Checklist

### 1. Generate a strong JWT secret
```bash
python -c "import secrets; print(secrets.token_hex(64))"
```
Copy the output. You'll need it below.

### 2. Set environment variables on Render (or your host)

Go to your Render backend service → Environment → Add the following:

| Variable | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `JWT_SECRET` | *(the 128-char hex you generated above)* |
| `SUPABASE_URL` | `https://YOUR_PROJECT.supabase.co` |
| `SUPABASE_SERVICE_KEY` | *(your Supabase server-side secret/service-role key)* |
| `FRONTEND_URL` | `https://your-frontend.onrender.com` |
| `SUPERADMIN_EMAIL` | `bereket@onyx.com` |
| `SUPERADMIN_PASSWORD` | *(strong password, min 12 chars)* |
| `DEMO_MODE_ENABLED` | `false` |

### 3. Run database migrations on Supabase

Open Supabase Dashboard → SQL Editor → run each file in order:

1. `backend/database/schema.sql` — (only on fresh database)
2. `backend/database/migration_001_item_name.sql`
3. `backend/database/migration_002_multitenant_rls.sql`
4. `backend/database/migration_003_notifications.sql`

### 4. Enable Supabase Realtime for notifications

Supabase Dashboard → Database → Replication → toggle ON the `notifications` table.

### 5. Update frontend config

Open `frontend/assets/js/config.js` and set:

```js
API_BASE_URL: 'https://your-backend.onrender.com/api',
SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
SUPABASE_KEY: 'your-anon-public-key',   // anon key (NOT service role)
```

---

## Security Features Now Active

| Feature | Status |
|---|---|
| JWT secret from environment | ✅ Crashes if not set in production |
| Demo mode off by default | ✅ `DEMO_MODE_ENABLED=false` |
| Test endpoints removed | ✅ `/test-db` and `/test-users` deleted |
| Demo credentials removed from login page | ✅ |
| Superadmin password from environment | ✅ Crashes if not set in production |
| Login rate limiting | ✅ 10 attempts/60s per IP |
| General rate limiting | ✅ 120 requests/60s per IP |
| CORS locked to your domain | ✅ Set via `FRONTEND_URL` |
| Swagger docs hidden in production | ✅ `/api/docs` returns 404 |
| Constant-time password comparison | ✅ Prevents timing attacks |
| Organization suspension check on login | ✅ Inactive org → 403 |
| Password minimum 8 characters enforced | ✅ Register + create user |
| `.env` in `.gitignore` | ✅ Secrets never committed |

---

## Owner Panel (Superadmin)

Access: `https://your-frontend/superadmin.html`

Login with the credentials set in `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` env vars.

From here you can: create client organisations, activate/deactivate them, edit their plan/settings, and delete them.

---

## Monitoring

- Health endpoint: `GET /api/health` — shows DB + Supabase status
- Logs: Render Dashboard → Logs (also saved to `app.log` on server)
- Supabase keeps automatic backups on paid plans

---

## Updating Superadmin Password

1. Change `SUPERADMIN_PASSWORD` in your Render environment variables
2. Redeploy (or restart the service)
3. The new password takes effect immediately

### Troubleshooting Render authentication / superadmin errors

If normal login returns **401** while `/api/superadmin/login` still works, check the Render logs for Supabase connection errors. The backend now returns **503** when the database is unavailable instead of incorrectly reporting bad user credentials.

If `/api/superadmin/stats` fails, the endpoint now returns **503** with a clear database-connection error instead of an unhandled 500.

The backend accepts these server-side Supabase key variable names for compatibility:
- `SUPABASE_SERVICE_KEY` (recommended for this app)
- `SUPABASE_SECRET_KEY`
- `SUPABASE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Use the actual Supabase project URL, for example `https://<project-ref>.supabase.co`. Do not put a server-side secret/service-role key in frontend JavaScript. Supabase recommends server-only secret keys for backend components.