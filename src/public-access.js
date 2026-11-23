import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const staffLifetime = 12 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');

export function readToken(req, name) {
  const value = (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : '';
}

export function createStaffSessions({ secure = true, name = 'staff' } = {}) {
  const cookie = `${secure ? '__Host-' : ''}checkin-${name}`;
  const options = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  const sessions = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  }, 60_000).unref();

  return {
    session(req) {
      const entry = sessions.get(readToken(req, cookie));
      return entry?.expiresAt > Date.now() ? entry : null;
    },
    startSession(res, role) {
      const id = token();
      sessions.set(id, { id, role, expiresAt: Date.now() + staffLifetime });
      res.cookie(cookie, id, { ...options, maxAge: staffLifetime });
    },
    endSession(req, res) {
      const id = readToken(req, cookie);
      sessions.delete(id);
      res?.clearCookie(cookie, options);
      return id;
    },
    endRoleSessions(role) {
      for (const [id, session] of sessions) {
        if (session.role === role) sessions.delete(id);
      }
    }
  };
}

function clientIp(req) {
  const address = req.ip || req.socket.remoteAddress || '';
  if (isIP(address)) return address;
  // ARR can include the source port in the forwarded address.
  const host = address.match(/^\[([^\]]+)\]:\d+$/)?.[1] || address.replace(/:\d+$/, '');
  return isIP(host) ? host : req.socket.remoteAddress;
}

export function createPublicAccess(env, settingsAccess) {
  if (env.PUBLIC_DEPLOYMENT !== '1') return null;

  let url;
  try { url = new URL(env.PUBLIC_URL); } catch { /* Checked below. */ }
  if (url?.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PUBLIC_DEPLOYMENT=1 requires PUBLIC_URL to be an HTTPS origin.');
  }
  const passwords = { admin: env.ADMIN_PASSWORD, screen: env.SCREEN_PASSWORD };
  if (Object.values(passwords).some((value) => !value || value.length < 12 || value.length > 80 || value.trim() !== value)
      || passwords.admin === passwords.screen) {
    throw new Error('Set distinct ADMIN_PASSWORD and SCREEN_PASSWORD values of 12-80 characters.');
  }
  if (env.SETTINGS_PASSWORD) {
    const password = env.SETTINGS_PASSWORD;
    if (password.length < 12 || password.length > 80 || password.trim() !== password || Object.values(passwords).includes(password)) {
      throw new Error('Set a distinct SETTINGS_PASSWORD value of 12-80 characters.');
    }
    passwords.settings = password;
  }
  const passwordHashes = Object.fromEntries(Object.entries(passwords).map(([role, password]) => [role, hash(password)]));
  const staff = createStaffSessions();
  const attempts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, attempt] of attempts) if (attempt.expiresAt <= now) attempts.delete(key);
  }, 60_000).unref();

  function allowAttempt(res, key, limit, windowMs) {
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (!entry && attempts.size >= 10_000) {
        res.status(429).json({ message: '请求过于频繁，请稍后再试' });
        return false;
      }
      entry = { count: 0, expiresAt: now + windowMs };
      attempts.set(key, entry);
    }
    if (entry.count >= limit) {
      res.set('Retry-After', String(Math.ceil((entry.expiresAt - now) / 1000)));
      res.status(429).json({ message: '请求过于频繁，请稍后再试' });
      return false;
    }
    entry.count += 1;
    return true;
  }

  function guardApi(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const route = `${method} ${req.path}`;
    if (method !== 'GET' && req.headers.origin !== url.origin) {
      res.status(403).json({ message: '请从活动页面发起请求' });
      return;
    }
    const role = staff.session(req)?.role;
    if (route === 'GET /state' || route === 'GET /qrcode.svg') return next();
    if (req.path.toLowerCase().replace(/\/+$/, '') === '/checkin/avatar') {
      res.status(404).json({ message: '公网签到使用微信头像' });
      return;
    }
    if (route === 'POST /login') {
      if (allowAttempt(res, `login:${clientIp(req)}`, 20, 15 * 60_000)) next();
      return;
    }
    if (route === 'POST /checkin') {
      if (allowAttempt(res, `checkin:${clientIp(req)}`, 600, 60_000)) next();
      return;
    }
    if (settingsAccess?.session(req)) {
      if (['PUT /config', 'POST /upload/logo', 'POST /upload/music', 'POST /logout'].includes(route)) return next();
      if (!role) return res.status(403).json({ message: '设置账号无权执行此操作' });
    }
    if (role === 'admin') return next();
    if (role === 'screen' && ['POST /draw', 'POST /logout', 'PUT /screen/qr-layout'].includes(route)) return next();
    res.status(role ? 403 : 401).json({ message: role ? '当前角色无权执行此操作' : '请先登录' });
  }

  return {
    origin: url.origin,
    guardApi,
    settingsReady: Boolean(passwordHashes.settings),
    ...staff,
    allowWechatStart: (req, res) => allowAttempt(res, `wechat:${clientIp(req)}`, 600, 60_000),
    matchesPassword: (role, value) => Boolean(passwordHashes[role]) && typeof value === 'string' && value.length <= 80
      && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(passwordHashes[role], 'hex'))
  };
}
