// Listen Better extension worker.
// A: pages opened by the user are forwarded to Listen Better (content.js -> here -> /api/ext/capture).
// B: an optional, server-configured daily refresh opens a few chart pages in background tabs.
//    It stops at the first verification challenge and leaves that tab for the user; it never solves challenges.

const VERSION = chrome.runtime.getManifest().version;
const TICK_MINUTES = 30;
const PAGE_TIMEOUT_MS = 2 * 60 * 1000;
const GAP_MIN_MS = 30 * 1000;
const GAP_MAX_MS = 75 * 1000;
const START_JITTER_MS = 10 * 60 * 1000;
const AUTO_BACKFILL_COOLDOWN_MS = 25 * 60 * 1000;
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
  if (!server || !token) throw new ApiError(0, '扩展尚未配置「听点好的」地址和配对令牌');
  let response;
  try {
    response = await fetch(server + path, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, 'x-listen-better-extension': VERSION }
    });
  } catch {
    throw new ApiError(0, `无法连接「听点好的」（${server}）`);
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
      // 409: Listen Better is running another job and holds the library lock.
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
    await chrome.storage.local.remove('lastChallengeDate');
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

// ---------- B: scheduled refresh & detail-page relay ----------

async function fetchAndStoreConfig() {
  const config = await api('/api/ext/config');
  await chrome.storage.local.set({ config, lastContact: new Date().toISOString(), lastError: null });
  return config;
}

function uniqueUrls(list) {
  return [...new Set(Array.isArray(list) ? list : [])];
}

const STALE_RUN_GRACE_MS = 2 * 60 * 1000;

async function getRun() {
  return (await chrome.storage.local.get('run')).run || null;
}
async function setRun(run) {
  run.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ run });
}

async function getTargetWindowId() {
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!Array.isArray(wins) || !wins.length) return null;
    const focused = wins.find((w) => w.focused && typeof w.id === 'number');
    return focused?.id ?? wins.find((w) => typeof w.id === 'number')?.id ?? null;
  } catch {
    return null;
  }
}

async function isRunActivelyInFlight(run) {
  if (!run || !['scheduled', 'running'].includes(run.status)) return false;
  const [stepAlarm, timeoutAlarm] = await Promise.all([
    chrome.alarms.get('run-step'),
    chrome.alarms.get('run-timeout')
  ]);
  if (stepAlarm || timeoutAlarm) return true;
  const updatedMs = Date.parse(run.updatedAt || run.startedAt || '') || 0;
  if (updatedMs && Date.now() - updatedMs < STALE_RUN_GRACE_MS) return true;
  // Clear orphaned run left without alarms (e.g. after a service worker reload or closed-window failure).
  run.status = 'done';
  run.finishedAt = run.finishedAt || new Date().toISOString();
  run.tabId = null;
  await setRun(run);
  return false;
}

async function resumeWaitingRun() {
  const run = await getRun();
  if (!run || run.status !== 'waiting_window') return false;
  const windowId = await getTargetWindowId();
  if (windowId === null) return false;
  run.status = 'scheduled';
  run.tabId = null;
  await setRun(run);
  await chrome.alarms.create('run-step', { when: Date.now() + 2000 });
  return true;
}

async function tick() {
  let config;
  try {
    config = await fetchAndStoreConfig();
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message });
    return;
  }
  if (await resumeWaitingRun()) return;
  const run = await getRun();
  if (await isRunActivelyInFlight(run)) return;
  if ((await getTargetWindowId()) === null) return;

  const refresh = config.refresh || {};
  const chartTargets = uniqueUrls(refresh.targets);
  const backfill = config.detailBackfill || {};
  const backfillTargets = uniqueUrls(backfill.targets);
  const { lastRunDate, lastChallengeDate, lastAutoBackfillAt } = await chrome.storage.local.get([
    'lastRunDate',
    'lastChallengeDate',
    'lastAutoBackfillAt'
  ]);

  if (refresh.enabled && chartTargets.length && lastRunDate !== today() && new Date().getHours() >= refresh.hour) {
    await startRun(false, chartTargets, { backfillOnly: false });
    return;
  }

  if (
    backfill.enabled &&
    backfillTargets.length &&
    lastChallengeDate !== today() &&
    (!lastAutoBackfillAt || Date.now() - lastAutoBackfillAt >= AUTO_BACKFILL_COOLDOWN_MS)
  ) {
    await chrome.storage.local.set({ lastAutoBackfillAt: Date.now() });
    await startRun(false, backfillTargets, { backfillOnly: true, noJitter: true });
  }
}

