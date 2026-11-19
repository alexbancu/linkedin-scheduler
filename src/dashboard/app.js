  var DATA = null;
  // the open tab survives a refresh
  var TAB = 'queue';
  try { var savedTab = localStorage.getItem('tab'); if (['queue', 'drafts', 'posted', 'analytics', 'settings'].indexOf(savedTab) > -1) TAB = savedTab; } catch (e) {}
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var DOW = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  var FOLD = 210;
  var PRESETS = [
    { day: 2, hour: 15, name: 'US morning + EU afternoon', desc: 'Recommended for a US + Western-EU audience — both regions active at once.' },
    { day: 3, hour: 16, name: 'US peak (9-10am ET)', desc: 'Prime US East Coast window; EU mid-afternoon.' },
    { day: 4, hour: 10, name: 'EU-first morning', desc: 'Best for a Europe-heavy audience; US still asleep.' }
  ];

  function api(method, path, body, cb) {
    fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    }).then(cb).catch(function (e) { if (e.message !== 'unauthorized') toast(e.message); });
  }

  function uploadMedia(kind, file, cb, errcb) {
    fetch('/api/media?kind=' + kind + '&name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    }).then(cb).catch(function (e) { errcb(e); });
  }

  // LinkedIn's own view of an uploaded video: the cover frame the feed shows and
  // the processed MP4. Cached per URN until the signed URLs near expiry; never
  // cached while LinkedIn is still processing, so the next ask sees the update.
  var VIDEO_INFO = {};
  function videoInfo(urn, cb) {
    var c = VIDEO_INFO[urn];
    if (c && c.data && (!c.data.expiresAt || c.data.expiresAt - Date.now() > 300000)) return cb(c.data);
    if (c && c.waiting) { c.waiting.push(cb); return; }
    var entry = VIDEO_INFO[urn] = { waiting: [cb] };
    function settle(d) {
      if (d.status === 'AVAILABLE') VIDEO_INFO[urn] = { data: d }; else delete VIDEO_INFO[urn];
      entry.waiting.forEach(function (f) { f(d); });
    }
    fetch('/api/media/video?urn=' + encodeURIComponent(urn))
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
      .then(settle)
      .catch(function (e) { settle({ status: 'ERROR', error: e.message }); });
  }
  // object URLs of videos attached in this tab: the preview can play them while
  // LinkedIn is still processing the upload
  var LOCAL_VIDEO = {};

  function showLogin() { document.getElementById('app').style.display = 'none'; document.getElementById('login').style.display = 'block'; }
  function doLogin() {
    var input = document.getElementById('pw');
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); }); })
      .then(function () { input.value = ''; load(); })
      .catch(function (e) { toast(e.message); });
  }
  function load() {
    api('GET', '/api/state', null, function (d) {
      DATA = d;
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      render();
      if (location.hash === '#oauth=ok') {
        history.replaceState(null, '', '/');
        toast('LinkedIn connected — new token saved (valid ~60 days)');
      }
    });
  }
  function refresh(d) { DATA = d; render(); }
  var QSEL = 'engineers';
  try { QSEL = localStorage.getItem('q_sel') || 'engineers'; } catch (e) {}
  var COMPOSER_OPEN = false;
  var UP_ALL = false;
  try { UP_ALL = localStorage.getItem('up_all') === '1'; } catch (e) {}
  function setQ(k) { QSEL = k; try { localStorage.setItem('q_sel', k); } catch (e) {} }
  function queueOf(k) { return (DATA.queues || []).filter(function (x) { return x.key === k; })[0] || DATA.queues[0]; }
  // All queued posts of both queues with their slot date, in the order they will go out.
  function allQueued() {
    var out = [];
    DATA.queues.forEach(function (q) { q.approved.forEach(function (p, i) { out.push({ p: p, q: q, i: i, total: q.approved.length, iso: q.slots[i] ? q.slots[i].iso : '9999' }); }); });
    out.sort(function (a, b) { return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0; });
    return out;
  }
  function dayPlural(k) { var q = queueOf(k); return DAYS[q.settings.post_day] + 's'; }
  function shortSlot(q) { return DAYS[q.settings.post_day].slice(0, 3) + ' ' + String(q.settings.post_hour).padStart(2, '0') + ':00' + (q.settings.cadence_weeks > 1 ? ', every ' + q.settings.cadence_weeks + ' wks' : ', weekly'); }
  var STAGE_INFO = { tofu: ['TOFU', 'reach'], mofu: ['MOFU', 'trust'], bofu: ['BOFU', 'ask'] };
  // Only the GTM leaders queue runs a funnel. Engineer posts are reach, so they
  // show a neutral "Reach" chip and no stage. Stored stage values are left as they are.
  var FUNNEL_Q = 'gtm';
  function inFunnel(queueKey) { return (queueKey || 'engineers') === FUNNEL_Q; }
  function stageLabel(p) { return inFunnel(p.queue) ? (p.stage && STAGE_INFO[p.stage] ? STAGE_INFO[p.stage][0] : 'no stage') : 'Reach'; }
  // Stage picker: TOFU / MOFU / BOFU / none. Optional, recommended.
  function stagePicker(current, onPick) {
    var row = el('div', 'row'); row.style.marginTop = '8px';
    row.appendChild(el('label', '', 'Funnel stage'));
    var pills = el('div', 'pills stagepills');
    [['tofu'], ['mofu'], ['bofu'], [null]].forEach(function (o) {
      var k = o[0];
      var b = el('button', 'pill' + (k === (current || null) ? ' active' : ''));
      if (k) { b.appendChild(el('span', '', STAGE_INFO[k][0])); b.appendChild(el('span', 'sub', STAGE_INFO[k][1])); } else b.appendChild(el('span', '', 'None'));
      b.onclick = function () { Array.prototype.forEach.call(pills.children, function (x) { x.classList.remove('active'); }); b.classList.add('active'); onPick(k); };
      pills.appendChild(b);
    });
    row.appendChild(pills);
    row.appendChild(el('span', 'note', 'optional, recommended'));
    return row;
  }
  var COMPOSE_Q = 'engineers';
  function queueLabel(k) { var q = (DATA.queues || []).filter(function (x) { return x.key === k; })[0]; return q ? q.label : k; }
  function queueSelect(selected) {
    var sel = el('select');
    (DATA.queues || []).forEach(function (q) { var o = el('option', '', q.label); o.value = q.key; if (q.key === selected) o.selected = true; sel.appendChild(o); });
    return sel;
  }
  function slotLine(q) {
    var cw = q.settings.cadence_weeks || 1;
    return (cw === 1 ? 'Weekly: ' : 'Every ' + cw + ' weeks: ') + DAYS[q.settings.post_day] + 's at ' + String(q.settings.post_hour).padStart(2, '0') + ':00 Bucharest';
  }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 4200);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function hasPlaceholders(text) { return /\[[^\]]*\]/.test(text); }

  // Mirror of the server's formatForLinkedIn: **bold** → unicode bold, "* "/"- " → "• ".
  // Previews and counters show exactly what will hit LinkedIn.
  function fmtLi(text) {
    return String(text || '')
      .replace(/\*\*([^*\n]+?)\*\*/g, function (_, inner) {
        var out = '';
        for (var i = 0; i < inner.length; ) {
          var cp = inner.codePointAt(i);
          if (cp >= 65 && cp <= 90) out += String.fromCodePoint(0x1D5D4 + cp - 65);
          else if (cp >= 97 && cp <= 122) out += String.fromCodePoint(0x1D5EE + cp - 97);
          else if (cp >= 48 && cp <= 57) out += String.fromCodePoint(0x1D7EC + cp - 48);
          else out += String.fromCodePoint(cp);
          i += cp > 0xFFFF ? 2 : 1;
        }
        return out;
      })
      .replace(/^([ \t]*)[*-][ \t]+/gm, '$1• ');
  }

  function tzOffsetMs(date, tz) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var p = {}; f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
  }
  function nextSlotInstant(day, hour) {
    var now = Date.now();
    for (var i = 0; i < 8; i++) {
      var base = new Date(now + i * 86400000);
      var p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(base).forEach(function (x) { p[x.type] = x.value; });
      if (DOW[p.weekday] !== day) continue;
      var guess = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, hour, 0, 0));
      var inst = new Date(guess.getTime() - tzOffsetMs(guess, 'Europe/Bucharest'));
      if (inst.getTime() < now - 2 * 3600000) continue;
      return inst;
    }
    return null;
  }
  function hhmm(inst, tz) { return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(inst); }
  function reachLabel(day, hour) {
    var inst = nextSlotInstant(day, hour);
    if (!inst) return '';
    return hhmm(inst, 'America/New_York') + ' New York · ' + hhmm(inst, 'Europe/London') + ' London · ' + hhmm(inst, 'Europe/Berlin') + ' Berlin';
  }

  function counterText(text) {
    // count the formatted text (what LinkedIn receives), in codepoints —
    // unicode-bold chars are surrogate pairs, so .length would double-count them
    var ft = fmtLi(text);
    var total = Array.from(ft).length;
    var hook = Array.from(ft.split('\n')[0]).length;
    var parts = [];
    parts.push({ t: 'total ' + total + '/' + DATA.maxChars, cls: total > DATA.maxChars ? 'over' : '' });
    parts.push({ t: 'hook ' + hook + ' chars', cls: hook > FOLD ? 'warn' : '' });
    if (total > FOLD) parts.push({ t: 'cut at ~' + FOLD + ' (see more)', cls: 'warn' });
    return parts;
  }
  function attachCounter(container, ta) {
    var box = el('div', 'counts');
    function paint() { box.innerHTML = ''; counterText(ta.value).forEach(function (p) { box.appendChild(el('span', p.cls, p.t)); }); }
    ta.addEventListener('input', paint); paint(); container.appendChild(box); return box;
  }

  function mediaSummary(m) {
    if (!m) return '';
    if (m.kind === 'images') return m.items.length === 1 ? '📷 photo' : '📷 ' + m.items.length + ' photos';
    if (m.kind === 'document') return '📄 carousel: ' + (m.items[0] ? m.items[0].name : 'document');
    if (m.kind === 'video') return '🎬 video: ' + (m.items[0] ? m.items[0].name : 'video');
    return '';
  }

  // client-side thumbnails so previews survive reload (bytes aren't stored).
  // Scales to maxDim, then walks quality down until the data URL fits the budget.
  function encodeScaled(source, w, h, maxDim, budget) {
    if (!w || !h) return null;
    var s = Math.min(1, maxDim / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    try { cv.getContext('2d').drawImage(source, 0, 0, cw, ch); } catch (e) { return null; }
    var qs = [0.82, 0.7, 0.58, 0.45, 0.35];
    for (var i = 0; i < qs.length; i++) {
      var d = cv.toDataURL('image/jpeg', qs[i]);
      if (d.length <= budget) return d;
    }
    return maxDim > 420 ? encodeScaled(source, w, h, Math.round(maxDim * 0.65), budget) : null;
  }
  function makeImageThumb(file, maxDim, budget) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () { var d = encodeScaled(img, img.width, img.height, maxDim, budget); URL.revokeObjectURL(img.src); res(d); };
      img.onerror = function () { res(null); };
      img.src = URL.createObjectURL(file);
    });
  }
  function makeVideoThumb(file, maxDim, budget) {
    return new Promise(function (res) {
      var v = document.createElement('video'); v.muted = true; v.preload = 'metadata';
      var url = URL.createObjectURL(file), fin = false;
      function done(d) { if (fin) return; fin = true; URL.revokeObjectURL(url); res(d); }
      function grab() { done(encodeScaled(v, v.videoWidth, v.videoHeight, maxDim, budget)); }
      v.onloadeddata = function () { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (e) { grab(); } };
      v.onseeked = grab;
      v.onerror = function () { done(null); };
      if (url.indexOf('blob:') === 0) v.src = url; else done(null);
    });
  }
  // single image/video renders large in the preview -> 720px; grid tiles stay small -> 480px
  function makeThumb(kind, file, count) {
    if (kind === 'images') return count > 1 ? makeImageThumb(file, 480, 70000) : makeImageThumb(file, 720, 150000);
    if (kind === 'video') return makeVideoThumb(file, 720, 150000);
    return Promise.resolve(null);
  }

  // LinkedIn-style feed preview with a mobile/desktop toggle
  function feedPreview(text, media, comment) {
    var mode = feedPreview._mode || 'mobile';
    var outer = el('div');
    var bar = el('div', 'pvbar');
    var mb = el('button', 'pvtab', '📱 Mobile');
    var db = el('button', 'pvtab', '🖥 Desktop');
    mb.onclick = function () { feedPreview._mode = 'mobile'; draw('mobile'); };
    db.onclick = function () { feedPreview._mode = 'desktop'; draw('desktop'); };
    bar.appendChild(mb); bar.appendChild(db); outer.appendChild(bar);
    var host = el('div', 'pvhost'); outer.appendChild(host);
    function draw(m) {
      mb.className = 'pvtab' + (m === 'mobile' ? ' active' : '');
      db.className = 'pvtab' + (m === 'desktop' ? ' active' : '');
      host.innerHTML = ''; host.appendChild(fpCard(text, media, m, comment));
    }
    draw(mode);
    return outer;
  }
  function fpCard(text, media, mode, comment) {
    var fold = mode === 'mobile' ? 140 : 210;
    var card = el('div', 'fpcard ' + mode);
    var au = el('div', 'fpauthor');
    au.appendChild(el('div', 'fpavatar', 'AB'));
    var ai = el('div');
    ai.appendChild(el('div', 'fpname', 'You'));
    ai.appendChild(el('div', 'fpsub', 'Senior Software Engineer'));
    ai.appendChild(el('div', 'fptime', 'now · 🌐'));
    au.appendChild(ai);
    card.appendChild(au);
    card.appendChild(fpText(fmtLi(text || ''), fold));
    if (media && media.items && media.items.length) card.appendChild(fpMedia(media));
    card.appendChild(fpReact());
    if (comment && comment.trim()) {
      // the first comment, as it shows under the post: author row, then the text
      var cm = el('div', 'fpcomment');
      var ch = el('div', 'fpchead');
      ch.appendChild(el('div', 'fpavatar sm', 'AB'));
      var cn = el('div'); cn.appendChild(el('span', 'fpname', 'You')); cn.appendChild(el('span', 'fpauthorchip', 'Author'));
      ch.appendChild(cn); cm.appendChild(ch);
      cm.appendChild(el('div', 'fpctext', fmtLi(comment.trim())));
      card.appendChild(cm);
    }
    return card;
  }
  function fpText(text, fold) {
    var wrap = el('div', 'fptext');
    if (!text) return wrap;
    var cut = text.length, nl = -1, cnt = 0;
    for (var i = 0; i < text.length; i++) { if (text[i] === '\n') { cnt++; if (cnt === 3) { nl = i; break; } } }
    if (text.length > fold) cut = Math.min(cut, fold);
    if (nl !== -1) cut = Math.min(cut, nl);
    // never split a surrogate pair (unicode-bold chars) at the fold boundary
    if (cut > 0 && cut < text.length && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
    if (cut >= text.length) { wrap.appendChild(el('span', '', text)); return wrap; }
    // trim the folded head for display, but hand the trimmed whitespace to the rest,
    // so a blank line right at the fold still shows once the post is expanded
    var head = text.slice(0, cut).replace(/\s+$/, '');
    wrap.appendChild(el('span', '', head));
    var more = el('span', 'more', ' …more');
    var rest = el('span', '', text.slice(head.length)); rest.style.display = 'none';
    more.onclick = function () { rest.style.display = 'inline'; more.style.display = 'none'; };
    wrap.appendChild(more); wrap.appendChild(rest);
    return wrap;
  }
  function fpTile(it, h) {
    if (it && it.thumb) { var img = el('img', 'fptile'); img.src = it.thumb; if (h) img.style.height = h; return img; }
    var d = el('div', 'fptile fpph'); d.style.height = h || '180px'; d.style.flexDirection = 'column'; d.style.gap = '4px';
    d.appendChild(el('div', '', '🖼'));
    var note = el('span', '', 're-attach to preview'); note.style.fontSize = '10.5px'; note.style.color = '#b7b2a8';
    d.appendChild(note);
    return d;
  }
  function fpMedia(media) {
    if (media.kind === 'video') return fpVideo(media.items[0]);
    if (media.kind === 'document') return fpDoc(media.items[0]);
    var items = media.items, n = items.length;
    if (n === 1) { var w = el('div', 'fpsingle'); var t = fpTile(items[0]); t.style.maxHeight = '430px'; w.appendChild(t); return w; }
    var grid = el('div', 'fpgrid'); grid.style.gridTemplateColumns = '1fr 1fr';
    var show = Math.min(n, 4);
    for (var i = 0; i < show; i++) {
      if (n === 3 && i === 0) { var span = el('div'); span.style.gridColumn = 'span 2'; span.appendChild(fpTile(items[0], '190px')); grid.appendChild(span); continue; }
      if (i === 3 && n > 4) { var ov = el('div', 'fpmore'); ov.appendChild(fpTile(items[3], '150px')); var o = el('div', 'ov', '+' + (n - 4)); ov.appendChild(o); grid.appendChild(ov); continue; }
      grid.appendChild(fpTile(items[i], '150px'));
    }
    return grid;
  }
  // Playable video. Poster = LinkedIn's generated cover (what the feed shows
  // before play), source = LinkedIn's processed MP4; the local thumb/file only
  // stand in until LinkedIn has finished processing.
  function fpVideo(it) {
    var wrap = el('div', 'fpvideo');
    var v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.preload = 'metadata';
    if (it && it.thumb) v.poster = it.thumb;
    wrap.appendChild(v);
    if (!it || !it.urn) return wrap;
    var note = el('div', 'fpvnote', 'Loading the video from LinkedIn…');
    wrap.appendChild(note);
    var tries = 0;
    (function ask() {
      videoInfo(it.urn, function (d) {
        if (d.aspect) v.style.aspectRatio = String(d.aspect);
        if (d.thumbnail) v.poster = d.thumbnail;
        if (d.status === 'AVAILABLE' && d.downloadUrl) {
          if (!v.src || v.paused) v.src = d.downloadUrl;
          note.remove();
          return;
        }
        var local = LOCAL_VIDEO[it.urn];
        // only object URLs this tab created for the user's own file
        if (local && !v.src && local.indexOf('blob:') === 0) v.src = local;
        if (d.status === 'PROCESSING' || d.status === 'WAITING_UPLOAD') {
          note.textContent = 'LinkedIn is still processing this video' +
            (local ? ' (playing your local file; the cover switches to LinkedIn’s when ready)' : ' (this preview updates by itself)');
          if (++tries < 30) setTimeout(function () { if (wrap.isConnected) ask(); }, 6000);
          return;
        }
        note.textContent = d.status === 'PROCESSING_FAILED'
          ? 'LinkedIn failed to process this video' + (d.failure ? ': ' + d.failure : '') + '. Re-attach it.'
          : 'Could not load the video from LinkedIn' + (d.error ? ': ' + d.error : '');
      });
    })();
    return wrap;
  }
  function fpDoc(it) {
    var wrap = el('div', 'fpdoc');
    var page = el('div', 'page');
    page.appendChild(el('div', 'di', '📄'));
    page.appendChild(el('div', 'docname', (it && it.name) || 'Carousel.pdf'));
    page.appendChild(el('div', '', 'swipe to view slides'));
    wrap.appendChild(page);
    wrap.appendChild(el('div', 'caption', 'Document · carousel'));
    return wrap;
  }
  function fpReact() {
    var r = el('div', 'fpreact');
    r.appendChild(el('span', '', '👍 ❤️ 💡  You and others'));
    r.appendChild(el('span', '', 'Comment · Repost · Send'));
    return r;
  }

  // Attach controls used in composer and on cards. onChange(mediaSpecOrNull) persists.
  function attachControls(current, onChange) {
    var wrap = el('div');
    var state = current ? JSON.parse(JSON.stringify(current)) : null;

    var bar = el('div', 'mediabar');
    function renderBar() {
      bar.innerHTML = '';
      if (!state || !state.items.length) return;
      state.items.forEach(function (it, idx) {
        var mi = el('div', 'mediaitem');
        if (it.thumb) { var img = el('img'); img.src = it.thumb; mi.appendChild(img); }
        else mi.appendChild(el('span', '', state.kind === 'document' ? '📄' : state.kind === 'video' ? '🎬' : '📷'));
        mi.appendChild(el('span', 'nm', it.name));
        if (state.kind === 'images') {
          var alt = el('input'); alt.type = 'text'; alt.placeholder = 'alt text (optional)'; alt.value = it.alt || '';
          alt.oninput = function () { it.alt = alt.value; onChange(clean(state)); };
          mi.appendChild(alt);
        }
        var x = el('span', 'x', '✕');
        x.onclick = function () { state.items.splice(idx, 1); if (!state.items.length) state = null; renderBar(); onChange(state ? clean(state) : null); };
        mi.appendChild(x);
        bar.appendChild(mi);
      });
    }
    function clean(s) { return { kind: s.kind, items: s.items.map(function (i) { return { urn: i.urn, name: i.name, alt: i.alt, thumb: i.thumb }; }) }; }

    var input = el('input'); input.type = 'file'; input.style.display = 'none';
    var busy = false;
    function pick(kind, multiple, accept) {
      if (busy) return;
      input.value = ''; input.accept = accept; input.multiple = multiple;
      input.onchange = function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return;
        if (!state || state.kind !== kind) state = { kind: kind, items: [] };
        var lim = DATA.mediaLimits[kind];
        if (state.items.length + files.length > lim.maxCount) { toast(kind + ': max ' + lim.maxCount); return; }
        busy = true; toast('Uploading to LinkedIn…');
        var i = 0;
        (function next() {
          if (i >= files.length) { busy = false; renderBar(); onChange(clean(state)); toast('Attached'); return; }
          var f = files[i];
          var item = { urn: '', name: f.name, alt: '' };
          uploadMedia(kind, f, function (d) {
            item.urn = d.urn;
            if (kind === 'video') LOCAL_VIDEO[d.urn] = URL.createObjectURL(f);
            var total = state.items.length + files.length;
            makeThumb(kind, f, total).then(function (t) { if (t && t.length <= 155000) item.thumb = t; state.items.push(item); i++; next(); });
          }, function (e) { busy = false; toast(e.message); });
        })();
      };
      input.click();
    }

    var arow = el('div', 'attachrow');
    var bImg = el('button', 'attach', '📷 Photos'); bImg.onclick = function () { pick('images', true, 'image/jpeg,image/png,image/gif'); };
    var bDoc = el('button', 'attach', '📄 Carousel PDF'); bDoc.onclick = function () { pick('document', false, '.pdf,.ppt,.pptx,.doc,.docx,application/pdf'); };
    var bVid = el('button', 'attach', '🎬 Video'); bVid.onclick = function () { pick('video', false, 'video/mp4'); };
    arow.appendChild(bImg); arow.appendChild(bDoc); arow.appendChild(bVid);
    arow.appendChild(el('span', 'note', 'one media type per post'));

    wrap.appendChild(bar); wrap.appendChild(input); wrap.appendChild(arow);
    renderBar();
    return wrap;
  }

  function snippet(text) { return text && text.trim() ? fmtLi(text) : '(media-only post — no text)'; }

  function collapsedThumb(media) {
    if (!media || !media.items || !media.items.length) return null;
    var it = media.items[0];
    var wrap = el('div', 'cthumb-wrap');
    if ((media.kind === 'images' || media.kind === 'video') && it.thumb) {
      var img = el('img', 'cthumb'); img.src = it.thumb; wrap.appendChild(img);
      if (media.kind === 'video') wrap.appendChild(el('div', 'cthumb-play', '▶'));
    } else {
      var d = el('div', 'cthumb'); d.style.display = 'flex'; d.style.alignItems = 'center'; d.style.justifyContent = 'center'; d.style.fontSize = '22px';
      d.textContent = media.kind === 'document' ? '📄' : media.kind === 'video' ? '🎬' : '📷';
      wrap.appendChild(d);
    }
    if (media.kind === 'images' && media.items.length > 1) wrap.appendChild(el('div', 'cthumb-badge', '+' + (media.items.length - 1)));
    // video: swap in LinkedIn's cover frame, the one the feed will actually show
    if (media.kind === 'video' && it.urn) {
      videoInfo(it.urn, function (d) {
        if (!d.thumbnail) return;
        wrap.innerHTML = '';
        var img = el('img', 'cthumb'); img.src = d.thumbnail; wrap.appendChild(img);
        wrap.appendChild(el('div', 'cthumb-play', '▶'));
      });
    }
    return wrap;
  }

  function togglePreview(btn, panel, p) {
    if (panel._open) { panel.innerHTML = ''; panel._open = false; btn.textContent = '👁 Preview'; }
    else { panel.innerHTML = ''; panel.appendChild(feedPreview(p.text, p.media, p.first_comment)); panel._open = true; btn.textContent = '✕ Hide preview'; }
  }

  // Compact, read-first card that expands into the full editor on demand (Buffer-style).
  function postCard(p, mode) {
    var c = el('div', 'card q-' + (p.queue || 'engineers') + (mode === 'attention' ? ' attention' : ''));
    var collapsed = el('div');
    var expanded = el('div'); expanded.style.display = 'none';
    var previewPanel = el('div');

    var meta = el('div', 'meta');
    if (mode === 'approved') meta.appendChild(el('span', 'chip', 'posts: ' + p.planned_slot));
    if (mode === 'posted') meta.appendChild(el('span', 'chip ok', 'posted'));
    if (mode === 'skipped') meta.appendChild(el('span', 'chip pos', 'skipped'));
    if (mode === 'attention') meta.appendChild(el('span', 'chip warn', p.status === 'failed' ? 'failed, not retried' : 'publishing'));
    if (!inFunnel(p.queue)) meta.appendChild(el('span', 'chip reach', 'Reach'));
    else if (p.stage && STAGE_INFO[p.stage]) meta.appendChild(el('span', 'chip stage', STAGE_INFO[p.stage][0]));
    else if (mode === 'approved' || mode === 'draft') meta.appendChild(el('span', 'chip nostage', 'no stage'));
    if (p.queue && ((mode !== 'approved' && mode !== 'draft') || QSEL === 'all')) meta.appendChild(el('span', 'chip q q-' + p.queue, queueLabel(p.queue)));
    if (p.media) meta.appendChild(el('span', 'chip media', mediaSummary(p.media)));
    if (mode !== 'posted' && hasPlaceholders(p.text)) meta.appendChild(el('span', 'chip warn', 'has [placeholders]'));
    var fcFailed = mode === 'posted' && /^failed/.test(p.first_comment_status || '');
    if (mode !== 'posted' && p.first_comment) meta.appendChild(el('span', 'chip', '+ first comment'));
    if (mode === 'posted' && p.first_comment_status === 'posted') meta.appendChild(el('span', 'chip ok', 'comment posted'));
    if (fcFailed) meta.appendChild(el('span', 'chip warn', 'comment failed'));
    collapsed.appendChild(meta);

    var sr = el('div', 'sniprow');
    sr.appendChild(el('div', 'snippet' + (p.text && p.text.trim() ? '' : ' muted'), snippet(p.text)));
    var th = collapsedThumb(p.media); if (th) sr.appendChild(th);
    collapsed.appendChild(sr);
    if (mode === 'attention' && p.last_error) collapsed.appendChild(el('div', 'hint', 'LinkedIn said: ' + p.last_error + ' · Check your feed before sending it back, it may have gone out.'));

    var acts = el('div', 'btns'); acts.style.marginTop = '10px';
    var prev = el('button', 'ghost', '👁 Preview');
    prev.onclick = function () { togglePreview(prev, previewPanel, p); };

    if (mode === 'posted') {
      if (p.post_url) {
        var a = el('a', '', 'View on LinkedIn ↗'); a.href = p.post_url; a.target = '_blank'; a.rel = 'noopener';
        a.style.cssText = 'background:#ececea;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;text-decoration:none;color:var(--ink)';
        acts.appendChild(a);
      }
      acts.appendChild(prev);
      if (fcFailed && p.first_comment) {
        var retry = el('button', '', 'Retry comment');
        retry.onclick = function () {
          retry.disabled = true;
          api('POST', '/api/posts/' + p.id + '/comment', {}, function (r) {
            toast(r.first_comment_status === 'posted' ? 'Comment posted' : 'Still failing: ' + r.first_comment_status);
            api('GET', '/api/state', null, refresh);
          });
        };
        acts.appendChild(retry);
      }
      collapsed.appendChild(acts);
      if (fcFailed) collapsed.appendChild(el('div', 'hint', 'First comment did not post. LinkedIn said: ' + p.first_comment_status.replace(/^failed: /, '')));
      collapsed.appendChild(previewPanel);
      c.appendChild(collapsed); return c;
    }

    var edit = el('button', '', '✎ Edit');
    edit.onclick = function () { collapsed.style.display = 'none'; expanded.style.display = 'block'; };
    acts.appendChild(edit);
    acts.appendChild(prev);
    // "Post now" is a deliberate two-step: it reveals a separate red confirm bar,
    // so a single stray click can never publish.
    var confirmBar = el('div', 'btns'); confirmBar.style.marginTop = '10px'; confirmBar.style.display = 'none';
    if (mode === 'approved') {
      var now = el('button', 'ghost', 'Post now…'); now.style.marginLeft = 'auto';
      now.onclick = function () { acts.style.display = 'none'; confirmBar.style.display = 'flex'; };
      acts.appendChild(now);
      var warn = hasPlaceholders(p.text);
      var cy = el('button', 'danger', warn ? '⚠ Publish WITH [placeholders]' : '⚠ Publish to LinkedIn now');
      cy.onclick = function () { cy.disabled = true; api('POST', '/api/posts/' + p.id + '/publish', { force: warn }, function (d) { refresh(d); toast('Published to LinkedIn'); }); };
      var cn = el('button', '', 'Cancel'); cn.onclick = function () { confirmBar.style.display = 'none'; acts.style.display = 'flex'; };
      confirmBar.appendChild(cn); confirmBar.appendChild(cy);
    }
    if (mode === 'attention' && p.status === 'failed') {
      var back = el('button', 'primary', 'Back to queue');
      back.onclick = function () { api('PUT', '/api/posts/' + p.id, { status: 'approved' }, function (d) { refresh(d); toast('Back at the end of its queue'); }); };
      acts.appendChild(back);
    }
    if (mode === 'draft' || mode === 'skipped') {
      var appr = el('button', 'primary qfill', 'Approve for ' + dayPlural(p.queue));
      appr.onclick = function () { api('PUT', '/api/posts/' + p.id, { status: 'approved' }, function (d) { refresh(d); toast('Approved & queued'); }); };
      acts.appendChild(appr);
    }
    collapsed.appendChild(acts);
    collapsed.appendChild(confirmBar);
    collapsed.appendChild(previewPanel);

    var ta = el('textarea'); ta.value = p.text; expanded.appendChild(ta);
    attachCounter(expanded, ta);
    expanded.appendChild(el('label', 'fclabel', 'First comment (optional) · posted right after the post goes live'));
    var fcta = el('textarea', 'fc'); fcta.value = p.first_comment || ''; fcta.placeholder = 'Sources, a link, or anything that should not sit in the post body'; fcta.maxLength = 1250;
    expanded.appendChild(fcta);
    expanded.appendChild(attachControls(p.media, function (spec) { api('PUT', '/api/posts/' + p.id, { media: spec }, function (d) { DATA = d; }); }));
    var qrow = el('div', 'row'); qrow.style.marginTop = '8px';
    qrow.appendChild(el('label', '', 'Queue'));
    var qsel = queueSelect(p.queue);
    qsel.onchange = function () { api('PUT', '/api/posts/' + p.id, { queue: qsel.value }, function (d) { refresh(d); toast('Moved to ' + queueLabel(qsel.value)); }); };
    qrow.appendChild(qsel); expanded.appendChild(qrow);
    if (inFunnel(p.queue)) expanded.appendChild(stagePicker(p.stage, function (k) { api('PUT', '/api/posts/' + p.id, { stage: k }, function (d) { DATA = d; toast(k ? 'Stage set to ' + STAGE_INFO[k][0] : 'Stage cleared'); }); }));
    var eb = el('div', 'btns'); eb.style.marginTop = '10px';
    var save = el('button', 'primary', 'Save & close');
    save.onclick = function () { api('PUT', '/api/posts/' + p.id, { text: ta.value, first_comment: fcta.value }, function (d) { refresh(d); toast('Saved'); }); };
    eb.appendChild(save);
    if (mode === 'approved') {
      var unq = el('button', '', 'Unqueue'); unq.onclick = function () { api('PUT', '/api/posts/' + p.id, { status: 'draft' }, refresh); }; eb.appendChild(unq);
      var skip = el('button', 'ghost', 'Skip'); skip.onclick = function () { api('PUT', '/api/posts/' + p.id, { status: 'skipped' }, refresh); }; eb.appendChild(skip);
    }
    if (mode === 'attention') { var todraft = el('button', '', 'Move to drafts'); todraft.onclick = function () { api('PUT', '/api/posts/' + p.id, { status: 'draft' }, refresh); }; eb.appendChild(todraft); }
    if (mode === 'draft') { var del = el('button', 'ghost', 'Delete'); del.onclick = function () { if (confirm('Delete this draft?')) api('DELETE', '/api/posts/' + p.id, null, refresh); }; eb.appendChild(del); }
    if (mode === 'skipped') { var res = el('button', '', 'Restore to draft'); res.onclick = function () { api('PUT', '/api/posts/' + p.id, { status: 'draft' }, refresh); }; eb.appendChild(res); }
    var close = el('button', 'ghost', 'Close'); close.onclick = function () { expanded.style.display = 'none'; collapsed.style.display = 'block'; }; eb.appendChild(close);
    expanded.appendChild(eb);

    c.appendChild(collapsed); c.appendChild(expanded);
    return c;
  }

  function queueCard(p, i, total) {
    var rowWrap = el('div', 'queuerow q-' + (p.queue || 'engineers'));
    rowWrap.appendChild(el('div', 'queuenum', String(i + 1)));
    var body = el('div', 'queuebody'); body.appendChild(postCard(p, 'approved')); rowWrap.appendChild(body);
    var reorder = el('div', 'reorder');
    var up = el('button', 'icon', '▲'); up.disabled = i === 0;
    up.onclick = function () { api('POST', '/api/posts/' + p.id + '/move', { dir: 'up' }, refresh); };
    var down = el('button', 'icon', '▼'); down.disabled = i === total - 1;
    down.onclick = function () { api('POST', '/api/posts/' + p.id + '/move', { dir: 'down' }, refresh); };
    reorder.appendChild(up); reorder.appendChild(down); rowWrap.appendChild(reorder);
    return rowWrap;
  }

  function composer() {
    var wrap = el('div', 'q-' + QSEL);
    if (!COMPOSER_OPEN) {
      var open = el('button', 'newpost', QSEL === 'all' ? '+ New post' : '+ New post in ' + queueOf(QSEL).label);
      open.onclick = function () { COMPOSER_OPEN = true; render(); };
      wrap.appendChild(open);
      return wrap;
    }
    wrap.appendChild(el('div', 'section-head', 'New post'));
    var c = el('div', 'card');
    var ta = el('textarea'); ta.placeholder = 'Paste your post text here…\n\n**bold** becomes unicode bold · "* " or "- " lines become • bullets (see Preview)\n(Bulk text: separate multiple posts with a line containing only ---)';
    c.appendChild(ta);
    attachCounter(c, ta);

    var pendingMedia = null;
    var prevWrap = el('div');
    var prevBtn = el('button', 'ghost', '👁 Preview'); prevBtn.style.padding = '4px 0';
    var shown = false;
    function drawPreview() { prevWrap.innerHTML = ''; if (shown) prevWrap.appendChild(feedPreview(ta.value, pendingMedia, fcta.value)); }
    c.appendChild(attachControls(null, function (spec) { pendingMedia = spec; drawPreview(); }));
    prevBtn.onclick = function () { shown = !shown; prevBtn.textContent = shown ? '✕ Hide preview' : '👁 Preview'; drawPreview(); };
    ta.addEventListener('input', function () { if (shown) drawPreview(); });
    c.appendChild(el('label', 'fclabel', 'First comment (optional) · posted right after the post goes live'));
    var fcta = el('textarea', 'fc'); fcta.placeholder = 'Sources, a link, or anything that should not sit in the post body'; fcta.maxLength = 1250;
    fcta.addEventListener('input', function () { if (shown) drawPreview(); });
    c.appendChild(fcta);
    c.appendChild(prevBtn); c.appendChild(prevWrap);

    function chunks() { return ta.value.split(/\n[ \t]*---[ \t]*\n/).map(function (s) { return s.trim(); }).filter(Boolean); }
    function addAll(approve) {
      var list = chunks();
      if (!list.length && !pendingMedia) return toast('Add text or media');
      if (!list.length && pendingMedia) list = ['']; // media-only post
      if (list.length > 1 && pendingMedia) return toast('Media attaches to a single post — remove extra --- splits');
      var i = 0;
      (function next() {
        if (i >= list.length) { if (QSEL !== 'all') setQ(qpick.value); COMPOSER_OPEN = false; location.reload(); return; }
        var payload = { text: list[i], approve: approve, queue: qpick.value, stage: inFunnel(qpick.value) ? stagePick.value : null };
        if (i === 0 && pendingMedia) payload.media = pendingMedia;
        if (i === 0 && fcta.value.trim()) payload.first_comment = fcta.value;
        api('POST', '/api/posts', payload, function (d) { DATA = d; i++; next(); });
      })();
    }
    var qprow = el('div', 'row'); qprow.style.marginTop = '10px';
    qprow.appendChild(el('label', '', 'Goes to'));
    var pills = el('div', 'pills');
    var qpick = { value: QSEL === 'all' ? DATA.queues[0].key : QSEL };
    DATA.queues.forEach(function (q) {
      var b = el('button', 'pill q-' + q.key + (q.key === qpick.value ? ' active' : ''));
      b.appendChild(el('span', '', q.label + ' · ' + DAYS[q.settings.post_day].slice(0, 3)));
      b.onclick = function () { qpick.value = q.key; Array.prototype.forEach.call(pills.children, function (x) { x.classList.remove('active'); }); b.classList.add('active'); paintStage(); };
      pills.appendChild(b);
    });
    qprow.appendChild(pills); c.appendChild(qprow);
    var stagePick = { value: null };
    var stageRow = stagePicker(null, function (k) { stagePick.value = k; });
    function paintStage() { stageRow.style.display = inFunnel(qpick.value) ? '' : 'none'; }
    paintStage();
    c.appendChild(stageRow);
    var btns = el('div', 'btns'); btns.style.marginTop = '10px';
    var d = el('button', '', 'Add as draft'); d.onclick = function () { addAll(false); }; btns.appendChild(d);
    var a = el('button', 'primary', 'Add & approve'); a.onclick = function () { addAll(true); }; btns.appendChild(a);
    c.appendChild(btns);
    wrap.appendChild(c);
    return wrap;
  }

  function settingsPanel() {
    var wrap = el('div');
    DATA.queues.forEach(function (q) {
      var sh = el('div', 'section-head q-' + q.key); sh.style.display = 'flex'; sh.style.alignItems = 'center'; sh.style.gap = '8px';
      sh.appendChild(el('span', 'qdot')); sh.appendChild(el('span', '', q.label + ' queue'));
      wrap.appendChild(sh);
      var card = el('div', 'card q-' + q.key);
      var row = el('div', 'row');
      row.appendChild(el('label', '', 'Every'));
      var daySel = el('select');
      DAYS.forEach(function (dn, i) { var o = el('option', '', dn); o.value = String(i); if (i === q.settings.post_day) o.selected = true; daySel.appendChild(o); });
      row.appendChild(daySel);
      row.appendChild(el('label', '', 'at'));
      var hourSel = el('select');
      for (var h = 5; h <= 22; h++) { var o = el('option', '', String(h).padStart(2, '0') + ':00'); o.value = String(h); if (h === q.settings.post_hour) o.selected = true; hourSel.appendChild(o); }
      row.appendChild(hourSel);
      row.appendChild(el('label', '', 'Bucharest,'));
      var cadSel = el('select');
      [[1, 'every week'], [2, 'every 2 weeks'], [3, 'every 3 weeks'], [4, 'every 4 weeks']].forEach(function (opt) {
        var o = el('option', '', opt[1]); o.value = String(opt[0]); if (opt[0] === q.settings.cadence_weeks) o.selected = true; cadSel.appendChild(o);
      });
      row.appendChild(cadSel);
      card.appendChild(row);
      var live = el('div', 'reach'); live.style.background = 'var(--q-soft)'; live.style.color = 'var(--q)';
      function paint() { live.textContent = 'Reaches: ' + reachLabel(Number(daySel.value), Number(hourSel.value)); }
      daySel.onchange = paint; hourSel.onchange = paint; paint();
      card.appendChild(live);
      var sr = el('div', 'btns'); sr.style.marginTop = '10px';
      var save = el('button', 'primary qfill', 'Save ' + q.label + ' schedule');
      save.onclick = function () {
        api('POST', '/api/settings', { queue: q.key, post_day: Number(daySel.value), post_hour: Number(hourSel.value), cadence_weeks: Number(cadSel.value) }, function (d) { refresh(d); toast(q.label + ' schedule saved'); });
      };
      sr.appendChild(save); card.appendChild(sr);
      card.appendChild(el('div', 'hint', 'Cadence counts from the last post in this queue. A missed slot is skipped, and the post waits for the next one.'));
      wrap.appendChild(card);
    });

    wrap.appendChild(el('div', 'section-head', 'Funnel mix target · GTM leaders'));
    var fm = el('div', 'card');
    var frow = el('div', 'row');
    frow.appendChild(el('label', '', 'Per 8 posts'));
    var tsel = {};
    ['tofu', 'mofu', 'bofu'].forEach(function (k) {
      frow.appendChild(el('label', '', STAGE_INFO[k][0]));
      var sel = el('select');
      for (var n = 0; n <= 8; n++) { var o = el('option', '', String(n)); o.value = String(n); if (n === DATA.settings.stage_target[k]) o.selected = true; sel.appendChild(o); }
      tsel[k] = sel; frow.appendChild(sel);
    });
    fm.appendChild(frow);
    var fb = el('div', 'btns');
    var fsave = el('button', 'primary', 'Save mix');
    fsave.onclick = function () {
      api('POST', '/api/settings', { stage_target: { tofu: Number(tsel.tofu.value), mofu: Number(tsel.mofu.value), bofu: Number(tsel.bofu.value) } }, function (d) { refresh(d); toast('Mix saved'); });
    };
    fb.appendChild(fsave); fm.appendChild(fb);
    fm.appendChild(el('div', 'hint', 'TOFU builds reach, MOFU builds trust, BOFU makes the ask. The content plan uses 3, 4 and 1. The Queue tab compares your next 8 GTM leaders posts with this mix. Engineer posts are reach. They sit outside the funnel.'));
    wrap.appendChild(fm);

    wrap.appendChild(el('div', 'section-head', 'LinkedIn connection'));
    var t = el('div', 'card');
    var tokenLine = DATA.token.set
      ? 'Token saved' + (DATA.token.ageDays !== null ? ' · ' + DATA.token.ageDays + ' days old (expires ~60)' : '') + (DATA.token.ageDays !== null && DATA.token.ageDays > 45 ? ' — renew soon' : '')
      : 'No token set — publishing and media upload are disabled.';
    var tl = el('div', 'row'); tl.appendChild(el('span', DATA.token.ageDays !== null && DATA.token.ageDays > 45 ? 'chip warn' : 'chip ok', DATA.token.set ? 'connected' : 'not set')); tl.appendChild(el('span', '', tokenLine));
    t.appendChild(tl);
    var oa = el('div', 'btns'); oa.style.margin = '10px 0';
    var cb = el('button', 'primary', '🔗 Connect LinkedIn');
    cb.onclick = function () { api('POST', '/api/oauth/start', {}, function (d) { window.location.href = d.url; }); };
    oa.appendChild(cb);
    oa.appendChild(el('span', 'note', 'one-click renewal — approve on LinkedIn, done'));
    t.appendChild(oa);
    var tin = el('input'); tin.type = 'password'; tin.placeholder = 'Or paste a token manually (fallback)'; tin.style.width = '100%';
    var tinWrap = el('div'); tinWrap.style.margin = '8px 0'; tinWrap.appendChild(tin); t.appendChild(tinWrap);
    var tb = el('div', 'btns');
    var st = el('button', 'primary', 'Save token'); st.onclick = function () { api('POST', '/api/token', { token: tin.value }, function (d) { refresh(d); toast('Token saved (encrypted)'); }); };
    tb.appendChild(st);
    var test = el('button', '', 'Test connection'); test.onclick = function () { api('POST', '/api/token/test', {}, function (d) { toast(d.message); }); };
    tb.appendChild(test); t.appendChild(tb);
    t.appendChild(el('div', 'hint', 'Token encrypted at rest (AES-256-GCM). Scopes: openid, profile, w_member_social. Media is uploaded to LinkedIn the moment you attach it, so a valid token is required to attach photos/carousels/video.'));
    wrap.appendChild(t);

    wrap.appendChild(el('div', 'section-head', 'Rules'));
    var g = el('div', 'card');
    var grow = el('div', 'row');
    grow.appendChild(el('label', '', 'Minimum time between any two posts'));
    var gapSel = el('select');
    [12, 18, 24, 36, 48].forEach(function (n) { var o = el('option', '', n + ' hours'); o.value = String(n); if (n === DATA.settings.min_gap_hours) o.selected = true; gapSel.appendChild(o); });
    grow.appendChild(gapSel);
    gapSel.onchange = function () { api('POST', '/api/settings', { min_gap_hours: Number(gapSel.value) }, function (d) { refresh(d); toast('Saved'); }); };
    g.appendChild(grow);
    g.appendChild(el('div', 'hint', 'Applies across both queues. Two posts within about 18 hours cut each other\'s reach, so 24 hours is the default. Each slot can publish only once, even if a check runs twice.'));
    wrap.appendChild(g);

    var out = el('button', 'ghost', 'Sign out'); out.style.marginTop = '6px';
    out.onclick = function () { fetch('/api/logout', { method: 'POST' }).then(showLogin); };
    wrap.appendChild(out);
    return wrap;
  }

  // The next slots of both queues in date order. An empty slot is shown as an
  // open row that leads to that queue's drafts, so no slot goes out empty by accident.
  function comingUp() {
    var rows = [];
    DATA.queues.forEach(function (q) {
      q.slots.forEach(function (sl, i) { rows.push({ q: q, iso: sl.iso, label: sl.label, post: q.approved[i] || null }); });
    });
    rows.sort(function (a, b) { return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0; });
    // "all": every queued post plus the open slots between them; default: the next two weeks
    var lastPosted = rows.filter(function (r) { return r.post; }).reduce(function (m, r) { return r.iso > m ? r.iso : m; }, '');
    var allRows = rows.filter(function (r) { return r.post || r.iso <= lastPosted; });
    var horizon = rows.length ? new Date(rows[0].iso).getTime() + 15 * 86400000 : 0;
    var shortRows = rows.filter(function (r) { return new Date(r.iso).getTime() <= horizon; }).slice(0, 6);
    var box = el('div', 'upnext');
    var head = el('div', 'uphead'); head.appendChild(el('span', '', 'Coming up'));
    if (allRows.length > shortRows.length || UP_ALL) {
      var tg = el('button', 'toggle', UP_ALL ? 'Show next 2 weeks' : 'Show all (' + allRows.length + ')');
      tg.onclick = function () { UP_ALL = !UP_ALL; try { localStorage.setItem('up_all', UP_ALL ? '1' : '0'); } catch (e) {} render(); };
      head.appendChild(tg);
    }
    box.appendChild(head);
    rows = UP_ALL ? (allRows.length ? allRows : shortRows) : shortRows;
    var dfmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest', weekday: 'short', day: 'numeric', month: 'short' });
    rows.forEach(function (r) {
      var row = el('div', 'uprow q-' + r.q.key + (r.post ? '' : ' open'));
      row.tabIndex = 0;
      var parts = dfmt.formatToParts(new Date(r.iso)); var p = {};
      parts.forEach(function (x) { p[x.type] = x.value; });
      var dt = el('div', 'updt'); dt.appendChild(el('b', '', p.weekday)); dt.appendChild(el('span', '', p.day + ' ' + p.month));
      row.appendChild(dt);
      row.appendChild(el('div', 'uplane'));
      var body = el('div', 'upbody');
      var qline = el('div', 'upq', r.q.label);
      if (r.post) qline.appendChild(el('span', 'st', stageLabel(r.post)));
      body.appendChild(qline);
      body.appendChild(el('div', 'uptext', r.post ? (snippet(r.post.text).split('\n')[0] || 'Media post') : 'Nothing scheduled'));
      row.appendChild(body);
      row.appendChild(el('div', 'go' + (r.post ? ' time' : ''), r.post ? String(r.q.settings.post_hour).padStart(2, '0') + ':00' : 'Pick a draft →'));
      function go() { setQ(r.q.key); TAB = r.post ? 'queue' : 'drafts'; render(); }
      row.onclick = go;
      row.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      box.appendChild(row);
    });
    box.appendChild(funnelMix());
    return box;
  }

  // The next 8 queued GTM leaders posts, by date, against the target mix.
  // Engineer posts are reach and sit outside the funnel, so they are not counted.
  function funnelMix() {
    var all = [];
    DATA.queues.forEach(function (q) { if (!inFunnel(q.key)) return; q.approved.forEach(function (p, i) { if (q.slots[i]) all.push({ iso: q.slots[i].iso, p: p, q: q }); }); });
    all.sort(function (a, b) { return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0; });
    var next = all.slice(0, 8);
    var c = { tofu: 0, mofu: 0, bofu: 0, none: 0 };
    next.forEach(function (x) { c[x.p.stage && STAGE_INFO[x.p.stage] ? x.p.stage : 'none']++; });
    var t = DATA.settings.stage_target;
    var wrap = el('div', 'mix');
    wrap.appendChild(el('div', '', 'Funnel mix · ' + queueLabel(FUNNEL_Q)));
    wrap.appendChild(el('div', 'mixhelp', 'Engineer posts are reach. They sit outside the funnel.'));
    var bar = el('div', 'mixbar');
    ['tofu', 'mofu', 'bofu', 'none'].forEach(function (k) { if (c[k]) { var s = el('span', k); s.style.flex = String(c[k]); bar.appendChild(s); } });
    wrap.appendChild(bar);
    var row = el('div', 'mixrow');
    row.appendChild(el('span', '', next.length ? 'Next ' + next.length + ' queued:' : 'Nothing queued yet.'));
    ['tofu', 'mofu', 'bofu'].forEach(function (k) {
      var it = el('span'); var sw = el('i'); sw.className = ''; sw.style.background = k === 'tofu' ? '#b9b3a8' : k === 'mofu' ? '#6f6a61' : '#1b1b1b';
      it.appendChild(sw); it.appendChild(el('b', '', STAGE_INFO[k][0] + ' ' + c[k])); it.appendChild(el('span', '', ' / ' + t[k]));
      row.appendChild(it);
    });
    if (c.none) row.appendChild(el('span', '', c.none + ' without a stage'));
    wrap.appendChild(row);
    var past = DATA.posted.filter(function (x) { return inFunnel(x.queue); }).slice(0, 8), pc = { tofu: 0, mofu: 0, bofu: 0, none: 0 };
    past.forEach(function (x) { pc[x.stage && STAGE_INFO[x.stage] ? x.stage : 'none']++; });
    if (past.length) {
      var prow = el('div', 'mixrow past');
      prow.appendChild(el('span', '', 'Last ' + past.length + ' published:'));
      ['tofu', 'mofu', 'bofu'].forEach(function (k) { prow.appendChild(el('span', '', STAGE_INFO[k][0] + ' ' + pc[k])); });
      if (pc.none) prow.appendChild(el('span', '', pc.none + ' untagged'));
      wrap.appendChild(prow);
    }
    // one nudge at most: the stage furthest below its target, scaled to how many posts are queued
    var scale = next.length / 8, worst = null, gapMax = 0;
    ['bofu', 'mofu', 'tofu'].forEach(function (k) { var want = Math.round(t[k] * scale), g = want - c[k]; if (g > gapMax) { gapMax = g; worst = k; } });
    var note = null;
    if (c.none) note = 'Tag the ' + c.none + ' untagged post' + (c.none > 1 ? 's' : '') + ' to see the real mix.';
    else if (worst) note = 'Add ' + gapMax + ' ' + STAGE_INFO[worst][0] + ' post' + (gapMax > 1 ? 's' : '') + ' to match your mix (' + STAGE_INFO[worst][1] + ').';
    if (note && next.length) wrap.appendChild(el('div', 'mixnote', note));
    return wrap;
  }

  // ---------------------------------------------------------------
  // Analytics: import LinkedIn's creator analytics export (.xlsx)
  // ---------------------------------------------------------------
  var AN = null; // /api/analytics payload, loaded when the tab first opens
  var AN_WIN = 28;
  try { AN_WIN = Number(localStorage.getItem('an_win')) || 28; } catch (e) {}
  var OTHER_OPEN = false;
  function loadAnalytics() { api('GET', '/api/analytics', null, function (d) { AN = d; if (TAB === 'analytics') render(); }); }

  // An .xlsx is a zip of XML parts. Read the zip's central directory, inflate
  // the parts we need with DecompressionStream, and parse them with DOMParser.
  function unzip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), eocd = -1, dec = new TextDecoder();
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('Not an .xlsx file');
    var n = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), files = {};
    for (var k = 0; k < n; k++) {
      var nlen = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
      var start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      files[dec.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method: dv.getUint16(p + 10, true), data: u8.subarray(start, start + dv.getUint32(p + 20, true)) };
      p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return files;
  }
  function inflateText(f) {
    if (!f) return Promise.resolve(null);
    if (f.method === 0) return Promise.resolve(new TextDecoder().decode(f.data));
    return new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }
  function colIndex(ref) { var m = /^[A-Z]+/.exec(ref || 'A'), n = 0; for (var i = 0; i < m[0].length; i++) n = n * 26 + m[0].charCodeAt(i) - 64; return n - 1; }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  // Returns { SHEET NAME: [[cell, cell, ...], ...] } with cells at their real column index.
  function readXlsx(buf) {
    var files = unzip(buf);
    function xml(s) { return new DOMParser().parseFromString(s, 'application/xml'); }
    return Promise.all([inflateText(files['xl/workbook.xml']), inflateText(files['xl/_rels/workbook.xml.rels']), inflateText(files['xl/sharedStrings.xml'])]).then(function (r) {
      if (!r[0]) throw new Error('Not an Excel workbook');
      var rels = {}, ss = [];
      if (r[1]) each(xml(r[1]).getElementsByTagName('Relationship'), function (x) { rels[x.getAttribute('Id')] = x.getAttribute('Target'); });
      if (r[2]) each(xml(r[2]).getElementsByTagName('si'), function (si) { var t = ''; each(si.getElementsByTagName('t'), function (x) { t += x.textContent; }); ss.push(t); });
      var sheets = Array.prototype.map.call(xml(r[0]).getElementsByTagName('sheet'), function (s, i) {
        var target = (rels[s.getAttribute('r:id')] || 'worksheets/sheet' + (i + 1) + '.xml').replace(/^\//, '').replace(/^xl\//, '');
        return { name: s.getAttribute('name'), path: 'xl/' + target };
      });
      return Promise.all(sheets.map(function (s) { return inflateText(files[s.path]); })).then(function (texts) {
        var book = {};
        sheets.forEach(function (s, i) {
          var rows = [];
          if (texts[i]) each(xml(texts[i]).getElementsByTagName('row'), function (row) {
            var vals = [];
            each(row.getElementsByTagName('c'), function (c) {
              var t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0];
              vals[colIndex(c.getAttribute('r'))] = t === 's' ? ss[Number(v.textContent)] : t === 'inlineStr' ? c.textContent : v ? v.textContent : '';
            });
            rows.push(vals);
          });
          book[String(s.name).toUpperCase()] = rows;
        });
        return book;
      });
    });
  }
  function isoDate(v) {
    if (v === undefined || v === null || v === '') return null;
    var s = String(v).trim(), m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Math.round((Number(s) - 25569) * 86400000)).toISOString().slice(0, 10); // Excel serial date
    return null;
  }
  function num(v) { if (v === undefined || v === null || v === '') return null; var n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; }
  // "5%" -> 5; "< 1%" -> under one percent; a bare fraction (0.05) as Excel may store it -> 5
  function parsePct(v) {
    var s = String(v === undefined || v === null ? '' : v).trim();
    if (/^<\s*1\s*%$/.test(s)) return { pct: 0.5, lt1: true };
    var m = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
    if (m) return { pct: Number(m[1]), lt1: false };
    var n = num(s);
    return n === null ? null : { pct: n <= 1 ? n * 100 : n, lt1: false };
  }
  // DEMOGRAPHICS sheets: header row, then category | value | percentage
  function demoSheet(rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      var p = parsePct(r[2]);
      if (!r[0] || !r[1] || !p || r[0] === 'Top Demographics') return;
      out.push({ category: String(r[0]).trim(), label: String(r[1]).trim(), pct: p.pct, lt1: p.lt1 });
    });
    return out;
  }
  // Sheets of LinkedIn's export: DISCOVERY (range + totals), ENGAGEMENT (daily),
  // TOP POSTS (two side-by-side lists: by engagements in A-C, by impressions in E-G),
  // FOLLOWERS (total + daily new followers), AUDIENCE / CONTENT DEMOGRAPHICS
  // (top values per category for followers / for people who saw posts).
  function parseExport(book, fileName) {
    var out = { file_name: fileName, daily: [], followers_daily: [], posts: [] };
    (book['DISCOVERY'] || []).forEach(function (r) {
      if (r[0] === 'Overall Performance' && r[1]) { var m = String(r[1]).split(' - '); out.range_start = isoDate(m[0]); out.range_end = isoDate(m[1]); }
      if (r[0] === 'Impressions') out.impressions = num(r[1]);
      if (r[0] === 'Members reached') out.members_reached = num(r[1]);
    });
    (book['ENGAGEMENT'] || []).forEach(function (r) { var d = isoDate(r[0]); if (d) out.daily.push({ date: d, impressions: num(r[1]), engagements: num(r[2]) }); });
    (book['FOLLOWERS'] || []).forEach(function (r) {
      if (/^Total followers/.test(r[0] || '')) out.followers = num(r[1]);
      var d = isoDate(r[0]); if (d) out.followers_daily.push({ date: d, new_followers: num(r[1]) });
    });
    var posts = {};
    function add(url, date, key, val) {
      if (!/^https:\/\/www\.linkedin\.com\//.test(url || '')) return;
      var p = posts[url] || (posts[url] = { url: url, publish_date: isoDate(date), impressions: null, engagements: null });
      p[key] = num(val);
    }
    var engRows = 0;
    (book['TOP POSTS'] || []).forEach(function (r) {
      if (/^https:/.test(r[0] || '')) engRows++;
      add(r[0], r[1], 'engagements', r[2]); add(r[4], r[5], 'impressions', r[6]);
    });
    out.posts = Object.keys(posts).map(function (k) { return posts[k]; });
    out.demographics = { followers: demoSheet(book['AUDIENCE DEMOGRAPHICS']), viewers: demoSheet(book['CONTENT DEMOGRAPHICS']) };
    // The engagements list stops at 50 rows. Shorter than that, it holds every post
    // with at least one engagement, so a post missing from it had none.
    if (engRows < 50) out.posts.forEach(function (p) { if (p.engagements === null) p.engagements = 0; });
    if (!out.range_start || !out.range_end) throw new Error('This does not look like a LinkedIn analytics export');
    return out;
  }
  // A single post's export (Post analytics → Export): its numbers plus who saw it.
  // Sheet "Post analytics": label/value rows, then "Post viewer demographics" rows of category/value/%.
  function parseSinglePost(book) {
    var rows = book['POST ANALYTICS'] || [], it = {}, demo = [], inDemo = false;
    var KEYS = { 'Impressions': 'impressions', 'Members reached': 'members_reached', 'Profile viewers from this post': 'profile_viewers', 'Followers gained from this post': 'followers_gained',
      'Reactions': 'reactions', 'Comments': 'comments', 'Reposts': 'reposts', 'Saves': 'saves', 'Sends on LinkedIn': 'sends' };
    rows.forEach(function (r) {
      var a = r[0], b = r[1];
      if (a === 'Post URL') { var m = /(\d{19})(?!.*\d{19})/.exec(b || ''); if (m) it.id = m[1]; }
      if (a === 'Post viewer demographics') { inDemo = true; return; }
      if (inDemo && a && a !== 'Category' && r[2] !== undefined) {
        var s = String(r[2]).trim(), lt1 = /^</.test(s);
        demo.push({ category: a, label: String(b), pct: lt1 ? 0.5 : num(s.replace('%', '')), lt1: lt1 });
      } else if (KEYS[a]) it[KEYS[a]] = num(b);
    });
    if (!it.id) throw new Error('This post export has no post URL');
    it.demographics = demo.filter(function (d) { return d.pct !== null; });
    return { checked_on: new Date().toISOString().slice(0, 10), items: [it] };
  }
  function importFile(file) {
    if (!file) return;
    toast('Reading ' + file.name + '…');
    file.arrayBuffer().then(readXlsx).then(function (book) {
      if (book['POST ANALYTICS']) {
        var one = parseSinglePost(book);
        api('POST', '/api/analytics/page-stats', one, function (d) { AN = d; render(); toast('Saved who saw this post, and its numbers'); });
        return;
      }
      var payload = parseExport(book, file.name);
      api('POST', '/api/analytics/import', payload, function (d) {
        AN = d; render();
        toast('Imported ' + payload.posts.length + ' posts and ' + payload.daily.length + ' days');
      });
    }).catch(function (e) { toast(e.message || String(e)); });
  }

  var NF = new Intl.NumberFormat('en-US');
  var NC = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  var DFD = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  function fmtDay(iso) { return DFD.format(new Date(iso + 'T00:00:00Z')); }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function svgEl(tag, attrs) { var e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  // axis top with 4 even steps; small counts (followers per day) stay on whole numbers
  function niceMax(v) {
    if (v <= 0) return 4;
    if (v <= 20) return Math.ceil(v / 4) * 4;
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 8 ? 8 : 10) * p;
  }

  // ---------------------------------------------------------------
  // Insights. The page answers "what should I write next?" first and
  // keeps history below it (Few: the decision gets the top of the page).
  // Every number is compared with something (Few, Tufte); posts are
  // judged against the creator's own median, never an average, so the
  // two viral posts cannot skew it; groups under MIN_N posts are shown
  // as hints only, since small groups land at both extremes by chance
  // (Wainer, "The Most Dangerous Equation").
  // ---------------------------------------------------------------
  var MIN_N = 5;          // fewer posts than this in a group: a hint, not a pattern
  var SETTLE_DAYS = 3;    // most posts fade before day 4 (van der Blom's "rocket" posts)
  var BASE_N = 20;        // baseline: median of the last 20 settled posts
  var COL = { engineers: '#0a66c2', gtm: '#d9581f', other: '#b3ada3' };
  var INK = '#1b1b1b', MUTED = '#6b6b6b', RULE = '#e8e5df', TRACK = '#f1efeb';
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WD_BUC = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/Bucharest' });

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function fmtX(x) {
    if (x === null || x === undefined) return '–';
    return (x >= 10 ? NF.format(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '')) + '×';
  }
  function fmtRate(r) { return r === null || r === undefined ? '–' : (r >= 10 ? Math.round(r) : r.toFixed(1).replace(/\.0$/, '')); }
  function pct(cur, prev) { return prev ? Math.round(100 * (cur - prev) / Math.abs(prev)) : null; }
  function queueName(q) { return q === 'gtm' ? 'GTM leaders' : q === 'engineers' ? 'Engineers' : 'Outside the scheduler'; }
  function colorOf(r) { return r.own ? COL[r.queue] || COL.engineers : COL.other; }
  function quote(s, n) { s = String(s || '').trim(); n = n || 70; return '“' + (s.length > n ? s.slice(0, n - 1).trim() + '…' : s) + '”'; }
  function weekStart(iso) { var d = new Date(iso + 'T00:00:00Z').getUTCDay(); return addDays(iso, -((d + 6) % 7)); }

  // One row per post with a lifetime number: scheduled posts (full text and
  // tags) plus older posts from the export (only the URL text and the date).
  function dataset() {
    var rows = [];
    AN.posts.forEach(function (p) {
      var m = p.metrics;
      if (!m || !m.lifetime || m.impressions === null) return;
      var date = new Date(p.posted_at).toISOString().slice(0, 10);
      var hook = (snippet(p.text).split('\n')[0] || 'Media post').trim();
      rows.push({ own: true, date: date, url: p.post_url, hook: hook, queue: p.queue, stage: p.stage || null, media: p.media_kind || 'text',
        wd: WD_BUC.format(new Date(p.posted_at)), imp: m.impressions, eng: m.engagements, age: daysBetween(date, m.as_of) });
    });
    AN.other.forEach(function (o) {
      if (!o.lifetime || o.impressions === null || !o.publish_date) return;
      rows.push({ own: false, date: o.publish_date, url: o.post_url, hook: postSlug(o.post_url).replace(/…$/, ''), queue: null,
        wd: WD[new Date(o.publish_date + 'T00:00:00Z').getUTCDay()], imp: o.impressions, eng: o.engagements, age: daysBetween(o.publish_date, o.as_of) });
    });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var settled = rows.filter(function (r) { return r.age >= SETTLE_DAYS; });
    var baseRows = settled.slice(-BASE_N);
    var base = median(baseRows.map(function (r) { return r.imp; })) || 1;
    rows.forEach(function (r) {
      r.settled = r.age >= SETTLE_DAYS;
      r.x = r.imp / base;
      r.rate = r.eng === null || !r.imp ? null : 1000 * r.eng / r.imp;
    });
    return { rows: rows, settled: settled, base: base, baseN: baseRows.length };
  }

  // Dimensions to compare. Tags exist only on scheduled posts; the weekday
  // is known for every post.
  function dimensions(D) {
    var own = D.settled.filter(function (r) { return r.own; });
    function group(rows, key, labels) {
      var g = {};
      rows.forEach(function (r) { var k = key(r); if (k === null || k === undefined) return; (g[k] = g[k] || []).push(r); });
      return Object.keys(g).map(function (k) {
        var xs = g[k].map(function (r) { return r.x; });
        return { key: k, label: labels && labels[k] || k, rows: g[k], n: g[k].length, med: median(xs) };
      }).sort(function (a, b) { return b.med - a.med; });
    }
    var dims = [
      { name: 'Audience', note: 'scheduled posts', groups: group(own, function (r) { return r.queue; }, { engineers: 'Engineers', gtm: 'GTM leaders' }) },
      { name: 'Format', note: 'scheduled posts', groups: group(own, function (r) { return r.media; }, { text: 'Text only', images: 'With image', document: 'Carousel / PDF', video: 'Video' }) },
      { name: 'Funnel stage', note: 'scheduled posts', groups: group(own, function (r) { return r.stage; }, { tofu: 'Reach (TOFU)', mofu: 'Trust (MOFU)', bofu: 'Ask (BOFU)' }) },
      { name: 'First line length', note: 'scheduled posts · short means 50 characters or less', groups: group(own, function (r) { return r.hook.length <= 50 ? 'short' : 'long'; }, { short: 'Short first line', long: 'Long first line' }) },
      { name: 'Day posted', note: 'all posts', groups: group(D.settled, function (r) { return r.wd; }) }
    ];
    return dims.filter(function (d) { return d.groups.length > 1; });
  }

  // The strongest difference where both sides have MIN_N posts, or null.
  function bestFinding(dims) {
    var best = null;
    dims.forEach(function (d) {
      var ok = d.groups.filter(function (g) { return g.n >= MIN_N; });
      if (ok.length < 2) return;
      var hi = ok[0], lo = ok[ok.length - 1], ratio = hi.med / lo.med;
      if (ratio >= 1.3 && (!best || ratio > best.ratio)) best = { dim: d, hi: hi, lo: lo, ratio: ratio };
    });
    return best;
  }

  // ---- shared chart pieces ------------------------------------------------
  function tipFor(holder) { var t = el('div', 'tip'); holder.appendChild(t); return t; }
  function showTip(tip, lines, x, y, W) {
    tip.innerHTML = '';
    lines.forEach(function (l, i) { tip.appendChild(el(i ? 'div' : 'b', i ? (/^(Click|Tap again) to open/.test(l) ? 'open' : '') : 'tt', l)); });
    tip.style.display = 'block';
    tip.style.left = Math.max(80, Math.min(W - 80, x)) + 'px';
    tip.style.top = Math.max(0, y - 10) + 'px';
  }
  function hideTip(tip) { tip.style.display = 'none'; }
  function postLines(r) {
    return [quote(r.hook, 60), fmtDay(r.date) + ' · ' + (r.own ? queueName(r.queue) : 'outside the scheduler'),
      NF.format(r.imp) + ' impressions · ' + fmtX(r.x) + ' your typical post',
      r.rate === null ? 'responses unknown' : NF.format(r.eng) + ' engagement' + (r.eng === 1 ? '' : 's') + ' · ' + fmtRate(r.rate) + ' per 1,000 views' + (r.settled ? '' : ' · still growing'),
      TOUCH ? 'Tap again to open the post' : 'Click to open the post'];
  }
  function text(svg, x, y, s, attrs) {
    var a = { x: x, y: y, 'font-size': 11, fill: MUTED }; for (var k in attrs || {}) a[k] = attrs[k];
    var t = svgEl('text', a); t.textContent = s; svg.appendChild(t); return t;
  }
  // nearest-point hover with a generous radius, so small marks are easy to hit
  // A mark with a url opens its post on click. On touch the first tap shows the
  // tooltip and a second tap on the same post opens it.
  var TOUCH = false;
  try { TOUCH = matchMedia('(hover: none)').matches; } catch (e) {}
  function nearestHover(svg, tip, pts, W, radius) {
    var cur = null, armed = null;
    function pick(e) {
      var b = svg.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top, best = null, bd = radius * radius;
      pts.forEach(function (p) { var d = (p.cx - mx) * (p.cx - mx) + (p.cy - my) * (p.cy - my) * (p.xOnly ? 0 : 1); if (d < bd) { bd = d; best = p; } });
      return best;
    }
    function show(best) {
      cur = best;
      pts.forEach(function (p) { if (p.mark) p.mark.setAttribute('opacity', best && p !== best ? 0.35 : 1); });
      svg.style.cursor = best && best.url ? 'pointer' : 'default';
      if (best) showTip(tip, best.lines, best.cx, best.ty, W); else hideTip(tip);
    }
    // Safari leaves pointerType off click events, so touch is decided per device
    svg.addEventListener('pointermove', function (e) { if (!TOUCH) show(pick(e)); });
    svg.addEventListener('pointerdown', function (e) { if (!TOUCH) return; var best = pick(e); armed = best && best === cur ? best : null; show(best); });
    svg.addEventListener('click', function (e) {
      var best = pick(e);
      if (!best || !best.url || (TOUCH && armed !== best)) return;
      window.open(best.url, '_blank', 'noopener');
    });
    svg.addEventListener('pointerleave', function () { if (!TOUCH) show(null); });
  }
  function later(holder, fn) { setTimeout(function () { holder.innerHTML = ''; fn(holder.clientWidth || 600); }, 0); }

  // ---- 1. every post as a multiple of the typical post --------------------
  function postsChart(holder, rows) {
    later(holder, function (W) {
      var H = 190, padL = 34, padR = 6, padT = 14, padB = 22, iw = W - padL - padR, ih = H - padT - padB, top = 3;
      var svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': 'Each post as a multiple of your typical post' });
      var base = padT + ih, n = rows.length, step = iw / Math.max(n, 1), bw = Math.max(3, Math.min(22, step - 3));
      function yAt(x) { return base - ih * Math.min(x, top) / top; }
      [0, 1, 2, 3].forEach(function (g) {
        svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: yAt(g), y2: yAt(g), stroke: g === 1 ? '#8f8a80' : g ? TRACK : '#d9d5ce', 'stroke-width': g === 1 ? 1.5 : 1 }));
        text(svg, padL - 6, yAt(g) + 4, g + '×', { 'text-anchor': 'end', fill: g === 1 ? INK : MUTED, 'font-weight': g === 1 ? 700 : 400 });
      });
      var pts = [], lastLabel = -99;
      rows.forEach(function (r, i) {
        var cx = padL + step * i + step / 2, x = cx - bw / 2, y = yAt(r.x), h = base - y, rad = Math.min(4, bw / 2, h);
        var mark = svgEl('path', { fill: colorOf(r), 'fill-opacity': r.settled ? 1 : 0.4,
          d: 'M' + x + ' ' + base + ' V' + (y + rad) + ' Q' + x + ' ' + y + ' ' + (x + rad) + ' ' + y + ' H' + (x + bw - rad) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + rad) + ' V' + base + ' Z' });
        svg.appendChild(mark);
        if (r.x > top && cx - lastLabel >= 30) { text(svg, cx, padT - 3, fmtX(r.x), { 'text-anchor': 'middle', fill: INK, 'font-weight': 700, 'font-size': 10 }); lastLabel = cx; }
        pts.push({ cx: cx, cy: y, ty: Math.max(y, padT), mark: mark, xOnly: true, lines: postLines(r), url: r.url });
      });
      if (n) {
        text(svg, padL + step / 2, H - 5, fmtDay(rows[0].date), { 'text-anchor': 'start' });
        text(svg, padL + step * (n - 0.5), H - 5, fmtDay(rows[n - 1].date), { 'text-anchor': 'end' });
      }
      holder.appendChild(svg);
      nearestHover(svg, tipFor(holder), pts, W, Math.max(step, 16));
    });
  }

  // ---- 2. groups compared: dot strip + median, log scale -------------------
  var LOG_MIN = 0.25, LOG_MAX = 4;
  function logPos(x, w) { var c = Math.min(LOG_MAX, Math.max(LOG_MIN, x)); return w * (Math.log(c / LOG_MIN) / Math.log(LOG_MAX / LOG_MIN)); }
  function groupRows(holder, dim) {
    later(holder, function (W) {
      var labelW = Math.min(170, Math.round(W * 0.36)), padR = 46, rowH = 34, axisH = 18, iw = W - labelW - padR;
      var H = axisH + rowH * dim.groups.length;
      var svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': dim.name + ' compared with your typical post' });
      [0.25, 0.5, 1, 2, 4].forEach(function (t) {
        var x = labelW + logPos(t, iw);
        svg.appendChild(svgEl('line', { x1: x, x2: x, y1: axisH - 4, y2: H, stroke: t === 1 ? '#8f8a80' : TRACK, 'stroke-width': t === 1 ? 1.5 : 1 }));
        text(svg, x, 11, t === 0.25 ? '¼×' : t === 0.5 ? '½×' : t + '×', { 'text-anchor': 'middle', fill: t === 1 ? INK : MUTED, 'font-weight': t === 1 ? 700 : 400, 'font-size': 10.5 });
      });
      var pts = [];
      dim.groups.forEach(function (g, i) {
        var cy = axisH + rowH * i + rowH / 2, solid = g.n >= MIN_N;
        text(svg, 0, cy - 2, g.label, { fill: solid ? INK : MUTED, 'font-size': 12.5, 'font-weight': 600 });
        text(svg, 0, cy + 12, g.n + ' post' + (g.n === 1 ? '' : 's') + (solid ? '' : ' · too few to tell'), { 'font-size': 10.5 });
        svg.appendChild(svgEl('line', { x1: labelW, x2: labelW + iw, y1: cy, y2: cy, stroke: RULE, 'stroke-width': 1 }));
        g.rows.forEach(function (r) {
          var cx = labelW + logPos(r.x, iw);
          var dot = svgEl('circle', { cx: cx, cy: cy, r: 4, fill: solid ? '#9db9d9' : '#cfcac2', stroke: '#fff', 'stroke-width': 1.5 });
          svg.appendChild(dot);
          pts.push({ cx: cx, cy: cy, ty: cy - 8, mark: dot, lines: postLines(r), url: r.url });
        });
        var mx = labelW + logPos(g.med, iw);
        svg.appendChild(svgEl('rect', { x: mx - 2, y: cy - 10, width: 4, height: 20, rx: 2, fill: solid ? (g.med >= 1 ? '#0a66c2' : INK) : '#a8a29a' }));
        text(svg, W, cy + 4, fmtX(g.med), { 'text-anchor': 'end', fill: solid ? INK : MUTED, 'font-weight': 700, 'font-size': 12.5 });
      });
      holder.appendChild(svg);
      nearestHover(svg, tipFor(holder), pts, W, 14);
    });
  }

  // ---- 3. reach vs response ------------------------------------------------
  function scatter(holder, rows, D) {
    later(holder, function (W) {
      var H = 270, padL = 34, padR = 8, padT = 22, padB = 30, iw = W - padL - padR, ih = H - padT - padB;
      var rates = rows.map(function (r) { return r.rate; });
      // scale to the 90th percentile so one outlier cannot flatten every other post; outliers sit on the top edge
      var sorted = rates.slice().sort(function (a, b) { return a - b; });
      var yMax = niceMax(Math.max(4, (sorted[Math.floor(sorted.length * 0.9)] || 1) * 1.4));
      var mRate = median(rates);
      var svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': 'Reach against responses for each post' });
      function X(x) { return padL + logPos(x, iw); }
      function Y(v) { return padT + ih - ih * Math.min(v, yMax) / yMax; }
      [0, 1, 2, 3, 4].forEach(function (g) { var v = yMax * g / 4; svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: Y(v), y2: Y(v), stroke: g ? TRACK : '#d9d5ce' })); text(svg, padL - 6, Y(v) + 4, fmtRate(v), { 'text-anchor': 'end' }); });
      [0.25, 0.5, 1, 2, 4].forEach(function (t) { text(svg, X(t), H - 14, t === 0.25 ? '¼×' : t === 0.5 ? '½×' : t + '×', { 'text-anchor': 'middle', 'font-size': 10.5, fill: t === 1 ? INK : MUTED, 'font-weight': t === 1 ? 700 : 400 }); });
      text(svg, padL + iw / 2, H - 1, 'Reach, vs your typical post →', { 'text-anchor': 'middle', 'font-size': 10.5 });
      text(svg, padL - 30, 10, 'Engagements per 1,000 views ↑', { 'font-size': 10.5 });
      svg.appendChild(svgEl('line', { x1: X(1), x2: X(1), y1: padT, y2: padT + ih, stroke: '#8f8a80', 'stroke-width': 1.5 }));
      if (mRate !== null) svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: Y(mRate), y2: Y(mRate), stroke: '#8f8a80', 'stroke-width': 1.5 }));
      var qs = [['Wide reach, people engaged', W - padR, padT + 12, 'end'], ['Few saw it, but they engaged', X(1) - 6, padT + 12, 'end'],
        ['Wide reach, little response', W - padR, padT + ih - 6, 'end'], ['Low reach, little response', X(1) - 6, padT + ih - 6, 'end']];
      qs.forEach(function (q) { text(svg, q[1], q[2], q[0], { 'text-anchor': q[3], 'font-size': 10.5, fill: '#8f8a80', stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke' }); });
      var pts = [];
      rows.forEach(function (r) {
        var cx = X(r.x), cy = Y(r.rate), over = r.rate > yMax;
        if (over) text(svg, cx + 8, cy + 4, fmtRate(r.rate) + ' ↑', { 'font-size': 10, fill: INK, 'font-weight': 700 });
        var dot = svgEl('circle', { cx: cx, cy: cy, r: r.own ? 5.5 : 4.5, fill: colorOf(r), 'fill-opacity': r.own ? 1 : 0.85, stroke: '#fff', 'stroke-width': 2 });
        svg.appendChild(dot);
        pts.push({ cx: cx, cy: cy, ty: cy - 8, mark: dot, lines: postLines(r), url: r.url });
      });
      holder.appendChild(svg);
      nearestHover(svg, tipFor(holder), pts, W, 22);
    });
  }

  // ---- 4. weekly account trend --------------------------------------------
  function weekly(daily) {
    var w = {}, order = [];
    daily.forEach(function (d) {
      var k = weekStart(d.date);
      if (!w[k]) { w[k] = { date: k, impressions: 0, new_followers: 0, days: 0 }; order.push(k); }
      w[k].impressions += d.impressions || 0; w[k].new_followers += d.new_followers || 0; w[k].days++;
    });
    return order.sort().map(function (k) { return w[k]; });
  }
  function weekBars(holder, weeks, key, unit) {
    later(holder, function (W) {
      var H = 150, padL = 38, padR = 4, padT = 8, padB = 22, iw = W - padL - padR, ih = H - padT - padB, base = padT + ih;
      var max = niceMax(weeks.reduce(function (m, w) { return Math.max(m, w[key]); }, 0));
      var svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': unit + ' per week' });
      [0, 1, 2, 3, 4].forEach(function (g) { var y = base - ih * g / 4; svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: g ? TRACK : '#d9d5ce' })); text(svg, padL - 6, y + 4, NC.format(max * g / 4), { 'text-anchor': 'end' }); });
      var n = weeks.length, step = iw / Math.max(n, 1), bw = Math.max(2, Math.min(18, step - 2)), pts = [];
      weeks.forEach(function (wk, i) {
        var cx = padL + step * i + step / 2, h = ih * wk[key] / max, x = cx - bw / 2, y = base - h, rad = Math.min(3, bw / 2, h);
        var recent = i >= n - 4, partial = wk.days < 7;
        var mark = h > 0 ? svgEl('path', { fill: recent ? '#0a66c2' : '#b9b3a8', 'fill-opacity': partial ? 0.45 : 1,
          d: 'M' + x + ' ' + base + ' V' + (y + rad) + ' Q' + x + ' ' + y + ' ' + (x + rad) + ' ' + y + ' H' + (x + bw - rad) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + rad) + ' V' + base + ' Z' }) : null;
        if (mark) svg.appendChild(mark);
        pts.push({ cx: cx, cy: y, ty: y, mark: mark, xOnly: true, lines: ['Week of ' + fmtDay(wk.date) + (partial ? ' (' + wk.days + ' days so far)' : ''), NF.format(wk[key]) + ' ' + unit] });
      });
      if (n) { text(svg, padL + step / 2, H - 5, fmtDay(weeks[0].date), { 'text-anchor': 'start' }); text(svg, padL + step * (n - 0.5), H - 5, fmtDay(weeks[n - 1].date), { 'text-anchor': 'end' }); }
      holder.appendChild(svg);
      nearestHover(svg, tipFor(holder), pts, W, Math.max(step, 12));
    });
  }

  // ---- page pieces -------------------------------------------------------------
  function card(title, sub) {
    var c = el('div', 'card chartcard');
    c.appendChild(el('div', 'ct', title));
    if (sub) c.appendChild(el('div', 'cs', sub));
    return c;
  }
  function legend(items) {
    var l = el('div', 'lgd');
    items.forEach(function (it) { var s = el('span'); var sw = el('i'); sw.style.background = it[1]; if (it[2]) sw.style.opacity = it[2]; s.appendChild(sw); s.appendChild(document.createTextNode(it[0])); l.appendChild(s); });
    return l;
  }
  function stat(label, value, cmp, cls) {
    var k = el('div', 'kpi');
    k.appendChild(el('div', 'kl', label));
    k.appendChild(el('div', 'kv', value));
    k.appendChild(el('div', 'kd ' + (cls || ''), cmp));
    return k;
  }
  function trendText(cur, prev, what) {
    var p = pct(cur, prev);
    if (p === null) return { t: 'no earlier ' + what + ' to compare', c: '' };
    if (Math.abs(p) < 5) return { t: 'about the same as the ' + what + ' before', c: '' };
    return { t: (p > 0 ? '▲ ' : '▼ ') + Math.abs(p) + '% vs the ' + what + ' before', c: p > 0 ? 'up' : 'down' };
  }
  function postSlug(url) {
    var m = /\/posts\/[^_\/]+_(.+?)-(?:share|ugcPost|activity)-\d{19}/.exec(url || '');
    if (!m) return 'LinkedIn post';
    var s = m[1];
    try { s = decodeURIComponent(s); } catch (e) {}
    // posts written in unicode bold/italic: fold those letters back to plain ones
    if (s.normalize) s = s.normalize('NFKC');
    s = s.replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '…';
  }
  function hookList(title, rows) {
    var box = el('div', 'hooks');
    box.appendChild(el('div', 'hh', title));
    rows.forEach(function (r) {
      var a = el('a', 'hrow'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
      var x = el('span', 'xchip' + (r.x >= 1 ? ' hi' : ''), fmtX(r.x));
      a.appendChild(x);
      var b = el('span', 'hb');
      b.appendChild(el('span', 'ht', r.hook + (r.own ? '' : '…')));
      b.appendChild(el('span', 'hm', fmtDay(r.date) + ' · ' + NF.format(r.imp) + ' impressions' + (r.rate === null ? '' : ' · ' + fmtRate(r.rate) + ' per 1k')));
      a.appendChild(b);
      box.appendChild(a);
    });
    return box;
  }

  function insightsPanel() {
    var wrap = el('div', 'insights');
    if (!AN) { wrap.appendChild(el('div', 'empty', 'Loading analytics…')); return wrap; }
    wrap.appendChild(importBar());
    if (!AN.latest) return wrap;
    var D = dataset(), dims = dimensions(D), find = bestFinding(dims);
    var settled = D.settled, last10 = settled.slice(-10), prev10 = settled.slice(-20, -10);
    var medLast = median(last10.map(function (r) { return r.imp; })), medPrev = median(prev10.map(function (r) { return r.imp; }));

    // --- Next post: the decision, in plain sentences ---
    var brief = el('div', 'card brief');
    brief.appendChild(el('div', 'eyebrow', 'For your next post'));
    var hero = el('div', 'hero');
    hero.appendChild(el('span', 'hn', NF.format(Math.round(D.base))));
    hero.appendChild(el('span', 'hu', 'impressions on your typical post'));
    brief.appendChild(hero);
    brief.appendChild(el('div', 'cs', 'The median of your last ' + D.baseN + ' posts. Every “×” on this page compares against it.'));
    var ul = el('ul', 'moves');
    function move(kind, html) { var li = el('li', kind); li.appendChild(el('span', 'mk', kind === 'do' ? 'Do' : kind === 'try' ? 'Try' : 'Note')); var s = el('span', 'mt'); html.forEach(function (h) { s.appendChild(typeof h === 'string' ? document.createTextNode(h) : h); }); li.appendChild(s); ul.appendChild(li); }
    if (find) {
      move(find.hi.med >= 1 ? 'do' : 'note', [find.dim.name + ': ', el('b', '', find.hi.label.toLowerCase()), ' did better than ' + find.lo.label.toLowerCase() + ', ' + fmtX(find.hi.med) + ' against ' + fmtX(find.lo.med) + ' your typical post (' + find.hi.n + ' and ' + find.lo.n + ' posts).' + (find.hi.med >= 1 ? '' : ' Both are still below your typical post.')]);
    } else {
      move('note', ['No group has ' + MIN_N + ' posts on both sides yet, so no pattern is solid. The comparisons below are hints to test, not rules.']);
    }
    var recent = settled.filter(function (r) { return daysBetween(r.date, AN.latest.range_end) <= 120; });
    var topR = recent.slice().sort(function (a, b) { return b.x - a.x; })[0];
    if (topR) move('do', ['Reuse the angle of your best recent post: ', el('b', '', quote(topR.hook, 80)), ' reached ' + fmtX(topR.x) + ' your typical post.']);
    var rated = settled.filter(function (r) { return r.rate !== null; });
    var mRate = median(rated.map(function (r) { return r.rate; }));
    var hidden = rated.filter(function (r) { return r.x < 1 && r.rate > mRate * 1.5 && daysBetween(r.date, AN.latest.range_end) <= 180; }).sort(function (a, b) { return b.rate - a.rate; })[0];
    if (hidden) move('try', ['Post this idea again with a sharper first line: ', el('b', '', quote(hidden.hook, 80)), ' got ' + fmtRate(hidden.rate) + ' engagements per 1,000 views (your median is ' + fmtRate(mRate) + ') but few people saw it.']);
    brief.appendChild(ul);
    wrap.appendChild(brief);

    // --- Is it getting better? Four comparisons, never a bare number ---
    var kp = el('div', 'kpis');
    var tr = trendText(medLast, medPrev, '10 posts');
    kp.appendChild(stat('Typical post, last 10', medLast === null ? '–' : NF.format(Math.round(medLast)), tr.t, tr.c));
    var rLast = median(last10.filter(function (r) { return r.rate !== null; }).map(function (r) { return r.rate; }));
    var rPrev = median(prev10.filter(function (r) { return r.rate !== null; }).map(function (r) { return r.rate; }));
    var tr2 = rLast === null ? { t: 'no data', c: '' } : trendText(rLast, rPrev, '10 posts');
    kp.appendChild(stat('Engagements per 1k views', fmtRate(rLast), tr2.t, tr2.c));
    // profile visits get a headline tile: the number this dashboard optimizes for
    // ("beat your typical post" already heads the chart below)
    var pvRows = AN.posts.concat(AN.other).map(function (p) { return { d: p.publish_date || (p.posted_at ? new Date(p.posted_at).toISOString().slice(0, 10) : ''), v: p.page ? p.page.profile_viewers : null }; })
      .filter(function (x) { return x.v !== null && x.d; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    var pv10 = pvRows.slice(-10), pvPrev = pvRows.slice(-20, -10);
    var pvNow = pv10.reduce(function (m, x) { return m + x.v; }, 0), pvBefore = pvPrev.reduce(function (m, x) { return m + x.v; }, 0);
    var tr4 = pvRows.length < 20 ? { t: 'from your last ' + pv10.length + ' posts', c: '' } : trendText(pvNow, pvBefore, '10 posts');
    kp.appendChild(stat('Profile visits, last 10 posts', pv10.length ? NF.format(pvNow) : '–', tr4.t, tr4.c));
    var wk = weekly(AN.daily), full = wk.filter(function (w) { return w.days === 7; });
    var f4 = full.slice(-4), p4 = full.slice(-8, -4);
    var fNow = median(f4.map(function (w) { return w.new_followers; })), fPrev = median(p4.map(function (w) { return w.new_followers; }));
    var tr3 = fNow === null ? { t: 'no data', c: '' } : trendText(fNow, fPrev, '4 weeks');
    kp.appendChild(stat('New followers a week', fNow === null ? '–' : NF.format(Math.round(fNow)), tr3.t, tr3.c));
    wrap.appendChild(kp);

    // --- Profile visits: what reach turns into ---
    wrap.appendChild(el('div', 'section-head', 'Profile visits'));
    wrap.appendChild(visitsCard());

    // --- Every post vs typical ---
    var lastN = D.rows.slice(-24);
    var beatAll = lastN.filter(function (r) { return r.settled && r.x >= 1; }).length, settledN = lastN.filter(function (r) { return r.settled; }).length;
    var c1 = card(beatAll + ' of your last ' + settledN + ' posts beat your typical post', 'Each bar is one post, as a multiple of your typical post. Hover a bar to see the post.');
    c1.appendChild(legend([['Engineers', COL.engineers], ['GTM leaders', COL.gtm], ['Outside the scheduler', COL.other], ['Still growing (under 3 days)', COL.engineers, 0.4], ['Your typical post (1×)', '#8f8a80']]));
    var h1 = el('div', 'chart'); h1.style.height = '190px'; c1.appendChild(h1); postsChart(h1, lastN);
    wrap.appendChild(c1);

    // --- What works ---
    wrap.appendChild(el('div', 'section-head', 'What works'));
    var c2 = card(find ? find.hi.label + ' posts do best so far (' + fmtX(find.hi.med) + ')' : 'Too few posts per group to call a winner yet',
      'Dots are posts, the bar is the group median, the grey line is your typical post. Groups with fewer than ' + MIN_N + ' posts are grey: small groups swing to extremes by chance.');
    dims.forEach(function (d) {
      var hd = el('div', 'dimhead'); hd.appendChild(el('span', 'dn', d.name)); hd.appendChild(el('span', 'dnote', d.note)); c2.appendChild(hd);
      var h = el('div', 'chart'); h.style.height = (18 + 34 * d.groups.length) + 'px'; c2.appendChild(h); groupRows(h, d);
    });
    wrap.appendChild(c2);

    // --- Hooks: right after "what works", since both answer "what should I write" ---
    wrap.appendChild(el('div', 'section-head', 'First lines to learn from'));
    var c4 = el('div', 'card');
    var byX = settled.slice().sort(function (a, b) { return b.x - a.x; });
    c4.appendChild(hookList('Went furthest', byX.slice(0, 5)));
    c4.appendChild(hookList('Went least far', byX.slice(-5).reverse()));
    c4.appendChild(el('div', 'hint', 'Older posts show the start of their LinkedIn URL, which is roughly the first words of the post.'));
    wrap.appendChild(c4);

    // --- Reach vs response ---
    wrap.appendChild(el('div', 'section-head', 'Reach and response'));
    var sc = settled.filter(function (r) { return r.rate !== null; });
    var hiddenN = sc.filter(function (r) { return r.x < 1 && r.rate >= mRate; }).length;
    var c3 = card(hiddenN ? hiddenN + ' posts got good responses but low reach. Their ideas deserve a second try.' : 'Reach and response line up so far',
      'Right means more people saw it. Up means more of them reacted, commented or shared. The grey lines are your medians.');
    c3.appendChild(legend([['Engineers', COL.engineers], ['GTM leaders', COL.gtm], ['Outside the scheduler', COL.other]]));
    var h3 = el('div', 'chart'); h3.style.height = '260px'; c3.appendChild(h3); scatter(h3, sc, D);
    wrap.appendChild(c3);

    // --- Who sees your posts: changes slowly, so it sits below the per-post sections ---
    wrap.appendChild(el('div', 'section-head', 'Who sees your posts'));
    wrap.appendChild(demoCard());

    // --- Account trend, weekly ---
    wrap.appendChild(el('div', 'section-head', 'Account trend'));
    var w26 = wk.slice(-26);
    var i4 = full.slice(-4), ip4 = full.slice(-8, -4);
    var tI = trendText(i4.reduce(function (m, w) { return m + w.impressions; }, 0), ip4.length === 4 ? ip4.reduce(function (m, w) { return m + w.impressions; }, 0) : 0, '4 weeks');
    var c5 = card('Impressions per week: ' + tI.t.replace(/^[▲▼] /, function (s) { return s === '▲ ' ? 'up ' : 'down '; }), 'Blue bars are the last 4 weeks. A faded bar is a week still in progress.');
    var h5 = el('div', 'chart'); h5.style.height = '150px'; c5.appendChild(h5); weekBars(h5, w26, 'impressions', 'impressions');
    var c6 = card('New followers per week', 'Followers are the slow, real result of posting. Look at the trend, not single weeks.');
    var h6 = el('div', 'chart'); h6.style.height = '150px'; c6.appendChild(h6); weekBars(h6, w26, 'new_followers', 'new followers');
    var det = el('details', 'daytable');
    det.appendChild(el('summary', '', 'Weekly numbers as a table'));
    var dw = el('div', 'daywrap'), tb = el('table'), hr = el('tr');
    ['Week of', 'Impressions', 'New followers'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    tb.appendChild(hr);
    w26.slice().reverse().forEach(function (w) { var r = el('tr'); [fmtDay(w.date) + (w.days < 7 ? ' (so far)' : ''), NF.format(w.impressions), NF.format(w.new_followers)].forEach(function (v) { r.appendChild(el('td', '', v)); }); tb.appendChild(r); });
    dw.appendChild(tb); det.appendChild(dw); c6.appendChild(det);
    wrap.appendChild(c5); wrap.appendChild(c6);

    // --- All posts ---
    var th = el('div', 'tblhead');
    th.appendChild(el('div', 'section-head', 'Posts'));
    var sw = el('div', 'pills');
    [['all', 'All posts'], ['scheduled', 'Scheduled']].forEach(function (o) {
      var b = el('span', 'pill' + (POSTS_VIEW === o[0] ? ' active' : ''), o[1]);
      b.onclick = function () { POSTS_VIEW = o[0]; try { localStorage.setItem('posts_view', o[0]); } catch (e) {} render(); };
      sw.appendChild(b);
    });
    th.appendChild(sw);
    wrap.appendChild(th);
    wrap.appendChild(postTable(D));
    wrap.appendChild(el('div', 'hint foot', 'Numbers come from LinkedIn\'s analytics export. A post\'s number counts only views inside the export\'s date range, so posts older than the range are left out of every comparison. Profile visits, followers, saves and sends per post come from each post\'s own analytics page (see Profile visits).'));
    return wrap;
  }

  // ---- profile visits, read off each post's LinkedIn analytics page -------------
  // A rate built on a few hundred views swings wildly (1 visit moves it a lot),
  // so the per-1k rate is shown only for posts with at least this many views.
  var RATE_MIN_IMP = 500;
  var STALE_DAYS = 30;
  var VISITS_TOP = 5;
  var VISITS_ALL = false;
  try { VISITS_ALL = localStorage.getItem('visits_all') === '1'; } catch (e) {}
  function visitsCard() {
    var rows = [];
    AN.posts.forEach(function (p) {
      if (!p.page || p.page.profile_viewers === null) return;
      rows.push({ date: new Date(p.posted_at).toISOString().slice(0, 10), label: snippet(p.text).split('\n')[0] || 'Media post', url: p.post_url, queue: p.queue, own: true, page: p.page });
    });
    AN.other.forEach(function (o) {
      if (!o.page || o.page.profile_viewers === null || !o.publish_date) return;
      rows.push({ date: o.publish_date, label: postSlug(o.post_url).replace(/…$/, ''), url: o.post_url, own: false, page: o.page });
    });
    var c = el('div', 'card visits');
    if (!rows.length) {
      c.appendChild(el('div', 'vlead', 'No post pages read yet. Profile visits per post are only on each post\'s LinkedIn analytics page, not in the export. Send them with POST /api/analytics/page-stats.'));
      return c;
    }
    rows.forEach(function (r) { r.v = r.page.profile_viewers; r.imp = r.page.impressions; });
    rows.sort(function (a, b) { return (b.v - a.v) || (a.date < b.date ? 1 : -1); });
    var total = rows.reduce(function (m, r) { return m + r.v; }, 0);
    var first = rows.reduce(function (m, r) { return r.date < m ? r.date : m; }, rows[0].date);
    var checked = rows.reduce(function (m, r) { return r.page.checked_on > m ? r.page.checked_on : m; }, '');
    var gained = rows.reduce(function (m, r) { return m + (r.page.followers_gained || 0); }, 0);

    // the two numbers that matter, side by side
    var top = el('div', 'vtop');
    function fig(n, label, sub) { var f = el('div', 'vfig'); f.appendChild(el('div', 'vn', n)); f.appendChild(el('div', 'vl', label)); f.appendChild(el('div', 'vs', sub)); top.appendChild(f); }
    fig(NF.format(total), 'profile visits from your posts', rows.length + ' posts since ' + fmtDay(first));
    fig(NF.format(gained), 'followers gained from your posts', 'as read on each post\'s analytics page');
    c.appendChild(top);

    // one plain sentence: which post did it, and how much of the total
    var best = rows[0];
    var lead = el('div', 'vlead');
    if (best.v > 0) {
      lead.appendChild(document.createTextNode('Most visits came from '));
      lead.appendChild(el('b', '', quote(best.label, 60)));
      lead.appendChild(document.createTextNode(' (' + fmtDay(best.date) + '): ' + best.v + ' of ' + total + '.' + (best.v < 30 ? ' Counts this small change a lot from post to post, so look for a type of post that keeps showing up near the top.' : '')));
    } else lead.appendChild(document.createTextNode('None of these posts brought a profile visit yet.'));
    c.appendChild(lead);

    var hd = el('div', 'vrow vhead'); hd.appendChild(el('span', '', 'Posted')); hd.appendChild(el('span', '', 'Post')); hd.appendChild(el('span', '', 'Visits')); c.appendChild(hd);
    var max = best.v || 1;
    // top 5 by default; the whole list is one click away (and remembered)
    var shown = VISITS_ALL ? rows : rows.slice(0, VISITS_TOP);
    shown.forEach(function (r) {
      var a = el('a', 'vrow' + (r.v ? '' : ' zero')); a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
      var dt = el('div', 'updt'); dt.appendChild(el('b', '', WD[new Date(r.date + 'T00:00:00Z').getUTCDay()])); dt.appendChild(el('span', '', fmtDay(r.date))); a.appendChild(dt);
      var b = el('div', 'upbody');
      var tl = el('div', 'uptext'); var qd = el('span', 'qd'); qd.style.background = r.own ? COL[r.queue] || COL.engineers : COL.other; tl.appendChild(qd); tl.appendChild(document.createTextNode(r.label)); b.appendChild(tl);
      var s = r.page, bits = [];
      if (r.imp !== null) bits.push(NF.format(r.imp) + ' views');
      if (s.followers_gained) bits.push(s.followers_gained + ' new follower' + (s.followers_gained === 1 ? '' : 's'));
      if (s.saves) bits.push(s.saves + ' save' + (s.saves === 1 ? '' : 's'));
      if (s.sends) bits.push(s.sends + ' send' + (s.sends === 1 ? '' : 's'));
      b.appendChild(el('div', 'psub', bits.join(' · ')));
      a.appendChild(b);
      var n = el('div');
      var cnt = el('div', 'vcount'), bar = el('div', 'vbar'), sp = el('span');
      sp.style.width = (r.v ? Math.max(4, 100 * r.v / max) : 0) + '%'; bar.appendChild(sp); cnt.appendChild(bar);
      cnt.appendChild(el('b', '', String(r.v)));
      n.appendChild(cnt);
      if (r.imp >= RATE_MIN_IMP) n.appendChild(el('div', 'vrate', (1000 * r.v / r.imp).toFixed(1) + ' per 1k'));
      a.appendChild(n);
      c.appendChild(a);
    });
    if (rows.length > VISITS_TOP) {
      var mb = el('button', 'vmore', VISITS_ALL ? 'Show top ' + VISITS_TOP + ' only' : 'Show all ' + rows.length + ' posts');
      mb.onclick = function () { VISITS_ALL = !VISITS_ALL; try { localStorage.setItem('visits_all', VISITS_ALL ? '1' : '0'); } catch (e) {} render(); };
      c.appendChild(mb);
    }

    var age = daysBetween(checked, new Date().toISOString().slice(0, 10));
    var stale = age > STALE_DAYS;
    c.appendChild(el('div', 'vfoot' + (stale ? ' stale' : ''), 'Read from each post\'s LinkedIn analytics page on ' + fmtDay(checked) + (stale ? ', ' + age + ' days ago. Send fresh numbers again.' : '. Send new numbers about once a month.') +
      ' The per-1k rate shows only for posts with ' + RATE_MIN_IMP + '+ views.'));
    return c;
  }

  // ---- who sees your posts: LinkedIn's "top demographics" ------------------------
  // LinkedIn lists only the top ~10 values per category, so a group added up from
  // several job titles is a floor ("at least"), and a value missing from one list
  // is below that list's smallest number, not zero.
  var DEMO_GROUPS = [
    { name: 'Engineers and developers', cat: 'Job title', test: function (l) { return /engineer|developer|programmer|architect/i.test(l); } },
    { name: 'Senior level', cat: 'Seniority', test: function (l) { return l === 'Senior'; } },
    { name: 'Managers and up', cat: 'Seniority', test: function (l) { return /^(Manager|Director|VP|CXO|Owner|Partner)$/.test(l); } },
  ];
  var DEMO_TABS = ['Job title', 'Industry', 'Seniority', 'Location', 'Company size'];
  var DEMO_TAB = 'Job title', DEMO_OPEN = null;
  try { if (DEMO_TABS.indexOf(localStorage.getItem('demo_tab')) > -1) DEMO_TAB = localStorage.getItem('demo_tab'); } catch (e) {}
  function demoGroup(rows, g) {
    var hit = (rows || []).filter(function (r) { return r.category === g.cat && g.test(r.label); });
    var listed = (rows || []).some(function (r) { return r.category === g.cat; });
    if (!listed) return null;
    return { pct: hit.reduce(function (m, r) { return m + r.pct; }, 0), n: hit.length, lt1: hit.length > 0 && hit.every(function (r) { return r.lt1; }), floor: hit.length > 1 };
  }
  function fmtPct(v) {
    if (!v) return 'not listed';
    if (v.lt1 || v.pct < 1) return 'under 1%';
    return (v.floor ? 'at least ' : '') + Math.round(v.pct) + '%';
  }
  function niceScale(v) { var s = [5, 10, 20, 25, 40, 50, 60, 80, 100]; for (var i = 0; i < s.length; i++) if (v <= s[i]) return s[i]; return 100; }
  // One row: label, a track with a hollow dot (the usual mix) and a filled dot (the
  // thing being looked at) on the same scale, and both numbers spelled out.
  function dumbbell(label, base, cur, max, baseName, curName) {
    var r = el('div', 'dbrow');
    r.appendChild(el('div', 'dbl', label));
    var t = el('div', 'dbt');
    function x(v) { return Math.min(100, 100 * (v.lt1 ? 0.5 : v.pct) / max); }
    if (base && cur) { var ln = el('i', 'dbline'); var a = x(base), b = x(cur); ln.style.left = Math.min(a, b) + '%'; ln.style.width = Math.abs(a - b) + '%'; t.appendChild(ln); }
    if (base) { var d0 = el('i', 'dbdot base' + (base.lt1 ? ' lt1' : '')); d0.style.left = x(base) + '%'; d0.title = baseName + ': ' + fmtPct(base); t.appendChild(d0); }
    if (cur) { var d1 = el('i', 'dbdot cur' + (cur.lt1 ? ' lt1' : '')); d1.style.left = x(cur) + '%'; d1.title = curName + ': ' + fmtPct(cur); t.appendChild(d1); }
    r.appendChild(t);
    var v = el('div', 'dbv');
    v.appendChild(el('b', '', fmtPct(cur)));
    v.appendChild(el('span', '', fmtPct(base)));
    r.appendChild(v);
    // the difference, in words: readers misjudge the distance between two dots
    var dd = null;
    if (base && cur && !(base.lt1 && cur.lt1)) { var d = Math.round(cur.pct) - Math.round(base.pct); dd = Math.abs(d) < 2 ? 'same' : (d > 0 ? '+' : '−') + Math.abs(d) + ' pts'; }
    r.appendChild(el('div', 'dbd' + (dd && dd !== 'same' ? (dd[0] === '+' ? ' up' : ' down') : ''), dd || '–'));
    return r;
  }
  function dbHead(baseName, curName, max) {
    var h = el('div', 'dbrow dbhead');
    h.appendChild(el('div', 'dbl', ''));
    var t = el('div', 'dbaxis'); t.appendChild(el('span', '', '0')); t.appendChild(el('span', '', max + '%')); h.appendChild(t);
    var v = el('div', 'dbv'); v.appendChild(el('b', '', curName)); v.appendChild(el('span', '', baseName)); h.appendChild(v);
    h.appendChild(el('div', 'dbd', 'Difference'));
    return h;
  }
  function dbLegend(baseName, curName) {
    var l = el('div', 'lgd dblgd');
    var a = el('span'); a.appendChild(el('i', 'dbkey cur')); a.appendChild(document.createTextNode(curName)); l.appendChild(a);
    var b = el('span'); b.appendChild(el('i', 'dbkey base')); b.appendChild(document.createTextNode(baseName)); l.appendChild(b);
    return l;
  }
  // every value either list names in this category, biggest share of the current mix first
  function demoTabRows(baseRows, curRows, cat) {
    var labels = [], seen = {};
    function take(rows) { (rows || []).forEach(function (r) { if (r.category === cat && !seen[r.label]) { seen[r.label] = 1; labels.push(r.label); } }); }
    take(curRows); take(baseRows);
    function find(rows, l) { var r = (rows || []).filter(function (x) { return x.category === cat && x.label === l; })[0]; return r ? { pct: r.pct, lt1: r.lt1 } : null; }
    return labels.map(function (l) { return { label: l, base: find(baseRows, l), cur: find(curRows, l) }; })
      .sort(function (a, b) { return (b.cur ? b.cur.pct : -1) - (a.cur ? a.cur.pct : -1) || (b.base ? b.base.pct : 0) - (a.base ? a.base.pct : 0); }).slice(0, 10);
  }
  function demoTabs(onPick) {
    var p = el('div', 'pills dbtabs');
    DEMO_TABS.forEach(function (t) {
      var b = el('span', 'pill' + (DEMO_TAB === t ? ' active' : ''), t);
      b.onclick = function () { DEMO_TAB = t; try { localStorage.setItem('demo_tab', t); } catch (e) {} onPick(); };
      p.appendChild(b);
    });
    return p;
  }
  function demoCompare(box, baseRows, curRows, baseName, curName, restCur, restBase) {
    var rows = demoTabRows(baseRows, curRows, DEMO_TAB);
    var max = niceScale(rows.reduce(function (m, r) { return Math.max(m, r.base ? r.base.pct : 0, r.cur ? r.cur.pct : 0); }, 0));
    box.appendChild(dbHead(baseName, curName, max));
    if (!rows.length) box.appendChild(el('div', 'hint', 'LinkedIn listed nothing for ' + DEMO_TAB.toLowerCase() + '.'));
    rows.forEach(function (r) { box.appendChild(dumbbell(r.label, r.base, r.cur, max, baseName, curName)); });
    // LinkedIn names only its top values; say how much of each mix that leaves out
    function rest(list) { var t = (list || []).filter(function (x) { return x.category === DEMO_TAB; }).reduce(function (m, x) { return m + (x.lt1 ? 0 : x.pct); }, 0); return t ? Math.max(0, Math.round(100 - t)) : null; }
    var rc = rest(curRows), rb = rest(baseRows);
    if (rc !== null || rb !== null) box.appendChild(el('div', 'dbrest', 'Not in LinkedIn\'s list: ' + [rc !== null ? 'about ' + rc + '% of ' + restCur : '', rb !== null ? 'about ' + rb + '% of ' + restBase : ''].filter(Boolean).join(', ') + '.'));
  }

  function demoCard() {
    var V = AN.demographics && AN.demographics.viewers, F = AN.demographics && AN.demographics.followers;
    var c = el('div', 'card demo');
    if (!V && !F) {
      c.appendChild(el('div', 'vlead', 'Import a new export to see who your posts reach. Older imports were read before this card existed.'));
      return c;
    }
    var vr = V ? V.rows : null, fr = F ? F.rows : null;
    var range = V ? fmtDay(V.range_start) + ' to ' + fmtDay(V.range_end) : '';

    // lead sentence: does the reach match the audience you follow-build for
    var rec = demoGroup(vr, DEMO_GROUPS[0]), recF = demoGroup(fr, DEMO_GROUPS[0]);
    var lead = el('div', 'dlead');
    if (rec && recF) {
      lead.appendChild(document.createTextNode('Engineers and developers are '));
      lead.appendChild(el('b', '', fmtPct(recF)));
      lead.appendChild(document.createTextNode(' of your followers and '));
      lead.appendChild(el('b', '', fmtPct(rec)));
      lead.appendChild(document.createTextNode(' of the people who saw your posts (' + range + ').'));
    } else lead.appendChild(document.createTextNode('Who saw your posts from ' + range + ', next to who follows you.'));
    c.appendChild(lead);

    var g = el('div', 'dbox');
    g.appendChild(el('div', 'dsub', 'Groups that matter for you'));
    var grp = DEMO_GROUPS.map(function (d) { return { name: d.name, base: demoGroup(fr, d), cur: demoGroup(vr, d) }; }).filter(function (x) { return x.base || x.cur; });
    var gmax = niceScale(grp.reduce(function (m, x) { return Math.max(m, x.base ? x.base.pct : 0, x.cur ? x.cur.pct : 0); }, 0));
    g.appendChild(dbLegend('Your followers', 'Saw your posts'));
    g.appendChild(dbHead('Followers', 'Saw posts', gmax));
    grp.forEach(function (x) { g.appendChild(dumbbell(x.name, x.base, x.cur, gmax, 'Your followers', 'Saw your posts')); });
    c.appendChild(g);

    // the full list is detail: folded away, open on request (and remembered)
    var t = el('details', 'dbox dmore');
    try { t.open = localStorage.getItem('demo_all') === '1'; } catch (e) {}
    t.ontoggle = function () { try { localStorage.setItem('demo_all', t.open ? '1' : '0'); } catch (e) {} };
    t.appendChild(el('summary', 'dsub', 'All of LinkedIn\'s list: job title, industry, seniority, location, company size'));
    var tb = el('div');
    function drawTab() { tb.innerHTML = ''; tb.appendChild(demoTabs(drawTab)); demoCompare(tb, fr, vr, 'Followers', 'Saw posts', 'the people who saw your posts', 'your followers'); }
    drawTab();
    t.appendChild(tb);
    c.appendChild(t);

    // per-post mix only once some post pages carry it; an empty placeholder is just noise
    var hasPostDemo = AN.posts.concat(AN.other).some(function (p) { return p.page && (p.page.demo || (p.page.in_network_pct !== null && p.page.in_network_pct !== undefined)); });
    if (hasPostDemo) c.appendChild(perPostDemo(vr));
    c.appendChild(el('div', 'vfoot', 'From LinkedIn\'s export: who saw any of your posts in the range, and who follows you today. LinkedIn names only the top 10 per category, so groups built from several job titles say "at least", and "not listed" means smaller than the last item LinkedIn listed.'));
    return c;
  }

  // per post: the post page's own mix next to your usual mix, one row per post,
  // opened in place (the list keeps its spot) instead of on a separate page
  function perPostDemo(vr) {
    var box = el('div', 'dbox dposts');
    box.appendChild(el('div', 'dsub', 'Per post'));
    var rows = [];
    AN.posts.forEach(function (p) {
      if (!p.page || (!p.page.demo && p.page.in_network_pct === null)) return;
      rows.push({ id: p.activity_id, date: new Date(p.posted_at).toISOString().slice(0, 10), label: snippet(p.text).split('\n')[0] || 'Media post', url: p.post_url, page: p.page });
    });
    AN.other.forEach(function (o) {
      if (!o.page || (!o.page.demo && o.page.in_network_pct === null) || !o.publish_date) return;
      rows.push({ id: o.activity_id, date: o.publish_date, label: postSlug(o.post_url).replace(/…$/, ''), url: o.post_url, page: o.page });
    });
    if (!rows.length) {
      box.appendChild(el('div', 'hint', 'No post pages read yet. Each post\'s LinkedIn analytics page shows its own mix (job title, seniority, industry and how much reach came from outside your network). Send them with POST /api/analytics/page-stats and they show up here, each next to your usual mix.'));
      return box;
    }
    rows.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    rows.forEach(function (r) {
      var open = DEMO_OPEN === r.id;
      var item = el('div', 'dpost' + (open ? ' open' : ''));
      var hd = el('button', 'dphead'); hd.setAttribute('aria-expanded', open ? 'true' : 'false');
      var dt = el('div', 'updt'); dt.appendChild(el('b', '', WD[new Date(r.date + 'T00:00:00Z').getUTCDay()])); dt.appendChild(el('span', '', fmtDay(r.date))); hd.appendChild(dt);
      var b = el('div', 'upbody');
      b.appendChild(el('div', 'uptext', r.label));
      var chips = el('div', 'dchips');
      function chip(text, hi) { chips.appendChild(el('span', 'dchip' + (hi ? ' hi' : ''), text)); }
      if (r.page.in_network_pct !== null) chip((100 - r.page.in_network_pct) + '% from outside your network', 100 - r.page.in_network_pct >= 60);
      [DEMO_GROUPS[0], DEMO_GROUPS[1]].forEach(function (g) {
        var cur = demoGroup(r.page.demo, g), base = demoGroup(vr, g);
        if (!cur) return;
        // "more than usual" needs a real step, not a 1-point wobble
        chip(g.name + ' ' + fmtPct(cur), base && cur.pct >= base.pct * 1.5 && cur.pct - base.pct >= 3);
      });
      b.appendChild(chips);
      hd.appendChild(b);
      hd.appendChild(el('span', 'dcaret', open ? '▾' : '▸'));
      hd.onclick = function () { DEMO_OPEN = open ? null : r.id; render(); };
      item.appendChild(hd);
      if (open) {
        var body = el('div', 'dpbody');
        if (r.page.demo) {
          body.appendChild(dbLegend('Usual mix (all your posts, ' + (AN.demographics.viewers ? fmtDay(AN.demographics.viewers.range_start) + ' to ' + fmtDay(AN.demographics.viewers.range_end) : 'no export yet') + ')', 'This post'));
          var tb = el('div');
          var draw = function () { tb.innerHTML = ''; tb.appendChild(demoTabs(draw)); demoCompare(tb, vr, r.page.demo, 'Usual', 'This post', 'this post\'s viewers', 'your usual viewers'); };
          draw();
          body.appendChild(tb);
        } else body.appendChild(el('div', 'hint', 'Only the reach split was read for this post, not its demographics.'));
        var meta = el('div', 'hint');
        meta.appendChild(document.createTextNode('Read from the post\'s LinkedIn page on ' + fmtDay(r.page.checked_on) + (r.page.members_reached !== null ? ', ' + NF.format(r.page.members_reached) + ' people reached' : '') + '. '));
        var a = el('a', '', 'Open the post'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; meta.appendChild(a);
        body.appendChild(meta);
        item.appendChild(body);
      }
      box.appendChild(item);
    });
    return box;
  }

  function importBar() {
    var L = AN.latest, bar = el('div', 'card importbar');
    var age = L ? daysBetween(L.range_end, new Date().toISOString().slice(0, 10)) : null;
    var t = el('div', 'ib-text');
    if (!L) t.appendChild(el('b', '', 'Import your first LinkedIn export to start.'));
    else {
      t.appendChild(el('b', '', 'Data up to ' + fmtDay(L.range_end)));
      t.appendChild(el('span', age > 7 ? 'stale' : '', age > 7 ? ' · ' + age + ' days old. Export a new 28-day file.' : ' · ' + (age <= 1 ? 'fresh' : age + ' days old')));
    }
    bar.appendChild(t);
    var fi = el('input'); fi.type = 'file'; fi.accept = '.xlsx'; fi.style.display = 'none';
    fi.onchange = function () { importFile(fi.files[0]); };
    var ib = el('button', L && age <= 7 ? '' : 'primary', 'Import .xlsx'); ib.onclick = function () { fi.click(); };
    bar.appendChild(ib); bar.appendChild(fi);
    var how = el('details', 'how');
    how.appendChild(el('summary', '', 'How to get the file'));
    how.appendChild(el('div', 'hint', 'On LinkedIn: Me → View profile → Show all analytics → Post impressions → 28 days → Export. Drop the file anywhere on this page. Once a week is enough.'));
    how.appendChild(el('div', 'hint', 'Who saw one post: open the post on LinkedIn → View analytics → Export, then drop that file here too. It fills in the "Seen by" line for that post.'));
    bar.appendChild(how);
    return bar;
  }

  var POSTS_VIEW = 'all';
  try { POSTS_VIEW = localStorage.getItem('posts_view') || 'all'; } catch (e) {}
  // "Seen by": the largest job title and the largest industry among a post's viewers,
  // from that post's own export. One short line; hover a chip for the top 3.
  function audienceLine(page) {
    if (!page || !page.demo || !page.demo.length) return null;
    function top(cat) { return page.demo.filter(function (d) { return d.category === cat; }).sort(function (a, b) { return b.pct - a.pct; }); }
    function pctText(d) { return d.lt1 ? '<1%' : Math.round(d.pct) + '%'; }
    var line = el('div', 'aud');
    line.appendChild(el('span', 'audk', 'Seen by'));
    [['Job title', 'job titles'], ['Industry', 'industries']].forEach(function (c) {
      var list = top(c[0]);
      if (!list.length) return;
      var chip = el('span', 'audc');
      chip.appendChild(document.createTextNode(list[0].label + ' '));
      chip.appendChild(el('b', '', pctText(list[0])));
      chip.title = 'Top ' + c[1] + ' among viewers: ' + list.slice(0, 3).map(function (d) { return d.label + ' ' + pctText(d); }).join(', ');
      line.appendChild(chip);
    });
    return line.childNodes.length > 1 ? line : null;
  }

  function postTable(D) {
    var box = el('div', 'ptable');
    var cols = el('div', 'prow phead'); cols.appendChild(el('span', '', 'Posted')); cols.appendChild(el('span', '', 'Post')); var ih = el('span', '', 'vs typical'); ih.style.textAlign = 'right'; cols.appendChild(ih); box.appendChild(cols);
    // one shape for both kinds of post, newest first
    var items = AN.posts.map(function (p) {
      return { own: true, date: new Date(p.posted_at).toISOString().slice(0, 10), wd: WD_BUC.format(new Date(p.posted_at)), url: p.post_url, queue: p.queue,
        label: snippet(p.text).split('\n')[0] || 'Media post', m: p.metrics, page: p.page, too_new: p.too_new };
    });
    if (POSTS_VIEW === 'all') AN.other.forEach(function (o) {
      items.push({ own: false, date: o.publish_date, wd: o.publish_date ? WD[new Date(o.publish_date + 'T00:00:00Z').getUTCDay()] : '', url: o.post_url,
        label: postSlug(o.post_url), page: o.page,
        m: { impressions: o.impressions, engagements: o.engagements, lifetime: o.lifetime, as_of: o.as_of, from: o.from } });
    });
    items.sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1 : 0; });
    if (!items.length) box.appendChild(el('div', 'empty', 'No published posts yet.'));
    items.forEach(function (p) {
      var posted = p.date, m = p.m;
      var row = el('a', 'prow'); row.href = p.url; row.target = '_blank'; row.rel = 'noopener';
      var thisYear = new Date().toISOString().slice(0, 4);
      var dt = el('div', 'updt'); dt.appendChild(el('b', '', p.wd)); dt.appendChild(el('span', '', posted ? fmtDay(posted) + (posted.slice(0, 4) !== thisYear ? ' ' + posted.slice(0, 4) : '') : '')); row.appendChild(dt);
      var body = el('div', 'upbody');
      var tl = el('div', 'uptext'); var qd = el('span', 'qd'); qd.style.background = p.own ? COL[p.queue] || COL.engineers : COL.other; tl.appendChild(qd); tl.appendChild(document.createTextNode(p.label)); body.appendChild(tl);
      var sub, miss = false;
      if (m && m.impressions !== null) {
        var bits = [NF.format(m.impressions) + ' impressions'];
        if (m.engagements !== null) bits.push(NF.format(m.engagements) + ' engagement' + (m.engagements === 1 ? '' : 's'));
        if (p.page && p.page.profile_viewers !== null) bits.push(NF.format(p.page.profile_viewers) + ' profile view' + (p.page.profile_viewers === 1 ? '' : 's'));
        if (m.lifetime && posted) { var age = Math.max(0, daysBetween(posted, m.as_of)); bits.push(age < SETTLE_DAYS ? 'still growing' : 'as of day ' + age); }
        else if (!m.lifetime) { bits.push('only counts ' + fmtDay(m.from) + ' onward'); miss = true; }
        if (!p.own) bits.push('outside the scheduler');
        sub = bits.join(' · ');
      } else if (p.too_new) sub = 'Posted after your latest export';
      else { sub = 'Not in any export yet'; miss = true; }
      body.appendChild(el('div', 'psub' + (miss ? ' miss' : ''), sub));
      var aud = audienceLine(p.page);
      if (aud) body.appendChild(aud);
      row.appendChild(body);
      var x = m && m.lifetime && m.impressions !== null ? m.impressions / D.base : null;
      var xc = el('div', 'pnum' + (x === null ? ' none' : ''));
      xc.appendChild(el('span', 'xchip' + (x !== null && x >= 1 ? ' hi' : ''), x === null ? '–' : fmtX(x)));
      row.appendChild(xc);
      box.appendChild(row);
    });
    return box;
  }

  // the whole page is a drop target for the export file
  document.addEventListener('dragover', function (e) { if (TAB === 'analytics') { e.preventDefault(); document.body.classList.add('dropping'); } });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', function (e) { if (TAB !== 'analytics') return; e.preventDefault(); document.body.classList.remove('dropping'); importFile(e.dataTransfer.files[0]); });

  var RESIZE_T = null;
  window.addEventListener('resize', function () { if (TAB !== 'analytics') return; clearTimeout(RESIZE_T); RESIZE_T = setTimeout(render, 150); });

  function queueSwitch(count, noun) {
    var wrap = el('div', 'qswitch three');
    DATA.queues.forEach(function (q) {
      var b = el('button', 'qbtn q-' + q.key + (q.key === QSEL ? ' active' : ''));
      b.setAttribute('aria-pressed', q.key === QSEL ? 'true' : 'false');
      var n = el('div', 'qn'); n.appendChild(el('span', 'qdot')); n.appendChild(el('span', '', q.label));
      n.appendChild(el('span', 'ct', count(q) + ' ' + noun));
      b.appendChild(n);
      b.appendChild(el('div', 'qs', shortSlot(q)));
      b.onclick = function () { setQ(q.key); COMPOSER_OPEN = false; render(); };
      wrap.appendChild(b);
    });
    var total = DATA.queues.reduce(function (m, q) { return m + count(q); }, 0);
    var ab = el('button', 'qbtn q-all' + (QSEL === 'all' ? ' active' : ''));
    ab.setAttribute('aria-pressed', QSEL === 'all' ? 'true' : 'false');
    var an = el('div', 'qn'); an.appendChild(el('span', '', 'All')); an.appendChild(el('span', 'ct', total + ' ' + noun));
    ab.appendChild(an);
    ab.appendChild(el('div', 'qs', DATA.queues.map(function (q) { return DAYS[q.settings.post_day].slice(0, 3); }).join(' + ')));
    ab.onclick = function () { setQ('all'); COMPOSER_OPEN = false; render(); };
    wrap.appendChild(ab);
    return wrap;
  }

  function render() {
    try { localStorage.setItem('tab', TAB); } catch (e) {}
    var app = document.getElementById('app');
    app.innerHTML = '';
    var head = el('header');
    head.appendChild(el('div', 'title', 'LinkedIn Scheduler'));
    var st = el('div', 'status');
    st.appendChild(el('span', 'dot ' + (DATA.token.set ? 'on' : 'off')));
    st.appendChild(el('span', '', DATA.token.set ? 'LinkedIn connected' : 'Not connected — add a token in Settings'));
    head.appendChild(st);

    var tabs = el('div', 'tabs');
    [['queue', 'Queue', DATA.approved.length], ['drafts', 'Drafts', DATA.drafts.length], ['posted', 'Posted', DATA.posted.length], ['analytics', 'Analytics', null], ['settings', 'Settings', null]].forEach(function (t) {
      var tab = el('div', 'tab' + (TAB === t[0] ? ' active' : ''));
      tab.appendChild(el('span', '', t[1]));
      if (t[2] !== null && t[2] > 0) tab.appendChild(el('span', 'badge', String(t[2])));
      tab.onclick = function () { TAB = t[0]; render(); };
      tabs.appendChild(tab);
    });
    head.appendChild(tabs);
    app.appendChild(head);

    if (TAB === 'queue') {
      app.appendChild(comingUp());
      if (DATA.attention.length) {
        app.appendChild(el('div', 'section-head', 'Needs attention'));
        DATA.attention.forEach(function (p) { app.appendChild(postCard(p, 'attention')); });
      }
      app.appendChild(queueSwitch(function (q) { return q.approved.length; }, 'queued'));
      app.appendChild(composer());
      var list = el('div');
      if (QSEL === 'all') {
        var items = allQueued();
        if (!items.length) list.appendChild(el('div', 'empty', 'Nothing queued. Approve a draft, or add a new post.'));
        items.forEach(function (x) { list.appendChild(queueCard(x.p, x.i, x.total)); });
      } else {
        var q = queueOf(QSEL);
        if (!q.approved.length) list.appendChild(el('div', 'empty', 'Nothing queued for ' + dayPlural(q.key) + '. Approve a draft in this queue, or add a new post.'));
        q.approved.forEach(function (p, i) { list.appendChild(queueCard(p, i, q.approved.length)); });
      }
      app.appendChild(list);
    } else if (TAB === 'drafts') {
      app.appendChild(queueSwitch(function (q) { return DATA.drafts.filter(function (p) { return p.queue === q.key; }).length; }, 'drafts'));
      app.appendChild(composer());
      var mine = QSEL === 'all' ? DATA.drafts : DATA.drafts.filter(function (p) { return p.queue === QSEL; });
      if (!mine.length) app.appendChild(el('div', 'empty', QSEL === 'all' ? 'No drafts.' : 'No drafts for ' + queueOf(QSEL).label + '.'));
      mine.forEach(function (p) { app.appendChild(postCard(p, 'draft')); });
      if (DATA.skipped.length) {
        app.appendChild(el('div', 'section-head', 'Skipped'));
        DATA.skipped.forEach(function (p) { app.appendChild(postCard(p, 'skipped')); });
      }
    } else if (TAB === 'posted') {
      app.appendChild(el('div', 'section-head', 'Published'));
      if (!DATA.posted.length) app.appendChild(el('div', 'empty', 'Nothing published yet.'));
      DATA.posted.forEach(function (p) { app.appendChild(postCard(p,'posted')); });
    } else if (TAB === 'analytics') {
      if (!AN) loadAnalytics();
      app.appendChild(insightsPanel());
    } else {
      app.appendChild(settingsPanel());
    }
  }

  document.getElementById('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  document.getElementById('signin').addEventListener('click', doLogin);
  // older versions kept the password itself in localStorage
  try { localStorage.removeItem('dash_pw'); } catch (e) {}
  load();
