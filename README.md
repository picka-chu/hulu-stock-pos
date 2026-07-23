# Hulu Stock Multi-Tenant POS System - Deployment Guide

A production-ready, scalable, multi-tenant Point of Sale (POS) Web System for grocery stores, cosmetics stores, and retail shops.

## Features

- **Multi-Tenant Architecture**: Each store is isolated with full data segregation
- **Multi-Branch Support**: Manage multiple branches within an organization
- **Role-Based Access Control**: Admin, Manager, and Cashier roles
- **Point of Sale**: Fast checkout with barcode scanning, cart management
- **Inventory Management**: Stock tracking, low stock alerts, expiry tracking
- **Financial Management**: Bank accounts, cash transfers, expenses
- **Reports & Analytics**: Sales reports, profit analysis, stock valuation
- **White-Label Ready**: Customizable branding (logo, colors, currency)
- **Modern UI/UX**: Responsive design, dark/light mode, smooth animations
- **Demo Mode**: Try without database setup

## Tech Stack

### Backend
- **Python 3.11+**
- **FastAPI**: Modern, fast web framework
- **PostgreSQL**: Supabase hosted database
- **JWT Authentication**: Secure token-based auth
- **Async Database**: asyncpg for high performance

### Frontend
- **HTML5**: Semantic markup
- **Tailwind CSS**: Utility-first CSS framework
- **Vanilla JavaScript**: No heavy frameworks
- **Chart.js**: Beautiful charts

## Quick Start - Demo Mode

The system works in demo mode without any database setup:

1. **Frontend Only Demo**:
   - Deploy the frontend to any static hosting (Netlify, Vercel, or Render)
   - Click "Try Demo" on the login page
   - Works completely offline with mock data

2. **Full Demo with Backend**:
   - Deploy backend to Render (no database needed for demo mode)
   - Backend will run in demo/offline mode
   - Click "Try Demo" to login

## Supabase Setup (Required for Production)

### A. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in
2. Click "New Project"
3. Enter project details:
   - **Name**: retailflow-pos (or your preferred name)
   - **Database Password**: Create a strong password (save this!)
   - **Region**: Choose the closest region to your users
4. Click "Create new project" and wait for setup (may take 2-3 minutes)

### B. Get Your Credentials

Once your project is ready:

