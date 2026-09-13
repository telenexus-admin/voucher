import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { openDatabase } from './db.js';
import { createAuth } from './auth.js';
import { parseVoucherCodes, importVouchers, claimVoucher, confirmClaim } from './vouchers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const db = openDatabase();
const auth = createAuth(db);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use('/assets', express.static(path.join(root, 'public'), { maxAge: '1h' }));
app.use(auth.attach);

app.locals.formatDate = value => value ? new Date(String(value).replace(' ', 'T') + 'Z').toLocaleString() : '—';
app.locals.number = value => new Intl.NumberFormat().format(Number(value || 0));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });

function publicBase(req) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
function normalizeHost(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}
function normalizeLandingPath(value) {
  const v = String(value || '/login').trim();
  return '/' + v.replace(/^\/+/, '');
}
function slugify(value) {
  return String(value || 'hotspot').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'hotspot';
}
function uniqueSlug(name) {
  const base = slugify(name); let slug = base; let i = 2;
  while (db.prepare('SELECT 1 FROM campaigns WHERE slug=?').get(slug)) slug = `${base}-${i++}`;
  return slug;
}
function campaignForUser(id, user) {
  if (user.role === 'admin') return db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
  return db.prepare('SELECT * FROM campaigns WHERE id=? AND owner_id=?').get(id, user.id);
}
function statsForCampaign(id) {
  return db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS available,
    SUM(CASE WHEN status='assigned' THEN 1 ELSE 0 END) AS assigned,
    SUM(CASE WHEN status='used' THEN 1 ELSE 0 END) AS used,
    SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled
    FROM vouchers WHERE campaign_id=?`).get(id);
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});
app.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  }
  auth.setSession(res, user);
  res.redirect('/dashboard');
});
app.post('/logout', auth.requireUser, auth.verifyCsrf, (_req, res) => { auth.clearSession(res); res.redirect('/login'); });

app.get('/dashboard', auth.requireUser, (req, res) => {
  const where = req.user.role === 'admin' ? '' : 'WHERE c.owner_id=?';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const campaigns = db.prepare(`SELECT c.*,u.display_name AS owner_name,
      COUNT(v.id) AS total,
      SUM(CASE WHEN v.status='unused' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN v.status='assigned' THEN 1 ELSE 0 END) AS assigned,
      SUM(CASE WHEN v.status='used' THEN 1 ELSE 0 END) AS used
    FROM campaigns c JOIN users u ON u.id=c.owner_id
    LEFT JOIN vouchers v ON v.campaign_id=c.id ${where}
    GROUP BY c.id ORDER BY c.created_at DESC`).all(...args);
  const summary = campaigns.reduce((a,c) => ({
    campaigns: a.campaigns + 1,
    total: a.total + Number(c.total || 0),
    available: a.available + Number(c.available || 0),
    assigned: a.assigned + Number(c.assigned || 0)
  }), { campaigns:0,total:0,available:0,assigned:0 });
  res.render('dashboard', { campaigns, summary });
});

app.get('/campaigns/new', auth.requireUser, (req, res) => res.render('new-campaign', { error: null }));
app.post('/campaigns', auth.requireUser, auth.verifyCsrf, (req, res) => {
  const name = String(req.body.name || '').trim();
  const host = normalizeHost(req.body.hotspot_host);
  if (!name || !host) return res.status(400).render('new-campaign', { error: 'Hotspot name and local hotspot hostname are required.' });
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO campaigns(id,owner_id,name,slug,public_token,hotspot_host,landing_path,description)
              VALUES(?,?,?,?,?,?,?,?)`).run(id, req.user.id, name, uniqueSlug(name), token, host, normalizeLandingPath(req.body.landing_path), String(req.body.description || '').trim() || null);
  res.redirect(`/campaigns/${id}`);
});

app.get('/campaigns/:id', auth.requireUser, (req, res) => {
  const campaign = campaignForUser(req.params.id, req.user);
  if (!campaign) return res.status(404).send('Campaign not found.');
  const stats = statsForCampaign(campaign.id);
  const batches = db.prepare('SELECT * FROM voucher_batches WHERE campaign_id=? ORDER BY created_at DESC LIMIT 20').all(campaign.id);
  const vouchers = db.prepare('SELECT * FROM vouchers WHERE campaign_id=? ORDER BY id DESC LIMIT 100').all(campaign.id);
  res.render('campaign', { campaign, stats, batches, vouchers, baseUrl: publicBase(req), notice: req.query.notice || null, error: req.query.error || null });
});

