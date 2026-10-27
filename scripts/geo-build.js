#!/usr/bin/env node
/**
 * GEO build — regenerates AI/SEO-discoverable artifacts from the source JSON.
 *
 * Inputs (repo root):
 *   - glossary-data.json   (array of { slug, title, category, sections:[{title,text}] })
 *   - data.json            (array of stories { story_id, title, category, story_text, takeaway, why_now, sent_at })
 *
 * Outputs (repo root):
 *   - szotar/<slug>.html              (ONE INDEXABLE PAGE PER TERM — the SEO engine)
 *   - szotar/kategoria-<slug>.html    (CATEGORY HUBS — concentrate internal link weight)
 *   - glossary.html                   (JSON-LD DefinedTermSet + static category links refreshed in place)
 *   - stories.html                    (JSON-LD Blog block refreshed in place)
 *   - llms-full.txt                   (full machine-readable content)
 *   - sitemap-1.xml                   (static pages + category hubs + every term page)
 *
 * llms.txt is intentionally NOT touched (it is hand-written, content-agnostic).
 *
 * Idempotent: safe to run on every push.
 */
const fs = require('fs');
const path = require('path');

const SITE = 'https://piacradar.eu';
const TG = 'https://t.me/+Mk5bfbCfUf1lMGE0';
const TERM_DIR = 'szotar';

// Kategóriák megjelenítési sorrendje
const CAT_ORDER = [
  'Makró & jegybank',
  'Kereskedés & technikai',
  'Vállalati & értékelés',
  'Globális piacok',
  'Kripto',
  'Portfólió & pszichológia',
];

// Kategóriánkénti rövid leírás (meta description + bevezető)
const CAT_INTRO = {
  'Makró & jegybank':
    'Makrogazdasági adatok és jegybanki döntések: infláció, munkaerőpiac, kamatpálya, Fed és EKB. Ezek az adatok mozgatják a leginkább a piacokat.',
  'Kereskedés & technikai':
    'Kereskedési és technikai elemzési fogalmak: árfolyammintázatok, indikátorok, likviditás, volatilitás és piaci mikrostruktúra.',
  'Vállalati & értékelés':
    'Vállalati jelentések és értékelési mutatók: eredmény, árbevétel, cash flow, P/E és a többi szám, amiből a részvény ára kiolvasható.',
  'Globális piacok':
    'Globális piacok és eszközosztályok: devizák, kötvények, nyersanyagok, feltörekvő piacok és a köztük lévő összefüggések.',
  Kripto:
    'Kriptopiaci fogalmak: Bitcoin, Ethereum, DeFi, stablecoinok, ETF-áramlások és a szektort meghatározó szabályozás.',
  'Portfólió & pszichológia':
    'Portfólióépítés és befektetői pszichológia: diverzifikáció, kockázatkezelés, pozícióméretezés és a leggyakoribb döntési hibák.',
};

const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const shorten = (t, n) => {
  t = clean(t);
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, '') + '…';
};
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const termUrl = (slug) => `${SITE}/${TERM_DIR}/${slug}.html`;

// ---------- Kategória-segédfüggvények ----------
const slugify = (s) =>
  clean(s)
    .toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/[óöő]/g, 'o').replace(/[úüű]/g, 'u')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const catSlug = (cat) => `kategoria-${slugify(cat)}`;
const catFile = (cat) => `${catSlug(cat)}.html`;
const catUrl = (cat) => `${SITE}/${TERM_DIR}/${catFile(cat)}`;
const catOf = (e) => e.category || 'Egyéb';

function orderedCategories(glossary) {
  const present = [...new Set(glossary.map(catOf))];
  const rank = (c) => (CAT_ORDER.indexOf(c) < 0 ? 99 : CAT_ORDER.indexOf(c));
  return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'hu'));
}

const byTitle = (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase(), 'hu');

// ---------- Automatikus kereszthivatkozás a fogalmak között ----------
const HU = 'A-Za-z\\u00C0-\\u017F0-9';
// Túl általános vagy félreérthető kifejezések: ezekre nem linkelünk
const NO_LINK = new Set(['gap', 'call', 'put', 'sec', 'em', 'moat', 'swap', 'beta']);

