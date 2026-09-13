import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

export function openDatabase() {
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'voucher.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('admin','operator')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      public_token TEXT NOT NULL UNIQUE,
      hotspot_host TEXT NOT NULL,
      landing_path TEXT NOT NULL DEFAULT '/login',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voucher_batches (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      label TEXT,
      source_name TEXT,
      imported_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      batch_id TEXT REFERENCES voucher_batches(id) ON DELETE SET NULL,
      code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused','assigned','used','disabled')),
      assigned_device TEXT,
      assigned_at TEXT,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, code)
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
      device_key TEXT NOT NULL,
      client_ip TEXT,
      user_agent TEXT,
      status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','used','failed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, device_key)
    );

    CREATE INDEX IF NOT EXISTS idx_vouchers_campaign_status ON vouchers(campaign_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_claims_campaign_device ON claims(campaign_id, device_key);
  `);

  bootstrapAdmin(db);
  return db;
}

function bootstrapAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  const name = String(process.env.BOOTSTRAP_ADMIN_NAME || 'Portal Administrator').trim();
  if (!email || password.length < 10) {
    throw new Error('First boot requires BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 10 characters.');
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users(email,password_hash,display_name,role) VALUES(?,?,?,?)')
    .run(email, hash, name || 'Portal Administrator', 'admin');
  console.log(`Bootstrap admin created: ${email}`);
}
