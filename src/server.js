import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import writeExcelFile from 'write-excel-file/node';
import { createPublicAccess, createStaffSessions, readToken } from './public-access.js';
import { createWechatCheckin } from './wechat-checkin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const EXAMPLE_DATA_FILE = path.join(DATA_DIR, 'store.example.json');
const UPLOAD_DIR = path.join(ROOT_DIR, 'assets', 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const avatarFilePattern = /^avatar-(?:public-[a-f0-9]{64}-)?[a-f0-9-]+\.(jpg|png|webp|gif)$/;
const visitorCookie = 'checkin-visitor';

loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 3000);
const settingsAccess = createStaffSessions({ secure: process.env.PUBLIC_DEPLOYMENT === '1', name: 'settings' });
const publicAccess = createPublicAccess(process.env, settingsAccess);
const staffAccess = publicAccess || createStaffSessions({ secure: false });
const lanSettingsPassword = process.env.SETTINGS_PASSWORD || 'settings123';
let wechatOrigin = publicAccess?.origin;
if (!wechatOrigin && process.env.PUBLIC_URL) {
  try {
    const url = new URL(process.env.PUBLIC_URL);
    if (url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) {
      wechatOrigin = url.origin;
    }
  } catch { /* The check-in page reports missing HTTPS configuration. */ }
}
const wechatCheckin = wechatOrigin && createWechatCheckin({ origin: wechatOrigin, env: process.env, fetchJson: fetchWechatJson });
const HOST = publicAccess ? '127.0.0.1' : '0.0.0.0';
const qrOptions = { type: 'svg', width: 420, margin: 1, errorCorrectionLevel: 'M' };
const publicCheckinQr = publicAccess ? await QRCode.toString(`${publicAccess.origin}/checkin`, qrOptions) : null;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  allowRequest(req, callback) {
    const origin = req.headers.origin;
    callback(null, Boolean(staffAccess.session(req) && (!publicAccess || !origin || origin === publicAccess.origin)));
  }
});

