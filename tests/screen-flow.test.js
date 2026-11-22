import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/public/app.js'), 'utf8');

function browser(pathname = '/screen/lottery') {
  const app = { innerHTML: '' };
  const masks = [];
  const selectors = new Map([['#app', app]]);
  const events = new Map();
  const timers = [];
  const stopLabel = { textContent: '' };
  selectors.set('#screenPrize', { value: 'first', addEventListener() {} });
  selectors.set('#screenCount', { value: '2' });
  selectors.set('#drawStopButton', { querySelector: () => stopLabel, addEventListener() {} });
  selectors.set('#drawLiveStatus', { textContent: '' });
  selectors.set('#loginForm', { addEventListener() {} });
  const context = vm.createContext({
    document: {
      querySelector: (selector) => selectors.get(selector) || null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) }),
      body: { appendChild: (mask) => masks.push(mask) }
    },
    window: {
      location: { pathname },
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener() {},
      requestAnimationFrame() {},
      setInterval: (fn) => timers.push(fn),
      clearInterval() {}
    },
    performance: { now: () => 2500 },
    io: () => ({ on: (event, callback) => events.set(event, callback) }),
    CSS: { escape: (value) => value },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64')
  });
  vm.runInContext(source, context);
  vm.runInContext(`state = {
    accessRole: 'screen',
    config: {},
    attendees: [{ id: 'a', name: '嘉宾甲' }, { id: 'b', name: '嘉宾乙' }, { id: 'c', name: '嘉宾丙' }],
    prizes: [
      { id: 'first', name: '一等奖', quantity: 3, drawCount: 2, animation: 'sphere' },
      { id: 'second', name: '二等奖', quantity: 5, drawCount: 1, animation: 'wall' },
      { id: 'third', name: '三等奖', quantity: 10, drawCount: 1, animation: 'orbit' }
    ],
    winners: [], checkinUrl: 'http://example.test/checkin'
  };`, context);
  return { context, app, masks, selectors, timers, events, run: (code) => vm.runInContext(code, context) };
}

test('check-in and lottery have independent display routes', () => {
  const checkin = browser('/screen/checkin');
  checkin.context.render();
  assert.match(checkin.app.innerHTML, /签到头像墙/);
  assert.match(checkin.app.innerHTML, /签到二维码/);
  assert.doesNotMatch(checkin.app.innerHTML, /id="drawButton"|id="prizeResults"/);
  assert.doesNotMatch(checkin.app.innerHTML, /shapeButton|backAdminButton|data-drag-key|qr-resize-handle|\/screen\/settings/);

  for (const route of ['/screen/lottery', '/screen']) {
    const lottery = browser(route);
    lottery.context.render();
    assert.match(lottery.app.innerHTML, /id="drawButton"/);
    assert.match(lottery.app.innerHTML, /id="prizeResults"/);
    assert.doesNotMatch(lottery.app.innerHTML, /签到二维码|最近签到/);
    assert.doesNotMatch(lottery.app.innerHTML, /backAdminButton|data-drag-key|\/screen\/settings/);
  }
});

test('the separate settings route requires its own session', () => {
  const ui = browser('/screen/settings');
  ui.run(`state.loginDefaults = { admin: true };`);
  ui.context.render();
  assert.match(ui.app.innerHTML, /进入大屏设置/);
  assert.doesNotMatch(ui.app.innerHTML, /id="settingsForm"|value="admin123"|data-role="screen"/);
  ui.selectors.set('#settingsForm', { addEventListener() {} });
  ui.run(`state.accessRole = 'admin';`);
  ui.context.render();
  assert.match(ui.app.innerHTML, /大屏设置密码/);
  assert.doesNotMatch(ui.app.innerHTML, /id="settingsForm"/);
  ui.run(`state.accessRole = null; state.hasSettingsAccess = true;`);
  ui.context.render();
  assert.match(ui.app.innerHTML, /id="settingsForm"/);
  assert.match(ui.app.innerHTML, /name="qrSize"/);
  assert.match(ui.app.innerHTML, /name="logoX"/);
  assert.match(ui.app.innerHTML, /退出设置/);
  assert.doesNotMatch(ui.app.innerHTML, /name="adminPassword"/);
});

