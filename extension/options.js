const $ = (id) => document.getElementById(id);
const STATE = { ok: '已收录', skipped: '已跳过', challenge: '需要验证', error: '失败' };
const RUN = { scheduled: '已排队，即将开始', running: '进行中', done: '已完成', challenge: '遇到验证，已暂停（请在留下的标签页里手动完成）' };
const time = (at) => (at ? new Date(at).toLocaleString('zh-CN') : '—');

function show(text, cls) {
  const box = $('connection');
  box.hidden = false;
  box.className = `status ${cls}`;
  box.textContent = text;
}

async function render() {
  const s = await chrome.storage.local.get(['server', 'token', 'config', 'run', 'recent', 'lastContact', 'lastError', 'lastRunDate']);
  if (document.activeElement !== $('server')) $('server').value = s.server || '';
  if (document.activeElement !== $('token')) $('token').value = s.token || '';
  const refresh = s.config?.refresh;
  const backfill = s.config?.detailBackfill;
  const rows = [
    ['巡检状态', refresh ? (refresh.enabled ? `已开启，每天 ${refresh.hour}:00 后执行` : '未开启') : '尚未读取新声簿配置'],
    ['巡检页面', refresh?.targets?.length ? refresh.targets.join('\n') : '—'],
    ['详情补抓', backfill?.enabled ? `已开启（每批 ${backfill.batchSize} 页 · 待补 ${backfill.pendingCount ?? 0} 个链接）` : '未开启'],
    ['上次巡检', s.run ? `${time(s.run.startedAt)} · ${RUN[s.run.status] || s.run.status}` : '—'],
    ['最近联系', s.lastError ? `${time(s.lastContact)}（失败：${s.lastError}）` : time(s.lastContact)]
  ];
  $('refresh').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; dd.style.whiteSpace = 'pre-wrap'; dd.style.margin = '0';
    return [dt, dd];
  }));
  const recent = s.recent || [];
  if (recent.length) {
    $('recent').replaceChildren(...recent.map((r) => {
      const li = document.createElement('li');
      const tag = document.createElement('strong'); tag.className = r.state; tag.textContent = STATE[r.state] || r.state;
      const meta = document.createElement('small'); meta.textContent = ` ${time(r.at)} · ${r.message}`;
      const url = document.createElement('div'); url.className = 'muted'; url.textContent = r.url;
      li.append(tag, meta, url);
      return li;
    }));
  }
}

$('save').addEventListener('click', async () => {
  let origin;
  try {
    const url = new URL($('server').value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    origin = url.origin;
  } catch {
    show('地址格式不对，示例：http://192.168.1.10:3210', 'error');
    return;
  }
  const token = $('token').value.trim();
  if (!/^ar_[A-Za-z0-9_-]{20,100}$/.test(token)) {
    show('配对令牌格式不对，请从 Album Relay 复制完整令牌', 'error');
    return;
  }
  // Only the configured Album Relay origin is granted, not every site.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    show('需要允许扩展访问这个 Album Relay 地址才能发送页面', 'error');
    return;
  }
  await chrome.storage.local.set({ server: origin, token });
  const result = await chrome.runtime.sendMessage({ type: 'tick-now' });
  const { lastError } = await chrome.storage.local.get('lastError');
  if (result?.error || lastError) show(`连接失败：${result?.error || lastError}`, 'error');
  else show('已连接。之后打开支持的页面将自动收录，图标会显示 ✓ / ! / ✗。', 'ok');
  await render();
});

$('run').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'run-now' });
  if (result?.error) show(result.error, 'error');
  else show('已开始巡检：将在后台逐页打开配置页面，每页间隔 30–75 秒。', 'ok');
  await render();
});

$('backfill').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'backfill-now' });
  if (result?.error) show(result.error, 'error');
  else show('已开始低频补抓入选专辑详情页（间隔 30–75 秒），遇验证即停。', 'ok');
  await render();
});

chrome.storage.onChanged.addListener(render);
render();
