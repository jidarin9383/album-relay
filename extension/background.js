// Album Relay extension worker.
// A: pages opened by the user are forwarded to Album Relay (content.js -> here -> /api/ext/capture).
// B: an optional, server-configured daily refresh opens a few chart pages in background tabs.
//    It stops at the first verification challenge and leaves that tab for the user; it never solves challenges.

const VERSION = chrome.runtime.getManifest().version;
const TICK_MINUTES = 30;
const PAGE_TIMEOUT_MS = 2 * 60 * 1000;
const GAP_MIN_MS = 30 * 1000;
const GAP_MAX_MS = 75 * 1000;
const START_JITTER_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [3000, 8000, 15000];
const RECENT_LIMIT = 20;

const BADGE = {
  sending: { text: '…', color: '#6b7280' },
  ok: { text: '✓', color: '#16a34a' },
  skipped: { text: '✓', color: '#6b7280' },
  challenge: { text: '!', color: '#d97706' },
  error: { text: '✗', color: '#dc2626' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
const random = (min, max) => Math.round(min + Math.random() * (max - min));
const sourceOf = (url) => {
  const host = new URL(url).hostname;
  return host.endsWith('rateyourmusic.com') ? 'rym' : host.endsWith('albumoftheyear.org') ? 'aoty' : 'pitchfork';
};

async function badge(state, tabId) {
  const b = BADGE[state];
  const target = tabId === undefined ? {} : { tabId };
  try {
    await chrome.action.setBadgeText({ ...target, text: b.text });
    await chrome.action.setBadgeBackgroundColor({ ...target, color: b.color });
  } catch {
    // Tab was closed meanwhile.
  }
}

async function remember(entry) {
  const { recent = [] } = await chrome.storage.local.get('recent');
  await chrome.storage.local.set({ recent: [{ ...entry, at: new Date().toISOString() }, ...recent].slice(0, RECENT_LIMIT) });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, init = {}) {
  const { server, token } = await chrome.storage.local.get(['server', 'token']);
  if (!server || !token) throw new ApiError(0, '扩展尚未配置 Album Relay 地址和配对令牌');
  let response;
  try {
    response = await fetch(server + path, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, 'x-album-relay-extension': VERSION }
    });
  } catch {
    throw new ApiError(0, `无法连接 Album Relay（${server}）`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error || `HTTP ${response.status}`);
  return body;
}

// ---------- A: forward pages ----------

async function submitPage(url, html) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api('/api/ext/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, html })
      });
    } catch (e) {
      // 409: Album Relay is running another job and holds the library lock.
      if (e instanceof ApiError && e.status === 409 && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw e;
    }
  }
}

async function handlePage(tabId, url, html) {
  await badge('sending', tabId);
  try {
    const result = await submitPage(url, html);
    if (result.status === 'skipped') {
      await badge('skipped', tabId);
      await remember({ url, state: 'skipped', message: '30 分钟内已收录过，跳过' });
      return 'ok';
    }
    const r = result.receipt;
    await badge('ok', tabId);
    await remember({ url, state: 'ok', message: `${r.albums.length} 条评分证据，新增 ${r.added}、更新 ${r.updated}` });
    return 'ok';
  } catch (e) {
    const challenge = e instanceof ApiError && e.status === 422 && /验证/.test(e.message);
    await badge(challenge ? 'challenge' : 'error', tabId);
    await remember({ url, state: challenge ? 'challenge' : 'error', message: e.message });
    return challenge ? 'challenge' : 'error';
  }
}

async function handleChallenge(tabId, url) {
  await badge('challenge', tabId);
  await remember({ url, state: 'challenge', message: '页面需要验证，请在这个标签页里手动完成' });
  await api('/api/ext/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: sourceOf(url), state: 'challenge', message: '浏览器扩展遇到验证页，请在 Chrome 中打开该页面手动完成一次', url })
  }).catch(() => {});
  return 'challenge';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'page' && tabId !== undefined) {
    handlePage(tabId, message.url, message.html).then((state) => onTabResult(tabId, state, message.url));
  } else if (message?.type === 'challenge' && tabId !== undefined) {
    handleChallenge(tabId, message.url).then((state) => onTabResult(tabId, state, message.url));
  } else if (message?.type === 'run-now') {
    startRun(true).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  } else if (message?.type === 'backfill-now') {
    startRun(true, null, { backfillOnly: true }).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  } else if (message?.type === 'tick-now') {
    tick().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  return false;
});