function buildLinkIndex(glossary) {
  const idx = [];
  for (const e of glossary) {
    const cands = new Set();
    const t = clean(e.title);
    cands.add(t);
    // "CPI – Fogyasztói árindex"  ->  "CPI"
    const dash = t.split(/\s+[–—-]\s+/)[0];
    if (dash) cands.add(clean(dash));
    // "European Central Bank (ECB)"  ->  "ECB"  és  "European Central Bank"
    const par = t.match(/\(([^)]+)\)/);
    if (par) cands.add(clean(par[1]));
    cands.add(clean(t.replace(/\s*\([^)]*\)/, '')));
    for (let c of cands) {
      c = c.trim();
      if (c.length < 3) continue;
      if (NO_LINK.has(c.toLowerCase())) continue;
      idx.push({ slug: e.slug, text: c });
    }
  }
  // Hosszabb kifejezés előbb, hogy az "ISM Services PMI" ne "PMI"-ként illeszkedjen
  idx.sort((a, b) => b.text.length - a.text.length);
  return idx;
}

const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Beszúrja a linkeket egy MÁR HTML-escapelt bekezdésbe.
   Szegmensekre bontva dolgozik: a már linkelt részekbe nem ír bele,
   így nem keletkezhet egymásba ágyazott <a> tag.
   Fogalmanként legfeljebb egy link, oldalanként legfeljebb 8. */
function linkify(escapedText, selfSlug, linkIndex, used) {
  // { t: szövegrész, open: beleírhatunk-e }
  let parts = [{ t: escapedText, open: true }];

  for (const { slug, text } of linkIndex) {
    if (used.size >= 8) break;
    if (slug === selfSlug || used.has(slug)) continue;

    const suffix = text.length >= 6 ? '[a-z\\u00E0-\\u017F]{0,4}' : '';
    const re = new RegExp(`(?<![${HU}])(${rxEsc(esc(text))}${suffix})(?![${HU}])`, 'i');

    let done = false;
    const next = [];
    for (const p of parts) {
      if (done || !p.open) { next.push(p); continue; }
      const m = p.t.match(re);
      if (!m) { next.push(p); continue; }
      const i = m.index;
      if (i > 0) next.push({ t: p.t.slice(0, i), open: true });
      next.push({
        t: `<a class="xref" href="/${TERM_DIR}/${slug}.html">${m[1]}</a>`,
        open: false,
      });
      const rest = p.t.slice(i + m[1].length);
      if (rest) next.push({ t: rest, open: true });
      done = true;
    }
    if (done) { parts = next; used.add(slug); }
  }
  return parts.map((p) => p.t).join('');
}

/* Kapcsolódó fogalmak: ugyanabból a kategóriából, a saját fogalomtól
   kezdődő körkörös sorrendben, hogy minden oldal MÁS hatot ajánljon.
   Így a kategórián belül sűrű, egyenletes belső linkhálózat alakul ki. */
function relatedTerms(entry, inCat, count = 6) {
  if (inCat.length <= 1) return [];
  const i = inCat.findIndex((x) => x.slug === entry.slug);
  const out = [];
  for (let k = 1; k < inCat.length && out.length < count; k++) {
    out.push(inCat[(i + k) % inCat.length]);
  }
  return out;
}

