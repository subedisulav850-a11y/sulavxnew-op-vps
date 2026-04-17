# SULAV VPS - Python Hosting Platform

A professional Python hosting platform with a hacker matrix UI.

## Deploy to Railway

### Method 1: GitHub + Railway (Recommended)
1. Upload this folder to a GitHub repository
2. Go to [Railway.app](https://railway.app)
3. Click "New Project" → "Deploy from GitHub"
4. Select your repository
5. Set environment variables (see below)
6. Click Deploy

### Method 2: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Environment Variables

Set these in Railway dashboard under "Variables":

| Variable | Value | Required |
|----------|-------|----------|
| `SESSION_SECRET` | Any long random string | Yes |
| `ADMIN_PASSWORD` | Your admin password (default: 676767) | No |
| `NODE_ENV` | production | No |
| `PORT` | Auto-set by Railway | No |

## Features

- **Security Check** - Human verification on first visit
- **Login System** - Any password works, auto-creates accounts
- **Project Hosting** - Upload .zip or .py files
- **File Manager** - View, edit, delete project files
- **Live Logs** - Real-time project logs
- **Package Installer** - pip install any package
- **Terminal** - Run shell commands
- **Credits System** - 1 credit = 1 project
- **Referral System** - Earn credits by referring users
- **Coupon System** - Create and redeem coupon codes
- **Admin Panel** - Hidden at `/admin` password area
- **Broadcast** - Send messages to all users
- **Maintenance Mode** - Take site offline
- **Site Settings** - Change colors, names

## Admin Panel

Click "Admin Panel" in the menu sidebar. Default password: `676767`

Admin can:
- View all users, passwords, and their files
- Ban/unban users
- Add/remove credits
- Create coupons
- Send broadcast messages
- Toggle maintenance mode
- Change site colors and names
- Download user files

## Default Settings

- Login title: **Sulav Gaming**
- Dashboard title: **SULAV VPS**
- Theme: Matrix green on black
- Admin password: **676767**
- Starting credits: **1 per user**

## Data Storage

On Railway, data is stored in `/data` directory. For persistence, add a Railway Volume at `/data`.

Without a volume, data resets on each deploy. With a volume, all user data persists permanently.
