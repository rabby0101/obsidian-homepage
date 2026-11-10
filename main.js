/* ─────────────────────────────────────────────────────────────────────────
   Homepage (Rabby) — v1.0.0

   WHY THIS EXISTS

   Homepage.md rendered six Dataview blocks. Four things made that feel
   like a web page assembling itself rather than an app:

     1. Dataview builds its own index over 1,687 notes before any query
        returns. Every block sits empty until that finishes.
     2. Markdown post-processors run *after* the view paints, so there is
        always a frame showing an incomplete page.
     3. All 43 banners are remote Unsplash URLs — an HTTP request each,
        on every boot.
     4. Nothing reserved its own height, so each block landing shoved
        everything below it down.

   This fixes all four:

     1. Reads app.metadataCache directly. That is Obsidian's own index,
        already warm at onLayoutReady. No second index, no waiting.
     2. It is an ItemView, not a note. It renders itself, once, in its
        own paint. No post-processor pipeline.
     3. Remote banners are copied into the vault on first sight and read
        from disk after that. Boot touches no network.
     4. Every card has a fixed aspect ratio and every section a reserved
        height, so nothing can shift.

   And the trick that makes it feel instant: the last render is saved to
   plugin data as a snapshot. On open, the snapshot paints synchronously
   in the first frame, then the real scan runs and quietly reconciles.
   You never see an empty state.
   ───────────────────────────────────────────────────────────────────── */

'use strict';

const {
  ItemView, MarkdownView, Modal, Plugin, PluginSettingTab, Setting, FuzzySuggestModal,
  Menu, Notice, Platform, setIcon, requestUrl, normalizePath, TFile, getIconIds,
  ToggleComponent, ExtraButtonComponent,
} = require('obsidian');

const VIEW_TYPE   = 'rabby-homepage-view';
const TABS_VIEW   = 'rabby-open-tabs-view';
const BANNER_DIR  = 'Attachments/_banners';


/* Colours and icons lifted from Callouts.css so the view matches the
   callouts it replaces. */
const SECTIONS = [
  { id: 'Career',   label: 'Career',   icon: 'briefcase',       rgb: '254,153,0'   },
  { id: 'Article',  label: 'Article',  icon: 'file-bar-chart',  rgb: '81,254,0'    },
  { id: 'Finance',  label: 'Finance',  icon: 'wallet-cards',    rgb: '0,186,254'   },
  { id: 'Personal', label: 'Personal', icon: 'user',            rgb: '255,134,215' },
  { id: 'Study',    label: 'Study',    icon: 'graduation-cap',  rgb: '255,128,128' },
  { id: 'Family',   label: 'Family',   icon: 'users',           rgb: '186,148,255' },
];

const BOOKMARK_PREVIEW = 4;

/* Sections are user data now (settings.sections). SECTIONS above is only
   the factory default — what a fresh install, or "Reset", starts from.
   `match` is the Class value a note needs to appear in the section, and
   is kept apart from the label so renaming a section never orphans its
   notes. */
function defaultSections() {
  return SECTIONS.map(s => ({ ...s, match: s.id, hidden: false, linked: false }));
}

/* Colours handed out to new sections, in turn. */
const PALETTE = [
  '99,102,241', '20,184,166', '245,158,11', '236,72,153',
  '132,204,22', '14,165,233', '239,68,68', '168,85,247',
];

const rgbToHex = rgb => '#' + String(rgb).split(',').map(n =>
  Math.max(0, Math.min(255, parseInt(n, 10) || 0)).toString(16).padStart(2, '0')).join('');

const hexToRgb = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '128,128,128';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

/** The theme's accent colour as "r,g,b" (bookmarks always use it). */
function accentRgb() {
  const probe = document.body.createDiv();
  probe.style.color = 'var(--interactive-accent)';
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color || '');
  probe.remove();
  return m ? `${m[1]},${m[2]},${m[3]}` : '139,92,246';
}

/* ── helpers ────────────────────────────────────────────────────────── */

/** `"[[Inbox/Personal|Personal]]"` → `"Personal"`. Also copes with arrays,
 *  bare strings, and links without an alias. */
function normClass(v) {
  if (v == null) return '';
  if (Array.isArray(v)) v = v[0];
  let s = String(v).trim();
  const m = s.match(/^\[\[(.+?)\]\]$/);
  if (m) s = m[1];
  if (s.includes('|')) s = s.split('|').pop();
  if (s.includes('/')) s = s.split('/').pop();
  return s.trim();
}

/** Stable short hash of a string — used to name cached banner files. */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Deterministic hue per note, so a bannerless card is a colour rather
 *  than a grey hole. Same note always gets the same colour. */
function hueOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

const isRemote = u => /^https?:\/\//i.test(u || '');

/* ── the view ───────────────────────────────────────────────────────── */

