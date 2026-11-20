// Runs on supported RYM / AOTY / Pitchfork pages after they load in the user's own Chrome.
// It never clicks, fills or solves anything: it only hands the rendered page to the extension worker.
(() => {
  const PAGES = {
    'https://rateyourmusic.com': [/^\/charts\/(top|popular|esoteric)\/album\//, /^\/release\/(?:album|ep|comp|single|mixtape|unauth|video|djmix|additional)\/[^/]+\/[^/]+\/?$/],
    'https://www.albumoftheyear.org': [/^\/ratings\/user-highest-rated\//, /^\/album\/\d+[^/]*\.php$/],
    'https://pitchfork.com': [/^\/reviews\/(?:best\/)?albums\/?$/, /^\/reviews\/albums\/[^/]+\/?$/]
  };
  if (!(PAGES[location.origin] || []).some((p) => p.test(location.pathname))) return;

  const QUIET_MS = 1200;
  const MAX_WAIT_MS = 8000;
  const INTERSTITIAL_SELECTOR =
    '#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, .cf-browser-verification, #challenge-error-text, #challenge-body-text, #cf-wrapper';
  const SITE_CONTENT_SELECTOR =
    '.page_charts_section_charts_item, .albumListRow, .album_title, h1.release_title, table.album_info, .albumTitle, .albumUserScore, [data-testid="ReviewPage"], main a[href^="/reviews/albums/"], article';
  const TURNSTILE_SELECTOR =
    '#turnstile-wrapper, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]';
  const CHALLENGE_TITLE_RE =
    /just a moment|verify you are human|checking your browser|attention required|请稍候|請稍候|请稍等|請稍等|正在检查您的浏览器|正在檢查您的瀏覽器|安全验证|安全驗證/i;
  const CHALLENGE_BODY_RE =
    /verify (?:you are|that you are) human|checking if the site connection is secure|performing security verification|complete the security check|ip address is temporarily blocked|too many requests|请验证您是真人|确认您是真人|验证您(?:是否)?是真人|正在验证您(?:是否)?是真人|請驗證您是真人|驗證您是人類|請確認您是真人|確認您是真人|正在检查您的浏览器|正在檢查您的瀏覽器|需要检查您的连接安全性|需要檢查您的連線安全性|安全验证|安全驗證/i;

  const hasSiteContent = () => !!document.querySelector(SITE_CONTENT_SELECTOR);
  const challenged = () => {
    // Interstitial markers only: Cloudflare also loads /cdn-cgi/challenge-platform scripts on normal pages.
    if (document.querySelector(INTERSTITIAL_SELECTOR)) return true;
    if (hasSiteContent()) return false;
    if (CHALLENGE_TITLE_RE.test((document.title || '').trim())) return true;
    if (document.querySelector(TURNSTILE_SELECTOR)) return true;
    return CHALLENGE_BODY_RE.test((document.body?.innerText || '').slice(0, 8000));
  };

  // Wait until the DOM stops changing (or a cap is reached) so lazily rendered rows are included.
  const settle = () =>
    new Promise((resolve) => {
      let timer = setTimeout(done, QUIET_MS);
      const cap = setTimeout(done, MAX_WAIT_MS);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, QUIET_MS);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      function done() {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve();
      }
    });

  settle().then(async () => {
    // Give an automatic (non-interactive) check time to pass; passing reloads the page and ends this script.
    for (let waited = 0; challenged() && waited < 20000; waited += 2000) await new Promise((r) => setTimeout(r, 2000));
    if (challenged()) {
      // Cloudflare reloads the page after the user passes, which re-runs this script.
      chrome.runtime.sendMessage({ type: 'challenge', url: location.href });
      return;
    }
    chrome.runtime.sendMessage({ type: 'page', url: location.href, html: document.documentElement.outerHTML });
  });
})();