if (publicAccess) {
  app.disable('x-powered-by');
  // Public mode only listens on loopback, behind a single local reverse proxy.
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY'
    });
    next();
  });
  app.use('/api', publicAccess.guardApi);
  app.use('/uploads', (req, res, next) => {
    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    const settingsAsset = /^\/(?:logo|music)-\d+-[a-f0-9]{8}\.[a-z0-9_-]+$/i.test(req.path) && settingsAccess.session(req);
    if (!publicAccess.session(req) && !settingsAsset) {
      res.sendStatus(404);
      return;
    }
    next();
  });
}

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('/screen/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.redirect('/admin?tab=settings');
});
app.get('/vendor/lucide.js', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'));
});
app.use('/vendor/three', express.static(path.join(ROOT_DIR, 'node_modules', 'three', 'build')));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, callback) => {
      const kind = cleanText(req.params.kind || 'file') || 'file';
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      callback(null, `${kind}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 }
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 2 }
});

function avatarExtension(buffer) {
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return '.gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || key in process.env) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadStore() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(EXAMPLE_DATA_FILE, DATA_FILE);
  }
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return normalizeStore(parsed);
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, 'utf8');
}

function normalizeStore(store) {
  const defaults = JSON.parse(fs.readFileSync(EXAMPLE_DATA_FILE, 'utf8'));
  const attendees = Array.isArray(store.attendees) ? store.attendees : [];
  const attendeeIds = new Set(attendees.map((attendee) => attendee.id));
  const prizes = Array.isArray(store.prizes) ? store.prizes : defaults.prizes;
  return {
    config: { ...defaults.config, ...(store.config || {}), companies: normalizeCompanies(store.config?.companies ?? defaults.config.companies) },
    attendees,
    prizes: prizes.map((prize) => ({
      ...prize,
      fixedWinnerIds: Array.isArray(prize.fixedWinnerIds)
        ? [...new Set(prize.fixedWinnerIds.filter((id) => attendeeIds.has(id)))] : []
    })),
    winners: Array.isArray(store.winners) ? store.winners : []
  };
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeCompanies(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 80)
    : [];
}

function cleanPhone(value) {
  const phone = typeof value === 'string' && value.length <= 32 ? value.trim().replace(/[\s-]+/g, '') : '';
  if (/^1[3-9]\d{9}$/.test(phone)) return phone;
  if (phone.startsWith('+86')) return /^\+861[3-9]\d{9}$/.test(phone) ? phone.slice(3) : '';
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : '';
}

function safePosition(value, fallback) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return {
    x: Number.isFinite(x) ? Math.max(0, Math.min(3000, Math.round(x))) : fallback.x,
    y: Number.isFinite(y) ? Math.max(0, Math.min(2000, Math.round(y))) : fallback.y
  };
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function publicConfig(config) {
  const { adminPassword, screenPassword, ...rest } = config;
  return rest;
}

function publicState(req, store = loadStore(), includeSelf = true) {
  const role = staffAccess.session(req)?.role;
  const checkinMode = publicAccess ? 'wechat' : store.config.checkinMode;
  const config = { ...publicConfig(store.config), checkinMode };
  const profile = includeSelf && checkinMode === 'wechat' ? wechatCheckin?.profile(req) : null;
  const visitor = includeSelf && checkinMode !== 'wechat' ? readToken(req, visitorCookie) : '';
  const self = findCheckinAttendee(store, profile, visitor);
  return {
    ...(publicAccess ? { deployment: 'public' } : { loginDefaults: {
      admin: store.config.adminPassword === 'admin123',
      screen: store.config.screenPassword === 'screen123'
    } }),
    accessRole: role || null,
    config: role || settingsAccess.session(req) ? config : { eventTitle: config.eventTitle, subtitle: config.subtitle, checkinMode, checkinEnabled: config.checkinEnabled, companies: config.companies },
    attendees: role === 'admin' ? store.attendees : role === 'screen' ? store.attendees.map(screenAttendee) : [],
    prizes: role === 'admin' ? store.prizes : role === 'screen' ? store.prizes.map(screenPrize) : [],
    winners: role === 'admin' ? store.winners : role === 'screen' ? store.winners.map(screenWinner) : [],
    selfAttendee: self ? ownAttendee(self) : null,
    wechat: {
      ready: Boolean(wechatCheckin?.ready),
      profile: profile ? { nickname: profile.nickname, avatar: profile.avatar } : null
    },
    checkinUrl: `${baseUrl(req)}/checkin`
  };
}

function findCheckinAttendee(store, profile, visitor) {
  const openid = profile?.id || (visitor && localVisitorId(visitor));
  if (!openid) return null;
  return store.attendees.find((item) => item.openid === openid)
    || (profile && store.attendees.find((item) => item.openid === profile.openid && item.source === 'wechat-oauth'));
}

function localVisitorId(visitor) {
  return `local-${crypto.createHash('sha256').update(visitor).digest('hex')}`;
}

function ownAttendee(attendee) {
  return { ...screenAttendee(attendee), phone: cleanPhone(attendee.phone) };
}

function screenAttendee({ id, name, nickname, company, avatar, checkedInAt }) {
  return { id, name, nickname, company, avatar, checkedInAt };
}

function screenPrize({ fixedWinnerIds, ...prize }) {
  return prize;
}

function screenWinner({ phone, fixed, ...winner }) {
  return winner;
}

function baseUrl(req) {
  if (publicAccess) return publicAccess.origin;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers.host;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '')) {
    const [firstLanUrl] = lanUrls(PORT);
    if (firstLanUrl) return firstLanUrl;
  }
  return `${req.protocol || 'http'}://${host}`;
}

function emitState(eventName, payload) {
  const store = loadStore();
  for (const socket of io.sockets.sockets.values()) {
    const role = staffAccess.session(socket.request)?.role;
    if (!role) {
      socket.disconnect(true);
      continue;
    }
    socket.emit('state', publicState(socket.request, store, false));
    if (eventName === 'checkin:new') socket.emit(eventName, screenAttendee(payload));
    else if (!publicAccess && role === 'admin' && eventName) socket.emit(eventName, payload);
  }
}

function isAlreadyWinner(store, attendeeId) {
  return store.winners.some((winner) => winner.attendeeId === attendeeId);
}

function remainingPrizeCount(store, prize) {
  const used = store.winners.filter((winner) => winner.prizeId === prize.id).length;
  return Math.max(0, Number(prize.quantity || 0) - used);
}

function pickRandom(items, count) {
  const pool = [...items];
  const picked = [];
  while (pool.length && picked.length < count) {
    const index = crypto.randomInt(pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  })[char]);
}