1. **Connection String** (for backend):
   - Go to Settings (gear icon) → Database
   - Scroll to "Connection string"
   - Copy the "URI" format (postgresql://postgres:[YOUR-PASSWORD]@db...)
   - Replace `[YOUR-PASSWORD]` with your database password

2. **API Credentials** (for frontend/backend):
   - Go to Settings → API
   - Copy "Project URL" (e.g., `https://xxxxx.supabase.co`)
   - Copy "anon public" key (under "Project API keys")
   - Copy "service_role" key (under "Project API keys" - **keep secret!**)

### C. Run Database Schema

1. In Supabase dashboard, click "SQL Editor" in the left sidebar
2. Click "New query"
3. Open `backend/database/schema.sql` and copy its contents
4. Paste into the SQL Editor and click "Run"
5. Wait for success message
6. Then run `backend/database/demo_data.sql` to create demo data

## Backend Deployment (Render)

### 1. Push to GitHub
Create a GitHub repository and push your backend code.

### 2. Create Render Web Service
1. Go to [render.com](https://render.com) and sign in
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: retailflow-pos-backend
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`

### 3. Set Environment Variables
Add these in Render dashboard:
- `DATABASE_URL`: Your Supabase connection string
- `JWT_SECRET`: A secure random string (min 32 characters)
- `SUPABASE_URL`: Your Supabase Project URL
- `SUPABASE_KEY`: Your Supabase anon key
- `SUPABASE_SERVICE_KEY`: Your service_role key
- `FRONTEND_URL`: Your deployed frontend URL
- `ENVIRONMENT`: production

### 4. Deploy
Click "Create Web Service" and wait for deployment.

## Frontend Deployment

### Option 1: Netlify (Easiest)
1. Go to [netlify.com](https://netlify.com)
2. Drag and drop the `frontend` folder to Netlify
3. Your site is live!

### Option 2: Vercel
1. Go to [vercel.com](https://vercel.com)
2. Install Vercel CLI: `npm i -g vercel`
3. Run `vercel` in the frontend directory
4. Follow the prompts

### Option 3: Render Static Site
1. Go to Render dashboard
2. Click "New" → "Static Site"
3. Connect your GitHub repository (frontend folder)
4. Configure:
   - **Build Command**: (leave empty)
   - **Publish Directory**: frontend

## Connecting Frontend to Backend

After deployment:

1. Open `frontend/assets/js/config.js`
2. Update the `API_BASE_URL`:
   ```javascript
   API_BASE_URL: 'https://your-backend.onrender.com/api'
   ```
3. Redeploy the frontend

## Demo Credentials

### Demo Mode (No Database)
- Click "Try Demo" on login page
- Works completely offline with sample data

### Database Login (After Setup)
- **Email**: admin@demostore.com
- **Password**: admin123

## Troubleshooting

### Issue: "Failed to fetch" Error
**Solution**: 
1. Check that backend is deployed and running
2. Verify CORS settings in backend
3. Update API_BASE_URL in frontend config.js

### Issue: Demo Mode Not Working
**Solution**:
1. Clear browser localStorage
2. Click "Try Demo" button
3. If backend is unavailable, frontend will use mock data

### Issue: Database Connection Error
**Solution**:
1. Verify DATABASE_URL is correct
2. Check Supabase project is active
3. Ensure IP whitelist allows Render IPs
4. Try demo mode to test frontend

### Issue: CORS Errors
**Solution**:
1. Set FRONTEND_URL in backend environment variables
2. Add your domain to ALLOWED_ORIGINS
3. Redeploy backend

### Issue: Login Not Working
**Solution**:
1. Clear localStorage and try again
2. Use demo mode for testing
3. Verify database has admin user

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - Register new user
- `POST /api/auth/demo` - Demo mode login
- `GET /api/auth/me` - Get current user

### Organizations
- `GET /api/organizations` - List organizations
- `POST /api/organizations` - Create organization
- `PUT /api/organizations/{id}` - Update organization

### Branches
- `GET /api/branches` - List branches
- `POST /api/branches` - Create branch
- `PUT /api/branches/{id}` - Update branch

### Items
- `GET /api/items` - List items
- `POST /api/items` - Create item
- `PUT /api/items/{id}` - Update item
- `DELETE /api/items/{id}` - Delete item
- `GET /api/items/barcode/{barcode}` - Get by barcode

### Sales
- `GET /api/sales` - List sales
- `POST /api/sales` - Create sale (checkout)
- `GET /api/sales/{id}` - Get sale details
- `GET /api/sales/receipt/{id}` - Get receipt

### Reports
- `GET /api/reports/daily` - Daily sales report
- `GET /api/reports/monthly` - Monthly sales report
- `GET /api/reports/profit` - Profit report
- `GET /api/reports/stock-valuation` - Stock valuation

### Dashboard
- `GET /api/dashboard/stats` - Dashboard statistics
- `GET /api/dashboard/recent-sales` - Recent sales
- `GET /api/dashboard/low-stock-items` - Low stock items
- `GET /api/dashboard/expiring-items` - Expiring items

## Security Notes

1. **JWT Secret**: Change the `JWT_SECRET` in production to a secure random string
2. **Database**: Use strong passwords and enable SSL for production
3. **CORS**: Configure `ALLOWED_ORIGINS` for your production domains
4. **HTTPS**: Always use HTTPS in production
5. **Rate Limiting**: Consider adding rate limiting for production

## Support

For issues and questions, please create an issue on GitHub.

## License

MIT License
