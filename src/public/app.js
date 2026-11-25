const app = document.querySelector('#app');

let state = {
  accessRole: null,
  config: {},
  attendees: [],
  prizes: [],
  winners: [],
  loginDefaults: {},
  checkinUrl: ''
};
let socket;
let spatialRotationFrame = 0;
let activeAdminTab = 'checkins';
let selectedLoginRole = 'admin';
const pendingFixedPrizes = new Set();
let pendingCheckinStatus = false;
let qrInteraction = null;
let qrSaving = false;
const checkinUiState = {
  initialized: false,
  editing: false,
  name: '',
  phone: '',
  company: '',
  avatar: '',
  preview: '',
  file: null,
  preparing: false,
  submitting: false
};
let screenUiState = {
  selectedPrizeId: null
};
let drawState = {
  rolling: false,
  stopping: false,
  scene: null,
  runId: 0,
  prizeId: null,
  count: 1,
  timer: null,
  fxTimer: null,
  candidates: [],
  railTick: 0,
  activeAnimation: 'sphere'
};

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('popstate', render);
window.addEventListener('resize', () => {
  if (window.location.pathname === '/screen/checkin' && hasRole('screen') && !qrInteraction && !qrSaving) {
    renderCheckinScreen();
    return;
  }
  if (drawState.rolling && !drawState.stopping) refreshDrawGeometry(drawState.activeAnimation);
  else if (window.location.pathname === '/screen/checkin') paintAvatarStage();
});

async function boot() {
  if (new URLSearchParams(window.location.search).get('tab') === 'settings') activeAdminTab = 'settings';
  await refreshState();
  connectSocket();
  render();
}

async function refreshState() {
  const response = await fetch('/api/state');
  state = await response.json();
}

function connectSocket() {
  if (!state.accessRole || window.location.pathname === '/checkin') return;
  socket = io();
  socket.on('state', (nextState) => {
    const previous = state;
    state = { accessRole: previous.accessRole, hasSettingsAccess: previous.hasSettingsAccess, ...nextState };
    const path = window.location.pathname;
    if (path === '/screen/checkin' && (qrInteraction || qrSaving)) return;
    if (path === '/screen/checkin' && document.querySelector('.checkin-display-page')
        && previous.accessRole === state.accessRole && previous.checkinUrl === state.checkinUrl
        && JSON.stringify(previous.config) === JSON.stringify(state.config)
        && JSON.stringify(previous.attendees) === JSON.stringify(state.attendees)) return;
    if (path === '/admin' && activeAdminTab === 'prizes' && syncPrizeEditors(previous)) return;
    if (path === '/admin' && activeAdminTab === 'settings' && document.querySelector('#adminPanel')
        && previous.accessRole === state.accessRole && previous.hasSettingsAccess === state.hasSettingsAccess) {
      updateAdminStats();
      return;
    }
    const known = new Set(previous.attendees.map((attendee) => attendee.id));
    const arrivals = new Set(state.attendees.filter((attendee) => !known.has(attendee.id)).map((attendee) => attendee.id));
    if (!drawState.rolling) render({ arrivals });
  });
  socket.on('checkin:new', showFlyCard);
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') window.location.reload();
  });
}

function render({ arrivals = new Set() } = {}) {
  const path = window.location.pathname;
  if (path !== '/screen/checkin') {
    stopSpatialRotation();
    document.querySelectorAll('.fly-card').forEach((card) => card.remove());
  }
  if (path === '/checkin') {
    renderCheckin();
    return;
  }
  if (['/screen', '/screen/checkin', '/screen/lottery'].includes(path)) {
    if (!hasRole('screen')) {
      stopSpatialRotation();
      renderLogin('screen');
      return;
    }
    if (path === '/screen/checkin') renderCheckinScreen(arrivals);
    else renderScreen();
    return;
  }
  if (path === '/admin') {
    if (!hasRole('admin')) {
      renderLogin('admin');
      return;
    }
    renderAdmin(arrivals);
    return;
  }
  renderLogin('admin');
}

function hasRole(role) {
  const current = state.accessRole;
  if (role === 'screen') return current === 'screen' || current === 'admin';
  return current === 'admin';
}

function navigate(path) {
  window.history.pushState({}, '', path);
  render();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === 'object' ? payload.message : payload;
    const error = new Error(message || '请求失败');
    error.status = response.status;
    error.code = payload && typeof payload === 'object' ? payload.code : undefined;
    throw error;
  }
  return payload;
}

async function uploadFile(file, kind) {
  const data = new FormData();
  data.append('file', file);
  return api(`/api/upload/${kind}`, { method: 'POST', body: data });
}