function avatarDataUri(name, color) {
  const label = escapeXml((name || '嘉宾').slice(-2));
  if (!color) {
    const colors = ['#b91c1c', '#0f766e', '#1d4ed8', '#a16207', '#be185d', '#6d28d9'];
    let hash = 0;
    const text = String(name || '嘉宾').trim().slice(-2);
    for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    color = colors[Math.abs(hash) % colors.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="80" fill="${color}"/><circle cx="118" cy="30" r="46" fill="#f4c762" opacity=".65"/><text x="80" y="96" text-anchor="middle" font-size="48" fill="#fff" font-family="Arial, sans-serif" font-weight="700">${label}</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#f8d56b"/></linearGradient></defs><rect width="160" height="160" rx="80" fill="url(#g)"/><text x="80" y="94" text-anchor="middle" font-size="48" fill="#fff" font-family="Arial, sans-serif" font-weight="700">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function isWechatBrowser(req) {
  return /MicroMessenger/i.test(req.get('user-agent') || '');
}

async function fetchWechatJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  const data = await response.json();
  if (!response.ok || data.errcode) {
    throw new Error(data.errmsg || `微信接口请求失败：${response.status}`);
  }
  return data;
}

function demoAttendees() {
  const names = ['王一鸣', '李思雨', '张嘉宁', '赵明轩', '陈若琳', '刘宇航', '周可欣', '吴昊然', '孙雅琪', '郑子墨', '许清扬', '何沐辰', '郭诗涵', '林俊熙', '马依诺', '高梓睿', '黄语桐', '唐景行'];
  const companies = ['总部', '市场部', '销售部', '技术部', '合作伙伴'];
  const colors = ['#c91f37', '#0f766e', '#7c3aed', '#d97706', '#2563eb', '#db2777'];
  return names.map((name, index) => ({
    id: crypto.randomUUID(),
    openid: `demo-openid-${index + 1}`,
    nickname: name.slice(0, 1) + '同学',
    avatar: avatarDataUri(name, colors[index % colors.length]),
    name,
    company: companies[index % companies.length],
    phone: `1380000${String(index + 1).padStart(4, '0')}`,
    source: 'demo',
    checkedInAt: new Date(Date.now() - (names.length - index) * 45000).toISOString()
  }));
}

function excelHeader(value) {
  return {
    value,
    fontWeight: 'bold',
    backgroundColor: '#8b1e1e',
    color: '#ffffff',
    align: 'center'
  };
}

async function sendWorkbook(res, filename, rows, columns) {
  const buffer = await writeExcelFile(rows, {
    columns,
    fontFamily: 'Arial',
    fontSize: 11
  }).toBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
}

app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ...publicState(req),
    accessRole: staffAccess.session(req)?.role || null,
    hasSettingsAccess: Boolean(settingsAccess.session(req))
  });
});

app.post('/api/login', (req, res) => {
  const { role: requestedRole, password } = req.body || {};
  if (requestedRole === 'settings') {
    if (!publicAccess && !allowLanOrigin(req, res)) return;
    const config = publicAccess ? null : loadStore().config;
    const ready = publicAccess ? publicAccess.settingsReady
      : ![config.adminPassword, config.screenPassword].includes(lanSettingsPassword);
    if (!ready) return res.status(503).json({ message: '请在服务端配置独立的设置密码' });
    const valid = publicAccess ? publicAccess.matchesPassword('settings', password) : password === lanSettingsPassword;
    if (!valid) return res.status(401).json({ message: '设置密码不正确' });
    settingsAccess.endSession(req);
    settingsAccess.startSession(res, 'settings');
    return res.json({ ok: true, role: 'settings', path: '/admin?tab=settings' });
  }
  const role = requestedRole === 'screen' ? 'screen' : 'admin';
  const valid = publicAccess ? publicAccess.matchesPassword(role, password)
    : cleanText(password, 80) === loadStore().config[role === 'admin' ? 'adminPassword' : 'screenPassword'];
  if (!valid) {
    res.status(401).json({ message: '密码不正确' });
    return;
  }
  const previousSession = staffAccess.endSession(req);
  if (previousSession) io.in(previousSession).disconnectSockets(true);
  staffAccess.startSession(res, role);
  res.json({ ok: true, role, path: role === 'admin' ? '/admin' : '/screen/checkin' });
});

app.post('/api/logout', (req, res) => {
  if (req.body?.role === 'settings') {
    if (!publicAccess && !allowLanOrigin(req, res)) return;
    settingsAccess.endSession(req, res);
    return res.json({ ok: true });
  }
  const id = staffAccess.endSession(req, res);
  if (id) io.in(id).disconnectSockets(true);
  res.json({ ok: true });
});

