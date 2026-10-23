#!/usr/bin/env node
// SecFeed updater: pulls news RSS, CISA KEV, YouTube and Reddit, ranks it,
// and writes data/feed.json for the app. No dependencies (Node 20+).
//
//   node scripts/build-feed.mjs                      # live
//   node scripts/build-feed.mjs --fixtures test/fixtures --now 2026-10-23T12:00:00Z
//
// Optional: set ANTHROPIC_API_KEY to add AI TL;DRs to the top stories (cached).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const FIXTURES = arg('--fixtures');
const NOW = arg('--now') ? new Date(arg('--now')) : new Date();
const OUT = path.join(ROOT, arg('--out') || 'data/feed.json');
const AI_CACHE = path.join(ROOT, 'data/.ai-cache.json');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/sources.json'), 'utf8'));
const bank = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/quiz-bank.json'), 'utf8'));
const UA = 'Mozilla/5.0 (compatible; SecFeedBot/1.0; +https://github.com)';
const status = {};

// ---------- fetching ----------
async function get(url, fixtureName) {
  if (FIXTURES) {
    for (const ext of ['', '.xml', '.json', '.html']) {
      try { return await fs.readFile(path.resolve(ROOT, FIXTURES, fixtureName + ext), 'utf8'); } catch {}
    }
    throw new Error('no fixture');
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ---------- tiny XML helpers (RSS 2.0 + Atom) ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, 'i')); return m ? decode(m[1]).trim() : ''; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, 'gi'))].map((m) => decode(m[1]).trim());
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${esc(name)}\\b[^>]*\\b${a}=["']([^"']*)["']`, 'i')); return m ? decode(m[1]) : ''; };
const blocks = (xml, name) => xml.match(new RegExp(`<${name}\\b[\\s\\S]*?</${name}>`, 'gi')) || [];
const safe = (u) => (/^https?:\/\//i.test((u || '').trim()) ? u.trim() : ''); // web links only
const stripHtml = (s) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\[(\.\.\.|…)\]/g, '').trim();
function clip(s, n = 300) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return end > n * 0.55 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}
function atomLink(entry) {
  const alt = entry.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i) || entry.match(/<link\b[^>]*href=[^>]*>/i);
  return alt ? (alt[0].match(/href=["']([^"']+)["']/i) || [])[1] || '' : '';
}
function parseFeed(xml) {
  const items = blocks(xml, 'item').map((it) => ({
    title: stripHtml(tag(it, 'title')),
    url: safe(tag(it, 'link')) || safe(tag(it, 'guid')),
    published: tag(it, 'pubDate') || tag(it, 'dc:date'),
    summary: stripHtml(tag(it, 'description') || tag(it, 'content:encoded')),
    author: stripHtml(tag(it, 'dc:creator') || tag(it, 'author')),
    categories: tags(it, 'category').map(stripHtml),
    image: safe(attr(it, 'enclosure', 'url') || attr(it, 'media:content', 'url') || attr(it, 'media:thumbnail', 'url')),
  }));
  if (items.length) return items;
  return blocks(xml, 'entry').map((e) => ({
    title: stripHtml(tag(e, 'title')),
    url: safe(atomLink(e)),
    published: tag(e, 'published') || tag(e, 'updated'),
    summary: stripHtml(tag(e, 'summary') || tag(e, 'content') || tag(e, 'media:description')),
    author: stripHtml(tag(e, 'name')),
    categories: [],
    image: safe(attr(e, 'media:thumbnail', 'url')),
    videoId: (tag(e, 'yt:videoId').match(/^[\w-]{6,20}$/) || [''])[0],
    views: +attr(e, 'media:statistics', 'views') || 0,
  }));
}

// ---------- classification ----------
const TAGS = {
  vulns: /\b(cve-\d|vulnerabilit|flaws?\b|zero-day|0-day|patch|rce\b|remote code|exploit|advisory|kev\b|cvss)/,
  malware: /\b(malware|ransomware|backdoor|trojan|stealer|botnet|loader|rat\b|spyware|worm|phishing|clickfix|miner)/,
  breaches: /\b(breach|leak|stolen|exposed (data|records|database)|compromis|hacked|intrusion|data theft|customer (data|secrets))/,
  cloud: /\b(aws|azure|gcp|google cloud|cloud|kubernetes|docker|saas|paas|m365|office 365|entra|okta)/,
  microsoft: /\b(microsoft|windows|exchange|outlook|active directory|entra|intune|powershell|sharepoint|defender|powertoys)/,
  linux: /\b(linux|kernel|ubuntu|debian|red hat|rhel|ksmbd|systemd|ssh)\b/,
  network: /\b(networking|network devices?|router|firewall|vpn|sd-wan|cisco|fortinet|forti\w+|palo alto|pan-os|juniper|arista|velocloud|dns|bgp|wi-?fi|http\/3|tls|ssl|tor\b)/,
  ai: /\b(ai|llm|gpt[\w.-]*|claude|gemini|openai|anthropic|agents?|agentic|chatbot|copilot|mcp)\b/,
  actors: /\b(apt\d*|state-sponsored|state-aligned|nation-state|lazarus|china-(linked|aligned)|russia\w*|north korean?|iran\w*|threat actors?|storm-\d+|hacktivist)/,
  policy: /\b(court|lawsuit|fined?|penalt|regulat|gdpr|ban(s|ned)?\b|arrest|sentenc|indict|interpol|europol|law enforcement|orders federal)/,
  devsecops: /\b(npm|pypi|github|gitlab|supply chain|package|node\.js|python|php\d?|wordpress|plugin|docker hub|ci\/cd)/,
};
const SEV_CRIT = /actively exploited|exploited in (the wild|attacks)|zero-day|0-day|cvss(?: score)?:? ?(9\.\d|10(\.0)?)|max(imum)?[- ]severity|emergency (patch|update|fix)|under (active )?attack|mass exploitation|orders federal agencies to patch/;
const SEV_HIGH = /critical|\brce\b|remote code|ransomware|breach|backdoor|supply chain|compromised|exploit|vulnerab|flaw|hijack/;
const EXCLUDE = /sponsored|webinar|weekly recap|threatsday|^\[?ad\]?\b|podcast:/i;

function classify(text) {
  const t = text.toLowerCase();
  const tg = Object.entries(TAGS).filter(([, re]) => re.test(t)).map(([k]) => k);
  const severity = SEV_CRIT.test(t) ? 'critical' : SEV_HIGH.test(t) ? 'high' : 'info';
  const cves = [...new Set((text.match(/CVE-\d{4}-\d{4,}/gi) || []).map((c) => c.toUpperCase()))];
  return { tags: tg, severity, cves };
}

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const hoursOld = (d) => (NOW - new Date(d)) / 36e5;
const validDate = (d) => d && !isNaN(new Date(d));

// ---------- story clustering ----------
const STOP = new Set(('the a an of to in on for and or with by from as at is are was be its it this that new how why what who after over into via up out about '
  + 'says said warns warn patches patch patched fix fixes fixed flaw flaws bug bugs critical security vulnerability vulnerabilities attack attacks attackers hackers hacker '
  + 'exploited exploit exploits exploitation update updates released release issues ships adds users servers server could allow lets more than two three four first '
  + 'zero-day actively emergency report reports researchers disclosed found used use using now still against before').split(' '));
function tokens(title) {
  return new Set(title.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9.-]+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}
const BIG = new Set('microsoft google chrome windows apple android linux amazon cisa openai github cloud meta cisco security cybercrime malware ransomware'.split(' '));
let DF = new Map(); // how many titles each token appears in
const strong = (w) => /\d/.test(w) && /[a-z]/.test(w) && w.length >= 5 && !/^\d+(st|nd|rd|th|s)$/.test(w);
function sameStory(a, b) {
  if (a.cves.some((c) => b.cves.includes(c))) return true;
  const shared = [...a.tok].filter((w) => b.tok.has(w));
  if (shared.some(strong)) return true;
  // rare name both headlines lead with, e.g. "GitLab warns…" / "Critical GitLab flaw…"
  const lead = (x) => [...x.tok].slice(0, 2);
  if (shared.some((w) => w.length >= 5 && !BIG.has(w) && (DF.get(w) || 0) <= 3 && lead(a).includes(w) && lead(b).includes(w))) return true;
  return shared.length >= 2 && shared.length / Math.min(a.tok.size, b.tok.size) >= 0.5;
}

// ---------- sources ----------
async function loadNews() {
  const out = [];
  await Promise.all(cfg.news.map(async (src) => {
    try {
      const items = parseFeed(await get(src.url, src.id));
      let n = 0;
      for (const it of items) {
        if (!it.title || !it.url || !validDate(it.published)) continue;
        if (EXCLUDE.test(it.title) || /sponsored/i.test(it.author)) continue;
        if (hoursOld(it.published) > cfg.maxAgeHours.news || hoursOld(it.published) < -2) continue;
        const c = classify(`${it.title}. ${it.summary}`);
        out.push({ type: 'news', id: hash(it.url), title: it.title, summary: clip(it.summary), url: it.url, source: src.name,
          weight: src.weight, published: new Date(it.published).toISOString(), image: it.image || undefined, ...c });
        n++;
      }
      status[src.name] = n ? `ok (${n})` : 'ok (0 recent)';
    } catch (e) { status[src.name] = 'failed: ' + e.message; }
  }));
  return out;
}

function clusterNews(items) {
  items.forEach((i) => (i.tok = tokens(i.title)));
  DF = new Map(); items.forEach((i) => i.tok.forEach((w) => DF.set(w, (DF.get(w) || 0) + 1)));
  items.sort((a, b) => b.weight - a.weight || b.summary.length - a.summary.length);
  const clusters = [];
  for (const it of items) {
    const c = clusters.find((cl) => sameStory(cl[0], it)); // compare to the lead only, so stories don't chain
    c ? c.push(it) : clusters.push([it]);
  }
  const sevW = { critical: 40, high: 20, info: 8 };
  const rank = { critical: 3, high: 2, info: 1 };
  return clusters.map((cl) => {
    const lead = cl[0];
    const sources = new Set(cl.map((m) => m.source));
    const newest = cl.map((m) => m.published).sort().at(-1);
    const severity = cl.map((m) => m.severity).sort((a, b) => rank[b] - rank[a])[0];
    const tagsU = [...new Set(cl.flatMap((m) => m.tags))];
    const story = {
      type: 'news', id: lead.id, title: lead.title, summary: lead.summary, url: lead.url, source: lead.source,
      published: newest, image: cl.find((m) => m.image)?.image, severity, tags: tagsU,
      cves: [...new Set(cl.flatMap((m) => m.cves))].slice(0, 4),
      alsoIn: cl.slice(1, 5).map((m) => ({ source: m.source, title: m.title, url: m.url })),
      coverage: sources.size,
      _context: cl.map((m) => `${m.source}: ${m.title}. ${m.summary}`).join('\n'),
    };
    story.score = Math.round(sevW[severity] + 12 * (sources.size - 1) + 3 * Math.min(cl.length - 1, 3)
      + (tagsU.includes('vulns') ? 4 : 0) + 5 * (lead.weight - 1) * 10 - 0.5 * Math.max(0, hoursOld(newest)));
    return story;
  }).sort((a, b) => b.score - a.score);
}

async function loadKev() {
  let data;
  for (const [i, url] of cfg.kev.urls.entries()) {
    try { data = JSON.parse(await get(url, i ? 'kev-mirror' : 'kev')); break; } catch (e) { status.CISA_KEV = 'failed: ' + e.message; }
  }
  if (!data) return { recent: [], products: [] };
  const all = data.vulnerabilities || [];
  const recent = all.filter((v) => hoursOld(v.dateAdded + 'T12:00:00Z') <= cfg.kev.days * 24)
    .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
    .map((v) => ({ cve: v.cveID, vendor: v.vendorProject, product: v.product, name: v.vulnerabilityName, added: v.dateAdded,
      due: v.dueDate || undefined, ransomware: v.knownRansomwareCampaignUse === 'Known', description: clip(v.shortDescription || '', 220) }));
  status.CISA_KEV = `ok (${recent.length} added in ${cfg.kev.days}d)`;
  return { recent, products: [...new Set(all.map((v) => `${v.vendorProject} ${v.product}`))] };
}

async function resolveChannel(handle) {
  const html = await get(`https://www.youtube.com/@${handle}`, `yt-handle-${handle}`);
  const m = html.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error('could not resolve @' + handle);
  return m[1];
}
async function loadVideos() {
  const out = [];
  await Promise.all(cfg.youtube.map(async (ch) => {
    const tryId = async (id) => parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, `yt-${id}`));
    try {
      let items;
      try { if (!ch.id) throw 0; items = await tryId(ch.id); } catch { items = await tryId(await resolveChannel(ch.handle)); }
      for (const it of items.slice(0, 6)) {
        if (!it.videoId || !validDate(it.published)) continue;
        const c = classify(`${it.title}. ${it.summary}`);
        out.push({ type: 'video', id: 'yt' + it.videoId, videoId: it.videoId, title: it.title, summary: clip(it.summary, 180),
          url: it.url || `https://www.youtube.com/watch?v=${it.videoId}`, source: ch.name, published: new Date(it.published).toISOString(),
          short: /\/shorts\//.test(it.url), views: it.views, tags: [...new Set(['tutorials', ...c.tags])], severity: 'info' });
      }
      status['YouTube: ' + ch.name] = 'ok';
    } catch (e) { status['YouTube: ' + ch.name] = 'failed: ' + (e.message || e); }
  }));
  const fresh = out.filter((v) => hoursOld(v.published) <= cfg.maxAgeHours.video);
  const pool = fresh.length >= 2 ? fresh : out; // evergreen fallback if channels are quiet
  pool.forEach((v) => (v.score = Math.round(30 + (v.short ? 8 : 0) + Math.log10((v.views || 0) + 10) * 4 - hoursOld(v.published) / 48)));
  // keep max 2 per channel so one creator can't dominate
  const perCh = {};
  return pool.sort((a, b) => b.score - a.score).filter((v) => (perCh[v.source] = (perCh[v.source] || 0) + 1) <= 2);
}