function bindLogout(role) {
  document.querySelector('#logoutButton')?.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST', body: role ? { role } : undefined });
      window.location.reload();
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderLogin(forceRole = selectedLoginRole) {
  selectedLoginRole = forceRole;
  const defaultPassword = selectedLoginRole === 'admin' ? 'admin123' : 'screen123';
  const passwordValue = state.loginDefaults?.[selectedLoginRole] ? defaultPassword : '';
  app.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <div class="brand-panel">
          <div>
            <div class="brand-mark">签</div>
            <h1>${escapeHtml(state.config.eventTitle || '微信签到抽奖')}</h1>
            <p>${escapeHtml(state.config.subtitle || '扫码签到 · 头像滚动 · 幸运抽奖')}</p>
          </div>
          ${state.deployment === 'public' ? '' : '<p>内网运行 / 大屏互动 / 后台导出</p>'}
        </div>
        <form class="login-form" id="loginForm">
          <div class="role-switch">
            <button type="button" data-role="admin" class="${selectedLoginRole === 'admin' ? 'active' : ''}">后台</button>
            <button type="button" data-role="screen" class="${selectedLoginRole === 'screen' ? 'active' : ''}">大屏</button>
          </div>
          <label>
            访问密码
            <input id="loginPassword" type="password" autocomplete="current-password" value="${passwordValue}" placeholder="请输入访问密码" />
          </label>
          <button type="submit">进入${selectedLoginRole === 'admin' ? '后台' : '大屏'}</button>
          <div class="error-text" id="loginError"></div>
        </form>
      </section>
    </main>
  `;
  document.querySelectorAll('[data-role]').forEach((button) => {
    button.addEventListener('click', () => renderLogin(button.dataset.role));
  });
  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.querySelector('#loginError');
    error.textContent = '';
    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: { role: selectedLoginRole, password: document.querySelector('#loginPassword').value }
      });
      const screenPath = ['/screen', '/screen/checkin', '/screen/lottery'].includes(location.pathname)
        ? location.pathname : '/screen/checkin';
      const path = result.role === 'screen' ? screenPath : activeAdminTab === 'settings' ? '/admin?tab=settings' : result.path;
      window.location.assign(path);
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function isWechatCheckin() {
  return state.deployment === 'public' || state.config.checkinMode === 'wechat';
}

function renderCheckin() {
  if (state.config.checkinEnabled === false) {
    app.innerHTML = `<main class="checkin-page local-checkin-page">
      <section class="checkin-card local-checkin-card success-state">
        <div class="brand-mark">签</div>
        <h1 class="mobile-title">签到已暂停</h1>
        <button type="button" id="refreshCheckinButton">刷新签到状态</button>
      </section>
    </main>`;
    document.querySelector('#refreshCheckinButton')?.addEventListener('click', () => window.location.reload());
    return;
  }
  if (isWechatCheckin()) renderWechatCheckin();
  else renderLocalCheckin();
}

function renderWechatCheckin() {
  const { ready, profile } = state.wechat || {};
  if (profile) {
    renderCheckinForm(state.selfAttendee, profile);
    return;
  }
  const insideWechat = /MicroMessenger/i.test(navigator.userAgent);
  const outcome = new URLSearchParams(window.location.search).get('wechat');
  const title = !ready ? '微信签到暂不可用'
    : !insideWechat ? '请用微信扫码签到'
      : outcome === 'denied' ? '未同意微信授权'
        : outcome ? '微信授权未完成' : '微信授权签到';
  app.innerHTML = `
    <main class="checkin-page local-checkin-page">
      <section class="checkin-card local-checkin-card success-state">
        <div class="brand-mark">微</div>
        <h1 class="mobile-title">${title}</h1>
        ${ready && insideWechat ? '<a class="button-link" href="/wechat/oauth/start">授权微信签到</a>' : ''}
      </section>
    </main>`;
}

function renderLocalCheckin() {
  renderCheckinForm(state.selfAttendee);
}

function renderCheckinForm(attendee, wechatProfile) {
  if (attendee?.phone && !checkinUiState.editing) {
    renderCheckinSuccess(attendee, true);
    return;
  }
  if (!checkinUiState.initialized) {
    checkinUiState.name = attendee?.name || '';
    checkinUiState.phone = attendee?.phone || '';
    checkinUiState.company = attendee?.company || '';
    checkinUiState.avatar = wechatProfile ? wechatProfile.avatar : attendee?.avatar?.startsWith('/uploads/') ? attendee.avatar : '';
    checkinUiState.initialized = true;
  }
  const preview = checkinUiState.preview || checkinUiState.avatar || makeAvatarDataUrl(checkinUiState.name);
  const companies = Array.isArray(state.config.companies) ? state.config.companies : [];
  const previousCompany = attendee?.company && !companies.includes(attendee.company) ? attendee.company : '';
  app.innerHTML = `
    <main class="checkin-page local-checkin-page">
      <section class="checkin-card local-checkin-card">
        <header class="local-checkin-heading">
          <span>来宾签到</span>
          <h1>${escapeHtml(state.config.eventTitle || '欢迎来到活动现场')}</h1>
        </header>
        <form id="localCheckinForm" class="checkin-form">
          <div class="checkin-avatar-field${wechatProfile ? ' is-wechat' : ''}">
            <div class="checkin-avatar-preview">
              <img id="checkinAvatarPreview" src="${escapeHtml(preview)}" alt="签到头像预览" />
              ${wechatProfile ? '' : `<button id="chooseCheckinAvatar" type="button" aria-label="选择头像" title="选择头像">${screenIcon('camera')}</button>`}
            </div>
            ${wechatProfile ? `<span class="checkin-avatar-label">${wechatProfile.avatar ? '微信头像' : '姓名头像'}</span>` : `
              <input id="checkinAvatarFile" class="checkin-file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="上传头像" tabindex="-1" />
              <span class="checkin-avatar-label">头像（选填）</span>
              <button id="useNameAvatar" class="checkin-text-button" type="button" ${checkinUiState.preview || checkinUiState.avatar ? '' : 'hidden'}>使用姓名头像</button>`}
          </div>
          <label for="checkinName">姓名
            <input id="checkinName" name="name" autocomplete="name" maxlength="40" required value="${escapeHtml(checkinUiState.name)}" placeholder="请输入姓名" />
          </label>
          <label for="checkinPhone">手机号
            <input id="checkinPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" required value="${escapeHtml(checkinUiState.phone)}" placeholder="请输入手机号" />
          </label>
          ${companies.length ? `<label for="checkinCompany">所属单位
            <select id="checkinCompany" name="company" autocomplete="organization">
              <option value="" ${checkinUiState.company ? '' : 'selected'}>请选择所属单位</option>
              ${[...companies, ...(previousCompany ? [previousCompany] : [])].map((company) => `<option value="${escapeHtml(company)}" ${company === checkinUiState.company ? 'selected' : ''}>${escapeHtml(company)}</option>`).join('')}
            </select>
          </label>` : ''}
          <div id="checkinError" class="error-text" role="alert" aria-live="polite"></div>
          ${wechatProfile ? '<a id="retryWechatCheckin" class="checkin-text-button" href="/wechat/oauth/start" hidden>重新授权</a>' : ''}
          <button id="submitCheckin" type="submit">${screenIcon('check')}<span>${attendee ? '保存资料' : '确认签到'}</span></button>
        </form>
      </section>
    </main>`;
  bindLocalCheckinForm();
  window.lucide?.createIcons();
}

function updateCheckinAvatarPreview() {
  const preview = document.querySelector('#checkinAvatarPreview');
  if (preview) preview.src = checkinUiState.preview || checkinUiState.avatar || makeAvatarDataUrl(checkinUiState.name);
  const reset = document.querySelector('#useNameAvatar');
  if (reset) reset.hidden = !checkinUiState.preview && !checkinUiState.avatar;
}

function updateCheckinBusy() {
  const busy = checkinUiState.preparing || checkinUiState.submitting;
  for (const selector of ['#submitCheckin', '#chooseCheckinAvatar', '#checkinAvatarFile', '#useNameAvatar']) {
    const element = document.querySelector(selector);
    if (element) element.disabled = busy;
  }
  for (const selector of ['#checkinName', '#checkinPhone', '#checkinCompany']) {
    const element = document.querySelector(selector);
    if (element) element.disabled = checkinUiState.submitting;
  }
  const button = document.querySelector('#submitCheckin span');
  if (button) button.textContent = checkinUiState.submitting ? '正在提交' : checkinUiState.preparing ? '正在处理头像' : checkinUiState.editing ? '保存资料' : '确认签到';
  document.querySelector('#localCheckinForm')?.setAttribute('aria-busy', String(busy));
}

function clearCheckinPreview() {
  if (checkinUiState.preview) URL.revokeObjectURL(checkinUiState.preview);
  checkinUiState.preview = '';
}

async function prepareCheckinAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片');
  }
  if (file.size > 12 * 1024 * 1024) throw new Error('照片不能超过 12 MB');
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('无法读取这张照片，请重新选择'));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(512, side);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('照片处理失败，请重新选择');
    return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bindLocalCheckinForm() {
  const fileInput = document.querySelector('#checkinAvatarFile');
  document.querySelector('#chooseCheckinAvatar')?.addEventListener('click', () => fileInput.click());
  document.querySelector('#checkinName').addEventListener('input', (event) => {
    checkinUiState.name = event.target.value;
    document.querySelector('#checkinError').textContent = '';
    updateCheckinAvatarPreview();
  });
  document.querySelector('#checkinPhone').addEventListener('input', (event) => {
    checkinUiState.phone = event.target.value;
    document.querySelector('#checkinError').textContent = '';
  });
  document.querySelector('#checkinCompany')?.addEventListener('change', (event) => {
    checkinUiState.company = event.target.value;
    document.querySelector('#checkinError').textContent = '';
  });
  document.querySelector('#useNameAvatar')?.addEventListener('click', () => {
    clearCheckinPreview();
    checkinUiState.avatar = '';
    checkinUiState.file = null;
    fileInput.value = '';
    document.querySelector('#checkinError').textContent = '';
    updateCheckinAvatarPreview();
  });
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    checkinUiState.preparing = true;
    updateCheckinBusy();
    const error = document.querySelector('#checkinError');
    error.textContent = '';
    try {
      const prepared = await prepareCheckinAvatar(file);
      clearCheckinPreview();
      checkinUiState.file = prepared;
      checkinUiState.avatar = '';
      checkinUiState.preview = URL.createObjectURL(prepared);
      updateCheckinAvatarPreview();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      checkinUiState.preparing = false;
      fileInput.value = '';
      updateCheckinBusy();
    }
  });
  document.querySelector('#localCheckinForm').addEventListener('submit', submitLocalCheckin);
}

async function submitLocalCheckin(event) {
  event.preventDefault();
  if (checkinUiState.submitting || checkinUiState.preparing) return;
  const name = (document.querySelector('#checkinName')?.value ?? checkinUiState.name).replace(/\s+/g, ' ').trim();
  const phone = (document.querySelector('#checkinPhone')?.value ?? checkinUiState.phone).trim();
  const company = document.querySelector('#checkinCompany')?.value ?? checkinUiState.company;
  const error = document.querySelector('#checkinError');
  error.textContent = '';
  if (!name) {
    error.textContent = '请填写姓名';
    document.querySelector('#checkinName').focus();
    return;
  }
  if (!phone) {
    error.textContent = '请填写手机号';
    document.querySelector('#checkinPhone').focus();
    return;
  }
  Object.assign(checkinUiState, { name, phone, company, initialized: true });
  checkinUiState.submitting = true;
  updateCheckinBusy();
  const wechat = isWechatCheckin();
  try {
    if (!wechat && checkinUiState.file) {
      const data = new FormData();
      data.append('file', checkinUiState.file);
      const uploaded = await api('/api/checkin/avatar', { method: 'POST', body: data });
      checkinUiState.avatar = uploaded.url;
      checkinUiState.file = null;
    }
    const result = await api('/api/checkin', {
      method: 'POST',
      body: wechat ? { name, phone, company } : { name, phone, company, avatar: checkinUiState.avatar }
    });
    state.selfAttendee = result.attendee;
    checkinUiState.editing = false;
    clearCheckinPreview();
    renderCheckin();
  } catch (err) {
    if (err.code === 'COMPANY_OPTIONS_CHANGED') {
      try {
        await refreshState();
        checkinUiState.company = state.selfAttendee?.company || '';
        renderCheckin();
      } catch { /* Keep the current draft available when refreshing fails. */ }
    }
    const currentError = document.querySelector('#checkinError');
    if (currentError) currentError.textContent = err.message;
    const retry = document.querySelector('#retryWechatCheckin');
    if (retry && err.status === 401) retry.hidden = false;
  } finally {
    checkinUiState.submitting = false;
    updateCheckinBusy();
  }
}

function renderCheckinSuccess(attendee, local = false) {
  app.innerHTML = `
    <main class="checkin-page ${local ? 'local-checkin-page' : ''}">
      <section class="checkin-card success-state ${local ? 'local-checkin-card' : ''}">
        <img class="rolling-avatar" src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
        <h1 class="mobile-title">签到成功</h1>
        <p class="mobile-copy checkin-success-name">${escapeHtml(attendee.name)}，祝你好运</p>
        ${attendee.company ? `<p class="mobile-copy checkin-success-company">所属单位：${escapeHtml(attendee.company)}</p>` : ''}
        ${local ? '<button id="editCheckin" class="checkin-text-button" type="button">修改资料</button>' : ''}
      </section>
    </main>
  `;
  if (local) {
    document.querySelector('#editCheckin').addEventListener('click', () => {
      checkinUiState.initialized = true;
      checkinUiState.editing = true;
      checkinUiState.name = attendee.name;
      checkinUiState.phone = attendee.phone || '';
      checkinUiState.company = attendee.company || '';
      checkinUiState.avatar = isWechatCheckin() ? state.wechat.profile.avatar
        : attendee.avatar?.startsWith('/uploads/') ? attendee.avatar : '';
      renderCheckin();
    });
  }
}

function makeAvatarDataUrl(seed) {
  const colors = ['#b91c1c', '#0f766e', '#1d4ed8', '#a16207', '#be185d', '#6d28d9'];
  const text = String(seed || '嘉宾').trim().slice(-2);
  const color = colors[Math.abs(hashCode(text)) % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="80" fill="${color}"/><circle cx="118" cy="30" r="46" fill="#f4c762" opacity=".65"/><text x="80" y="96" text-anchor="middle" font-size="48" fill="#fff" font-family="Arial, sans-serif" font-weight="700">${escapeHtml(text)}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function hashCode(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function screenIcon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function renderScreenBrand() {
  const config = state.config || {};
  if (!config.logoUrl) return '';
  const x = clampScreenPosition(config.logoPosition?.x, 32, 190, 'x');
  const y = clampScreenPosition(config.logoPosition?.y, 24, 82, 'y');
  return `<div class="screen-logo" style="left:${x}px; top:${y}px;">
    <img src="${escapeHtml(config.logoUrl)}" alt="活动 Logo" />
  </div>`;
}

function renderScreenToolbar(mode) {
  return `<footer class="screen-toolbar">
    <nav class="screen-page-switch" aria-label="大屏页面">
      <a href="/screen/checkin" data-screen-path="/screen/checkin" ${mode === 'checkin' ? 'aria-current="page"' : ''}>${screenIcon('scan-line')}签到展示</a>
      <a href="/screen/lottery" data-screen-path="/screen/lottery" ${mode === 'lottery' ? 'aria-current="page"' : ''}>${screenIcon('gift')}幸运抽奖</a>
    </nav>
    <div class="screen-tools">
      <button class="ghost icon-button" id="fullscreenButton" aria-label="全屏" title="全屏">${screenIcon('maximize')}</button>
      <button class="ghost icon-button" id="musicButton" aria-label="音乐" title="音乐" ${state.config.musicUrl ? '' : 'disabled'}>${screenIcon('music-2')}</button>
      ${state.deployment === 'public' ? `<button class="ghost icon-button" id="logoutButton" aria-label="退出登录" title="退出登录">${screenIcon('log-out')}</button>` : ''}
    </div>
  </footer>`;
}

function renderCheckinScreen(arrivals = new Set()) {
  disposeDrawScene();
  const config = state.config || {};
  const qrSize = clampQrSize(config.qrSize || 106);
  const qrX = clampScreenPosition(config.qrPosition?.x, Math.max(window.innerWidth - qrSize - 16, 36), qrSize + 10, 'x');
  const qrY = clampScreenPosition(config.qrPosition?.y, 28, qrSize + 46, 'y');
  const recent = state.attendees.slice(-6).reverse();
  app.innerHTML = `
    <main class="screen-page checkin-display-page" style="--checkin-qr-clearance:${Math.max(90, qrY + qrSize + 46)}px;">
      ${renderScreenBrand()}
      <div class="qr-card" tabindex="0" aria-label="移动签到二维码" title="移动签到二维码" style="right:auto; left:${qrX}px; top:${qrY}px; --qr-size:${qrSize}px;">
        <img draggable="false" src="/api/qrcode.svg?target=${encodeURIComponent(state.checkinUrl || `${location.origin}/checkin`)}" alt="签到二维码" />
        <strong>${config.checkinEnabled === false ? '签到已暂停' : '微信扫码签到'}</strong>
        <button type="button" class="qr-resize-handle" aria-label="调整二维码大小" title="调整二维码大小">${screenIcon('move-diagonal-2')}</button>
      </div>
      ${config.musicUrl ? `<audio id="screenAudio" src="${escapeHtml(config.musicUrl)}" loop></audio>` : ''}
      <div class="screen-content checkin-display-content">
        <header class="screen-title checkin-display-title">
          <span class="screen-section-label">现场签到</span>
          <h1>${escapeHtml(config.eventTitle || '微信签到抽奖活动')}</h1>
          <div class="checkin-total" aria-live="polite">已签到 <strong>${state.attendees.length}</strong> 位</div>
        </header>
        <section class="checkin-display-wall" aria-label="签到头像墙">
          <div id="avatarStage" class="avatar-stage ${escapeHtml(config.wallMode || 'orbit')}"></div>
        </section>
        <section class="recent-checkins" aria-label="最近签到">
          <h2>最近签到</h2>
          <div class="recent-checkin-list">${recent.length ? recent.map((attendee) => `
            <div class="recent-checkin-item${arrivals.has(attendee.id) ? ' checkin-arrival' : ''}" data-checkin-id="${escapeHtml(attendee.id)}">
              <img src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
              <strong>${escapeHtml(attendee.name || attendee.nickname || '微信嘉宾')}</strong>
            </div>`).join('') : '<span class="checkin-waiting">等待嘉宾入场</span>'}
          </div>
        </section>
        ${renderScreenToolbar('checkin')}
      </div>
    </main>`;
  paintAvatarStage();
  bindScreenEvents();
  window.lucide?.createIcons();
}

function renderScreen() {
  stopSpatialRotation();
  disposeDrawScene();
  const config = state.config || {};
  const selectedPrize = getSelectedScreenPrize();
  const selectedWinners = selectedPrize ? state.winners.filter((winner) => winner.prizeId === selectedPrize.id) : [];
  const selectedQuantity = Math.max(0, Number(selectedPrize?.quantity || 0));
  const selectedRemaining = Math.max(0, selectedQuantity - selectedWinners.length);
  const selectedDrawCount = Math.max(1, Math.min(Number(selectedPrize?.drawCount || 1), selectedRemaining || 1));
  const prizeOptions = state.prizes.map((prize) => `<option value="${escapeHtml(prize.id)}" ${prize.id === selectedPrize?.id ? 'selected' : ''}>${escapeHtml(prize.name)}</option>`).join('');
  app.innerHTML = `
    <main class="screen-page lottery-display-page">
      <div class="screen-tech-lines" aria-hidden="true"><i></i><i></i><i></i></div>
      ${renderScreenBrand()}
      ${config.musicUrl ? `<audio id="screenAudio" src="${escapeHtml(config.musicUrl)}" loop></audio>` : ''}
      <button id="drawStopButton" class="draw-stop-button" type="button">
        ${screenIcon('square')}
        <strong>停止抽奖</strong>
      </button>
      <div id="drawLiveStatus" class="draw-live-status" role="status" aria-live="polite"></div>
      <div class="screen-content">
        <header class="screen-title">
          <h1>${escapeHtml(config.eventTitle || '微信签到抽奖活动')}</h1>
          <p>${escapeHtml(config.subtitle || '扫码签到 · 头像滚动 · 幸运抽奖')}</p>
        </header>
        <section class="screen-main">
          <section class="lottery-panel">
            <div class="panel-ribbon">
              <h2>幸运抽奖</h2>
            </div>
            <div class="active-prize-name">${escapeHtml(selectedPrize?.name || '请创建奖项')}</div>
            <div class="gift-stage">
              <button id="previousPrizeButton" class="gift-arrow" type="button" aria-label="上一个奖项" title="上一个奖项" ${state.prizes.length > 1 ? '' : 'disabled'}>${screenIcon('chevron-left')}</button>
              <div class="gift-visual" aria-hidden="true">
                <div class="gift-rays"></div>
                <div class="gift-particles"></div>
                ${selectedPrize?.imageUrl ? `
                  <div class="prize-artwork"><img src="${escapeHtml(selectedPrize.imageUrl)}" alt="" /></div>
                ` : `
                  <div class="gift-box">
                    <div class="gift-lid"></div>
                    <div class="gift-body"></div>
                    <div class="gift-bow"></div>
                  </div>
                `}
              </div>
              <button id="nextPrizeButton" class="gift-arrow" type="button" aria-label="下一个奖项" title="下一个奖项" ${state.prizes.length > 1 ? '' : 'disabled'}>${screenIcon('chevron-right')}</button>
            </div>
            <div class="prize-summary">
              <strong>${escapeHtml(selectedPrize?.name || '暂无奖项')}</strong>
              <span>${selectedPrize ? `共 ${selectedQuantity} 份 · 剩余 ${selectedRemaining} 份` : '请先在后台添加奖项'}</span>
            </div>
            <div class="lottery-meta">参与人数：${state.attendees.length}</div>
            <div class="draw-actions">
              <select id="screenPrize" class="screen-prize-select" aria-label="当前奖项">${prizeOptions}</select>
              <div class="draw-count-control">
                <button type="button" data-draw-count-delta="-1" aria-label="减少抽取人数" title="减少抽取人数">${screenIcon('minus')}</button>
                <input id="screenCount" type="number" min="1" max="${Math.max(1, selectedRemaining)}" value="${selectedDrawCount}" aria-label="本次抽取人数" readonly />
                <button type="button" data-draw-count-delta="1" aria-label="增加抽取人数" title="增加抽取人数">${screenIcon('plus')}</button>
              </div>
              <button id="drawButton" ${availableCandidates().length && selectedPrize && selectedRemaining ? '' : 'disabled'}>${screenIcon('play')}${selectedPrize && !selectedRemaining ? '本奖项已抽完' : '开始抽奖'}</button>
            </div>
          </section>
          <section class="winner-panel">
            <div class="panel-ribbon panel-ribbon-wide">
              <h2>抽奖结果</h2>
              <span>${escapeHtml(selectedPrize?.name || '暂无奖项')} · ${selectedWinners.length} 位</span>
            </div>
            <div class="winner-stage">
              <div id="avatarStage" class="avatar-stage" aria-hidden="true"></div>
              <div id="drawFocusRail" class="draw-focus-rail" aria-hidden="true"></div>
              <div id="prizeResults" class="prize-results" aria-label="${escapeHtml(selectedPrize?.name || '')}抽奖结果">${renderPrizeResults(selectedPrize)}</div>
              <button id="openWinnerBookButton" class="winner-book-trigger" type="button">${screenIcon('list')}查看本奖项名单</button>
            </div>
          </section>
        </section>
        ${renderScreenToolbar('lottery')}
      </div>
    </main>
  `;
  bindScreenEvents();
  window.lucide?.createIcons();
}

function getSelectedScreenPrize() {
  const prize = state.prizes.find((item) => item.id === screenUiState.selectedPrizeId) || state.prizes[0] || null;
  screenUiState.selectedPrizeId = prize?.id || null;
  return prize;
}

function cycleScreenPrize(direction) {
  if (state.prizes.length < 2 || drawState.rolling) return;
  const currentIndex = Math.max(0, state.prizes.findIndex((item) => item.id === screenUiState.selectedPrizeId));
  const nextIndex = (currentIndex + direction + state.prizes.length) % state.prizes.length;
  screenUiState.selectedPrizeId = state.prizes[nextIndex].id;
  renderScreen();
}

function clampQrSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 106;
  return Math.max(88, Math.min(480, window.innerWidth - 24, window.innerHeight - 72, Math.round(number)));
}

function qrLayout(size, x, y) {
  const qrSize = clampQrSize(size);
  return {
    qrSize,
    qrPosition: {
      x: Math.round(clampScreenPosition(x, 16, qrSize, 'x')),
      y: Math.round(clampScreenPosition(y, 28, qrSize + 34, 'y'))
    }
  };
}

function applyQrLayout(card, layout) {
  card.style.left = `${layout.qrPosition.x}px`;
  card.style.top = `${layout.qrPosition.y}px`;
  card.style.setProperty('--qr-size', `${layout.qrSize}px`);
  card.closest('.checkin-display-page')?.style.setProperty('--checkin-qr-clearance', `${Math.max(90, layout.qrPosition.y + layout.qrSize + 46)}px`);
}

async function saveQrLayout(layout) {
  const previous = { qrPosition: state.config.qrPosition, qrSize: state.config.qrSize };
  state.config = { ...state.config, ...layout };
  qrSaving = true;
  try {
    const saved = await api('/api/screen/qr-layout', { method: 'PUT', body: layout });
    state.config = { ...state.config, ...saved };
  } catch (error) {
    state.config = { ...state.config, ...previous };
    toast(error.message);
  } finally {
    qrSaving = false;
    if (location.pathname === '/screen/checkin') {
      const focus = document.activeElement?.closest('.qr-resize-handle') ? '.qr-resize-handle'
        : document.activeElement?.closest('.qr-card') ? '.qr-card' : null;
      renderCheckinScreen();
      if (focus) document.querySelector(focus)?.focus();
    }
  }
}

function bindQrLayout() {
  const card = document.querySelector('.qr-card');
  if (!card) return;
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || qrSaving || qrInteraction) return;
    const rect = card.getBoundingClientRect();
    qrInteraction = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, size: rect.width,
      resizing: Boolean(event.target.closest('.qr-resize-handle')),
      layout: qrLayout(rect.width, rect.left, rect.top), moved: false
    };
    card.setPointerCapture(event.pointerId);
    card.classList.add('is-adjusting');
    event.preventDefault();
  });
  card.addEventListener('pointermove', (event) => {
    const drag = qrInteraction;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 3 && !drag.moved) return;
    drag.moved = true;
    drag.layout = drag.resizing
      ? qrLayout(drag.size + Math.max(dx, dy), drag.left, drag.top)
      : qrLayout(drag.size, drag.left + dx, drag.top + dy);
    applyQrLayout(card, drag.layout);
  });
  const finish = (event) => {
    const drag = qrInteraction;
    if (!drag || event.pointerId !== drag.pointerId) return;
    qrInteraction = null;
    card.classList.remove('is-adjusting');
    if (event.type === 'pointerup' && drag.moved) saveQrLayout(drag.layout);
    else renderCheckinScreen();
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
  card.addEventListener('lostpointercapture', finish);
  card.addEventListener('keydown', (event) => {
    if (qrSaving || qrInteraction) return;
    const rect = card.getBoundingClientRect();
    const step = event.shiftKey ? 10 : 2;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const resizing = event.target.closest('.qr-resize-handle');
    let layout;
    if (['+', '=', '-'].includes(event.key) || (resizing && arrows[event.key])) {
      const delta = event.key === '-' || ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -step : step;
      layout = qrLayout(rect.width + delta, rect.left, rect.top);
    } else if (arrows[event.key]) {
      const [dx, dy] = arrows[event.key];
      layout = qrLayout(rect.width, rect.left + dx, rect.top + dy);
    } else return;
    event.preventDefault();
    saveQrLayout(layout);
  });
}

function clampScreenPosition(value, fallback, elementSize, axis) {
  const number = Number(value);
  const viewport = axis === 'y' ? window.innerHeight : window.innerWidth;
  const max = Math.max(0, viewport - elementSize - 12);
  if (!Number.isFinite(number)) return Math.min(fallback, max);
  return Math.max(0, Math.min(number, max));
}

function winnersForPrize(prizeId) {
  return state.winners.filter((winner) => winner.prizeId === prizeId);
}

function renderPrizeResults(prize) {
  const winners = prize ? winnersForPrize(prize.id) : [];
  if (!winners.length) {
    return `<div class="prize-results-empty">${screenIcon('trophy')}<strong>${prize ? `${escapeHtml(prize.name)} · 等待幸运揭晓` : '暂无奖项'}</strong><span>暂无中奖记录</span></div>`;
  }
  return `<div class="prize-results-grid">${winners.slice().reverse().map((winner, index) => `
    <article class="prize-result" data-winner-id="${escapeHtml(winner.id)}">
      <span class="prize-result-number">${String(winners.length - index).padStart(2, '0')}</span>
      <img src="${escapeHtml(winner.avatar || makeAvatarDataUrl(winner.name))}" alt="" />
      <strong>${escapeHtml(winner.name || winner.nickname || '幸运嘉宾')}</strong>
      <span>${escapeHtml(winner.company || winner.nickname || '')}</span>
    </article>`).join('')}</div>`;
}

function paintAvatarStage(attendeePool = state.attendees) {
  stopSpatialRotation();
  const stage = document.querySelector('#avatarStage');
  if (!stage) return;
  const wallMode = state.config.wallMode || 'orbit';
  const visualMode = drawState.rolling ? drawState.activeAnimation : getVisualWallMode(wallMode);
  stage.classList.remove('sphere', 'wall', 'text', 'orbit');
  stage.classList.add(visualMode);
  const width = Math.max(stage.clientWidth, 1);
  const height = Math.max(stage.clientHeight, 1);
  const wallCapacity = Math.max(24, Math.floor(width / 60) * Math.floor(height / 22));
  const maxVisible = ['sphere', 'orbit'].includes(visualMode) ? 520 : Math.min(180, wallCapacity);
  const attendees = attendeePool.slice(-maxVisible);
  const drawingSphere = drawState.rolling && visualMode === 'sphere';
  const spatialCheckin = window.location.pathname === '/screen/checkin' && ['sphere', 'orbit'].includes(visualMode);
  const spatial = (drawingSphere || spatialCheckin) && attendees.length > 0;
  stage.classList.toggle('is-spatial', spatial);
  stage.classList.toggle('is-dense', attendees.length >= 36);
  if (!attendees.length) {
    stage.innerHTML = '<div class="empty-stage">等待扫码签到</div>';
    return;
  }
  const avatarSize = getResponsiveAvatarSize(attendees.length, width, height, visualMode);
  stage.style.setProperty('--avatar-size', `${avatarSize}px`);
  stage.style.setProperty('--avatar-node-width', `${Math.max(avatarSize + 12, 56)}px`);
  stage.style.setProperty('--avatar-label-max', `${Math.max(avatarSize + 22, 64)}px`);
  const avoidRect = getStageAvoidRect(stage, width, height);
  if (spatial) {
    paintSpatialAvatarStage(stage, attendees, visualMode, width, height, avoidRect, drawingSphere);
    return;
  }
  const sphereBounds = visualMode === 'sphere' ? getSphereBounds(width, height, avoidRect) : null;
  const orbitBounds = visualMode === 'orbit' ? getOrbitBounds(width, height, avoidRect) : null;
  if (sphereBounds) {
    stage.style.setProperty('--sphere-left', `${sphereBounds.centerX}px`);
    stage.style.setProperty('--sphere-top', `${sphereBounds.centerY}px`);
    stage.style.setProperty('--sphere-diameter', `${sphereBounds.radius * 2}px`);
  } else {
    stage.style.removeProperty('--sphere-left');
    stage.style.removeProperty('--sphere-top');
    stage.style.removeProperty('--sphere-diameter');
  }
  if (orbitBounds) {
    stage.style.setProperty('--orbit-left', `${orbitBounds.centerX}px`);
    stage.style.setProperty('--orbit-top', `${orbitBounds.centerY}px`);
    stage.style.setProperty('--orbit-width', `${orbitBounds.radiusX * 2}px`);
    stage.style.setProperty('--orbit-height', `${orbitBounds.radiusY * 2}px`);
  } else {
    stage.style.removeProperty('--orbit-left');
    stage.style.removeProperty('--orbit-top');
    stage.style.removeProperty('--orbit-width');
    stage.style.removeProperty('--orbit-height');
  }
  const positions = getAvatarPositions(attendees.length, width, height, visualMode, state.config.wallText, avatarSize, avoidRect, sphereBounds, orbitBounds);
  stage.innerHTML = attendees.map((attendee, index) => {
    const position = positions[index] || { x: width / 2, y: height / 2 };
    const sphere = getSphereAvatarPosition(index, attendees.length, width, height);
    const delay = (index % 12) * -0.28;
    return `
      <div class="avatar-node" data-attendee-id="${escapeHtml(attendee.id)}" data-sphere-angle="${sphere.angle}" style="left:${position.x}px; top:${position.y}px; z-index:${position.zIndex || 1}; animation-delay:${delay}s; --sphere-angle:${sphere.angle}deg; --sphere-y:${sphere.y}px; --sphere-radius:${sphere.radius}px; --sphere-scale:${position.scale || sphere.scale}; --sphere-delay:${sphere.delay}s; --sphere-opacity:${position.opacity || 1}; --sphere-blur:${position.blur || 0}px;">
        <img src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
        <span>${escapeHtml(attendee.name || attendee.nickname)}</span>
      </div>
    `;
  }).join('');
}

function paintSpatialAvatarStage(stage, attendees, mode, width, height, avoidRect, drawing) {
  const usableWidth = avoidRect && avoidRect.top < height * 0.48 && avoidRect.left > width * 0.55
    ? avoidRect.left : width;
  const centerX = usableWidth / 2;
  const centerY = height * (drawing ? 0.45 : 0.49);
  const radius = Math.min(usableWidth * 0.36, height * (drawing ? 0.29 : 0.36));
  const size = Math.max(14, Math.min(drawing ? 62 : 68, radius * 1.55 / Math.sqrt(attendees.length), radius * 0.48));
  stage.style.setProperty('--scene-x', `${centerX}px`);
  stage.style.setProperty('--scene-y', `${centerY}px`);
  stage.style.setProperty('--scene-diameter', `${radius * 2}px`);
  stage.style.setProperty('--avatar-size', `${size}px`);
  stage.innerHTML = attendees.map((attendee) => `
    <div class="avatar-node" data-attendee-id="${escapeHtml(attendee.id)}">
      <img src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
    </div>`).join('');

  const nodes = stage.querySelectorAll('.avatar-node');
  const points = spatialAvatarPoints(attendees.length, mode);
  const motion = window.matchMedia?.('(prefers-reduced-motion: no-preference)');
  const rotationSpeed = drawing ? 1080 : 2500;
  function drawFrame(time) {
    const moving = motion?.matches;
    const angle = moving ? time / rotationSpeed : 0.5;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    nodes.forEach((node, index) => {
      const point = projectAvatarPoint(points[index], sine, cosine);
      node.style.transform = `translate3d(${centerX + point.x * radius}px, ${centerY + point.y * radius}px, 0) translate(-50%, -50%) scale(${point.scale})`;
      node.style.opacity = point.opacity;
      node.style.zIndex = point.depth;
    });
    if (moving) spatialRotationFrame = window.requestAnimationFrame(drawFrame);
  }
  drawFrame(performance.now());
}

function spatialAvatarPoints(count, mode) {
  const ringTilts = [-0.43, 0.55, 0.13];
  return Array.from({ length: count }, (_, index) => {
    if (mode === 'orbit') {
      const ring = index % ringTilts.length;
      const amount = Math.ceil((count - ring) / ringTilts.length);
      const angle = Math.floor(index / ringTilts.length) * Math.PI * 2 / amount + ring * 0.55;
      const radius = 0.65 + ring * 0.18;
      const depth = Math.sin(angle) * radius;
      return { x: Math.cos(angle) * radius, y: Math.sin(ringTilts[ring]) * depth + (ring - 1) * 0.18, z: Math.cos(ringTilts[ring]) * depth };
    }
    const y = 1 - (index + 0.5) * 2 / count;
    const radius = Math.sqrt(1 - y * y);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
  });
}

function projectAvatarPoint(point, sine, cosine) {
  const x = point.x * cosine + point.z * sine;
  const z = -point.x * sine + point.z * cosine;
  const y = point.y * 0.94 - z * 0.34;
  const depth = point.y * 0.34 + z * 0.94;
  const perspective = 3 / (3 - depth);
  return {
    x: x * perspective,
    y: -y * perspective,
    scale: perspective * (1 + depth * 0.18),
    opacity: Math.min(1, 0.66 + depth * 0.35),
    depth: Math.round((depth + 1.2) * 1000)
  };
}

function stopSpatialRotation() {
  if (spatialRotationFrame) window.cancelAnimationFrame(spatialRotationFrame);
  spatialRotationFrame = 0;
}

function getVisualWallMode(mode) {
  return ['orbit', 'sphere', 'wall', 'text'].includes(mode) ? mode : 'orbit';
}

function getSphereAvatarPosition(index, count, width, height) {
  const safeCount = Math.max(count, 1);
  const rings = Math.max(4, Math.ceil(Math.sqrt(safeCount)));
  const row = Math.floor((index / safeCount) * rings);
  const rowProgress = rings === 1 ? 0.5 : row / (rings - 1);
  const yUnit = -0.9 + rowProgress * 1.8;
  const radiusUnit = Math.max(0.25, Math.sqrt(Math.max(0, 1 - yUnit * yUnit)));
  const goldenAngle = 137.508;
  const angle = (index * goldenAngle + row * 18) % 360;
  const radius = Math.max(120, Math.min(width, height) * 0.34 * radiusUnit);
  return {
    angle: Math.round(angle * 100) / 100,
    y: Math.round(yUnit * Math.min(height, width) * 0.36),
    radius: Math.round(radius),
    scale: (0.68 + radiusUnit * 0.34).toFixed(2),
    delay: Number((index * -0.08).toFixed(2))
  };
}

function getResponsiveAvatarSize(count, width, height, mode) {
  if (mode === 'orbit') {
    const arena = Math.min(width * 0.78, height * 0.58);
    const tile = Math.sqrt((arena * arena * 0.95) / Math.max(count, 1));
    return Math.max(24, Math.min(40, Math.round(tile)));
  }
  if (mode === 'sphere') {
    const diameter = Math.min(width * 0.72, height * 0.64);
    const tile = Math.sqrt((diameter * diameter * 0.72) / Math.max(count, 1)) * 1.04;
    return Math.max(14, Math.min(28, Math.round(tile)));
  }
  if (mode !== 'wall') return 64;
  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(count * 1.35)), Math.floor(width / 60)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const byWidth = Math.floor((width / (cols + 0.5)) * 0.82);
  const byHeight = Math.floor((Math.max(1, height - 104) / rows) * 0.8);
  return Math.max(14, Math.min(64, byWidth, byHeight));
}

function getStageAvoidRect(stage, width, height) {
  const qr = document.querySelector('.qr-card');
  if (!qr) return null;
  const stageRect = stage.getBoundingClientRect();
  const qrRect = qr.getBoundingClientRect();
  const overlaps = qrRect.right > stageRect.left && qrRect.left < stageRect.right && qrRect.bottom > stageRect.top && qrRect.top < stageRect.bottom;
  if (!overlaps) return null;
  const padding = 10;
  return {
    left: Math.max(0, qrRect.left - stageRect.left - padding),
    top: Math.max(0, qrRect.top - stageRect.top - padding),
    right: Math.min(width, qrRect.right - stageRect.left + padding),
    bottom: Math.min(height, qrRect.bottom - stageRect.top + padding)
  };
}

function getSphereBounds(width, height, avoidRect = null) {
  let radius = Math.min(width * 0.39, height * 0.32);
  let centerX = width * 0.44;
  let centerY = height * 0.47;
  if (avoidRect && avoidRect.top < centerY + radius && avoidRect.left < centerX + radius) {
    radius = Math.min(radius, avoidRect.left - centerX - 18);
  }
  radius = Math.max(126, radius);
  centerX = Math.max(radius + 18, Math.min(width - radius - 18, centerX));
  centerY = Math.max(radius + 18, Math.min(height - radius - 18, centerY));
  return { centerX, centerY, radius };
}

function getOrbitBounds(width, height, avoidRect = null) {
  const bottomReserve = Math.max(136, height * 0.22);
  const bottomLimit = Math.max(height * 0.58, height - bottomReserve);
  let centerX = width * 0.5;
  let centerY = height * 0.43;
  let radiusX = Math.min(width * 0.38, 270);
  let radiusY = Math.min(height * 0.24, 190);
  if (avoidRect && avoidRect.top < centerY && avoidRect.left < centerX + radiusX) {
    centerX = Math.max(width * 0.42, Math.min(centerX, avoidRect.left - radiusX * 0.28));
  }
  centerX = Math.max(radiusX + 28, Math.min(width - radiusX - 28, centerX));
  radiusY = Math.min(radiusY, Math.max(96, bottomLimit - centerY - 22));
  centerY = Math.max(radiusY + 34, Math.min(bottomLimit - radiusY, centerY));
  return { centerX, centerY, radiusX, radiusY };
}

function getAvatarPositions(count, width, height, mode, text, avatarSize = 64, avoidRect = null, sphereBounds = null, orbitBounds = null) {
  if (mode === 'orbit') return orbitPositions(count, width, height, avatarSize, avoidRect, orbitBounds);
  if (mode === 'wall') return gridPositions(count, width, height, avatarSize, avoidRect);
  if (mode === 'sphere') return spherePositions(count, width, height, avatarSize, avoidRect, sphereBounds);
  if (mode === 'text') return textPositions(count, width, height, text || 'LUCKY');
  const positions = [];
  const centerX = width * 0.48;
  const centerY = height * 0.52;
  const radiusX = width * 0.34;
  const radiusY = height * 0.34;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const ring = 0.46 + ((index % 5) / 5) * 0.54;
    positions.push({
      x: centerX + Math.cos(angle) * radiusX * ring,
      y: centerY + Math.sin(angle * 1.35) * radiusY * ring
    });
  }
  return positions;
}

function orbitPositions(count, width, height, avatarSize = 32, avoidRect = null, orbitBounds = null) {
  const { centerX, centerY, radiusX, radiusY } = orbitBounds || getOrbitBounds(width, height, avoidRect);
  const ringCount = Math.max(3, Math.min(5, Math.ceil(Math.sqrt(Math.max(count, 1)) / 2)));
  const weightTotal = (ringCount * (ringCount + 1)) / 2;
  const ringCounts = Array.from({ length: ringCount }, (_, index) => Math.max(1, Math.round((count * (index + 1)) / weightTotal)));
  let diff = count - ringCounts.reduce((sum, value) => sum + value, 0);
  while (diff !== 0) {
    const target = diff > 0 ? ringCounts.length - 1 : ringCounts.indexOf(Math.max(...ringCounts));
    ringCounts[target] += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  const positions = [];
  ringCounts.forEach((amount, ringIndex) => {
    const progress = (ringIndex + 1) / ringCount;
    const rx = radiusX * (0.24 + progress * 0.76);
    const ry = radiusY * (0.18 + progress * 0.82);
    const phase = ringIndex * 0.42;
    for (let index = 0; index < amount && positions.length < count; index += 1) {
      const angle = ((index / amount) * Math.PI * 2) + phase;
      const depth = (Math.sin(angle) + 1) / 2;
      positions.push({
        x: centerX + Math.cos(angle) * rx,
        y: centerY + Math.sin(angle) * ry + depth * 18 - 8,
        scale: (0.72 + progress * 0.14 + depth * 0.18).toFixed(2),
        opacity: (0.56 + progress * 0.16 + depth * 0.22).toFixed(2),
        blur: depth < 0.18 ? 0.25 : 0,
        zIndex: 10 + ringIndex * 8 + Math.round(depth * 56)
      });
    }
  });
  return positions;
}

function spherePositions(count, width, height, avatarSize = 18, avoidRect = null, sphereBounds = null) {
  const { centerX, centerY, radius } = sphereBounds || getSphereBounds(width, height, avoidRect);
  let rows = Math.max(14, Math.ceil(Math.sqrt(count) * 0.95));
  let cols = Math.max(14, Math.ceil(rows * 1.06));
  let candidates = [];
  const buildCandidates = () => {
    const list = [];
    for (let row = 0; row < rows; row += 1) {
      const ny = rows === 1 ? 0 : -1 + (2 * row) / (rows - 1);
      for (let col = 0; col < cols; col += 1) {
        const nx = cols === 1 ? 0 : -1 + (2 * col) / (cols - 1);
        const normalized = nx * nx + ny * ny;
        if (normalized > 1) continue;
        const z = Math.sqrt(1 - normalized);
        const sideShade = 0.88 + z * 0.16;
        list.push({
          x: centerX + nx * radius * sideShade,
          y: centerY + ny * radius,
          scale: (0.62 + z * 0.5).toFixed(2),
          opacity: (0.34 + z * 0.6).toFixed(2),
          blur: z < 0.32 ? 0.35 : 0,
          zIndex: 10 + Math.round(z * 70)
        });
      }
    }
    return list;
  };
  while (candidates.length < count) {
    candidates = buildCandidates();
    if (candidates.length >= count) break;
    rows += 2;
    cols += 2;
  }
  candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (candidates.length <= count) return candidates;
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = count === 1 ? Math.floor(candidates.length / 2) : Math.round((index * (candidates.length - 1)) / (count - 1));
    return candidates[sourceIndex];
  });
}

function gridPositions(count, width, height, avatarSize = 64, avoidRect = null) {
  const idealCols = Math.ceil(Math.sqrt(count * 1.35));
  const maxCols = Math.max(1, Math.floor(width / Math.max(avatarSize + 18, 60)));
  const cols = Math.max(1, Math.min(idealCols, maxCols));
  const nodeWidth = Math.max(avatarSize + 12, 56);
  const nodeHeight = avatarSize + 28;
  const safeX = Math.max(nodeWidth / 2 + 6, 32);
  const safeTop = Math.max(nodeHeight / 2 + 8, 36);
  const safeBottom = Math.max(nodeHeight / 2 + 14, 58);
  const usableW = Math.max(1, width - safeX * 2);
  const usableH = Math.max(1, height - safeTop - safeBottom);
  const intersectsAvoidRect = (x, y) => {
    if (!avoidRect) return false;
    return x + nodeWidth / 2 > avoidRect.left
      && x - nodeWidth / 2 < avoidRect.right
      && y + nodeHeight / 2 > avoidRect.top
      && y - nodeHeight / 2 < avoidRect.bottom;
  };
  const makeCandidates = (rows) => {
    const candidates = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = cols === 1 ? width / 2 : safeX + (usableW * col) / (cols - 1);
        const y = rows === 1 ? height / 2 : safeTop + (usableH * row) / (rows - 1);
        if (!intersectsAvoidRect(x, y)) candidates.push({ x, y });
      }
    }
    return candidates;
  };
  let rows = Math.ceil(count / cols);
  let candidates = makeCandidates(rows);
  while (candidates.length < count && rows < count) {
    rows += 1;
    candidates = makeCandidates(rows);
  }
  return candidates.slice(0, count);
}

function textPositions(count, width, height, text) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = 520;
  canvas.height = 220;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.font = '900 116px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(text).slice(0, 8), canvas.width / 2, canvas.height / 2);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const points = [];
  for (let y = 14; y < canvas.height; y += 10) {
    for (let x = 12; x < canvas.width; x += 10) {
      if (data[(y * canvas.width + x) * 4 + 3] > 80) points.push({ x, y });
    }
  }
  if (!points.length) return gridPositions(count, width, height);
  return Array.from({ length: count }, (_, index) => {
    const point = points[Math.floor(index * points.length / count) % points.length];
    return {
      x: width * 0.16 + (point.x / canvas.width) * width * 0.66,
      y: height * 0.18 + (point.y / canvas.height) * height * 0.6
    };
  });
}

function bindScreenEvents() {
  bindQrLayout();
  document.querySelectorAll('[data-screen-path]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!drawState.rolling) navigate(link.dataset.screenPath);
    });
  });
  document.querySelector('#fullscreenButton')?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
  document.querySelector('#musicButton')?.addEventListener('click', async () => {
    const audio = document.querySelector('#screenAudio');
    if (!audio) return;
    if (audio.paused) await audio.play();
    else audio.pause();
  });
  bindLogout();
  document.querySelector('#openWinnerBookButton')?.addEventListener('click', showWinnerBookModal);
  document.querySelector('#previousPrizeButton')?.addEventListener('click', () => cycleScreenPrize(-1));
  document.querySelector('#nextPrizeButton')?.addEventListener('click', () => cycleScreenPrize(1));
  document.querySelector('#screenPrize')?.addEventListener('change', (event) => {
    const prize = state.prizes.find((item) => item.id === event.target.value);
    if (!prize) return;
    screenUiState.selectedPrizeId = prize.id;
    renderScreen();
  });
  document.querySelectorAll('[data-draw-count-delta]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.querySelector('#screenCount');
      if (!input) return;
      const minimum = Math.max(1, Number(input.min || 1));
      const maximum = Math.max(minimum, Number(input.max || state.attendees.length || 1));
      const nextValue = Number(input.value || minimum) + Number(button.dataset.drawCountDelta || 0);
      input.value = String(Math.max(minimum, Math.min(maximum, nextValue)));
    });
  });
  document.querySelector('#drawButton')?.addEventListener('click', () => {
    if (drawState.rolling) stopDraw();
    else startDraw();
  });
  document.querySelector('#drawStopButton')?.addEventListener('click', () => {
    if (drawState.rolling) stopDraw();
  });
}

function startDraw() {
  if (drawState.rolling || drawState.stopping) return;
  const prizeId = document.querySelector('#screenPrize')?.value;
  if (!prizeId) {
    toast('请先在后台创建奖项');
    return;
  }
  const prize = state.prizes.find((item) => item.id === prizeId);
  const usedCount = state.winners.filter((winner) => winner.prizeId === prizeId).length;
  const remainingCount = Math.max(0, Number(prize?.quantity || 0) - usedCount);
  if (!prize || remainingCount <= 0) {
    showScreenNotice('该奖项已全部发放', prize?.name || '当前奖项', '请切换其他奖项或到后台增加奖项数量');
    return;
  }
  drawState.candidates = availableCandidates();
  if (!drawState.candidates.length) {
    toast('没有可参与抽奖的签到人员');
    return;
  }
  drawState.rolling = true;
  drawState.runId += 1;
  drawState.prizeId = prizeId;
  drawState.count = Math.max(1, Math.min(Number(document.querySelector('#screenCount')?.value) || 1, remainingCount));
  drawState.railTick = 0;
  drawState.activeAnimation = ['orbit', 'sphere', 'wall', 'text'].includes(prize.animation) ? prize.animation : 'sphere';
  const spherical = drawState.activeAnimation === 'sphere';
  setDrawEffects(true, drawState.activeAnimation);
  paintAvatarStage(drawState.candidates);
  startDrawScene(drawState.activeAnimation);
  updateDrawStatus(`${prize.name} · 正在抽取 ${drawState.count} 位幸运嘉宾`);
  const initialAttendee = drawState.candidates[Math.floor(Math.random() * drawState.candidates.length)];
  highlightRollingCandidate(initialAttendee);
  updateDrawFocusRail(initialAttendee);
  drawState.timer = window.setInterval(() => {
    const attendee = drawState.candidates[Math.floor(Math.random() * drawState.candidates.length)];
    highlightRollingCandidate(attendee);
    drawState.railTick += 1;
    if (spherical || drawState.railTick % 2 === 0) updateDrawFocusRail(attendee);
  }, spherical ? 140 : 70);
  if (drawState.activeAnimation === 'orbit') drawState.fxTimer = window.setInterval(syncOrbitDepth, 180);
}

async function stopDraw() {
  if (!drawState.rolling || drawState.stopping) return;
  drawState.stopping = true;
  window.clearInterval(drawState.timer);
  window.clearInterval(drawState.fxTimer);
  stopSpatialRotation();
  const stopButton = document.querySelector('#drawStopButton');
  stopButton.disabled = true;
  stopButton.querySelector('strong').textContent = '正在揭晓';
  document.querySelector('.screen-page')?.classList.add('is-revealing');
  drawState.scene?.pause();
  updateDrawStatus('正在揭晓中奖嘉宾');
  try {
    const result = await api('/api/draw', {
      method: 'POST',
      body: {
        prizeId: drawState.prizeId,
        count: drawState.count
      }
    });
    // Socket updates may arrive before or after the HTTP response.
    const winnerIds = new Set(state.winners.map((winner) => winner.id));
    state.winners.push(...result.winners.filter((winner) => !winnerIds.has(winner.id)));
    screenUiState.selectedPrizeId = result.prize.id;
    drawState.rolling = false;
    drawState.stopping = false;
    renderScreen();
    showWinnerModal(result.prize, result.winners);
  } catch (err) {
    drawState.rolling = false;
    drawState.stopping = false;
    renderScreen();
    toast(err.message);
  }
}

function availableCandidates() {
  if (state.config.allowRepeatWinners) return state.attendees;
  const winnerIds = new Set(state.winners.map((item) => item.attendeeId));
  return state.attendees.filter((attendee) => !winnerIds.has(attendee.id));
}

async function startDrawScene(animation) {
  if (animation !== 'orbit') return;
  const runId = drawState.runId;
  try {
    const { createLotteryScene } = await import('/lottery-scene.js');
    if (!drawState.rolling || drawState.stopping || runId !== drawState.runId) return;
    const host = document.querySelector('.winner-stage');
    if (!host) return;
    const attendees = drawState.candidates.slice(-180).map((attendee) => ({
      src: attendee.avatar || makeAvatarDataUrl(attendee.name),
      fallback: makeAvatarDataUrl(attendee.name)
    }));
    const scene = createLotteryScene(host, attendees, animation);
    drawState.scene = scene;
    await scene.ready;
    if (drawState.rolling && !drawState.stopping && runId === drawState.runId) {
      document.querySelector('.screen-page')?.classList.add('has-webgl');
    }
  } catch {
    // Keep the CSS avatar animation on devices without WebGL.
    if (runId === drawState.runId) disposeDrawScene();
  }
}

function disposeDrawScene() {
  drawState.scene?.dispose();
  drawState.scene = null;
  drawState.runId += 1;
}

function updateDrawStatus(text) {
  const status = document.querySelector('#drawLiveStatus');
  if (status) status.textContent = text;
}

function setDrawEffects(active, animation = drawState.activeAnimation) {
  const page = document.querySelector('.screen-page');
  const stage = document.querySelector('#avatarStage');
  page?.classList.toggle('is-drawing', active);
  if (page) page.dataset.drawAnimation = active ? animation : '';
  stage?.classList.toggle('drawing', active);
  document.querySelector('.rolling-card')?.classList.toggle('is-rolling', active);
  if (active && stage && animation !== 'sphere') {
    window.requestAnimationFrame(() => {
      refreshDrawGeometry(animation);
      syncOrbitDepth();
    });
  }
  if (!active) {
    document.querySelectorAll('.avatar-node').forEach((node) => {
      node.classList.remove('draw-hot');
      node.style.removeProperty('opacity');
      node.style.removeProperty('z-index');
    });
    stage?.classList.remove('draw-mode-sphere', 'draw-mode-orbit', 'draw-mode-wall', 'draw-mode-text');
    updateDrawFocusRail(null);
    paintAvatarStage();
  }
}

function refreshDrawGeometry(animation) {
  if (animation === 'sphere') {
    paintAvatarStage(drawState.candidates);
    return;
  }
  const stage = document.querySelector('#avatarStage');
  if (!stage) return;
  const nodes = Array.from(stage.querySelectorAll('.avatar-node'));
  const width = Math.max(stage.clientWidth, 280);
  const height = Math.max(stage.clientHeight, 320);
  const mode = animation;
  stage.classList.remove('draw-mode-sphere', 'draw-mode-orbit', 'draw-mode-wall', 'draw-mode-text');
  stage.classList.add(`draw-mode-${mode}`);

  if (mode === 'wall' || mode === 'text') {
    const positions = mode === 'text'
      ? textPositions(nodes.length, width, height, state.config.wallText || 'LUCKY')
      : gridPositions(nodes.length, width * 0.88, height * 0.74, 48).map((position) => ({
          x: position.x + width * 0.06,
          y: position.y + height * 0.12
        }));
    nodes.forEach((node, index) => {
      const position = positions[index] || { x: width / 2, y: height / 2 };
      node.style.setProperty('--draw-x', `${position.x}px`);
      node.style.setProperty('--draw-y', `${position.y}px`);
      node.style.setProperty('--draw-delay', `${(index % 10) * -0.11}s`);
    });
    return;
  }

  nodes.forEach((node, index) => {
    const position = getDrawOrbitPosition(index, nodes.length, width, height);
    node.dataset.sphereAngle = String(position.angle);
    node.style.setProperty('--sphere-angle', `${position.angle}deg`);
    node.style.setProperty('--sphere-y', `${position.y}px`);
    node.style.setProperty('--sphere-radius', `${position.radius}px`);
    node.style.setProperty('--sphere-scale', String(position.scale));
    node.style.setProperty('--sphere-delay', `${position.delay}s`);
  });
}

function getDrawOrbitPosition(index, count, width, height) {
  const safeCount = Math.max(count, 1);
  const rings = Math.max(6, Math.ceil(Math.sqrt(safeCount)));
  const row = Math.floor((index / safeCount) * rings);
  const progress = rings === 1 ? 0.5 : row / (rings - 1);
  const yUnit = -0.94 + progress * 1.88;
  const ringRadius = Math.max(0.22, Math.sqrt(Math.max(0, 1 - yUnit * yUnit)));
  const angle = (index * 137.508 + row * 21) % 360;
  const baseRadius = Math.min(width * 0.38, height * 0.42);
  return {
    angle: Math.round(angle * 100) / 100,
    y: Math.round(yUnit * height * 0.26),
    radius: Math.round(Math.max(35, baseRadius * ringRadius)),
    scale: (0.72 + ringRadius * 0.34).toFixed(2),
    delay: Number((index * -0.08).toFixed(2))
  };
}

function highlightRollingCandidate(attendee) {
  const node = attendee?.id ? document.querySelector(`[data-attendee-id="${CSS.escape(attendee.id)}"]`) : null;
  document.querySelectorAll('.avatar-node.draw-hot').forEach((active) => {
    if (active !== node) active.classList.remove('draw-hot');
  });
  node?.classList.add('draw-hot');
}

function updateDrawFocusRail(centerAttendee) {
  const rail = document.querySelector('#drawFocusRail');
  if (!rail) return;
  if (!drawState.rolling || !centerAttendee) {
    rail.innerHTML = '';
    return;
  }
  const pool = drawState.candidates.filter((item) => item.id !== centerAttendee.id);
  const sideItems = [];
  const used = new Set([centerAttendee.id]);
  while (pool.length && sideItems.length < 4) {
    const item = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    if (!used.has(item.id)) {
      used.add(item.id);
      sideItems.push(item);
    }
  }
  const items = [sideItems[0], sideItems[1], centerAttendee, sideItems[2], sideItems[3]].filter(Boolean);
  rail.innerHTML = `
    <div class="focus-rail-inner">
      ${items.map((item) => `
        <div class="focus-card ${item.id === centerAttendee.id ? 'is-active' : ''}">
          <img src="${escapeHtml(item.avatar || makeAvatarDataUrl(item.name))}" alt="" />
          <strong>${escapeHtml(item.name || item.nickname || '幸运嘉宾')}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function syncOrbitDepth() {
  if (drawState.activeAnimation !== 'orbit') return;
  document.querySelectorAll('.avatar-stage.drawing .avatar-node').forEach((node) => {
    const angle = Number(node.dataset.sphereAngle || 0) + (Date.now() / 12000) * 360;
    const z = Math.cos((angle * Math.PI) / 180);
    node.style.zIndex = node.classList.contains('draw-hot') ? '68' : String(8 + Math.round((z + 1) * 24));
    node.style.opacity = String(0.42 + ((z + 1) / 2) * 0.5);
  });
}

function showWinnerModal(prize, winners) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <section class="modal winner-modal" role="dialog" aria-modal="true" aria-labelledby="winnerModalTitle">
      <div class="winner-modal-rays"></div>
      <button class="winner-modal-close" type="button" data-close-modal aria-label="关闭中奖名单" title="关闭">${screenIcon('x')}</button>
      <header class="winner-modal-header">
        <span>LUCKY MOMENT</span>
        <h2 id="winnerModalTitle">获奖名单</h2>
        <p>${escapeHtml(prize.name)}</p>
      </header>
      <div class="winner-grid ${winners.length === 1 ? 'is-single' : ''}">
        ${winners.map((winner, index) => `
          <div class="winner-card" style="--winner-delay:${index * 0.08}s">
            <div class="winner-rank">${String(index + 1).padStart(2, '0')}</div>
            <div class="winner-avatar-frame">
              <img src="${escapeHtml(winner.avatar || makeAvatarDataUrl(winner.name))}" alt="" />
            </div>
            <h3>${escapeHtml(winner.name)}</h3>
            <p>${escapeHtml(winner.company || winner.nickname || '')}</p>
          </div>
        `).join('')}
      </div>
      <div class="winner-modal-actions"><button type="button" data-close-modal>返回抽奖结果</button></div>
    </section>
  `;
  document.body.appendChild(mask);
  mask.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => mask.remove()));
  window.lucide?.createIcons();
}

function showWinnerBookModal() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const prize = getSelectedScreenPrize();
  const winners = prize ? winnersForPrize(prize.id) : [];
  const prizeGroups = prize ? [{ prize, winners }] : [];
  const total = winners.length;
  mask.innerHTML = `
    <section class="modal winner-book-modal">
      <header class="winner-book-header">
        <span>WINNER LIST</span>
        <h2>${escapeHtml(prize?.name || '当前奖项')}中奖名单</h2>
        <p>已抽中 ${total} 位</p>
      </header>
      <div class="winner-book-content">
        ${total ? prizeGroups.map((group) => `
          <section class="winner-book-section">
            <div class="winner-book-title">
              <strong>${escapeHtml(group.prize.name)}</strong>
              <span>${group.winners.length}/${Number(group.prize.quantity || group.winners.length) || group.winners.length} 位</span>
            </div>
            <div class="winner-book-grid">
              ${group.winners.slice().reverse().map((winner, index) => `
                <div class="winner-book-item">
                  <span class="winner-book-index">${String(group.winners.length - index).padStart(2, '0')}</span>
                  <img src="${escapeHtml(winner.avatar || makeAvatarDataUrl(winner.name))}" alt="" />
                  <div>
                    <strong>${escapeHtml(winner.name || winner.nickname || '幸运嘉宾')}</strong>
                    <span>${escapeHtml(winner.company || winner.nickname || '')}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </section>
        `).join('') : '<div class="winner-book-empty">暂无中奖记录</div>'}
      </div>
      <div class="winner-modal-actions">
        <button data-close-modal>关闭</button>
      </div>
    </section>
  `;
  document.body.appendChild(mask);
  mask.querySelector('[data-close-modal]').addEventListener('click', () => mask.remove());
}

function showFlyCard(attendee) {
  if (window.location.pathname !== '/screen/checkin' || !hasRole('screen')) return;
  document.querySelector('.fly-card')?.remove();
  const card = document.createElement('div');
  card.className = 'fly-card';
  const qr = document.querySelector('.qr-card')?.getBoundingClientRect();
  const wall = document.querySelector('#avatarStage')?.getBoundingClientRect();
  if (qr) {
    card.style.setProperty('--arrival-from-x', `${qr.left + qr.width / 2 - window.innerWidth / 2}px`);
    card.style.setProperty('--arrival-from-y', `${qr.bottom - window.innerHeight / 2}px`);
  }
  if (wall) card.style.setProperty('--arrival-to-y', `${wall.top + wall.height / 2 - window.innerHeight / 2}px`);
  card.innerHTML = `
    <img class="winner-avatar" src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
    <div>
      <strong>${escapeHtml(attendee.name || attendee.nickname)}</strong>
      <span class="muted">${escapeHtml(attendee.company || '已签到')}</span>
    </div>
  `;
  document.body.appendChild(card);
  window.setTimeout(() => card.remove(), 2500);
}

function renderAdmin(arrivals = new Set()) {
  const checkinCount = state.attendees.length;
  const winnerCount = state.winners.length;
  const prizeCount = state.prizes.length;
  app.innerHTML = `
    <main class="admin-shell">
      <aside class="admin-sidebar">
        <h1>签到抽奖后台</h1>
        <nav class="admin-nav">
          ${adminTabButton('checkins', '签到管理')}
          ${adminTabButton('prizes', '抽奖设置')}
          ${adminTabButton('settings', '大屏设置')}
          ${adminTabButton('exports', '数据导出')}
          <a class="button-link" href="/screen/checkin">签到展示</a>
          <a class="button-link" href="/screen/lottery">抽奖大屏</a>
          ${state.deployment === 'public' ? '<button type="button" id="logoutButton">退出登录</button>' : ''}
        </nav>
      </aside>
      <section class="admin-main">
        <header class="admin-header">
          <div>
            <h2>${escapeHtml(state.config.eventTitle || '微信签到抽奖活动')}</h2>
            <p class="muted">${escapeHtml(state.checkinUrl || '')}</p>
          </div>
          <div class="stat-row">
            <div class="stat"><span>已签到</span><strong id="adminCheckinCount">${checkinCount}</strong></div>
            <div class="stat"><span>奖项</span><strong id="adminPrizeCount">${prizeCount}</strong></div>
            <div class="stat"><span>已中奖</span><strong id="adminWinnerCount">${winnerCount}</strong></div>
          </div>
        </header>
        <div id="adminPanel">${renderAdminPanel(arrivals)}</div>
      </section>
    </main>
  `;
  bindAdminEvents();
  bindLogout();
  window.lucide?.createIcons();
}

function adminTabButton(tab, label) {
  return `<button type="button" data-tab="${tab}" class="${activeAdminTab === tab ? 'active' : ''}">${label}</button>`;
}

function updateAdminStats() {
  for (const [selector, count] of [['#adminCheckinCount', state.attendees.length], ['#adminPrizeCount', state.prizes.length], ['#adminWinnerCount', state.winners.length]]) {
    const node = document.querySelector(selector);
    if (node) node.textContent = count;
  }
}

function renderAdminPanel(arrivals) {
  if (activeAdminTab === 'prizes') return renderPrizePanel();
  if (activeAdminTab === 'settings') return state.hasSettingsAccess ? renderSettingsPanel() : renderSettingsUnlockPanel();
  if (activeAdminTab === 'exports') return renderExportPanel();
  return renderCheckinPanel(arrivals);
}

function renderCheckinPanel(arrivals = new Set()) {
  const enabled = state.config.checkinEnabled !== false;
  const wechatMissing = isWechatCheckin() && !state.wechat?.ready;
  const rows = state.attendees.slice().reverse().map((attendee, index) => `
    <tr${arrivals.has(attendee.id) ? ' class="checkin-arrival"' : ''} data-checkin-id="${escapeHtml(attendee.id)}">
      <td class="nowrap">${state.attendees.length - index}</td>
      <td><img class="table-avatar" src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" /></td>
      <td>${escapeHtml(attendee.name)}</td>
      <td>${escapeHtml(attendee.nickname)}</td>
      <td>${escapeHtml(attendee.company)}</td>
      <td>${escapeHtml(attendee.phone)}</td>
      <td>${escapeHtml(formatTime(attendee.checkedInAt))}</td>
      <td><button class="secondary" data-delete-attendee="${escapeHtml(attendee.id)}">删除</button></td>
    </tr>
  `).join('');
  return `
    <section class="checkin-control-bar" aria-label="签到状态">
      <div><strong>${enabled ? '签到已开启' : '签到已暂停'}</strong>${wechatMissing ? '<span class="error-text">微信授权未配置</span>' : ''}</div>
      <button type="button" id="toggleCheckinButton" ${pendingCheckinStatus ? 'disabled' : ''}>${screenIcon(enabled ? 'pause' : 'play')}${enabled ? '暂停签到' : '开始签到'}</button>
    </section>
    <section class="panel">
      <div class="panel-title">
        <h2>签到人员</h2>
        <div class="toolbar">
          <button id="seedDemoButton" class="secondary">生成演示签到</button>
          <a class="button-link secondary" href="/api/export/checkins.xlsx">导出签到 Excel</a>
          <button id="resetAttendeesButton" class="danger">清空签到</button>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th style="width:64px;">序号</th>
              <th style="width:58px;">头像</th>
              <th>姓名</th>
              <th>昵称</th>
              <th>单位</th>
              <th>手机号</th>
              <th>签到时间</th>
              <th style="width:92px;">操作</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="muted">暂无签到数据</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPrizePanel() {
  const prizeCards = state.prizes.map((prize) => {
    const winners = state.winners.filter((winner) => winner.prizeId === prize.id).length;
    return `
      <article class="prize-card" data-prize-card="${escapeHtml(prize.id)}">
        <div class="prize-thumb">${prize.imageUrl ? `<img src="${escapeHtml(prize.imageUrl)}" alt="" />` : '奖品'}</div>
        <div class="form-grid">
          <div class="grid-3">
            <label>奖项名称<input class="prize-name" value="${escapeHtml(prize.name)}" /></label>
            <label>总名额<input class="prize-quantity" type="number" min="1" value="${Number(prize.quantity || 1)}" /></label>
            <label>每次抽取<input class="prize-count" type="number" min="1" value="${Number(prize.drawCount || 1)}" /></label>
          </div>
          <div class="grid-2">
            <label>动画方式
              <select class="prize-animation">
                ${modeOption('orbit', '星环排列', prize.animation)}
                ${modeOption('sphere', '球形滚动', prize.animation)}
                ${modeOption('wall', '头像矩阵', prize.animation)}
                ${modeOption('text', '文字造型', prize.animation)}
              </select>
            </label>
            <label>奖品图片<input class="prize-image" type="file" accept="image/*" /></label>
          </div>
          <fieldset class="fixed-winner-editor" data-fixed-editor="${escapeHtml(prize.id)}">
            ${renderFixedWinnerEditor(prize)}
          </fieldset>
          <p class="muted">已抽出 ${winners} / ${Number(prize.quantity || 0)}</p>
          <div class="toolbar">
            <button data-save-prize="${escapeHtml(prize.id)}">保存奖项</button>
            <button class="danger" data-delete-prize="${escapeHtml(prize.id)}">删除奖项</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
  return `
    <section class="panel">
      <div class="panel-title"><h2>新增奖项</h2></div>
      <form id="newPrizeForm" class="form-grid">
        <div class="grid-3">
          <label>奖项名称<input name="name" placeholder="例如 一等奖" required /></label>
          <label>总名额<input name="quantity" type="number" min="1" value="1" /></label>
          <label>每次抽取<input name="drawCount" type="number" min="1" value="1" /></label>
        </div>
        <div class="grid-2">
          <label>动画方式
            <select name="animation">
              <option value="sphere">球形滚动</option>
              <option value="orbit">星环排列</option>
              <option value="wall">头像矩阵</option>
              <option value="text">文字造型</option>
            </select>
          </label>
          <label>奖品图片<input name="image" type="file" accept="image/*" /></label>
        </div>
        <div class="toolbar"><button type="submit">新增奖项</button></div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>奖项列表</h2></div>
      <div class="prize-list">${prizeCards || '<p class="muted">暂无奖项</p>'}</div>
    </section>
  `;
}

function renderFixedWinnerEditor(prize, selected = '') {
  const attendeeById = new Map(state.attendees.map((attendee) => [attendee.id, attendee]));
  const fixed = (prize.fixedWinnerIds || []).map((id) => attendeeById.get(id)).filter(Boolean);
  const fixedIds = new Set(fixed.map((attendee) => attendee.id));
  const candidates = state.attendees.filter((attendee) => !fixedIds.has(attendee.id));
  const busy = pendingFixedPrizes.has(prize.id);
  const chosen = candidates.some((attendee) => attendee.id === selected) ? selected : '';
  return `
    <legend>内定人员（${fixed.length}）</legend>
    <form class="fixed-winner-add">
      <select name="attendeeId" aria-label="待选签到人员" required ${!candidates.length || busy ? 'disabled' : ''}>
        <option value="" disabled ${chosen ? '' : 'selected'}>${candidates.length ? '选择签到人员' : '暂无可添加人员'}</option>
        ${candidates.map((attendee) => {
          const detail = attendee.company || attendee.phone || formatTime(attendee.checkedInAt);
          const label = detail ? `${attendee.name} · ${detail}` : attendee.name;
          return `<option value="${escapeHtml(attendee.id)}" ${chosen === attendee.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')}
      </select>
      <button type="submit" class="secondary" ${!chosen || busy ? 'disabled' : ''}>${screenIcon('plus')}添加内定</button>
    </form>
    ${fixed.length ? `<ul class="fixed-winner-list" aria-label="已内定人员">${fixed.map((attendee) => `
      <li><span>${escapeHtml(attendee.name)}</span>
        <button type="button" class="secondary" data-remove-fixed="${escapeHtml(attendee.id)}"
          aria-label="取消 ${escapeHtml(attendee.name)} 的内定" ${busy ? 'disabled' : ''}>${screenIcon('x')}删除</button>
      </li>`).join('')}</ul>` : '<p class="muted fixed-winner-empty">暂无内定人员</p>'}
  `;
}

function syncPrizeEditors(previous) {
  const form = document.querySelector('#newPrizeForm');
  if (!form || JSON.stringify(previous.prizes.map(withoutFixedWinners)) !== JSON.stringify(state.prizes.map(withoutFixedWinners))
      || previous.winners.map((winner) => winner.id).join() !== state.winners.map((winner) => winner.id).join()) return false;
  const count = document.querySelector('#adminCheckinCount');
  if (count) count.textContent = state.attendees.length;
  document.querySelectorAll('[data-fixed-editor]').forEach((editor) => {
    const selected = editor.querySelector('select').value;
    refreshFixedWinnerEditor(editor, selected);
  });
  window.lucide?.createIcons();
  return true;
}

function withoutFixedWinners({ fixedWinnerIds, ...prize }) {
  return prize;
}

function refreshFixedWinnerEditor(editor, selected = '') {
  const prize = state.prizes.find((item) => item.id === editor.dataset.fixedEditor);
  if (prize) editor.innerHTML = renderFixedWinnerEditor(prize, selected);
}

async function changeFixedWinner(editor, attendeeId, add) {
  const id = editor.dataset.fixedEditor;
  if (!attendeeId || pendingFixedPrizes.has(id)) return;
  pendingFixedPrizes.add(id);
  refreshFixedWinnerEditor(editor, add ? attendeeId : editor.querySelector('select').value);
  try {
    const endpoint = `/api/prizes/${encodeURIComponent(id)}/fixed-winners`;
    const result = add
      ? await api(endpoint, { method: 'POST', body: { attendeeId } })
      : await api(`${endpoint}/${encodeURIComponent(attendeeId)}`, { method: 'DELETE' });
    const prize = state.prizes.find((item) => item.id === id);
    if (prize) prize.fixedWinnerIds = result.fixedWinnerIds;
  } catch (error) {
    toast(error.message);
  } finally {
    pendingFixedPrizes.delete(id);
    const currentEditor = document.querySelector(`[data-fixed-editor="${CSS.escape(id)}"]`);
    if (currentEditor) refreshFixedWinnerEditor(currentEditor, currentEditor.querySelector('select').value);
    window.lucide?.createIcons();
  }
}

function renderSettingsUnlockPanel() {
  return `<section class="panel">
    <div class="panel-title"><h2>大屏设置</h2></div>
    <form id="settingsUnlockForm" class="form-grid settings-unlock-form">
      <label>大屏设置密码<input name="settingsPassword" type="password" autocomplete="current-password" required /></label>
      <div class="toolbar"><button type="submit">${screenIcon('lock-keyhole-open')}解锁设置</button></div>
      <div id="settingsUnlockError" class="error-text" role="alert"></div>
    </form>
  </section>`;
}

async function unlockSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const error = form.querySelector('#settingsUnlockError');
  button.disabled = true;
  error.textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { role: 'settings', password: form.elements.settingsPassword.value } });
    await refreshState();
    if (window.location.pathname === '/admin' && activeAdminTab === 'settings') renderAdmin();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function modeOption(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
}

function renderSettingsPanel() {
  const config = state.config || {};
  return `
    <section class="panel">
      <div class="panel-title">
        <h2>大屏设置</h2>
        <button type="button" class="secondary" id="lockSettingsButton">${screenIcon('lock-keyhole')}锁定设置</button>
      </div>
      <form id="settingsForm" class="form-grid">
        <div class="grid-2">
          <label>活动标题<input name="eventTitle" value="${escapeHtml(config.eventTitle || '')}" /></label>
          <label>副标题<input name="subtitle" value="${escapeHtml(config.subtitle || '')}" /></label>
        </div>
        ${state.deployment === 'public' ? '' : `<label>签到方式
          <select name="checkinMode" aria-label="签到方式">
            ${modeOption('local', '内网填写姓名与头像', config.checkinMode || 'local')}
            ${modeOption('wechat', '微信网页授权', config.checkinMode)}
          </select>
        </label>`}
        <div class="grid-3">
          <label>头像墙模式
            <select name="wallMode">
              ${modeOption('orbit', '星环排列', config.wallMode)}
              ${modeOption('sphere', '球形滚动', config.wallMode)}
              ${modeOption('wall', '头像矩阵', config.wallMode)}
              ${modeOption('text', '文字造型', config.wallMode)}
            </select>
          </label>
          <label>文字造型<input name="wallText" maxlength="16" value="${escapeHtml(config.wallText || 'LUCKY')}" /></label>
          <label>主题
            <select name="theme">
              <option value="celebration" ${config.theme === 'celebration' ? 'selected' : ''}>庆典红金</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>上传 Logo<input name="logo" type="file" accept="image/*" /></label>
          <label>上传背景音乐<input name="music" type="file" accept="audio/*" /></label>
        </div>
        <fieldset class="settings-layout">
          <legend>大屏布局</legend>
          <div class="grid-2">
            <label>Logo 左边距（px）<input name="logoX" type="number" min="0" max="3000" value="${Number(config.logoPosition?.x ?? 32)}" required /></label>
            <label>Logo 上边距（px）<input name="logoY" type="number" min="0" max="3000" value="${Number(config.logoPosition?.y ?? 24)}" required /></label>
          </div>
          <div class="grid-3">
            <label>二维码左边距（px）<input name="qrX" type="number" min="0" max="3000" value="${Number(config.qrPosition?.x ?? 1120)}" required /></label>
            <label>二维码上边距（px）<input name="qrY" type="number" min="0" max="3000" value="${Number(config.qrPosition?.y ?? 28)}" required /></label>
            <label>二维码大小（px）<input name="qrSize" type="number" min="88" max="480" value="${Number(config.qrSize ?? 106)}" required /></label>
          </div>
        </fieldset>
        <label>单位下拉预设
          <textarea name="companies">${escapeHtml((config.companies || []).join('\n'))}</textarea>
        </label>
        ${state.deployment === 'public' || !hasRole('admin') ? '' : `<div class="grid-2">
          <label>后台新密码<input name="adminPassword" type="password" autocomplete="new-password" /></label>
          <label>大屏新密码<input name="screenPassword" type="password" autocomplete="new-password" /></label>
        </div>`}
        <label style="display:flex;align-items:center;gap:10px;">
          <input name="allowRepeatWinners" type="checkbox" style="width:18px;min-height:18px;" ${config.allowRepeatWinners ? 'checked' : ''} />
          允许同一人员重复中奖
        </label>
        <div class="toolbar"><button type="submit">保存设置</button></div>
        <div id="settingsError" class="error-text" role="alert"></div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>签到二维码</h2></div>
      <div class="grid-2">
        <div><img src="/api/qrcode.svg?target=${encodeURIComponent(state.checkinUrl || `${location.origin}/checkin`)}" alt="签到二维码" style="width:220px;height:220px;background:#fff;padding:10px;border-radius:8px;" /></div>
        <label>签到链接<input readonly value="${escapeHtml(state.checkinUrl || '')}" /></label>
      </div>
    </section>
  `;
}

function renderExportPanel() {
  const rows = state.winners.slice().reverse().map((winner) => `
    <tr>
      <td>${escapeHtml(winner.prizeName)}</td>
      <td>${escapeHtml(winner.name)}</td>
      <td>${escapeHtml(winner.company)}</td>
      <td>${escapeHtml(winner.phone)}</td>
      <td>${winner.fixed ? '是' : '否'}</td>
      <td>${escapeHtml(formatTime(winner.drawnAt))}</td>
      <td><button class="secondary" data-delete-winner="${escapeHtml(winner.id)}">删除</button></td>
    </tr>
  `).join('');
  return `
    <section class="panel">
      <div class="panel-title">
        <h2>数据导出</h2>
        <div class="toolbar">
          <a class="button-link secondary" href="/api/export/checkins.xlsx">导出签到 Excel</a>
          <a class="button-link secondary" href="/api/export/winners.xlsx">导出中奖 Excel</a>
          <button id="resetWinnersButton" class="danger">清空中奖</button>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>奖项</th>
              <th>姓名</th>
              <th>单位</th>
              <th>手机号</th>
              <th>内定</th>
              <th>中奖时间</th>
              <th style="width:92px;">操作</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted">暂无中奖数据</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function bindAdminEvents() {
  document.querySelector('#settingsUnlockForm')?.addEventListener('submit', unlockSettings);
  document.querySelector('#settingsForm')?.addEventListener('submit', saveSettings);
  document.querySelector('#lockSettingsButton')?.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST', body: { role: 'settings' } });
      state.hasSettingsAccess = false;
      if (window.location.pathname === '/admin' && activeAdminTab === 'settings') renderAdmin();
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('#toggleCheckinButton')?.addEventListener('click', async () => {
    if (pendingCheckinStatus) return;
    pendingCheckinStatus = true;
    document.querySelector('#toggleCheckinButton').disabled = true;
    try {
      const saved = await api('/api/checkin/status', { method: 'PUT', body: { checkinEnabled: state.config.checkinEnabled === false } });
      state.config = { ...state.config, ...saved };
    } catch (error) {
      toast(error.message);
    } finally {
      pendingCheckinStatus = false;
      if (location.pathname === '/admin') renderAdmin();
    }
  });
  const panel = document.querySelector('#adminPanel');
  panel?.addEventListener('change', (event) => {
    const form = event.target.closest('.fixed-winner-add');
    if (form) form.querySelector('button').disabled = !event.target.value;
  });
  panel?.addEventListener('submit', (event) => {
    if (!event.target.matches('.fixed-winner-add')) return;
    event.preventDefault();
    const editor = event.target.closest('[data-fixed-editor]');
    changeFixedWinner(editor, event.target.querySelector('select').value, true);
  });
  panel?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-fixed]');
    if (button) changeFixedWinner(button.closest('[data-fixed-editor]'), button.dataset.removeFixed, false);
  });
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      activeAdminTab = button.dataset.tab;
      renderAdmin();
    });
  });
  document.querySelector('#seedDemoButton')?.addEventListener('click', async () => {
    const result = await api('/api/demo/seed', { method: 'POST' });
    toast(`已生成 ${result.count} 位演示签到`);
  });
  document.querySelector('#resetAttendeesButton')?.addEventListener('click', async () => {
    if (!confirm('确认清空签到和中奖数据？')) return;
    await api('/api/reset', { method: 'POST', body: { scope: 'attendees' } });
  });
  document.querySelector('#resetWinnersButton')?.addEventListener('click', async () => {
    if (!confirm('确认清空中奖数据？')) return;
    await api('/api/reset', { method: 'POST', body: { scope: 'winners' } });
  });
  document.querySelectorAll('[data-delete-attendee]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('删除该签到人员？')) return;
      await api(`/api/attendees/${button.dataset.deleteAttendee}`, { method: 'DELETE' });
    });
  });
  document.querySelectorAll('[data-delete-winner]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/winners/${button.dataset.deleteWinner}`, { method: 'DELETE' });
    });
  });
  document.querySelector('#newPrizeForm')?.addEventListener('submit', saveNewPrize);
  document.querySelectorAll('[data-save-prize]').forEach((button) => {
    button.addEventListener('click', () => savePrize(button.dataset.savePrize));
  });
  document.querySelectorAll('[data-delete-prize]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('删除该奖项及相关中奖记录？')) return;
      await api(`/api/prizes/${button.dataset.deletePrize}`, { method: 'DELETE' });
    });
  });
}