// ---------- Közös stíluslap (fogalom- és kategóriaoldalakhoz) ----------
const PAGE_CSS = `:root{--bg:#0b1220;--text:rgba(255,255,255,.92);--muted:rgba(255,255,255,.68);--border:rgba(255,255,255,.14);--accent:#5eead4;--accent2:#60a5fa;--radius:18px}
*{box-sizing:border-box}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;color:var(--text);background:var(--bg);line-height:1.55;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(900px 450px at 15% 10%,rgba(94,234,212,.18),transparent 60%),radial-gradient(800px 400px at 85% 20%,rgba(96,165,250,.16),transparent 60%),var(--bg)}
a{color:inherit;text-decoration:none}
.wrap{max-width:760px;margin:0 auto;padding:24px 18px 60px}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:18px}
.crumbs a:hover{color:var(--accent);text-decoration:underline}
h1{font-size:30px;line-height:1.15;letter-spacing:-.4px;margin:0 0 6px}
.kick{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid var(--border);background:rgba(255,255,255,.05);border-radius:999px;font-size:12.5px;color:var(--muted);margin-bottom:16px}
.kick:hover{border-color:rgba(94,234,212,.35);color:var(--text)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.lead{color:rgba(255,255,255,.78);font-size:15px;margin:0 0 20px;max-width:62ch}
.sec{border:1px solid var(--border);background:rgba(255,255,255,.04);border-radius:var(--radius);padding:16px 18px;margin:14px 0}
.sec h2{margin:0 0 8px;font-size:14px;font-weight:900;color:var(--accent);letter-spacing:.2px}
.sec p{margin:0;font-size:15px;color:rgba(255,255,255,.85)}
.xref{color:var(--accent);text-decoration:none;border-bottom:1px dotted rgba(94,234,212,.45)}
.xref:hover{border-bottom-style:solid}
.rel{margin-top:26px;border:1px solid var(--border);background:rgba(255,255,255,.03);border-radius:var(--radius);padding:16px 18px}
.rel h2{margin:0 0 12px;font-size:14px;font-weight:900;color:var(--accent);letter-spacing:.2px}
.rel ul{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.rel li a{display:block;font-size:13.5px;color:rgba(255,255,255,.80);border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);padding:9px 12px;border-radius:12px}
.rel li a:hover{border-color:rgba(94,234,212,.35);color:#fff}
.catlist{margin:0;padding:0;list-style:none;display:grid;gap:10px}
.catlist li a{display:block;border:1px solid var(--border);background:rgba(255,255,255,.04);border-radius:14px;padding:13px 16px}
.catlist li a:hover{border-color:rgba(94,234,212,.35)}
.catlist strong{display:block;font-size:15px;margin-bottom:3px}
.catlist span{font-size:13px;color:var(--muted)}
.catnav{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 22px}
.catnav a{font-size:12.5px;color:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);padding:7px 12px;border-radius:999px}
.catnav a:hover{border-color:rgba(94,234,212,.35);color:#fff}
.catnav a.on{background:linear-gradient(135deg,rgba(94,234,212,.24),rgba(96,165,250,.16));border-color:rgba(94,234,212,.5);color:#fff;font-weight:700}
.pn-row{display:flex;justify-content:space-between;gap:10px;margin-top:26px;flex-wrap:wrap}
.pn{font-size:13px;color:var(--muted);border:1px solid var(--border);background:rgba(255,255,255,.04);padding:9px 12px;border-radius:12px;max-width:48%}
.pn:hover{border-color:rgba(94,234,212,.35);color:var(--text)}
.cta{margin-top:28px;border:1px solid rgba(94,234,212,.3);background:linear-gradient(135deg,rgba(94,234,212,.1),rgba(96,165,250,.07));border-radius:var(--radius);padding:18px}
.cta h3{margin:0 0 6px;font-size:15px}
.cta p{margin:0 0 12px;font-size:13.5px;color:rgba(255,255,255,.78)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 14px;border-radius:14px;border:1px solid rgba(94,234,212,.35);background:linear-gradient(135deg,rgba(94,234,212,.22),rgba(96,165,250,.14));font-weight:900;font-size:14px}
.btn.ghost{background:rgba(255,255,255,.04);border-color:var(--border)}
footer{margin-top:34px;padding-top:16px;border-top:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.55);font-size:12px}
footer a:hover{text-decoration:underline}
.legal{margin-top:10px;line-height:1.5}
@media(max-width:520px){h1{font-size:25px}.pn{max-width:100%;width:100%}.rel ul{grid-template-columns:1fr}}`;

const PAGE_HEAD_ICONS = `<link rel="icon" href="/favicon.ico" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />`;