test('only new arrivals animate, both in the live check-in list and the admin table', () => {
  const live = browser('/screen/checkin');
  live.context.render();
  assert.doesNotMatch(live.app.innerHTML, /checkin-arrival/);
  live.context.connectSocket();
  const next = live.run(`({ ...state, attendees: [...state.attendees, { id: 'new', name: '新签到来宾' }] })`);
  live.events.get('state')(next);
  assert.match(live.app.innerHTML, /recent-checkin-item checkin-arrival" data-checkin-id="new"/);
  assert.equal((live.app.innerHTML.match(/checkin-arrival/g) || []).length, 1);
  live.events.get('state')(next);
  assert.doesNotMatch(live.app.innerHTML, /checkin-arrival/);
  const admin = browser('/admin');
  admin.run(`state.accessRole = 'admin';`);
  admin.context.connectSocket();
  admin.events.get('state')({ ...next, accessRole: 'admin' });
  assert.match(admin.app.innerHTML, /<tr class="checkin-arrival" data-checkin-id="new"/);
});

test('the check-in sphere projects rotating avatars with depth', () => {
  const ui = browser('/screen/checkin');
  const sphere = ui.context.spatialAvatarPoints(18, 'sphere');
  assert.equal(sphere.length, 18);
  assert.ok(sphere.every(({ x, y, z }) => Math.abs(Math.hypot(x, y, z) - 1) < 1e-10));
  const point = { x: 1, y: 0, z: 0 };
  const side = ui.context.projectAvatarPoint(point, 0, 1);
  const front = ui.context.projectAvatarPoint(point, -1, 0);
  const back = ui.context.projectAvatarPoint(point, 1, 0);
  assert.notEqual(side.x, front.x);
  assert.ok(front.scale > back.scale);
  assert.ok(front.opacity > back.opacity);
  assert.ok(front.depth > back.depth);
  assert.ok(front.scale > 1.5 && back.scale < 0.8);
});

test('a spherical draw uses the selected prize animation instead of the check-in wall layout', () => {
  const ui = browser();
  const classes = new Set();
  const stage = {
    clientWidth: 1440,
    clientHeight: 900,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    },
    style: { setProperty() {} },
    querySelectorAll: () => []
  };
  ui.selectors.set('#avatarStage', stage);
  ui.run("state.config.wallMode = 'wall'; drawState.rolling = true;");
  ui.context.paintAvatarStage();
  assert.ok(classes.has('sphere'));
  assert.ok(classes.has('is-spatial'));
  assert.match(stage.innerHTML, /data-attendee-id="a"/);
  const highlighted = new Set();
  ui.selectors.set('[data-attendee-id="a"]', { classList: { add: (name) => highlighted.add(name) } });
  ui.context.highlightRollingCandidate({ id: 'a' });
  assert.deepEqual([...highlighted], ['draw-hot']);
});

test('the preset editor separates an empty selection from saved names', () => {
  const ui = browser('/admin');
  const empty = ui.run('renderFixedWinnerEditor(state.prizes[0])');
  assert.match(empty, /内定人员（0）/);
  assert.match(empty, /value="" disabled selected/);
  assert.match(empty, /暂无内定人员/);
  assert.match(empty, /添加内定/);
  assert.doesNotMatch(empty, /data-remove-fixed/);
  ui.run(`state.prizes[0].fixedWinnerIds = ['a'];`);
  const saved = ui.run('renderFixedWinnerEditor(state.prizes[0])');
  assert.match(saved, /内定人员（1）/);
  assert.match(saved, /data-remove-fixed="a"/);
  assert.match(saved, /删除<\/button>/);
  assert.doesNotMatch(saved, /<option value="a"/);
});

test('results and expanded list include only the selected prize', () => {
  const ui = browser();
  ui.run(`state.winners = state.prizes.map((prize, index) => ({
    id: 'winner-' + index, attendeeId: 'guest-' + index, prizeId: prize.id, name: '专属嘉宾' + index
  }));`);
  for (const [index, id] of ['first', 'second', 'third'].entries()) {
    ui.run(`screenUiState.selectedPrizeId = '${id}'`);
    const html = ui.run(`renderPrizeResults(getSelectedScreenPrize())`);
    assert.match(html, new RegExp(`专属嘉宾${index}`));
    for (const other of [0, 1, 2].filter((value) => value !== index)) {
      assert.doesNotMatch(html, new RegExp(`专属嘉宾${other}`));
    }
    ui.context.showWinnerBookModal();
    const book = ui.masks.at(-1).innerHTML;
    assert.match(book, new RegExp(`专属嘉宾${index}`));
    assert.doesNotMatch(book, /完整中奖名单/);
    assert.equal((book.match(/class="winner-book-item"/g) || []).length, 1);
  }
});

