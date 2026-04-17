'use strict';
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
const SESSION_SECRET = process.env.SESSION_SECRET || 'sulav-vps-secret-2024-change-me';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'sulav.db');

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Database setup
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    credits INTEGER DEFAULT 1,
    banned INTEGER DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    main_file TEXT DEFAULT 'main.py',
    status TEXT DEFAULT 'stopped',
    user_id TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    logs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    credits INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    used_by TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    site_name TEXT DEFAULT 'SULAV VPS',
    login_title TEXT DEFAULT 'Sulav Gaming',
    dashboard_title TEXT DEFAULT 'SULAV VPS',
    primary_color TEXT DEFAULT '#00ff41',
    accent_color TEXT DEFAULT '#ff00ff',
    bg_color TEXT DEFAULT '#050505',
    maintenance_mode INTEGER DEFAULT 0,
    maintenance_message TEXT DEFAULT 'System under maintenance',
    broadcast_message TEXT DEFAULT '',
    broadcast_active INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO site_settings (id) VALUES (1);
`);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ======= HELPER =======
function getSettings() {
  return db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
}

function addNotification(message, type = 'info') {
  db.prepare('INSERT INTO notifications (id, message, type) VALUES (?, ?, ?)').run(uuidv4(), message, type);
}

// ======= AUTH =======
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: 'All fields required' });

    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      const id = uuidv4();
      db.prepare('INSERT INTO users (id, username, password, referral_code, credits) VALUES (?, ?, ?, ?, 1)').run(id, username, password, refCode);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }
    if (user.banned) return res.json({ success: false, message: 'Account banned' });
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(password, user.id);

    req.session.userId = user.id;
    req.session.isAdmin = false;
    return res.json({ success: true, message: 'Login successful', user: { id: user.id, username: user.username, credits: user.credits, banned: !!user.banned, referralCode: user.referral_code } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password, referralCode } = req.body;
    if (!username || !password) return res.json({ success: false, message: 'All fields required' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.json({ success: false, message: 'Username already taken' });

    const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    let extraCredits = 0;

    if (referralCode) {
      const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(referralCode);
      if (referrer) {
        db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').run(referrer.id);
        extraCredits = 1;
      }
    }

    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password, referral_code, referred_by, credits) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, password, refCode, referralCode || null, 1 + extraCredits);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    req.session.userId = user.id;
    return res.json({ success: true, message: 'Registered!', user: { id: user.id, username: user.username, credits: user.credits, banned: false, referralCode: user.referral_code } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false, message: 'Not logged in' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ success: false });
  return res.json({ id: user.id, username: user.username, credits: user.credits, banned: !!user.banned, referralCode: user.referral_code });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, message: 'Logged out' }));
});

// ======= PROJECTS =======
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ success: false, message: 'Not logged in' });
  next();
}

app.get('/api/projects', requireAuth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  return res.json(projects.map(p => ({ id: p.id, name: p.name, mainFile: p.main_file, status: p.status, userId: p.user_id, createdAt: p.created_at, logs: p.logs })));
});

app.post('/api/projects', requireAuth, upload.single('file'), (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user || user.credits < 1) return res.status(403).json({ success: false, message: 'Not enough credits. Earn credits via referrals or coupons.' });
    const { name } = req.body;
    if (!name || !req.file) return res.status(400).json({ success: false, message: 'Name and file required' });

    const safeDir = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const projectDir = path.join(UPLOADS_DIR, req.session.userId, safeDir + '_' + Date.now());
    fs.mkdirSync(projectDir, { recursive: true });

    const fileExt = req.file.originalname.split('.').pop().toLowerCase();
    if (fileExt === 'zip') {
      try {
        const zip = new AdmZip(req.file.buffer);
        zip.extractAllTo(projectDir, true);
      } catch {
        fs.writeFileSync(path.join(projectDir, req.file.originalname), req.file.buffer);
      }
    } else {
      fs.writeFileSync(path.join(projectDir, req.file.originalname), req.file.buffer);
    }

    const files = fs.readdirSync(projectDir);
    let mainFile = 'main.py';
    if (files.includes('main.py')) mainFile = 'main.py';
    else if (files.includes('app.py')) mainFile = 'app.py';
    else if (files.includes('bot.py')) mainFile = 'bot.py';
    else {
      const pyFile = files.find(f => f.endsWith('.py'));
      if (pyFile) mainFile = pyFile;
      else if (files.length > 0) mainFile = files[0];
    }

    const id = uuidv4();
    db.prepare('INSERT INTO projects (id, name, main_file, status, user_id, storage_path, logs) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, mainFile, 'stopped', req.session.userId, projectDir, '');
    db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ?').run(req.session.userId);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return res.json({ id: project.id, name: project.name, mainFile: project.main_file, status: project.status, userId: project.user_id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ success: false, message: 'Not found' });
  return res.json({ id: p.id, name: p.name, mainFile: p.main_file, status: p.status, userId: p.user_id, createdAt: p.created_at, logs: p.logs });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ success: false, message: 'Not found' });
  try { fs.rmSync(p.storage_path, { recursive: true, force: true }); } catch {}
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  return res.json({ success: true, message: 'Deleted' });
});

app.post('/api/projects/:id/start', requireAuth, (req, res) => {
  const log = new Date().toISOString() + ' [SYSTEM] Project started\n';
  db.prepare("UPDATE projects SET status = 'running', logs = ? WHERE id = ? AND user_id = ?").run(log, req.params.id, req.session.userId);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  return res.json({ id: p.id, name: p.name, mainFile: p.main_file, status: p.status, userId: p.user_id });
});

app.post('/api/projects/:id/stop', requireAuth, (req, res) => {
  const log = new Date().toISOString() + ' [SYSTEM] Project stopped\n';
  db.prepare("UPDATE projects SET status = 'stopped', logs = ? WHERE id = ? AND user_id = ?").run(log, req.params.id, req.session.userId);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  return res.json({ id: p.id, name: p.name, mainFile: p.main_file, status: p.status, userId: p.user_id });
});

app.post('/api/projects/:id/restart', requireAuth, (req, res) => {
  const log = new Date().toISOString() + ' [SYSTEM] Project restarted\n';
  db.prepare("UPDATE projects SET status = 'running', logs = ? WHERE id = ? AND user_id = ?").run(log, req.params.id, req.session.userId);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  return res.json({ id: p.id, name: p.name, mainFile: p.main_file, status: p.status, userId: p.user_id });
});

app.put('/api/projects/:id/settings', requireAuth, (req, res) => {
  const { mainFile, name } = req.body;
  if (mainFile) db.prepare('UPDATE projects SET main_file = ? WHERE id = ? AND user_id = ?').run(mainFile, req.params.id, req.session.userId);
  if (name) db.prepare('UPDATE projects SET name = ? WHERE id = ? AND user_id = ?').run(name, req.params.id, req.session.userId);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  return res.json({ id: p.id, name: p.name, mainFile: p.main_file, status: p.status, userId: p.user_id });
});

app.get('/api/projects/:id/logs', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ logs: '', projectId: req.params.id });
  return res.json({ logs: p.logs || 'No logs yet.', projectId: p.id });
});

// Project files
app.get('/api/projects/:id/files', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.json([]);
  const listFiles = (dir, base = '') => {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const rel = base ? base + '/' + e.name : e.name;
        if (e.isDirectory()) {
          results.push({ name: e.name, path: rel, size: 0, type: 'directory' });
          results.push(...listFiles(path.join(dir, e.name), rel));
        } else {
          const stats = fs.statSync(path.join(dir, e.name));
          results.push({ name: e.name, path: rel, size: stats.size, type: 'file' });
        }
      }
    } catch {}
    return results;
  };
  return res.json(listFiles(p.storage_path));
});

app.get('/api/projects/:id/files/*', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ content: '', path: '' });
  const filePath = req.params[0];
  const full = path.join(p.storage_path, filePath);
  if (!full.startsWith(p.storage_path)) return res.status(403).json({ content: '', path: '' });
  try {
    const content = fs.readFileSync(full, 'utf-8');
    return res.json({ content, path: filePath });
  } catch { return res.json({ content: 'Binary file - cannot display', path: filePath }); }
});

app.put('/api/projects/:id/files/*', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ success: false, message: 'Not found' });
  const filePath = req.params[0];
  const full = path.join(p.storage_path, filePath);
  if (!full.startsWith(p.storage_path)) return res.status(403).json({ success: false, message: 'Forbidden' });
  fs.writeFileSync(full, req.body.content);
  return res.json({ success: true, message: 'Saved' });
});

app.delete('/api/projects/:id/files/*', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ success: false, message: 'Not found' });
  const filePath = req.params[0];
  const full = path.join(p.storage_path, filePath);
  if (!full.startsWith(p.storage_path)) return res.status(403).json({ success: false, message: 'Forbidden' });
  fs.unlinkSync(full);
  return res.json({ success: true, message: 'Deleted' });
});

app.post('/api/projects/:id/upload', requireAuth, upload.single('file'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!p || !req.file) return res.status(404).json({ success: false, message: 'Not found' });
  fs.writeFileSync(path.join(p.storage_path, req.file.originalname), req.file.buffer);
  return res.json({ success: true, message: 'Uploaded' });
});

// Dashboard stats
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  const projects = db.prepare('SELECT status FROM projects WHERE user_id = ?').all(req.session.userId);
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.session.userId);
  const running = projects.filter(p => p.status === 'running').length;
  return res.json({
    totalProjects: projects.length,
    runningProjects: running,
    stoppedProjects: projects.length - running,
    credits: user ? user.credits : 0,
    cpuUsage: (Math.random() * 50 + 10).toFixed(1),
    ramUsage: (Math.random() * 40 + 30).toFixed(1),
  });
});

// ======= PACKAGES =======
app.get('/api/packages/list', requireAuth, (req, res) => {
  try {
    const out = execSync('pip3 list --format=json 2>/dev/null || pip list --format=json 2>/dev/null', { timeout: 15000, encoding: 'utf-8' });
    return res.json(JSON.parse(out).map(p => ({ name: p.name, version: p.version })));
  } catch { return res.json([]); }
});

app.post('/api/packages/install', requireAuth, (req, res) => {
  const { packageName } = req.body;
  if (!packageName) return res.json({ success: false, message: 'Package name required' });
  try {
    const out = execSync(`pip3 install ${packageName} 2>&1 || pip install ${packageName} 2>&1`, { timeout: 120000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
    return res.json({ success: true, message: `${packageName} installed`, output: out });
  } catch (e) {
    return res.json({ success: false, message: 'Install failed', output: e.stdout || e.message });
  }
});

app.post('/api/packages/uninstall', requireAuth, (req, res) => {
  const { packageName } = req.body;
  if (!packageName) return res.json({ success: false, message: 'Package name required' });
  try {
    const out = execSync(`pip3 uninstall -y ${packageName} 2>&1`, { timeout: 60000, encoding: 'utf-8' });
    return res.json({ success: true, message: `${packageName} removed`, output: out });
  } catch (e) {
    return res.json({ success: false, message: 'Failed', output: e.message });
  }
});

// ======= TERMINAL =======
app.post('/api/terminal/execute', requireAuth, (req, res) => {
  const { command } = req.body;
  if (!command) return res.json({ output: 'No command', exitCode: 1 });
  try {
    const out = execSync(command, { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    return res.json({ output: out || 'Done', exitCode: 0 });
  } catch (e) {
    return res.json({ output: e.stderr || e.stdout || e.message, exitCode: e.status || 1 });
  }
});

// ======= CREDITS =======
app.get('/api/credits/balance', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  return res.json({ credits: user ? user.credits : 0, referralCode: user ? user.referral_code : '' });
});

app.post('/api/credits/redeem', requireAuth, (req, res) => {
  const { code } = req.body;
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
  if (!coupon) return res.status(404).json({ success: false, message: 'Invalid coupon' });
  if (coupon.used) return res.status(400).json({ success: false, message: 'Coupon already used' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  db.prepare('UPDATE coupons SET used = 1, used_by = ? WHERE id = ?').run(user.username, coupon.id);
  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(coupon.credits, req.session.userId);
  addNotification(`${user.username} redeemed coupon ${code} for ${coupon.credits} credits`, 'coupon');
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  return res.json({ credits: updated.credits, referralCode: updated.referral_code });
});

app.post('/api/credits/create-coupon', requireAuth, (req, res) => {
  const { credits } = req.body;
  if (!credits || credits < 1) return res.status(400).json({ success: false, message: 'Invalid amount' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.credits < credits) return res.status(400).json({ success: false, message: 'Not enough credits' });
  const code = 'SV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const id = uuidv4();
  db.prepare('INSERT INTO coupons (id, code, credits, created_by) VALUES (?, ?, ?, ?)').run(id, code, credits, user.username);
  db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(credits, req.session.userId);
  const c = db.prepare('SELECT * FROM coupons WHERE id = ?').get(id);
  return res.json({ id: c.id, code: c.code, credits: c.credits, used: false, createdBy: c.created_by });
});

app.get('/api/credits/referral', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const referred = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?').get(user ? user.referral_code : '');
  return res.json({ referralCode: user ? user.referral_code : '', totalReferred: referred.cnt, creditsEarned: referred.cnt });
});

// ======= HELP =======
const HELP_KB = {
  upload: 'To upload a project: Click the + button, give your project a name, and upload a .zip file. The system auto-detects main.py, app.py, or bot.py.',
  start: 'To start a project: Click the green play button on your project card.',
  stop: 'To stop a project: Click the red stop button.',
  restart: 'To restart: Click the restart button.',
  delete: 'To delete: Click DELETE on a stopped project. This is permanent.',
  credits: 'Credits: 1 credit = 1 project. Start with 1 credit. Earn via referrals and coupons.',
  referral: 'Share your referral code - both you and your friend get +1 credit when they register.',
  coupon: 'Use redeem to enter a coupon code. Create coupons from your own credits to share.',
  packages: 'Package Installer: Install any pip package. Access from the menu.',
  terminal: 'Terminal: Run shell commands from the menu.',
  files: 'File Manager: Click the eye icon on a project to view, edit, or delete files.',
  logs: 'Live Logs: Click the eye icon then go to the Logs tab to see output.',
  python: 'Python hosting: Upload .py files or .zip containing Python scripts. Main file is auto-detected.',
  hosting: 'SULAV VPS provides Python process hosting. Upload your zip, set main file, click Start.',
};

app.post('/api/help/ask', (req, res) => {
  const { question } = req.body;
  if (!question) return res.json({ answer: 'Ask me anything about SULAV VPS!' });
  const q = question.toLowerCase();
  let answer = 'I am the SULAV VPS AI Assistant. I can help with:\n\n• Uploading and managing projects\n• Starting/stopping/restarting\n• File management\n• Package installation\n• Credits and coupons\n• Referral system\n• Terminal usage\n\nAsk me something specific!';
  for (const [key, val] of Object.entries(HELP_KB)) {
    if (q.includes(key)) { answer = val; break; }
  }
  if (q.includes('how') && (q.includes('work') || q.includes('use'))) {
    answer = 'How SULAV VPS works:\n\n1. Register/Login (any password works)\n2. Upload a .zip with your Python files\n3. System detects main file\n4. Click Start to run\n5. View logs in real-time\n6. Install pip packages as needed\n\nCredits system: 1 credit = 1 project. Earn via referrals and coupon codes.';
  }
  if (q.includes('hello') || q.includes('hi')) answer = 'Hello! Welcome to SULAV VPS. How can I help you today?';
  return res.json({ answer });
});

// ======= ADMIN =======
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Admin required' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ success: false, message: 'Wrong password' });
  req.session.isAdmin = true;
  return res.json({ success: true, message: 'Admin access granted' });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const settings = getSettings();
  return res.json({
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalProjects: db.prepare('SELECT COUNT(*) as c FROM projects').get().c,
    runningProjects: db.prepare("SELECT COUNT(*) as c FROM projects WHERE status = 'running'").get().c,
    totalCreditsIssued: 0,
    totalCoupons: db.prepare('SELECT COUNT(*) as c FROM coupons').get().c,
    bannedUsers: db.prepare('SELECT COUNT(*) as c FROM users WHERE banned = 1').get().c,
    maintenanceMode: !!settings.maintenance_mode,
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  return res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    password: u.password,
    credits: u.credits,
    banned: !!u.banned,
    projectCount: db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id = ?').get(u.id).c,
    referralCode: u.referral_code,
    createdAt: u.created_at,
  })));
});

app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(req.params.id);
  return res.json({ success: true, message: 'Banned' });
});

app.post('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(req.params.id);
  return res.json({ success: true, message: 'Unbanned' });
});

app.put('/api/admin/users/:id/credits', requireAdmin, (req, res) => {
  const { credits, action } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'Not found' });
  let nc = user.credits;
  if (action === 'add') nc += credits;
  else if (action === 'remove') nc = Math.max(0, nc - credits);
  else if (action === 'set') nc = credits;
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(nc, req.params.id);
  return res.json({ success: true, message: 'Updated to ' + nc });
});

app.get('/api/admin/users/:id/files', requireAdmin, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects WHERE user_id = ?').all(req.params.id);
  const files = [];
  for (const p of projects) {
    try {
      const entries = fs.readdirSync(p.storage_path);
      for (const e of entries) {
        const full = path.join(p.storage_path, e);
        if (fs.statSync(full).isFile()) {
          files.push({ id: p.id + '_' + e, projectName: p.name, fileName: e, fileSize: fs.statSync(full).size, uploadedAt: p.created_at });
        }
      }
    } catch {}
  }
  return res.json(files);
});

app.get('/api/admin/users/:uid/files/:fileId/download', requireAdmin, (req, res) => {
  const parts = req.params.fileId.split('_');
  const projectId = parts[0];
  const fileName = parts.slice(1).join('_');
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return res.status(404).json({ success: false });
  return res.download(path.join(p.storage_path, fileName));
});

app.get('/api/admin/maintenance', (req, res) => {
  const s = getSettings();
  return res.json({ enabled: !!s.maintenance_mode, message: s.maintenance_message });
});

app.put('/api/admin/maintenance', requireAdmin, (req, res) => {
  const { enabled, message } = req.body;
  db.prepare('UPDATE site_settings SET maintenance_mode = ?, maintenance_message = ? WHERE id = 1').run(enabled ? 1 : 0, message || 'Under maintenance');
  return res.json({ enabled: !!enabled, message: message || 'Under maintenance' });
});

app.get('/api/admin/broadcast', (req, res) => {
  const s = getSettings();
  return res.json({ message: s.broadcast_message, active: !!s.broadcast_active });
});

app.put('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { message, active } = req.body;
  db.prepare('UPDATE site_settings SET broadcast_message = ?, broadcast_active = ? WHERE id = 1').run(message, active ? 1 : 0);
  return res.json({ message, active: !!active });
});

app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  return res.json(db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all().map(c => ({ id: c.id, code: c.code, credits: c.credits, used: !!c.used, usedBy: c.used_by, createdBy: c.created_by, createdAt: c.created_at })));
});

app.post('/api/admin/coupons', requireAdmin, (req, res) => {
  const { code, credits } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO coupons (id, code, credits, created_by) VALUES (?, ?, ?, ?)').run(id, code, credits, 'admin');
  const c = db.prepare('SELECT * FROM coupons WHERE id = ?').get(id);
  return res.json({ id: c.id, code: c.code, credits: c.credits, used: false, createdBy: 'admin' });
});

app.delete('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
  return res.json({ success: true, message: 'Deleted' });
});

app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  return res.json(db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all().map(n => ({ id: n.id, message: n.message, type: n.type, createdAt: n.created_at })));
});

app.get('/api/admin/site-settings', (req, res) => {
  const s = getSettings();
  return res.json({ siteName: s.site_name, loginTitle: s.login_title, dashboardTitle: s.dashboard_title, primaryColor: s.primary_color, accentColor: s.accent_color, backgroundColor: s.bg_color });
});

app.put('/api/admin/site-settings', requireAdmin, (req, res) => {
  const { siteName, loginTitle, dashboardTitle, primaryColor, accentColor, backgroundColor } = req.body;
  const updates = [];
  const vals = [];
  if (siteName) { updates.push('site_name = ?'); vals.push(siteName); }
  if (loginTitle) { updates.push('login_title = ?'); vals.push(loginTitle); }
  if (dashboardTitle) { updates.push('dashboard_title = ?'); vals.push(dashboardTitle); }
  if (primaryColor) { updates.push('primary_color = ?'); vals.push(primaryColor); }
  if (accentColor) { updates.push('accent_color = ?'); vals.push(accentColor); }
  if (backgroundColor) { updates.push('bg_color = ?'); vals.push(backgroundColor); }
  if (updates.length > 0) {
    vals.push(1);
    db.prepare(`UPDATE site_settings SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  }
  const s = getSettings();
  return res.json({ siteName: s.site_name, loginTitle: s.login_title, dashboardTitle: s.dashboard_title, primaryColor: s.primary_color, accentColor: s.accent_color, backgroundColor: s.bg_color });
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'SULAV VPS' }));

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SULAV VPS running on port ${PORT}`);
});