const PAGE_FOOTER = `  <footer>
    <a href="/">Piacradar</a> · <a href="/glossary.html">Szótár</a> · <a href="/stories.html">Történetek</a> · <a href="/adatkezeles.html">Adatkezelés</a>
    <div class="legal">A tartalom kizárólag általános tájékoztatási célt szolgál, nem minősül befektetési tanácsadásnak.</div>
  </footer>`;

// ---------- Individual term pages ----------
function termPageHTML(entry, prev, next, linkIndex, inCat) {
  const secs = Array.isArray(entry.sections) ? entry.sections : [];
  const first = secs.length && secs[0] && typeof secs[0] === 'object' ? secs[0].text : '';
  const desc = shorten(first, 155);
  const url = termUrl(entry.slug);
  const cat = catOf(entry);
  const hasCat = Boolean(entry.category);

  const crumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Piacradar', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: 'Pénzügyi Szótár', item: `${SITE}/glossary.html` },
  ];
  if (hasCat) {
    crumbItems.push({ '@type': 'ListItem', position: 3, name: cat, item: catUrl(cat) });
  }
  crumbItems.push({ '@type': 'ListItem', position: crumbItems.length + 1, name: entry.title, item: url });

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'DefinedTerm',
        name: entry.title,
        url,
        description: shorten(first, 300),
        inDefinedTermSet: {
          '@type': 'DefinedTermSet',
          name: 'Piacradar Pénzügyi Szótár',
          url: `${SITE}/glossary.html`,
        },
        inLanguage: 'hu',
        ...(hasCat ? { termCode: cat } : {}),
      },
      { '@type': 'BreadcrumbList', itemListElement: crumbItems },
    ],
  };

  const used = new Set();
  const body = secs
    .map((s) => {
      if (!s || typeof s !== 'object') return '';
      const t = clean(s.title);
      const x = clean(s.text);
      if (!x) return '';
      const p = linkIndex ? linkify(esc(x), entry.slug, linkIndex, used) : esc(x);
      return t
        ? `        <section class="sec">\n          <h2>${esc(t)}</h2>\n          <p>${p}</p>\n        </section>`
        : `        <section class="sec">\n          <p>${p}</p>\n        </section>`;
    })
    .filter(Boolean)
    .join('\n');

  // Kapcsolódó fogalmak ugyanebből a kategóriából
  const rel = relatedTerms(entry, inCat || [], 6);
  const relBlock = rel.length
    ? `
  <div class="rel">
    <h2>Kapcsolódó fogalmak — ${esc(cat)}</h2>
    <ul>
${rel.map((r) => `      <li><a href="${esc(r.slug)}.html">${esc(shorten(r.title, 46))}</a></li>`).join('\n')}
    </ul>
  </div>
`
    : '';

  const catBadge = hasCat
    ? `<a class="kick" href="${esc(catFile(cat))}"><span class="dot"></span> ${esc(cat)}</a>`
    : `<div class="kick"><span class="dot"></span> Pénzügyi fogalom</div>`;

  const crumbHtml = hasCat
    ? `<a href="/">Piacradar</a> › <a href="/glossary.html">Pénzügyi Szótár</a> › <a href="${esc(catFile(cat))}">${esc(cat)}</a> › <span>${esc(entry.title)}</span>`
    : `<a href="/">Piacradar</a> › <a href="/glossary.html">Pénzügyi Szótár</a> › <span>${esc(entry.title)}</span>`;

  const nav = [];
  if (prev) nav.push(`<a class="pn" href="${esc(prev.slug)}.html">← ${esc(shorten(prev.title, 42))}</a>`);
  else nav.push('<span></span>');
  if (next) nav.push(`<a class="pn" href="${esc(next.slug)}.html">${esc(shorten(next.title, 42))} →</a>`);
  else nav.push('<span></span>');

  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(entry.title)} — mit jelent? | Piacradar Pénzügyi Szótár</title>
