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
  const challenged = () =>
    /just a moment|verify you are human|checking your browser|attention required/i.test(document.title) ||
    // Interstitial markers only: Cloudflare also loads /cdn-cgi/challenge-platform scripts on normal pages.
    !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, .cf-browser-verification');

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
