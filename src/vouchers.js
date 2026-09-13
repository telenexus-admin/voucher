import crypto from 'node:crypto';

export function parseVoucherCodes(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const values = raw.split(/[\r\n,;\t]+/g).map(v => v.trim()).filter(Boolean);
  const headers = new Set(['voucher','vouchers','code','voucher code','voucher_code']);
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (headers.has(value.toLowerCase())) continue;
    if (value.length > 160) continue;
    if (!seen.has(value)) { seen.add(value); unique.push(value); }
  }
  return unique;
}

export function importVouchers(db, campaignId, codes, { label = '', sourceName = '' } = {}) {
  const batchId = crypto.randomUUID();
  const insertBatch = db.prepare(`INSERT INTO voucher_batches(id,campaign_id,label,source_name,imported_count,duplicate_count)
                                  VALUES(?,?,?,?,0,0)`);
  const insertVoucher = db.prepare(`INSERT OR IGNORE INTO vouchers(campaign_id,batch_id,code,status) VALUES(?,?,?,'unused')`);
  const updateBatch = db.prepare('UPDATE voucher_batches SET imported_count=?, duplicate_count=? WHERE id=?');
  const touch = db.prepare('UPDATE campaigns SET updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const tx = db.transaction(() => {
    insertBatch.run(batchId, campaignId, label || null, sourceName || null);
    let imported = 0;
    for (const code of codes) imported += insertVoucher.run(campaignId, batchId, code).changes;
    const duplicates = codes.length - imported;
    updateBatch.run(imported, duplicates, batchId);
    touch.run(campaignId);
    return { batchId, imported, duplicates };
  });
  return tx();
}

export function claimVoucher(db, publicToken, deviceKey, meta = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const campaign = db.prepare(`SELECT id,name,status FROM campaigns WHERE public_token=?`).get(publicToken);
    if (!campaign) throw Object.assign(new Error('QR campaign not found.'), { statusCode: 404 });
    if (campaign.status !== 'active') throw Object.assign(new Error('This QR campaign is paused.'), { statusCode: 409 });

    const existing = db.prepare(`SELECT c.id AS claim_id,c.status AS claim_status,v.code,v.status AS voucher_status
      FROM claims c JOIN vouchers v ON v.id=c.voucher_id
      WHERE c.campaign_id=? AND c.device_key=?`).get(campaign.id, deviceKey);
    if (existing) {
      db.exec('COMMIT');
      return { campaign, claimId: existing.claim_id, code: existing.code, status: existing.voucher_status, reused: true };
    }

    const voucher = db.prepare(`SELECT id,code FROM vouchers WHERE campaign_id=? AND status='unused' ORDER BY id LIMIT 1`).get(campaign.id);
    if (!voucher) throw Object.assign(new Error('No vouchers are currently available.'), { statusCode: 409, code: 'POOL_EMPTY' });

    const claimId = crypto.randomUUID();
    db.prepare(`UPDATE vouchers SET status='assigned',assigned_device=?,assigned_at=CURRENT_TIMESTAMP WHERE id=? AND status='unused'`)
      .run(deviceKey, voucher.id);
    db.prepare(`INSERT INTO claims(id,campaign_id,voucher_id,device_key,client_ip,user_agent,status)
                VALUES(?,?,?,?,?,?,'assigned')`)
      .run(claimId, campaign.id, voucher.id, deviceKey, meta.clientIp || null, meta.userAgent || null);
    db.exec('COMMIT');
    return { campaign, claimId, code: voucher.code, status: 'assigned', reused: false };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function confirmClaim(db, publicToken, claimId, deviceKey) {
  const row = db.prepare(`SELECT c.id,c.voucher_id,c.device_key,c.campaign_id
    FROM claims c JOIN campaigns p ON p.id=c.campaign_id
    WHERE p.public_token=? AND c.id=?`).get(publicToken, claimId);
  if (!row || row.device_key !== deviceKey) return false;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE claims SET status='used',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(claimId);
    db.prepare(`UPDATE vouchers SET status='used',used_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.voucher_id);
  });
  tx();
  return true;
}
