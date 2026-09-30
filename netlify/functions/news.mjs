// ChainzNewz news function (runs on Netlify).
// The app calls this every time it opens or you pull down. If the stored
// feed is more than 2 hours old, it pulls fresh packaging / foodservice /
// cold chain news, adds the buying signals, drops anything older than 30
// days, saves it, and returns it. Otherwise it returns the stored feed.
import { getStore } from "@netlify/blobs";

const KEEP_DAYS = 30;
const STALE_MS = 2 * 60 * 60 * 1000;
const MAX_NEW = 6;
const FETCH_TIMEOUT_MS = 5000;
const TZ = "America/Detroit";

const INDUSTRY_FEEDS = [
  ["Packaging Dive", "https://www.packagingdive.com/feeds/news/"],
  ["Food Dive", "https://www.fooddive.com/feeds/news/"],
  ["Grocery Dive", "https://www.grocerydive.com/feeds/news/"],
  ["Restaurant Dive", "https://www.restaurantdive.com/feeds/news/"],
  ["Supply Chain Dive", "https://www.supplychaindive.com/feeds/news/"],
];
const GOOGLE_QUERIES = [
  '"food plant" OR "food processing plant" expansion OR opens',
  '"prepared meals" OR "ready meals" OR "meal prep" expansion OR launch OR facility',
  'co-packer OR "co-manufacturer" expansion food',
  '"franchise" "development agreement" restaurant units',
  '"multi-unit" franchisee restaurant signs',
  '"commissary kitchen" OR "ghost kitchen" opens OR expansion',
  '"tray sealing" OR "tray sealer" OR "lidding film"',
  '"foodservice packaging" OR "takeout packaging" OR "to-go packaging"',
  '"food packaging" price increase OR tariff OR shortage',
  'resin OR containerboard OR corrugated price increase packaging',
  '"disposable gloves" OR "vinyl gloves" OR "nitrile gloves" price OR tariff OR shortage',
  '"can liners" OR "trash bags" price OR tariff',
  'PFAS "food packaging" ban',
  '"cold chain" packaging OR shipping perishable OR pharmacy',
  '"gel packs" OR "insulated shipping" OR "insulated shippers"',
  '"specialty pharmacy" OR "direct-to-patient" expansion OR launch',
  'packaging supplier acquires OR acquisition foodservice',
];

const RULES = [
  ["buyer", "Hot", 6, ["looking for a supplier", "seeking suppliers", "rfp", "request for proposal", "shortage"]],
  ["growth", "Warm", 4, ["new plant", "new facility", "opens new", "to open", "expansion", "expands", "invests", "investment",
    "production line", "new line", "new jobs", "development agreement", "unit deal", "unit agreement",
    "co-packer", "co-manufactur", "commissary", "ghost kitchen", "raises $", "funding round", "breaks ground"]],
  ["pricing", "Warm", 4, ["price increase", "price hike", "prices rise", "raising prices", "surcharge", "tariff", "duties", "anti-dumping"]],
  ["mna", "Warm", 3, ["acquires", "acquisition", "to acquire", "merger", "buyout", "private equity", "sells to"]],
  ["regulation", "Watch", 2, ["pfas", "ban", "epr", "extended producer", "regulation", "law", "bill"]],
  ["chain", "Watch", 1, ["mcdonald", "burger king", "wendy", "kfc", "taco bell", "chick-fil-a", "starbucks", "subway", "domino"]],
];
const RELEVANCE = ["packaging", "tray", "film", "sealer", "sealing", "glove", "liner", "straw", "container", "to-go", "takeout",
  "foodservice", "restaurant", "franchise", "meal", "food plant", "food processing", "co-pack", "commissary",
  "cold chain", "insulated", "gel pack", "perishable", "pharmacy", "corrugated", "containerboard", "resin",
  "frozen", "prepared food", "grocery", "qsr", "fast casual", "catering", "kitchen"];
const COLD = ["cold chain", "insulated", "gel pack", "perishable", "pharma", "pharmacy", "refrigerated", "temperature-controlled",
  "direct-to-patient", "biologic", "glp-1", "vaccine", "frozen shipping"];