<meta name="description" content="${esc(desc)}" />
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large" />
<meta name="theme-color" content="#0b1220" />
<link rel="canonical" href="${url}" />
<meta property="og:title" content="${esc(entry.title)} — Piacradar Pénzügyi Szótár" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${SITE}/og-image.jpg" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(entry.title)} — Piacradar Pénzügyi Szótár" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${SITE}/og-image.jpg" />
${PAGE_HEAD_ICONS}
<style>
${PAGE_CSS}
</style>
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>
<div class="wrap">
  <nav class="crumbs" aria-label="Morzsamenü">
    ${crumbHtml}
  </nav>

  ${catBadge}
  <h1>${esc(entry.title)}</h1>

${body}
${relBlock}
  <div class="pn-row">
    ${nav.join('\n    ')}
  </div>

  <div class="cta">
    <h3>Értsd meg, mi mozgatja a piacot</h3>
    <p>Piaci napokon napi 3 elemzés: EU/USA makró, kiemelt vállalati jelentések, Fed és ECB — magyarul, forráslinkkel.</p>
    <a class="btn" href="${TG}" target="_blank" rel="noopener noreferrer">Csatlakozz a zárt közösséghez →</a>
    <a class="btn ghost" href="/glossary.html">Vissza a szótárhoz</a>
  </div>

${PAGE_FOOTER}
</div>
</body>
</html>
`;
}

// ---------- Category hub pages ----------
function categoryPageHTML(cat, inCat, allCats) {
  const url = catUrl(cat);
  const intro =
    CAT_INTRO[cat] ||
    `A Piacradar Pénzügyi Szótár ${cat} kategóriájába tartozó fogalmak magyarázata befektetői kontextussal.`;
  const desc = shorten(`${cat} — ${inCat.length} pénzügyi fogalom magyarázata. ${intro}`, 155);

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: `${cat} — Piacradar Pénzügyi Szótár`,
        url,
        description: shorten(intro, 300),
        inLanguage: 'hu',
        isPartOf: {
          '@type': 'DefinedTermSet',
          name: 'Piacradar Pénzügyi Szótár',
          url: `${SITE}/glossary.html`,
        },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: inCat.length,
          itemListElement: inCat.map((e, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: e.title,
            url: termUrl(e.slug),
          })),
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Piacradar', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Pénzügyi Szótár', item: `${SITE}/glossary.html` },
          { '@type': 'ListItem', position: 3, name: cat, item: url },
        ],
      },
    ],
  };

  const navHtml = allCats
    .map(
      (c) =>
        `    <a href="${esc(catFile(c))}"${c === cat ? ' class="on" aria-current="page"' : ''}>${esc(c)}</a>`
    )
    .join('\n');

  const listHtml = inCat
    .map((e) => {
      const secs = Array.isArray(e.sections) ? e.sections : [];
      const first = secs.length && secs[0] && typeof secs[0] === 'object' ? secs[0].text : '';
      return `      <li><a href="${esc(e.slug)}.html"><strong>${esc(e.title)}</strong><span>${esc(
        shorten(first, 120)
      )}</span></a></li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(cat)} — ${inCat.length} fogalom | Piacradar Pénzügyi Szótár</title>
<meta name="description" content="${esc(desc)}" />
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large" />
<meta name="theme-color" content="#0b1220" />
<link rel="canonical" href="${url}" />
<meta property="og:title" content="${esc(cat)} — Piacradar Pénzügyi Szótár" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${SITE}/og-image.jpg" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(cat)} — Piacradar Pénzügyi Szótár" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${SITE}/og-image.jpg" />
${PAGE_HEAD_ICONS}
<style>
${PAGE_CSS}
</style>
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>
<div class="wrap">
  <nav class="crumbs" aria-label="Morzsamenü">
    <a href="/">Piacradar</a> › <a href="/glossary.html">Pénzügyi Szótár</a> › <span>${esc(cat)}</span>
  </nav>

  <div class="kick"><span class="dot"></span> Szótár-kategória</div>
  <h1>${esc(cat)}</h1>
  <p class="lead">${esc(intro)} Összesen <strong>${inCat.length} fogalom</strong> ebben a kategóriában.</p>

  <nav class="catnav" aria-label="Kategóriák">
${navHtml}
  </nav>

  <ul class="catlist">
