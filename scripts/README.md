# Build szkriptek

## `geo-build.js`

A `glossary-data.json`-ból és a `data.json`-ból generálja a szótár- és történetoldalakat
(`szotar/`, `tortenetek/`), a hub oldalak statikus listáit és JSON-LD-jét, a `sitemap-1.xml`-t,
az `llms-full.txt`-t és a `content-dates.json`-t. Push után a GitHub Actions automatikusan futtatja,
de helyben is futtatható:

```
node scripts/geo-build.js
```

## `content-dates-bootstrap.js`

Egyszeri szkript: a `content-dates.json` kezdőértékeit (első megjelenés, utolsó módosítás)
a git-előzményekből számolja. Normál használathoz nem kell, a `geo-build.js` tartja karban a fájlt.

## Szótárbejegyzés formátuma (`glossary-data.json`)

A fájl egy tömb; minden elem egy fogalom.

| Mező | Kötelező | Leírás |
|---|---|---|
| `slug` | igen | Az oldal címe: `szotar/<slug>.html`. Kisbetű, ékezet nélkül, kötőjellel. Megjelenés után ne változtasd, mert az URL is változna. |
| `title` | igen | A fogalom neve, ez lesz az oldal címe (h1). |
| `category` | igen | Egy a hat kategóriából: `Makró & jegybank`, `Kereskedés & technikai`, `Vállalati & értékelés`, `Globális piacok`, `Kripto`, `Portfólió & pszichológia`. |
| `sections` | igen | Szakaszok tömbje, `{ "title": "...", "text": "..." }` elemekkel, 3–5 darab. |
| `sources` | nem | Források tömbje, `{ "label": "...", "url": "https://..." }` elemekkel. |

### Szakaszok

A szakaszok a megadott sorrendben jelennek meg. Ajánlott címek és sorrend:

1. `Mi ez?` — kötelezően az első: ebből készül a meta description és a kártyák kivonata.
2. `Miért fontos?`
3. `Valós példa` (opcionális)
4. `Gyakori tévhit` (opcionális)
5. `Piacradar értelmezés`

A szövegben a többi fogalom nevét a build automatikusan linkeli (oldalanként legfeljebb 8 link).

### Források

- Ha van `sources`, a fogalomoldalon a szakaszok után „Források” blokk jelenik meg, új lapon nyíló
  linkekkel, és a JSON-LD-be `citation`-ként kerülnek. Az `llms-full.txt`-be is bekerülnek.
- Csak a címkével és `http://` vagy `https://` kezdetű URL-lel rendelkező források jelennek meg,
  a többit a build kihagyja.
- Ha nincs `sources` (vagy üres), semmi nem jelenik meg.

### Dátumok

Nem kell kézzel megadni. A `geo-build.js` a `content-dates.json`-ban bejegyzésenként követi,
mikor változott utoljára a tartalom (bármely mező). Ebből lesz a fogalomoldalon a
„Frissítve: ÉÉÉÉ.HH.NN.” sor, a JSON-LD `dateModified` mezője és a sitemap `lastmod`-ja.

### Teljes példa

```json
{
  "slug": "cpi",
  "title": "CPI – Fogyasztói árindex",
  "category": "Makró & jegybank",
  "sections": [
    { "title": "Mi ez?", "text": "Rövid definíció (ebből lesz a meta description)." },
    { "title": "Miért fontos?", "text": "…" },
    { "title": "Valós példa", "text": "…" },
    { "title": "Gyakori tévhit", "text": "…" },
    { "title": "Piacradar értelmezés", "text": "…" }
  ],
  "sources": [
    { "label": "U.S. Bureau of Labor Statistics – Consumer Price Index", "url": "https://www.bls.gov/cpi/" }
  ]
}
```
