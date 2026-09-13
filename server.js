require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const production = process.env.NODE_ENV === 'production';
const JWT_SECRET = String(process.env.JWT_SECRET || (production ? '' : 'development-only-secret-change-before-production-12345'));
if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'voucher.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function now() { return new Date().toISOString(); }
function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'campaign';
}
function normalizeVoucherCodes(input) {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set();
  const output = [];
  for (const raw of values) {
    const code = String(raw || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    output.push(code.slice(0, 180));
  }
  return output;
}
function appendQuery(urlString, key, value) {
  const url = new URL(urlString);
  url.searchParams.set(key, value);
  return url.toString();
}
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  hotspot_login_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned','disabled')),
  assigned_device_key TEXT,
  assigned_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, code),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  voucher_id INTEGER NOT NULL UNIQUE,
  device_key TEXT NOT NULL,
  client_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, device_key),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vouchers_campaign_status ON vouchers(campaign_id, status, id);
CREATE INDEX IF NOT EXISTS idx_claims_campaign_device ON claims(campaign_id, device_key);
`);

if (!hasColumn('users', 'display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
if (!hasColumn('users', 'role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'");
if (!hasColumn('campaigns', 'owner_id')) db.exec('ALTER TABLE campaigns ADD COLUMN owner_id INTEGER');

db.prepare("UPDATE users SET display_name = CASE WHEN display_name='' THEN email ELSE display_name END").run();
const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
if (firstUser) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(firstUser.id);

const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
if (adminEmail && adminPassword) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const passwordHash = bcrypt.hashSync(adminPassword, 12);
    db.prepare('INSERT INTO users (email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(adminEmail, passwordHash, 'Portal Administrator', 'admin', now());
    console.log(`Bootstrap admin created: ${adminEmail}`);
  } else {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(existing.id);
  }
} else if (!firstUser) {
  console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set. Admin login will not work until configured.');
}

const adminOwner = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1").get();
if (adminOwner) db.prepare('UPDATE campaigns SET owner_id=? WHERE owner_id IS NULL').run(adminOwner.id);

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });

function signUser(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, name: user.display_name }, JWT_SECRET, { expiresIn: '12h' });
}
function requireAuth(req, res, next) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,email,display_name,role FROM users WHERE id=?').get(decoded.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
    next();
  });
}
function campaignForUser(id, user) {
  if (user.role === 'admin') {
    return db.prepare(`SELECT c.*,u.email AS owner_email,u.display_name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=?`).get(id);
  }
  return db.prepare(`SELECT c.*,u.email AS owner_email,u.display_name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=? AND c.owner_id=?`).get(id, user.id);
}
function campaignsForUser(user) {
  if (user.role === 'admin') {
    return db.prepare(`SELECT c.*,u.email AS owner_email,u.display_name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id=c.owner_id ORDER BY c.id DESC`).all();
  }
  return db.prepare(`SELECT c.*,u.email AS owner_email,u.display_name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id=c.owner_id WHERE c.owner_id=? ORDER BY c.id DESC`).all(user.id);
}
function campaignWithStats(row) {
  if (!row) return null;
  const stats = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status='assigned' THEN 1 ELSE 0 END) AS assigned,
      SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled
    FROM vouchers WHERE campaign_id = ?`).get(row.id);
  return {
    ...row,
    total: Number(stats.total || 0),
    available: Number(stats.available || 0),
    assigned: Number(stats.assigned || 0),
    disabled: Number(stats.disabled || 0),
    qr_target: `${BASE_URL}/go/${row.public_token}`,
    claim_api: `${BASE_URL}/api/v1/claim`
  };
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'voucher-qr-portal', time: now() }));

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: signUser(user), user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } });
});

app.get('/api/admin/overview', requireAuth, (req, res) => {
  const campaigns = campaignsForUser(req.user).map(campaignWithStats);
  const summary = campaigns.reduce((out, c) => {
    out.vouchers_total += c.total;
    out.vouchers_available += c.available;
    out.vouchers_assigned += c.assigned;
    return out;
  }, { vouchers_total: 0, vouchers_available: 0, vouchers_assigned: 0 });
  res.json({ campaigns: campaigns.length, ...summary });
});

app.get('/api/admin/campaigns', requireAuth, (req, res) => {
  res.json({ campaigns: campaignsForUser(req.user).map(campaignWithStats) });
});