${listHtml}
  </ul>

  <div class="cta">
    <h3>Értsd meg, mi mozgatja a piacot</h3>
    <p>Piaci napokon napi 3 elemzés: EU/USA makró, kiemelt vállalati jelentések, Fed és ECB — magyarul, forráslinkkel.</p>
    <a class="btn" href="${TG}" target="_blank" rel="noopener noreferrer">Csatlakozz a zárt közösséghez →</a>
    <a class="btn ghost" href="/glossary.html">Teljes szótár →</a>
  </div>

${PAGE_FOOTER}
</div>
</body>
</html>
`;
}

// ---------- Page generation ----------
function buildPages(glossary) {
  if (!fs.existsSync(TERM_DIR)) fs.mkdirSync(TERM_DIR, { recursive: true });
  const linkIndex = buildLinkIndex(glossary);
  const cats = orderedCategories(glossary);

  // Kategóriánkénti, cím szerint rendezett lista (a kapcsolódó fogalmakhoz)
  const byCat = new Map();
  for (const c of cats) {
    byCat.set(c, glossary.filter((e) => catOf(e) === c && e.slug).sort(byTitle));
  }

  const sorted = [...glossary].sort(byTitle);
  const wanted = new Set();

  // Fogalomoldalak
  sorted.forEach((e, i) => {
    if (!e.slug) return;
    const inCat = byCat.get(catOf(e)) || [];
    const html = termPageHTML(e, sorted[i - 1] || null, sorted[i + 1] || null, linkIndex, inCat);
    fs.writeFileSync(path.join(TERM_DIR, `${e.slug}.html`), html);
    wanted.add(`${e.slug}.html`);
  });
  const termCount = wanted.size;

  // Kategória-oldalak
  for (const c of cats) {
    const inCat = byCat.get(c) || [];
    if (!inCat.length) continue;
    fs.writeFileSync(path.join(TERM_DIR, catFile(c)), categoryPageHTML(c, inCat, cats));
    wanted.add(catFile(c));
  }

  // Elavult oldalak törlése
  let removed = 0;
  for (const f of fs.readdirSync(TERM_DIR)) {
    if (f.endsWith('.html') && !wanted.has(f)) {
      fs.unlinkSync(path.join(TERM_DIR, f));
      removed++;
    }
  }
  return { terms: termCount, cats: cats.length, removed };
}

// ---------- GLOSSARY JSON-LD (DefinedTermSet) ----------
function glossaryLD(glossary) {
  const terms = glossary.map((e) => {
    const secs = Array.isArray(e.sections) ? e.sections : [];
    const desc = secs.length && secs[0] && typeof secs[0] === 'object' ? secs[0].text : '';
    return {
      '@type': 'DefinedTerm',
      name: e.title,
      url: termUrl(e.slug),
      description: shorten(desc, 180),
      inDefinedTermSet: `${SITE}/glossary.html`,
      ...(e.category ? { termCode: e.category } : {}),
    };
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    name: 'Piacradar Pénzügyi Szótár',
    url: `${SITE}/glossary.html`,
    description: `${glossary.length} pénzügyi és tőzsdei fogalom magyarázata befektetői kontextussal: CPI, GDP, VIX, EPS és sok más.`,
    inLanguage: 'hu',
    hasDefinedTerm: terms,
  };
}

// ---------- STORIES JSON-LD (Blog) ----------
function storiesLD(stories) {
  const posts = stories.map((st) => {
    const post = {
      '@type': 'BlogPosting',
      headline: st.title,
      description: shorten(st.takeaway || st.story_text || '', 200),
      articleSection: st.category || '',
      url: `${SITE}/stories.html#${st.story_id || ''}`,
      inLanguage: 'hu',
      isPartOf: { '@type': 'Blog', name: 'Szombati Történetek', url: `${SITE}/stories.html` },
      publisher: { '@type': 'Organization', name: 'Piacradar', url: `${SITE}/` },
    };
    if (st.sent_at && String(st.sent_at).toLowerCase() !== 'none') {
      post.datePublished = st.sent_at;
    }
    return post;
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Szombati Történetek',
    url: `${SITE}/stories.html`,
    description:
      'Heti történetek piaci összeomlásokról, tőzsdei legendákról és befektetői tanulságokról — magyarul.',
    inLanguage: 'hu',
    blogPost: posts,
  };
}

