// ChainzNewz scheduled refresh (runs on Netlify's own scheduler).
// Every 2 hours on weekdays, 5am to 7pm Eastern, it runs the full news scan
// (all sources, PE watchlist, menu/LTO searches, and Claude scoring if a key
// is set) and saves the result, so the app is current before you open it.
import { getStore } from "@netlify/blobs";
import { loadFeed, refreshAndSave } from "./news.mjs";

export default async () => {
  const store = getStore({ name: "chainznewz", consistency: "strong" });
  const feed = await loadFeed(store, "https://chainznewz.netlify.app");
  try {
    const next = await refreshAndSave(store, feed, { budgetMs: 26000, full: true });
    console.log("scheduled refresh ok", next.updated, next.items.length);
  } catch (e) {
    console.error("scheduled refresh failed", e);
  }
};

// Netlify schedules use UTC. 9:07-23:07 UTC every 2 hours = about 5am-7pm Eastern.
export const config = { schedule: "7 9-23/2 * * 1-5" };
