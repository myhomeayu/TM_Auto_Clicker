// ==UserScript==
// @name         TM Auto Clicker (gcp.giftee.biz + x.com)
// @namespace    https://example.local/
// @version      1.0.2
// @description  Auto click with debug + safety for gcp.giftee.biz and x.com OAuth2.
// @match        https://gcp.giftee.biz/*
// @match        https://x.com/*
// @match        https://present.social-camp.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// @updateURL    https://github.com/myhomeayu/TM_Auto_Clicker/raw/main/TM_Auto_Clicker.user.js
// @downloadURL  https://github.com/myhomeayu/TM_Auto_Clicker/raw/main/TM_Auto_Clicker.user.js

(() => {
  'use strict';

  // ==============================
  // Config
  // ==============================
  const DEBUG = true; // true: verbose, false: minimal logs

  const LOG_PREFIX = '[TM-AUTO]';

  // GCP
  const GCP_DELAY_MIN_MS = 9500;
  const GCP_DELAY_MAX_MS = 12000;
  const GCP_GUARD_PREFIX = 'tm_autoclick_gcp:';
  const GCP_RESULT_GUARD_PREFIX = 'tm_autoclick_gcp_result:';
  const GCP_RESULT_DELAY_MS = 1000;
  // GCP join retry/cooldown
  const GCP_JOIN_KEY_PREFIX = 'tm_autoclick_gcp_join:';
  const GCP_JOIN_DELAY_MS = 1000; // fixed 1s
  const GCP_JOIN_RETRY_COOLDOWN_MS = 7000; // 7s cooldown
  const GCP_JOIN_MAX_CLICKS_PER_PAGE = 5;
  // X fixed delay
  const X_FIXED_DELAY_MS = 1000;

  // X OAuth
  const X_DELAY_MIN_MS = 1800;
  const X_DELAY_MAX_MS = 2600;
  const X_GUARD_PREFIX = 'tm_autoclick_xoauth:';
  // Social Camp redirect
  const SC_REDIRECT_GUARD_PREFIX = 'tm_autoclick_scjump:';
  const SC_REDIRECT_USE_REPLACE = true;
  const SC_REDIRECT_KEEP_QUERY_HASH = true;

  const OBSERVER_TIMEOUT_MS = 60000;
  const MAX_ATTEMPTS_PER_PAGE = 3;
  const MAX_DUMP_CANDIDATES = 10;

  const X_TEXT_MATCHERS = [
    'アプリにアクセスを許可',
    'Authorize app',
    'Allow',
    '許可',
    'Authorize'
  ];

  // ==============================
  // State
  // ==============================
  const state = {
    phase: 'init',
    attempts: 0,
    guardKey: null,
    lastCandidateCount: 0,
    lastFoundLabel: null,
    observerActive: false,
    lastError: null
  };

  // In-memory retry timers for GCP join per-URL to avoid duplicate scheduling
  const gcpJoinRetryTimers = new Map();

  // ==============================
  // Logging
  // ==============================
  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }
  function info(...args) {
    console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }
  function err(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  // ==============================
  // Utilities
  // ==============================
  function delayRand(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getGuardKey(prefix) {
    return `${prefix}${location.pathname}${location.search}`;
  }

  function truncateText(str, max = 50) {
    if (!str) return '';
    const s = str.replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '...';
  }

  function normalizeText(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  function normalizePathname(pathname) {
    const cleaned = (pathname || '/').replace(/\/+$/, '');
    return cleaned || '/';
  }

  // Detect presence of GCP join wait/error messages that require longer wait
  function detectGcpJoinWaitMessage() {
    try {
      const body = document.body && (document.body.innerText || '');
      if (!body) return false;
      const s = normalizeText(body);
      return s.includes('参加条件の達成が確認できませんでした') || s.includes('10秒ほどお待ちいただいてから参加ボタンを押してください');
    } catch (e) {
      return false;
    }
  }

  // Return array of issues. Empty => ok
  function getElementIssues(el, options = {}) {
    const issues = [];
    if (!el) {
      issues.push('no_element');
      return issues;
    }

    const {
      textMatchers,
      requireHrefIncludes
    } = options;

    // Visibility checks
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      issues.push('not_visible');
    }
    if (rect.width === 0 || rect.height === 0) {
      issues.push('not_visible');
    }

    // Disabled
    if (el.disabled) issues.push('disabled');
    const ariaDisabled = el.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') issues.push('aria_disabled');

    // Text match
    if (textMatchers && textMatchers.length > 0) {
      const text = normalizeText(el.innerText || el.textContent || '');
      const matched = textMatchers.some((t) => text.includes(t));
      if (!matched) issues.push('text_mismatch');
    }

    // Href requirement
    if (requireHrefIncludes) {
      const href = el.getAttribute('href') || '';
      if (!href || !href.includes(requireHrefIncludes)) {
        issues.push('no_href');
      }
    }

    return issues;
  }

  function findBestCandidate({ candidates, textMatchers, hrefIncludes }) {
    if (!candidates || candidates.length === 0) return null;

    // Prefer earlier matcher order
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const issues = getElementIssues(el, {
        textMatchers,
        requireHrefIncludes: hrefIncludes
      });
      if (issues.length === 0) return el;
    }
    return null;
  }

  function dumpCandidates(label, elements, maxN, inspectorFn) {
    const list = Array.from(elements || []);
    const slice = list.slice(0, maxN);

    info(`${label}: no target found. Dumping candidates (max ${maxN})...`);
    slice.forEach((el, idx) => {
      const infoObj = inspectorFn(el);
      info(`[${label}] #${idx}`, infoObj);
    });

    if (list.length > maxN) {
      info(`${label}: ${list.length - maxN} more candidates omitted`);
    }
  }

  function elementInfo(el, issues) {
    const role = el.getAttribute('role') || '';
    const className = (el.className || '').toString();
    const trimmedClass = className.length > 80 ? className.slice(0, 80) + '...' : className;
    const href = el.getAttribute('href') || '';
    const text = truncateText(el.innerText || el.textContent || '', 50);
    return {
      tagName: el.tagName,
      role,
      className: trimmedClass,
      href,
      innerText: text,
      issues
    };
  }

  async function clickWithFallback(el) {
    if (!el) return false;

    try {
      el.click();
      log('clickWithFallback: primary el.click()');
      return true;
    } catch (e1) {
      log('clickWithFallback: primary failed', e1);
    }

    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      log('clickWithFallback: dispatchEvent click');
      return true;
    } catch (e2) {
      log('clickWithFallback: dispatchEvent failed', e2);
    }

    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      log('clickWithFallback: pointerdown/up/click');
      return true;
    } catch (e3) {
      log('clickWithFallback: pointer sequence failed', e3);
    }

    return false;
  }

  function scheduleAutoClick({ label, findFn, delayMin, delayMax, guardKey }) {
    if (state.attempts >= MAX_ATTEMPTS_PER_PAGE) {
      warn(`${label}: max attempts reached (${MAX_ATTEMPTS_PER_PAGE}). Abort.`);
      return;
    }

    state.attempts += 1;
    state.phase = `${label}:scheduled`;
    state.guardKey = guardKey;

    if (sessionStorage.getItem(guardKey)) {
      info(`${label}: already guarded. skip.`);
      return;
    }

    log(`${label}: scheduling click attempt #${state.attempts}`);
    delayRand(delayMin, delayMax).then(() => {
      state.phase = `${label}:recheck`;
      const el = findFn();

      if (!el) {
        info(`${label}: target not found after delay.`);
        return;
      }

      sessionStorage.setItem(guardKey, Date.now().toString());
      state.phase = `${label}:click`;
      clickWithFallback(el).then((ok) => {
        info(`${label}: click attempted. success=${ok}`);
        state.phase = `${label}:done`;
      });
    });
  }

  // Fixed-delay scheduler (no randomness)
  function scheduleAutoClickFixed({ label, findFn, delayMs, guardKey }) {
    if (state.attempts >= MAX_ATTEMPTS_PER_PAGE) {
      warn(`${label}: max attempts reached (${MAX_ATTEMPTS_PER_PAGE}). Abort.`);
      return;
    }

    state.attempts += 1;
    state.phase = `${label}:scheduled`;
    state.guardKey = guardKey;

    if (sessionStorage.getItem(guardKey)) {
      info(`${label}: already guarded. skip.`);
      return;
    }

    log(`${label}: scheduling fixed click after ${delayMs}ms`);
    setTimeout(() => {
      state.phase = `${label}:recheck`;
      const el = findFn();

      if (!el) {
        info(`${label}: target not found after delay.`);
        return;
      }

      sessionStorage.setItem(guardKey, Date.now().toString());
      state.phase = `${label}:click`;
      clickWithFallback(el).then((ok) => {
        info(`${label}: click attempted. success=${ok}`);
        state.phase = `${label}:done`;
      });
    }, delayMs);
  }

  // GCP join scheduler with cooldown and per-URL click count
  function scheduleGcpJoinWithCooldown({ label, findFn, delayMs, keyPrefix }) {
    const metaKey = `${keyPrefix}${location.pathname}${location.search}`;

    const loadMeta = () => {
      try {
        const raw = sessionStorage.getItem(metaKey);
        return raw ? JSON.parse(raw) : { lastClickTs: 0, clickCount: 0 };
      } catch (e) {
        return { lastClickTs: 0, clickCount: 0 };
      }
    };

    const saveMeta = (m) => {
      try {
        sessionStorage.setItem(metaKey, JSON.stringify(m));
      } catch (e) {
        // ignore
      }
    };

    const meta = loadMeta();
    if (meta.clickCount >= GCP_JOIN_MAX_CLICKS_PER_PAGE) {
      info(`${label}: max clicks reached for this URL (${meta.clickCount}). skip.`);
      return;
    }

    const since = Date.now() - (meta.lastClickTs || 0);
    // extend cooldown when specific wait/error messages are present
    const hasWaitMsg = detectGcpJoinWaitMessage();
    const effectiveCooldown = hasWaitMsg ? Math.max(GCP_JOIN_RETRY_COOLDOWN_MS, 10000) : GCP_JOIN_RETRY_COOLDOWN_MS;
    if (since < effectiveCooldown) {
      const remain = effectiveCooldown - since;
      // avoid scheduling duplicate retry timers for same URL
      if (gcpJoinRetryTimers.has(metaKey)) {
        info(`${label}: in cooldown, remain=${remain}ms (retry already scheduled)`);
        return;
      }
      info(`${label}: in cooldown, remain=${remain}ms; scheduling retry`);
      const to = setTimeout(() => {
        try { gcpJoinRetryTimers.delete(metaKey); } catch (e) {}
        scheduleGcpJoinWithCooldown({ label, findFn, delayMs, keyPrefix });
      }, remain + 50);
      gcpJoinRetryTimers.set(metaKey, to);
      return;
    }

    const foundNow = findFn();
    if (!foundNow) {
      info(`${label}: not found at scheduling time`);
      return;
    }

    log(`${label}: found. fixed delay=${delayMs}ms`);
    setTimeout(() => {
      state.phase = `${label}:recheck`;
      const el = findFn();
      if (!el) {
        info(`${label}: target disappeared before click.`);
        return;
      }

      // reload meta just before clicking to avoid race
      const meta2 = loadMeta();
      if (meta2.clickCount >= GCP_JOIN_MAX_CLICKS_PER_PAGE) {
        info(`${label}: max clicks reached before click (${meta2.clickCount}). skip.`);
        return;
      }
      const since2 = Date.now() - (meta2.lastClickTs || 0);
      if (since2 < GCP_JOIN_RETRY_COOLDOWN_MS) {
        info(`${label}: still in cooldown before click. skip.`);
        return;
      }

      // clear any pending retry timer for this URL
      if (gcpJoinRetryTimers.has(metaKey)) {
        try { clearTimeout(gcpJoinRetryTimers.get(metaKey)); } catch (e) {}
        try { gcpJoinRetryTimers.delete(metaKey); } catch (e) {}
      }

      // set metadata BEFORE clicking
      meta2.lastClickTs = Date.now();
      meta2.clickCount = (meta2.clickCount || 0) + 1;
      saveMeta(meta2);

      state.phase = `${label}:click`;
      clickWithFallback(el).then((ok) => {
        info(`${label}: clicked. success=${ok}, clickCount=${meta2.clickCount}`);
        state.phase = `${label}:done`;
      });
    }, delayMs);
  }

  function startObserver({ label, findFn, onFound, timeoutMs }) {
    let active = true;
    const obs = new MutationObserver(() => {
      const el = findFn();
      if (el) {
        obs.disconnect();
        active = false;
        log(`${label}: observer found target. disconnected.`);
        onFound(el);
      }
    });

    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      if (active) {
        obs.disconnect();
        active = false;
        info(`${label}: observer timeout. disconnected.`);
      }
    }, timeoutMs);
  }

  // ==============================
  // Phase: GCP Result (「結果をみる」)
  // ==============================
  function runGcpResultPhase() {
    const label = 'GCP_RESULT';
    state.phase = `${label}:init`;

    const guardKey = getGuardKey(GCP_RESULT_GUARD_PREFIX);

    const findFn = () => {
      const elements = document.querySelectorAll('a');
      state.lastCandidateCount = elements.length;
      const list = Array.from(elements || []);

      const textMatch = (el) => normalizeText(el.innerText || el.textContent || '').includes('結果をみる');
      const hrefMatch = (el) => (el.getAttribute('href') || '').includes('/entry/lottery/result');

      // Priority: both text + href, then href, then text
      let candidates = list.filter((el) => textMatch(el) && hrefMatch(el));
      if (candidates.length === 0) candidates = list.filter((el) => hrefMatch(el));
      if (candidates.length === 0) candidates = list.filter((el) => textMatch(el));

      if (candidates.length === 0) {
        if (DEBUG) {
          dumpCandidates(label, list, MAX_DUMP_CANDIDATES, (el) => {
            const issues = getElementIssues(el, { textMatchers: ['結果をみる'] });
            return elementInfo(el, issues);
          });
        } else {
          info(`${label}: no target found.`);
        }
        return null;
      }

      // If multiple, prefer hrefs containing 'result' or 'lottery'
      candidates.sort((a, b) => {
        const aHref = (a.getAttribute('href') || '').toLowerCase();
        const bHref = (b.getAttribute('href') || '').toLowerCase();
        const aScore = (aHref.includes('result') || aHref.includes('lottery')) ? 0 : 1;
        const bScore = (bHref.includes('result') || bHref.includes('lottery')) ? 0 : 1;
        return aScore - bScore;
      });

      for (const el of candidates) {
        const isText = textMatch(el);
        const isHref = hrefMatch(el);
        const checkOpts = {};
        if (isText) checkOpts.textMatchers = ['結果をみる'];
        if (isHref) checkOpts.requireHrefIncludes = '/entry/lottery/result';

        const issues = getElementIssues(el, checkOpts);
        if (issues.length === 0) return el;
        if (DEBUG) {
          log(`${label}: candidate skipped`, elementInfo(el, issues));
        }
      }

      return null;
    };

    const scheduleFixed = () => {
      if (sessionStorage.getItem(guardKey)) {
        log(`${label}: guard skip`);
        return;
      }

      const found = findFn();
      if (!found) {
        info(`${label}: not found at scheduling time`);
        return;
      }

      log(`${label}: found. delay=${GCP_RESULT_DELAY_MS}ms`);

      setTimeout(() => {
        state.phase = `${label}:recheck`;
        const el = findFn();
        if (!el) {
          info(`${label}: target disappeared before click.`);
          return;
        }

        // set guard before clicking to avoid races
        sessionStorage.setItem(guardKey, Date.now().toString());
        state.phase = `${label}:click`;
        clickWithFallback(el).then((ok) => {
          info(`${label}: clicked. success=${ok}`);
          state.phase = `${label}:done`;
        });
      }, GCP_RESULT_DELAY_MS);
    };

    const initial = findFn();
    if (initial) {
      scheduleFixed();
      return;
    }

    startObserver({
      label,
      findFn,
      timeoutMs: OBSERVER_TIMEOUT_MS,
      onFound: () => {
        scheduleFixed();
      }
    });
  }

  // ==============================
  // Phase: GCP
  // ==============================
  function runGcpPhase() {
    const label = 'GCP';
    state.phase = `${label}:init`;

    const guardKey = getGuardKey(GCP_GUARD_PREFIX);

    const findFn = () => {
      const elements = document.querySelectorAll('a[href*="/authentications/auth/"]');
      state.lastCandidateCount = elements.length;

      const candidates = Array.from(elements);
      const target = findBestCandidate({
        candidates,
        textMatchers: ['参加する'],
        hrefIncludes: '/authentications/auth/'
      });

      if (!target) {
        if (DEBUG) {
          dumpCandidates(label, candidates, MAX_DUMP_CANDIDATES, (el) => {
            const issues = getElementIssues(el, {
              textMatchers: ['参加する'],
              requireHrefIncludes: '/authentications/auth/'
            });
            return elementInfo(el, issues);
          });
        } else {
          info(`${label}: no target found.`);
        }
      }

      return target;
    };

    const found = findFn();
    if (found) {
      // Use cooldown-aware scheduler for GCP "参加する"
      scheduleGcpJoinWithCooldown({
        label,
        findFn,
        delayMs: GCP_JOIN_DELAY_MS,
        keyPrefix: GCP_JOIN_KEY_PREFIX
      });
      return;
    }

    startObserver({
      label,
      findFn,
      timeoutMs: OBSERVER_TIMEOUT_MS,
      onFound: () => {
        scheduleGcpJoinWithCooldown({
          label,
          findFn,
          delayMs: GCP_JOIN_DELAY_MS,
          keyPrefix: GCP_JOIN_KEY_PREFIX
        });
      }
    });
  }

  // ==============================
  // Phase: X OAuth2
  // ==============================
  function runXOAuthPhase() {
    const label = 'XOAuth';
    state.phase = `${label}:init`;

    const guardKey = getGuardKey(X_GUARD_PREFIX);

    const findFn = () => {
      const elements = document.querySelectorAll('button, div[role="button"], a[role="button"]');
      state.lastCandidateCount = elements.length;

      const candidates = Array.from(elements);

      // Prefer earlier matcher
      let target = null;
      for (const matcher of X_TEXT_MATCHERS) {
        target = candidates.find((el) => {
          const issues = getElementIssues(el, { textMatchers: [matcher] });
          return issues.length === 0;
        });
        if (target) break;
      }

      if (!target) {
        if (DEBUG) {
          dumpCandidates(label, candidates, MAX_DUMP_CANDIDATES, (el) => {
            const issues = getElementIssues(el, { textMatchers: X_TEXT_MATCHERS });
            return elementInfo(el, issues);
          });
        } else {
          info(`${label}: no target found.`);
        }
      }

      return target;
    };

    const found = findFn();
    if (found) {
      scheduleAutoClickFixed({
        label,
        findFn,
        delayMs: X_FIXED_DELAY_MS,
        guardKey
      });
      return;
    }

    startObserver({
      label,
      findFn,
      timeoutMs: OBSERVER_TIMEOUT_MS,
      onFound: () => {
        scheduleAutoClickFixed({
          label,
          findFn,
          delayMs: X_FIXED_DELAY_MS,
          guardKey
        });
      }
    });
  }

  // ==============================
  // Phase: Social Camp Lottery Redirect
  // ==============================
  function runSocialCampLotteryRedirectPhase() {
    const label = 'SOCIAL_CAMP_LOTTERY_REDIRECT';
    state.phase = `${label}:init`;

    const currentUrl = location.href;
    const normalizedPath = normalizePathname(location.pathname);
    const guardKey = `${SC_REDIRECT_GUARD_PREFIX}${location.pathname}${location.search}`;
    state.guardKey = guardKey;

    // Avoid derived paths like /lose/lottery as well
    if (normalizedPath.includes('/lottery')) {
      log(`${label}: skip (already /lottery)`, { currentUrl, normalizedPath });
      return;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length !== 2) {
      log(`${label}: skip (not base path /{seg1}/{seg2})`, { currentUrl, normalizedPath, segments });
      return;
    }

    if (sessionStorage.getItem(guardKey)) {
      log(`${label}: skip (guard hit)`, { currentUrl, guardKey });
      return;
    }

    const newPath = `${normalizedPath}/lottery`;
    const suffix = SC_REDIRECT_KEEP_QUERY_HASH ? `${location.search}${location.hash}` : '';
    const newUrl = `${location.origin}${newPath}${suffix}`;

    log(`${label}: redirect`, {
      currentUrl,
      normalizedPath,
      newUrl
    });

    sessionStorage.setItem(guardKey, Date.now().toString());
    state.phase = `${label}:redirect`;
    if (SC_REDIRECT_USE_REPLACE) {
      location.replace(newUrl);
    } else {
      location.assign(newUrl);
    }
  }

  // ==============================
  // Manual debug helpers
  // ==============================
  window.tmAutoClickStatus = function tmAutoClickStatus() {
    return {
      phase: state.phase,
      attempts: state.attempts,
      guardKey: state.guardKey,
      guardHit: state.guardKey ? !!sessionStorage.getItem(state.guardKey) : false,
      lastCandidateCount: state.lastCandidateCount,
      observerActive: state.observerActive,
      lastError: state.lastError
    };
  };

  window.tmAutoClickRun = function tmAutoClickRun(options = {}) {
    const { force = false } = options;
    if (state.guardKey && sessionStorage.getItem(state.guardKey) && !force) {
      info('tmAutoClickRun: guarded. use {force:true} to bypass when DEBUG=true');
      return;
    }
    if (force && !DEBUG) {
      info('tmAutoClickRun: force ignored because DEBUG=false');
      return;
    }

    info('tmAutoClickRun: manual trigger');
    main(true);
  };

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'j') {
      window.tmAutoClickRun({ force: DEBUG });
    }
  });

  // ==============================
  // Main
  // ==============================
  function main(isManual = false) {
    try {
      state.phase = 'main';
      state.attempts = 0;
      state.lastError = null;
      state.lastCandidateCount = 0;

      const host = location.host;

      if (host === 'gcp.giftee.biz') {
        runGcpPhase();
        runGcpResultPhase();
        return;
      }

      if (host === 'x.com') {
        const okPath = location.pathname === '/i/oauth2/authorize';
        const hasClientId = new URLSearchParams(location.search).has('client_id');
        if (okPath && hasClientId) {
          runXOAuthPhase();
        } else {
          log('X: path or client_id not matched, skip.');
        }
        return;
      }

      if (host === 'present.social-camp.com') {
        runSocialCampLotteryRedirectPhase();
        return;
      }

      log('No matching host. skip.');
    } catch (e) {
      state.lastError = e;
      if (DEBUG) {
        err('Unhandled error:', e, e.stack);
      } else {
        err('Unhandled error:', e.message || e);
      }
    } finally {
      if (isManual) {
        log('Manual run completed.');
      }
    }
  }

  main(false);
})();