// ---------- Embed/replace JSON-LD block in an HTML file ----------
function embedLD(p, ld) {
  let html = fs.readFileSync(p, 'utf8');
  const block =
    '<!-- Structured Data (GEO/SEO) — auto-generated by geo-build.js, do not edit by hand -->\n  ' +
    '<script type="application/ld+json">\n' +
    JSON.stringify(ld, null, 2) +
    '\n  </script>';
  const re = /<!-- Structured Data \(GEO\/SEO\)[^>]*-->\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/;
  if (re.test(html)) {
    html = html.replace(re, block);
  } else {
    html = html.replace('</head>', '  ' + block + '\n</head>');
  }
  fs.writeFileSync(p, html);
  JSON.parse(JSON.stringify(ld));
  return html.length;
}

/* Statikus, feltérképezhető kategória-linksor beszúrása a glossary.html-be.
   A meglévő #catNav JS-ből épül, ezért a Google nem követi — ez a sor viszont
   sima <a> tagekből áll, és a kategória-hubokra mutat. Idempotens. */
function embedCategoryLinks(glossary) {
  const p = 'glossary.html';
  let html = fs.readFileSync(p, 'utf8');
  const cats = orderedCategories(glossary);

  const links = cats
    .map((c) => {
      const n = glossary.filter((e) => catOf(e) === c).length;
      return `      <a href="/${TERM_DIR}/${catFile(c)}">${esc(c)} <span class="n">${n}</span></a>`;
    })
    .join('\n');

  const block = `<!-- Kategória-hubok (GEO) — auto-generated by geo-build.js, do not edit by hand -->
    <nav class="cat-hubs" aria-label="Szótár-kategóriák">
${links}
    </nav>
    <!-- /Kategória-hubok -->`;

  const re = /<!-- Kategória-hubok \(GEO\)[\s\S]*?<!-- \/Kategória-hubok -->/;
  if (re.test(html)) {
    html = html.replace(re, block);
  } else {
    const anchor = '<div class="cat-nav" id="catNav"></div>';
    if (html.includes(anchor)) {
      html = html.replace(anchor, `${block}\n      ${anchor}`);
    } else {
      console.warn('! glossary.html: nem talalom a #catNav horgonyt, a kategoria-linksor kimaradt');
      return 0;
    }
  }

  // Stílus a linksorhoz (egyszer)
  if (!html.includes('.cat-hubs{')) {
    const css = `    .cat-hubs{ display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
    .cat-hubs a{ font-size:13px; color:rgba(255,255,255,.78); border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.04); padding:8px 13px; border-radius:999px; text-decoration:none; }
    .cat-hubs a:hover{ border-color:rgba(94,234,212,.4); color:#fff; }
    .cat-hubs .n{ opacity:.55; margin-left:5px; font-weight:600; }
`;
    html = html.replace('    .cat-chip {', css + '    .cat-chip {');
  }

  fs.writeFileSync(p, html);
  return cats.length;
}

// ---------- sitemap-1.xml ----------
function buildSitemap(glossary) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, freq: 'weekly', pri: '1.0' },
    { loc: `${SITE}/glossary.html`, freq: 'weekly', pri: '0.9' },
    { loc: `${SITE}/stories.html`, freq: 'weekly', pri: '0.8' },
    { loc: `${SITE}/adatkezeles.html`, freq: 'yearly', pri: '0.2' },
  ];
  // Kategória-hubok elöl: ezeken keresztül jut el a crawler a fogalmakhoz
  for (const c of orderedCategories(glossary)) {
    if (glossary.some((e) => catOf(e) === c && e.slug)) {
      urls.push({ loc: catUrl(c), freq: 'weekly', pri: '0.8' });
    }
  }
  for (const e of [...glossary].sort(byTitle)) {
    if (e.slug) urls.push({ loc: termUrl(e.slug), freq: 'monthly', pri: '0.6' });
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  fs.writeFileSync('sitemap-1.xml', xml);
  return urls.length;
}