async function saveNewPrize(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const imageFile = form.get('image');
  let imageUrl = '';
  if (imageFile && imageFile.size) {
    const uploaded = await uploadFile(imageFile, 'prize');
    imageUrl = uploaded.url;
  }
  await api('/api/prizes', {
    method: 'POST',
    body: {
      name: form.get('name'),
      quantity: form.get('quantity'),
      drawCount: form.get('drawCount'),
      animation: form.get('animation'),
      imageUrl
    }
  });
  toast('奖项已新增');
}

async function savePrize(id) {
  const card = document.querySelector(`[data-prize-card="${CSS.escape(id)}"]`);
  const file = card.querySelector('.prize-image').files[0];
  const current = state.prizes.find((item) => item.id === id);
  let imageUrl = current?.imageUrl || '';
  if (file) {
    const uploaded = await uploadFile(file, 'prize');
    imageUrl = uploaded.url;
  }
  await api(`/api/prizes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: {
      name: card.querySelector('.prize-name').value,
      quantity: card.querySelector('.prize-quantity').value,
      drawCount: card.querySelector('.prize-count').value,
      animation: card.querySelector('.prize-animation').value,
      imageUrl
    }
  });
  toast('奖项已保存');
}

async function saveSettings(event) {
  event.preventDefault();
  const settings = event.currentTarget;
  const submit = settings.querySelector('button[type="submit"]');
  const error = settings.querySelector('#settingsError');
  if (submit.disabled) return;
  const form = new FormData(settings);
  submit.disabled = true;
  error.textContent = '';
  try {
    const logoFile = form.get('logo');
    const musicFile = form.get('music');
    const logoUrl = logoFile?.size ? (await uploadFile(logoFile, 'logo')).url : state.config.logoUrl || '';
    const musicUrl = musicFile?.size ? (await uploadFile(musicFile, 'music')).url : state.config.musicUrl || '';
    const body = {
      eventTitle: form.get('eventTitle'),
      subtitle: form.get('subtitle'),
      checkinMode: form.get('checkinMode'),
      wallMode: form.get('wallMode'),
      wallText: form.get('wallText'),
      theme: form.get('theme'),
      logoUrl,
      musicUrl,
      logoPosition: { x: Number(form.get('logoX')), y: Number(form.get('logoY')) },
      qrPosition: { x: Number(form.get('qrX')), y: Number(form.get('qrY')) },
      qrSize: Number(form.get('qrSize')),
      companies: String(form.get('companies') || '').split('\n').map((item) => item.trim()).filter(Boolean),
      allowRepeatWinners: form.get('allowRepeatWinners') === 'on'
    };
    if (form.get('adminPassword')) body.adminPassword = form.get('adminPassword');
    if (form.get('screenPassword')) body.screenPassword = form.get('screenPassword');
    const saved = await api('/api/config', { method: 'PUT', body });
    state.config = saved.config;
    settings.querySelectorAll('input[type="password"], input[type="file"]').forEach((input) => { input.value = ''; });
    toast('设置已保存');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  window.setTimeout(() => node.remove(), 2400);
}

function showScreenNotice(title, subtitle = '', detail = '') {
  document.querySelector('.screen-notice-mask')?.remove();
  const mask = document.createElement('div');
  mask.className = 'screen-notice-mask';
  mask.innerHTML = `
    <section class="screen-notice">
      <span>${escapeHtml(subtitle)}</span>
      <h2>${escapeHtml(title)}</h2>
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
      <button type="button" data-close-screen-notice>知道了</button>
    </section>
  `;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-close-screen-notice]').addEventListener('click', close);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  window.setTimeout(close, 3600);
}
