#!/usr/bin/env node
/**
 * Egyszeri indítás: a content-dates.json kezdőértékeit a git-előzményekből számolja.
 *
 * Minden olyan commitot végigjár (a legrégebbitől), amely a data.json-t, a glossary-data.json-t,
 * az index.html-t vagy az adatkezeles.html-t módosította, és bejegyzésenként megjegyzi,
 * melyik commitban jelent meg először (datePublished) és melyikben változott utoljára a tartalom
 * (lastmod / dateModified) — ugyanazzal a hash-sel, amit a geo-build.js használ.
 * Ehhez teljes git-előzmény kell (nem sekély klón). Utána a geo-build.js tartja karban a fájlt.
 *
 * Futtatás: node scripts/content-dates-bootstrap.js
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const { contentSources } = require('./geo-build.js');

const FILES = ['data.json', 'glossary-data.json', 'index.html', 'adatkezeles.html'];
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const show = (sha, file) => {
  try {
    return git('show', `${sha}:${file}`);
  } catch (e) {
    return null;
  }
};

const commits = git('log', '--reverse', '--format=%H %cs', '--', ...FILES)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [sha, date] = l.split(' ');
    return { sha, date };
  });

const last = {};
for (const { sha, date } of commits) {
  const read = (f) => show(sha, f);
  const parse = (f) => {
    const t = read(f);
    if (!t) return [];
    try {
      return JSON.parse(t);
    } catch (e) {
      return [];
    }
  };
  const src = contentSources(parse('glossary-data.json'), parse('data.json'), read);
  for (const [k, h] of Object.entries(src)) {
    if (!last[k]) last[k] = { hash: h, date, first: date };
    else if (last[k].hash !== h) last[k] = { hash: h, date, first: last[k].first };
  }
}

// A munkakönyvtár jelenlegi állapota (ha van még nem commitolt változás, az mai dátumot kap)
const today = new Date().toISOString().slice(0, 10);
const readNow = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const now = contentSources(JSON.parse(readNow('glossary-data.json')), JSON.parse(readNow('data.json')), readNow);
const out = {};
for (const k of Object.keys(now).sort()) {
  if (last[k] && last[k].hash === now[k]) out[k] = last[k];
  else out[k] = { hash: now[k], date: today, first: (last[k] && last[k].first) || today };
  // a történetek slugját megőrizzük (a geo-build.js tölti ki)
  const prevDb = fs.existsSync('content-dates.json') ? JSON.parse(fs.readFileSync('content-dates.json', 'utf8')) : {};
  if (prevDb[k] && prevDb[k].slug) out[k].slug = prevDb[k].slug;
}
fs.writeFileSync('content-dates.json', JSON.stringify(out, null, 1) + '\n');
const dates = Object.values(out).map((v) => v.date);
console.log(`content-dates.json: ${dates.length} bejegyzés, ${commits.length} commit alapján`);
const hist = {};
for (const d of dates) hist[d] = (hist[d] || 0) + 1;
console.log(Object.entries(hist).sort().map(([d, n]) => `${d}: ${n}`).join('\n'));
