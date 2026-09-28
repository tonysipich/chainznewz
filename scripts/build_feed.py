"""ChainzNewz daily refresh.

Runs on GitHub every weekday morning. Pulls packaging, foodservice and
cold chain news from public news feeds, picks the items that look like
buying signals for SupplyChainz, adds them to feed.json, and drops
anything older than 30 days. Netlify redeploys the site when feed.json
changes.

If an ANTHROPIC_API_KEY secret is set, Claude picks the best items and
writes the summary, "why it matters", next step and opener. Without a
key, simple keyword rules do the same job.
"""
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Detroit")
FEED_PATH = os.path.join(os.path.dirname(__file__), "..", "feed.json")
KEEP_DAYS = 30
MAX_NEW = 10
MODEL = os.environ.get("CHAINZNEWZ_MODEL", "claude-sonnet-4-5")

INDUSTRY_FEEDS = [
    ("Packaging Dive", "https://www.packagingdive.com/feeds/news/"),
    ("Food Dive", "https://www.fooddive.com/feeds/news/"),
    ("Grocery Dive", "https://www.grocerydive.com/feeds/news/"),
    ("Restaurant Dive", "https://www.restaurantdive.com/feeds/news/"),
    ("Supply Chain Dive", "https://www.supplychaindive.com/feeds/news/"),
]

GOOGLE_QUERIES = [
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
]

UA = "Mozilla/5.0 (ChainzNewz daily refresh; +https://chainznewz.netlify.app)"


