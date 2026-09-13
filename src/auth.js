import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const COOKIE = 'voucher_session';

export function createAuth(db) {
  const secret = String(process.env.SESSION_SECRET || '');
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');

  function setSession(res, user) {
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.display_name,
      csrf: crypto.randomBytes(24).toString('base64url')
    };
    const token = jwt.sign(payload, secret, { expiresIn: '12h', issuer: 'voucher-portal' });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/'
    });
  }

  function clearSession(res) { res.clearCookie(COOKIE, { path: '/' }); }

  function readUser(req) {
    const raw = req.cookies?.[COOKIE];
    if (!raw) return null;
    try {
      const session = jwt.verify(raw, secret, { issuer: 'voucher-portal' });
      const user = db.prepare('SELECT id,email,display_name,role FROM users WHERE id=?').get(session.id);
      return user ? { ...user, csrf: session.csrf } : null;
    } catch { return null; }
  }

  function attach(req, res, next) {
    req.user = readUser(req);
    res.locals.currentUser = req.user;
    res.locals.csrf = req.user?.csrf || '';
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.redirect('/login');
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'admin') return res.status(403).send('Forbidden');
    next();
  }

  function verifyCsrf(req, res, next) {
    if (!req.user || !req.body || req.body._csrf !== req.user.csrf) return res.status(403).send('Invalid request token.');
    next();
  }

  return { setSession, clearSession, attach, requireUser, requireAdmin, verifyCsrf };
}