const PRODUCT_MAP = [
  ["Meal trays", ["meal", "tray", "prepared", "ready-to-eat", "frozen entree", "entree"]],
  ["Sealing film", ["film", "lidding", "seal"]],
  ["Tray sealers", ["sealer", "sealing machine", "automation", "line"]],
  ["To-go packaging", ["to-go", "takeout", "take-out", "container", "restaurant", "franchise", "units", "delivery", "catering"]],
  ["Gloves", ["glove", "restaurant", "plant", "kitchen", "franchise", "food processing"]],
  ["Can liners", ["liner", "trash", "restaurant", "franchise", "units"]],
  ["Straws", ["straw", "beverage", "smoothie", "coffee", "drink"]],
  ["Boxes", ["box", "corrugated", "containerboard", "case"]],
  ["Cold chain shippers", ["cold chain", "insulated", "shipper", "perishable", "pharmacy"]],
  ["Gel packs", ["gel pack", "cold chain", "refrigerant", "perishable"]],
];
const NOISE = ["recipe", "horoscope", "stock price", "shares of", "earnings call", "obituary", "review:", "market size", "market report",
  "feasibility", "setup cost", "cost report", "forecast", "cagr", "franchise costs", "franchise cost", "fees, profit",
  "bankrupt", "chapter 11", "layoff", "closing", "closes", "shutter", "value menu", "perception", "hidden liability",
  "why multi-unit", "why multi-brand", "top 10", "best ", "how to ", "webinar", "sponsored", "india", "indian", " uk ",
  "australia", "canada's", "europe", "pakistan", "italy", "italian", "germany", "france", "spain", "mexico", "brazil",
  "china", "chinese", "japan", "philippines", "saudi", "dubai", "uae", "nigeria", "kenya", "south africa", "south asia",
  "new zealand", "ireland", "scotland", "britain", "british", "€", "£", "₹", "pet food", "petfood", "explained",
  "what to know", "opinion", "podcast", "a conversation with", "interview", "gym", "fitness", "salon", "hotel"];
const BLOCKED_SOURCES = ["retail news asia", "hoodline", "petfoodindustry", "openpr", "quiver", "insider media", "indian printer",
  "packaging south asia", "1851 franchise", "ein presswire", "einpresswire", "marketsandmarkets", "yahoo finance", "benzinga",
  "zacks", "seeking alpha", "motley fool", "marketbeat", "globenewswire", "news.google"];

const KICKERS = { growth: "Growth signal", pricing: "Price move", mna: "Deal", chain: "Chain news", buyer: "Buyer need", coldchain: "Cold chain", regulation: "Regulation" };
const SIGNALS = {
  growth: "More volume means new buys on packaging and supplies, and vendors often get set up fresh.",
  pricing: "Buyers are about to feel higher costs. It's a good reason to offer a price check.",
  mna: "Ownership changes often bring price and SKU changes. Buyers may want a second source.",
  chain: "Background on a big chain. Most consumables run through national contracts.",
  buyer: "A direct need is showing. Reach out while they're still choosing.",
  coldchain: "More temperature-sensitive shipping means more liners, gel packs and shipper boxes.",
  regulation: "Rules like this push buyers to re-check what they're using.",
};
const GENERIC = new Set(Object.values(SIGNALS));
const NEXT = {
  growth: "Find the purchasing or operations lead and ask what they're buying for the new volume.",
  pricing: "Call buyers of these items and offer to check what they're paying.",
  mna: "Pitch a second-source quote to accounts that buy from this supplier.",
  chain: "Watch only. Look for franchisee groups in your region.",
  buyer: "Reach out today while they're still picking a supplier.",
  coldchain: "Find the shipping or packaging lead and offer liners, gel packs and shippers.",
  regulation: "Watch only. Use it as a talking point with buyers.",
};
const OPENERS = {
  growth: "Hi [Name],\nCongrats on the growth. When volume ramps up, packaging and supplies are usually where it gets tight. I'd like to quote you a backup source. Can you and I discuss?\nTony",
  pricing: "Hi [Name],\nPrices are moving on packaging again. Before your next order, let me check what you're paying. Can you and I discuss?\nTony",
  mna: "Hi [Name],\nWith the ownership change at your supplier, pricing and SKUs could shift. I can quote you a backup so you're covered either way. Can you and I discuss?\nTony",
  buyer: "Hi [Name],\nI saw you're looking for a supplier. I can get you pricing quickly. Can you and I discuss?\nTony",
  coldchain: "Hi [Name],\nI saw you're growing your cold shipping. I supply liners, gel packs and shipper boxes and can get you a side-by-side quick. Can you and I discuss?\nTony",
};
const STAT_RE = /(\$\s?\d[\d,.]*\s?(?:million|billion|[MBK])\b|\d[\d,]*\s?(?:-unit|units|locations|stores|restaurants|jobs)\b|\d+(?:\.\d+)?%)/i;
const STOP = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "with", "its", "at", "by", "from", "as", "is", "new", "after", "into", "over"]);