app.get('/api/qrcode.svg', async (req, res, next) => {
  try {
    const svg = publicCheckinQr ?? await QRCode.toString(cleanText(req.query.target, 500) || `${baseUrl(req)}/checkin`, qrOptions);
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    next(error);
  }
});

function startVisitor(res) {
  const id = crypto.randomBytes(32).toString('hex');
  res.cookie(visitorCookie, id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
  return id;
}

app.get('/wechat/oauth/start', (req, res) => {
  if (loadStore().config.checkinEnabled === false) return res.redirect('/checkin');
  if (!wechatCheckin?.ready || (!publicAccess && loadStore().config.checkinMode !== 'wechat')) {
    return res.redirect('/checkin?wechat=not-ready');
  }
  if (!isWechatBrowser(req)) return res.redirect('/checkin?wechat=outside');
  if (publicAccess && !publicAccess.allowWechatStart(req, res)) return;
  return wechatCheckin.start(req, res);
});

app.get('/wechat/oauth/callback', (req, res) => {
  if (!wechatCheckin || (!publicAccess && loadStore().config.checkinMode !== 'wechat')) {
    return res.redirect('/checkin?wechat=failed');
  }
  return wechatCheckin.callback(req, res);
});

app.get('/checkin', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET') return next();
  if (publicAccess || loadStore().config.checkinMode === 'wechat') {
    if (loadStore().config.checkinEnabled !== false && wechatCheckin?.ready && !req.query.wechat && isWechatBrowser(req) && !wechatCheckin.profile(req)) {
      return res.redirect('/wechat/oauth/start');
    }
  } else if (!readToken(req, visitorCookie)) {
    startVisitor(res);
  }
  next();
});

function allowLanOrigin(req, res, allowedOrigin) {
  const origin = req.get('origin');
  if (!publicAccess && origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== allowedOrigin) {
    res.status(403).json({ message: '请从活动页面发起请求' });
    return false;
  }
  return true;
}

function requireAdminSession(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const role = staffAccess.session(req)?.role;
  if (role !== 'admin') return res.status(role ? 403 : 401).json({ message: '请使用后台密码登录' });
  if (allowLanOrigin(req, res)) next();
}

function requireSettingsSession(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!settingsAccess.session(req)) {
    return res.status(staffAccess.session(req) ? 403 : 401).json({ message: '请使用大屏设置密码登录' });
  }
  if (allowLanOrigin(req, res)) next();
}

app.put('/api/checkin/status', requireAdminSession, (req, res) => {
  if (typeof req.body?.checkinEnabled !== 'boolean') return res.status(400).json({ message: '请选择签到状态' });
  const store = loadStore();
  store.config.checkinEnabled = req.body.checkinEnabled;
  saveStore(store);
  emitState('config:update', publicConfig(store.config));
  res.json({ checkinEnabled: store.config.checkinEnabled });
});

app.put('/api/screen/qr-layout', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!staffAccess.session(req)) return res.status(401).json({ message: '请先登录大屏' });
  if (!allowLanOrigin(req, res)) return;
  const store = loadStore();
  if ('qrPosition' in (req.body || {})) store.config.qrPosition = safePosition(req.body.qrPosition, store.config.qrPosition);
  if ('qrSize' in (req.body || {})) store.config.qrSize = safeNumber(req.body.qrSize, store.config.qrSize, 88, 480);
  saveStore(store);
  emitState('config:update', publicConfig(store.config));
  res.json({ qrPosition: store.config.qrPosition, qrSize: store.config.qrSize });
});