// ---------- B: scheduled refresh (state machine driven by alarms; the worker may be unloaded between steps) ----------

function buildQueue(config, backfillOnly = false) {
  const list = [];
  if (!backfillOnly && Array.isArray(config?.refresh?.targets)) {
    list.push(...config.refresh.targets);
  }
  if (config?.detailBackfill?.enabled && Array.isArray(config.detailBackfill.targets)) {
    list.push(...config.detailBackfill.targets);
  }
  return [...new Set(list)];
}

async function getRun() {
  return (await chrome.storage.local.get('run')).run || null;
}
async function setRun(run) {
  await chrome.storage.local.set({ run });
}

async function tick() {
  let config;
  try {
    config = await api('/api/ext/config');
    await chrome.storage.local.set({ config, lastContact: new Date().toISOString(), lastError: null });
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message });
    return;
  }
  const refresh = config.refresh;
  const queue = buildQueue(config, false);
  const { lastRunDate } = await chrome.storage.local.get('lastRunDate');
  const run = await getRun();
  if (!refresh.enabled || !queue.length) return;
  if (run && ['scheduled', 'running'].includes(run.status)) return;
  if (lastRunDate === today() || new Date().getHours() < refresh.hour) return;
  await startRun(false, queue);
}

async function startRun(manual, targets, opts = {}) {
  const current = await getRun();
  if (current && ['scheduled', 'running'].includes(current.status)) return { error: '定时刷新正在进行' };
  const backfillOnly = Boolean(opts.backfillOnly);
  if (!targets) {
    const config = await api('/api/ext/config');
    await chrome.storage.local.set({ config, lastContact: new Date().toISOString(), lastError: null });
    targets = buildQueue(config, backfillOnly);
  }
  if (!targets.length) {
    return { error: backfillOnly ? '当前没有需要补抓的已入选专辑详情页（或尚未开启详情页补抓开关）' : '没有配置要刷新的页面' };
  }
  // Mark the day first so an interrupted scheduled run is not retried every tick.
  if (!backfillOnly) {
    await chrome.storage.local.set({ lastRunDate: today() });
  }
  const delay = manual ? 0 : random(0, START_JITTER_MS);
  await setRun({ status: 'scheduled', manual, queue: targets, index: 0, tabId: null, startedAt: new Date().toISOString(), results: [] });
  await chrome.alarms.create('run-step', { when: Date.now() + Math.max(delay, 1000) });
  return { ok: true };
}

async function step() {
  const run = await getRun();
  if (!run || !['scheduled', 'running'].includes(run.status)) return;
  if (run.index >= run.queue.length) {
    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    await setRun(run);
    return;
  }
  const tab = await chrome.tabs.create({ url: run.queue[run.index], active: false });
  run.status = 'running';
  run.tabId = tab.id;
  await setRun(run);
  await chrome.alarms.create('run-timeout', { when: Date.now() + PAGE_TIMEOUT_MS });
}

async function onTabResult(tabId, state, url) {
  const run = await getRun();
  if (!run || run.status !== 'running' || run.tabId !== tabId) return;
  await chrome.alarms.clear('run-timeout');
  run.results.push({ url: url || run.queue[run.index], state });
  if (state === 'challenge') {
    // Leave the tab open so the user can pass the check themselves.
    run.status = 'challenge';
    run.finishedAt = new Date().toISOString();
    run.tabId = null;
    await setRun(run);
    await badge('challenge');
    return;
  }
  run.index += 1;
  run.tabId = null;
  await setRun(run);
  await chrome.tabs.remove(tabId).catch(() => {});
  await chrome.alarms.create('run-step', { when: Date.now() + random(GAP_MIN_MS, GAP_MAX_MS) });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tick') await tick();
  else if (alarm.name === 'run-step') await step();
  else if (alarm.name === 'run-timeout') {
    const run = await getRun();
    if (run?.status === 'running' && run.tabId !== null) {
      await remember({ url: run.queue[run.index], state: 'error', message: '页面在 2 分钟内没有完成加载，已跳过' });
      await onTabResult(run.tabId, 'error');
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const run = await getRun();
  if (run?.status === 'running' && run.tabId === tabId) await onTabResult(tabId, 'error');
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function ensureTick() {
  if (!(await chrome.alarms.get('tick'))) await chrome.alarms.create('tick', { periodInMinutes: TICK_MINUTES, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(ensureTick);
chrome.runtime.onStartup.addListener(ensureTick);
