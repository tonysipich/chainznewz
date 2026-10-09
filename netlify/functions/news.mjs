// ChainzNewz news function (runs on Netlify).
// The app calls /api/news every time it opens or you pull down. It returns the
// saved feed, and if the feed is stale it pulls fresh news first.
// A separate scheduled function (news-scheduled.mjs) also refreshes the feed
// every 2 hours on weekdays, so the app is current even before you open it.
//
// What it looks for: packaging / foodservice / cold chain buying signals,
// private equity deals in food, restaurants and packaging, procurement leader
// changes, chain menu launches and LTOs, and price moves on Tony's products.
// Only stories that give Tony a reason to call make it in, capped per day.
//
// Optional: if an ANTHROPIC_API_KEY environment variable is set in Netlify,
// Claude scores every story 1-10 for "does this help Tony sell" and only 7+
// stories are kept. Without a key, keyword rules do the picking.
import { getStore } from "@netlify/blobs";

const KEEP_DAYS = 30;
const STALE_MS = 2 * 60 * 60 * 1000;      // refresh on open if older than this
const DAILY_CAP = 8;                      // most new stories added per day
const PER_RUN_CAP = 5;                    // most new stories added per refresh
const FETCH_TIMEOUT_MS = 5000;
const CONCURRENCY = 8;
const TZ = "America/Detroit";
const CLAUDE_MODEL = (globalThis.process?.env?.CLAUDE_MODEL) || "claude-haiku-4-5";
const MIN_CLAUDE_SCORE = 7;

// ---------- sources ----------
// Direct feeds. Any feed that's down or blocked is skipped quietly.
const DIRECT_FEEDS = [
  ["Packaging Dive", "https://www.packagingdive.com/feeds/news/"],
  ["Food Dive", "https://www.fooddive.com/feeds/news/"],
  ["Grocery Dive", "https://www.grocerydive.com/feeds/news/"],
  ["Restaurant Dive", "https://www.restaurantdive.com/feeds/news/"],
  ["Supply Chain Dive", "https://www.supplychaindive.com/feeds/news/"],
  ["Chew Boom", "https://www.chewboom.com/feed/"],
  ["The Fast Food Post", "https://www.thefastfoodpost.com/feed/"],
  ["PE Hub", "https://www.pehub.com/feed/"],
  ["PE Professional", "https://peprofessional.com/feed/"],
  ["PR Newswire", "https://www.prnewswire.com/rss/food-beverages-latest-news/food-beverages-latest-news-list.rss"],
];

// Food-focused and active food/restaurant/packaging private equity firms.
// Any story naming one of these gets pushed up the list.
const PE_WATCHLIST = [
  "Roark Capital", "Butterfly Equity", "L Catterton", "Sentinel Capital", "TriArtisan", "Garnett Station",
  "Brentwood Associates", "Wind Point Partners", "Arbor Investments", "Peak Rock Capital", "Swander Pace",
  "CenterOak", "Kainos Capital", "Highlander Partners", "Gryphon Investors", "Trivest", "KarpReilly",
  "Princeton Equity", "Savory Fund", "Act III Holdings", "Sun Capital", "Golden Gate Capital",
  "Olympus Partners", "Freeman Spogli", "Levine Leichtman", "Kohlberg", "Pritzker Private Capital",
  "Arsenal Capital", "Lindsay Goldberg", "Clearlake", "Sycamore Partners", "Fortress Investment",
  "Blackstone", "Apollo", "KKR", "Bain Capital", "TPG", "Carlyle", "Advent International", "Ares Management",
];