// ---------- helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function unescape(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function clean(s) {
  return unescape(unescape(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function parseRss(xml, defaultSource) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    let title = clean(tag(b, "title"));
    const link = clean(tag(b, "link"));
    const source = clean(tag(b, "source")) || defaultSource;
    const desc = clean(tag(b, "description"));
    const pub = new Date(clean(tag(b, "pubDate")));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(" - " + source).length).trim();
    if (title && link && !isNaN(pub)) out.push({ title, url: link, pub, source, desc });
  }
  return out;
}
async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (ChainzNewz; +https://chainznewz.netlify.app)" } });
    return r.ok ? await r.text() : "";
  } catch { return ""; } finally { clearTimeout(t); }
}
function localDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function localIso(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).formatToParts(d).map(x => [x.type, x.value]));
  const off = (p.timeZoneName || "GMT-04:00").replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
function words(t) {
  return new Set((t.toLowerCase().match(/[a-z0-9$]+/g) || []).filter(w => !STOP.has(w) && w.length > 2));
}
function sameStory(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.5;
}
function slug(s, n = 48) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "");
}
function isNoise(text, source) {
  const t = text.toLowerCase(), s = (source || "").toLowerCase();
  return NOISE.some(n => t.includes(n)) || BLOCKED_SOURCES.some(b => s.includes(b));
}
function coverStat(title, typ) {
  const m = title.match(STAT_RE);
  if (m) return m[1].replace(/\s*million/i, "M").replace(/\s*billion/i, "B").replace(/\s/g, "").slice(0, 11);
  return { growth: "Growing", pricing: "Price move", mna: "New owner", chain: "Chain news", buyer: "Need", coldchain: "Cold chain", regulation: "New rule" }[typ];
}

function pick(cands, existing, today) {
  const scored = [];
  for (const c of cands) {
    const text = (c.title + " " + c.desc).toLowerCase();
    if (isNoise(c.title + " " + c.desc, c.source)) continue;
    if (!RELEVANCE.some(r => text.includes(r))) continue;
    let best = null, score = 0;
    for (const [typ, heat, w, kws] of RULES) {
      const hits = kws.filter(k => text.includes(k)).length;
      if (hits) { score += w * hits; if (!best || w > best[2]) best = [typ, heat, w]; }
    }
    if (!best || score < 4) continue;
    let [typ, heat] = best;
    let lane = "A";
    if (COLD.some(k => text.includes(k))) {
      lane = ["restaurant", "foodservice", "franchise"].some(k => text.includes(k)) ? "A+B" : "B";
      if (typ === "chain" || (typ === "growth" && lane === "B")) typ = "coldchain";
    }
    let products = PRODUCT_MAP.filter(([, kws]) => kws.some(k => text.includes(k))).map(([p]) => p);
    if (lane === "A") products = products.filter(p => p !== "Cold chain shippers" && p !== "Gel packs");
    scored.push({ score, c, typ, heat, lane, products: products.slice(0, 4).length ? products.slice(0, 4) : ["To-go packaging"] });
  }
  const rank = { Hot: 3, Warm: 2, Watch: 1 };
  scored.sort((a, b) => rank[b.heat] - rank[a.heat] || b.score - a.score);
  const out = [], taken = [];
  for (const s of scored) {
    if (out.length >= MAX_NEW) break;
    if (taken.some(t => sameStory(t, s.c.title)) || existing.some(i => sameStory(i.headline || "", s.c.title))) continue;
    taken.push(s.c.title);
    const pub = localDate(s.c.pub);
    out.push({
      id: `${slug(s.c.title)}-${pub}`, found: today, published: pub, source: s.c.source, url: s.c.url, headline: s.c.title,
      summary: s.c.desc ? (s.c.desc.length > 260 ? s.c.desc.slice(0, 260) + "…" : s.c.desc) : s.c.title,
      signal: SIGNALS[s.typ], heat: s.heat, lane: s.lane, type: s.typ, company: s.c.source, products: s.products,
      nextStep: NEXT[s.typ],
      cover: { kicker: KICKERS[s.typ], stat: coverStat(s.c.title, s.typ), sub: s.c.source.slice(0, 28) },
      opener: (s.heat === "Hot" || s.heat === "Warm") ? (OPENERS[s.typ] || "") : "",
    });
  }
  return out;
}

