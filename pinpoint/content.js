/* =========================================================
   Pinpoint — content script
   • YouTube: plugs into the native player (button + dots on the bar)
   • Any other site with an HTML5 <video>: floating overlay
     (pin button, dots, pin list) that appears when you move
     the mouse over the video.
   ========================================================= */
(() => {
  'use strict';
  if (window.__pinpointLoaded) return;
  window.__pinpointLoaded = true;

  const YT_KEY = 'yt_pins';      // { [videoId]: [{time,label}] }  (unchanged, old pins keep working)
  const WEB_KEY = 'pp_web_pins'; // { [pageUrl]: [{time,label}] }
  const IDLE_MS = 2500;
  const MIN_W = 240;             // ignore tiny videos (ads, thumbnails, previews)
  const MIN_H = 135;
  const IS_YT_HOST = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);

  const PIN_PATH =
    'M18 4c-3.3 0-6 2.7-6 6 0 4.2 6 12 6 12s6-7.8 6-12c0-3.3-2.7-6-6-6zm0 8.5A2.5 2.5 0 1 1 18 7a2.5 2.5 0 0 1 0 5.5z';
  const LIST_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>';

  /* ---------------- State ---------------- */

  let mode = null;            // 'yt' | 'web' | null
  let video = null;           // the <video> we are attached to
  let pinId = null;           // storage id: YouTube video id, or page URL
  let pins = [];
  let markerEls = [];
  let loadToken = 0;

  let awake = false;          // web overlay: mouse recently moved over the video
  let uiHover = false;        // web overlay: mouse is on our toolbar
  let idleTimer = null;
  let editorOpen = false;
  let panelOpen = false;
  let tipVisible = false;
  let lastMouse = { x: -1, y: -1 };

  let layer = null, sidebar = null, editor = null, tip = null;
  let resizeObs = null;
  let syncTimer = null;
  let raf = 0;

  /* ---------------- Small helpers ---------------- */

  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function pinSvg(id, size) {
    const dim = size ? `width="${size}" height="${size}"` : 'width="100%" height="100%"';
    // The glyph is re-centred in the 36x36 box so it lines up with YouTube's own icons.
    return `<svg ${dim} viewBox="0 0 36 36" aria-hidden="true">
      <defs><linearGradient id="pp-g-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe97a"/><stop offset=".5" stop-color="#ffd600"/><stop offset="1" stop-color="#ff9100"/>
      </linearGradient></defs>
      <g transform="translate(18 18) scale(1.2) translate(-18 -13)">
        <path fill="url(#pp-g-${id})" d="${PIN_PATH}"/>
      </g></svg>`;
  }

  // Keep clicks / keys inside our own UI from reaching the site's player
  // (otherwise a click in our list would pause the video, typing would trigger hotkeys).
  function isolate(el, events) {
    (events || ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'contextmenu'])
      .forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation()));
  }

  function pop(el) {
    if (!el) return;
    el.classList.remove('yt-pin-pop');
    void el.offsetWidth; // restart the animation
    el.classList.add('yt-pin-pop');
  }

  function seekTo(t) {
    if (!video) return;
    video.currentTime = t;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  }

  function getYouTubeId() {
    const p = location.pathname;
    if (p === '/watch') return new URLSearchParams(location.search).get('v');
    const m = p.match(/^\/(?:embed|live)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function pageKey() {
    const u = new URL(location.href);
    u.hash = '';
    return u.origin + u.pathname + u.search;
  }

  const isAdShowing = () => !!document.querySelector('.html5-video-player.ad-showing');

  /* ---------------- Storage ---------------- */

  const keyFor = (m) => (m === 'yt' ? YT_KEY : WEB_KEY);

  async function readAll(m) {
    const k = keyFor(m);
    const data = await chrome.storage.local.get(k);
    return data[k] || {};
  }

  async function loadPins(m, id) {
    try { return (await readAll(m))[id] || []; } catch (e) { return []; }
  }

  async function savePin(m, id, pin) {
    try {
      const all = await readAll(m);
      const list = all[id] || (all[id] = []);
      list.push(pin);
      list.sort((a, b) => a.time - b.time);
      await chrome.storage.local.set({ [keyFor(m)]: all });
      return list;
    } catch (e) { return null; }
  }

  async function deletePin(m, id, index) {
    try {
      const all = await readAll(m);
      if (!all[id]) return [];
      all[id].splice(index, 1);
      await chrome.storage.local.set({ [keyFor(m)]: all });
      return all[id];
    } catch (e) { return null; }
  }

  /* ---------------- Choosing what to attach to ---------------- */

  function usable(v) {
    if (!v || !v.isConnected) return false;
    if (v.loop && v.muted) return false;                 // decorative background loops
    if (!isFinite(v.duration) || v.duration <= 0) return false; // not loaded yet, or a live stream
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return false;
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
    const cs = getComputedStyle(v);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function pickWebVideo() {
    const all = Array.from(document.querySelectorAll('video')).filter(usable);
    if (!all.length) return null;
    const under = all.filter((v) => {
      const r = v.getBoundingClientRect();
      return lastMouse.x >= r.left && lastMouse.x <= r.right && lastMouse.y >= r.top && lastMouse.y <= r.bottom;
    });
    const pool = under.length ? under : (all.includes(video) ? [video] : all);
    const score = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height * (v.paused ? 1 : 3); };
    return pool.reduce((a, b) => (score(b) > score(a) ? b : a));
  }

  /* ---------------- UI: building blocks ---------------- */

  function ensureSidebar() {
    if (sidebar) return;
    sidebar = document.createElement('div');
    sidebar.id = 'yt-pin-sidebar';
    sidebar.innerHTML = `
      <div class="yt-pin-header">
        <span class="yt-pin-title">${pinSvg('side', 16)}Pinpoint</span>
        <span class="yt-pin-right">
          <span class="yt-pin-count">0</span>
          <button type="button" class="pp-close" title="Close" aria-label="Close">×</button>
        </span>
      </div>
      <ul id="yt-pin-list"></ul>`;
    sidebar.querySelector('.pp-close').addEventListener('click', () => {
      panelOpen = false;
      sidebar.classList.remove('pp-open');
      applyAwake();
    });
    isolate(sidebar);
  }

  function ensureTip() {
    if (tip) return;
    tip = document.createElement('div');
    tip.id = 'pp-tip';
    tip.innerHTML = '<span class="pp-tip-time"></span><span class="pp-tip-label" dir="auto"></span>';
  }

  function ensureLayer() {
    if (layer) return;
    layer = document.createElement('div');
    layer.id = 'pp-layer';
    layer.innerHTML = `
      <div class="pp-toolbar">
        <button type="button" class="pp-fab pp-add" title="Pin this moment (P)" aria-label="Pin this moment">${pinSvg('fab', 22)}</button>
        <button type="button" class="pp-fab pp-list-btn" title="Pinned moments" aria-label="Pinned moments">${LIST_SVG}<span class="pp-badge">0</span></button>
      </div>
      <div class="pp-track"></div>`;
    const toolbar = layer.querySelector('.pp-toolbar');
    layer.querySelector('.pp-add').addEventListener('click', openEditor);
    layer.querySelector('.pp-list-btn').addEventListener('click', () => {
      panelOpen = !panelOpen;
      sidebar.classList.toggle('pp-open', panelOpen);
      applyAwake();
    });
    toolbar.addEventListener('mouseenter', () => { uiHover = true; applyAwake(); });
    toolbar.addEventListener('mouseleave', () => { uiHover = false; applyAwake(); });
    isolate(toolbar);
  }

  function ensureEditor() {
    if (editor) return;
    editor = document.createElement('div');
    editor.id = 'pp-editor';
    editor.innerHTML = `
      <div class="pp-ed-head">${pinSvg('ed', 18)}<span>Pin this moment</span><span class="pp-ed-time">0:00</span></div>
      <input class="pp-ed-input" type="text" maxlength="120" dir="auto" placeholder="Add a title (optional)" autocomplete="off" spellcheck="false">
      <div class="pp-ed-actions">
        <span class="pp-ed-hint">Enter to save · Esc to cancel</span>
        <button type="button" class="pp-ed-cancel">Cancel</button>
        <button type="button" class="pp-ed-save">Save</button>
      </div>`;
    const input = editor.querySelector('.pp-ed-input');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); commitEditor(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commitEditor(false); }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    editor.querySelector('.pp-ed-save').addEventListener('click', () => commitEditor(true));
    editor.querySelector('.pp-ed-cancel').addEventListener('click', () => commitEditor(false));
    isolate(editor);
  }

  /* Where each piece lives. Inside a fullscreen element only that element's
     subtree is visible, so everything follows the fullscreen element. */
  function mountParent() {
    const fs = document.fullscreenElement;
    if (fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME') return fs;
    return document.body || document.documentElement;
  }

  function placeUI() {
    if (!mode) return;
    const host = mountParent();
    if (tip && tip.parentNode !== host) host.appendChild(tip);
    if (mode === 'yt') {
      if (layer && layer.isConnected) layer.remove();
      [sidebar, editor].forEach((n) => { if (n && n.parentNode !== host) host.appendChild(n); });
    } else if (layer) {
      if (layer.parentNode !== host) host.appendChild(layer);
      [sidebar, editor].forEach((n) => { if (n && n.parentNode !== layer) layer.appendChild(n); });
    }
  }

  /* ---------------- YouTube: the pin button in the controls ---------------- */

  function ensurePinButton() {
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    let btn = document.getElementById('pin-moment-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'pin-moment-btn';
      btn.className = 'ytp-button';
      btn.title = 'Pinpoint this moment (P)';
      btn.innerHTML = pinSvg('btn');
      btn.addEventListener('click', openEditor);
      btn.addEventListener('animationend', () => btn.classList.remove('yt-pin-pop'), true);
      isolate(btn, ['dblclick']);
    }
    // Sit right next to YouTube's own buttons (same parent = same layout rules),
    // as the first one in the group.
    const first = controls.querySelector('.ytp-button:not(#pin-moment-btn)');
    const parent = first ? first.parentNode : controls;
    if (btn.parentNode !== parent || (first && btn.nextElementSibling !== first)) {
      parent.insertBefore(btn, first || parent.firstChild);
    }
    alignPinButton(btn, controls);
  }

  // YouTube's control bar layout changes between versions, so don't trust it:
  // measure our icon against a native icon and nudge until their centres match.
  function alignPinButton(btn, controls) {
    if (btn.matches(':hover') || btn.classList.contains('yt-pin-pop')) return;
    const mine = btn.querySelector('svg');
    if (!mine) return;
    let ref = null, refBtnWidth = 0;
    for (const b of controls.querySelectorAll('.ytp-button:not(#pin-moment-btn)')) {
      const s = b.querySelector('svg');
      if (!s || b.matches(':hover')) continue;
      const r = s.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { ref = r; refBtnWidth = b.getBoundingClientRect().width; break; }
    }
    if (!ref) return;

    // Same width as the native buttons, so the spacing between icons is even.
    if (refBtnWidth > 0 && Math.abs(btn.getBoundingClientRect().width - refBtnWidth) > 1) {
      btn.style.width = `${refBtnWidth}px`;
      btn.style.flex = 'none';
    }
    const me = mine.getBoundingClientRect();
    if (!me.width || !me.height) return;
    const delta = (ref.top + ref.height / 2) - (me.top + me.height / 2);
    if (Math.abs(delta) < 0.75 || Math.abs(delta) > 40) return;
    const next = (parseFloat(btn.dataset.ppDy) || 0) + delta;
    btn.dataset.ppDy = String(next);
    btn.style.transform = `translateY(${next}px)`;
  }

  /* ---------------- Adding a pin (inline title editor) ---------------- */

  function openEditor() {
    if (!video || !mode) return;
    if (editorOpen) { closeEditor(); return; }
    if (mode === 'yt' && isAdShowing()) return;
    ensureEditor();
    editor._time = video.currentTime;
    editor.querySelector('.pp-ed-time').textContent = formatTime(editor._time);
    const input = editor.querySelector('.pp-ed-input');
    input.value = '';
    placeUI();
    editor.classList.add('pp-open');
    editorOpen = true;
    applyAwake();
    input.focus({ preventScroll: true });          // focus right away so typing never misses the box
    setTimeout(() => { if (editorOpen) input.focus({ preventScroll: true }); }, 60);
  }

  function closeEditor() {
    if (!editorOpen) return;
    editorOpen = false;
    if (editor) editor.classList.remove('pp-open');
    applyAwake();
  }

  async function commitEditor(save) {
    if (!editorOpen) return;
    const label = editor.querySelector('.pp-ed-input').value.trim();
    const t = editor._time;
    closeEditor();
    if (!save) return;
    const m = mode, id = pinId;
    const next = await savePin(m, id, { time: t, label: label || formatTime(t) });
    if (next && mode === m && pinId === id) {
      pins = next;
      refresh();
      pop(m === 'yt' ? document.getElementById('pin-moment-btn') : layer && layer.querySelector('.pp-add'));
    }
  }

  /* ---------------- Dots on the bar ---------------- */

  function markerHost() {
    if (mode === 'yt') return document.querySelector('.ytp-progress-bar');
    return layer ? layer.querySelector('.pp-track') : null;
  }

  function expectedMarkers() {
    if (!video || !isFinite(video.duration) || video.duration <= 0) return 0;
    if (mode === 'yt' && isAdShowing()) return 0;
    return pins.filter((p) => p.time <= video.duration).length;
  }

  function removeMarkers() {
    markerEls.forEach((el) => el.remove());
    markerEls = [];
  }

  function renderMarkers() {
    removeMarkers();
    const host = markerHost();
    if (!host) return;
    host.querySelectorAll('.yt-pin-marker').forEach((el) => el.remove()); // leftovers from older versions
    host.classList.toggle('pp-has-pins', pins.length > 0);
    if (!expectedMarkers()) return;

    const dur = video.duration;
    pins.forEach((pin, i) => {
      const pct = (pin.time / dur) * 100;
      if (pct < 0 || pct > 100) return;
      const m = document.createElement('div');
      m.className = 'yt-pin-marker';
      m.dataset.index = i;
      m.style.left = `${pct}%`;
      m.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); seekTo(pin.time); });
      host.appendChild(m);
      markerEls.push(m);
    });
    updateActive();
  }

  function updateActive() {
    if (!video) return;
    const t = video.currentTime + 0.25;
    let active = -1;
    pins.forEach((p, i) => { if (p.time <= t) active = i; });
    markerEls.forEach((m) => m.classList.toggle('yt-pin-active', Number(m.dataset.index) === active));
    if (sidebar) {
      sidebar.querySelectorAll('#yt-pin-list li[data-index]').forEach((li) => {
        li.classList.toggle('yt-pin-active', Number(li.dataset.index) === active);
      });
    }
  }

  /* ---------------- Hover title ---------------- */

  function updateTip(x, y) {
    let best = null, bestDx = Infinity;
    for (const m of markerEls) {
      if (!m.isConnected) continue;
      const r = m.getBoundingClientRect();
      if (!r.width) continue;
      const dx = Math.abs(x - (r.left + r.width / 2));
      const dy = Math.abs(y - (r.top + r.height / 2));
      if (dx <= 12 && dy <= 18 && dx < bestDx) { best = { m, r }; bestDx = dx; }
    }
    markerEls.forEach((m) => m.classList.toggle('yt-pin-hot', !!best && m === best.m));
    if (!best) { hideTip(); return; }
    showTip(best.m, best.r);
  }

  function showTip(marker, r) {
    const pin = pins[Number(marker.dataset.index)];
    if (!pin || !tip) { hideTip(); return; }
    const time = formatTime(pin.time);
    const hasTitle = pin.label && pin.label !== time;
    tip.querySelector('.pp-tip-time').textContent = time;
    const lab = tip.querySelector('.pp-tip-label');
    lab.textContent = hasTitle ? pin.label : '';
    lab.style.display = hasTitle ? '' : 'none';

    tip.classList.add('pp-show');
    tipVisible = true;
    document.documentElement.classList.add('pp-tip-on'); // hides YouTube's own hover preview

    const cx = r.left + r.width / 2;
    const w = tip.offsetWidth;
    const half = w / 2 + 8;
    const left = Math.min(Math.max(cx, half), Math.max(half, innerWidth - half));
    tip.style.left = `${left}px`;
    tip.style.top = `${r.top - 6}px`;
    tip.style.setProperty('--pp-ax', `${cx - left + w / 2}px`);
  }

  function hideTip() {
    if (!tipVisible) return;
    tipVisible = false;
    if (tip) tip.classList.remove('pp-show');
    document.documentElement.classList.remove('pp-tip-on');
    markerEls.forEach((m) => m.classList.remove('yt-pin-hot'));
  }

  /* ---------------- Pin list ---------------- */

  function updateSidebar() {
    if (!sidebar) return;
    const list = sidebar.querySelector('#yt-pin-list');
    list.textContent = '';
    sidebar.querySelector('.yt-pin-count').textContent = pins.length;

    if (!pins.length) {
      const li = document.createElement('li');
      li.className = 'yt-pin-empty';
      li.innerHTML = mode === 'web'
        ? 'Nothing pinned yet.<br>Tap the pin button on the video to save a moment.'
        : 'Nothing pinned yet.<br>Hit the pin button in the player controls to save a moment.';
      list.appendChild(li);
      return;
    }

    pins.forEach((pin, i) => {
      const li = document.createElement('li');
      li.dataset.index = i;

      const time = document.createElement('span');
      time.className = 'yt-pin-time';
      time.textContent = formatTime(pin.time);

      const label = document.createElement('span');
      label.className = 'yt-pin-label';
      label.dir = 'auto';
      label.textContent = pin.label;
      label.title = pin.label;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'yt-pin-del';
      del.title = 'Delete';
      del.textContent = '×';

      const seek = () => seekTo(pin.time);
      time.addEventListener('click', seek);
      label.addEventListener('click', seek);
      del.addEventListener('click', async () => {
        const next = await deletePin(mode, pinId, i);
        if (next) { pins = next; refresh(); }
      });

      li.append(time, label, del);
      list.appendChild(li);
    });
    updateActive();
  }

  function updateBadge() {
    if (!layer) return;
    const b = layer.querySelector('.pp-badge');
    b.textContent = pins.length;
    b.style.display = pins.length ? '' : 'none';
  }

  function refresh() {
    updateSidebar();
    renderMarkers();
    updateBadge();
    applyAwake();
    syncLayer();
  }

  /* ---------------- Show / hide logic ---------------- */

  // Web overlay: visible while the mouse moves over the video, or while paused / editing.
  function applyAwake() {
    if (mode !== 'web' || !layer) return;
    const show = awake || uiHover || editorOpen || panelOpen || (video && video.paused && !video.ended);
    layer.classList.toggle('pp-awake', !!show);
  }

  function wake() {
    awake = true;
    applyAwake();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { awake = false; applyAwake(); }, IDLE_MS);
  }

  // YouTube fullscreen: fade our extras out together with YouTube's controls.
  function wakeYT() {
    if (!document.fullscreenElement) return;
    document.documentElement.classList.remove('pp-ui-hidden');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!editorOpen) document.documentElement.classList.add('pp-ui-hidden');
    }, IDLE_MS);
  }

  let lastRect = '';
  function syncLayer() {
    if (mode !== 'web' || !layer || !video) return;
    const r = video.getBoundingClientRect();
    const fs = document.fullscreenElement;
    const visible = r.width > 0 && r.height > 0 && (!fs || fs.contains(video));
    layer.style.display = visible ? '' : 'none';
    if (!visible) return;
    const sig = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (sig === lastRect) return;
    lastRect = sig;
    layer.style.left = `${r.left}px`;
    layer.style.top = `${r.top}px`;
    layer.style.width = `${r.width}px`;
    layer.style.height = `${r.height}px`;
  }

  function schedSync() {
    if (raf || mode !== 'web') return;
    raf = requestAnimationFrame(() => { raf = 0; syncLayer(); });
  }

  /* ---------------- Attach / detach ---------------- */

  function attach({ m, v, id }) {
    detach();
    mode = m; video = v; pinId = id; pins = [];
    ensureSidebar();
    ensureTip();
    if (m === 'web') ensureLayer();
    sidebar.classList.toggle('pp-in-layer', m === 'web');
    sidebar.classList.remove('pp-open');
    panelOpen = false;
    placeUI();
    lastRect = '';
    if (m === 'web' && window.ResizeObserver) {
      resizeObs = new ResizeObserver(schedSync);
      resizeObs.observe(v);
    }
    const token = ++loadToken;
    loadPins(m, id).then((list) => {
      if (token === loadToken) { pins = list; refresh(); }
    });
    refresh();
  }

  function detach() {
    loadToken++;
    closeEditor();
    hideTip();
    removeMarkers();
    clearTimeout(idleTimer);
    awake = false; uiHover = false; panelOpen = false;
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    document.documentElement.classList.remove('pp-ui-hidden');
    [layer, sidebar, editor].forEach((n) => { if (n && n.isConnected) n.remove(); });
    mode = null; video = null; pinId = null; pins = [];
  }

  // Called every tick while attached: repairs things the site re-rendered.
  function maintain() {
    placeUI();
    if (mode === 'yt') ensurePinButton(); else syncLayer();
    const host = markerHost();
    const want = expectedMarkers();
    const ok = host && markerEls.length === want && markerEls.every((el) => el.isConnected && el.parentNode === host);
    if (!ok) renderMarkers();
  }

  function sync() {
    if (!alive()) { shutdown(); return; }
    if (document.hidden) return;

    let target = null;
    if (IS_YT_HOST) {
      const id = getYouTubeId();
      const v = id && document.querySelector('video.html5-main-video, #movie_player video, video');
      if (id && v && document.querySelector('.ytp-right-controls')) target = { m: 'yt', v, id };
    } else {
      const v = pickWebVideo();
      if (v) target = { m: 'web', v, id: pageKey() };
    }

    if (!target) { if (mode) detach(); return; }
    if (target.m !== mode || target.v !== video || target.id !== pinId) attach(target);
    maintain();
  }

  // The extension was reloaded/updated: clean up so no stale UI is left on the page.
  function shutdown() {
    clearInterval(syncTimer);
    detach();
    [layer, sidebar, editor, tip].forEach((n) => { if (n) n.remove(); });
    const btn = document.getElementById('pin-moment-btn');
    if (btn) btn.remove();
    document.documentElement.classList.remove('pp-tip-on', 'pp-ui-hidden');
  }

  /* ---------------- Events ---------------- */

  window.addEventListener('mousemove', (e) => {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    if (!mode) return;
    if (mode === 'yt') {
      wakeYT();
    } else if (video) {
      const r = video.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) wake();
    }
    if (markerEls.length) updateTip(e.clientX, e.clientY); else hideTip();
  }, { capture: true, passive: true });

  // Shortcut: press P to pin the current moment (ignored while typing in a text field).
  window.addEventListener('keydown', (e) => {
    if (!mode || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const isP = (e.key && e.key.toLowerCase() === 'p') || e.code === 'KeyP'; // code: works on any keyboard layout
    if (!isP) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    e.stopPropagation();
    openEditor();
  }, true);

  // Click anywhere outside the title box = cancel it.
  window.addEventListener('mousedown', (e) => {
    if (!editorOpen) return;
    const t = e.target;
    if (editor.contains(t) || (t.closest && t.closest('#pin-moment-btn, .pp-add'))) return;
    closeEditor();
  }, true);

  window.addEventListener('scroll', schedSync, { capture: true, passive: true });
  window.addEventListener('resize', schedSync);
  document.documentElement.addEventListener('mouseleave', hideTip);

  document.addEventListener('fullscreenchange', () => {
    placeUI();
    syncLayer();
    if (mode === 'yt') {
      clearTimeout(idleTimer);
      document.documentElement.classList.remove('pp-ui-hidden');
      if (document.fullscreenElement) wakeYT();
    }
  });

  const onMeta = (e) => { if (e.target === video) renderMarkers(); else if (e.target instanceof HTMLVideoElement) sync(); };
  document.addEventListener('loadedmetadata', onMeta, true);
  document.addEventListener('durationchange', onMeta, true);
  const onTime = (e) => { if (e.target === video) updateActive(); };
  document.addEventListener('timeupdate', onTime, true);
  document.addEventListener('seeked', onTime, true);
  const onPlayState = (e) => { if (e.target === video) applyAwake(); };
  document.addEventListener('play', onPlayState, true);
  document.addEventListener('pause', onPlayState, true);

  // Keep this tab in sync if pins change elsewhere (popup, another tab, another frame).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !mode || !changes[keyFor(mode)]) return;
      pins = ((changes[keyFor(mode)].newValue || {})[pinId]) || [];
      refresh();
    });
  } catch (e) { /* extension context gone */ }

  syncTimer = setInterval(sync, 700);
  sync();
})();