def now_local():
    return datetime.now(TZ)


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean(text):
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_rss(raw, default_source):
    out = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return out
    for it in root.iter("item"):
        title = clean(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate") or ""
        desc = clean(it.findtext("description"))
        src_el = it.find("source")
        source = clean(src_el.text) if src_el is not None and src_el.text else default_source
        if source and title.endswith(" - " + source):
            title = title[: -len(" - " + source)].strip()
        try:
            dt = parsedate_to_datetime(pub)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:
            dt = None
        if title and link:
            out.append({"title": title, "url": link, "published_dt": dt, "source": source or default_source, "desc": desc})
    return out


def gather(since, lookback_days):
    items = []
    for name, url in INDUSTRY_FEEDS:
        try:
            items += parse_rss(fetch(url), name)
        except Exception as e:
            print(f"skip {name}: {e}", file=sys.stderr)
    for q in GOOGLE_QUERIES:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": f"{q} when:{lookback_days}d", "hl": "en-US", "gl": "US", "ceid": "US:en"})
        try:
            items += parse_rss(fetch(url), "Google News")
        except Exception as e:
            print(f"skip query {q!r}: {e}", file=sys.stderr)
    fresh = [i for i in items if i["published_dt"] and i["published_dt"] >= since]
    print(f"fetched {len(items)} items, {len(fresh)} inside window", file=sys.stderr)
    return fresh


# ---------- keyword scoring (used when no API key, or if the API fails) ----------

RULES = [
    # (type, heat, weight, keywords)
    ("buyer", "Hot", 6, ["looking for a supplier", "seeking suppliers", "rfp", "request for proposal", "shortage"]),
    ("growth", "Warm", 4, ["new plant", "new facility", "opens new", "to open", "expansion", "expands", "invests", "investment",
                           "production line", "new line", "new jobs", "development agreement", "unit deal", "unit agreement",
                           "co-packer", "co-manufactur", "commissary", "ghost kitchen", "raises $", "funding round", "breaks ground"]),
    ("pricing", "Warm", 4, ["price increase", "price hike", "prices rise", "raising prices", "surcharge", "tariff", "duties", "anti-dumping"]),
    ("mna", "Warm", 3, ["acquires", "acquisition", "to acquire", "merger", "buyout", "private equity", "sells to"]),
    ("regulation", "Watch", 2, ["pfas", "ban", "epr", "extended producer", "regulation", "law", "bill"]),
    ("chain", "Watch", 1, ["mcdonald", "burger king", "wendy", "kfc", "taco bell", "chick-fil-a", "starbucks", "subway", "domino"]),
]
RELEVANCE = ["packaging", "tray", "film", "sealer", "sealing", "glove", "liner", "straw", "container", "to-go", "takeout",
             "foodservice", "restaurant", "franchise", "meal", "food plant", "food processing", "co-pack", "commissary",
             "cold chain", "insulated", "gel pack", "perishable", "pharmacy", "corrugated", "containerboard", "resin",
             "frozen", "prepared food", "grocery", "qsr", "fast casual", "catering", "kitchen"]
COLD = ["cold chain", "insulated", "gel pack", "perishable", "pharma", "pharmacy", "refrigerated", "temperature-controlled",
        "direct-to-patient", "biologic", "glp-1", "vaccine", "frozen shipping"]
PRODUCT_MAP = [
    ("Meal trays", ["meal", "tray", "prepared", "ready-to-eat", "frozen entree", "entree"]),
    ("Sealing film", ["film", "lidding", "seal"]),
    ("Tray sealers", ["sealer", "sealing machine", "automation", "line"]),
    ("To-go packaging", ["to-go", "takeout", "take-out", "container", "restaurant", "franchise", "units", "delivery", "catering"]),
    ("Gloves", ["glove", "restaurant", "plant", "kitchen", "franchise", "food processing"]),
    ("Can liners", ["liner", "trash", "restaurant", "franchise", "units"]),
    ("Straws", ["straw", "beverage", "smoothie", "coffee", "drink"]),
    ("Boxes", ["box", "corrugated", "containerboard", "case"]),
    ("Cold chain shippers", ["cold chain", "insulated", "shipper", "perishable", "pharmacy"]),
    ("Gel packs", ["gel pack", "cold chain", "refrigerant", "perishable"]),
]
NOISE = ["recipe", "horoscope", "stock price", "shares of", "earnings call", "obituary", "review:", "market size", "market report",
         "feasibility", "setup cost", "cost report", "forecast", "cagr", "franchise costs", "franchise cost", "fees, profit",
         "bankrupt", "chapter 11", "layoff", "closing", "closes", "shutter", "value menu", "perception", "hidden liability",
         "why multi-unit", "why multi-brand", "top 10", "best ", "how to ", "webinar", "sponsored", "india", "indian", " uk ",
         "australia", "canada's", "europe", "value perception"]
BLOCKED_SOURCES = ["openpr", "quiver", "insider media", "indian printer", "1851 franchise", "ein presswire", "einpresswire",
                   "marketsandmarkets", "yahoo finance", "benzinga", "zacks", "seeking alpha", "motley fool", "marketbeat",
                   "globenewswire", "openpr.com", "news.google"]


def keyword_pick(cands):
    scored = []
    for c in cands:
        text = (c["title"] + " " + c["desc"]).lower()
        if any(n in text for n in NOISE) or any(b in c["source"].lower() for b in BLOCKED_SOURCES):
            continue
        if not any(r in text for r in RELEVANCE):
            continue
        best = None
        score = 0
        for typ, heat, w, kws in RULES:
            hits = sum(1 for k in kws if k in text)
            if hits:
                score += w * hits
                if best is None or w > best[2]:
                    best = (typ, heat, w)
        if not best:
            continue
        typ, heat, _ = best
        if score < 4:
            continue
        if any(k in text for k in COLD):
            lane = "B" if not any(k in text for k in ["restaurant", "foodservice", "franchise"]) else "A+B"
            if typ in ("chain",):
                typ = "coldchain"
            if typ == "growth":
                typ = "coldchain" if lane == "B" else typ
        else:
            lane = "A"
        products = [p for p, kws in PRODUCT_MAP if any(k in text for k in kws)]
        if lane == "A":
            products = [p for p in products if p not in ("Cold chain shippers", "Gel packs")]
        scored.append((score, c, typ, heat, lane, products[:4] or ["To-go packaging"]))
    scored.sort(key=lambda x: (-{"Hot": 3, "Warm": 2, "Watch": 1}[x[3]], -x[0]))
    return scored


STAT_RE = re.compile(r"(\$\s?\d[\d,.]*\s?(?:million|billion|[MBK])\b|\d[\d,]*\s?(?:-unit|units|locations|stores|restaurants|jobs)\b|\d+(?:\.\d+)?%)", re.I)
KICKERS = {"growth": "Growth signal", "pricing": "Price move", "mna": "Deal", "chain": "Chain news",
           "buyer": "Buyer need", "coldchain": "Cold chain", "regulation": "Regulation"}
SIGNALS = {
    "growth": "More volume means new buys on packaging and supplies, and vendors often get set up fresh.",
    "pricing": "Buyers are about to feel higher costs. It's a good reason to offer a price check.",
    "mna": "Ownership changes often bring price and SKU changes. Buyers may want a second source.",
    "chain": "Background on a big chain. Most consumables run through national contracts.",
    "buyer": "A direct need is showing. Reach out while they're still choosing.",
    "coldchain": "More temperature-sensitive shipping means more liners, gel packs and shipper boxes.",
    "regulation": "Rules like this push buyers to re-check what they're using.",
}
NEXT = {
    "growth": "Find the purchasing or operations lead and ask what they're buying for the new volume.",
    "pricing": "Call buyers of these items and offer to check what they're paying.",
    "mna": "Pitch a second-source quote to accounts that buy from this supplier.",
    "chain": "Watch only. Look for franchisee groups in your region.",
    "buyer": "Reach out today while they're still picking a supplier.",
    "coldchain": "Find the shipping or packaging lead and offer liners, gel packs and shippers.",
    "regulation": "Watch only. Use it as a talking point with buyers.",
}
OPENERS = {
    "growth": "Hi [Name],\nCongrats on the growth. When volume ramps up, packaging and supplies are usually where it gets tight. I'd like to quote you a backup source. Can you and I discuss?\nTony",
    "pricing": "Hi [Name],\nPrices are moving on packaging again. Before your next order, let me check what you're paying. Can you and I discuss?\nTony",
    "mna": "Hi [Name],\nWith the ownership change at your supplier, pricing and SKUs could shift. I can quote you a backup so you're covered either way. Can you and I discuss?\nTony",
    "buyer": "Hi [Name],\nI saw you're looking for a supplier. I can get you pricing quickly. Can you and I discuss?\nTony",
    "coldchain": "Hi [Name],\nI saw you're growing your cold shipping. I supply liners, gel packs and shipper boxes and can get you a side-by-side quick. Can you and I discuss?\nTony",
}


def slug(s, n=48):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:n].rstrip("-")