const CORE_QUERIES = [
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
const PE_QUERIES = [
  '"private equity" acquires restaurant OR franchisor OR "restaurant brand"',
  '"private equity" acquires food OR snacks OR bakery OR "food manufacturer"',
  '"private equity" acquires packaging OR "foodservice packaging" OR containers',
  '"portfolio company" acquires restaurant OR food OR bakery OR snacks OR packaging',
  '"add-on acquisition" food OR restaurant OR packaging',
  'franchisee group acquires restaurants OR units "private equity" OR "backed by"',
  '"chief procurement officer" OR "chief supply chain officer" OR "vice president of procurement" restaurant OR food appoints OR names',
  'site:businesswire.com acquires OR acquisition food OR restaurant OR packaging',
  'site:prnewswire.com acquires OR acquisition food OR restaurant OR packaging',
  'site:pehub.com food OR restaurant OR packaging',
  'site:peprofessional.com food OR restaurant OR packaging',
];
const MENU_QUERIES = [
  'site:chewboom.com new OR launches OR "limited time"',
  'site:thefastfoodpost.com new OR "limited time"',
  'restaurant chain "limited-time" OR "limited time" new menu launches',
  'restaurant chain "new packaging" OR "packaging redesign" OR rebrand',
  'restaurant chain launches catering OR "family bundle" OR "delivery-only" OR "grab-and-go"',
  'restaurant chain "value menu" OR "value meal" OR "price cuts" launch',
  'site:qsrmagazine.com OR site:restaurantbusinessonline.com OR site:nrn.com menu launch OR new item',
  '"snack size" OR "single-serve" OR "grab-and-go" food launch packaging',
];
const PACK_QUERIES = [
  'site:packworld.com OR site:packagingstrategies.com OR site:plasticsnews.com foodservice OR "food packaging"',
  'polypropylene OR polystyrene OR "PET resin" prices packaging',
];
function watchlistQueries() {
  const out = [];
  for (let i = 0; i < PE_WATCHLIST.length; i += 7) {
    const names = PE_WATCHLIST.slice(i, i + 7).map(n => `"${n}"`).join(" OR ");
    out.push(`(${names}) acquires OR acquisition OR invests OR "portfolio" restaurant OR food OR packaging`);
  }
  return out;
}

// ---------- keyword rules (used without a Claude key, and to pre-sort for Claude) ----------
// [signal key, card type, heat, weight, keywords]
const RULES = [
  ["buyer", "buyer", "Hot", 6, ["looking for a supplier", "seeking suppliers", "rfp", "request for proposal", "shortage"]],
  ["exec", "buyer", "Hot", 6, ["chief procurement officer", "chief supply chain officer", "vice president of procurement", "vp of procurement",
    "head of procurement", "vice president of supply chain", "vp of supply chain", "head of supply chain", "director of purchasing"]],
  ["pe_pack", "mna", "Hot", 6, []],   // filled in by logic: PE deal involving a packaging supplier
  ["pe", "mna", "Warm", 5, ["private equity", "portfolio company", "add-on acquisition", "platform acquisition", "backed by",
    "equity partners", "capital partners", "acquired by", "to acquire", "acquires", "acquisition", "buyout"]],
  ["growth", "growth", "Warm", 4, ["new plant", "new facility", "opens new", "to open", "expansion", "expands", "invests", "investment",
    "production line", "new line", "new jobs", "development agreement", "unit deal", "unit agreement",
    "co-packer", "co-manufactur", "commissary", "ghost kitchen", "raises $", "funding round", "breaks ground"]],
  ["menu", "growth", "Warm", 4, ["limited-time", "limited time", " lto", "new menu", "menu launch", "launches new", "debuts", "rolls out",
    "catering", "family bundle", "delivery-only", "grab-and-go", "new packaging", "packaging redesign", "rebrand", "new item", "new flavor"]],
  ["cost", "pricing", "Warm", 4, ["value menu", "value meal", "price cuts", "cost cutting", "cost savings", "margin pressure"]],
  ["pricing", "pricing", "Warm", 4, ["price increase", "price hike", "prices rise", "raising prices", "surcharge", "tariff", "duties", "anti-dumping"]],
  ["regulation", "regulation", "Watch", 2, ["pfas", "ban", "epr", "extended producer", "regulation", "law", "bill"]],
  ["chain", "chain", "Watch", 1, ["mcdonald", "burger king", "wendy", "kfc", "taco bell", "chick-fil-a", "starbucks", "subway", "domino"]],
];
const RELEVANCE = ["packaging", "tray", "film", "sealer", "sealing", "glove", "liner", "straw", "container", "to-go", "takeout",
  "foodservice", "restaurant", "franchise", "meal", "food plant", "food processing", "co-pack", "commissary",
  "cold chain", "insulated", "gel pack", "perishable", "pharmacy", "corrugated", "containerboard", "resin",
  "frozen", "prepared food", "grocery", "qsr", "fast casual", "fast food", "catering", "kitchen", "menu", "bakery",
  "snack", "food company", "food brand", "food manufacturer", "beverage", "coffee", "pizza", "chicken", "burger"];
const PACK_SUPPLIER = ["packaging", "containers", "foodservice disposables", "cups", "film", "converter", "corrugated", "molded fiber"];
const COLD = ["cold chain", "insulated", "gel pack", "perishable", "pharma", "pharmacy", "refrigerated", "temperature-controlled",
  "direct-to-patient", "biologic", "glp-1", "vaccine", "frozen shipping"];
const PRODUCT_MAP = [
  ["Meal trays", ["meal", "tray", "prepared", "ready-to-eat", "frozen entree", "entree", "bowl"]],
  ["Sealing film", ["film", "lidding", "seal"]],
  ["Tray sealers", ["sealer", "sealing machine", "automation", "line"]],
  ["To-go packaging", ["to-go", "takeout", "take-out", "container", "restaurant", "franchise", "units", "delivery", "catering", "menu", "bundle", "packaging"]],
  ["Gloves", ["glove", "restaurant", "plant", "kitchen", "franchise", "food processing"]],
  ["Can liners", ["liner", "trash", "restaurant", "franchise", "units"]],
  ["Straws", ["straw", "beverage", "smoothie", "coffee", "drink", "shake", "tea"]],
  ["Boxes", ["box", "corrugated", "containerboard", "case", "pizza"]],
  ["Cold chain shippers", ["cold chain", "insulated", "shipper", "perishable", "pharmacy"]],
  ["Gel packs", ["gel pack", "cold chain", "refrigerant", "perishable"]],
];
const NOISE = ["recipe", "horoscope", "stock price", "shares of", "earnings call", "obituary", "review:", "market size", "market report",
  "feasibility", "setup cost", "cost report", "forecast", "cagr", "franchise costs", "franchise cost", "fees, profit",
  "bankrupt", "chapter 11", "layoff", "closing", "closes", "shutter", "perception", "hidden liability",
  "why multi-unit", "why multi-brand", "top 10", "best ", "how to ", "webinar", "sponsored", "india", "indian", " uk ",
  "australia", "canada's", "europe", "pakistan", "italy", "italian", "germany", "france", "spain", "mexico", "brazil",
  "china", "chinese", "japan", "philippines", "saudi", "dubai", "uae", "nigeria", "kenya", "south africa", "south asia",
  "new zealand", "ireland", "scotland", "britain", "british", "€", "£", "₹", "pet food", "petfood", "explained",
  "what to know", "opinion", "podcast", "a conversation with", "interview", "gym", "fitness", "salon", "hotel",
  "real estate", "reit", "apartment", "software", "fintech", "biotech", "oil and gas", "taste test", "ranked", "we tried"];
const BLOCKED_SOURCES = ["retail news asia", "hoodline", "petfoodindustry", "openpr", "quiver", "insider media", "indian printer",
  "packaging south asia", "1851 franchise", "ein presswire", "einpresswire", "marketsandmarkets", "yahoo finance", "benzinga",
  "zacks", "seeking alpha", "motley fool", "marketbeat", "globenewswire", "news.google"];

const KICKERS = { buyer: "Buyer need", exec: "New buyer", pe_pack: "Supplier bought", pe: "PE deal", growth: "Growth signal",
  menu: "Menu launch", cost: "Cost pressure", pricing: "Price move", regulation: "Regulation", chain: "Chain news", coldchain: "Cold chain" };
const SIGNALS = {
  buyer: "A direct need is showing. Reach out while they're still choosing.",
  exec: "New procurement and supply chain leaders usually re-bid suppliers in their first months.",
  pe_pack: "A packaging supplier just changed owners. Its customers may face price or SKU changes and want a backup source.",
  pe: "New PE owners push cost savings and often consolidate packaging buying across their brands.",
  growth: "More volume means new buys on packaging and supplies, and vendors often get set up fresh.",
  menu: "New menu items and formats often need new containers, cups or bags fast.",
  cost: "A chain cutting prices needs cheaper packaging to protect margin. That's a price pitch.",
  pricing: "Buyers are about to feel higher costs. It's a good reason to offer a price check.",
  regulation: "Rules like this push buyers to re-check what they're using.",
  chain: "Background on a big chain. Most consumables run through national contracts.",
  coldchain: "More temperature-sensitive shipping means more liners, gel packs and shipper boxes.",
};
const GENERIC = new Set([...Object.values(SIGNALS),
  "Ownership changes often bring price and SKU changes. Buyers may want a second source."]);
const NEXT = {
  buyer: "Reach out today while they're still picking a supplier.",
  exec: "Connect with the new leader in their first 90 days and offer a packaging cost review.",
  pe_pack: "Pitch a second-source quote to accounts that buy from this supplier.",
  pe: "Find the PE firm's operating partner or portfolio procurement lead. Pitch consolidating packaging across its brands.",
  growth: "Find the purchasing or operations lead and ask what they're buying for the new volume.",
  menu: "Reach the brand's packaging or purchasing lead about containers for the new item.",
  cost: "Offer a side-by-side on their current to-go packaging and gloves to cut cost.",
  pricing: "Call buyers of these items and offer to check what they're paying.",
  regulation: "Watch only. Use it as a talking point with buyers.",
  chain: "Watch only. Look for franchisee groups in your region.",
  coldchain: "Find the shipping or packaging lead and offer liners, gel packs and shippers.",
};
const OPENERS = {
  buyer: "Hi [Name],\nI saw you're looking for a supplier. I can get you pricing quickly. Can you and I discuss?\nTony",
  exec: "Hi [Name],\nCongrats on the new role. When someone new takes over buying, it's a good time to look at packaging spend with fresh eyes. I'd like to run a quick side-by-side for you. Can you and I discuss?\nTony",
  pe_pack: "Hi [Name],\nWith your packaging supplier changing owners, pricing and SKUs could shift. I can quote you a backup so you're covered either way. Can you and I discuss?\nTony",
  pe: "Hi [Name],\nCongrats on the deal. When a group brings brands together, packaging buying is usually spread across a bunch of suppliers. Consolidating it is where there's real money left on the table. Can you and I discuss?\nTony",
  growth: "Hi [Name],\nCongrats on the growth. When volume ramps up, packaging and supplies are usually where it gets tight. I'd like to quote you a backup source. Can you and I discuss?\nTony",
  menu: "Hi [Name],\nI saw the new menu launch. New items usually mean new containers, and that's where I can help on cost and lead time. Can you and I discuss?\nTony",
  cost: "Hi [Name],\nWith prices coming down on the menu, packaging is one of the easiest places to win back margin. I'd like to show you a side-by-side. Can you and I discuss?\nTony",
  pricing: "Hi [Name],\nPrices are moving on packaging again. Before your next order, let me check what you're paying. Can you and I discuss?\nTony",
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
  for (const m of (xml || "").matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    let title = clean(tag(b, "title"));
    const link = clean(tag(b, "link"));
    const source = clean(tag(b, "source")) || defaultSource;
    const desc = clean(tag(b, "description"));
    const pub = new Date(clean(tag(b, "pubDate")) || clean(tag(b, "dc:date")));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(" - " + source).length).trim();
    if (title && link && !isNaN(pub)) out.push({ title, url: link, pub, source, desc });
  }
  return out;
}
async function fetchText(url, deadline) {
  const left = deadline - Date.now();
  if (left < 800) return "";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.min(FETCH_TIMEOUT_MS, left - 300));
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (ChainzNewz; +https://chainznewz.netlify.app)" } });
    return r.ok ? await r.text() : "";
  } catch { return ""; } finally { clearTimeout(t); }
}
async function pool(tasks, n) {
  const out = []; let i = 0;
  async function worker() { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
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
function watchHit(text) {
  const t = text.toLowerCase();
  return PE_WATCHLIST.find(n => t.includes(n.toLowerCase())) || "";
}
function coverStat(title, key) {
  const m = title.match(STAT_RE);
  if (m) return m[1].replace(/\s*million/i, "M").replace(/\s*billion/i, "B").replace(/\s/g, "").slice(0, 11);
  return { buyer: "Need", exec: "New buyer", pe_pack: "PE buyout", pe: "PE deal", growth: "Growing", menu: "New item",
    cost: "Price cuts", pricing: "Price move", regulation: "New rule", chain: "Chain news", coldchain: "Cold chain" }[key] || "News";
}

// Scores every candidate with keyword rules. Returns sorted list.
function score(cands) {
  const scored = [];
  for (const c of cands) {
    const raw = c.title + " " + c.desc, text = raw.toLowerCase();
    if (isNoise(raw, c.source)) continue;
    if (!RELEVANCE.some(r => text.includes(r))) continue;
    const firm = watchHit(raw);
    let best = null, pts = firm ? 4 : 0;
    for (const [key, typ, heat, w, kws] of RULES) {
      const hits = kws.filter(k => text.includes(k)).length;
      if (hits) { pts += w * hits; if (!best || w > best.w) best = { key, typ, heat, w }; }
    }
    if (!best) continue;
    let { key, typ, heat } = best;
    if (key === "pe" && PACK_SUPPLIER.some(k => text.includes(k)) && !text.includes("restaurant")) { key = "pe_pack"; heat = "Hot"; }
    if (key === "pe" && !firm && !/private equity|portfolio|backed by|capital|partners|equity/.test(text)) { key = "growth"; typ = "growth"; }
    if (key === "menu" && !/bowl|wing|sandwich|drink|beverage|bundle|catering|packag|box|cup|tray|snack|shake|dessert|pizza/.test(text)) heat = "Watch";
    if (pts < 4) continue;
    let lane = "A";
    if (COLD.some(k => text.includes(k))) {
      lane = ["restaurant", "foodservice", "franchise"].some(k => text.includes(k)) ? "A+B" : "B";
      if (typ === "chain" || (typ === "growth" && lane === "B")) { typ = "coldchain"; key = "coldchain"; }
    }
    let products = PRODUCT_MAP.filter(([, kws]) => kws.some(k => text.includes(k))).map(([p]) => p);
    if (lane === "A") products = products.filter(p => p !== "Cold chain shippers" && p !== "Gel packs");
    scored.push({ pts, c, key, typ, heat, lane, firm, products: products.length ? products.slice(0, 4) : ["To-go packaging"] });
  }
  const rank = { Hot: 3, Warm: 2, Watch: 1 };
  scored.sort((a, b) => rank[b.heat] - rank[a.heat] || b.pts - a.pts);
  return scored;
}

function toItem(s, today) {
  const pub = localDate(s.c.pub);
  return {
    id: `${slug(s.c.title)}-${pub}`, found: today, published: pub, source: s.c.source, url: s.c.url, headline: s.c.title,
    summary: s.c.desc ? (s.c.desc.length > 260 ? s.c.desc.slice(0, 260) + "…" : s.c.desc) : s.c.title,
    signal: SIGNALS[s.key] + (s.firm ? ` ${s.firm} is on your PE watchlist.` : ""),
    heat: s.heat, lane: s.lane, type: s.typ, company: s.firm || s.c.source, products: s.products,
    nextStep: NEXT[s.key],
    cover: { kicker: KICKERS[s.key], stat: coverStat(s.c.title, s.key), sub: (s.firm || s.c.source).slice(0, 28) },
    opener: (s.heat === "Hot" || s.heat === "Warm") ? (OPENERS[s.key] || "") : "",
  };
}

// ---------- optional Claude scoring ----------
const CLAUDE_PROMPT = `You screen news for Tony, who owns SupplyChainz, a packaging broker. He sells:
Lane A (foodservice / food manufacturing): meal trays, custom and stock to-go packaging, vinyl gloves, can liners, straws, tray sealing film, tray sealing machinery.
Lane B (cold chain): insulated shipping liners, gel packs, tape, cold chain shipper boxes for food and pharma.
His best leads: private equity firms buying food, restaurant or packaging companies (he pitches consolidating packaging buying across the PE firm's brands, or a second source when a packaging supplier changes owners); new procurement or supply chain leaders; chains launching menu items, LTOs, catering, bundles or new packaging that need new containers; chain value/cost programs (cheaper packaging pitch); plant openings, co-packers, meal prep and franchise development deals; price moves and tariffs on his products; cold chain and pharmacy shipping launches.
Score each numbered story 1-10 for "does this give Tony a specific company to call this month to sell more product". 7+ means yes. Score 1-3 for general industry chatter, consumer reviews, stock news, opinion, foreign stories, closings and bankruptcies.
Return ONLY a JSON array, one object per story scoring 7 or higher:
{"n": <number>, "score": <1-10>, "heat": "Hot|Warm|Watch", "lane": "A|B|A+B", "type": "growth|pricing|mna|chain|buyer|coldchain|regulation", "company": "<company or PE firm>", "summary": "<1-2 factual sentences from the story only>", "signal": "<1-2 sentences: why this helps Tony sell>", "nextStep": "<one action naming who to contact>", "products": ["<Tony's products that fit>"], "kicker": "<2-3 words>", "stat": "<short number or phrase, max 11 chars>", "opener": "<Hot/Warm only: Tony's plain voice, starts 'Hi [Name],', short sentences with contractions, no marketing tone, ends 'Can you and I discuss?' then a new line 'Tony'. Use \\n for line breaks. Empty string for Watch.>"}
Use only facts in the story text. Never invent names or numbers.
Stories:
`;

async function claudePick(scored, key, today, deadline) {
  const list = scored.slice(0, 40);
  if (!list.length) return [];
  const lines = list.map((s, i) => `${i}. [${s.c.source}, ${localDate(s.c.pub)}${s.firm ? `, PE watchlist: ${s.firm}` : ""}] ${s.c.title} — ${s.c.desc.slice(0, 280)}`);
  const left = deadline - Date.now();
  if (left < 6000) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), left - 1500);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 4000, messages: [{ role: "user", content: CLAUDE_PROMPT + lines.join("\n") }] }),
    });
    if (!r.ok) { console.error("claude", r.status, await r.text()); return null; }
    const data = await r.json();
    const text = (data.content || []).map(b => b.text || "").join("");
    const m = text.match(/\[[\s\S]*\]/);
    const picks = m ? JSON.parse(m[0]) : [];
    const out = [];
    for (const p of picks.sort((a, b) => (b.score || 0) - (a.score || 0))) {
      const s = list[+p.n];
      if (!s || (p.score || 0) < MIN_CLAUDE_SCORE || !["Hot", "Warm", "Watch"].includes(p.heat)) continue;
      const base = toItem(s, today);
      out.push({
        ...base,
        heat: p.heat, lane: p.lane || base.lane, type: p.type || base.type, company: p.company || base.company,
        summary: p.summary || base.summary, signal: p.signal || base.signal, nextStep: p.nextStep || base.nextStep,
        products: Array.isArray(p.products) && p.products.length ? p.products.slice(0, 4) : base.products,
        cover: { kicker: p.kicker || base.cover.kicker, stat: (p.stat || base.cover.stat).slice(0, 11), sub: (p.company || base.cover.sub).slice(0, 28) },
        opener: p.heat === "Watch" ? "" : (p.opener || base.opener),
        score: p.score,
      });
    }
    return out;
  } catch (e) { console.error("claude failed", e?.message); return null; } finally { clearTimeout(t); }
}