// ---------- llms-full.txt ----------
function buildLlmsFull(glossary, stories) {
  const out = [];
  out.push('# Piacradar — teljes tartalom (AI/LLM olvasásra)\n');
  out.push(
    `> Ez a fájl a Piacradar teljes edukációs tartalmát tartalmazza gépi olvasásra: a Pénzügyi Szótár összes fogalma és a Szombati Történetek teljes szövege. Forrás és kapcsolat: ${SITE}/ · Telegram: ${TG} · Készítő: Tamás Kovács (https://tamaskovacs.eu).\n`
  );
  out.push(
    'A tartalmak kizárólag általános tájékoztatási célt szolgálnak, nem minősülnek befektetési tanácsadásnak.\n'
  );

  out.push(`\n# Pénzügyi Szótár (${glossary.length} fogalom)\n`);
  out.push(`Forrás: ${SITE}/glossary.html\n`);
  const sorted = [...glossary].sort(byTitle);
  const cats = orderedCategories(glossary);

  out.push('## Tartalomjegyzék kategóriánként\n');
  out.push('Minden fogalom szerkezete azonos: "Mi ez?" · "Miért fontos?" · "Piacradar értelmezés".\n');
  for (const c of cats) {
    const inCat = sorted.filter((e) => catOf(e) === c);
    out.push(`\n### ${c} (${inCat.length}) — ${catUrl(c)}`);
    out.push(inCat.map((e) => `${e.title} — ${termUrl(e.slug)}`).join('\n'));
  }
  out.push('\n---\n');
  for (const e of sorted) {
    out.push(`\n## ${e.title}`);
    if (e.category) out.push(`Kategória: ${e.category} (${catUrl(catOf(e))})`);
    out.push(`Hivatkozás: ${termUrl(e.slug)}`);
    for (const sec of e.sections || []) {
      if (sec && typeof sec === 'object') {
        const st = clean(sec.title);
        const tx = clean(sec.text);
        if (st && tx) out.push(`\n**${st}** ${tx}`);
        else if (tx) out.push(`\n${tx}`);
      }
    }
  }

  out.push(`\n\n# Szombati Történetek (${stories.length} történet)\n`);
  out.push(`Forrás: ${SITE}/stories.html\n`);
  for (const st of stories) {
    out.push(`\n## ${clean(st.title)}`);
    const meta = [];
    if (st.category) meta.push(`Kategória: ${clean(st.category)}`);
    meta.push(`Hivatkozás: ${SITE}/stories.html#${st.story_id || ''}`);
    out.push(meta.join(' · '));
    if (st.story_text) out.push(`\n${clean(st.story_text)}`);
    if (st.takeaway) out.push(`\n**Tanulság:** ${clean(st.takeaway)}`);
    if (st.why_now) out.push(`\n**Miért aktuális:** ${clean(st.why_now)}`);
  }
  return out.join('\n') + '\n';
}

// ---------- main ----------
function main() {
  const glossary = readJSON('glossary-data.json');
  const stories = readJSON('data.json');

  const pages = buildPages(glossary);
  const gLen = embedLD('glossary.html', glossaryLD(glossary));
  const catLinks = embedCategoryLinks(glossary);
  const sLen = embedLD('stories.html', storiesLD(stories));

  const full = buildLlmsFull(glossary, stories);
  fs.writeFileSync('llms-full.txt', full);

  const smCount = buildSitemap(glossary);

  console.log(`${TERM_DIR}/: ${pages.terms} fogalomoldal + ${pages.cats} kategoria-oldal, ${pages.removed} elavult torolve`);
  console.log(`glossary.html: ${glossary.length} fogalom JSON-LD + ${catLinks} kategoria-link (${gLen} bytes)`);
  console.log(`stories.html: ${stories.length} tortenet JSON-LD (${sLen} bytes)`);
  console.log(`llms-full.txt: ${full.length} bytes`);
  console.log(`sitemap-1.xml: ${smCount} URL`);
}

main();