def cover_stat(title, typ):
    m = STAT_RE.search(title)
    if m:
        v = m.group(1)
        v = re.sub(r"\s*million", "M", v, flags=re.I)
        v = re.sub(r"\s*billion", "B", v, flags=re.I)
        return v.replace(" ", " ")[:11]
    return {"growth": "Growing", "pricing": "Price move", "mna": "New owner", "chain": "Chain news",
            "buyer": "Need", "coldchain": "Cold chain", "regulation": "New rule"}[typ]


def keyword_items(cands, today):
    out = []
    for score, c, typ, heat, lane, products in keyword_pick(cands)[:6]:
        pub = c["published_dt"].astimezone(TZ).date().isoformat()
        out.append({
            "id": f"{slug(c['title'])}-{pub}", "found": today, "published": pub,
            "source": c["source"], "url": c["url"], "headline": c["title"],
            "summary": (c["desc"][:260] + "…") if len(c["desc"]) > 260 else (c["desc"] or c["title"]),
            "signal": SIGNALS[typ], "heat": heat, "lane": lane, "type": typ,
            "company": c["source"], "products": products, "nextStep": NEXT[typ],
            "cover": {"kicker": KICKERS[typ], "stat": cover_stat(c["title"], typ), "sub": c["source"][:28]},
            "opener": OPENERS.get(typ, "") if heat in ("Hot", "Warm") else "",
        })
    return out


# ---------- Claude (optional, better writing and picking) ----------

PROMPT = """You pick daily sales leads for Tony, who owns SupplyChainz, a packaging broker.
Lane A (foodservice / food manufacturing): meal trays, custom and stock to-go packaging, vinyl gloves, can liners, straws, tray sealing film, tray sealing machinery.
Lane B (cold chain): insulated shipping liners, gel packs, tape, cold chain shipper boxes for food and pharma.
Coverage is nationwide.

From the numbered news items below, choose the 3 to 10 best buying signals: price complaints, supplier trouble, "looking for a supplier", packaging changes (PFAS, compostable rules, new private-label meals), growth (new plants, lines, commissaries, meal-prep launches, funding, franchise development deals), tray sealer needs, cold chain shipping launches or problems, and market events Tony can use as a reason to call (supplier M&A, resin/film/corrugated/glove price moves, tariffs, distributor consolidation). Skip competitors promoting themselves, stock-market chatter, recipes and anything not useful for selling. Use only facts in the item text. Never invent people, numbers or quotes.

Return ONLY a JSON array. Each element:
{"n": <item number>, "headline": "<plain headline>", "company": "<company or market>", "summary": "<1-2 plain factual sentences>", "signal": "<1-2 sentences: why this matters for Tony's sales>", "heat": "Hot|Warm|Watch", "lane": "A|B|A+B", "type": "growth|pricing|mna|chain|buyer|coldchain|regulation", "products": ["<Tony's products that fit>"], "nextStep": "<one concrete action, name the role or company to contact>", "cover": {"kicker": "<2-3 words>", "stat": "<short number or phrase, max 11 characters>", "sub": "<short context>"}, "opener": "<Hot/Warm only, else empty string: Tony's plain voice, start 'Hi [Name],' then short sentences with contractions, no marketing tone, end with 'Can you and I discuss?' then a new line 'Tony'. Use \\n for line breaks.>"}
Hot = direct need now or a company scaling production that needs these products within about 90 days. Warm = strong reason to call. Watch = background.

Items:
"""


