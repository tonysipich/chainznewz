// ChainzNewz shared marks (Starred, Contacted, Not relevant).
// Saved on Netlify so every device and browser sees the same lists.
//   GET  /api/marks                      -> { starred:[], contacted:[], hidden:[], updated }
//   POST /api/marks {set, id, on}        -> turn one mark on or off
//   POST /api/marks {merge:{starred,...}} -> add a device's older marks (one time)
import { getStore } from "@netlify/blobs";

const SETS = ["starred", "contacted", "hidden"];
const MAX_PER_SET = 2000;

function blank() { return { starred: [], contacted: [], hidden: [], updated: null }; }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function cleanId(id) { return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null; }

export default async (req) => {
  const store = getStore({ name: "chainznewz", consistency: "strong" });
  let marks = (await store.get("marks", { type: "json", consistency: "strong" }).catch(() => null)) || blank();
  for (const s of SETS) if (!Array.isArray(marks[s])) marks[s] = [];

  if (req.method === "GET") return json(marks);
  if (req.method !== "POST") return json({ error: "Use GET or POST" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  if (body && body.merge && typeof body.merge === "object") {
    for (const s of SETS) {
      const add = Array.isArray(body.merge[s]) ? body.merge[s].map(cleanId).filter(Boolean) : [];
      marks[s] = [...new Set([...marks[s], ...add])].slice(-MAX_PER_SET);
    }
  } else if (body && SETS.includes(body.set) && cleanId(body.id)) {
    const id = cleanId(body.id);
    const list = new Set(marks[body.set]);
    if (body.on) list.add(id); else list.delete(id);
    marks[body.set] = [...list].slice(-MAX_PER_SET);
  } else {
    return json({ error: "Bad request" }, 400);
  }
  marks.updated = new Date().toISOString();
  await store.setJSON("marks", marks);
  return json(marks);
};

export const config = { path: "/api/marks" };