app.post('/api/admin/campaigns', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const hotspotLoginUrl = String(req.body.hotspot_login_url || '').trim();
  if (!name) return res.status(400).json({ error: 'Campaign name is required' });
  try {
    const parsed = new URL(hotspotLoginUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch (error) {
    return res.status(400).json({ error: 'A valid hotspot login URL is required, e.g. http://nexa.spot/login' });
  }
  const baseSlug = slugify(name); let slug = baseSlug; let index = 2;
  while (db.prepare('SELECT id FROM campaigns WHERE slug = ?').get(slug)) slug = `${baseSlug}-${index++}`;
  const token = randomToken(24); const stamp = now();
  const info = db.prepare(`INSERT INTO campaigns (owner_id,name,slug,public_token,hotspot_login_url,status,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(req.user.id, name, slug, token, hotspotLoginUrl, stamp, stamp);
  res.status(201).json({ campaign: campaignWithStats(campaignForUser(info.lastInsertRowid, req.user)) });
});

app.patch('/api/admin/campaigns/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id); const current = campaignForUser(id, req.user);
  if (!current) return res.status(404).json({ error: 'Campaign not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : current.name;
  const hotspotLoginUrl = req.body.hotspot_login_url !== undefined ? String(req.body.hotspot_login_url).trim() : current.hotspot_login_url;
  const status = req.body.status !== undefined ? String(req.body.status) : current.status;
  if (!name) return res.status(400).json({ error: 'Campaign name is required' });
  if (!['active', 'paused'].includes(status)) return res.status(400).json({ error: 'Invalid campaign status' });
  try { new URL(hotspotLoginUrl); } catch (error) { return res.status(400).json({ error: 'Invalid hotspot login URL' }); }
  db.prepare('UPDATE campaigns SET name=?,hotspot_login_url=?,status=?,updated_at=? WHERE id=?').run(name, hotspotLoginUrl, status, now(), id);
  res.json({ campaign: campaignWithStats(campaignForUser(id, req.user)) });
});

app.post('/api/admin/campaigns/:id/vouchers', requireAuth, (req, res) => {
  const id = Number(req.params.id); const campaign = campaignForUser(id, req.user);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const codes = normalizeVoucherCodes(req.body.vouchers);
  if (!codes.length) return res.status(400).json({ error: 'No voucher codes supplied' });
  if (codes.length > 10000) return res.status(400).json({ error: 'Maximum 10,000 vouchers per upload' });
  const insert = db.prepare("INSERT OR IGNORE INTO vouchers (campaign_id,code,status,created_at) VALUES (?,?,'available',?)");
  const tx = db.transaction((items) => { let added = 0; for (const code of items) added += insert.run(id, code, now()).changes; return added; });
  const added = tx(codes);
  res.json({ added, skipped: codes.length - added, campaign: campaignWithStats(campaignForUser(id, req.user)) });
});

app.get('/api/admin/campaigns/:id/vouchers', requireAuth, (req, res) => {
  const id = Number(req.params.id); if (!campaignForUser(id, req.user)) return res.status(404).json({ error: 'Campaign not found' });
  const rows = db.prepare(`SELECT id,code,status,assigned_device_key,assigned_at,created_at FROM vouchers WHERE campaign_id=? ORDER BY id DESC LIMIT 1000`).all(id);
  res.json({ vouchers: rows });
});

app.post('/api/admin/campaigns/:id/qr', requireAuth, async (req, res) => {
  const id = Number(req.params.id); const row = campaignForUser(id, req.user);
  if (!row) return res.status(404).json({ error: 'Campaign not found' });
  const target = `${BASE_URL}/go/${row.public_token}`;
  const svg = await QRCode.toString(target, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 1024 });
  res.json({ target, svg });
});

app.post('/api/admin/campaigns/:id/rotate-token', requireAuth, (req, res) => {
  const id = Number(req.params.id); if (!campaignForUser(id, req.user)) return res.status(404).json({ error: 'Campaign not found' });
  db.prepare('UPDATE campaigns SET public_token=?,updated_at=? WHERE id=?').run(randomToken(24), now(), id);
  res.json({ campaign: campaignWithStats(campaignForUser(id, req.user)) });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id,email,display_name,role,created_at FROM users ORDER BY id DESC').all();
  res.json({ users });
});
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const displayName = String(req.body.display_name || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'operator';
  if (!email || !displayName || password.length < 10) return res.status(400).json({ error: 'Name, email and a password of at least 10 characters are required' });
  try {
    const info = db.prepare('INSERT INTO users(email,password_hash,display_name,role,created_at) VALUES(?,?,?,?,?)')
      .run(email, bcrypt.hashSync(password, 12), displayName, role, now());
    const user = db.prepare('SELECT id,email,display_name,role,created_at FROM users WHERE id=?').get(info.lastInsertRowid);
    res.status(201).json({ user });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email already exists' });
    throw error;
  }
});

app.get('/go/:token', (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE public_token=? AND status='active'").get(req.params.token);
  if (!campaign) return res.status(404).send('This hotspot QR campaign is unavailable.');
  try { return res.redirect(302, appendQuery(campaign.hotspot_login_url, 'vq', campaign.public_token)); }
  catch (error) { return res.status(500).send('Campaign destination is invalid.'); }
});

const claimCors = cors({ origin: '*', methods: ['POST','OPTIONS'], allowedHeaders: ['Content-Type'] });
app.options('/api/v1/claim', claimCors);
const claimVoucher = db.transaction((campaign, deviceKey, reqMeta) => {
  const prior = db.prepare(`SELECT v.code,v.status,c.created_at FROM claims c JOIN vouchers v ON v.id=c.voucher_id WHERE c.campaign_id=? AND c.device_key=?`).get(campaign.id, deviceKey);
  if (prior) return { reused: true, voucher: prior.code, assigned_at: prior.created_at };
  const voucher = db.prepare("SELECT id,code FROM vouchers WHERE campaign_id=? AND status='available' ORDER BY id ASC LIMIT 1").get(campaign.id);
  if (!voucher) return null;
  const stamp = now();
  const changed = db.prepare("UPDATE vouchers SET status='assigned',assigned_device_key=?,assigned_at=? WHERE id=? AND status='available'").run(deviceKey, stamp, voucher.id).changes;
  if (!changed) throw new Error('Voucher assignment race detected');
  db.prepare('INSERT INTO claims(campaign_id,voucher_id,device_key,client_ip,user_agent,created_at) VALUES(?,?,?,?,?,?)')
    .run(campaign.id, voucher.id, deviceKey, reqMeta.ip, reqMeta.userAgent, stamp);
  return { reused: false, voucher: voucher.code, assigned_at: stamp };
});

app.post('/api/v1/claim', claimLimiter, claimCors, (req, res) => {
  const token = String(req.body.campaign_token || '').trim();
  const deviceKey = String(req.body.device_key || '').trim().toLowerCase().slice(0, 180);
  if (!token || !deviceKey) return res.status(400).json({ error: 'campaign_token and device_key are required' });
  const campaign = db.prepare("SELECT * FROM campaigns WHERE public_token=? AND status='active'").get(token);
  if (!campaign) return res.status(404).json({ error: 'QR campaign is invalid or paused' });
  try {
    const result = claimVoucher.immediate(campaign, deviceKey, { ip: req.ip || '', userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
    if (!result) return res.status(409).json({ error: 'No vouchers are currently available', code: 'POOL_EMPTY' });
    const remaining = db.prepare("SELECT COUNT(*) count FROM vouchers WHERE campaign_id=? AND status='available'").get(campaign.id).count;
    res.json({ success:true,campaign:campaign.name,voucher:result.voucher,reused:result.reused,assigned_at:result.assigned_at,remaining:Number(remaining || 0) });
  } catch (error) {
    console.error('claim error', error);
    res.status(500).json({ error: 'Unable to assign a voucher' });
  }
});

app.get('/api/v1/campaign/:token/status', claimCors, (req, res) => {
  const campaign = db.prepare('SELECT id,name,status FROM campaigns WHERE public_token=?').get(req.params.token);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const remaining = db.prepare("SELECT COUNT(*) count FROM vouchers WHERE campaign_id=? AND status='available'").get(campaign.id).count;
  res.json({ name:campaign.name,status:campaign.status,remaining:Number(remaining || 0) });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Unexpected server error' });
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  next();
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => { console.log(`Voucher QR Portal listening on port ${PORT}`); console.log(`Base URL: ${BASE_URL}`); });