def claude_items(cands, today, key):
    cands = cands[:60]
    lines = []
    for i, c in enumerate(cands):
        lines.append(f"{i}. [{c['source']}, {c['published_dt'].astimezone(TZ).date()}] {c['title']} — {c['desc'][:300]}")
    body = json.dumps({"model": MODEL, "max_tokens": 6000,
                       "messages": [{"role": "user", "content": PROMPT + "\n".join(lines)}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        resp = json.loads(r.read())
    text = "".join(b.get("text", "") for b in resp.get("content", []))
    m = re.search(r"\[.*\]", text, re.S)
    picks = json.loads(m.group(0)) if m else []
    out = []
    for p in picks[:MAX_NEW]:
        try:
            c = cands[int(p["n"])]
        except Exception:
            continue
        pub = c["published_dt"].astimezone(TZ).date().isoformat()
        item = {k: p.get(k) for k in ("headline", "company", "summary", "signal", "heat", "lane", "type",
                                      "products", "nextStep", "cover", "opener")}
        if item["heat"] not in ("Hot", "Warm", "Watch") or not item["headline"]:
            continue
        item.update({"id": f"{slug(item['headline'])}-{pub}", "found": today, "published": pub,
                     "source": c["source"], "url": c["url"]})
        item["opener"] = item.get("opener") or ""
        out.append(item)
    return out


def main():
    now = now_local()
    today = now.date().isoformat()
    lookback = 4 if now.weekday() == 0 else 2          # Monday covers the weekend
    since = now - timedelta(days=lookback)

    with open(FEED_PATH, encoding="utf-8") as f:
        feed = json.load(f)
    items = feed.get("items", [])
    # clear out weak keyword picks from earlier runs that today's filters would reject
    generic = set(SIGNALS.values())
    def weak(i):
        if i.get("signal") not in generic:
            return False
        t = (i.get("headline", "") + " ").lower()
        return any(n in t for n in NOISE) or any(b in i.get("source", "").lower() for b in BLOCKED_SOURCES)
    dropped = [i for i in items if weak(i)]
    items = [i for i in items if not weak(i)]
    if dropped:
        print(f"removed {len(dropped)} weak earlier picks", file=sys.stderr)
    seen_urls = {i["url"] for i in items}
    seen_titles = {slug(i.get("headline", ""), 60) for i in items}

    cands, cand_titles = [], set()
    for c in gather(since, lookback):
        t = slug(c["title"], 60)
        if c["url"] in seen_urls or t in seen_titles or t in cand_titles:
            continue
        cand_titles.add(t)
        cands.append(c)
    cands.sort(key=lambda c: c["published_dt"], reverse=True)

    new = []
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key and cands:
        try:
            new = claude_items(cands, today, key)
            print(f"Claude picked {len(new)} items", file=sys.stderr)
        except Exception as e:
            print(f"Claude step failed, using keyword rules: {e}", file=sys.stderr)
    if not new and cands:
        new = keyword_items(cands, today)
        print(f"keyword rules picked {len(new)} items", file=sys.stderr)

    ids = {i["id"] for i in items}
    for n in new:
        while n["id"] in ids:
            n["id"] += "-x"
        ids.add(n["id"])
    items = new + items

    cutoff = (now.date() - timedelta(days=KEEP_DAYS)).isoformat()
    before = len(items)
    items = [i for i in items if i.get("found", today) >= cutoff]
    feed["items"] = items
    feed["updated"] = now.replace(microsecond=0).isoformat()
    feed["window"] = {"from": min((i["found"] for i in items), default=today), "to": today}
    feed.pop("notes", None)

    with open(FEED_PATH, "w", encoding="utf-8") as f:
        json.dump(feed, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"added {len(new)}, pruned {before - len(items)}, total {len(items)}")


if __name__ == "__main__":
    main()