test('starting only animates; stop draws once using the frozen prize and count', async () => {
  const ui = browser();
  const calls = [];
  let finish;
  ui.context.api = (url, options) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(options.body)) });
    return new Promise((resolve) => { finish = resolve; });
  };
  ui.context.startDraw();
  ui.context.startDraw();
  assert.equal(calls.length, 0);
  assert.equal(ui.timers.length, 1);
  assert.equal(ui.run('drawState.rolling'), true);
  assert.equal(ui.run('state.winners.length'), 0);

  ui.selectors.get('#screenPrize').value = 'second';
  ui.selectors.get('#screenCount').value = '5';
  const stopping = ui.context.stopDraw();
  await ui.context.stopDraw();
  assert.deepEqual(calls, [{ url: '/api/draw', body: { prizeId: 'first', count: 2 } }]);
  assert.equal(ui.run('drawState.rolling && drawState.stopping'), true);
  const winners = [{ id: 'new-winner', prizeId: 'first', attendeeId: 'a', name: '嘉宾甲' }];
  ui.context.incoming = winners;
  ui.run('state.winners = [...incoming]');
  finish({ prize: { id: 'first', name: '一等奖' }, winners });
  await stopping;
  assert.equal(ui.run('drawState.rolling || drawState.stopping'), false);
  assert.equal(ui.run('state.winners.length'), 1);
  assert.equal(ui.run('screenUiState.selectedPrizeId'), 'first');
  assert.match(ui.app.innerHTML, /data-winner-id="new-winner"/);
  assert.match(ui.masks[0].innerHTML, /返回抽奖结果/);
});

test('HTTP results persist locally even when the socket has not delivered them yet', async () => {
  const ui = browser();
  ui.context.api = async () => ({
    prize: { id: 'first', name: '一等奖' },
    winners: [{ id: 'winner-http', prizeId: 'first', attendeeId: 'a', name: '嘉宾甲' }]
  });
  ui.context.startDraw();
  await ui.context.stopDraw();
  assert.equal(ui.run('state.winners.length'), 1);
  assert.match(ui.app.innerHTML, /data-winner-id="winner-http"/);
  ui.context.cycleScreenPrize(1);
  assert.doesNotMatch(ui.app.innerHTML, /data-winner-id="winner-http"/);
  ui.context.cycleScreenPrize(-1);
  assert.match(ui.app.innerHTML, /data-winner-id="winner-http"/);
});

test('a failed draw unlocks the page without adding a winner', async () => {
  const ui = browser();
  let message;
  ui.context.toast = (text) => { message = text; };
  ui.context.api = async () => { throw new Error('没有可抽取的签到人员'); };
  ui.context.startDraw();
  await ui.context.stopDraw();
  assert.equal(ui.run('drawState.rolling || drawState.stopping'), false);
  assert.equal(ui.run('state.winners.length'), 0);
  assert.equal(message, '没有可抽取的签到人员');
  assert.match(ui.app.innerHTML, /id="drawButton"/);
});

test('exhausted prizes cannot start another draw', () => {
  const ui = browser();
  ui.run(`state.winners = [1, 2, 3].map(id => ({ id, prizeId: 'first' }));`);
  let notice;
  ui.context.showScreenNotice = (text) => { notice = text; };
  ui.context.startDraw();
  assert.equal(notice, '该奖项已全部发放');
  assert.equal(ui.run('drawState.rolling'), false);
  ui.context.renderScreen();
  assert.match(ui.app.innerHTML, /本奖项已抽完/);
});

test('previous winners are excluded from the animation candidate pool', () => {
  const ui = browser();
  ui.run(`state.winners = [{ attendeeId: 'a', prizeId: 'second' }];`);
  assert.equal(ui.run('availableCandidates().length'), 2);
  ui.run('state.config.allowRepeatWinners = true');
  assert.equal(ui.run('availableCandidates().length'), 3);
});

test('empty data renders useful page states', () => {
  const ui = browser();
  ui.run('state.prizes = []; state.attendees = [];');
  ui.context.renderScreen();
  assert.match(ui.app.innerHTML, /暂无奖项/);
  assert.match(ui.app.innerHTML, /id="drawButton" disabled/);
  ui.context.renderCheckinScreen();
  assert.match(ui.app.innerHTML, /等待嘉宾入场/);
});