async function loadReddit() {
  const out = [];
  await Promise.all(cfg.reddit.map(async ({ sub }) => {
    try {
      const items = parseFeed(await get(`https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=6`, `reddit-${sub}`));
      for (const [rank, it] of items.entries()) {
        if (!it.title || !it.url || /megathread|weekly|monthly|moronic monday|thickheaded thursday|mentorship/i.test(it.title)) continue;
        if (validDate(it.published) && hoursOld(it.published) > cfg.maxAgeHours.reddit) continue;
        const c = classify(it.title);
        out.push({ type: 'reddit', id: hash(it.url), title: it.title, url: it.url, source: 'r/' + sub,
          published: validDate(it.published) ? new Date(it.published).toISOString() : NOW.toISOString(),
          tags: c.tags, severity: 'info', score: 25 - rank * 3 });
      }
      status['Reddit r/' + sub] = 'ok';
    } catch (e) { status['Reddit r/' + sub] = 'failed: ' + e.message; }
  }));
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

// ---------- quiz ----------
function dayNumber(d) { return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 864e5); }
function seeded(seed) { return () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32); }
function buildQuiz(kev) {
  const day = dayNumber(NOW), rnd = seeded(day);
  const qs = [];
  const fresh = kev.recent[0];
  if (fresh && kev.products.length > 8) {
    const right = `${fresh.vendor} ${fresh.product}`;
    const wrong = new Set();
    while (wrong.size < 3) { const p = kev.products[Math.floor(rnd() * kev.products.length)]; if (p !== right) wrong.add(p); }
    const options = [right, ...wrong].sort(() => rnd() - 0.5);
    qs.push({ id: 'kev-' + fresh.cve, tag: 'This week', q: `CISA just added ${fresh.cve} to its Known Exploited Vulnerabilities list. What does it affect?`,
      options, answer: options.indexOf(right), explain: `${fresh.cve}: ${fresh.name}. ${fresh.ransomware ? 'Known to be used in ransomware campaigns. ' : ''}${fresh.due ? 'Federal agencies must fix it by ' + fresh.due + '.' : ''}`.trim() });
  }
  const need = 3 - qs.length;
  for (let i = 0; i < need; i++) qs.push(bank[(day * 3 + i) % bank.length]); // cycles the whole bank before repeating
  return qs.map((q) => ({ ...q }));
}