// ---------- refresh ----------
export async function refresh(feed, { now = new Date(), budgetMs = 8500, full = true } = {}) {
  const started = Date.now(), deadline = started + budgetMs;
  const today = localDate(now);
  let items = (feed.items || []).filter(i => !(GENERIC.has(i.signal) && isNoise(i.headline || "", i.source)));
  const lastRun = feed.updated ? new Date(feed.updated) : new Date(now.getTime() - 3 * 864e5);
  const since = new Date(Math.min(lastRun.getTime(), now.getTime() - 864e5) - 6 * 3600e3);
  const days = Math.min(7, Math.max(1, Math.ceil((now - since) / 864e5)));

  const queries = full ? [...PE_QUERIES, ...watchlistQueries(), ...MENU_QUERIES, ...CORE_QUERIES, ...PACK_QUERIES]
                       : [...PE_QUERIES.slice(0, 5), ...MENU_QUERIES.slice(2, 6), ...CORE_QUERIES];
  const tasks = DIRECT_FEEDS.map(([name, url]) => () => fetchText(url, deadline).then(x => parseRss(x, name)));
  for (const q of queries) {
    const url = "https://news.google.com/rss/search?" + new URLSearchParams({ q: `${q} when:${days}d`, hl: "en-US", gl: "US", ceid: "US:en" });
    tasks.push(() => fetchText(url, deadline).then(x => parseRss(x, "Google News")));
  }
  const fetchDeadline = deadline - (full ? 12000 : 1500);
  const all = (await pool(tasks.map(t => () => Date.now() < fetchDeadline ? t() : Promise.resolve([])), CONCURRENCY)).flat();

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

  const room = Math.max(0, Math.min(PER_RUN_CAP, DAILY_CAP - items.filter(i => i.found === today).length));
  let fresh = [];
  if (room > 0 && cands.length) {
    const scored = score(cands);
    const key = globalThis.process?.env?.ANTHROPIC_API_KEY || (typeof Netlify !== "undefined" ? Netlify.env.get("ANTHROPIC_API_KEY") : "");
    let picked = key && full ? await claudePick(scored, key, today, deadline) : null;
    if (!picked) picked = scored.map(s => toItem(s, today));
    const taken = [];
    for (const it of picked) {
      if (fresh.length >= room) break;
      if (taken.some(t => sameStory(t, it.headline)) || items.some(i => sameStory(i.headline || "", it.headline))) continue;
      taken.push(it.headline);
      fresh.push(it);
    }
  }
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

export async function loadFeed(store, origin) {
  let feed = await store.get("feed", { type: "json", consistency: "strong" }).catch(() => null);
  if (!feed && origin) {
    try {
      const r = await fetch(new URL("/feed.json", origin), { headers: { "cache-control": "no-cache" } });
      if (r.ok) feed = await r.json();
    } catch {}
  }
  return feed || { updated: null, items: [] };
}

export async function refreshAndSave(store, feed, opts) {
  const next = await refresh(feed, opts);
  const { _fetched, _added, ...cleanFeed } = next;
  if (_fetched > 0) { await store.setJSON("feed", cleanFeed); return cleanFeed; }
  return feed;
}

export default async (req) => {
  const store = getStore({ name: "chainznewz", consistency: "strong" });
  let feed = await loadFeed(store, req.url);
  const force = new URL(req.url).searchParams.get("force") === "1";
  const age = feed.updated ? Date.now() - new Date(feed.updated).getTime() : Infinity;
  if (force || age > STALE_MS) {
    try { feed = await refreshAndSave(store, feed, { budgetMs: 8500, full: false }); }
    catch (e) { console.error("refresh failed", e); }
  }
  return new Response(JSON.stringify(feed), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/news" };