class HomepageView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.fetching = new Set();
    this.sectionEls = new Map();
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Home'; }
  getIcon()        { return 'home'; }

  async onOpen() {
    this.root = this.contentEl.createDiv({ cls: 'hp' });

    /* FIRST FRAME — built synchronously from the saved snapshot. Nothing
       here awaits, so it is on screen before the event loop yields. */
    this.build(this.plugin.settings.snapshot || { bookmarks: [], sections: {} });

    /* Then reconcile against the live vault, once Obsidian says its own
       index is ready. */
    this.app.workspace.onLayoutReady(() => {
      this.reconcile();
      this.registerEvent(this.app.metadataCache.on('changed', () => { this.queueReconcile(); this.refreshOverview(); }));
      this.registerEvent(this.app.vault.on('delete',  () => this.queueReconcile()));
      this.registerEvent(this.app.vault.on('rename',  () => this.queueReconcile()));
    });
  }

  async onClose() { this.contentEl.empty(); }

  queueReconcile() {
    clearTimeout(this._rq);
    this._rq = setTimeout(() => this.reconcile(), 400);
  }

  /* ── scan: metadataCache only, no Dataview ─────────────────────── */

  scan() {
    /* hidden sections are not scanned at all — they cost nothing */
    const live = this.plugin.getSections().filter(s => !s.hidden);
    const sections = {};
    const byMatch = new Map();      // lower-cased Class value → section ids
    for (const s of live) {
      sections[s.id] = [];
      const k = String(s.match || s.label || s.id).trim().toLowerCase();
      if (!byMatch.has(k)) byMatch.set(k, []);
      byMatch.get(k).push(s.id);
    }

    for (const f of this.app.vault.getMarkdownFiles()) {
      /* anywhere in the vault: a section is defined by frontmatter, not by
         where the note lives. The cache lookup is cheap, and the type check
         below discards nearly everything immediately. */
      if (f.path.startsWith('.') || f.path.includes('/.')) continue;

      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm || fm.type !== 'Widget') continue;

      const ids = byMatch.get(normClass(fm.Class).toLowerCase());
      if (!ids) continue;

      const entry = {
        path:   f.path,
        title:  (fm.title && String(fm.title)) || f.basename,
        banner: fm.banner ? String(fm.banner) : '',
        icon:   fm.banner_icon ? String(fm.banner_icon) : '',
        ctime:  f.stat.ctime,
      };
      for (const id of ids) sections[id].push(entry);
    }

    for (const k of Object.keys(sections)) sections[k].sort((a, b) => b.ctime - a.ctime);

    return { bookmarks: this.plugin.settings.hideBookmarks ? [] : this.scanBookmarks(), sections };
  }

  scanBookmarks() {
    const bm = this.app.internalPlugins.getPluginById('bookmarks');
    if (!bm || !bm.enabled) return [];

    const inst = bm.instance;
    const tops = (typeof inst.getBookmarks === 'function' ? inst.getBookmarks() : inst.items) || [];

    const flat = (items, out = []) => {
      for (const i of items || []) {
        if (i.type === 'group') flat(i.items, out);
        else if (i.type === 'file') out.push(i);
      }
      return out;
    };

    const seen = new Set();
    const out = [];
    for (const b of flat(tops)) {
      if (!b.path || seen.has(b.path)) continue;
      seen.add(b.path);

      const f = this.app.vault.getAbstractFileByPath(b.path);
      if (!(f instanceof TFile) || f.extension !== 'md') continue;

      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      out.push({
        path:   f.path,
        title:  b.title || (fm.title && String(fm.title)) || f.basename,
        banner: fm.banner ? String(fm.banner) : '',
        icon:   fm.banner_icon ? String(fm.banner_icon) : '',
        folder: f.parent ? f.parent.path : '/',
      });
    }
    return out;
  }

  async reconcile() {
    const data = this.scan();

    /* Only rebuild the DOM if something actually changed — otherwise the
       snapshot paint stands and there is no second flash. */
    const next = JSON.stringify(data);
    if (next !== this._last) {
      this._last = next;
      this.build(data);
    }

    this.plugin.settings.snapshot = data;
    this.plugin.saveSnapshot();

    this.cacheBannersInBackground(data);
  }

  /* ── banner resolution ─────────────────────────────────────────── */

  /** Returns a src that can be used right now, or '' if we have nothing
   *  local yet. Never returns a remote URL during boot — a remote URL is
   *  a network request, which is the thing we are removing. */
  resolveBanner(raw, { allowRemote = false } = {}) {
    if (!raw) return '';

    if (isRemote(raw)) {
      const cached = this.app.vault.getAbstractFileByPath(this.bannerPath(raw));
      if (cached instanceof TFile) return this.app.vault.getResourcePath(cached);
      return allowRemote ? raw : '';
    }

    /* local: a vault path, or [[wikilink]], or ![[embed]] */
    let p = raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
    const f = this.app.metadataCache.getFirstLinkpathDest(p, '') ||
              this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? this.app.vault.getResourcePath(f) : '';
  }

  bannerPath(url) {
    const clean = url.split('?')[0];
    const ext = (clean.match(/\.(jpe?g|png|webp|gif|avif)$/i) || [, 'jpg'])[1].toLowerCase();
    return normalizePath(`${BANNER_DIR}/${hash(url)}.${ext}`);
  }

  /** Copies remote banners into the vault, one at a time, after the view
   *  is already on screen. Runs once per URL, ever. */
  async cacheBannersInBackground(data) {
    const urls = new Set();
    for (const b of data.bookmarks) if (isRemote(b.banner)) urls.add(b.banner);
    for (const list of Object.values(data.sections)) {
      for (const it of list) if (isRemote(it.banner)) urls.add(it.banner);
    }

    const todo = [...urls].filter(u => {
      if (this.fetching.has(u)) return false;
      return !(this.app.vault.getAbstractFileByPath(this.bannerPath(u)) instanceof TFile);
    });
    if (!todo.length) return;

    await this.ensureFolder(BANNER_DIR);

    for (const url of todo) {
      this.fetching.add(url);
      try {
        const res = await requestUrl({ url, throw: false });
        if (res.status >= 200 && res.status < 300 && res.arrayBuffer) {
          const path = this.bannerPath(url);
          if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
            await this.app.vault.createBinary(path, res.arrayBuffer);
          }
          this.swapBanner(url, path);
        }
      } catch (e) {
        console.warn('[homepage] banner fetch failed', url, e);
      } finally {
        this.fetching.delete(url);
      }
      await new Promise(r => setTimeout(r, 120));   // be polite
    }
  }

  /** Point every tile that wanted this URL at the local copy, without a
   *  rebuild — so the swap is a single image decode, not a relayout. */
  swapBanner(url, path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const src = this.app.vault.getResourcePath(f);
    this.root.findAll(`[data-banner="${CSS.escape(url)}"]`).forEach(el => {
      const img = el.querySelector('img') || el.createEl('img', { attr: { loading: 'lazy', alt: '' } });
      img.src = src;
      el.addClass('is-loaded');
    });
  }

  async ensureFolder(path) {
    const parts = normalizePath(path).split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (_) { /* raced */ }
      }
    }
  }

  /* ── render ────────────────────────────────────────────────────── */

  build(data) {
    const scrollTop = this.root.scrollTop;
    this.root.empty();
    this.sectionEls.clear();

    this.buildHeader();
    this.buildOverview();
    this.buildQuote();
    if (!this.plugin.settings.hideBookmarks) this.buildBookmarks(data.bookmarks || []);

    for (const s of this.plugin.getSections()) {
      if (s.hidden) continue;
      const items = (data.sections && data.sections[s.id]) || [];
      this.buildSection(s, items);
    }

    this.root.scrollTop = scrollTop;
  }

  buildHeader() {
    const h = this.root.createDiv({ cls: 'hp-head' });
    const now = new Date();
    const hour = now.getHours();
    const greet = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning'
                : hour < 18 ? 'Good afternoon' : 'Good evening';

    h.createDiv({ cls: 'hp-greet', text: greet });
    h.createDiv({
      cls: 'hp-date',
      text: now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    });
  }

  /* ── overview: a few plain sentences about tasks ──────────────────
     Reads the same tasks the Task Manager does (checkboxes under "## Tasks"
     in notes with `type: Project`). Paints the last result at once, then
     recomputes, so the first frame never waits on the vault. */
  buildOverview() {
    this._ovEl = this.root.createDiv({ cls: 'hp-ov' });
    this.paintOverview(this._ovData || null);
    this.refreshOverview();
  }

  paintOverview(d) {
    const el = this._ovEl;
    if (!el || !el.isConnected) return;
    el.empty();
    if (!d) { el.createDiv({ cls: 'hp-ov-sentence' }).createSpan({ cls: 'hp-ov-dim', text: 'Taking a look at your day…' }); return; }

    /* one flowing sentence: quiet words, bright key phrases, inline icons */
    const p = el.createDiv({ cls: 'hp-ov-sentence' });
    for (const part of d.parts) {
      if (part.ic) {
        const w = p.createSpan({ cls: 'hp-ov-ic' });
        w.style.setProperty('--ov-rgb', part.ic.rgb);
        setIcon(w.createSpan({ cls: 'hp-ov-ic-i' }), part.ic.icon);
        w.createSpan({ cls: 'hp-ov-hi', text: part.ic.text });
      } else {
        p.createSpan({ cls: part.hi ? 'hp-ov-hi' : 'hp-ov-dim', text: part.t });
      }
    }
  }

  refreshOverview() {
    clearTimeout(this._ovq);
    this._ovq = setTimeout(async () => {
      try {
        this._ovData = await this.computeOverview();
        this.paintOverview(this._ovData);
      } catch (_) { /* leave the last text in place */ }
    }, 250);
  }

  async computeOverview() {
    const RE_TASK = /^(\s*)-\s\[([ xX])\]\s?(.*)$/;
    const RE_DUE  = /📅\s*(\d{4}-\d{2}-\d{2})/;
    const clean = t => t
      .replace(/\s*\^tm[a-z0-9]+\s*$/, '').replace(RE_DUE, '').replace(/⏰\s*\d{1,2}:\d{2}(?:\s*[–—-]\s*\d{1,2}:\d{2})?/, '').replace(/↻\s*\d+/, '').replace(/\(from\s+\d{4}-\d{2}-\d{2}\)/, '').replace(/\((High|Medium|Low)\)/ig, '')
      .replace(/🔖\s*[^\s🔖📅(]+/g, '').replace(/✅\s*\d{4}-\d{2}-\d{2}/, '').replace(/\s{2,}/g, ' ').trim();

    const tasks = [];
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => this.app.metadataCache.getFileCache(f)?.frontmatter?.type === 'Project');
    await Promise.all(files.map(async f => {
      let data; try { data = await this.app.vault.cachedRead(f); } catch (_) { return; }
      const lines = data.split('\n');
      const start = lines.findIndex(l => /^#+\s*Tasks\s*$/i.test(l.trim()));
      if (start === -1) return;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i])) break;
        const m = lines[i].match(RE_TASK);
        if (!m || m[2].toLowerCase() === 'x') continue;
        tasks.push({
          text: clean(m[3]) || 'Untitled', due: (m[3].match(RE_DUE) || [])[1] || '',
          time: ((m[3].match(/⏰\s*(\d{1,2}:\d{2})/) || [])[1] || '').replace(/^(\d):/, '0$1:'),
          end: ((m[3].match(/⏰\s*\d{1,2}:\d{2}\s*[–—-]\s*(\d{1,2}:\d{2})/) || [])[1] || '').replace(/^(\d):/, '0$1:'),
          moves: parseInt((m[3].match(/↻\s*(\d+)/) || [])[1] || '0', 10),
          from: (m[3].match(/\(from\s+(\d{4}-\d{2}-\d{2})\)/) || [])[1] || '',
          path: f.path, project: f.basename, line: i,
        });
      }
    }));

    const iso = d => d.toLocaleDateString('en-CA');
    const now = new Date();
    const today = iso(now);
    const tomorrow = iso(new Date(now.getTime() + 864e5));
    const week = iso(new Date(now.getTime() + 7 * 864e5));
    const byDue = (a, b) => a.due.localeCompare(b.due);
    const day = d => d === today ? 'Today' : d === tomorrow ? 'Tomorrow'
      : new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');

    const todays   = tasks.filter(t => t.due === today);
    const overdue  = tasks.filter(t => t.due && t.due < today).sort(byDue);
    const upcoming = tasks.filter(t => t.due > today).sort(byDue);
    const soon     = upcoming.filter(t => t.due <= week);
    const moved    = tasks.filter(t => t.moves > 0).sort((a, b) => b.moves - a.moves);

    const words = ['no', 'one', 'two', 'three', 'four', 'five'];
    const num = n => words[n] || String(n);
    const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

    const C = { today: ['sun', '255,176,32'], late: ['calendar-clock', '255,99,120'],
                moved: ['refresh-cw', '168,128,255'], ahead: ['calendar-days', '56,189,248'] };
    const ic = (k, text) => ({ ic: { icon: C[k][0], rgb: C[k][1], text } });

    /* one sentence, written the way you would say it */
    const parts = [];
    if (todays.length) {
      parts.push({ t: 'You have ' }, ic('today', plural(todays.length, 'task')), { t: ' today' });
      const nowHM = now.toTimeString().slice(0, 5);
      const nextT = todays.filter(t => t.time && t.time >= nowHM).sort((a, b) => a.time.localeCompare(b.time))[0];
      if (nextT) parts.push({ t: ', next at ' }, { t: nextT.time + (nextT.end ? '–' + nextT.end : ''), hi: true });
    } else {
      parts.push({ t: 'Nothing is due today' });
    }
    const tail = [];
    if (overdue.length) tail.push([ic('late', `${num(overdue.length)} overdue`), ` ${overdue.length === 1 ? 'needs' : 'need'} a new date`]);
    if (moved.length)   tail.push([ic('moved', `${num(moved.length)} rescheduled`), '']);
    if (soon.length)    tail.push([ic('ahead', `${num(soon.length)} coming up`), ' this week']);
    else if (upcoming.length) tail.push([ic('ahead', 'one next up'), ` on ${day(upcoming[0].due)}`]);

    if (tail.length) {
      parts.push({ t: '. ' });
      tail.forEach(([chip, rest], i) => {
        if (i > 0) parts.push({ t: i === tail.length - 1 ? ', and ' : ', ' });
        parts.push(chip);
        if (rest) parts.push({ t: rest });
      });
      parts.push({ t: '.' });
    } else {
      parts.push({ t: '. ' });
    }
    if (!todays.length && !overdue.length) {
      if (tail.length) parts.push({ t: " You're " }, { t: 'mostly free', hi: true }, { t: '.' });
      else parts.push({ t: "You're " }, { t: 'all clear', hi: true }, { t: '.' });
    }

    return { parts };
  }

  buildQuote() {
    const q = this.plugin.settings.quote;
    if (!q || q.enabled === false || !(q.text || '').trim()) return;
    const el = this.root.createDiv({ cls: 'hp-quote' });
    el.createDiv({ cls: 'hp-quote-t', text: q.text });
    if (q.by) el.createDiv({ cls: 'hp-quote-b', text: `— ${q.by}` });
  }

  /* ── bookmarks: 2×2 + expandable list ──────────────────────────── */

  buildBookmarks(marks) {
    const B = this.plugin.settings.bookmarks || {};
    const label = 'Bookmarks', icon = 'bookmark';
    const preview = Math.max(1, B.preview | 0 || BOOKMARK_PREVIEW);
    const wrap = this.root.createDiv({ cls: 'hp-sec hp-bm' });
    wrap.style.setProperty('--hp-rgb', accentRgb());

    const head = wrap.createDiv({ cls: 'hp-sec-h' });
    setIcon(head.createSpan({ cls: 'hp-sec-i' }), icon);
    head.createSpan({ cls: 'hp-sec-t', text: label });
    if (marks.length) head.createSpan({ cls: 'hp-sec-n', text: String(marks.length) });

    if (!marks.length) {
      wrap.createDiv({ cls: 'hp-empty', text: 'No bookmarked notes yet' });
      return;
    }

    const grid = wrap.createDiv({ cls: 'hp-grid hp-grid-2' });
    marks.slice(0, preview).forEach(m => grid.appendChild(this.card(m, { label, icon })));

    if (marks.length > preview) {
      const btn = wrap.createDiv({ cls: 'hp-more' });
      const all = `All ${label.toLowerCase()} (${marks.length})`;
      const lbl = btn.createSpan({ text: all });
      setIcon(btn.createSpan({ cls: 'hp-more-c' }), 'chevron-down');

      const list = wrap.createDiv({ cls: 'hp-list' });
      marks.forEach(m => list.appendChild(this.row(m)));

      btn.onclick = () => {
        const open = wrap.hasClass('is-open');
        wrap.toggleClass('is-open', !open);
        lbl.setText(open ? all : 'Show less');
      };
    }
  }

  /* ── a class section: collapsible, contents built on first open ── */

  buildSection(def, items) {
    const wrap = this.root.createDiv({ cls: 'hp-sec' });
    wrap.style.setProperty('--hp-rgb', def.rgb || '128,128,128');
    this.sectionEls.set(def.id, wrap);

    const head = wrap.createDiv({ cls: 'hp-sec-h is-toggle' });
    setIcon(head.createSpan({ cls: 'hp-sec-i' }), def.icon || 'folder');
    head.createSpan({ cls: 'hp-sec-t', text: def.label || 'Untitled' });
    head.createSpan({ cls: 'hp-sec-n', text: String(items.length) });
    setIcon(head.createSpan({ cls: 'hp-sec-c' }), 'chevron-down');

    const body = wrap.createDiv({ cls: 'hp-sec-b' });

    /* Contents are not built until the section is first opened. A closed
       section costs one header row, so all six together cost almost
       nothing at boot. */
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      const grid = body.createDiv({ cls: 'hp-grid' });
      items.forEach(it => grid.appendChild(this.card(it, def)));
      grid.appendChild(this.addTile(def));
    };

    const open = !!(this.plugin.settings.open || {})[def.id];
    if (open) { wrap.addClass('is-open'); fill(); }

    head.onclick = () => {
      const now = !wrap.hasClass('is-open');
      wrap.toggleClass('is-open', now);
      if (now) fill();
      this.plugin.settings.open = this.plugin.settings.open || {};
      this.plugin.settings.open[def.id] = now;
      this.plugin.saveSettings();
    };
  }

  /* ── pieces ────────────────────────────────────────────────────── */

  card(item, def) {
    const el = createDiv({ cls: 'hp-card' });
    el.style.setProperty('--hp-hue', String(hueOf(item.path)));

    const media = el.createDiv({ cls: 'hp-card-m' });
    if (isRemote(item.banner)) media.dataset.banner = item.banner;

    const src = this.resolveBanner(item.banner);
    if (src) {
      const img = media.createEl('img', { attr: { loading: 'lazy', alt: '' } });
      img.src = src;
      media.addClass('is-loaded');
    }

    const ico = el.createDiv({ cls: 'hp-card-i' });
    const em = (item.icon || '').trim();
    if (em && !/^[\w./-]+\.(png|jpe?g|svg|webp|gif)$/i.test(em) && em.length <= 8) ico.setText(em);
    else setIcon(ico, 'file-text');
    el.createDiv({ cls: 'hp-card-t', text: item.title });
    el.createDiv({ cls: 'hp-card-s', text: (def && def.label) || '' });
    if (def && def.icon) setIcon(el.createDiv({ cls: 'hp-card-l' }), def.icon);
    el.onclick = () => this.app.workspace.openLinkText(item.path, '', false);
    return el;
  }

  /* The last tile of every section: makes a new note that belongs to it. */
  addTile(def) {
    const el = createDiv({ cls: 'hp-card hp-card-add' });
    setIcon(el.createDiv({ cls: 'hp-card-add-i' }), 'plus');
    el.createDiv({ cls: 'hp-card-add-t', text: 'New' });
    el.onclick = () => new NewTileModal(this.app, def, async (name) => {
      const clean = name.replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      const dir = this.app.vault.getAbstractFileByPath('Inbox') ? 'Inbox/' : '';
      let path = normalizePath(`${dir}${clean}.md`), n = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${dir}${clean} ${n++}.md`);
      const cls = String(def.match || def.label || def.id).trim();
      const body = `---\ncssclasses: []\ntype: Widget\nClass: "[[${cls}]]"\nbanner_icon: 📥\n---\n\n`;
      const file = await this.app.vault.create(path, body);
      await this.app.workspace.getLeaf(false).openFile(file);
      this.queueReconcile();
    }).open();
    return el;
  }

  row(item) {
    const el = createDiv({ cls: 'hp-row' });
    el.style.setProperty('--hp-hue', String(hueOf(item.path)));

    const th = el.createDiv({ cls: 'hp-row-m' });
    if (isRemote(item.banner)) th.dataset.banner = item.banner;
    const src = this.resolveBanner(item.banner);
    if (src) {
      const img = th.createEl('img', { attr: { loading: 'lazy', alt: '' } });
      img.src = src;
      th.addClass('is-loaded');
    }

    const t = el.createDiv({ cls: 'hp-row-t' });
    t.createDiv({ cls: 'hp-row-n', text: item.title });
    t.createDiv({ cls: 'hp-row-p', text: item.folder || '' });

    el.onclick = () => this.app.workspace.openLinkText(item.path, '', false);
    return el;
  }
}

/* Colour per kind of tab, so the list reads at a glance. */
const TAB_RGB = {
  markdown: '168,128,255', 'rabby-homepage-view': '255,176,32', graph: '81,220,120',
  localgraph: '81,220,120', canvas: '56,189,248', pdf: '255,99,120', image: '255,134,215',
  'rabby-task-manager-view': '53,196,139', bases: '255,150,60', search: '56,189,248',
};

/* ── open tabs: every open tab in one list ─────────────────────────── */

class OpenTabsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType()    { return TABS_VIEW; }
  getDisplayText() { return 'Open tabs'; }
  getIcon()        { return 'app-window'; }

  async onOpen() {
    this.contentEl.addClass('rb-tabs');
    const ws = this.app.workspace;
    let t = null;
    const queue = () => { clearTimeout(t); t = setTimeout(() => this.render(), 120); };
    this.register(() => clearTimeout(t));
    this.registerEvent(ws.on('layout-change', queue));
    this.registerEvent(ws.on('active-leaf-change', queue));
    this.registerEvent(ws.on('file-open', queue));
    this.registerEvent(this.app.vault.on('rename', queue));
    this.render();
  }

  async onClose() { this.contentEl.empty(); }

  render() {
    const ws = this.app.workspace;
    const active = ws.getMostRecentLeaf ? ws.getMostRecentLeaf() : null;

    /* main-area tabs only, grouped by the tab group they sit in */
    const groups = new Map();
    ws.iterateRootLeaves(leaf => {
      const g = leaf.parent;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(leaf);
    });
    const total = [...groups.values()].reduce((n, l) => n + l.length, 0);

    const el = this.contentEl;
    el.empty();
    const h = el.createDiv({ cls: 'rb-tabs-h' });
    h.createSpan({ text: 'Open tabs' });
    h.createSpan({ cls: 'rb-tabs-count', text: String(total) });

    if (!total) { el.createDiv({ cls: 'rb-tabs-empty', text: 'No tabs open' }); return; }

    /* one cloud of pills — every tab together, each with its own colour */
    const cloud = el.createDiv({ cls: 'rb-tabs-cloud' });
    for (const leaves of groups.values()) {
      for (const leaf of leaves) {
        const view = leaf.view;
        const file = view && view.file;
        const name = leaf.getDisplayText() || 'New tab';
        const pill = cloud.createDiv({ cls: 'rb-tabs-pill' + (leaf === active ? ' is-active' : '') });
        pill.style.setProperty('--tab-h', String(hueOf((file && file.path) || name)));
        pill.setAttr('title', (file && file.path) || name);

        setIcon(pill.createSpan({ cls: 'rb-tabs-i' }), (view && view.getIcon && view.getIcon()) || 'file');
        pill.createSpan({ cls: 'rb-tabs-n', text: name });
        if (leaf.pinned) setIcon(pill.createSpan({ cls: 'rb-tabs-pin' }), 'pin');

        const x = pill.createSpan({ cls: 'rb-tabs-x', attr: { 'aria-label': 'Close tab' } });
        setIcon(x, 'x');
        x.onclick = e => { e.stopPropagation(); leaf.detach(); };

        pill.onclick = () => {
          if (typeof ws.revealLeaf === 'function') ws.revealLeaf(leaf);
          ws.setActiveLeaf(leaf, { focus: true });
        };
        pill.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); leaf.detach(); } });
      }
    }
  }
}

class NewTileModal extends Modal {
  constructor(app, def, onSubmit) { super(app); this.def = def; this.onSubmit = onSubmit; }
  onOpen() {
    this.modalEl.addClass('rb-kb');
    this.titleEl.setText(`New in ${this.def.label || this.def.id}`);
    const input = this.contentEl.createEl('input', { type: 'text', placeholder: 'Title' });
    input.style.width = '100%';
    const go = () => { const v = input.value; this.close(); this.onSubmit(v); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const row = this.contentEl.createDiv();
    row.style.cssText = 'display:flex;justify-content:flex-end;margin-top:12px';
    row.createEl('button', { text: 'Create', cls: 'mod-cta' }).onclick = go;
    setTimeout(() => input.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* ── plugin ─────────────────────────────────────────────────────────── */


const DEFAULTS = {
  snapshot: null,
  open: {},
  /* null until migrate() seeds it from defaultSections() */
  sections: null,
  hideBookmarks: false,
  /* an "Open tabs" panel in the left sidebar, next to Search and Tags */
  /* 'replace' takes over the frontmost tab, 'newtab' opens alongside,
     'off' leaves Obsidian's own session restore alone. Default is off:
     reopening where you left off is the behaviour Obsidian ships, and
     forcing the homepage over it was taking away a choice rather than
     adding one. The Home button is always a tap away. */
  bootMode: 'off',
  /* 0 = no cap. Mobile accumulates tabs with no way to close them. */
  showOpenTabs: true,
  bootMigrated: false,
  /* The floating orange home circle. Off: the bar is icon-only and
     centred, and the homepage is reached from the command palette or
     the ribbon. */
  homeButton: false,
  /* mobile: put Obsidian's own File properties panel in the left sidebar */
  propsLeft: false,
  quote: {
    enabled: true,
    text: 'Tell me and I forget, teach me and I may remember, involve me and I learn.',
    by: 'Benjamin Franklin',
  },
};

module.exports = class HomepagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    await this.loadSnapshot();
    this.migrate();

    /* Marks the app as ours on mobile: hides the note header so the
       floating buttons own the corners, and lifts the mode button clear
       of the native bar. Set in onload so it lands as early as we can. */
    if (Platform.isMobile) document.body.addClass('rb-hp');

    this.registerView(VIEW_TYPE, leaf => new HomepageView(leaf, this));
    this.registerView(TABS_VIEW, leaf => new OpenTabsView(leaf, this));
    /* No ribbon icon. On mobile Obsidian surfaces ribbon actions in the
       navbar, and this one showed up there as a house next to the menu
       button. The view is reachable from the command palette, and the
       floating home button is a setting if you want a tap target. */

    /* `icon` matters on mobile — it is what the command shows as in the
       bottom toolbar. Without it you get a generic glyph. */
    this.addCommand({
      id: 'open',
      name: 'Home',
      icon: 'home',
      callback: () => this.activate(),
    });

    this.bootToHomepage();

    this.settingTab = new HomepageSettings(this.app, this);
    this.addSettingTab(this.settingTab);

    /* bookmark button in each note's own header, and the dock */
    this.app.workspace.onLayoutReady(() => {
      this.syncTabsView();
      this.placePropsLeft();
      this.mountDock();
      this.mountHome();
      this.decorateActiveView();
      this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.decorateActiveView()));
      this.registerEvent(this.app.workspace.on('css-change', () => this.refreshViews()));
      this.registerEvent(this.app.workspace.on('file-open', (file) => {
        this.applyDefaultMode(file);
        this.decorateActiveView();
      }));
      this.registerEvent(this.app.workspace.on('layout-change', () => {
        this.decorateActiveView();
        this.alignHome();
      }));
    });

    this.addCommand({
      id: 'close-other-tabs',
      name: 'Close other tabs',
      icon: 'x-square',
      callback: () => this.closeOtherTabs(),
    });

    this.addCommand({
      id: 'toggle-bookmark',
      name: 'Bookmark this note',
      icon: 'bookmark',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (!checking) {
          const btn = view.containerEl.querySelector('.rb-bm-btn');
          this.toggleBookmark(view.file, btn || document.createElement('div'));
        }
        return true;
      },
    });

    this.addCommand({
      id: 'recache-banners',
      name: 'Re-cache all banners',
      icon: 'image-down',
      callback: async () => {
        const view = await this.activate();
        if (!view) return;
        new Notice('Caching banners…');
        await view.cacheBannersInBackground(view.scan());
        new Notice('Banners cached');
      },
    });
  }

  /* ── bookmark button in the note header ────────────────────────────
     Obsidian's mobile toolbar is a shared dock — putting a per-note
     action there means it appears and disappears as you move between a
     note and the homepage, which is exactly the churn we are avoiding.
     This puts it in the note's own header instead, top right, where it
     belongs to the note rather than to the app.

     addAction() is the sanctioned API for that slot. On mobile Obsidian
     hides .view-actions by default; styles.css puts it back. */

  bookmarksInstance() {
    const bm = this.app.internalPlugins.getPluginById('bookmarks');
    return bm && bm.enabled ? bm.instance : null;
  }

  findBookmark(path) {
    const inst = this.bookmarksInstance();
    if (!inst) return null;
    const tops = (typeof inst.getBookmarks === 'function' ? inst.getBookmarks() : inst.items) || [];
    const walk = (items) => {
      for (const i of items || []) {
        if (i.type === 'group') { const r = walk(i.items); if (r) return r; }
        else if (i.type === 'file' && i.path === path && !i.subpath) return i;
      }
      return null;
    };
    return walk(tops);
  }

  paintBookmarkBtn(btn, file) {
    const on = !!this.findBookmark(file.path);
    btn.empty();
    setIcon(btn, on ? 'bookmark-check' : 'bookmark');
    btn.toggleClass('is-bookmarked', on);
    /* Deliberately not the string "Bookmark" — styles.css hides other
       buttons carrying that label, and this one must not match. */
    btn.setAttribute('aria-label', on ? 'Remove from bookmarks' : 'Add to bookmarks');
  }

  toggleBookmark(file, btn) {
    const inst = this.bookmarksInstance();
    if (!inst) { new Notice('Bookmarks core plugin is off'); return; }

    const existing = this.findBookmark(file.path);
    try {
      if (existing && typeof inst.removeItem === 'function') {
        inst.removeItem(existing);
      } else if (!existing && typeof inst.addItem === 'function') {
        inst.addItem({ type: 'file', path: file.path, ctime: Date.now() });
      } else {
        /* Fall back to the built-in command if the instance API is not
           what this Obsidian version exposes. */
        this.app.commands.executeCommandById('bookmarks:bookmark-current-view');
      }
    } catch (e) {
      console.error('[homepage] bookmark toggle failed', e);
      this.app.commands.executeCommandById('bookmarks:bookmark-current-view');
    }

    setTimeout(() => this.paintBookmarkBtn(btn, file), 60);

    /* keep the homepage in step */
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.view?.queueReconcile?.();
    }
  }

  /* ── floating controls over the note ──────────────────────────────
     These used to be view actions in the header row. They are now an
     absolutely-positioned layer inside .view-content instead, because
     the header row can only ever be one cluster in one corner — and the
     ask was back top-left, forward top-right, bookmark on the banner.

     The layer itself is pointer-events: none, so only the buttons take
     taps and the note scrolls normally underneath them. */

  decorateActiveView() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;

    let ovl = view.contentEl.querySelector(':scope > .rb-ovl');
    if (!ovl) {
      ovl = view.contentEl.createDiv({ cls: 'rb-ovl' });

      const back = ovl.createDiv({ cls: 'rb-fab rb-back' });
      setIcon(back, 'arrow-left');
      back.setAttribute('aria-label', 'Back');
      back.onclick = () => this.app.commands.executeCommandById('app:go-back');

      const fwd = ovl.createDiv({ cls: 'rb-fab rb-fwd' });
      setIcon(fwd, 'arrow-right');
      fwd.setAttribute('aria-label', 'Forward');
      fwd.onclick = () => this.app.commands.executeCommandById('app:go-forward');

      const bm = ovl.createDiv({ cls: 'rb-fab rb-bm-btn' });
      bm.onclick = () => this.toggleBookmark(view.file, bm);

      /* edit / reading toggle — bottom right, clear of the dock */
      const mode = ovl.createDiv({ cls: 'rb-fab rb-mode' });
      mode.onclick = () => {
        this.app.commands.executeCommandById('markdown:toggle-preview');
        setTimeout(() => this.paintMode(view, mode), 80);
      };
    }

    /* desktop home button — bottom left of the note, on the edit button's
       baseline. Lives in the overlay so it follows the pane, whatever the
       sidebars are doing. Mobile keeps its own body-level button. */
    const wantHome = !Platform.isMobile && !!this.settings.homeButton;
    let hd = ovl.querySelector('.rb-home-d');
    if (wantHome && !hd) {
      hd = ovl.createDiv({ cls: 'rb-fab rb-home-d' });
      setIcon(hd, 'home');
      hd.setAttribute('aria-label', 'Home');
      hd.onclick = () => this.activate();
    } else if (!wantHome && hd) {
      hd.remove();
    }

    const bm = ovl.querySelector('.rb-bm-btn');
    this.paintBookmarkBtn(bm, view.file);
    this.placeBookmark(view, bm);
    this.paintMode(view, ovl.querySelector('.rb-mode'));
  }

  /* ── default view for every note ──────────────────────────────────
     Obsidian's "Default view for new tabs" (Settings → Editor) only
     applies to *new* tabs. On mobile one tab is reused for everything,
     so after you edit one note every note opens in editing. This applies
     that same Obsidian setting on every file open — no plugin setting.

     Only acts when the setting is Reading view. Tap the pencil and the
     note stays editable until you open another one; a brand-new empty
     note is left in editing, since you made it to write in it. */

  applyDefaultMode(file) {
    if (this.app.vault.getConfig?.('defaultViewMode') !== 'preview') return;
    if (file && file.stat && file.stat.size === 0) return;   // new, empty note

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode?.() !== 'source') return;

    const state = view.getState();
    if (state.mode === 'preview') return;
    state.mode = 'preview';
    view.setState(state, { history: false });
  }

  /** Shows the mode you'd switch *to*, not the one you're in — a button
   *  labelled with its own destination. */
  paintMode(view, el) {
    if (!el) return;
    const reading = view.getMode?.() === 'preview';
    el.empty();
    setIcon(el, reading ? 'pencil' : 'book-open');
    el.setAttribute('aria-label', reading ? 'Edit' : 'Reading view');
  }

  /** Sit the bookmark on the banner if there is one, otherwise at the
   *  top of the note beside the nav buttons.
   *
   *  The banner's height is measured rather than read from
   *  --banner-height: that variable is set by the banners plugin and
   *  isn't reliably in scope here, and Theme.css additionally grows the
   *  banner by the status-bar strip. offsetHeight is the truth. */
  placeBookmark(view, bm) {
    if (!bm) return;
    const banner = view.contentEl.querySelector('.obsidian-banner');

    if (banner && banner.offsetHeight > 80) {
      bm.addClass('is-on-banner');
      bm.style.top = `${Math.round(banner.offsetHeight) - 52}px`;
    } else {
      bm.removeClass('is-on-banner');
      bm.style.top = '';
    }

    /* A banner image that hasn't decoded yet reports the wrong height,
       so measure again once it has. Cheap, and only while the banner
       element is new to us. */
    if (banner && !banner.dataset.rbWatched) {
      banner.dataset.rbWatched = '1';
      const again = () => this.placeBookmark(view, bm);
      banner.querySelectorAll('img').forEach(img => {
        if (!img.complete) img.addEventListener('load', again, { once: true });
      });
      setTimeout(again, 120);
      setTimeout(again, 500);
    }
  }

  /* ── the home button ───────────────────────────────────────────────
     Its own element, floating bottom-right, rather than an item inside
     the navbar. Obsidian's navbar pairs the tab switcher and home into
     one cluster, so styling home as a raised circle there dropped it on
     top of the hamburger. Out here it owns its space and keeps the
     orange treatment. */

  mountHome() {
    this.unmountHome();
    /* desktop gets its home button from decorateActiveView(), inside the
       note's own overlay, so it shares a baseline with the edit button */
    if (!Platform.isMobile || !this.settings.homeButton) return;

    const b = document.body.createDiv({ cls: 'rb-home' });
    setIcon(b, 'home');
    b.setAttribute('aria-label', 'Home');
    b.onclick = () => this.activate();
    this.homeEl = b;

    this.alignHome();
    /* the bar's position depends on safe-area insets and whether
       Obsidian's floating navbar setting is on, so measure rather than
       assume — and re-measure once layout has settled */
    setTimeout(() => this.alignHome(), 120);
    setTimeout(() => this.alignHome(), 600);
    this.registerDomEvent(window, 'resize', () => this.alignHome());

    /* layout-change doesn't reliably fire when a drawer slides open, so
       watch the workspace element's attributes as well. */
    const root = document.querySelector('.app-container') || document.body;
    this._obs = new MutationObserver(() => { this.alignHome(); this.followDock(); });
    this._obs.observe(root, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });

    /* Obsidian slides the navbar down while you scroll. Follow it, so
       the button stays seated in the notch instead of floating alone. */
    const kick = () => this.followDock();
    this.registerDomEvent(document, 'scroll', kick, { capture: true, passive: true });
    this.registerDomEvent(document, 'touchmove', kick, { passive: true });
    this.registerDomEvent(document, 'touchend', kick, { passive: true });
  }

  /** Keep the home button's centre on the navbar's top edge, frame by
   *  frame, for ~500ms after anything that might move the bar. Uses the
   *  `translate` property, not `transform`, so it never fights the
   *  entrance animation or the press scale. */
  followDock() {
    this._followUntil = performance.now() + 900;
    if (this._followRaf) return;
    const step = () => {
      this._followRaf = 0;
      const b = this.homeEl;
      const bar = document.querySelector('.mobile-navbar');
      if (!b || !bar) return;
      const r = bar.getBoundingClientRect();
      const cs = getComputedStyle(bar);
      /* Obsidian may hide the bar outright (display/opacity/visibility)
         instead of sliding it — then there is no edge to follow, so the
         button drops out of sight with it. */
      const gone = !r.height || cs.display === 'none' || cs.visibility === 'hidden' ||
        parseFloat(cs.opacity) < 0.1 || r.top >= window.innerHeight - 2;
      b.toggleClass('rb-dock-gone', gone);
      if (gone) {
        /* stay put; CSS shrinks it away (.rb-dock-gone) */
      } else {
        const h = b.offsetHeight || 64;
        const bottom = parseFloat(getComputedStyle(b).bottom) || 0;
        const restTop = window.innerHeight - bottom - h;
        const dy = Math.round((r.top - h / 2) - restTop);
        const v = Math.abs(dy) < 1 ? '' : `0px ${dy}px`;
        if (b.style.translate !== v) b.style.translate = v;
      }
      if (performance.now() < this._followUntil) this._followRaf = requestAnimationFrame(step);
    };
    this._followRaf = requestAnimationFrame(step);
  }

  unmountHome() {
    this._obs?.disconnect();
    this._obs = null;
    // don't leave the navbar hidden if the plugin goes away mid-drawer
    document.body.removeClass('rb-drawer-open');
    this.homeEl?.remove();
    this.homeEl = null;
  }

  /** Line the home button up with the navbar's vertical centre.
   *
   *  Earlier versions hardcoded `bottom` and hoped it matched. It never
   *  quite did: the button is a different height from the bar, and the
   *  bar's own offset varies with the safe-area inset. Measuring both
   *  and solving for the offset is exact and survives any of that
   *  changing. */

  alignHome() {
    /* Hide while a sidebar drawer is open — these are fixed to the
       viewport, so they otherwise float on top of the file explorer and
       clip the vault name at the bottom of it.
       leftSplit/rightSplit.collapsed is Obsidian's own state rather than
       a class name I'd be guessing at.

       The body class is set before the homeEl guard below, because
       Theme.css hides the navbar off it and that has to keep working
       whether or not the floating home button is switched on. */
    const ws = this.app.workspace;
    const drawerOpen = Platform.isMobile && (
      (ws.leftSplit && ws.leftSplit.collapsed === false) ||
      (ws.rightSplit && ws.rightSplit.collapsed === false));
    document.body.toggleClass('rb-drawer-open', !!drawerOpen);

    const b = this.homeEl;
    if (!b) return;
    b.toggleClass('is-hidden', !!drawerOpen);

    const bar = document.querySelector('.mobile-navbar');
    if (!bar) return;

    const r = bar.getBoundingClientRect();
    if (!r.height) return;

    const h = b.offsetHeight || 64;
    const centreFromBottom = window.innerHeight - (r.top + r.height / 2);
    b.style.bottom = `${Math.round(centreFromBottom - h / 2)}px`;
  }

  /* ── the dock ──────────────────────────────────────────────────────
     Obsidian's mobile navbar is a fixed set you can only toggle items
     within. This replaces it outright: a bar we own, whose items are
     any command in the palette, in whatever order, with one raised
     primary item in the middle.

     Mobile only — on desktop the navbar doesn't exist and the ribbon
     already does this job. Turning the setting off restores Obsidian's
     own bar immediately, so a broken dock is never a trap. */

  closeOtherTabs() {
    const ws = this.app.workspace;
    const active = ws.getMostRecentLeaf(ws.rootSplit);
    const leaves = [];
    ws.iterateRootLeaves(l => leaves.push(l));
    let n = 0;
    for (const l of leaves) if (l !== active) { l.detach(); n++; }
    new Notice(n ? `Closed ${n} tab${n > 1 ? 's' : ''}` : 'No other tabs');
  }

  /* ── boot ──────────────────────────────────────────────────────────
     Obsidian restores last session's tabs, so without this you watch
     yesterday's note paint and then get replaced. The veil goes up in
     onload — before the workspace is ready — and comes down once the
     homepage is mounted, so the first thing you see is the homepage,
     already complete.

     The veil is hard-capped on a timer. If anything here throws, or the
     workspace never becomes ready, you get your vault back rather than
     a blank screen. That matters more than the effect. */

  bootToHomepage() {
    /* The "On launch" option was removed (v3.10): the homepage never
       takes over on start-up; Obsidian restores your last session. */
    const mode = 'off';

    if (mode === 'off') return;

    this.app.workspace.onLayoutReady(async () => {
      try {
        const ws = this.app.workspace;
        let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];

        if (!leaf) {
          if (mode === 'replace') {
            /* take over whatever tab is frontmost — on mobile there is
               only one, which is the case this is really for */
            leaf = ws.getMostRecentLeaf(ws.rootSplit) || ws.getLeaf(true);
          } else {
            leaf = ws.getLeavesOfType('empty')[0] || ws.getLeaf(true);
          }
          await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }

        ws.revealLeaf(leaf);
      } catch (e) {
        console.error('[homepage] boot failed', e);
      }
    });
  }

  /** A saved dock from before overflow existed has no way to reach
   *  Settings — and no way to reach the settings tab that would fix it.
   *  So this runs on load, not on demand. */
  migrate() {
    /* sections became user-editable; seed them from the old fixed list so
       nobody loses what they had. Open/closed state is keyed by id, and
       the built-in ids are unchanged, so that carries over too. */
    if (!Array.isArray(this.settings.sections) || !this.settings.sections.length) {
      this.settings.sections = defaultSections();
      this.persist();
    }

    /* openOnStart was a boolean before boot modes existed */
    if (this.settings.bootMode === undefined) {
      this.settings.bootMode = 'off';
    }
    delete this.settings.openOnStart;
    /* bookmarks block: number of cards shown (v3.10) */
    this.settings.bookmarks = Object.assign(
      { preview: 4 }, this.settings.bookmarks || {});
    /* bookmarks have a fixed title, icon and the accent colour */
    delete this.settings.bookmarks.rgb;
    delete this.settings.bookmarks.label;
    delete this.settings.bookmarks.icon;
    /* quote: one quote the user writes, plus a show/hide switch (v3.10) */
    {
      const q = this.settings.quote || {};
      const first = Array.isArray(q.list) && q.list[0] ? q.list[0] : q;
      this.settings.quote = { enabled: q.enabled !== false, text: first.text || '', by: first.by || '' };
    }
    /* removed in v3.10 */
    delete this.settings.maxTabs;
    delete this.settings.alwaysReading;

    /* v2 shipped bootMode:'replace' as the default and overrode session
       restore for everyone. Hand that back once. */
    if (!this.settings.bootMigrated) {
      this.settings.bootMode = 'off';
      this.settings.bootMigrated = true;
      this.persist();
    }

    /* the custom dock ("Replace the mobile toolbar") was removed in v3.11 */
    delete this.settings.dock;
  }

  /* The custom dock was removed in v3.11; this only clears a leftover one. */
  mountDock() {
    this.unmountDock();
  }

  unmountDock() {
    this.dockEl?.remove();
    this.dockEl = null;
    document.body.removeClass('rb-dock-on');
  }

  /* ── bookmark helpers continue below ─────────────────────────────── */

  /** The live section list, tolerant of hand-edited data.json. */
  getSections() {
    return (this.settings.sections || []).filter(s => s && s.id);
  }

  /** Re-scan and repaint every open homepage after a settings change. */
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v && typeof v.reconcile === 'function') { v._last = null; v.reconcile(); }
    }
  }

  /* data.json holds only user settings (sections, dock, ...) so it changes
     rarely and syncs cleanly. The cache lives in snapshot.json, which can
     be excluded from sync: it is rebuilt on every open. */
  persist() {
    const { snapshot, ...rest } = this.settings;
    return this.saveData(rest);
  }

  _snapPath() { return `${this.manifest.dir}/snapshot.json`; }

  async loadSnapshot() {
    const ad = this.app.vault.adapter;
    try {
      if (await ad.exists(this._snapPath())) {
        this.settings.snapshot = JSON.parse(await ad.read(this._snapPath()));
        return;
      }
    } catch (_) { /* fall through to the legacy copy */ }
    /* legacy: the snapshot used to live inside data.json */
    if (this.settings.snapshot) this.saveSnapshot();
  }

  saveSnapshot() {
    clearTimeout(this._snq);
    this._snq = setTimeout(() => {
      try { this.app.vault.adapter.write(this._snapPath(), JSON.stringify(this.settings.snapshot || null)); } catch (_) {}
    }, 300);
  }

  /* Sync replaced data.json under us: pick up the new sections instead of
     keeping the stale in-memory copy and overwriting the file on next save. */
  async onExternalSettingsChange() {
    const snap = this.settings.snapshot;
    this.settings = Object.assign({}, DEFAULTS, await this.loadData(), { snapshot: snap });
    this.migrate();
    this.refreshViews();
    this.mountDock();
    try { if (this.app.setting && this.app.setting.activeTab === this.settingTab) this.settingTab.display(); } catch (_) {}
  }

  async saveSettings() {
    clearTimeout(this._sq);
    this._sq = setTimeout(() => this.persist(), 300);
  }

  onunload() {
    document.body.removeClass('rb-hp');
    this.unmountHome();
    this.unmountDock();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(TABS_VIEW);
  }

  /* Puts the Open tabs panel in the left sidebar, in the same tab group as
     Search and Tags, or removes it — whichever the setting says. */
  async syncTabsView() {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(TABS_VIEW);
    /* desktop and tablets only: on a phone the panel is never shown */
    if (!this.settings.showOpenTabs || Platform.isPhone) { existing.forEach(l => l.detach()); return; }
    if (existing.length) return;

    let leaf = null;
    const search = ws.getLeavesOfType('search').find(l => l.getRoot() === ws.leftSplit);
    if (search && search.parent && typeof ws.createLeafInParent === 'function') {
      leaf = ws.createLeafInParent(search.parent, search.parent.children.length);
    }
    if (!leaf) leaf = ws.getLeftLeaf(false);
    if (leaf) await leaf.setViewState({ type: TABS_VIEW, active: false });
  }

  /* ── File properties in the left sidebar (mobile) ────────────────
     On a phone Obsidian can't move a panel between sidebars, and the
     File properties panel opens on the right. With the setting on, this
     puts it in the left sidebar, once per device: if you move or close it
     afterwards, it is left alone. The "done" mark lives in this device's
     local storage, so every phone and tablet gets it once. */
  async placePropsLeft(force = false) {
    if (!Platform.isMobile || !this.settings.propsLeft) return;
    if (!this.app.internalPlugins?.getPluginById?.('properties')?.enabled) return;
    const KEY = 'rabby-homepage-props-left';
    if (!force && this.app.loadLocalStorage?.(KEY)) return;
    const ws = this.app.workspace;
    if (!ws.getLeavesOfType('file-properties').some(l => l.getRoot() === ws.leftSplit)) {
      let leaf = null;
      const fe = ws.getLeavesOfType('file-explorer').find(l => l.getRoot() === ws.leftSplit);
      if (fe && fe.parent && typeof ws.createLeafInParent === 'function') {
        leaf = ws.createLeafInParent(fe.parent, fe.parent.children.length);
      }
      if (!leaf) leaf = ws.getLeftLeaf(false);
      if (leaf) await leaf.setViewState({ type: 'file-properties', active: false });
      ws.requestSaveLayout?.();
    }
    this.app.saveLocalStorage?.(KEY, '1');
  }

  async activate() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }
};

/* ── settings ───────────────────────────────────────────────────────── */

class HomepageSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  save() {
    this.plugin.persist();
    this.plugin.mountDock();
  }

  /* ── settings UI: grouped-card layout ─────────────────────────────
     Rounded cards with slim rows (icon · title · subtitle · control ·
     chevron), small uppercase titles above and a muted note below.
     Editing a row happens in a sheet, so nothing has to squeeze onto
     one line on a phone. */

  group(parent, title, note) {
    if (title) parent.createDiv({ cls: 'rb-group-title', text: title });
    const g = parent.createDiv({ cls: 'rb-group' });
    if (note) parent.createDiv({ cls: 'rb-group-note', text: note });
    return g;
  }

  listRow(g, o) {
    const r = g.createDiv({ cls: 'rb-row' + (o.onClick ? ' is-clickable' : '') + (o.dim ? ' is-dim' : '') });
    const ic = r.createDiv({ cls: 'rb-row-ic' });
    if (o.rgb) ic.style.setProperty('--rb-rgb', o.rgb);
    setIcon(ic, o.icon || 'circle');
    const t = r.createDiv({ cls: 'rb-row-t' });
    t.createDiv({ cls: 'rb-row-n', text: o.title || '' });
    if (o.sub) t.createDiv({ cls: 'rb-row-s', text: o.sub });
    const right = r.createDiv({ cls: 'rb-row-r' });
    if (o.onClick) {
      r.addEventListener('click', e => { if (!e.target.closest('.rb-row-ctl')) o.onClick(); });
    }
    return { r, right };
  }

  chevron(right) {
    const c = right.createSpan({ cls: 'rb-row-chev' });
    setIcon(c, 'chevron-right');
  }

  toggle(right, value, onChange) {
    const w = right.createDiv({ cls: 'rb-row-ctl' });
    new ToggleComponent(w).setValue(value).onChange(onChange);
  }

  addRow(g, label, onClick) {
    const a = g.createDiv({ cls: 'rb-row rb-row-add is-clickable' });
    setIcon(a.createDiv({ cls: 'rb-row-ic rb-row-ic-plain' }), 'plus');
    a.createDiv({ cls: 'rb-row-t' }).createDiv({ cls: 'rb-row-n', text: label });
    a.addEventListener('click', onClick);
  }

  /* two-step link button: first tap arms, second confirms */
  armedLink(parent, key, idle, armed, onConfirm, redraw) {
    const on = this._arm === key;
    const b = parent.createDiv({ cls: 'rb-link-btn' + (on ? ' is-warn' : ''), text: on ? armed : idle });
    b.addEventListener('click', () => {
      if (this._arm === key) { this._arm = null; onConfirm(); return; }
      this._arm = key; redraw();
      setTimeout(() => { if (this._arm === key) { this._arm = null; redraw(); } }, 3500);
    });
  }

  /* ── sections ─────────────────────────────────────────────────── */

  renderSections(host) {
    host.empty();
    const P = this.plugin;
    const secs = P.settings.sections;
    const commit = () => { P.persist(); P.refreshViews(); };
    const redraw = () => this.renderSections(host);
    const edit = s => new SectionModal(this.app, P, s, () => { commit(); redraw(); }).open();

    const g = host.createDiv({ cls: 'rb-group' });

    secs.forEach(s => {
      const { right } = this.listRow(g, {
        icon: s.icon || 'folder', rgb: s.rgb, title: s.label || 'Untitled',
        sub: s.hidden ? 'Hidden from the homepage' : `Class: ${s.match || '—'}`,
        dim: s.hidden, onClick: () => edit(s),
      });
      this.toggle(right, !s.hidden, v => { s.hidden = !v; commit(); redraw(); });
      this.chevron(right);
    });

    this.addRow(g, 'Add section', () => {
      const s = {
        id: 's' + Date.now().toString(36), label: 'New section', icon: 'folder',
        rgb: PALETTE[secs.length % PALETTE.length], match: 'New section',
        hidden: false, linked: true,
      };
      secs.push(s); commit(); redraw(); edit(s);
    });

    this.armedLink(host, 'reset', 'Reset sections to defaults', 'Tap again to reset all sections',
      () => { P.settings.sections = defaultSections(); commit(); redraw(); }, redraw);
  }

  display() {
    const { containerEl: c } = this;
    c.empty();
    c.addClass('rb-hp-settings');
    const S = this.plugin.settings;

    /* General */
    const gen = this.group(c, 'General');

    if (!Platform.isPhone) new Setting(gen)
      .setName('Open tabs panel')
      .setDesc('An \u201cOpen tabs\u201d view in the left sidebar listing every open tab. Desktop and tablets only.')
      .addToggle(t => t
        .setValue(!!S.showOpenTabs)
        .onChange(async v => {
          S.showOpenTabs = v;
          this.plugin.persist();
          await this.plugin.syncTabsView();
        }));

    new Setting(gen)
      .setName('Floating home button')
      .setDesc('A round home button over every note.')
      .addToggle(t => t
        .setValue(S.homeButton)
        .onChange(v => {
          S.homeButton = v;
          this.save();
          this.plugin.mountHome();
          this.plugin.decorateActiveView();
        }));

    /* Bookmarks */
    const bmg = this.group(c, 'Bookmarks', 'Notes you bookmark in Obsidian, shown at the top of the homepage.');
    const B = S.bookmarks;
    const refresh = () => { this.plugin.persist(); this.plugin.refreshViews(); };
    new Setting(bmg)
      .setName('Show on homepage')
      .addToggle(t => t
        .setValue(!S.hideBookmarks)
        .onChange(v => { S.hideBookmarks = !v; refresh(); }));
    new Setting(bmg)
      .setName('Cards before \u201cAll bookmarks\u201d')
      .setDesc('The rest are in the list below the cards.')
      .addDropdown(d => {
        [2, 4, 6, 8].forEach(n => d.addOption(String(n), String(n)));
        d.setValue(String(B.preview || 4))
         .onChange(v => { B.preview = parseInt(v, 10) || 4; refresh(); });
      });

    /* Quote */
    const Q = S.quote;
    const qg = this.group(c, 'Quote', 'Shown under the overview on the homepage.');
    const qsave = () => { this.plugin.persist(); this.plugin.refreshViews(); };
    new Setting(qg)
      .setName('Show quote')
      .addToggle(t => t
        .setValue(Q.enabled !== false)
        .onChange(v => { Q.enabled = v; qsave(); this.display(); }));
    if (Q.enabled !== false) {
      const { right } = this.listRow(qg, {
        icon: 'quote', rgb: accentRgb(),
        title: Q.text || 'Write your quote', sub: Q.by ? `\u2014 ${Q.by}` : 'Tap to edit',
        dim: !Q.text,
        onClick: () => new QuoteModal(this.app, this.plugin, Q, () => { qsave(); this.display(); }).open(),
      });
      this.chevron(right);
    }

    /* Sections */
    c.createDiv({ cls: 'rb-group-title', text: 'Sections' });
    this.renderSections(c.createDiv({ cls: 'rb-sections' }));
    c.createDiv({
      cls: 'rb-group-note',
      text: 'A note appears in a section when its frontmatter has type: Widget and Class: [[<Class value>]]. Tap a section to edit it.',
    });

    /* Miscellaneous */
    const misc = this.group(c, 'Miscellaneous');
    new Setting(misc)
      .setName('File properties in the left sidebar')
      .setDesc('Mobile only. Puts Obsidian\u2019s File properties panel in the left sidebar, once on each phone or tablet. Needs the Properties view core plugin.')
      .addToggle(t => t
        .setValue(!!S.propsLeft)
        .onChange(async v => {
          S.propsLeft = v;
          this.plugin.persist();
          if (!v) return;
          if (!this.app.internalPlugins?.getPluginById?.('properties')?.enabled) {
            new Notice('Turn on Properties view in Settings \u2192 Core plugins first');
            return;
          }
          await this.plugin.placePropsLeft(true);
        }));
  }
}

/* ── edit sheets ──────────────────────────────────────────────────── */

class SectionModal extends Modal {
  constructor(app, plugin, s, done, opts = {}) {
    super(app);
    this.plugin = plugin; this.s = s; this.done = done; this.armed = false; this.opts = opts;
  }
  onOpen()  { this.modalEl.addClass('rb-sheet'); this.render(); }
  onClose() { clearTimeout(this._t); this.plugin.persist(); this.plugin.refreshViews(); this.contentEl.empty(); this.done(); }

  render() {
    if (!this.modalEl.isConnected) return;
    const { contentEl: c, s, plugin: P } = this;
    const secs = P.settings.sections;
    c.empty();
    this.titleEl.setText(this.opts.title || 'Edit section');

    const save = () => { P.persist(); P.refreshViews(); };
    const soon = () => { clearTimeout(this._t); this._t = setTimeout(save, 350); };
    const iconIds = typeof getIconIds === 'function'
      ? new Set(getIconIds().map(x => x.replace(/^lucide-/, ''))) : null;

    /* live preview */
    const pv = c.createDiv({ cls: 'rb-sheet-pv' });
    const pic = pv.createDiv({ cls: 'rb-row-ic rb-sheet-pv-ic' });
    const pname = pv.createDiv({ cls: 'rb-sheet-pv-n' });
    const paint = () => {
      pic.empty(); setIcon(pic, s.icon || 'folder');
      pic.style.setProperty('--rb-rgb', this.opts.accent ? accentRgb() : (s.rgb || '128,128,128'));
      pname.setText(s.label || 'Untitled');
    };
    paint();

    const g = c.createDiv({ cls: 'rb-group' });
    let matchText = null;
    new Setting(g).setName('Name').addText(t => t
      .setPlaceholder('Section name').setValue(s.label || '')
      .onChange(v => {
        s.label = v.trim();
        if (s.linked) { s.match = s.label; if (matchText) matchText.setValue(s.match); }
        paint(); soon();
      }));
    new Setting(g).setName('Icon').setDesc('Lucide name, e.g. briefcase').addText(t => t
      .setPlaceholder('folder').setValue(s.icon || '')
      .onChange(v => {
        v = v.trim(); s.icon = v;
        if (!iconIds || !v || iconIds.has(v)) { paint(); soon(); }
      }));
    if (!this.opts.simple) new Setting(g).setName('Class value').setDesc('Notes with Class: [[this]] show here').addText(t => {
      matchText = t;
      t.setPlaceholder('Class value').setValue(s.match || '')
       .onChange(v => { s.match = v.trim(); s.linked = false; soon(); });
    });

    if (this.opts.accent) return;   // bookmarks: colour follows the theme accent

    c.createDiv({ cls: 'rb-group-title', text: 'Colour' });
    const cg = c.createDiv({ cls: 'rb-group rb-swatches' });
    /* every coloured element that can be "the current colour" */
    const pickables = [];
    const mark = () => pickables.forEach(([el, rgb]) => el.toggleClass('is-on', rgb === s.rgb));
    const pick = rgb => { s.rgb = rgb; paint(); mark(); save(); };

    const choices = [...new Set([...SECTIONS.map(x => x.rgb), ...PALETTE].filter(Boolean))];
    choices.forEach(rgb => {
      const sw = cg.createDiv({ cls: 'rb-swatch' });
      sw.style.setProperty('--rb-rgb', rgb);
      sw.addEventListener('click', () => pick(rgb));
      pickables.push([sw, rgb]);
    });

    /* "more colours": opens a grid of hues x shades, in the sheet itself
       (no system colour dialog) */
    const more = cg.createDiv({ cls: 'rb-swatch rb-swatch-more' + (this.showGrid ? ' is-open' : ''), attr: { 'aria-label': 'More colours' } });
    const isCustom = !choices.includes(s.rgb);
    if (isCustom) { more.style.setProperty('--rb-rgb', s.rgb); more.addClass('has-custom'); }
    more.addEventListener('click', () => { this.showGrid = !this.showGrid; this.render(); });

    if (this.showGrid) {
      const hsl = (h, sat, l) => {
        sat /= 100; l /= 100;
        const k = n => (n + h / 30) % 12, a = sat * Math.min(l, 1 - l);
        const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return [f(0), f(8), f(4)].map(x => Math.round(x * 255)).join(',');
      };
      const grid = c.createDiv({ cls: 'rb-group rb-cgrid' });
      const rows = [];
      rows.push(Array.from({ length: 12 }, (_, i) => { const v = Math.round(255 - i * 255 / 11); return `${v},${v},${v}`; }));
      [88, 78, 68, 58, 48, 38, 28].forEach(l =>
        rows.push(Array.from({ length: 12 }, (_, i) => hsl(i * 30, 88, l))));
      rows.forEach(row => row.forEach(rgb => {
        const cell = grid.createDiv({ cls: 'rb-cgrid-cell' });
        cell.style.setProperty('--rb-rgb', rgb);
        cell.addEventListener('click', () => pick(rgb));
        pickables.push([cell, rgb]);
      }));
    }
    mark();

    if (this.opts.simple) return;

    const i = secs.indexOf(s);
    c.createDiv({ cls: 'rb-group-title', text: 'Order' });
    const og = c.createDiv({ cls: 'rb-group' });
    const mv = d => { const j = i + d; [secs[i], secs[j]] = [secs[j], secs[i]]; save(); this.render(); };
    new Setting(og).setName(`Position ${i + 1} of ${secs.length}`)
      .addExtraButton(b => b.setIcon('chevron-up').setTooltip('Move up').setDisabled(i <= 0).onClick(() => mv(-1)))
      .addExtraButton(b => b.setIcon('chevron-down').setTooltip('Move down').setDisabled(i >= secs.length - 1).onClick(() => mv(1)));

    const del = c.createEl('button', { cls: 'rb-danger-btn', text: this.armed ? 'Tap again to delete' : 'Delete section' });
    del.addEventListener('click', () => {
      if (!this.armed) {
        this.armed = true; this.render();
        setTimeout(() => { if (this.armed) { this.armed = false; this.render(); } }, 3500);
        return;
      }
      const k = secs.indexOf(s);
      if (k >= 0) secs.splice(k, 1);
      delete (P.settings.open || {})[s.id];
      this.armed = false;
      this.close();
    });
  }
}

class QuoteModal extends Modal {
  constructor(app, plugin, q, done) {
    super(app);
    this.plugin = plugin; this.q = q; this.done = done;
  }
  onOpen()  { this.modalEl.addClass('rb-sheet'); this.render(); }
  onClose() { this.plugin.persist(); this.plugin.refreshViews(); this.contentEl.empty(); this.done(); }

  render() {
    const { contentEl: c, q } = this;
    c.empty();
    this.titleEl.setText('Your quote');

    const pv = c.createDiv({ cls: 'rb-quote-pv' });
    const pt = pv.createDiv({ cls: 'rb-quote-pv-t' });
    const pb = pv.createDiv({ cls: 'rb-quote-pv-b' });
    const paint = () => { pt.setText(q.text || 'Your quote'); pb.setText(q.by ? `\u2014 ${q.by}` : ''); pv.toggleClass('is-empty', !q.text); };
    paint();

    const g = c.createDiv({ cls: 'rb-group' });
    new Setting(g).setClass('rb-quote-text').setName('Quote').addTextArea(t => {
      t.setPlaceholder('Type a quote you like').setValue(q.text || '')
       .onChange(v => { q.text = v.trim(); paint(); });
      t.inputEl.rows = 4;
    });
    new Setting(g).setName('Author').setDesc('Optional').addText(t => t
      .setPlaceholder('Who said it').setValue(q.by || '')
      .onChange(v => { q.by = v.trim(); paint(); }));
  }
}