app.put('/api/config', requireSettingsSession, (req, res) => {
  const store = loadStore();
  const body = req.body || {};
  const previous = store.config;
  const next = { ...previous };
  if ('eventTitle' in body) next.eventTitle = cleanText(body.eventTitle, 80) || next.eventTitle;
  if ('subtitle' in body) next.subtitle = cleanText(body.subtitle, 120);
  if ('logoUrl' in body) next.logoUrl = cleanText(body.logoUrl, 500);
  if ('musicUrl' in body) next.musicUrl = cleanText(body.musicUrl, 500);
  if ('theme' in body) next.theme = cleanText(body.theme, 40) || 'celebration';
  if (!publicAccess && ['local', 'wechat'].includes(body.checkinMode)) next.checkinMode = body.checkinMode;
  if ('wallMode' in body) next.wallMode = ['orbit', 'sphere', 'wall', 'text'].includes(body.wallMode) ? body.wallMode : next.wallMode;
  if ('wallText' in body) next.wallText = cleanText(body.wallText, 16) || 'LUCKY';
  if ('allowRepeatWinners' in body) next.allowRepeatWinners = Boolean(body.allowRepeatWinners);
  if ('companies' in body && Array.isArray(body.companies)) {
    next.companies = normalizeCompanies(body.companies);
  }
  if ('logoPosition' in body) next.logoPosition = safePosition(body.logoPosition, next.logoPosition);
  if ('qrPosition' in body) next.qrPosition = safePosition(body.qrPosition, next.qrPosition);
  if ('qrSize' in body) next.qrSize = safeNumber(body.qrSize, next.qrSize || 106, 88, 480);
  if (!publicAccess) {
    const adminPassword = cleanText(body.adminPassword, 80);
    const screenPassword = cleanText(body.screenPassword, 80);
    if ((adminPassword || screenPassword) && staffAccess.session(req)?.role !== 'admin') {
      return res.status(403).json({ message: '修改后台或大屏密码还需登录后台' });
    }
    if ([adminPassword, screenPassword].includes(lanSettingsPassword)) {
      return res.status(400).json({ message: '后台和大屏密码须与设置密码不同' });
    }
    if (adminPassword) next.adminPassword = adminPassword;
    if (screenPassword) next.screenPassword = screenPassword;
  }
  store.config = next;
  saveStore(store);
  if (!publicAccess) {
    if (next.screenPassword !== previous.screenPassword) staffAccess.endRoleSessions('screen');
    if (next.adminPassword !== previous.adminPassword) {
      staffAccess.endRoleSessions('admin');
      staffAccess.startSession(res, 'admin');
    }
  }
  emitState('config:update', publicConfig(next));
  res.json(publicState(req, store));
});

app.post('/api/upload/:kind', (req, res, next) => {
  if (!['logo', 'music', 'prize'].includes(req.params.kind)) {
    res.status(400).json({ message: '不支持的上传类型' });
    return;
  }
  if (req.params.kind !== 'prize') return requireSettingsSession(req, res, next);
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: '没有收到文件' });
    return;
  }
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size
  });
});

