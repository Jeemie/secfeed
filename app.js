(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sf:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('sf:' + k, JSON.stringify(v)); } catch {} },
  };
  const FRAMED = (() => { try { return window.top !== window.self; } catch { return true; } })();
  const TOPICS = { vulns: 'Vulns & patches', malware: 'Malware', breaches: 'Breaches', cloud: 'Cloud', microsoft: 'Microsoft', linux: 'Linux',
    network: 'Network', ai: 'AI', actors: 'Threat actors', policy: 'Policy & law', devsecops: 'DevSecOps', tutorials: 'Tutorials' };
  const SEV = { critical: 'Critical', high: 'High', info: 'Info' };
  const ICON = {
    save: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v13M7 8l5-5 5 5M5 14v6h14v-6"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  };

  let prefs = Object.assign({ topics: [], deck: 12, videos: true, community: true, theme: 'system' }, store.get('prefs', {}));
  let seen = store.get('seen', {});
  let saved = store.get('saved', []);
  let feed = null, deck = [], replay = false, loadedAt = 0;
  const now = Date.now();
  for (const [k, t] of Object.entries(seen)) if (now - t > 7 * 864e5) delete seen[k];

  const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Only allow web links from the feed (blocks javascript:, data: etc. if a source were ever tampered with)
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? esc(String(u).trim()) : '#');
  const today = () => new Date().toLocaleDateString('en-CA');
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 6e4));
    if (m < 60) return m + 'm ago'; const h = Math.round(m / 60); if (h < 36) return h + 'h ago'; return Math.round(h / 24) + 'd ago';
  };
  const fmtDate = (d) => new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const applyTheme = () => { const r = document.documentElement; prefs.theme === 'system' ? r.removeAttribute('data-theme') : r.setAttribute('data-theme', prefs.theme); };
  applyTheme();

  // ---------- deck ----------
  const topicOK = (it) => !prefs.topics.length || (it.tags || []).some((t) => prefs.topics.includes(t));
  function buildDeck() {
    const fresh = (it) => replay || !seen[it.id];
    const items = feed.items || [];
    const news = items.filter((i) => i.type === 'news' && fresh(i));
    const picked = [...news.filter(topicOK), ...news.filter((i) => !topicOK(i) && i.severity === 'critical').map((i) => ({ ...i, outside: true }))];
    const videos = prefs.videos ? items.filter((i) => i.type === 'video' && fresh(i) && (!prefs.topics.length || prefs.topics.includes('tutorials') || topicOK(i))) : [];
    const reddit = prefs.community ? items.filter((i) => i.type === 'reddit' && fresh(i) && (!i.tags.length || topicOK(i))) : [];
    const kevId = 'kev-' + (feed.kev || []).map((k) => k.cve).join(',');
    const kev = feed.kev?.length && fresh({ id: kevId }) ? { type: 'kev', id: kevId, severity: 'critical', items: feed.kev.slice(0, 4) } : null;
    const quiz = feed.quiz?.length && (replay || store.get('quizDay') !== today()) ? { type: 'quiz', id: 'quiz', qs: feed.quiz } : null;

    const slots = { 2: kev, 3: videos[0], 5: reddit[0], 7: videos[1] };
    const out = [];
    picked.forEach((n, i) => { out.push(n); if (slots[i + 1]) out.push(slots[i + 1]); });
    for (const e of [kev, videos[0], reddit[0], videos[1]]) if (e && !out.includes(e)) out.push(e);
    const content = out.slice(0, prefs.deck - (quiz ? 1 : 0));
    if (quiz && content.length) content.push(quiz);
    else if (quiz && !content.length && !replay) content.push(quiz);
    return content;
  }

  // ---------- cards ----------
  const rail = (it) => {
    const on = saved.some((s) => s.id === it.id);
    return `<div class="rail">
      <button data-act="save" class="${on ? 'on' : ''}" aria-pressed="${on}" aria-label="Save"><span class="ic">${ICON.save}</span>${on ? 'Saved' : 'Save'}</button>
      <button data-act="share" aria-label="Share"><span class="ic">${ICON.share}</span>Share</button>
      <a href="${safeUrl(it.url)}" target="_blank" rel="noopener" aria-label="Open source"><span class="ic">${ICON.open}</span>Open</a></div>`;
  };
  const meta = (it, extra = '') => `<div class="meta"><span class="chip sev">${SEV[it.severity]}</span>${extra}<span class="src">${esc(it.source)} · ${ago(it.published)}</span></div>`;

  function newsCard(it, i) {
    const others = [...new Set((it.alsoIn || []).map((a) => a.source))].filter((s) => s !== it.source);
    const n = (it.alsoIn?.length || 0) + 1;
    const also = n < 2 ? '' : others.length
      ? `<div class="also">Also covered by <b>${esc(others.join(', '))}</b>${n > 2 ? ` · ${n} articles` : ''}</div>`
      : `<div class="also">${n} articles on this story</div>`;
    const body = it.ai?.bullets?.length
      ? `<div class="tldr"><span class="lbl">AI summary</span><ul>${it.ai.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>${it.ai.action ? `<div class="do">${esc(it.ai.action)}</div>` : ''}</div>`
      : `<p class="lede">${esc(it.summary)}</p>`;
    const cves = it.cves?.length ? `<div class="cves">${it.cves.map((c) => `<a href="https://nvd.nist.gov/vuln/detail/${c}" target="_blank" rel="noopener">${c}</a>`).join('')}</div>` : '';
    const img = it.image ? `<div class="hero-img"><img src="${safeUrl(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : '';
    return `<section class="card" data-sev="${it.severity}" data-i="${i}">${img}<div class="body">
      ${meta(it, it.outside ? '<span class="chip">Outside your topics</span>' : '')}
      <h2>${esc(it.title)}</h2>${body}${cves}${also}
      <div class="tags">${(it.tags || []).slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      <a class="cta" href="${safeUrl(it.url)}" target="_blank" rel="noopener">Read the story ↗</a></div>${rail(it)}</section>`;
  }
  function kevCard(it, i) {
    const rows = it.items.map((k) => `<a href="https://nvd.nist.gov/vuln/detail/${esc(k.cve)}" target="_blank" rel="noopener">
      <span class="id">${esc(k.cve)}</span><span class="due">${k.due ? 'Due ' + fmtDate(k.due) : 'Added ' + fmtDate(k.added)}</span>
      <span class="pr">${esc(k.vendor)} ${esc(k.product)}</span>
      <span class="nm">${esc(k.name)}${k.ransomware ? ' · <span class="rw">Used by ransomware</span>' : ''}</span></a>`).join('');
    const extra = feed.kev.length > it.items.length ? ` (${feed.kev.length - it.items.length} more on the list)` : '';
    return `<section class="card plain" data-sev="critical" data-i="${i}"><div class="body">
      <div class="meta"><span class="chip solid">CISA KEV</span><span>${feed.kev.length} added this week${extra}</span></div>
      <h2>Being exploited right now</h2>
      <p class="lede">These were just added to CISA's Known Exploited Vulnerabilities catalog. US federal agencies must patch by the due date; everyone else should treat them as top priority.</p>
      <div class="kev">${rows}</div>
      <a class="cta ghost" href="https://www.cisa.gov/known-exploited-vulnerabilities-catalog" target="_blank" rel="noopener">Full KEV catalog ↗</a></div></section>`;
  }
  function videoCard(it, i) {
    const inner = `<img src="https://i.ytimg.com/vi/${esc(it.videoId)}/hqdefault.jpg" alt="" loading="lazy"><span class="play">${ICON.play}</span><span class="ch">${esc(it.source)}</span>`;
    const poster = FRAMED
      ? `<a class="poster${it.short ? ' short' : ''}" href="${safeUrl(it.url)}" target="_blank" rel="noopener" aria-label="Play on YouTube">${inner}</a>`
      : `<button class="poster${it.short ? ' short' : ''}" data-act="play" aria-label="Play video">${inner}</button>`;
    return `<section class="card" data-sev="info" data-i="${i}"><div class="body">
      <div class="meta"><span class="chip">${it.short ? 'Short' : 'Tutorial'}</span><span>YouTube</span><span>${ago(it.published)}</span></div>
      ${poster}<h2>${esc(it.title)}</h2>${it.summary ? `<p class="lede">${esc(it.summary)}</p>` : ''}</div>${rail(it)}</section>`;
  }
  function redditCard(it, i) {
    return `<section class="card" data-sev="info" data-i="${i}"><div class="body">
      <div class="meta"><span class="chip">${esc(it.source)}</span><span>Community</span><span>${ago(it.published)}</span></div>
      <h2>${esc(it.title)}</h2><p class="lede">One of today's top threads. Worth a look for what other admins are dealing with.</p>
      <a class="cta" href="${safeUrl(it.url)}" target="_blank" rel="noopener">Read the thread ↗</a></div>${rail(it)}</section>`;
  }
  const quizCard = (it, i) => `<section class="card plain" data-i="${i}" data-quiz><div class="body quiz"></div></section>`;

  function introCard() {
    const h = new Date().getHours();
    const hello = h < 5 ? 'Night shift.' : h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.';
    const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const staleH = (Date.now() - new Date(feed.generatedAt)) / 36e5;
    const upd = `<span class="${staleH > 6 ? 'stale' : ''}">Updated ${ago(feed.generatedAt)}</span>`;
    if (!deck.length) {
      return `<section class="card plain" data-i="-1"><div class="body">
        <div class="meta"><span>${dateStr}</span>${upd}</div><h1>You're caught up.</h1>
        <p class="lede">You've seen everything new since the last update. New stories arrive every couple of hours.</p>
        <div class="row"><button class="cta" data-act="replay">Replay today's cards</button><button class="cta ghost" data-act="saved">Saved</button><button class="cta ghost" data-act="settings">Topics</button></div></div></section>`;
    }
    const crit = deck.filter((d) => d.severity === 'critical' && d.type === 'news').length;
    const mins = Math.max(1, Math.round(deck.length * 0.5));
    const top = deck.filter((d) => d.type === 'news').slice(0, 3);
    return `<section class="card plain" data-i="-1"><div class="body">
      <div class="meta"><span>${dateStr}</span>${upd}</div>
      <h1>${hello}</h1>
      <div class="stats"><div class="stat c"><b>${crit}</b><span>Critical</span></div><div class="stat"><b>${feed.kev?.length || 0}</b><span>New KEV</span></div><div class="stat"><b>${mins}</b><span>Minutes</span></div></div>
      <h4 class="small eyebrow">TOP OF THE STACK</h4>
      <ul class="toplist">${top.map((t) => `<li data-sev="${t.severity}">${esc(t.title)}</li>`).join('')}</ul>
      <div class="hint">${ICON.up} Swipe up · ${deck.length} cards</div></div></section>`;
  }
  function endCard() {
    const next = new Date(new Date(feed.generatedAt).getTime() + 2 * 36e5);
    const nextStr = next > new Date() ? next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'soon';
    return `<section class="card plain" data-i="${deck.length}"><div class="body">
      <div class="meta"><span>End of brief</span></div><h1>You're caught up.</h1>
      <p class="lede">${deck.length} cards · ${saved.length} saved for later. Next update around ${nextStr}.</p>
      <div class="row"><button class="cta" data-act="saved">View saved</button><button class="cta ghost" data-act="replay">Replay today's cards</button><button class="cta ghost" data-act="settings">Topics</button></div></div></section>`;
  }

  // ---------- render ----------
  const feedEl = $('#feed');
  // broken images: drop them instead of showing a broken icon (no inline handlers, so the CSP can forbid inline script)
  feedEl.addEventListener('error', (e) => { const t = e.target; if (t.tagName === 'IMG') (t.closest('.hero-img') || t).remove(); }, true);
  let io, playIo;
  function render() {
    deck = buildDeck();
    const html = [introCard()];
    deck.forEach((it, i) => html.push({ news: newsCard, kev: kevCard, video: videoCard, reddit: redditCard, quiz: quizCard }[it.type](it, i)));
    if (deck.length) html.push(endCard());
    feedEl.innerHTML = html.join('');
    feedEl.scrollTop = 0;
    $('#progress').innerHTML = deck.map(() => '<i></i>').join('');
    feedEl.querySelectorAll('[data-quiz]').forEach((el) => quiz(el.querySelector('.quiz'), deck[+el.dataset.i].qs));
    observe();
    fitCards();
    setCount(-1);
  }
  // If a card's text is taller than the screen (small phones, long AI summaries), drop the least important
  // parts step by step so the headline is never pushed off the top.
  function fitCards() {
    feedEl.querySelectorAll('.card').forEach((card) => {
      const body = card.querySelector('.body'); if (!body) return;
      card.classList.remove('fit-1', 'fit-2', 'fit-3', 'fit-4');
      const cs = getComputedStyle(card);
      const avail = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      for (let lvl = 1; lvl <= 4 && body.offsetHeight > avail; lvl++) card.classList.add('fit-' + lvl);
      // hide the banner if only a sliver of it would show below the top bar
      const hero = card.querySelector('.hero-img');
      if (hero) { hero.hidden = false; if (hero.offsetHeight - parseFloat(cs.paddingTop) < 70) hero.hidden = true; }
    });
  }
  let fitT; addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitCards, 150); });
  document.fonts?.ready.then(() => feed && fitCards());

  function setCount(i) {
    const n = deck.length;
    $('#count').textContent = i < 0 ? `${n} cards` : i >= n ? 'Done' : `${i + 1} / ${n}`;
    [...$('#progress').children].forEach((el, k) => (el.className = k < i ? 'done' : k === i ? 'now' : i >= n ? 'done' : ''));
  }
  function observe() {
    io?.disconnect();
    const timers = new Map();
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = +e.target.dataset.i;
        if (e.isIntersecting) {
          setCount(i);
          const it = deck[i];
          if (it && it.type !== 'quiz' && !seen[it.id]) timers.set(e.target, setTimeout(() => { seen[it.id] = Date.now(); store.set('seen', seen); }, 1200));
        } else {
          clearTimeout(timers.get(e.target));
          const fr = e.target.querySelector('iframe'); if (fr) fr.parentNode.outerHTML = videoCard(deck[i], i).match(/<button class="poster[\s\S]*?<\/button>/)[0];
        }
      }
    }, { root: feedEl, threshold: 0.6 });
    feedEl.querySelectorAll('.card').forEach((c) => io.observe(c));
  }

  // ---------- quiz ----------
  function quiz(el, qs) {
    let step = 0; const res = [];
    const draw = () => {
      const dots = `<div class="dots">${qs.map((_, k) => `<i class="${res[k] === true ? 'r' : res[k] === false ? 'w' : k === step ? 'c' : ''}"></i>`).join('')}</div>`;
      if (step >= qs.length) {
        const score = res.filter(Boolean).length;
        const last = store.get('quizDay'), yest = new Date(Date.now() - 864e5).toLocaleDateString('en-CA');
        if (last !== today()) { store.set('streak', last === yest ? store.get('streak', 0) + 1 : 1); store.set('quizDay', today()); }
        const streak = store.get('streak', 1);
        el.innerHTML = `<div class="meta"><span class="chip solid">Daily 3</span><span>Done</span></div>${dots}
          <div class="score">${score}/${qs.length}</div>
          <p class="lede">${score === qs.length ? 'Clean sweep.' : score ? 'Solid. The explanations are worth a reread.' : 'Tough set. New questions tomorrow.'} ${streak > 1 ? `You're on a ${streak}-day streak.` : 'Come back tomorrow to start a streak.'}</p>`;
        return;
      }
      const q = qs[step];
      el.innerHTML = `<div class="meta"><span class="chip solid">Daily 3</span><span>${esc(q.tag || 'Quiz')}</span><span>${step + 1} of ${qs.length}</span></div>${dots}
        <p class="q">${esc(q.q)}</p>
        ${q.options.map((o, k) => `<button class="opt" data-k="${k}"><kbd>${'ABCD'[k]}</kbd><span>${esc(o)}</span></button>`).join('')}
        <div class="fb" hidden></div>`;
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.opt'); const nx = e.target.closest('[data-next]');
      if (nx) { step++; draw(); return; }
      if (!b || b.disabled) return;
      answer(+b.dataset.k);
    });
    const answer = (k) => {
      const q = qs[step]; if (!q || res[step] !== undefined) return;
      res[step] = k === q.answer;
      el.querySelectorAll('.opt').forEach((o, j) => { o.disabled = true; if (j === q.answer) o.classList.add('right'); else if (j === k) o.classList.add('wrong'); });
      const fb = el.querySelector('.fb'); fb.hidden = false;
      fb.innerHTML = `<p class="explain"><b>${res[step] ? 'Correct.' : 'Not quite.'}</b> ${esc(q.explain)}</p>
        <button class="cta next" data-next>${step + 1 < qs.length ? 'Next question' : 'See score'}</button>`;
      el.querySelector('.dots').children[step].className = res[step] ? 'r' : 'w';
    };
    el._answer = answer;
    draw();
  }

  // ---------- actions ----------
  let toastT;
  function toast(msg) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); $('.app').append(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 1800);
  }
  async function share(it) {
    const data = { title: it.title, text: it.title + ' (via SecFeed)', url: it.url };
    if (navigator.share && !FRAMED) { try { await navigator.share(data); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(`${it.title}\n${it.url}`); toast('Link copied'); } catch { toast('Copy failed. Long-press Open to copy the link.'); }
  }
  function toggleSave(it, btn) {
    const i = saved.findIndex((s) => s.id === it.id);
    if (i > -1) saved.splice(i, 1); else saved.unshift({ id: it.id, title: it.title || 'CISA KEV list', url: it.url, source: it.source, at: Date.now() });
    store.set('saved', saved);
    const on = i === -1; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on); btn.lastChild.textContent = on ? 'Saved' : 'Save';
    toast(on ? 'Saved for later' : 'Removed from saved');
  }
  feedEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const card = b.closest('.card'); const it = card && deck[+card.dataset.i];
    const act = b.dataset.act;
    if (act === 'save') toggleSave(it, b);
    else if (act === 'share') share(it);
    else if (act === 'play') b.outerHTML = `<div class="poster${it.short ? ' short' : ''}"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(it.videoId)}?autoplay=1&playsinline=1&rel=0" title="${esc(it.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
    else if (act === 'replay') { replay = true; render(); }
    else if (act === 'saved') openSaved();
    else if (act === 'settings') openSettings();
  });
  document.addEventListener('keydown', (e) => {
    if ($('.sheet:not([hidden])')) { if (e.key === 'Escape') closeSheets(); return; }
    const h = feedEl.clientHeight;
    if (['ArrowDown', 'j', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); feedEl.scrollBy({ top: h, behavior: 'smooth' }); }
    if (['ArrowUp', 'k', 'PageUp'].includes(e.key)) { e.preventDefault(); feedEl.scrollBy({ top: -h, behavior: 'smooth' }); }
    const cur = feedEl.querySelector('.card:nth-child(' + (Math.round(feedEl.scrollTop / h) + 1) + ')');
    if (cur?.hasAttribute('data-quiz') && /^[1-4a-d]$/i.test(e.key)) cur.querySelector('.quiz')._answer?.('1234'.includes(e.key) ? +e.key - 1 : 'abcd'.indexOf(e.key.toLowerCase()));
    if (e.key === 's' && cur) cur.querySelector('[data-act="save"]')?.click();
  });

  // ---------- sheets ----------
  const closeSheets = () => document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
  document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) { closeSheets(); if (s.id === 'settings') render(); } }));
  $('#btn-saved').addEventListener('click', openSaved);
  $('#btn-settings').addEventListener('click', openSettings);

  function openSaved() {
    const list = $('#saved-list');
    list.innerHTML = saved.length ? saved.map((s, k) => `<li><a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><small>${esc(s.source || '')} · saved ${ago(new Date(s.at).toISOString())}</small><button data-rm="${k}">Remove</button></li>`).join('')
      : '<p class="empty">Nothing saved yet. Tap the bookmark on any card to keep it here.</p>';
    $('#saved').hidden = false;
  }
  $('#saved-list').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; saved.splice(+b.dataset.rm, 1); store.set('saved', saved); openSaved(); });

  function openSettings() {
    const t = $('#topics');
    t.innerHTML = Object.entries(TOPICS).map(([k, v]) => `<button class="toggle" data-topic="${k}" aria-pressed="${prefs.topics.includes(k)}">${v}</button>`).join('');
    document.querySelectorAll('#deck-size button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.n === prefs.deck));
    document.querySelectorAll('#theme button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.t === prefs.theme));
    $('#opt-videos').checked = prefs.videos; $('#opt-community').checked = prefs.community;
    $('#topic-note').textContent = prefs.topics.length ? 'Showing only these topics, plus any critical story you shouldn’t miss.' : 'No topics picked, so you get everything.';
    const st = Object.entries(feed?.status || {}).sort(([a], [b]) => a.localeCompare(b));
    $('#status').innerHTML = feed ? `Feed built ${ago(feed.generatedAt)}.<br>` + st.map(([k, v]) => `${esc(k)}: <span class="${/fail/.test(v) ? 'bad' : ''}">${esc(v)}</span>`).join('<br>') : '';
    $('#settings').hidden = false;
  }
  const savePrefs = () => store.set('prefs', prefs);
  $('#topics').addEventListener('click', (e) => {
    const b = e.target.closest('[data-topic]'); if (!b) return;
    const k = b.dataset.topic; prefs.topics = prefs.topics.includes(k) ? prefs.topics.filter((x) => x !== k) : [...prefs.topics, k];
    savePrefs(); openSettings();
  });
  $('#deck-size').addEventListener('click', (e) => { const b = e.target.closest('[data-n]'); if (!b) return; prefs.deck = +b.dataset.n; savePrefs(); openSettings(); });
  $('#theme').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; prefs.theme = b.dataset.t; savePrefs(); applyTheme(); openSettings(); });
  $('#opt-videos').addEventListener('change', (e) => { prefs.videos = e.target.checked; savePrefs(); });
  $('#opt-community').addEventListener('change', (e) => { prefs.community = e.target.checked; savePrefs(); });
  $('#reset-seen').addEventListener('click', () => { seen = {}; store.set('seen', seen); store.set('quizDay', ''); toast('History cleared'); });

  // ---------- load ----------
  async function load(quiet) {
    try {
      const res = await fetch('data/feed.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const next = await res.json();
      loadedAt = Date.now();
      if (quiet && feed && next.generatedAt === feed.generatedAt) return;
      feed = next; replay = false; render();
    } catch (err) {
      if (feed) return;
      feedEl.innerHTML = `<section class="card plain"><div class="body"><h1>No feed yet.</h1><p class="lede">Couldn't load today's brief. Check your connection, then try again. If you just set this up, the first update can take a few minutes to run.</p><button class="cta" id="retry">Try again</button></div></section>`;
      $('#retry').onclick = () => load();
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt > 20 * 6e4) load(true); });
  if ('serviceWorker' in navigator && !FRAMED && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  load();
})();