app.post('/campaigns/:id/import', auth.requireUser, upload.single('voucher_file'), (req, res, next) => {
  try {
    if (req.body._csrf !== req.user.csrf) return res.status(403).send('Invalid request token.');
    const campaign = campaignForUser(req.params.id, req.user);
    if (!campaign) return res.status(404).send('Campaign not found.');
    const fileText = req.file ? req.file.buffer.toString('utf8') : '';
    const codes = parseVoucherCodes(`${req.body.vouchers || ''}\n${fileText}`);
    if (!codes.length) return res.redirect(`/campaigns/${campaign.id}?error=${encodeURIComponent('No voucher codes were found. Use TXT or CSV, or paste codes directly.')}`);
    const result = importVouchers(db, campaign.id, codes, { label: String(req.body.label || '').trim(), sourceName: req.file?.originalname || '' });
    res.redirect(`/campaigns/${campaign.id}?notice=${encodeURIComponent(`${result.imported} vouchers added; ${result.duplicates} duplicates skipped.`)}`);
  } catch (error) { next(error); }
});

app.post('/campaigns/:id/status', auth.requireUser, auth.verifyCsrf, (req, res) => {
  const campaign = campaignForUser(req.params.id, req.user);
  if (!campaign) return res.status(404).send('Campaign not found.');
  const next = req.body.status === 'paused' ? 'paused' : 'active';
  db.prepare('UPDATE campaigns SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, campaign.id);
  res.redirect(`/campaigns/${campaign.id}`);
});

app.get('/campaigns/:id/qr.png', auth.requireUser, async (req, res) => {
  const campaign = campaignForUser(req.params.id, req.user);
  if (!campaign) return res.status(404).send('Campaign not found.');
  const url = `${publicBase(req)}/q/${campaign.public_token}`;
  const png = await QRCode.toBuffer(url, { width: 900, margin: 2, errorCorrectionLevel: 'H' });
  res.type('png').set('Cache-Control','no-store').send(png);
});
app.get('/campaigns/:id/print', auth.requireUser, (req, res) => {
  const campaign = campaignForUser(req.params.id, req.user);
  if (!campaign) return res.status(404).send('Campaign not found.');
  res.render('print', { campaign, qrUrl: `/campaigns/${campaign.id}/qr.png`, publicUrl: `${publicBase(req)}/q/${campaign.public_token}` });
});

app.get('/users', auth.requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id,email,display_name,role,created_at FROM users ORDER BY created_at DESC').all();
  res.render('users', { users, error: null });
});
app.post('/users', auth.requireAdmin, auth.verifyCsrf, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.display_name || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'operator';
  if (!email || !name || password.length < 10) {
    const users = db.prepare('SELECT id,email,display_name,role,created_at FROM users ORDER BY created_at DESC').all();
    return res.status(400).render('users', { users, error: 'Name, email and a password of at least 10 characters are required.' });
  }
  try {
    db.prepare('INSERT INTO users(email,password_hash,display_name,role) VALUES(?,?,?,?)').run(email, bcrypt.hashSync(password, 12), name, role);
    res.redirect('/users');
  } catch {
    const users = db.prepare('SELECT id,email,display_name,role,created_at FROM users ORDER BY created_at DESC').all();
    res.status(409).render('users', { users, error: 'That email is already registered.' });
  }
});

app.get('/q/:token', claimLimiter, (req, res) => {
  const campaign = db.prepare(`SELECT public_token,hotspot_host,landing_path,status FROM campaigns WHERE public_token=?`).get(req.params.token);
  if (!campaign) return res.status(404).send('QR campaign not found.');
  if (campaign.status !== 'active') return res.status(409).send('This hotspot QR is currently paused.');
  const destination = new URL(`http://${campaign.hotspot_host}${campaign.landing_path}`);
  destination.searchParams.set('qr', campaign.public_token);
  destination.searchParams.set('qrs', publicBase(req));
  res.redirect(302, destination.toString());
});

app.use('/api/public', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/public/campaigns/:token/claim', claimLimiter, (req, res) => {
  const deviceKey = String(req.body.device_id || req.body.mac || '').trim().toLowerCase();
  if (!deviceKey || deviceKey.length > 128) return res.status(400).json({ ok:false, error:'device_id is required.' });
  try {
    const result = claimVoucher(db, req.params.token, deviceKey, { clientIp: req.ip, userAgent: req.get('user-agent') });
    res.json({ ok:true, campaign: result.campaign.name, voucher: result.code, claim_id: result.claimId, reused: result.reused, status: result.status });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok:false, code:error.code || 'CLAIM_FAILED', error:error.message || 'Unable to assign voucher.' });
  }
});
app.post('/api/public/campaigns/:token/confirm', claimLimiter, (req, res) => {
  const deviceKey = String(req.body.device_id || req.body.mac || '').trim().toLowerCase();
  const claimId = String(req.body.claim_id || '').trim();
  if (!deviceKey || !claimId) return res.status(400).json({ ok:false });
  const ok = confirmClaim(db, req.params.token, claimId, deviceKey);
  res.status(ok ? 200 : 404).json({ ok });
});

app.use((error, req, res, _next) => {
  console.error(error);
  res.status(500).send(process.env.NODE_ENV === 'production' ? 'Unexpected server error.' : String(error.stack || error));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Voucher QR Portal listening on :${port}`));