app.post('/api/checkin/avatar', (req, res, next) => {
  avatarUpload.single('file')(req, res, (error) => {
    if (error) {
      res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? '头像不能超过 2 MB' : '头像上传失败，请重新选择图片' });
      return;
    }
    const extension = req.file && avatarExtension(req.file.buffer);
    if (!extension) {
      res.status(400).json({ message: '请选择 JPG、PNG、WebP 或 GIF 图片' });
      return;
    }
    try {
      const filename = `avatar-${crypto.randomUUID()}${extension}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
      res.json({ url: `/uploads/${filename}` });
    } catch (writeError) {
      next(writeError);
    }
  });
});

app.post('/api/checkin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const store = loadStore();
  if (store.config.checkinEnabled === false) return res.status(403).json({ message: '签到已暂停，请等待主办方开始签到' });
  const wechatMode = publicAccess || store.config.checkinMode === 'wechat';
  if (!allowLanOrigin(req, res, wechatOrigin)) return;
  const profile = wechatMode ? wechatCheckin?.profile(req) : null;
  if (wechatMode && !profile) {
    res.status(401).json({ message: '请重新授权微信后签到' });
    return;
  }
  const now = new Date().toISOString();
  const body = req.body || {};
  const name = typeof body.name === 'string' ? cleanText(body.name, 40) : '';
  if (!name) {
    res.status(400).json({ message: '请填写姓名' });
    return;
  }
  if (typeof body.phone !== 'string' || !body.phone.trim()) return res.status(400).json({ message: '请填写手机号' });
  const phone = cleanPhone(body.phone);
  if (!phone) return res.status(400).json({ message: '请输入有效的手机号' });
  const visitor = profile ? '' : readToken(req, visitorCookie) || startVisitor(res);
  const openid = profile?.id || localVisitorId(visitor);
  const existing = findCheckinAttendee(store, profile, visitor);
  const company = body.company === undefined ? existing?.company || '' : typeof body.company === 'string' ? cleanText(body.company, 80) : null;
  if (company === null || (company && !store.config.companies.includes(company) && company !== existing?.company)) {
    return res.status(400).json({ code: 'COMPANY_OPTIONS_CHANGED', message: '单位列表已更新，请重新选择所属单位' });
  }
  const source = profile ? 'wechat-oauth' : 'local-form';
  let avatar = profile ? profile.avatar : cleanText(body.avatar, 5000);
  if (source === 'local-form' && avatar) {
    const filename = avatar.slice('/uploads/'.length);
    if (!avatar.startsWith('/uploads/') || !avatarFilePattern.test(filename) || !fs.existsSync(path.join(UPLOAD_DIR, filename))) {
      res.status(400).json({ message: '头像文件无效，请重新上传' });
      return;
    }
  }
  if (!avatar) avatar = avatarDataUri(name);
  const attendee = {
    id: crypto.randomUUID(),
    openid,
    nickname: (profile ? cleanText(profile.nickname, 60) : cleanText(body.nickname, 60)) || name,
    avatar,
    name,
    company,
    phone,
    source,
    checkedInAt: now
  };
  let saved;
  if (existing) {
    Object.assign(existing, attendee, { id: existing.id, checkedInAt: existing.checkedInAt, updatedAt: now });
    saved = existing;
  } else {
    store.attendees.push(attendee);
    saved = attendee;
  }
  saveStore(store);
  emitState(existing ? null : 'checkin:new', saved);
  res.json({ ok: true, attendee: ownAttendee(saved), existing: Boolean(existing) });
});

app.get('/api/attendees', requireAdminSession, (req, res) => {
  res.json(loadStore().attendees);
});

app.delete('/api/attendees/:id', (req, res) => {
  const store = loadStore();
  const before = store.attendees.length;
  store.attendees = store.attendees.filter((item) => item.id !== req.params.id);
  store.winners = store.winners.filter((item) => item.attendeeId !== req.params.id);
  saveStore(store);
  emitState('attendee:delete', { id: req.params.id });
  res.json({ ok: true, removed: before - store.attendees.length });
});

app.post('/api/demo/seed', requireAdminSession, (req, res) => {
  const store = loadStore();
  const existing = new Set(store.attendees.map((item) => item.openid));
  const demos = demoAttendees();
  const count = safeNumber(req.body?.count, demos.length, 1, demos.length);
  const additions = demos.slice(0, count).filter((item) => !existing.has(item.openid));
  store.attendees.push(...additions);
  saveStore(store);
  emitState('demo:seed', { count: additions.length });
  res.json({ ok: true, count: additions.length });
});

app.get('/api/prizes', (req, res) => {
  res.json(loadStore().prizes);
});

app.post('/api/prizes', (req, res) => {
  const store = loadStore();
  const prize = {
    id: crypto.randomUUID(),
    name: cleanText(req.body.name, 80) || '新奖项',
    quantity: Math.max(1, Number.parseInt(req.body.quantity, 10) || 1),
    drawCount: Math.max(1, Number.parseInt(req.body.drawCount, 10) || 1),
    imageUrl: cleanText(req.body.imageUrl, 500),
    animation: ['orbit', 'sphere', 'wall', 'text'].includes(req.body.animation) ? req.body.animation : 'sphere',
    fixedWinnerIds: []
  };
  store.prizes.push(prize);
  saveStore(store);
  emitState('prize:create', prize);
  res.json(prize);
});

app.put('/api/prizes/:id', (req, res) => {
  const store = loadStore();
  const prize = store.prizes.find((item) => item.id === req.params.id);
  if (!prize) {
    res.status(404).json({ message: '奖项不存在' });
    return;
  }
  if ('name' in req.body) prize.name = cleanText(req.body.name, 80) || prize.name;
  if ('quantity' in req.body) prize.quantity = Math.max(1, Number.parseInt(req.body.quantity, 10) || prize.quantity);
  if ('drawCount' in req.body) prize.drawCount = Math.max(1, Number.parseInt(req.body.drawCount, 10) || prize.drawCount);
  if ('imageUrl' in req.body) prize.imageUrl = cleanText(req.body.imageUrl, 500);
  if ('animation' in req.body) prize.animation = ['orbit', 'sphere', 'wall', 'text'].includes(req.body.animation) ? req.body.animation : prize.animation;
  saveStore(store);
  emitState('prize:update', prize);
  res.json(prize);
});

function updateFixedWinners(req, res, add) {
  const store = loadStore();
  const prize = store.prizes.find((item) => item.id === req.params.id);
  if (!prize) return res.status(404).json({ message: '奖项不存在' });
  const attendeeId = add ? req.body?.attendeeId : req.params.attendeeId;
  if (add) {
    if (!store.attendees.some((attendee) => attendee.id === attendeeId)) {
      return res.status(404).json({ message: '签到人员不存在' });
    }
    if (!prize.fixedWinnerIds.includes(attendeeId)) prize.fixedWinnerIds.push(attendeeId);
  } else {
    prize.fixedWinnerIds = prize.fixedWinnerIds.filter((id) => id !== attendeeId);
  }
  saveStore(store);
  emitState('prize:update', prize);
  res.json({ fixedWinnerIds: prize.fixedWinnerIds });
}

app.post('/api/prizes/:id/fixed-winners', requireAdminSession, (req, res) => updateFixedWinners(req, res, true));
app.delete('/api/prizes/:id/fixed-winners/:attendeeId', requireAdminSession, (req, res) => updateFixedWinners(req, res, false));

app.delete('/api/prizes/:id', (req, res) => {
  const store = loadStore();
  store.prizes = store.prizes.filter((item) => item.id !== req.params.id);
  store.winners = store.winners.filter((item) => item.prizeId !== req.params.id);
  saveStore(store);
  emitState('prize:delete', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/draw', (req, res) => {
  const role = staffAccess.session(req)?.role;
  if (!role) return res.status(401).json({ message: '请先登录大屏' });
  if (!allowLanOrigin(req, res, wechatOrigin)) return;
  const store = loadStore();
  const prize = store.prizes.find((item) => item.id === req.body.prizeId);
  if (!prize) {
    res.status(404).json({ message: '请选择有效奖项' });
    return;
  }
  const remaining = remainingPrizeCount(store, prize);
  if (remaining <= 0) {
    res.status(400).json({ message: '该奖项已全部发放' });
    return;
  }
  const requested = Math.max(1, Number.parseInt(req.body.count, 10) || Number(prize.drawCount) || 1);
  const targetCount = Math.min(requested, remaining);
  const attendees = store.attendees;
  const fixedIds = Array.isArray(prize.fixedWinnerIds) ? prize.fixedWinnerIds : [];
  const fixed = fixedIds
    .map((id) => attendees.find((item) => item.id === id))
    .filter(Boolean)
    .filter((item) => store.config.allowRepeatWinners || !isAlreadyWinner(store, item.id))
    .slice(0, targetCount);
  const fixedSet = new Set(fixed.map((item) => item.id));
  const pool = attendees.filter((item) => {
    if (fixedSet.has(item.id)) return false;
    if (!store.config.allowRepeatWinners && isAlreadyWinner(store, item.id)) return false;
    return true;
  });
  const picked = [...fixed, ...pickRandom(pool, targetCount - fixed.length)];
  if (!picked.length) {
    res.status(400).json({ message: '没有可抽取的签到人员' });
    return;
  }
  const now = new Date().toISOString();
  const winners = picked.map((attendee) => ({
    id: crypto.randomUUID(),
    prizeId: prize.id,
    prizeName: prize.name,
    attendeeId: attendee.id,
    name: attendee.name,
    nickname: attendee.nickname,
    company: attendee.company,
    phone: attendee.phone,
    avatar: attendee.avatar,
    fixed: fixedSet.has(attendee.id),
    drawnAt: now
  }));
  store.winners.push(...winners);
  saveStore(store);
  emitState('draw:complete', { prize, winners });
  const isScreen = role === 'screen';
  res.json({
    prize: isScreen ? screenPrize(prize) : prize,
    winners: isScreen ? winners.map(screenWinner) : winners,
    remaining: remainingPrizeCount(store, prize)
  });
});

app.get('/api/winners', requireAdminSession, (req, res) => {
  res.json(loadStore().winners);
});

app.delete('/api/winners/:id', (req, res) => {
  const store = loadStore();
  store.winners = store.winners.filter((winner) => winner.id !== req.params.id);
  saveStore(store);
  emitState('winner:delete', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/reset', requireAdminSession, (req, res) => {
  const scope = req.body.scope;
  if (scope === 'all' && (!settingsAccess.session(req) || staffAccess.session(req)?.role !== 'admin')) {
    return res.status(403).json({ message: '恢复全部设置需要同时登录后台和大屏设置' });
  }
  if (scope === 'all' && !allowLanOrigin(req, res)) return;
  const store = loadStore();
  if (scope === 'attendees') {
    store.attendees = [];
    store.winners = [];
  } else if (scope === 'winners') {
    store.winners = [];
  } else if (scope === 'all') {
    const fresh = normalizeStore({});
    store.config = { ...fresh.config, adminPassword: store.config.adminPassword, screenPassword: store.config.screenPassword };
    store.attendees = [];
    store.prizes = fresh.prizes;
    store.winners = [];
  } else {
    res.status(400).json({ message: '未知重置范围' });
    return;
  }
  saveStore(store);
  emitState('state:reset', { scope });
  res.json({ ok: true });
});

app.get('/api/export/checkins.xlsx', requireAdminSession, async (req, res, next) => {
  try {
    const rows = loadStore().attendees.map((item, index) => ({ index: index + 1, ...item }));
    await sendWorkbook(res, `签到数据-${dateStamp()}.xlsx`, rows, [
      { header: excelHeader('序号'), cell: (row) => ({ value: row.index, type: Number }), width: 8 },
      { header: excelHeader('姓名'), cell: (row) => ({ value: row.name }), width: 16 },
      { header: excelHeader('微信昵称'), cell: (row) => ({ value: row.nickname }), width: 18 },
      { header: excelHeader('所在单位'), cell: (row) => ({ value: row.company }), width: 24 },
      { header: excelHeader('手机号'), cell: (row) => ({ value: row.phone }), width: 18 },
      { header: excelHeader('签到时间'), cell: (row) => ({ value: formatDate(row.checkedInAt) }), width: 22 },
      { header: excelHeader('来源'), cell: (row) => ({ value: row.source }), width: 14 },
      { header: excelHeader('OpenID/访客ID'), cell: (row) => ({ value: row.openid }), width: 28 }
    ]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/winners.xlsx', requireAdminSession, async (req, res, next) => {
  try {
    const rows = loadStore().winners.map((item, index) => ({ index: index + 1, ...item }));
    await sendWorkbook(res, `中奖名单-${dateStamp()}.xlsx`, rows, [
      { header: excelHeader('序号'), cell: (row) => ({ value: row.index, type: Number }), width: 8 },
      { header: excelHeader('奖项'), cell: (row) => ({ value: row.prizeName }), width: 18 },
      { header: excelHeader('姓名'), cell: (row) => ({ value: row.name }), width: 16 },
      { header: excelHeader('微信昵称'), cell: (row) => ({ value: row.nickname }), width: 18 },
      { header: excelHeader('所在单位'), cell: (row) => ({ value: row.company }), width: 24 },
      { header: excelHeader('手机号'), cell: (row) => ({ value: row.phone }), width: 18 },
      { header: excelHeader('是否内定'), cell: (row) => ({ value: row.fixed ? '是' : '否' }), width: 12 },
      { header: excelHeader('中奖时间'), cell: (row) => ({ value: formatDate(row.drawnAt) }), width: 22 }
    ]);
  } catch (error) {
    next(error);
  }
});

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (item) => String(item).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

io.on('connection', (socket) => {
  const session = staffAccess.session(socket.request);
  if (!session) {
    socket.disconnect(true);
    return;
  }
  socket.join(session.id);
  const expiry = setTimeout(() => socket.disconnect(true), session.expiresAt - Date.now());
  socket.on('disconnect', () => clearTimeout(expiry));
  socket.emit('state', publicState(socket.request, loadStore(), false));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((error, req, res, next) => {
  if (publicAccess && (error.status === 400 || error.status === 413)) {
    res.status(error.status).json({ message: error.status === 413 ? '请求内容过大' : '请求格式有误' });
    return;
  }
  console.error(error);
  res.status(500).json({ message: publicAccess ? '服务异常' : error.message || '服务异常' });
});

server.listen(PORT, HOST, () => {
  console.log(`微信签到抽奖服务已启动：http://localhost:${PORT}`);
  if (publicAccess) console.log(`公网部署模式：${publicAccess.origin}（由本机 HTTPS 代理转发）`);
  for (const address of publicAccess ? [] : lanUrls(PORT)) {
    console.log(`局域网访问：${address}`);
  }
});

function lanUrls(port) {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === 'IPv4' && !item.internal) {
        urls.push(`http://${item.address}:${port}`);
      }
    }
  }
  return urls;
}