export async function refresh(feed, now = new Date()) {
  const today = localDate(now);
  let items = (feed.items || []).filter(i => !(GENERIC.has(i.signal) && isNoise(i.headline || "", i.source)));
  const lastRun = feed.updated ? new Date(feed.updated) : new Date(now.getTime() - 3 * 864e5);
  const since = new Date(Math.min(lastRun.getTime(), now.getTime() - 864e5) - 6 * 3600e3);
  const days = Math.min(7, Math.max(1, Math.ceil((now - since) / 864e5)));

  const jobs = INDUSTRY_FEEDS.map(([name, url]) => fetchText(url).then(x => parseRss(x, name)));
  for (const q of GOOGLE_QUERIES) {
    const url = "https://news.google.com/rss/search?" + new URLSearchParams({ q: `${q} when:${days}d`, hl: "en-US", gl: "US", ceid: "US:en" });
    jobs.push(fetchText(url).then(x => parseRss(x, "Google News")));
  }
  const all = (await Promise.all(jobs)).flat();
  const seenUrls = new Set(items.map(i => i.url)), seenTitles = new Set(items.map(i => slug(i.headline || "", 60)));
  const cands = [];
  for (const c of all) {
    if (c.pub < since) continue;
    const t = slug(c.title, 60);
    if (seenUrls.has(c.url) || seenTitles.has(t)) continue;
    seenUrls.add(c.url); seenTitles.add(t);
    cands.push(c);
  }
  cands.sort((a, b) => b.pub - a.pub);
  const fresh = pick(cands, items, today);
  const ids = new Set(items.map(i => i.id));
  for (const n of fresh) { while (ids.has(n.id)) n.id += "-x"; ids.add(n.id); }
  items = [...fresh, ...items];
  const cutoff = localDate(new Date(now.getTime() - KEEP_DAYS * 864e5));
  items = items.filter(i => (i.found || today) >= cutoff);
  return {
    updated: localIso(now),
    window: { from: items.reduce((m, i) => (i.found < m ? i.found : m), today), to: today },
    items,
    _fetched: all.length, _added: fresh.length,
  };
}

async function seedFromSite(req) {
  try {
    const r = await fetch(new URL("/feed.json", req.url), { headers: { "cache-control": "no-cache" } });
    if (r.ok) return await r.json();
  } catch {}
  return { updated: null, items: [] };
}

export default async (req) => {
  const store = getStore("chainznewz");
  let feed = await store.get("feed", { type: "json" }).catch(() => null);
  if (!feed) feed = await seedFromSite(req);
  const force = new URL(req.url).searchParams.get("force") === "1";
  const age = feed.updated ? Date.now() - new Date(feed.updated).getTime() : Infinity;
  if (force || age > STALE_MS) {
    try {
      const next = await refresh(feed);
      const { _fetched, _added, ...clean } = next;
      if (_fetched > 0) { await store.setJSON("feed", clean); feed = clean; }
    } catch (e) { console.error("refresh failed", e); }
  }
  return new Response(JSON.stringify(feed), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/news" };