// ---------- optional AI TL;DR ----------
async function addAiSummaries(stories) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return (status['AI summaries'] = 'off (no ANTHROPIC_API_KEY)'), false;
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(AI_CACHE, 'utf8')); } catch {}
  let calls = 0;
  for (const s of stories.slice(0, cfg.ai.topStories)) {
    if (cache[s.id]) { s.ai = cache[s.id].ai; continue; }
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.ai.model, max_tokens: 300, messages: [{ role: 'user', content:
          `You write a 20-second morning briefing card for IT and security staff. Using ONLY the reporting below, return JSON: {"bullets":[3 strings, each under 18 words],"action":"one concrete thing an admin should do today, under 16 words, or empty string if none"}. No speculation.\n\n${s._context.slice(0, 4000)}` }] }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const text = j.content?.map((c) => c.text || '').join('') || '';
      const ai = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      if (Array.isArray(ai.bullets)) { s.ai = { bullets: ai.bullets.slice(0, 3), action: ai.action || '' }; cache[s.id] = { ai: s.ai, at: NOW.toISOString() }; calls++; }
    } catch (e) { console.warn('AI summary failed for', s.title, e.message); }
  }
  const keep = Object.entries(cache).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 300);
  await fs.writeFile(AI_CACHE, JSON.stringify(Object.fromEntries(keep)));
  status['AI summaries'] = `on (${calls} new, rest cached)`;
  return true;
}

// ---------- main ----------
const [rawNews, kev, videos, reddit] = await Promise.all([loadNews(), loadKev(), loadVideos(), loadReddit()]);
const stories = clusterNews(rawNews);
const ai = await addAiSummaries(stories);
stories.forEach((s) => delete s._context);

const items = [...stories.slice(0, 40), ...videos.slice(0, 8), ...reddit];
if (!stories.length && !kev.recent.length) {
  console.error('Every news source failed — not publishing, so the last good feed stays live.', status);
  process.exit(1);
}
const feed = { generatedAt: NOW.toISOString(), ai, status, kev: kev.recent.slice(0, 6), quiz: buildQuiz(kev), items };
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(feed));
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${stories.length} stories, ${kev.recent.length} KEV, ${videos.length} videos, ${reddit.length} reddit`);
console.table(status);