async function startRun(manual, targets, opts = {}) {
  const current = await getRun();
  if (await isRunActivelyInFlight(current)) return { error: '定时刷新正在进行' };
  const backfillOnly = Boolean(opts.backfillOnly);
  if (manual) {
    await chrome.storage.local.remove('lastChallengeDate');
  }
  let phase = backfillOnly ? 'backfill' : 'charts';
  if (!targets) {
    const config = await fetchAndStoreConfig();
    if (backfillOnly) {
      targets = config?.detailBackfill?.enabled ? uniqueUrls(config.detailBackfill.targets) : [];
    } else {
      const charts = uniqueUrls(config?.refresh?.targets);
      if (charts.length) {
        targets = charts;
      } else if (config?.detailBackfill?.enabled) {
        phase = 'backfill';
        targets = uniqueUrls(config.detailBackfill.targets);
      } else {
        targets = [];
      }
    }
  } else {
    targets = uniqueUrls(targets);
  }
  if (!targets.length) {
    return { error: backfillOnly ? '当前没有需要补抓的已入选专辑详情页（或尚未开启详情页补抓开关）' : '没有配置要刷新的页面' };
  }
  // Mark the day first so an interrupted chart refresh is not retried every tick.
  if (!backfillOnly) {
    await chrome.storage.local.set({ lastRunDate: today() });
  }
  const delay = manual ? 0 : opts.noJitter ? random(3000, 15000) : random(0, START_JITTER_MS);
  await setRun({ status: 'scheduled', phase, manual, queue: targets, index: 0, tabId: null, startedAt: new Date().toISOString(), results: [] });
  await chrome.alarms.create('run-step', { when: Date.now() + Math.max(delay, 1000) });
  return { ok: true };
}

async function step() {
  const run = await getRun();
  if (!run || !['scheduled', 'running'].includes(run.status)) return;
  if (run.index >= run.queue.length) {
    if (run.phase === 'charts') {
      try {
        const config = await fetchAndStoreConfig();
        const extra = config?.detailBackfill?.enabled
          ? uniqueUrls(config.detailBackfill.targets).filter((u) => !run.queue.includes(u))
          : [];
        if (extra.length) {
          run.phase = 'backfill';
          run.queue.push(...extra);
          await setRun(run);
        }
      } catch {
        // Complete chart run cleanly if server config cannot be fetched right now.
      }
    }
    if (run.index >= run.queue.length) {
      await fetchAndStoreConfig().catch(() => {});
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      await setRun(run);
      return;
    }
  }
  const windowId = await getTargetWindowId();
  if (windowId === null) {
    run.status = 'waiting_window';
    run.tabId = null;
    await setRun(run);
    return;
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ windowId, url: run.queue[run.index], active: false });
  } catch {
    run.status = 'waiting_window';
    run.tabId = null;
    await setRun(run);
    return;
  }
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
    await chrome.storage.local.set({ lastChallengeDate: today() });
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

chrome.windows.onCreated.addListener(() => {
  void resumeWaitingRun();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function ensureTick() {
  if (!(await chrome.alarms.get('tick'))) await chrome.alarms.create('tick', { periodInMinutes: TICK_MINUTES, delayInMinutes: 1 });
  await resumeWaitingRun();
}
chrome.runtime.onInstalled.addListener(ensureTick);
chrome.runtime.onStartup.addListener(ensureTick);
