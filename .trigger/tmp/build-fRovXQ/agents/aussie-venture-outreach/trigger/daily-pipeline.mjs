import {
  emailBodyToHtml,
  runFollowUpAgent
} from "../../../chunk-O3DEJT6L.mjs";
import {
  createServiceClient,
  getAnalyticsDayRange,
  logger,
  sendEmail,
  withRetry
} from "../../../chunk-4PKXMH3C.mjs";
import {
  schedules_exports
} from "../../../chunk-YMG6YHR2.mjs";
import "../../../chunk-KOWVEGTZ.mjs";
import {
  __name,
  init_esm
} from "../../../chunk-ZETKKQG6.mjs";

// trigger/daily-pipeline.ts
init_esm();

// agents/finder.ts
init_esm();

// src/lib/searchBusinesses.ts
init_esm();

// src/lib/outscraper.ts
init_esm();
var MAX_POLL_ATTEMPTS = 20;
var outscraperCallCount = 0;
var outscraperCallWindowStart = Date.now();
var OUTSCRAPER_RATE_LIMIT = 10;
function normalizePhone(p) {
  return p?.replace(/\D/g, "");
}
__name(normalizePhone, "normalizePhone");
function dedupeResults(results) {
  const seen = /* @__PURE__ */ new Set();
  return results.filter((r) => {
    const key = normalizePhone(r.phone) || `${r.name?.toLowerCase()}-${r.address?.toLowerCase()}`;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
__name(dedupeResults, "dedupeResults");
async function rateLimitedFetch(url, headers) {
  const now = Date.now();
  if (now - outscraperCallWindowStart > 6e4) {
    outscraperCallCount = 0;
    outscraperCallWindowStart = now;
  }
  if (outscraperCallCount >= OUTSCRAPER_RATE_LIMIT) {
    const wait = 6e4 - (now - outscraperCallWindowStart);
    await new Promise((r) => setTimeout(r, wait));
    outscraperCallCount = 0;
    outscraperCallWindowStart = Date.now();
  }
  outscraperCallCount++;
  return withRetry(() => fetch(url, { headers }), { maxAttempts: 3, baseDelayMs: 2e3 });
}
__name(rateLimitedFetch, "rateLimitedFetch");
async function pollResults(resultsUrl, headers) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const wait = attempt < 3 ? 2e3 : 4e3;
    await new Promise((r) => setTimeout(r, wait));
    const res = await rateLimitedFetch(resultsUrl, headers);
    if (!res.ok) throw new Error(`Outscraper poll error: ${res.status}`);
    const job = await res.json();
    console.log(`Outscraper poll ${attempt}/${MAX_POLL_ATTEMPTS}: status=${job.status}`);
    if (job.status !== "Pending") {
      return job.data?.flat() ?? [];
    }
  }
  console.warn("Outscraper: max poll attempts reached, giving up");
  return [];
}
__name(pollResults, "pollResults");
var ENDPOINT = "maps/search-v3";
async function searchBusinesses(query, limit = 20, skip = 0) {
  const cleanKey = (process.env.OUTSCRAPER_API_KEY ?? "").replace(/[^\x20-\x7E]/g, "").trim();
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    language: "en",
    region: "AU"
  });
  if (skip > 0) params.set("skip", String(skip));
  const url = `https://api.app.outscraper.com/${ENDPOINT}?${params}`;
  const headers = {
    "X-API-KEY": cleanKey
  };
  console.log(`Outscraper [${ENDPOINT}] search: "${query}"`);
  try {
    const response = await rateLimitedFetch(url, headers);
    if (!response.ok) {
      throw new Error(`Outscraper API error: ${response.status}`);
    }
    const job = await response.json();
    console.log(`Outscraper job queued: id=${job.id} status=${job.status}`);
    let results = [];
    if (job.status !== "Pending" && job.data) {
      results = job.data.flat();
    } else if (job.results_location) {
      const pollUrl = job.results_location.replace(
        /https?:\/\/[^/]*datapipelineplatform\.cloud/,
        "https://api.app.outscraper.com"
      );
      results = await pollResults(pollUrl, headers);
    } else {
      console.warn("Outscraper: no results_location in response");
      return [];
    }
    const uniqueResults = dedupeResults(results);
    console.log(`Deduped results: ${results.length} → ${uniqueResults.length}`);
    return uniqueResults;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("402")) throw error;
    console.error("Outscraper error:", error);
    return [];
  }
}
__name(searchBusinesses, "searchBusinesses");

// src/lib/googleplaces.ts
init_esm();
function mapGooglePlace(place) {
  const parts = (place.formattedAddress ?? "").split(",").map((s) => s.trim());
  return {
    name: place.displayName?.text ?? "",
    address: place.formattedAddress ?? "",
    borough: "",
    city: parts.length >= 2 ? parts[parts.length - 2] : "",
    postal_code: "",
    country_code: "AU",
    phone: place.nationalPhoneNumber ?? "",
    website: place.websiteUri ?? "",
    email: "",
    rating: place.rating ?? 0,
    reviews: place.userRatingCount ?? 0,
    latitude: 0,
    longitude: 0
  };
}
__name(mapGooglePlace, "mapGooglePlace");
async function searchBusinessesGoogle(query, limit) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY not configured");
  const results = [];
  let nextPageToken;
  while (results.length < limit) {
    const body = {
      textQuery: query,
      maxResultCount: Math.min(20, limit - results.length),
      languageCode: "en",
      regionCode: "AU"
    };
    if (nextPageToken) body.pageToken = nextPageToken;
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.id,nextPageToken"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Places API ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json();
    if (!data.places?.length) break;
    results.push(...data.places.map(mapGooglePlace));
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }
  return results.slice(0, limit);
}
__name(searchBusinessesGoogle, "searchBusinessesGoogle");

// src/lib/searchBusinesses.ts
async function getSetting(supabase, key) {
  const { data } = await supabase.from("settings").select("value").eq("key", key).single();
  return data?.value ?? null;
}
__name(getSetting, "getSetting");
async function updateSetting(supabase, key, value) {
  await supabase.from("settings").update({ value, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("key", key);
}
__name(updateSetting, "updateSetting");
async function searchBusinesses2(query, limit, supabase, skip = 0) {
  if (skip === 0) {
    const { data: cached } = await supabase.from("search_cache").select("results, api_used").eq("query", query).gt("expires_at", (/* @__PURE__ */ new Date()).toISOString()).maybeSingle();
    if (cached) {
      logger.info("search", `Cache hit: "${query}"`);
      return {
        results: cached.results.slice(0, limit),
        apiUsed: "cache"
      };
    }
  }
  const primaryApi = await getSetting(supabase, "primary_search_api") ?? "outscraper";
  const googleLimit = parseFloat(await getSetting(supabase, "google_maps_monthly_limit") ?? "180");
  const hasGoogleKey = !!process.env.GOOGLE_MAPS_API_KEY;
  const now = /* @__PURE__ */ new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastResetMonth = await getSetting(supabase, "google_maps_spend_reset_month") ?? "";
  let googleSpend = parseFloat(await getSetting(supabase, "google_maps_spend_this_month") ?? "0");
  if (lastResetMonth !== currentMonth) {
    await updateSetting(supabase, "google_maps_spend_this_month", "0.0000");
    await updateSetting(supabase, "google_maps_spend_reset_month", currentMonth);
    googleSpend = 0;
    logger.info("search", `Google Maps monthly spend reset for ${currentMonth}`);
  }
  const withinBudget = googleSpend < googleLimit;
  const useGoogle = primaryApi === "google_maps" && hasGoogleKey && withinBudget && skip === 0;
  console.log(`[search] query="${query}" skip=${skip}`);
  console.log(`[search] primary_search_api="${primaryApi}" (from DB setting)`);
  console.log(`[search] GOOGLE_MAPS_API_KEY set: ${hasGoogleKey}`);
  console.log(`[search] google_spend=$${googleSpend.toFixed(4)} limit=$${googleLimit} withinBudget=${withinBudget}`);
  console.log(`[search] useGoogle=${useGoogle} → will use: ${useGoogle ? "Google Maps" : primaryApi === "google_maps" && !hasGoogleKey ? "Outscraper (NO KEY IN ENV)" : "Outscraper"}`);
  let results;
  let apiUsed;
  if (useGoogle) {
    try {
      results = await searchBusinessesGoogle(query, limit);
      const costPerRequest = parseFloat(await getSetting(supabase, "google_maps_cost_per_request") ?? "0.032");
      const newSpend = googleSpend + costPerRequest;
      await updateSetting(supabase, "google_maps_spend_this_month", newSpend.toFixed(4));
      logger.info("search", `Google Maps: "${query}" (spend: $${newSpend.toFixed(4)}/$${googleLimit})`);
      apiUsed = "google_maps";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("search", `Google Maps failed for "${query}" — falling back to Outscraper`, { error: msg });
      results = await searchBusinesses(query, limit, skip);
      apiUsed = "outscraper_fallback";
    }
  } else {
    if (primaryApi === "google_maps" && !withinBudget) {
      logger.warn("search", `Google Maps budget reached ($${googleSpend.toFixed(2)}/$${googleLimit}) — using Outscraper`);
    }
    results = await searchBusinesses(query, limit, skip);
    apiUsed = "outscraper";
  }
  if (skip === 0 && results.length > 0) {
    await supabase.from("search_cache").upsert(
      {
        query,
        results,
        api_used: apiUsed,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3).toISOString()
      },
      { onConflict: "query" }
    );
  }
  return { results, apiUsed };
}
__name(searchBusinesses2, "searchBusinesses");

// agents/finder.ts
var EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
var MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
var INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i;
var EMAIL_CATEGORIES = [
  // High yield — search first, larger batch
  { name: "Travel Agents", query: "travel agent {city}", capped: true, batchSize: 5 },
  { name: "Tour Operators", query: "tour operator {city}", capped: true, batchSize: 5 },
  // Medium yield
  { name: "Boutique Hotels", query: "boutique hotel {city}", capped: true, batchSize: 3 },
  { name: "Beauty / Lash Studios", query: "beauty studio {city}", capped: true, batchSize: 3 },
  // Low yield — only reached if quota not filled
  { name: "Hair Salons", query: "hair salon {city}", capped: false, batchSize: 3 },
  { name: "Spas / Massage Studios", query: "day spa {city}", capped: false, batchSize: 3 },
  { name: "Halal Restaurants", query: "halal restaurant {city}", capped: false, batchSize: 3 }
];
var DM_CATEGORY_NAMES = ["Halal Restaurants", "Halal Cafes", "Halal Bakeries", "Nail Salons"];
var CITY_STATE = {
  Sydney: "NSW",
  Melbourne: "VIC",
  Brisbane: "QLD",
  Perth: "WA",
  Adelaide: "SA"
};
var BLOCKED_LOCALS = /* @__PURE__ */ new Set([
  "noreply",
  "donotreply",
  "no-reply",
  "wordpress",
  "postmaster",
  "webmaster",
  "bounce",
  "mailer"
]);
function isValidEmail(email) {
  const local = email.toLowerCase().split("@")[0];
  if (BLOCKED_LOCALS.has(local)) return false;
  if (local.length < 4) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(email)) return false;
  if (email.toLowerCase().includes("@2x")) return false;
  const hasVowel = /[aeiou]/.test(local);
  const hasSeparator = /[._]/.test(local);
  if (!hasVowel && !hasSeparator) return false;
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false;
  return true;
}
__name(isValidEmail, "isValidEmail");
function findEmailInHtml(html) {
  const mailtoRe = new RegExp(MAILTO_REGEX.source, "gi");
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    if (isValidEmail(m[1])) return m[1];
  }
  const matches = html.match(EMAIL_REGEX) ?? [];
  return matches.find(isValidEmail) ?? null;
}
__name(findEmailInHtml, "findEmailInHtml");
async function fetchHtml(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5e3);
  try {
    const normalised = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalised, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AussieVentureBot/1.0)" },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return await res.text();
  } catch {
    clearTimeout(timeoutId);
    return "";
  }
}
__name(fetchHtml, "fetchHtml");
async function findEmailForBusiness(rawWebsite) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawWebsite);
  } catch {
    decoded = rawWebsite;
  }
  const base = decoded.replace(/\/$/, "");
  const pages = [
    { url: decoded, label: "homepage" },
    { url: `${base}/contact`, label: "/contact" },
    { url: `${base}/contact-us`, label: "/contact-us" },
    { url: `${base}/about`, label: "/about" },
    { url: `${base}/about-us`, label: "/about-us" }
  ];
  let fetches = 0;
  for (const page of pages) {
    if (fetches >= 3) break;
    const html = await fetchHtml(page.url);
    fetches++;
    if (!html) continue;
    const email = findEmailInHtml(html);
    if (email) return { email, source: page.label };
  }
  return null;
}
__name(findEmailForBusiness, "findEmailForBusiness");
var IRRELEVANT_KEYWORDS = [
  "migrate",
  "migration",
  "migrant",
  "visa",
  "immigration",
  "education",
  "university",
  "college",
  "school",
  "tafe",
  "accounting",
  "tax",
  "legal",
  "lawyer",
  "solicitor",
  "dentist",
  "doctor",
  "medical",
  "pharmacy",
  "clinic",
  "real estate",
  "mortgage",
  "insurance",
  "finance",
  "funeral"
];
function isIrrelevant(name) {
  const lower = name.toLowerCase();
  return IRRELEVANT_KEYWORDS.some((kw) => lower.includes(kw));
}
__name(isIrrelevant, "isIrrelevant");
function isValidBusinessEmail(email, businessName) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const junkDomains = ["sentry.io", "wixpress.com", "mailchimp.com", "sendgrid.net", "example.com", "domain.com", "mail.com"];
  if (junkDomains.some((d) => domain.includes(d))) return false;
  const placeholders = ["example@", "user@", "test@", "demo@", "sample@"];
  if (placeholders.some((p) => email.startsWith(p))) return false;
  if (/^[a-f0-9]{20,}$/.test(local)) return false;
  if (!domain.includes(".")) return false;
  return true;
}
__name(isValidBusinessEmail, "isValidBusinessEmail");
async function isAlreadyInDB(supabase, name, city, phone) {
  const conditions = [`and(business_name.eq.${name},city.eq.${city})`];
  if (phone) conditions.push(`phone.eq.${phone}`);
  const { data } = await supabase.from("leads").select("id").or(conditions.join(",")).limit(1);
  return !!data?.length;
}
__name(isAlreadyInDB, "isAlreadyInDB");
async function getDailyOutscraperSpend(supabase) {
  const now = /* @__PURE__ */ new Date();
  const sydneyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(now);
  const offsetMs = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Sydney" })).getTime() - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const todayStart = new Date((/* @__PURE__ */ new Date(`${sydneyDate}T00:00:00Z`)).getTime() - offsetMs);
  const { data } = await supabase.from("activity_log").select("metadata").eq("event_type", "finder_complete").gte("created_at", todayStart.toISOString());
  return (data ?? []).reduce((sum, row) => {
    const meta = row.metadata;
    const cost = typeof meta?.estimated_cost === "string" ? parseFloat(meta.estimated_cost) : typeof meta?.estimated_cost === "number" ? meta.estimated_cost : 0;
    return sum + (isNaN(cost) ? 0 : cost);
  }, 0);
}
__name(getDailyOutscraperSpend, "getDailyOutscraperSpend");
async function cleanupDmQueue(supabase) {
  logger.info("finder", "Cleaning up DM queue entries");
  const { error: fbErr } = await supabase.from("dm_queue").delete().eq("platform", "facebook");
  if (fbErr) logger.error("finder", "DM cleanup Facebook delete error", { error: fbErr.message });
  const invalidValues = ["Not found", "Not mentioned", "N/A", "None", "null", "Unknown"];
  for (const val of invalidValues) {
    await supabase.from("dm_queue").delete().eq("handle", val);
  }
  const { data: allDms } = await supabase.from("dm_queue").select("id, lead_id, created_at").order("created_at", { ascending: true });
  if (allDms?.length) {
    const seenLeadIds = /* @__PURE__ */ new Map();
    const toDelete = [];
    for (const dm of allDms) {
      if (seenLeadIds.has(dm.lead_id)) {
        toDelete.push(dm.id);
      } else {
        seenLeadIds.set(dm.lead_id, dm.id);
      }
    }
    if (toDelete.length) {
      logger.info("finder", `Removing ${toDelete.length} duplicate DM queue entries`);
      await supabase.from("dm_queue").delete().in("id", toDelete);
    } else {
      logger.info("finder", "DM queue clean — no duplicates");
    }
  }
}
__name(cleanupDmQueue, "cleanupDmQueue");
async function runFinderAgent() {
  const supabase = createServiceClient();
  try {
    const { data: systemSetting } = await supabase.from("settings").select("value").eq("key", "system_active").single();
    if (systemSetting?.value !== "true") {
      logger.info("finder", "System paused - skipped");
      return 0;
    }
    const [emailLimitRow, dmLimitRow, totalLimitRow, dailyOutscraperLimitRow] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "daily_email_limit").single(),
      supabase.from("settings").select("value").eq("key", "daily_dm_limit").single(),
      supabase.from("settings").select("value").eq("key", "daily_lead_limit").single(),
      supabase.from("settings").select("value").eq("key", "daily_outscraper_limit").single()
    ]);
    const DAILY_EMAIL_LIMIT = parseInt(emailLimitRow.data?.value ?? "30", 10);
    const DAILY_DM_LIMIT = parseInt(dmLimitRow.data?.value ?? "10", 10);
    const TOTAL_TARGET = parseInt(totalLimitRow.data?.value ?? "40", 10);
    const EMAIL_TARGET = Math.min(DAILY_EMAIL_LIMIT, TOTAL_TARGET);
    const DM_TARGET = Math.min(DAILY_DM_LIMIT, Math.max(0, TOTAL_TARGET - EMAIL_TARGET));
    const DAILY_OUTSCRAPER_LIMIT = parseFloat(dailyOutscraperLimitRow.data?.value ?? "1.00");
    const cappedLimit = EMAIL_TARGET > 0 ? Math.max(1, Math.ceil(EMAIL_TARGET / 4)) : 0;
    logger.info("finder", "Targets", { emailTarget: EMAIL_TARGET, dmTarget: DM_TARGET, totalTarget: TOTAL_TARGET });
    logger.info("finder", "[NEW_OUTREACH_ALLOCATION]", {
      daily_lead_limit: TOTAL_TARGET,
      email_allocation: EMAIL_TARGET,
      dm_allocation: DM_TARGET,
      configured_daily_email_limit: DAILY_EMAIL_LIMIT,
      configured_daily_dm_limit: DAILY_DM_LIMIT
    });
    logger.info("finder", `Per-category cap: ${cappedLimit}`);
    logger.info("finder", `Daily cost limit: $${DAILY_OUTSCRAPER_LIMIT}`);
    const { data: activeCitySetting } = await supabase.from("settings").select("value").eq("key", "active_cities").single();
    const activeCities = activeCitySetting?.value.split(",").map((c) => c.trim()).filter(Boolean) ?? ["Sydney"];
    logger.info("finder", "Active cities", { cities: activeCities });
    const { data: suburbData } = await supabase.from("city_suburbs").select("city, suburb").eq("active", true).in("city", activeCities).order("city").order("suburb");
    const cityAreaSets = {};
    for (const row of suburbData ?? []) {
      if (!cityAreaSets[row.city]) cityAreaSets[row.city] = /* @__PURE__ */ new Set();
      cityAreaSets[row.city].add(row.suburb);
    }
    const cityAreas = Object.fromEntries(
      Object.entries(cityAreaSets).map(([city, set]) => [city, [...set]])
    );
    for (const city of activeCities) {
      if (!cityAreas[city]?.length) cityAreas[city] = [city];
    }
    logger.info("finder", `Suburbs loaded: ${Object.values(cityAreas).flat().length} active suburbs`);
    await supabase.from("exhausted_queries").delete().lt("expires_at", (/* @__PURE__ */ new Date()).toISOString());
    const { data: exhaustedData } = await supabase.from("exhausted_queries").select("query").gt("expires_at", (/* @__PURE__ */ new Date()).toISOString());
    const exhaustedSet = new Set((exhaustedData ?? []).map((r) => r.query));
    logger.info("finder", `Exhausted queries cached: ${exhaustedSet.size}`);
    const spentToday = await getDailyOutscraperSpend(supabase);
    logger.info("finder", `Prior spend today: $${spentToday.toFixed(4)}`);
    const seenQueries = /* @__PURE__ */ new Set();
    let costGuardHit = false;
    let emailCount = 0;
    let dmCount = 0;
    let callCount = 0;
    let totalResultsFetched = 0;
    let outscraperResultsFetched = 0;
    logger.info("finder", "Phase 1: Email Leads");
    for (const category of EMAIL_CATEGORIES) {
      if (emailCount >= EMAIL_TARGET) break;
      if (emailCount + dmCount >= TOTAL_TARGET) break;
      if (costGuardHit) break;
      const categoryLimit = category.capped ? cappedLimit : EMAIL_TARGET - emailCount;
      let categoryEmailCount = 0;
      logger.info("finder", `Category: ${category.name}`, { limit: categoryLimit });
      citySuburbLoop:
        for (const [city, suburbs] of Object.entries(cityAreas)) {
          const state = CITY_STATE[city] ?? "Unknown";
          for (const suburb of suburbs) {
            if (emailCount >= EMAIL_TARGET) break citySuburbLoop;
            if (emailCount + dmCount >= TOTAL_TARGET) break citySuburbLoop;
            if (categoryEmailCount >= categoryLimit) break citySuburbLoop;
            if (costGuardHit) break citySuburbLoop;
            const query = category.query.replace("{city}", suburb);
            if (seenQueries.has(query)) {
              logger.info("finder", `Skip duplicate query: ${query}`);
              continue;
            }
            if (exhaustedSet.has(query)) {
              logger.info("finder", `Skip exhausted query: ${query}`);
              continue;
            }
            seenQueries.add(query);
            let skip = 0;
            let exhaustedThisQuery = false;
            while (true) {
              if (emailCount >= EMAIL_TARGET) break;
              if (emailCount + dmCount >= TOTAL_TARGET) break;
              if (categoryEmailCount >= categoryLimit) break;
              if (costGuardHit) break;
              const currentRunEstimate = outscraperResultsFetched * 3e-3;
              if (spentToday + currentRunEstimate >= DAILY_OUTSCRAPER_LIMIT) {
                logger.warn("finder", "Cost guard triggered", { limit: DAILY_OUTSCRAPER_LIMIT, spentToday, estimate: currentRunEstimate });
                await supabase.from("activity_log").insert({
                  event_type: "cost_guard_triggered",
                  description: `Daily Outscraper limit $${DAILY_OUTSCRAPER_LIMIT} reached`,
                  metadata: { spent_today: spentToday, current_run_estimate: currentRunEstimate, limit: DAILY_OUTSCRAPER_LIMIT }
                });
                costGuardHit = true;
                break;
              }
              let results;
              let apiUsed;
              try {
                callCount++;
                const searchResult = await searchBusinesses2(query, category.batchSize, supabase, skip);
                results = searchResult.results;
                apiUsed = searchResult.apiUsed;
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                if (msg.includes("402")) throw error;
                logger.error("finder", `Search error: ${query}`, { error: msg });
                await supabase.from("dead_letter_queue").insert({
                  operation: "outscraper_search",
                  payload: { query, skip },
                  error: msg
                });
                await supabase.from("activity_log").insert({
                  event_type: "agent_error",
                  description: `Search error for query "${query}": ${msg}`,
                  metadata: { query, skip, error: msg }
                });
                break;
              }
              totalResultsFetched += results.length;
              if (apiUsed === "outscraper" || apiUsed === "outscraper_fallback") {
                outscraperResultsFetched += results.length;
              }
              let newLeadsThisBatch = 0;
              for (const result of results) {
                if (emailCount >= EMAIL_TARGET) break;
                if (emailCount + dmCount >= TOTAL_TARGET) break;
                if (categoryEmailCount >= categoryLimit) break;
                const name = result.name;
                const rawWebsite = result.website || null;
                if (isIrrelevant(name)) {
                  logger.info("finder", `Skip irrelevant: ${name}`);
                  continue;
                }
                if (await isAlreadyInDB(supabase, name, city, result.phone)) {
                  logger.info("finder", `Skip duplicate: ${name}`);
                  continue;
                }
                if (rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
                  logger.info("finder", `Skip Instagram website: ${name}`);
                  continue;
                }
                let foundEmail = null;
                let emailSource = "";
                if (result.email && isValidEmail(result.email)) {
                  foundEmail = result.email;
                  emailSource = "outscraper";
                }
                if (!foundEmail && !rawWebsite) {
                  logger.info("finder", `Skip ${name} — no website, cannot extract email`);
                  continue;
                }
                if (!foundEmail && rawWebsite) {
                  const found = await findEmailForBusiness(rawWebsite);
                  if (found) {
                    foundEmail = found.email;
                    emailSource = found.source;
                  }
                }
                if (foundEmail) {
                  if (!isValidBusinessEmail(foundEmail, name)) {
                    logger.info("finder", `Skip junk email: ${name}`, { email: foundEmail });
                    continue;
                  }
                  const { error } = await supabase.from("leads").insert({
                    business_name: name,
                    category_name: category.name,
                    city,
                    state,
                    phone: result.phone || null,
                    email: foundEmail,
                    website: rawWebsite,
                    address: result.address || null,
                    google_rating: result.rating || null,
                    google_reviews_count: result.reviews || null,
                    status: "new",
                    outreach_channel: "email"
                  });
                  if (error) {
                    logger.error("finder", `Insert failed: ${name}`, { error: error.message });
                    continue;
                  }
                  emailCount++;
                  categoryEmailCount++;
                  newLeadsThisBatch++;
                  logger.info("finder", `Email lead: ${name}`, { email: foundEmail, source: emailSource });
                  await supabase.from("activity_log").insert({
                    event_type: "lead_found",
                    description: `Email lead: ${name} — ${foundEmail}`,
                    metadata: { category: category.name, city, email: foundEmail, source: emailSource, type: "email" }
                  });
                } else {
                  logger.info("finder", `No email: ${name}`);
                }
              }
              if (categoryEmailCount >= categoryLimit) break;
              if (apiUsed === "google_maps" || apiUsed === "cache") {
                exhaustedThisQuery = true;
                break;
              }
              if (results.length <= 1) {
                exhaustedThisQuery = true;
                break;
              }
              if (newLeadsThisBatch <= 1) {
                logger.info("finder", `Low yield: ${query}`, { newLeads: newLeadsThisBatch });
                break;
              }
              skip += category.batchSize;
            }
            if (exhaustedThisQuery) {
              await supabase.from("exhausted_queries").upsert({
                query,
                city,
                category: category.name,
                exhausted_at: (/* @__PURE__ */ new Date()).toISOString(),
                expires_at: new Date(Date.now() + 3 * 864e5).toISOString()
              });
              exhaustedSet.add(query);
            }
            if (costGuardHit) break citySuburbLoop;
          }
          if (costGuardHit) break;
        }
      if (costGuardHit) break;
    }
    logger.info("finder", "Phase 1 complete", { emailCount, target: EMAIL_TARGET });
    logger.info("finder", "Phase 2: Instagram DM Queue (free)");
    await cleanupDmQueue(supabase);
    const { data: existingDms } = await supabase.from("dm_queue").select("lead_id");
    const alreadyQueued = new Set((existingDms ?? []).map((r) => r.lead_id));
    const { data: dmCandidates } = await supabase.from("leads").select("id, business_name, category_name, city, state").in("category_name", DM_CATEGORY_NAMES).is("email", null).eq("status", "new").in("city", activeCities).order("created_at", { ascending: false }).limit(DM_TARGET * 3);
    for (const lead of dmCandidates ?? []) {
      if (dmCount >= DM_TARGET) break;
      if (emailCount + dmCount >= TOTAL_TARGET) break;
      if (alreadyQueued.has(lead.id)) continue;
      const suggestedHandle = lead.business_name.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9_.]/g, "").slice(0, 30) || "instagram";
      const dmMessage = `Hi! We're Aussie Venture, a food & lifestyle media brand based in Sydney. We'd love to feature ${lead.business_name} in our content. Would you be open to a collaboration? DM us back if you're keen!`;
      const { error } = await supabase.from("dm_queue").insert({
        lead_id: lead.id,
        platform: "instagram",
        handle: suggestedHandle,
        message_text: dmMessage,
        status: "pending"
      });
      if (error) {
        logger.error("finder", `DM queue insert failed: ${lead.business_name}`, { error: error.message });
        continue;
      }
      dmCount++;
      logger.info("finder", `DM queued: ${lead.business_name}`, { handle: suggestedHandle });
      await supabase.from("activity_log").insert({
        event_type: "lead_found",
        description: `DM queued: ${lead.business_name} — search @${suggestedHandle} on Instagram`,
        metadata: { category: lead.category_name, city: lead.city, suggested_handle: suggestedHandle, type: "dm" }
      });
    }
    logger.info("finder", "Phase 2 complete", { dmCount, target: DM_TARGET });
    const leadsKept = emailCount + dmCount;
    const estimatedCost = (outscraperResultsFetched * 3e-3).toFixed(4);
    const efficiency = `${leadsKept}/${totalResultsFetched} results used`;
    const efficiencyPct = totalResultsFetched > 0 ? (leadsKept / totalResultsFetched * 100).toFixed(1) : "0.0";
    logger.info("finder", `Outscraper results fetched: ${outscraperResultsFetched}`);
    logger.info("finder", `Total results fetched (all APIs): ${totalResultsFetched}`);
    logger.info("finder", `Leads kept: ${leadsKept}`);
    logger.info("finder", `Efficiency: ${leadsKept}/${totalResultsFetched} (${efficiencyPct}%)`);
    logger.info("finder", `Estimated Outscraper cost: $${estimatedCost}`);
    logger.info("finder", "Run complete", {
      emailLeads: emailCount,
      dmLeads: dmCount,
      outscraperCalls: callCount,
      resultsFetched: totalResultsFetched,
      estimatedCost,
      efficiency,
      costGuardHit
    });
    if (costGuardHit) logger.warn("finder", `Run stopped by cost guard ($${DAILY_OUTSCRAPER_LIMIT} daily limit)`);
    await supabase.from("activity_log").insert({
      event_type: "finder_complete",
      description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads queued (${callCount} Outscraper calls)`,
      metadata: {
        email_leads: emailCount,
        dm_leads: dmCount,
        email_target: EMAIL_TARGET,
        dm_target: DM_TARGET,
        total_target: TOTAL_TARGET,
        outscraper_calls: callCount,
        results_fetched: totalResultsFetched,
        leads_kept: leadsKept,
        outscraper_results: outscraperResultsFetched,
        estimated_cost: estimatedCost,
        efficiency,
        cost_guard_hit: costGuardHit
      }
    });
    return leadsKept;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("finder", "Fatal error", { error: message, stack: error instanceof Error ? error.stack : null });
    const isBalanceError = message.includes("402");
    await supabase.from("activity_log").insert({
      event_type: "agent_error",
      description: `Agent failed: ${message}`,
      metadata: {
        agent: "finder",
        error: message,
        stack: error instanceof Error ? error.stack : null,
        is_balance_error: isBalanceError,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
    throw error;
  }
}
__name(runFinderAgent, "runFinderAgent");

// agents/researcher.ts
init_esm();

// src/lib/claude.ts
init_esm();

// node_modules/@anthropic-ai/sdk/index.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/client.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/tslib.mjs
init_esm();
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
__name(__classPrivateFieldSet, "__classPrivateFieldSet");
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
__name(__classPrivateFieldGet, "__classPrivateFieldGet");

// node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs
init_esm();
var uuid4 = /* @__PURE__ */ __name(function() {
  const { crypto } = globalThis;
  if (crypto?.randomUUID) {
    uuid4 = crypto.randomUUID.bind(crypto);
    return crypto.randomUUID();
  }
  const u8 = new Uint8Array(1);
  const randomByte = crypto ? () => crypto.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
}, "uuid4");

// node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/core/error.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/errors.mjs
init_esm();
function isAbortError(err) {
  return typeof err === "object" && err !== null && // Spec-compliant fetch implementations
  ("name" in err && err.name === "AbortError" || // Expo fetch
  "message" in err && String(err.message).includes("FetchRequestCanceledException"));
}
__name(isAbortError, "isAbortError");
var castToError = /* @__PURE__ */ __name((err) => {
  if (err instanceof Error)
    return err;
  if (typeof err === "object" && err !== null) {
    try {
      if (Object.prototype.toString.call(err) === "[object Error]") {
        const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
        if (err.stack)
          error.stack = err.stack;
        if (err.cause && !error.cause)
          error.cause = err.cause;
        if (err.name)
          error.name = err.name;
        return error;
      }
    } catch {
    }
    try {
      return new Error(JSON.stringify(err));
    } catch {
    }
  }
  return new Error(err);
}, "castToError");

// node_modules/@anthropic-ai/sdk/core/error.mjs
var AnthropicError = class extends Error {
  static {
    __name(this, "AnthropicError");
  }
};
var APIError = class _APIError extends AnthropicError {
  static {
    __name(this, "APIError");
  }
  constructor(status, error, message, headers, type) {
    super(`${_APIError.makeMessage(status, error, message)}`);
    this.status = status;
    this.headers = headers;
    this.requestID = headers?.get("request-id");
    this.error = error;
    this.type = type ?? null;
  }
  static makeMessage(status, error, message) {
    const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
    if (status && msg) {
      return `${status} ${msg}`;
    }
    if (status) {
      return `${status} status code (no body)`;
    }
    if (msg) {
      return msg;
    }
    return "(no status code or body)";
  }
  static generate(status, errorResponse, message, headers) {
    if (!status || !headers) {
      return new APIConnectionError({ message, cause: castToError(errorResponse) });
    }
    const error = errorResponse;
    const type = error?.["error"]?.["type"];
    if (status === 400) {
      return new BadRequestError(status, error, message, headers, type);
    }
    if (status === 401) {
      return new AuthenticationError(status, error, message, headers, type);
    }
    if (status === 403) {
      return new PermissionDeniedError(status, error, message, headers, type);
    }
    if (status === 404) {
      return new NotFoundError(status, error, message, headers, type);
    }
    if (status === 409) {
      return new ConflictError(status, error, message, headers, type);
    }
    if (status === 422) {
      return new UnprocessableEntityError(status, error, message, headers, type);
    }
    if (status === 429) {
      return new RateLimitError(status, error, message, headers, type);
    }
    if (status >= 500) {
      return new InternalServerError(status, error, message, headers, type);
    }
    return new _APIError(status, error, message, headers, type);
  }
};
var APIUserAbortError = class extends APIError {
  static {
    __name(this, "APIUserAbortError");
  }
  constructor({ message } = {}) {
    super(void 0, void 0, message || "Request was aborted.", void 0);
  }
};
var APIConnectionError = class extends APIError {
  static {
    __name(this, "APIConnectionError");
  }
  constructor({ message, cause }) {
    super(void 0, void 0, message || "Connection error.", void 0);
    if (cause)
      this.cause = cause;
  }
};
var APIConnectionTimeoutError = class extends APIConnectionError {
  static {
    __name(this, "APIConnectionTimeoutError");
  }
  constructor({ message } = {}) {
    super({ message: message ?? "Request timed out." });
  }
};
var BadRequestError = class extends APIError {
  static {
    __name(this, "BadRequestError");
  }
};
var AuthenticationError = class extends APIError {
  static {
    __name(this, "AuthenticationError");
  }
};
var PermissionDeniedError = class extends APIError {
  static {
    __name(this, "PermissionDeniedError");
  }
};
var NotFoundError = class extends APIError {
  static {
    __name(this, "NotFoundError");
  }
};
var ConflictError = class extends APIError {
  static {
    __name(this, "ConflictError");
  }
};
var UnprocessableEntityError = class extends APIError {
  static {
    __name(this, "UnprocessableEntityError");
  }
};
var RateLimitError = class extends APIError {
  static {
    __name(this, "RateLimitError");
  }
};
var InternalServerError = class extends APIError {
  static {
    __name(this, "InternalServerError");
  }
};

// node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
var startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
var isAbsoluteURL = /* @__PURE__ */ __name((url) => {
  return startsWithSchemeRegexp.test(url);
}, "isAbsoluteURL");
var isArray = /* @__PURE__ */ __name((val) => (isArray = Array.isArray, isArray(val)), "isArray");
var isReadonlyArray = isArray;
function maybeObj(x) {
  if (typeof x !== "object") {
    return {};
  }
  return x ?? {};
}
__name(maybeObj, "maybeObj");
function isEmptyObj(obj) {
  if (!obj)
    return true;
  for (const _k in obj)
    return false;
  return true;
}
__name(isEmptyObj, "isEmptyObj");
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
__name(hasOwn, "hasOwn");
var validatePositiveInteger = /* @__PURE__ */ __name((name, n) => {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new AnthropicError(`${name} must be an integer`);
  }
  if (n < 0) {
    throw new AnthropicError(`${name} must be a positive integer`);
  }
  return n;
}, "validatePositiveInteger");
var safeJSON = /* @__PURE__ */ __name((text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return void 0;
  }
}, "safeJSON");

// node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs
init_esm();
var sleep = /* @__PURE__ */ __name((ms) => new Promise((resolve) => setTimeout(resolve, ms)), "sleep");

// node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/version.mjs
init_esm();
var VERSION = "0.91.1";

// node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs
var isRunningInBrowser = /* @__PURE__ */ __name(() => {
  return (
    // @ts-ignore
    typeof window !== "undefined" && // @ts-ignore
    typeof window.document !== "undefined" && // @ts-ignore
    typeof navigator !== "undefined"
  );
}, "isRunningInBrowser");
function getDetectedPlatform() {
  if (typeof Deno !== "undefined" && Deno.build != null) {
    return "deno";
  }
  if (typeof EdgeRuntime !== "undefined") {
    return "edge";
  }
  if (Object.prototype.toString.call(typeof globalThis.process !== "undefined" ? globalThis.process : 0) === "[object process]") {
    return "node";
  }
  return "unknown";
}
__name(getDetectedPlatform, "getDetectedPlatform");
var getPlatformProperties = /* @__PURE__ */ __name(() => {
  const detectedPlatform = getDetectedPlatform();
  if (detectedPlatform === "deno") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": normalizePlatform(Deno.build.os),
      "X-Stainless-Arch": normalizeArch(Deno.build.arch),
      "X-Stainless-Runtime": "deno",
      "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
    };
  }
  if (typeof EdgeRuntime !== "undefined") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": `other:${EdgeRuntime}`,
      "X-Stainless-Runtime": "edge",
      "X-Stainless-Runtime-Version": globalThis.process.version
    };
  }
  if (detectedPlatform === "node") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": normalizePlatform(globalThis.process.platform ?? "unknown"),
      "X-Stainless-Arch": normalizeArch(globalThis.process.arch ?? "unknown"),
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown"
    };
  }
  const browserInfo = getBrowserInfo();
  if (browserInfo) {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": "unknown",
      "X-Stainless-Runtime": `browser:${browserInfo.browser}`,
      "X-Stainless-Runtime-Version": browserInfo.version
    };
  }
  return {
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": VERSION,
    "X-Stainless-OS": "Unknown",
    "X-Stainless-Arch": "unknown",
    "X-Stainless-Runtime": "unknown",
    "X-Stainless-Runtime-Version": "unknown"
  };
}, "getPlatformProperties");
function getBrowserInfo() {
  if (typeof navigator === "undefined" || !navigator) {
    return null;
  }
  const browserPatterns = [
    { key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }
  ];
  for (const { key, pattern } of browserPatterns) {
    const match = pattern.exec(navigator.userAgent);
    if (match) {
      const major = match[1] || 0;
      const minor = match[2] || 0;
      const patch = match[3] || 0;
      return { browser: key, version: `${major}.${minor}.${patch}` };
    }
  }
  return null;
}
__name(getBrowserInfo, "getBrowserInfo");
var normalizeArch = /* @__PURE__ */ __name((arch) => {
  if (arch === "x32")
    return "x32";
  if (arch === "x86_64" || arch === "x64")
    return "x64";
  if (arch === "arm")
    return "arm";
  if (arch === "aarch64" || arch === "arm64")
    return "arm64";
  if (arch)
    return `other:${arch}`;
  return "unknown";
}, "normalizeArch");
var normalizePlatform = /* @__PURE__ */ __name((platform) => {
  platform = platform.toLowerCase();
  if (platform.includes("ios"))
    return "iOS";
  if (platform === "android")
    return "Android";
  if (platform === "darwin")
    return "MacOS";
  if (platform === "win32")
    return "Windows";
  if (platform === "freebsd")
    return "FreeBSD";
  if (platform === "openbsd")
    return "OpenBSD";
  if (platform === "linux")
    return "Linux";
  if (platform)
    return `Other:${platform}`;
  return "Unknown";
}, "normalizePlatform");
var _platformHeaders;
var getPlatformHeaders = /* @__PURE__ */ __name(() => {
  return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
}, "getPlatformHeaders");

// node_modules/@anthropic-ai/sdk/internal/shims.mjs
init_esm();
function getDefaultFetch() {
  if (typeof fetch !== "undefined") {
    return fetch;
  }
  throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
__name(getDefaultFetch, "getDefaultFetch");
function makeReadableStream(...args) {
  const ReadableStream = globalThis.ReadableStream;
  if (typeof ReadableStream === "undefined") {
    throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  }
  return new ReadableStream(...args);
}
__name(makeReadableStream, "makeReadableStream");
function ReadableStreamFrom(iterable) {
  let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  return makeReadableStream({
    start() {
    },
    async pull(controller) {
      const { done, value } = await iter.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      await iter.return?.();
    }
  });
}
__name(ReadableStreamFrom, "ReadableStreamFrom");
function ReadableStreamToAsyncIterable(stream) {
  if (stream[Symbol.asyncIterator])
    return stream;
  const reader = stream.getReader();
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result?.done)
          reader.releaseLock();
        return result;
      } catch (e) {
        reader.releaseLock();
        throw e;
      }
    },
    async return() {
      const cancelPromise = reader.cancel();
      reader.releaseLock();
      await cancelPromise;
      return { done: true, value: void 0 };
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
__name(ReadableStreamToAsyncIterable, "ReadableStreamToAsyncIterable");
async function CancelReadableStream(stream) {
  if (stream === null || typeof stream !== "object")
    return;
  if (stream[Symbol.asyncIterator]) {
    await stream[Symbol.asyncIterator]().return?.();
    return;
  }
  const reader = stream.getReader();
  const cancelPromise = reader.cancel();
  reader.releaseLock();
  await cancelPromise;
}
__name(CancelReadableStream, "CancelReadableStream");

// node_modules/@anthropic-ai/sdk/internal/request-options.mjs
init_esm();
var FallbackEncoder = /* @__PURE__ */ __name(({ headers, body }) => {
  return {
    bodyHeaders: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}, "FallbackEncoder");

// node_modules/@anthropic-ai/sdk/internal/utils/query.mjs
init_esm();
function stringifyQuery(query) {
  return Object.entries(query).filter(([_, value]) => typeof value !== "undefined").map(([key, value]) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
    if (value === null) {
      return `${encodeURIComponent(key)}=`;
    }
    throw new AnthropicError(`Cannot stringify type ${typeof value}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
  }).join("&");
}
__name(stringifyQuery, "stringifyQuery");

// node_modules/@anthropic-ai/sdk/core/pagination.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/parse.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/core/streaming.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs
init_esm();
function concatBytes(buffers) {
  let length = 0;
  for (const buffer of buffers) {
    length += buffer.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const buffer of buffers) {
    output.set(buffer, index);
    index += buffer.length;
  }
  return output;
}
__name(concatBytes, "concatBytes");
var encodeUTF8_;
function encodeUTF8(str) {
  let encoder;
  return (encodeUTF8_ ?? (encoder = new globalThis.TextEncoder(), encodeUTF8_ = encoder.encode.bind(encoder)))(str);
}
__name(encodeUTF8, "encodeUTF8");
var decodeUTF8_;
function decodeUTF8(bytes) {
  let decoder;
  return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}
__name(decodeUTF8, "decodeUTF8");

// node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
var _LineDecoder_buffer;
var _LineDecoder_carriageReturnIndex;
var LineDecoder = class {
  static {
    __name(this, "LineDecoder");
  }
  constructor() {
    _LineDecoder_buffer.set(this, void 0);
    _LineDecoder_carriageReturnIndex.set(this, void 0);
    __classPrivateFieldSet(this, _LineDecoder_buffer, new Uint8Array(), "f");
    __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
  }
  decode(chunk) {
    if (chunk == null) {
      return [];
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
    __classPrivateFieldSet(this, _LineDecoder_buffer, concatBytes([__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), binaryChunk]), "f");
    const lines = [];
    let patternIndex;
    while ((patternIndex = findNewlineIndex(__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f"))) != null) {
      if (patternIndex.carriage && __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") == null) {
        __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, patternIndex.index, "f");
        continue;
      }
      if (__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") != null && (patternIndex.index !== __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") + 1 || patternIndex.carriage)) {
        lines.push(decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") - 1)));
        __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f")), "f");
        __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
        continue;
      }
      const endIndex = __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
      const line = decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, endIndex));
      lines.push(line);
      __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(patternIndex.index), "f");
      __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
    }
    return lines;
  }
  flush() {
    if (!__classPrivateFieldGet(this, _LineDecoder_buffer, "f").length) {
      return [];
    }
    return this.decode("\n");
  }
};
_LineDecoder_buffer = /* @__PURE__ */ new WeakMap(), _LineDecoder_carriageReturnIndex = /* @__PURE__ */ new WeakMap();
LineDecoder.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
function findNewlineIndex(buffer, startIndex) {
  const newline = 10;
  const carriage = 13;
  for (let i = startIndex ?? 0; i < buffer.length; i++) {
    if (buffer[i] === newline) {
      return { preceding: i, index: i + 1, carriage: false };
    }
    if (buffer[i] === carriage) {
      return { preceding: i, index: i + 1, carriage: true };
    }
  }
  return null;
}
__name(findNewlineIndex, "findNewlineIndex");
function findDoubleNewlineIndex(buffer) {
  const newline = 10;
  const carriage = 13;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === newline && buffer[i + 1] === newline) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === carriage) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === newline && i + 3 < buffer.length && buffer[i + 2] === carriage && buffer[i + 3] === newline) {
      return i + 4;
    }
  }
  return -1;
}
__name(findDoubleNewlineIndex, "findDoubleNewlineIndex");

// node_modules/@anthropic-ai/sdk/internal/utils/log.mjs
init_esm();
var levelNumbers = {
  off: 0,
  error: 200,
  warn: 300,
  info: 400,
  debug: 500
};
var parseLogLevel = /* @__PURE__ */ __name((maybeLevel, sourceName, client) => {
  if (!maybeLevel) {
    return void 0;
  }
  if (hasOwn(levelNumbers, maybeLevel)) {
    return maybeLevel;
  }
  loggerFor(client).warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
  return void 0;
}, "parseLogLevel");
function noop() {
}
__name(noop, "noop");
function makeLogFn(fnLevel, logger2, logLevel) {
  if (!logger2 || levelNumbers[fnLevel] > levelNumbers[logLevel]) {
    return noop;
  } else {
    return logger2[fnLevel].bind(logger2);
  }
}
__name(makeLogFn, "makeLogFn");
var noopLogger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop
};
var cachedLoggers = /* @__PURE__ */ new WeakMap();
function loggerFor(client) {
  const logger2 = client.logger;
  const logLevel = client.logLevel ?? "off";
  if (!logger2) {
    return noopLogger;
  }
  const cachedLogger = cachedLoggers.get(logger2);
  if (cachedLogger && cachedLogger[0] === logLevel) {
    return cachedLogger[1];
  }
  const levelLogger = {
    error: makeLogFn("error", logger2, logLevel),
    warn: makeLogFn("warn", logger2, logLevel),
    info: makeLogFn("info", logger2, logLevel),
    debug: makeLogFn("debug", logger2, logLevel)
  };
  cachedLoggers.set(logger2, [logLevel, levelLogger]);
  return levelLogger;
}
__name(loggerFor, "loggerFor");
var formatRequestDetails = /* @__PURE__ */ __name((details) => {
  if (details.options) {
    details.options = { ...details.options };
    delete details.options["headers"];
  }
  if (details.headers) {
    details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [
      name,
      name.toLowerCase() === "x-api-key" || name.toLowerCase() === "authorization" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value
    ]));
  }
  if ("retryOfRequestLogID" in details) {
    if (details.retryOfRequestLogID) {
      details.retryOf = details.retryOfRequestLogID;
    }
    delete details.retryOfRequestLogID;
  }
  return details;
}, "formatRequestDetails");

// node_modules/@anthropic-ai/sdk/core/streaming.mjs
var _Stream_client;
var Stream = class _Stream {
  static {
    __name(this, "Stream");
  }
  constructor(iterator, controller, client) {
    this.iterator = iterator;
    _Stream_client.set(this, void 0);
    this.controller = controller;
    __classPrivateFieldSet(this, _Stream_client, client, "f");
  }
  static fromSSEResponse(response, controller, client) {
    let consumed = false;
    const logger2 = client ? loggerFor(client) : console;
    async function* iterator() {
      if (consumed) {
        throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      }
      consumed = true;
      let done = false;
      try {
        for await (const sse of _iterSSEMessages(response, controller)) {
          if (sse.event === "completion") {
            try {
              yield JSON.parse(sse.data);
            } catch (e) {
              logger2.error(`Could not parse message into JSON:`, sse.data);
              logger2.error(`From chunk:`, sse.raw);
              throw e;
            }
          }
          if (sse.event === "message_start" || sse.event === "message_delta" || sse.event === "message_stop" || sse.event === "content_block_start" || sse.event === "content_block_delta" || sse.event === "content_block_stop" || sse.event === "message" || sse.event === "user.message" || sse.event === "user.interrupt" || sse.event === "user.tool_confirmation" || sse.event === "user.custom_tool_result" || sse.event === "agent.message" || sse.event === "agent.thinking" || sse.event === "agent.tool_use" || sse.event === "agent.tool_result" || sse.event === "agent.mcp_tool_use" || sse.event === "agent.mcp_tool_result" || sse.event === "agent.custom_tool_use" || sse.event === "agent.thread_context_compacted" || sse.event === "session.status_running" || sse.event === "session.status_idle" || sse.event === "session.status_rescheduled" || sse.event === "session.status_terminated" || sse.event === "session.error" || sse.event === "session.deleted" || sse.event === "span.model_request_start" || sse.event === "span.model_request_end") {
            try {
              yield JSON.parse(sse.data);
            } catch (e) {
              logger2.error(`Could not parse message into JSON:`, sse.data);
              logger2.error(`From chunk:`, sse.raw);
              throw e;
            }
          }
          if (sse.event === "ping") {
            continue;
          }
          if (sse.event === "error") {
            const body = safeJSON(sse.data) ?? sse.data;
            const type = body?.error?.type;
            throw new APIError(void 0, body, void 0, response.headers, type);
          }
        }
        done = true;
      } catch (e) {
        if (isAbortError(e))
          return;
        throw e;
      } finally {
        if (!done)
          controller.abort();
      }
    }
    __name(iterator, "iterator");
    return new _Stream(iterator, controller, client);
  }
  /**
   * Generates a Stream from a newline-separated ReadableStream
   * where each item is a JSON value.
   */
  static fromReadableStream(readableStream, controller, client) {
    let consumed = false;
    async function* iterLines() {
      const lineDecoder = new LineDecoder();
      const iter = ReadableStreamToAsyncIterable(readableStream);
      for await (const chunk of iter) {
        for (const line of lineDecoder.decode(chunk)) {
          yield line;
        }
      }
      for (const line of lineDecoder.flush()) {
        yield line;
      }
    }
    __name(iterLines, "iterLines");
    async function* iterator() {
      if (consumed) {
        throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      }
      consumed = true;
      let done = false;
      try {
        for await (const line of iterLines()) {
          if (done)
            continue;
          if (line)
            yield JSON.parse(line);
        }
        done = true;
      } catch (e) {
        if (isAbortError(e))
          return;
        throw e;
      } finally {
        if (!done)
          controller.abort();
      }
    }
    __name(iterator, "iterator");
    return new _Stream(iterator, controller, client);
  }
  [(_Stream_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    return this.iterator();
  }
  /**
   * Splits the stream into two streams which can be
   * independently read from at different speeds.
   */
  tee() {
    const left = [];
    const right = [];
    const iterator = this.iterator();
    const teeIterator = /* @__PURE__ */ __name((queue) => {
      return {
        next: /* @__PURE__ */ __name(() => {
          if (queue.length === 0) {
            const result = iterator.next();
            left.push(result);
            right.push(result);
          }
          return queue.shift();
        }, "next")
      };
    }, "teeIterator");
    return [
      new _Stream(() => teeIterator(left), this.controller, __classPrivateFieldGet(this, _Stream_client, "f")),
      new _Stream(() => teeIterator(right), this.controller, __classPrivateFieldGet(this, _Stream_client, "f"))
    ];
  }
  /**
   * Converts this stream to a newline-separated ReadableStream of
   * JSON stringified values in the stream
   * which can be turned back into a Stream with `Stream.fromReadableStream()`.
   */
  toReadableStream() {
    const self = this;
    let iter;
    return makeReadableStream({
      async start() {
        iter = self[Symbol.asyncIterator]();
      },
      async pull(ctrl) {
        try {
          const { value, done } = await iter.next();
          if (done)
            return ctrl.close();
          const bytes = encodeUTF8(JSON.stringify(value) + "\n");
          ctrl.enqueue(bytes);
        } catch (err) {
          ctrl.error(err);
        }
      },
      async cancel() {
        await iter.return?.();
      }
    });
  }
};
async function* _iterSSEMessages(response, controller) {
  if (!response.body) {
    controller.abort();
    if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
      throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
    }
    throw new AnthropicError(`Attempted to iterate over a response with no body`);
  }
  const sseDecoder = new SSEDecoder();
  const lineDecoder = new LineDecoder();
  const iter = ReadableStreamToAsyncIterable(response.body);
  for await (const sseChunk of iterSSEChunks(iter)) {
    for (const line of lineDecoder.decode(sseChunk)) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield sse;
    }
  }
  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse)
      yield sse;
  }
}
__name(_iterSSEMessages, "_iterSSEMessages");
async function* iterSSEChunks(iterator) {
  let data = new Uint8Array();
  for await (const chunk of iterator) {
    if (chunk == null) {
      continue;
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
    let newData = new Uint8Array(data.length + binaryChunk.length);
    newData.set(data);
    newData.set(binaryChunk, data.length);
    data = newData;
    let patternIndex;
    while ((patternIndex = findDoubleNewlineIndex(data)) !== -1) {
      yield data.slice(0, patternIndex);
      data = data.slice(patternIndex);
    }
  }
  if (data.length > 0) {
    yield data;
  }
}
__name(iterSSEChunks, "iterSSEChunks");
var SSEDecoder = class {
  static {
    __name(this, "SSEDecoder");
  }
  constructor() {
    this.event = null;
    this.data = [];
    this.chunks = [];
  }
  decode(line) {
    if (line.endsWith("\r")) {
      line = line.substring(0, line.length - 1);
    }
    if (!line) {
      if (!this.event && !this.data.length)
        return null;
      const sse = {
        event: this.event,
        data: this.data.join("\n"),
        raw: this.chunks
      };
      this.event = null;
      this.data = [];
      this.chunks = [];
      return sse;
    }
    this.chunks.push(line);
    if (line.startsWith(":")) {
      return null;
    }
    let [fieldname, _, value] = partition(line, ":");
    if (value.startsWith(" ")) {
      value = value.substring(1);
    }
    if (fieldname === "event") {
      this.event = value;
    } else if (fieldname === "data") {
      this.data.push(value);
    }
    return null;
  }
};
function partition(str, delimiter) {
  const index = str.indexOf(delimiter);
  if (index !== -1) {
    return [str.substring(0, index), delimiter, str.substring(index + delimiter.length)];
  }
  return [str, "", ""];
}
__name(partition, "partition");

// node_modules/@anthropic-ai/sdk/internal/parse.mjs
async function defaultParseResponse(client, props) {
  const { response, requestLogID, retryOfRequestLogID, startTime } = props;
  const body = await (async () => {
    if (props.options.stream) {
      loggerFor(client).debug("response", response.status, response.url, response.headers, response.body);
      if (props.options.__streamClass) {
        return props.options.__streamClass.fromSSEResponse(response, props.controller);
      }
      return Stream.fromSSEResponse(response, props.controller);
    }
    if (response.status === 204) {
      return null;
    }
    if (props.options.__binaryResponse) {
      return response;
    }
    const contentType = response.headers.get("content-type");
    const mediaType = contentType?.split(";")[0]?.trim();
    const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
    if (isJSON) {
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return void 0;
      }
      const json = await response.json();
      return addRequestID(json, response);
    }
    const text = await response.text();
    return text;
  })();
  loggerFor(client).debug(`[${requestLogID}] response parsed`, formatRequestDetails({
    retryOfRequestLogID,
    url: response.url,
    status: response.status,
    body,
    durationMs: Date.now() - startTime
  }));
  return body;
}
__name(defaultParseResponse, "defaultParseResponse");
function addRequestID(value, response) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.defineProperty(value, "_request_id", {
    value: response.headers.get("request-id"),
    enumerable: false
  });
}
__name(addRequestID, "addRequestID");

// node_modules/@anthropic-ai/sdk/core/api-promise.mjs
init_esm();
var _APIPromise_client;
var APIPromise = class _APIPromise extends Promise {
  static {
    __name(this, "APIPromise");
  }
  constructor(client, responsePromise, parseResponse = defaultParseResponse) {
    super((resolve) => {
      resolve(null);
    });
    this.responsePromise = responsePromise;
    this.parseResponse = parseResponse;
    _APIPromise_client.set(this, void 0);
    __classPrivateFieldSet(this, _APIPromise_client, client, "f");
  }
  _thenUnwrap(transform) {
    return new _APIPromise(__classPrivateFieldGet(this, _APIPromise_client, "f"), this.responsePromise, async (client, props) => addRequestID(transform(await this.parseResponse(client, props), props), props.response));
  }
  /**
   * Gets the raw `Response` instance instead of parsing the response
   * data.
   *
   * If you want to parse the response body but still get the `Response`
   * instance, you can use {@link withResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
   * to your `tsconfig.json`.
   */
  asResponse() {
    return this.responsePromise.then((p) => p.response);
  }
  /**
   * Gets the parsed response data, the raw `Response` instance and the ID of the request,
   * returned via the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * If you just want to get the raw `Response` instance without parsing it,
   * you can use {@link asResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
   * to your `tsconfig.json`.
   */
  async withResponse() {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response, request_id: response.headers.get("request-id") };
  }
  parse() {
    if (!this.parsedPromise) {
      this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(__classPrivateFieldGet(this, _APIPromise_client, "f"), data));
    }
    return this.parsedPromise;
  }
  then(onfulfilled, onrejected) {
    return this.parse().then(onfulfilled, onrejected);
  }
  catch(onrejected) {
    return this.parse().catch(onrejected);
  }
  finally(onfinally) {
    return this.parse().finally(onfinally);
  }
};
_APIPromise_client = /* @__PURE__ */ new WeakMap();

// node_modules/@anthropic-ai/sdk/core/pagination.mjs
var _AbstractPage_client;
var AbstractPage = class {
  static {
    __name(this, "AbstractPage");
  }
  constructor(client, response, body, options) {
    _AbstractPage_client.set(this, void 0);
    __classPrivateFieldSet(this, _AbstractPage_client, client, "f");
    this.options = options;
    this.response = response;
    this.body = body;
  }
  hasNextPage() {
    const items = this.getPaginatedItems();
    if (!items.length)
      return false;
    return this.nextPageRequestOptions() != null;
  }
  async getNextPage() {
    const nextOptions = this.nextPageRequestOptions();
    if (!nextOptions) {
      throw new AnthropicError("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
    }
    return await __classPrivateFieldGet(this, _AbstractPage_client, "f").requestAPIList(this.constructor, nextOptions);
  }
  async *iterPages() {
    let page = this;
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }
  async *[(_AbstractPage_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    for await (const page of this.iterPages()) {
      for (const item of page.getPaginatedItems()) {
        yield item;
      }
    }
  }
};
var PagePromise = class extends APIPromise {
  static {
    __name(this, "PagePromise");
  }
  constructor(client, request, Page2) {
    super(client, request, async (client2, props) => new Page2(client2, props.response, await defaultParseResponse(client2, props), props.options));
  }
  /**
   * Allow auto-paginating iteration on an unawaited list call, eg:
   *
   *    for await (const item of client.items.list()) {
   *      console.log(item)
   *    }
   */
  async *[Symbol.asyncIterator]() {
    const page = await this;
    for await (const item of page) {
      yield item;
    }
  }
};
var Page = class extends AbstractPage {
  static {
    __name(this, "Page");
  }
  constructor(client, response, body, options) {
    super(client, response, body, options);
    this.data = body.data || [];
    this.has_more = body.has_more || false;
    this.first_id = body.first_id || null;
    this.last_id = body.last_id || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  hasNextPage() {
    if (this.has_more === false) {
      return false;
    }
    return super.hasNextPage();
  }
  nextPageRequestOptions() {
    if (this.options.query?.["before_id"]) {
      const first_id = this.first_id;
      if (!first_id) {
        return null;
      }
      return {
        ...this.options,
        query: {
          ...maybeObj(this.options.query),
          before_id: first_id
        }
      };
    }
    const cursor = this.last_id;
    if (!cursor) {
      return null;
    }
    return {
      ...this.options,
      query: {
        ...maybeObj(this.options.query),
        after_id: cursor
      }
    };
  }
};
var PageCursor = class extends AbstractPage {
  static {
    __name(this, "PageCursor");
  }
  constructor(client, response, body, options) {
    super(client, response, body, options);
    this.data = body.data || [];
    this.next_page = body.next_page || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  nextPageRequestOptions() {
    const cursor = this.next_page;
    if (!cursor) {
      return null;
    }
    return {
      ...this.options,
      query: {
        ...maybeObj(this.options.query),
        page: cursor
      }
    };
  }
};

// node_modules/@anthropic-ai/sdk/core/uploads.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/to-file.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/uploads.mjs
init_esm();
var checkFileSupport = /* @__PURE__ */ __name(() => {
  if (typeof File === "undefined") {
    const { process: process2 } = globalThis;
    const isOldNode = typeof process2?.versions?.node === "string" && parseInt(process2.versions.node.split(".")) < 20;
    throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
  }
}, "checkFileSupport");
function makeFile(fileBits, fileName, options) {
  checkFileSupport();
  return new File(fileBits, fileName ?? "unknown_file", options);
}
__name(makeFile, "makeFile");
function getName(value, stripPath) {
  const val = typeof value === "object" && value !== null && ("name" in value && value.name && String(value.name) || "url" in value && value.url && String(value.url) || "filename" in value && value.filename && String(value.filename) || "path" in value && value.path && String(value.path)) || "";
  return stripPath ? val.split(/[\\/]/).pop() || void 0 : val;
}
__name(getName, "getName");
var isAsyncIterable = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function", "isAsyncIterable");
var multipartFormRequestOptions = /* @__PURE__ */ __name(async (opts, fetch2, stripFilenames = true) => {
  return { ...opts, body: await createForm(opts.body, fetch2, stripFilenames) };
}, "multipartFormRequestOptions");
var supportsFormDataMap = /* @__PURE__ */ new WeakMap();
function supportsFormData(fetchObject) {
  const fetch2 = typeof fetchObject === "function" ? fetchObject : fetchObject.fetch;
  const cached = supportsFormDataMap.get(fetch2);
  if (cached)
    return cached;
  const promise = (async () => {
    try {
      const FetchResponse = "Response" in fetch2 ? fetch2.Response : (await fetch2("data:,")).constructor;
      const data = new FormData();
      if (data.toString() === await new FetchResponse(data).text()) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  })();
  supportsFormDataMap.set(fetch2, promise);
  return promise;
}
__name(supportsFormData, "supportsFormData");
var createForm = /* @__PURE__ */ __name(async (body, fetch2, stripFilenames = true) => {
  if (!await supportsFormData(fetch2)) {
    throw new TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
  }
  const form = new FormData();
  await Promise.all(Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value, stripFilenames)));
  return form;
}, "createForm");
var isNamedBlob = /* @__PURE__ */ __name((value) => value instanceof Blob && "name" in value, "isNamedBlob");
var addFormValue = /* @__PURE__ */ __name(async (form, key, value, stripFilenames) => {
  if (value === void 0)
    return;
  if (value == null) {
    throw new TypeError(`Received null for "${key}"; to pass null in FormData, you must use the string 'null'`);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    form.append(key, String(value));
  } else if (value instanceof Response) {
    let options = {};
    const contentType = value.headers.get("Content-Type");
    if (contentType) {
      options = { type: contentType };
    }
    form.append(key, makeFile([await value.blob()], getName(value, stripFilenames), options));
  } else if (isAsyncIterable(value)) {
    form.append(key, makeFile([await new Response(ReadableStreamFrom(value)).blob()], getName(value, stripFilenames)));
  } else if (isNamedBlob(value)) {
    form.append(key, makeFile([value], getName(value, stripFilenames), { type: value.type }));
  } else if (Array.isArray(value)) {
    await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry, stripFilenames)));
  } else if (typeof value === "object") {
    await Promise.all(Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop, stripFilenames)));
  } else {
    throw new TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`);
  }
}, "addFormValue");

// node_modules/@anthropic-ai/sdk/internal/to-file.mjs
var isBlobLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function", "isBlobLike");
var isFileLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value), "isFileLike");
var isResponseLike = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function", "isResponseLike");
async function toFile(value, name, options) {
  checkFileSupport();
  value = await value;
  name || (name = getName(value, true));
  if (isFileLike(value)) {
    if (value instanceof File && name == null && options == null) {
      return value;
    }
    return makeFile([await value.arrayBuffer()], name ?? value.name, {
      type: value.type,
      lastModified: value.lastModified,
      ...options
    });
  }
  if (isResponseLike(value)) {
    const blob = await value.blob();
    name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
    return makeFile(await getBytes(blob), name, options);
  }
  const parts = await getBytes(value);
  if (!options?.type) {
    const type = parts.find((part) => typeof part === "object" && "type" in part && part.type);
    if (typeof type === "string") {
      options = { ...options, type };
    }
  }
  return makeFile(parts, name, options);
}
__name(toFile, "toFile");
async function getBytes(value) {
  let parts = [];
  if (typeof value === "string" || ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
  value instanceof ArrayBuffer) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(value instanceof Blob ? value : await value.arrayBuffer());
  } else if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      parts.push(...await getBytes(chunk));
    }
  } else {
    const constructor = value?.constructor?.name;
    throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
  }
  return parts;
}
__name(getBytes, "getBytes");
function propsForError(value) {
  if (typeof value !== "object" || value === null)
    return "";
  const props = Object.getOwnPropertyNames(value);
  return `; props: [${props.map((p) => `"${p}"`).join(", ")}]`;
}
__name(propsForError, "propsForError");

// node_modules/@anthropic-ai/sdk/resources/index.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/shared.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/core/resource.mjs
init_esm();
var APIResource = class {
  static {
    __name(this, "APIResource");
  }
  constructor(client) {
    this._client = client;
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/environments.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/headers.mjs
init_esm();
var brand_privateNullableHeaders = Symbol.for("brand.privateNullableHeaders");
function* iterateHeaders(headers) {
  if (!headers)
    return;
  if (brand_privateNullableHeaders in headers) {
    const { values, nulls } = headers;
    yield* values.entries();
    for (const name of nulls) {
      yield [name, null];
    }
    return;
  }
  let shouldClear = false;
  let iter;
  if (headers instanceof Headers) {
    iter = headers.entries();
  } else if (isReadonlyArray(headers)) {
    iter = headers;
  } else {
    shouldClear = true;
    iter = Object.entries(headers ?? {});
  }
  for (let row of iter) {
    const name = row[0];
    if (typeof name !== "string")
      throw new TypeError("expected header name to be a string");
    const values = isReadonlyArray(row[1]) ? row[1] : [row[1]];
    let didClear = false;
    for (const value of values) {
      if (value === void 0)
        continue;
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, null];
      }
      yield [name, value];
    }
  }
}
__name(iterateHeaders, "iterateHeaders");
var buildHeaders = /* @__PURE__ */ __name((newHeaders) => {
  const targetHeaders = new Headers();
  const nullHeaders = /* @__PURE__ */ new Set();
  for (const headers of newHeaders) {
    const seenHeaders = /* @__PURE__ */ new Set();
    for (const [name, value] of iterateHeaders(headers)) {
      const lowerName = name.toLowerCase();
      if (!seenHeaders.has(lowerName)) {
        targetHeaders.delete(name);
        seenHeaders.add(lowerName);
      }
      if (value === null) {
        targetHeaders.delete(name);
        nullHeaders.add(lowerName);
      } else {
        targetHeaders.append(name, value);
        nullHeaders.delete(lowerName);
      }
    }
  }
  return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
}, "buildHeaders");

// node_modules/@anthropic-ai/sdk/internal/utils/path.mjs
init_esm();
function encodeURIPath(str) {
  return str.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
__name(encodeURIPath, "encodeURIPath");
var EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
var createPathTagFunction = /* @__PURE__ */ __name((pathEncoder = encodeURIPath) => /* @__PURE__ */ __name(function path2(statics, ...params) {
  if (statics.length === 1)
    return statics[0];
  let postPath = false;
  const invalidSegments = [];
  const path3 = statics.reduce((previousValue, currentValue, index) => {
    if (/[?#]/.test(currentValue)) {
      postPath = true;
    }
    const value = params[index];
    let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
    if (index !== params.length && (value == null || typeof value === "object" && // handle values from other realms
    value.toString === Object.getPrototypeOf(Object.getPrototypeOf(value.hasOwnProperty ?? EMPTY) ?? EMPTY)?.toString)) {
      encoded = value + "";
      invalidSegments.push({
        start: previousValue.length + currentValue.length,
        length: encoded.length,
        error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
      });
    }
    return previousValue + currentValue + (index === params.length ? "" : encoded);
  }, "");
  const pathOnly = path3.split(/[?#]/, 1)[0];
  const invalidSegmentPattern = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
  let match;
  while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) {
    invalidSegments.push({
      start: match.index,
      length: match[0].length,
      error: `Value "${match[0]}" can't be safely passed as a path parameter`
    });
  }
  invalidSegments.sort((a, b) => a.start - b.start);
  if (invalidSegments.length > 0) {
    let lastEnd = 0;
    const underline = invalidSegments.reduce((acc, segment) => {
      const spaces = " ".repeat(segment.start - lastEnd);
      const arrows = "^".repeat(segment.length);
      lastEnd = segment.start + segment.length;
      return acc + spaces + arrows;
    }, "");
    throw new AnthropicError(`Path parameters result in path with invalid segments:
${invalidSegments.map((e) => e.error).join("\n")}
${path3}
${underline}`);
  }
  return path3;
}, "path"), "createPathTagFunction");
var path = /* @__PURE__ */ createPathTagFunction(encodeURIPath);

// node_modules/@anthropic-ai/sdk/resources/beta/environments.mjs
var Environments = class extends APIResource {
  static {
    __name(this, "Environments");
  }
  /**
   * Create a new environment with the specified configuration.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.create({
   *     name: 'python-data-analysis',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/environments?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Retrieve a specific environment by ID.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.retrieve(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  retrieve(environmentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/environments/${environmentID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update an existing environment's configuration.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.update(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  update(environmentID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/environments/${environmentID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List environments with pagination support.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaEnvironment of client.beta.environments.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/environments?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete an environment by ID. Returns a confirmation of the deletion.
   *
   * @example
   * ```ts
   * const betaEnvironmentDeleteResponse =
   *   await client.beta.environments.delete(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  delete(environmentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/environments/${environmentID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive an environment by ID. Archived environments cannot be used to create new
   * sessions.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.archive(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  archive(environmentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/environments/${environmentID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/files.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/lib/stainless-helper-header.mjs
init_esm();
var SDK_HELPER_SYMBOL = Symbol("anthropic.sdk.stainlessHelper");
function wasCreatedByStainlessHelper(value) {
  return typeof value === "object" && value !== null && SDK_HELPER_SYMBOL in value;
}
__name(wasCreatedByStainlessHelper, "wasCreatedByStainlessHelper");
function collectStainlessHelpers(tools, messages) {
  const helpers = /* @__PURE__ */ new Set();
  if (tools) {
    for (const tool of tools) {
      if (wasCreatedByStainlessHelper(tool)) {
        helpers.add(tool[SDK_HELPER_SYMBOL]);
      }
    }
  }
  if (messages) {
    for (const message of messages) {
      if (wasCreatedByStainlessHelper(message)) {
        helpers.add(message[SDK_HELPER_SYMBOL]);
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (wasCreatedByStainlessHelper(block)) {
            helpers.add(block[SDK_HELPER_SYMBOL]);
          }
        }
      }
    }
  }
  return Array.from(helpers);
}
__name(collectStainlessHelpers, "collectStainlessHelpers");
function stainlessHelperHeader(tools, messages) {
  const helpers = collectStainlessHelpers(tools, messages);
  if (helpers.length === 0)
    return {};
  return { "x-stainless-helper": helpers.join(", ") };
}
__name(stainlessHelperHeader, "stainlessHelperHeader");
function stainlessHelperHeaderFromFile(file) {
  if (wasCreatedByStainlessHelper(file)) {
    return { "x-stainless-helper": file[SDK_HELPER_SYMBOL] };
  }
  return {};
}
__name(stainlessHelperHeaderFromFile, "stainlessHelperHeaderFromFile");

// node_modules/@anthropic-ai/sdk/resources/beta/files.mjs
var Files = class extends APIResource {
  static {
    __name(this, "Files");
  }
  /**
   * List Files
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const fileMetadata of client.beta.files.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/files?beta=true", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete File
   *
   * @example
   * ```ts
   * const deletedFile = await client.beta.files.delete(
   *   'file_id',
   * );
   * ```
   */
  delete(fileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/files/${fileID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Download File
   *
   * @example
   * ```ts
   * const response = await client.beta.files.download(
   *   'file_id',
   * );
   *
   * const content = await response.blob();
   * console.log(content);
   * ```
   */
  download(fileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/files/${fileID}/content?beta=true`, {
      ...options,
      headers: buildHeaders([
        {
          "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString(),
          Accept: "application/binary"
        },
        options?.headers
      ]),
      __binaryResponse: true
    });
  }
  /**
   * Get File Metadata
   *
   * @example
   * ```ts
   * const fileMetadata =
   *   await client.beta.files.retrieveMetadata('file_id');
   * ```
   */
  retrieveMetadata(fileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/files/${fileID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Upload File
   *
   * @example
   * ```ts
   * const fileMetadata = await client.beta.files.upload({
   *   file: fs.createReadStream('path/to/file'),
   * });
   * ```
   */
  upload(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/files?beta=true", multipartFormRequestOptions({
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        stainlessHelperHeaderFromFile(body.file),
        options?.headers
      ])
    }, this._client));
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/models.mjs
init_esm();
var Models = class extends APIResource {
  static {
    __name(this, "Models");
  }
  /**
   * Get a specific model.
   *
   * The Models API response can be used to determine information about a specific
   * model or resolve a model alias to a model ID.
   *
   * @example
   * ```ts
   * const betaModelInfo = await client.beta.models.retrieve(
   *   'model_id',
   * );
   * ```
   */
  retrieve(modelID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/models/${modelID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
  /**
   * List available models.
   *
   * The Models API response can be used to determine which models are available for
   * use in the API. More recently released models are listed first.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaModelInfo of client.beta.models.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/models?beta=true", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs
init_esm();
var UserProfiles = class extends APIResource {
  static {
    __name(this, "UserProfiles");
  }
  /**
   * Create User Profile
   *
   * @example
   * ```ts
   * const betaUserProfile =
   *   await client.beta.userProfiles.create();
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/user_profiles?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get User Profile
   *
   * @example
   * ```ts
   * const betaUserProfile =
   *   await client.beta.userProfiles.retrieve(
   *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
   *   );
   * ```
   */
  retrieve(userProfileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/user_profiles/${userProfileID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update User Profile
   *
   * @example
   * ```ts
   * const betaUserProfile =
   *   await client.beta.userProfiles.update(
   *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
   *   );
   * ```
   */
  update(userProfileID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/user_profiles/${userProfileID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List User Profiles
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaUserProfile of client.beta.userProfiles.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/user_profiles?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Create Enrollment URL
   *
   * @example
   * ```ts
   * const betaUserProfileEnrollmentURL =
   *   await client.beta.userProfiles.createEnrollmentURL(
   *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
   *   );
   * ```
   */
  createEnrollmentURL(userProfileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/user_profiles/${userProfileID}/enrollment_url?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs
init_esm();
var Versions = class extends APIResource {
  static {
    __name(this, "Versions");
  }
  /**
   * List Agent Versions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsAgent of client.beta.agents.versions.list(
   *   'agent_011CZkYpogX7uDKUyvBTophP',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(agentID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/agents/${agentID}/versions?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs
var Agents = class extends APIResource {
  static {
    __name(this, "Agents");
  }
  constructor() {
    super(...arguments);
    this.versions = new Versions(this._client);
  }
  /**
   * Create Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.create({
   *     model: 'claude-sonnet-4-6',
   *     name: 'My First Agent',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/agents?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.retrieve(
   *     'agent_011CZkYpogX7uDKUyvBTophP',
   *   );
   * ```
   */
  retrieve(agentID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.get(path`/v1/agents/${agentID}?beta=true`, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.update(
   *     'agent_011CZkYpogX7uDKUyvBTophP',
   *     { version: 1 },
   *   );
   * ```
   */
  update(agentID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/agents/${agentID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Agents
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsAgent of client.beta.agents.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/agents?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.archive(
   *     'agent_011CZkYpogX7uDKUyvBTophP',
   *   );
   * ```
   */
  archive(agentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/agents/${agentID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
Agents.Versions = Versions;

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memories.mjs
init_esm();
var Memories = class extends APIResource {
  static {
    __name(this, "Memories");
  }
  /**
   * CreateMemory
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemory =
   *   await client.beta.memoryStores.memories.create(
   *     'memory_store_id',
   *     { content: 'content', path: 'xx' },
   *   );
   * ```
   */
  create(memoryStoreID, params, options) {
    const { view, betas, ...body } = params;
    return this._client.post(path`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, {
      query: { view },
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * GetMemory
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemory =
   *   await client.beta.memoryStores.memories.retrieve(
   *     'memory_id',
   *     { memory_store_id: 'memory_store_id' },
   *   );
   * ```
   */
  retrieve(memoryID, params, options) {
    const { memory_store_id, betas, ...query } = params;
    return this._client.get(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * UpdateMemory
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemory =
   *   await client.beta.memoryStores.memories.update(
   *     'memory_id',
   *     { memory_store_id: 'memory_store_id' },
   *   );
   * ```
   */
  update(memoryID, params, options) {
    const { memory_store_id, view, betas, ...body } = params;
    return this._client.post(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
      query: { view },
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * ListMemories
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsMemoryListItem of client.beta.memoryStores.memories.list(
   *   'memory_store_id',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(memoryStoreID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * DeleteMemory
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedMemory =
   *   await client.beta.memoryStores.memories.delete(
   *     'memory_id',
   *     { memory_store_id: 'memory_store_id' },
   *   );
   * ```
   */
  delete(memoryID, params, options) {
    const { memory_store_id, expected_content_sha256, betas } = params;
    return this._client.delete(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
      query: { expected_content_sha256 },
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions.mjs
init_esm();
var MemoryVersions = class extends APIResource {
  static {
    __name(this, "MemoryVersions");
  }
  /**
   * GetMemoryVersion
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemoryVersion =
   *   await client.beta.memoryStores.memoryVersions.retrieve(
   *     'memory_version_id',
   *     { memory_store_id: 'memory_store_id' },
   *   );
   * ```
   */
  retrieve(memoryVersionID, params, options) {
    const { memory_store_id, betas, ...query } = params;
    return this._client.get(path`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}?beta=true`, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * ListMemoryVersions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsMemoryVersion of client.beta.memoryStores.memoryVersions.list(
   *   'memory_store_id',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(memoryStoreID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/memory_stores/${memoryStoreID}/memory_versions?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * RedactMemoryVersion
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemoryVersion =
   *   await client.beta.memoryStores.memoryVersions.redact(
   *     'memory_version_id',
   *     { memory_store_id: 'memory_store_id' },
   *   );
   * ```
   */
  redact(memoryVersionID, params, options) {
    const { memory_store_id, betas } = params;
    return this._client.post(path`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}/redact?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs
var MemoryStores = class extends APIResource {
  static {
    __name(this, "MemoryStores");
  }
  constructor() {
    super(...arguments);
    this.memories = new Memories(this._client);
    this.memoryVersions = new MemoryVersions(this._client);
  }
  /**
   * CreateMemoryStore
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemoryStore =
   *   await client.beta.memoryStores.create({ name: 'x' });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/memory_stores?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * GetMemoryStore
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemoryStore =
   *   await client.beta.memoryStores.retrieve(
   *     'memory_store_id',
   *   );
   * ```
   */
  retrieve(memoryStoreID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * UpdateMemoryStore
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemoryStore =
   *   await client.beta.memoryStores.update('memory_store_id');
   * ```
   */
  update(memoryStoreID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * ListMemoryStores
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsMemoryStore of client.beta.memoryStores.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/memory_stores?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * DeleteMemoryStore
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedMemoryStore =
   *   await client.beta.memoryStores.delete('memory_store_id');
   * ```
   */
  delete(memoryStoreID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * ArchiveMemoryStore
   *
   * @example
   * ```ts
   * const betaManagedAgentsMemoryStore =
   *   await client.beta.memoryStores.archive('memory_store_id');
   * ```
   */
  archive(memoryStoreID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/memory_stores/${memoryStoreID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
MemoryStores.Memories = Memories;
MemoryStores.MemoryVersions = MemoryVersions;

// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/error.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/constants.mjs
init_esm();
var MODEL_NONSTREAMING_TOKENS = {
  "claude-opus-4-20250514": 8192,
  "claude-opus-4-0": 8192,
  "claude-4-opus-20250514": 8192,
  "anthropic.claude-opus-4-20250514-v1:0": 8192,
  "claude-opus-4@20250514": 8192,
  "claude-opus-4-1-20250805": 8192,
  "anthropic.claude-opus-4-1-20250805-v1:0": 8192,
  "claude-opus-4-1@20250805": 8192
};

// node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs
init_esm();
function getOutputFormat(params) {
  return params?.output_format ?? params?.output_config?.format;
}
__name(getOutputFormat, "getOutputFormat");
function maybeParseBetaMessage(message, params, opts) {
  const outputFormat = getOutputFormat(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return Object.defineProperty(parsedBlock, "parsed", {
            get() {
              opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
              return null;
            },
            enumerable: false
          });
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseBetaMessage(message, params, opts);
}
__name(maybeParseBetaMessage, "maybeParseBetaMessage");
function parseBetaMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseBetaOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return Object.defineProperty(parsedBlock, "parsed", {
        get() {
          opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
          return parsedOutput;
        },
        enumerable: false
      });
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
__name(parseBetaMessage, "parseBetaMessage");
function parseBetaOutputFormat(params, content) {
  const outputFormat = getOutputFormat(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}
__name(parseBetaOutputFormat, "parseBetaOutputFormat");

// node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs
init_esm();
var tokenize = /* @__PURE__ */ __name((input) => {
  let current = 0;
  let tokens = [];
  while (current < input.length) {
    let char = input[current];
    if (char === "\\") {
      current++;
      continue;
    }
    if (char === "{") {
      tokens.push({
        type: "brace",
        value: "{"
      });
      current++;
      continue;
    }
    if (char === "}") {
      tokens.push({
        type: "brace",
        value: "}"
      });
      current++;
      continue;
    }
    if (char === "[") {
      tokens.push({
        type: "paren",
        value: "["
      });
      current++;
      continue;
    }
    if (char === "]") {
      tokens.push({
        type: "paren",
        value: "]"
      });
      current++;
      continue;
    }
    if (char === ":") {
      tokens.push({
        type: "separator",
        value: ":"
      });
      current++;
      continue;
    }
    if (char === ",") {
      tokens.push({
        type: "delimiter",
        value: ","
      });
      current++;
      continue;
    }
    if (char === '"') {
      let value = "";
      let danglingQuote = false;
      char = input[++current];
      while (char !== '"') {
        if (current === input.length) {
          danglingQuote = true;
          break;
        }
        if (char === "\\") {
          current++;
          if (current === input.length) {
            danglingQuote = true;
            break;
          }
          value += char + input[current];
          char = input[++current];
        } else {
          value += char;
          char = input[++current];
        }
      }
      char = input[++current];
      if (!danglingQuote) {
        tokens.push({
          type: "string",
          value
        });
      }
      continue;
    }
    let WHITESPACE = /\s/;
    if (char && WHITESPACE.test(char)) {
      current++;
      continue;
    }
    let NUMBERS = /[0-9]/;
    if (char && NUMBERS.test(char) || char === "-" || char === ".") {
      let value = "";
      if (char === "-") {
        value += char;
        char = input[++current];
      }
      while (char && NUMBERS.test(char) || char === ".") {
        value += char;
        char = input[++current];
      }
      tokens.push({
        type: "number",
        value
      });
      continue;
    }
    let LETTERS = /[a-z]/i;
    if (char && LETTERS.test(char)) {
      let value = "";
      while (char && LETTERS.test(char)) {
        if (current === input.length) {
          break;
        }
        value += char;
        char = input[++current];
      }
      if (value == "true" || value == "false" || value === "null") {
        tokens.push({
          type: "name",
          value
        });
      } else {
        current++;
        continue;
      }
      continue;
    }
    current++;
  }
  return tokens;
}, "tokenize");
var strip = /* @__PURE__ */ __name((tokens) => {
  if (tokens.length === 0) {
    return tokens;
  }
  let lastToken = tokens[tokens.length - 1];
  switch (lastToken.type) {
    case "separator":
      tokens = tokens.slice(0, tokens.length - 1);
      return strip(tokens);
      break;
    case "number":
      let lastCharacterOfLastToken = lastToken.value[lastToken.value.length - 1];
      if (lastCharacterOfLastToken === "." || lastCharacterOfLastToken === "-") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      }
    case "string":
      let tokenBeforeTheLastToken = tokens[tokens.length - 2];
      if (tokenBeforeTheLastToken?.type === "delimiter") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      } else if (tokenBeforeTheLastToken?.type === "brace" && tokenBeforeTheLastToken.value === "{") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      }
      break;
    case "delimiter":
      tokens = tokens.slice(0, tokens.length - 1);
      return strip(tokens);
      break;
  }
  return tokens;
}, "strip");
var unstrip = /* @__PURE__ */ __name((tokens) => {
  let tail = [];
  tokens.map((token) => {
    if (token.type === "brace") {
      if (token.value === "{") {
        tail.push("}");
      } else {
        tail.splice(tail.lastIndexOf("}"), 1);
      }
    }
    if (token.type === "paren") {
      if (token.value === "[") {
        tail.push("]");
      } else {
        tail.splice(tail.lastIndexOf("]"), 1);
      }
    }
  });
  if (tail.length > 0) {
    tail.reverse().map((item) => {
      if (item === "}") {
        tokens.push({
          type: "brace",
          value: "}"
        });
      } else if (item === "]") {
        tokens.push({
          type: "paren",
          value: "]"
        });
      }
    });
  }
  return tokens;
}, "unstrip");
var generate = /* @__PURE__ */ __name((tokens) => {
  let output = "";
  tokens.map((token) => {
    switch (token.type) {
      case "string":
        output += '"' + token.value + '"';
        break;
      default:
        output += token.value;
        break;
    }
  });
  return output;
}, "generate");
var partialParse = /* @__PURE__ */ __name((input) => JSON.parse(generate(unstrip(strip(tokenize(input))))), "partialParse");

// node_modules/@anthropic-ai/sdk/streaming.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
var _BetaMessageStream_instances;
var _BetaMessageStream_currentMessageSnapshot;
var _BetaMessageStream_params;
var _BetaMessageStream_connectedPromise;
var _BetaMessageStream_resolveConnectedPromise;
var _BetaMessageStream_rejectConnectedPromise;
var _BetaMessageStream_endPromise;
var _BetaMessageStream_resolveEndPromise;
var _BetaMessageStream_rejectEndPromise;
var _BetaMessageStream_listeners;
var _BetaMessageStream_ended;
var _BetaMessageStream_errored;
var _BetaMessageStream_aborted;
var _BetaMessageStream_catchingPromiseCreated;
var _BetaMessageStream_response;
var _BetaMessageStream_request_id;
var _BetaMessageStream_logger;
var _BetaMessageStream_getFinalMessage;
var _BetaMessageStream_getFinalText;
var _BetaMessageStream_handleError;
var _BetaMessageStream_beginRequest;
var _BetaMessageStream_addStreamEvent;
var _BetaMessageStream_endRequest;
var _BetaMessageStream_accumulateMessage;
var JSON_BUF_PROPERTY = "__json_buf";
function tracksToolInput(content) {
  return content.type === "tool_use" || content.type === "server_tool_use" || content.type === "mcp_tool_use";
}
__name(tracksToolInput, "tracksToolInput");
var BetaMessageStream = class _BetaMessageStream {
  static {
    __name(this, "BetaMessageStream");
  }
  constructor(params, opts) {
    _BetaMessageStream_instances.add(this);
    this.messages = [];
    this.receivedMessages = [];
    _BetaMessageStream_currentMessageSnapshot.set(this, void 0);
    _BetaMessageStream_params.set(this, null);
    this.controller = new AbortController();
    _BetaMessageStream_connectedPromise.set(this, void 0);
    _BetaMessageStream_resolveConnectedPromise.set(this, () => {
    });
    _BetaMessageStream_rejectConnectedPromise.set(this, () => {
    });
    _BetaMessageStream_endPromise.set(this, void 0);
    _BetaMessageStream_resolveEndPromise.set(this, () => {
    });
    _BetaMessageStream_rejectEndPromise.set(this, () => {
    });
    _BetaMessageStream_listeners.set(this, {});
    _BetaMessageStream_ended.set(this, false);
    _BetaMessageStream_errored.set(this, false);
    _BetaMessageStream_aborted.set(this, false);
    _BetaMessageStream_catchingPromiseCreated.set(this, false);
    _BetaMessageStream_response.set(this, void 0);
    _BetaMessageStream_request_id.set(this, void 0);
    _BetaMessageStream_logger.set(this, void 0);
    _BetaMessageStream_handleError.set(this, (error) => {
      __classPrivateFieldSet(this, _BetaMessageStream_errored, true, "f");
      if (isAbortError(error)) {
        error = new APIUserAbortError();
      }
      if (error instanceof APIUserAbortError) {
        __classPrivateFieldSet(this, _BetaMessageStream_aborted, true, "f");
        return this._emit("abort", error);
      }
      if (error instanceof AnthropicError) {
        return this._emit("error", error);
      }
      if (error instanceof Error) {
        const anthropicError = new AnthropicError(error.message);
        anthropicError.cause = error;
        return this._emit("error", anthropicError);
      }
      return this._emit("error", new AnthropicError(String(error)));
    });
    __classPrivateFieldSet(this, _BetaMessageStream_connectedPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet(this, _BetaMessageStream_resolveConnectedPromise, resolve, "f");
      __classPrivateFieldSet(this, _BetaMessageStream_rejectConnectedPromise, reject, "f");
    }), "f");
    __classPrivateFieldSet(this, _BetaMessageStream_endPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet(this, _BetaMessageStream_resolveEndPromise, resolve, "f");
      __classPrivateFieldSet(this, _BetaMessageStream_rejectEndPromise, reject, "f");
    }), "f");
    __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f").catch(() => {
    });
    __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f").catch(() => {
    });
    __classPrivateFieldSet(this, _BetaMessageStream_params, params, "f");
    __classPrivateFieldSet(this, _BetaMessageStream_logger, opts?.logger ?? console, "f");
  }
  get response() {
    return __classPrivateFieldGet(this, _BetaMessageStream_response, "f");
  }
  get request_id() {
    return __classPrivateFieldGet(this, _BetaMessageStream_request_id, "f");
  }
  /**
   * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * This is the same as the `APIPromise.withResponse()` method.
   *
   * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
   * as no `Response` is available.
   */
  async withResponse() {
    __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
    const response = await __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f");
    if (!response) {
      throw new Error("Could not resolve a `Response` object");
    }
    return {
      data: this,
      response,
      request_id: response.headers.get("request-id")
    };
  }
  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream) {
    const runner = new _BetaMessageStream(null);
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }
  static createMessage(messages, params, options, { logger: logger2 } = {}) {
    const runner = new _BetaMessageStream(params, { logger: logger2 });
    for (const message of params.messages) {
      runner._addMessageParam(message);
    }
    __classPrivateFieldSet(runner, _BetaMessageStream_params, { ...params, stream: true }, "f");
    runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, "X-Stainless-Helper-Method": "stream" } }));
    return runner;
  }
  _run(executor) {
    executor().then(() => {
      this._emitFinal();
      this._emit("end");
    }, __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f"));
  }
  _addMessageParam(message) {
    this.messages.push(message);
  }
  _addMessage(message, emit = true) {
    this.receivedMessages.push(message);
    if (emit) {
      this._emit("message", message);
    }
  }
  async _createMessage(messages, params, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
      const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
      this._connected(response);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  _connected(response) {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _BetaMessageStream_response, response, "f");
    __classPrivateFieldSet(this, _BetaMessageStream_request_id, response?.headers.get("request-id"), "f");
    __classPrivateFieldGet(this, _BetaMessageStream_resolveConnectedPromise, "f").call(this, response);
    this._emit("connect");
  }
  get ended() {
    return __classPrivateFieldGet(this, _BetaMessageStream_ended, "f");
  }
  get errored() {
    return __classPrivateFieldGet(this, _BetaMessageStream_errored, "f");
  }
  get aborted() {
    return __classPrivateFieldGet(this, _BetaMessageStream_aborted, "f");
  }
  abort() {
    this.controller.abort();
  }
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this MessageStream, so that calls can be chained
   */
  on(event, listener) {
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this MessageStream, so that calls can be chained
   */
  off(event, listener) {
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
    if (!listeners)
      return this;
    const index = listeners.findIndex((l) => l.listener === listener);
    if (index >= 0)
      listeners.splice(index, 1);
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this MessageStream, so that calls can be chained
   */
  once(event, listener) {
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
    listeners.push({ listener, once: true });
    return this;
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * @returns a Promise that resolves the next time given event is triggered,
   * or rejects if an error is emitted.  (If you request the 'error' event,
   * returns a promise that resolves with the error).
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve, reject) => {
      __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
      if (event !== "error")
        this.once("error", reject);
      this.once(event, resolve);
    });
  }
  async done() {
    __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
    await __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f");
  }
  get currentMessage() {
    return __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
  }
  /**
   * @returns a promise that resolves with the the final assistant Message response,
   * or rejects if an error occurred or the stream ended prematurely without producing a Message.
   * If structured outputs were used, this will be a ParsedMessage with a `parsed` field.
   */
  async finalMessage() {
    await this.done();
    return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this);
  }
  /**
   * @returns a promise that resolves with the the final assistant Message's text response, concatenated
   * together if there are more than one text blocks.
   * Rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalText() {
    await this.done();
    return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalText).call(this);
  }
  _emit(event, ...args) {
    if (__classPrivateFieldGet(this, _BetaMessageStream_ended, "f"))
      return;
    if (event === "end") {
      __classPrivateFieldSet(this, _BetaMessageStream_ended, true, "f");
      __classPrivateFieldGet(this, _BetaMessageStream_resolveEndPromise, "f").call(this);
    }
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
    if (listeners) {
      __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
      listeners.forEach(({ listener }) => listener(...args));
    }
    if (event === "abort") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
      return;
    }
    if (event === "error") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
    }
  }
  _emitFinal() {
    const finalMessage = this.receivedMessages.at(-1);
    if (finalMessage) {
      this._emit("finalMessage", __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this));
    }
  }
  async _fromReadableStream(readableStream, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
      this._connected(null);
      const stream = Stream.fromReadableStream(readableStream, this.controller);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  [(_BetaMessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_params = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_listeners = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_ended = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_errored = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_aborted = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_response = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_request_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_logger = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_handleError = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_instances = /* @__PURE__ */ new WeakSet(), _BetaMessageStream_getFinalMessage = /* @__PURE__ */ __name(function _BetaMessageStream_getFinalMessage2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    return this.receivedMessages.at(-1);
  }, "_BetaMessageStream_getFinalMessage"), _BetaMessageStream_getFinalText = /* @__PURE__ */ __name(function _BetaMessageStream_getFinalText2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
    if (textBlocks.length === 0) {
      throw new AnthropicError("stream ended without producing a content block with type=text");
    }
    return textBlocks.join(" ");
  }, "_BetaMessageStream_getFinalText"), _BetaMessageStream_beginRequest = /* @__PURE__ */ __name(function _BetaMessageStream_beginRequest2() {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
  }, "_BetaMessageStream_beginRequest"), _BetaMessageStream_addStreamEvent = /* @__PURE__ */ __name(function _BetaMessageStream_addStreamEvent2(event) {
    if (this.ended)
      return;
    const messageSnapshot = __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_accumulateMessage).call(this, event);
    this._emit("streamEvent", event, messageSnapshot);
    switch (event.type) {
      case "content_block_delta": {
        const content = messageSnapshot.content.at(-1);
        switch (event.delta.type) {
          case "text_delta": {
            if (content.type === "text") {
              this._emit("text", event.delta.text, content.text || "");
            }
            break;
          }
          case "citations_delta": {
            if (content.type === "text") {
              this._emit("citation", event.delta.citation, content.citations ?? []);
            }
            break;
          }
          case "input_json_delta": {
            if (tracksToolInput(content) && content.input) {
              this._emit("inputJson", event.delta.partial_json, content.input);
            }
            break;
          }
          case "thinking_delta": {
            if (content.type === "thinking") {
              this._emit("thinking", event.delta.thinking, content.thinking);
            }
            break;
          }
          case "signature_delta": {
            if (content.type === "thinking") {
              this._emit("signature", content.signature);
            }
            break;
          }
          case "compaction_delta": {
            if (content.type === "compaction" && content.content) {
              this._emit("compaction", content.content);
            }
            break;
          }
          default:
            checkNever(event.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(messageSnapshot);
        this._addMessage(maybeParseBetaMessage(messageSnapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", messageSnapshot.content.at(-1));
        break;
      }
      case "message_start": {
        __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, messageSnapshot, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, "_BetaMessageStream_addStreamEvent"), _BetaMessageStream_endRequest = /* @__PURE__ */ __name(function _BetaMessageStream_endRequest2() {
    if (this.ended) {
      throw new AnthropicError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
    if (!snapshot) {
      throw new AnthropicError(`request ended without sending any chunks`);
    }
    __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
    return maybeParseBetaMessage(snapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") });
  }, "_BetaMessageStream_endRequest"), _BetaMessageStream_accumulateMessage = /* @__PURE__ */ __name(function _BetaMessageStream_accumulateMessage2(event) {
    let snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
    if (event.type === "message_start") {
      if (snapshot) {
        throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
      }
      return event.message;
    }
    if (!snapshot) {
      throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_stop":
        return snapshot;
      case "message_delta":
        snapshot.container = event.delta.container;
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        snapshot.context_management = event.context_management;
        if (event.usage.input_tokens != null) {
          snapshot.usage.input_tokens = event.usage.input_tokens;
        }
        if (event.usage.cache_creation_input_tokens != null) {
          snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage.cache_read_input_tokens != null) {
          snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage.server_tool_use != null) {
          snapshot.usage.server_tool_use = event.usage.server_tool_use;
        }
        if (event.usage.iterations != null) {
          snapshot.usage.iterations = event.usage.iterations;
        }
        return snapshot;
      case "content_block_start":
        snapshot.content.push(event.content_block);
        return snapshot;
      case "content_block_delta": {
        const snapshotContent = snapshot.content.at(event.index);
        switch (event.delta.type) {
          case "text_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                text: (snapshotContent.text || "") + event.delta.text
              };
            }
            break;
          }
          case "citations_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                citations: [...snapshotContent.citations ?? [], event.delta.citation]
              };
            }
            break;
          }
          case "input_json_delta": {
            if (snapshotContent && tracksToolInput(snapshotContent)) {
              let jsonBuf = snapshotContent[JSON_BUF_PROPERTY] || "";
              jsonBuf += event.delta.partial_json;
              const newContent = { ...snapshotContent };
              Object.defineProperty(newContent, JSON_BUF_PROPERTY, {
                value: jsonBuf,
                enumerable: false,
                writable: true
              });
              if (jsonBuf) {
                try {
                  newContent.input = partialParse(jsonBuf);
                } catch (err) {
                  const error = new AnthropicError(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${err}. JSON: ${jsonBuf}`);
                  __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, error);
                }
              }
              snapshot.content[event.index] = newContent;
            }
            break;
          }
          case "thinking_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                thinking: snapshotContent.thinking + event.delta.thinking
              };
            }
            break;
          }
          case "signature_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                signature: event.delta.signature
              };
            }
            break;
          }
          case "compaction_delta": {
            if (snapshotContent?.type === "compaction") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                content: (snapshotContent.content || "") + event.delta.content
              };
            }
            break;
          }
          default:
            checkNever(event.delta);
        }
        return snapshot;
      }
      case "content_block_stop":
        return snapshot;
    }
  }, "_BetaMessageStream_accumulateMessage"), Symbol.asyncIterator)]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on("streamEvent", (event) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(event);
      } else {
        pushQueue.push(event);
      }
    });
    this.on("end", () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(void 0);
      }
      readQueue.length = 0;
    });
    this.on("abort", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    this.on("error", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    return {
      next: /* @__PURE__ */ __name(async () => {
        if (!pushQueue.length) {
          if (done) {
            return { value: void 0, done: true };
          }
          return new Promise((resolve, reject) => readQueue.push({ resolve, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
        }
        const chunk = pushQueue.shift();
        return { value: chunk, done: false };
      }, "next"),
      return: /* @__PURE__ */ __name(async () => {
        this.abort();
        return { value: void 0, done: true };
      }, "return")
    };
  }
  toReadableStream() {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
};
function checkNever(x) {
}
__name(checkNever, "checkNever");

// node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs
init_esm();
var ToolError = class extends Error {
  static {
    __name(this, "ToolError");
  }
  constructor(content) {
    const message = typeof content === "string" ? content : content.map((block) => {
      if (block.type === "text")
        return block.text;
      return `[${block.type}]`;
    }).join(" ");
    super(message);
    this.name = "ToolError";
    this.content = content;
  }
};

// node_modules/@anthropic-ai/sdk/lib/tools/CompactionControl.mjs
init_esm();
var DEFAULT_TOKEN_THRESHOLD = 1e5;
var DEFAULT_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;

// node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs
var _BetaToolRunner_instances;
var _BetaToolRunner_consumed;
var _BetaToolRunner_mutated;
var _BetaToolRunner_state;
var _BetaToolRunner_options;
var _BetaToolRunner_message;
var _BetaToolRunner_toolResponse;
var _BetaToolRunner_completion;
var _BetaToolRunner_iterationCount;
var _BetaToolRunner_checkAndCompact;
var _BetaToolRunner_generateToolResponse;
function promiseWithResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
__name(promiseWithResolvers, "promiseWithResolvers");
var BetaToolRunner = class {
  static {
    __name(this, "BetaToolRunner");
  }
  constructor(client, params, options) {
    _BetaToolRunner_instances.add(this);
    this.client = client;
    _BetaToolRunner_consumed.set(this, false);
    _BetaToolRunner_mutated.set(this, false);
    _BetaToolRunner_state.set(this, void 0);
    _BetaToolRunner_options.set(this, void 0);
    _BetaToolRunner_message.set(this, void 0);
    _BetaToolRunner_toolResponse.set(this, void 0);
    _BetaToolRunner_completion.set(this, void 0);
    _BetaToolRunner_iterationCount.set(this, 0);
    __classPrivateFieldSet(this, _BetaToolRunner_state, {
      params: {
        // You can't clone the entire params since there are functions as handlers.
        // You also don't really need to clone params.messages, but it probably will prevent a foot gun
        // somewhere.
        ...params,
        messages: structuredClone(params.messages)
      }
    }, "f");
    const helpers = collectStainlessHelpers(params.tools, params.messages);
    const helperValue = ["BetaToolRunner", ...helpers].join(", ");
    __classPrivateFieldSet(this, _BetaToolRunner_options, {
      ...options,
      headers: buildHeaders([{ "x-stainless-helper": helperValue }, options?.headers])
    }, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
    if (params.compactionControl?.enabled) {
      console.warn('Anthropic: The `compactionControl` parameter is deprecated and will be removed in a future version. Use server-side compaction instead by passing `edits: [{ type: "compact_20260112" }]` in the params passed to `toolRunner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction');
    }
  }
  async *[(_BetaToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_mutated = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_state = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_options = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_message = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_toolResponse = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_completion = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_iterationCount = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_instances = /* @__PURE__ */ new WeakSet(), _BetaToolRunner_checkAndCompact = /* @__PURE__ */ __name(async function _BetaToolRunner_checkAndCompact2() {
    const compactionControl = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.compactionControl;
    if (!compactionControl || !compactionControl.enabled) {
      return false;
    }
    let tokensUsed = 0;
    if (__classPrivateFieldGet(this, _BetaToolRunner_message, "f") !== void 0) {
      try {
        const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
        const totalInputTokens = message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0);
        tokensUsed = totalInputTokens + message.usage.output_tokens;
      } catch {
        return false;
      }
    }
    const threshold = compactionControl.contextTokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    if (tokensUsed < threshold) {
      return false;
    }
    const model = compactionControl.model ?? __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.model;
    const summaryPrompt = compactionControl.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
    const messages = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages;
    if (messages[messages.length - 1].role === "assistant") {
      const lastMessage = messages[messages.length - 1];
      if (Array.isArray(lastMessage.content)) {
        const nonToolBlocks = lastMessage.content.filter((block) => block.type !== "tool_use");
        if (nonToolBlocks.length === 0) {
          messages.pop();
        } else {
          lastMessage.content = nonToolBlocks;
        }
      }
    }
    const response = await this.client.beta.messages.create({
      model,
      messages: [
        ...messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: summaryPrompt
            }
          ]
        }
      ],
      max_tokens: __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_tokens
    }, {
      signal: __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal,
      headers: buildHeaders([__classPrivateFieldGet(this, _BetaToolRunner_options, "f").headers, { "x-stainless-helper": "compaction" }])
    });
    if (response.content[0]?.type !== "text") {
      throw new AnthropicError("Expected text response for compaction");
    }
    __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages = [
      {
        role: "user",
        content: response.content
      }
    ];
    return true;
  }, "_BetaToolRunner_checkAndCompact"), Symbol.asyncIterator)]() {
    var _a2;
    if (__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
      throw new AnthropicError("Cannot iterate over a consumed stream");
    }
    __classPrivateFieldSet(this, _BetaToolRunner_consumed, true, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
    try {
      while (true) {
        let stream;
        try {
          if (__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations && __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f") >= __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations) {
            break;
          }
          __classPrivateFieldSet(this, _BetaToolRunner_mutated, false, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_iterationCount, (_a2 = __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f"), _a2++, _a2), "f");
          __classPrivateFieldSet(this, _BetaToolRunner_message, void 0, "f");
          const { max_iterations, compactionControl, ...params } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
          if (params.stream) {
            stream = this.client.beta.messages.stream({ ...params }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f"));
            __classPrivateFieldSet(this, _BetaToolRunner_message, stream.finalMessage(), "f");
            __classPrivateFieldGet(this, _BetaToolRunner_message, "f").catch(() => {
            });
            yield stream;
          } else {
            __classPrivateFieldSet(this, _BetaToolRunner_message, this.client.beta.messages.create({ ...params, stream: false }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
            yield __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
          }
          const isCompacted = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_checkAndCompact).call(this);
          if (!isCompacted) {
            if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
              const { role, content } = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
              __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push({ role, content });
            }
            const toolMessage = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.at(-1));
            if (toolMessage) {
              __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push(toolMessage);
            } else if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
              break;
            }
          }
        } finally {
          if (stream) {
            stream.abort();
          }
        }
      }
      if (!__classPrivateFieldGet(this, _BetaToolRunner_message, "f")) {
        throw new AnthropicError("ToolRunner concluded without a message from the server");
      }
      __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").resolve(await __classPrivateFieldGet(this, _BetaToolRunner_message, "f"));
    } catch (error) {
      __classPrivateFieldSet(this, _BetaToolRunner_consumed, false, "f");
      __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise.catch(() => {
      });
      __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").reject(error);
      __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
      throw error;
    }
  }
  setMessagesParams(paramsOrMutator) {
    if (typeof paramsOrMutator === "function") {
      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params);
    } else {
      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator;
    }
    __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
  }
  setRequestOptions(optionsOrMutator) {
    if (typeof optionsOrMutator === "function") {
      __classPrivateFieldSet(this, _BetaToolRunner_options, optionsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
    } else {
      __classPrivateFieldSet(this, _BetaToolRunner_options, { ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"), ...optionsOrMutator }, "f");
    }
  }
  /**
   * Get the tool response for the last message from the assistant.
   * Avoids redundant tool executions by caching results.
   *
   * @returns A promise that resolves to a BetaMessageParam containing tool results, or null if no tools need to be executed
   *
   * @example
   * const toolResponse = await runner.generateToolResponse();
   * if (toolResponse) {
   *   console.log('Tool results:', toolResponse.content);
   * }
   */
  async generateToolResponse(signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
    const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f") ?? this.params.messages.at(-1);
    if (!message) {
      return null;
    }
    return __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, message, signal);
  }
  /**
   * Wait for the async iterator to complete. This works even if the async iterator hasn't yet started, and
   * will wait for an instance to start and go to completion.
   *
   * @returns A promise that resolves to the final BetaMessage when the iterator completes
   *
   * @example
   * // Start consuming the iterator
   * for await (const message of runner) {
   *   console.log('Message:', message.content);
   * }
   *
   * // Meanwhile, wait for completion from another part of the code
   * const finalMessage = await runner.done();
   * console.log('Final response:', finalMessage.content);
   */
  done() {
    return __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise;
  }
  /**
   * Returns a promise indicating that the stream is done. Unlike .done(), this will eagerly read the stream:
   * * If the iterator has not been consumed, consume the entire iterator and return the final message from the
   * assistant.
   * * If the iterator has been consumed, waits for it to complete and returns the final message.
   *
   * @returns A promise that resolves to the final BetaMessage from the conversation
   * @throws {AnthropicError} If no messages were processed during the conversation
   *
   * @example
   * const finalMessage = await runner.runUntilDone();
   * console.log('Final response:', finalMessage.content);
   */
  async runUntilDone() {
    if (!__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
      for await (const _ of this) {
      }
    }
    return this.done();
  }
  /**
   * Get the current parameters being used by the ToolRunner.
   *
   * @returns A readonly view of the current ToolRunnerParams
   *
   * @example
   * const currentParams = runner.params;
   * console.log('Current model:', currentParams.model);
   * console.log('Message count:', currentParams.messages.length);
   */
  get params() {
    return __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
  }
  /**
   * Add one or more messages to the conversation history.
   *
   * @param messages - One or more BetaMessageParam objects to add to the conversation
   *
   * @example
   * runner.pushMessages(
   *   { role: 'user', content: 'Also, what about the weather in NYC?' }
   * );
   *
   * @example
   * // Adding multiple messages
   * runner.pushMessages(
   *   { role: 'user', content: 'What about NYC?' },
   *   { role: 'user', content: 'And Boston?' }
   * );
   */
  pushMessages(...messages) {
    this.setMessagesParams((params) => ({
      ...params,
      messages: [...params.messages, ...messages]
    }));
  }
  /**
   * Makes the ToolRunner directly awaitable, equivalent to calling .runUntilDone()
   * This allows using `await runner` instead of `await runner.runUntilDone()`
   */
  then(onfulfilled, onrejected) {
    return this.runUntilDone().then(onfulfilled, onrejected);
  }
};
_BetaToolRunner_generateToolResponse = /* @__PURE__ */ __name(async function _BetaToolRunner_generateToolResponse2(lastMessage, signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
  if (__classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f") !== void 0) {
    return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
  }
  __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, generateToolResponse(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params, lastMessage, {
    ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"),
    signal
  }), "f");
  return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
}, "_BetaToolRunner_generateToolResponse");
async function generateToolResponse(params, lastMessage = params.messages.at(-1), requestOptions) {
  if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.content || typeof lastMessage.content === "string") {
    return null;
  }
  const toolUseBlocks = lastMessage.content.filter((content) => content.type === "tool_use");
  if (toolUseBlocks.length === 0) {
    return null;
  }
  const toolResults = await Promise.all(toolUseBlocks.map(async (toolUse) => {
    const tool = params.tools.find((t) => ("name" in t ? t.name : t.mcp_server_name) === toolUse.name);
    if (!tool || !("run" in tool)) {
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: `Error: Tool '${toolUse.name}' not found`,
        is_error: true
      };
    }
    try {
      let input = toolUse.input;
      if ("parse" in tool && tool.parse) {
        input = tool.parse(input);
      }
      const result = await tool.run(input, {
        toolUseBlock: toolUse,
        signal: requestOptions?.signal
      });
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      };
    } catch (error) {
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: error instanceof ToolError ? error.content : `Error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
    }
  }));
  return {
    role: "user",
    content: toolResults
  };
}
__name(generateToolResponse, "generateToolResponse");

// node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs
init_esm();
var JSONLDecoder = class _JSONLDecoder {
  static {
    __name(this, "JSONLDecoder");
  }
  constructor(iterator, controller) {
    this.iterator = iterator;
    this.controller = controller;
  }
  async *decoder() {
    const lineDecoder = new LineDecoder();
    for await (const chunk of this.iterator) {
      for (const line of lineDecoder.decode(chunk)) {
        yield JSON.parse(line);
      }
    }
    for (const line of lineDecoder.flush()) {
      yield JSON.parse(line);
    }
  }
  [Symbol.asyncIterator]() {
    return this.decoder();
  }
  static fromResponse(response, controller) {
    if (!response.body) {
      controller.abort();
      if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
        throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
      }
      throw new AnthropicError(`Attempted to iterate over a response with no body`);
    }
    return new _JSONLDecoder(ReadableStreamToAsyncIterable(response.body), controller);
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
var Batches = class extends APIResource {
  static {
    __name(this, "Batches");
  }
  /**
   * Send a batch of Message creation requests.
   *
   * The Message Batches API can be used to process multiple Messages API requests at
   * once. Once a Message Batch is created, it begins processing immediately. Batches
   * can take up to 24 hours to complete.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatch =
   *   await client.beta.messages.batches.create({
   *     requests: [
   *       {
   *         custom_id: 'my-custom-id-1',
   *         params: {
   *           max_tokens: 1024,
   *           messages: [
   *             { content: 'Hello, world', role: 'user' },
   *           ],
   *           model: 'claude-opus-4-6',
   *         },
   *       },
   *     ],
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/messages/batches?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * This endpoint is idempotent and can be used to poll for Message Batch
   * completion. To access the results of a Message Batch, make a request to the
   * `results_url` field in the response.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatch =
   *   await client.beta.messages.batches.retrieve(
   *     'message_batch_id',
   *   );
   * ```
   */
  retrieve(messageBatchID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List all Message Batches within a Workspace. Most recently created batches are
   * returned first.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaMessageBatch of client.beta.messages.batches.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/messages/batches?beta=true", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete a Message Batch.
   *
   * Message Batches can only be deleted once they've finished processing. If you'd
   * like to delete an in-progress batch, you must first cancel it.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaDeletedMessageBatch =
   *   await client.beta.messages.batches.delete(
   *     'message_batch_id',
   *   );
   * ```
   */
  delete(messageBatchID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Batches may be canceled any time before processing ends. Once cancellation is
   * initiated, the batch enters a `canceling` state, at which time the system may
   * complete any in-progress, non-interruptible requests before finalizing
   * cancellation.
   *
   * The number of canceled requests is specified in `request_counts`. To determine
   * which requests were canceled, check the individual results within the batch.
   * Note that cancellation may not result in any canceled requests if they were
   * non-interruptible.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatch =
   *   await client.beta.messages.batches.cancel(
   *     'message_batch_id',
   *   );
   * ```
   */
  cancel(messageBatchID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Streams the results of a Message Batch as a `.jsonl` file.
   *
   * Each line in the file is a JSON object containing the result of a single request
   * in the Message Batch. Results are not guaranteed to be in the same order as
   * requests. Use the `custom_id` field to match results to requests.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatchIndividualResponse =
   *   await client.beta.messages.batches.results(
   *     'message_batch_id',
   *   );
   * ```
   */
  async results(messageBatchID, params = {}, options) {
    const batch = await this.retrieve(messageBatchID);
    if (!batch.results_url) {
      throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
    }
    const { betas } = params ?? {};
    return this._client.get(batch.results_url, {
      ...options,
      headers: buildHeaders([
        {
          "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
          Accept: "application/binary"
        },
        options?.headers
      ]),
      stream: true,
      __binaryResponse: true
    })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
var DEPRECATED_MODELS = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-3-opus-20240229": "January 5th, 2026",
  "claude-2.1": "July 21st, 2025",
  "claude-2.0": "July 21st, 2025",
  "claude-3-7-sonnet-latest": "February 19th, 2026",
  "claude-3-7-sonnet-20250219": "February 19th, 2026"
};
var MODELS_TO_WARN_WITH_THINKING_ENABLED = ["claude-mythos-preview", "claude-opus-4-6"];
var Messages = class extends APIResource {
  static {
    __name(this, "Messages");
  }
  constructor() {
    super(...arguments);
    this.batches = new Batches(this._client);
  }
  create(params, options) {
    const modifiedParams = transformOutputFormat(params);
    const { betas, ...body } = modifiedParams;
    if (body.model in DEPRECATED_MODELS) {
      console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    }
    if (MODELS_TO_WARN_WITH_THINKING_ENABLED.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
      console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    }
    let timeout = this._client._options.timeout;
    if (!body.stream && timeout == null) {
      const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
      timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
    }
    const helperHeader = stainlessHelperHeader(body.tools, body.messages);
    return this._client.post("/v1/messages?beta=true", {
      body,
      timeout: timeout ?? 6e5,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        helperHeader,
        options?.headers
      ]),
      stream: modifiedParams.stream ?? false
    });
  }
  /**
   * Send a structured list of input messages with text and/or image content, along with an expected `output_format` and
   * the response will be automatically parsed and available in the `parsed_output` property of the message.
   *
   * @example
   * ```ts
   * const message = await client.beta.messages.parse({
   *   model: 'claude-3-5-sonnet-20241022',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'What is 2+2?' }],
   *   output_format: zodOutputFormat(z.object({ answer: z.number() }), 'math'),
   * });
   *
   * console.log(message.parsed_output?.answer); // 4
   * ```
   */
  parse(params, options) {
    options = {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...params.betas ?? [], "structured-outputs-2025-12-15"].toString() },
        options?.headers
      ])
    };
    return this.create(params, options).then((message) => parseBetaMessage(message, params, { logger: this._client.logger ?? console }));
  }
  /**
   * Create a Message stream
   */
  stream(body, options) {
    return BetaMessageStream.createMessage(this, body, options);
  }
  /**
   * Count the number of tokens in a Message.
   *
   * The Token Count API can be used to count the number of tokens in a Message,
   * including tools, images, and documents, without creating it.
   *
   * Learn more about token counting in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)
   *
   * @example
   * ```ts
   * const betaMessageTokensCount =
   *   await client.beta.messages.countTokens({
   *     messages: [{ content: 'Hello, world', role: 'user' }],
   *     model: 'claude-opus-4-6',
   *   });
   * ```
   */
  countTokens(params, options) {
    const modifiedParams = transformOutputFormat(params);
    const { betas, ...body } = modifiedParams;
    return this._client.post("/v1/messages/count_tokens?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "token-counting-2024-11-01"].toString() },
        options?.headers
      ])
    });
  }
  toolRunner(body, options) {
    return new BetaToolRunner(this._client, body, options);
  }
};
function transformOutputFormat(params) {
  if (!params.output_format) {
    return params;
  }
  if (params.output_config?.format) {
    throw new AnthropicError("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
  }
  const { output_format, ...rest } = params;
  return {
    ...rest,
    output_config: {
      ...params.output_config,
      format: output_format
    }
  };
}
__name(transformOutputFormat, "transformOutputFormat");
Messages.Batches = Batches;
Messages.BetaToolRunner = BetaToolRunner;
Messages.ToolError = ToolError;

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs
init_esm();
var Events = class extends APIResource {
  static {
    __name(this, "Events");
  }
  /**
   * List Events
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsSessionEvent of client.beta.sessions.events.list(
   *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(sessionID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/sessions/${sessionID}/events?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Send Events
   *
   * @example
   * ```ts
   * const betaManagedAgentsSendSessionEvents =
   *   await client.beta.sessions.events.send(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *     {
   *       events: [
   *         {
   *           content: [
   *             {
   *               text: 'Where is my order #1234?',
   *               type: 'text',
   *             },
   *           ],
   *           type: 'user.message',
   *         },
   *       ],
   *     },
   *   );
   * ```
   */
  send(sessionID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${sessionID}/events?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Stream Events
   *
   * @example
   * ```ts
   * const betaManagedAgentsStreamSessionEvents =
   *   await client.beta.sessions.events.stream(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  stream(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/sessions/${sessionID}/events/stream?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ]),
      stream: true
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs
init_esm();
var Resources = class extends APIResource {
  static {
    __name(this, "Resources");
  }
  /**
   * Get Session Resource
   *
   * @example
   * ```ts
   * const resource =
   *   await client.beta.sessions.resources.retrieve(
   *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
   *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
   *   );
   * ```
   */
  retrieve(resourceID, params, options) {
    const { session_id, betas } = params;
    return this._client.get(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Session Resource
   *
   * @example
   * ```ts
   * const resource =
   *   await client.beta.sessions.resources.update(
   *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
   *     {
   *       session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *       authorization_token: 'ghp_exampletoken',
   *     },
   *   );
   * ```
   */
  update(resourceID, params, options) {
    const { session_id, betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Session Resources
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsSessionResource of client.beta.sessions.resources.list(
   *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(sessionID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/sessions/${sessionID}/resources?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Session Resource
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeleteSessionResource =
   *   await client.beta.sessions.resources.delete(
   *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
   *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
   *   );
   * ```
   */
  delete(resourceID, params, options) {
    const { session_id, betas } = params;
    return this._client.delete(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Add Session Resource
   *
   * @example
   * ```ts
   * const betaManagedAgentsFileResource =
   *   await client.beta.sessions.resources.add(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *     {
   *       file_id: 'file_011CNha8iCJcU1wXNR6q4V8w',
   *       type: 'file',
   *     },
   *   );
   * ```
   */
  add(sessionID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${sessionID}/resources?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs
var Sessions = class extends APIResource {
  static {
    __name(this, "Sessions");
  }
  constructor() {
    super(...arguments);
    this.events = new Events(this._client);
    this.resources = new Resources(this._client);
  }
  /**
   * Create Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.create({
   *     agent: 'agent_011CZkYpogX7uDKUyvBTophP',
   *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/sessions?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.retrieve(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  retrieve(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/sessions/${sessionID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.update(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  update(sessionID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${sessionID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Sessions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsSession of client.beta.sessions.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/sessions?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedSession =
   *   await client.beta.sessions.delete(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  delete(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/sessions/${sessionID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.archive(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  archive(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/sessions/${sessionID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
Sessions.Events = Events;
Sessions.Resources = Resources;

// node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs
init_esm();
var Versions2 = class extends APIResource {
  static {
    __name(this, "Versions");
  }
  /**
   * Create Skill Version
   *
   * @example
   * ```ts
   * const version = await client.beta.skills.versions.create(
   *   'skill_id',
   * );
   * ```
   */
  create(skillID, params = {}, options) {
    const { betas, ...body } = params ?? {};
    return this._client.post(path`/v1/skills/${skillID}/versions?beta=true`, multipartFormRequestOptions({
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    }, this._client));
  }
  /**
   * Get Skill Version
   *
   * @example
   * ```ts
   * const version = await client.beta.skills.versions.retrieve(
   *   'version',
   *   { skill_id: 'skill_id' },
   * );
   * ```
   */
  retrieve(version, params, options) {
    const { skill_id, betas } = params;
    return this._client.get(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Skill Versions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const versionListResponse of client.beta.skills.versions.list(
   *   'skill_id',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(skillID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/skills/${skillID}/versions?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Skill Version
   *
   * @example
   * ```ts
   * const version = await client.beta.skills.versions.delete(
   *   'version',
   *   { skill_id: 'skill_id' },
   * );
   * ```
   */
  delete(version, params, options) {
    const { skill_id, betas } = params;
    return this._client.delete(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs
var Skills = class extends APIResource {
  static {
    __name(this, "Skills");
  }
  constructor() {
    super(...arguments);
    this.versions = new Versions2(this._client);
  }
  /**
   * Create Skill
   *
   * @example
   * ```ts
   * const skill = await client.beta.skills.create();
   * ```
   */
  create(params = {}, options) {
    const { betas, ...body } = params ?? {};
    return this._client.post("/v1/skills?beta=true", multipartFormRequestOptions({
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    }, this._client, false));
  }
  /**
   * Get Skill
   *
   * @example
   * ```ts
   * const skill = await client.beta.skills.retrieve('skill_id');
   * ```
   */
  retrieve(skillID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/skills/${skillID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Skills
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const skillListResponse of client.beta.skills.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/skills?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Skill
   *
   * @example
   * ```ts
   * const skill = await client.beta.skills.delete('skill_id');
   * ```
   */
  delete(skillID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/skills/${skillID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
};
Skills.Versions = Versions2;

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs
init_esm();
var Credentials = class extends APIResource {
  static {
    __name(this, "Credentials");
  }
  /**
   * Create Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.create(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *     {
   *       auth: {
   *         token: 'bearer_exampletoken',
   *         mcp_server_url:
   *           'https://example-server.modelcontextprotocol.io/sse',
   *         type: 'static_bearer',
   *       },
   *     },
   *   );
   * ```
   */
  create(vaultID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/vaults/${vaultID}/credentials?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.retrieve(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  retrieve(credentialID, params, options) {
    const { vault_id, betas } = params;
    return this._client.get(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.update(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  update(credentialID, params, options) {
    const { vault_id, betas, ...body } = params;
    return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Credentials
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsCredential of client.beta.vaults.credentials.list(
   *   'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(vaultID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/vaults/${vaultID}/credentials?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedCredential =
   *   await client.beta.vaults.credentials.delete(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  delete(credentialID, params, options) {
    const { vault_id, betas } = params;
    return this._client.delete(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.archive(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  archive(credentialID, params, options) {
    const { vault_id, betas } = params;
    return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs
var Vaults = class extends APIResource {
  static {
    __name(this, "Vaults");
  }
  constructor() {
    super(...arguments);
    this.credentials = new Credentials(this._client);
  }
  /**
   * Create Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.create({
   *     display_name: 'Example vault',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/vaults?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.retrieve(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  retrieve(vaultID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/vaults/${vaultID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.update(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  update(vaultID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/vaults/${vaultID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Vaults
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsVault of client.beta.vaults.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/vaults?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedVault =
   *   await client.beta.vaults.delete(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  delete(vaultID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/vaults/${vaultID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.archive(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  archive(vaultID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/vaults/${vaultID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
Vaults.Credentials = Credentials;

// node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
var Beta = class extends APIResource {
  static {
    __name(this, "Beta");
  }
  constructor() {
    super(...arguments);
    this.models = new Models(this._client);
    this.messages = new Messages(this._client);
    this.agents = new Agents(this._client);
    this.environments = new Environments(this._client);
    this.sessions = new Sessions(this._client);
    this.vaults = new Vaults(this._client);
    this.memoryStores = new MemoryStores(this._client);
    this.files = new Files(this._client);
    this.skills = new Skills(this._client);
    this.userProfiles = new UserProfiles(this._client);
  }
};
Beta.Models = Models;
Beta.Messages = Messages;
Beta.Agents = Agents;
Beta.Environments = Environments;
Beta.Sessions = Sessions;
Beta.Vaults = Vaults;
Beta.MemoryStores = MemoryStores;
Beta.Files = Files;
Beta.Skills = Skills;
Beta.UserProfiles = UserProfiles;

// node_modules/@anthropic-ai/sdk/resources/completions.mjs
init_esm();
var Completions = class extends APIResource {
  static {
    __name(this, "Completions");
  }
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/complete", {
      body,
      timeout: this._client._options.timeout ?? 6e5,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ]),
      stream: params.stream ?? false
    });
  }
};

// node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
init_esm();

// node_modules/@anthropic-ai/sdk/lib/parser.mjs
init_esm();
function getOutputFormat2(params) {
  return params?.output_config?.format;
}
__name(getOutputFormat2, "getOutputFormat");
function maybeParseMessage(message, params, opts) {
  const outputFormat = getOutputFormat2(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return parsedBlock;
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseMessage(message, params, opts);
}
__name(maybeParseMessage, "maybeParseMessage");
function parseMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return parsedBlock;
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
__name(parseMessage, "parseMessage");
function parseOutputFormat(params, content) {
  const outputFormat = getOutputFormat2(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}
__name(parseOutputFormat, "parseOutputFormat");

// node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
var _MessageStream_instances;
var _MessageStream_currentMessageSnapshot;
var _MessageStream_params;
var _MessageStream_connectedPromise;
var _MessageStream_resolveConnectedPromise;
var _MessageStream_rejectConnectedPromise;
var _MessageStream_endPromise;
var _MessageStream_resolveEndPromise;
var _MessageStream_rejectEndPromise;
var _MessageStream_listeners;
var _MessageStream_ended;
var _MessageStream_errored;
var _MessageStream_aborted;
var _MessageStream_catchingPromiseCreated;
var _MessageStream_response;
var _MessageStream_request_id;
var _MessageStream_logger;
var _MessageStream_getFinalMessage;
var _MessageStream_getFinalText;
var _MessageStream_handleError;
var _MessageStream_beginRequest;
var _MessageStream_addStreamEvent;
var _MessageStream_endRequest;
var _MessageStream_accumulateMessage;
var JSON_BUF_PROPERTY2 = "__json_buf";
function tracksToolInput2(content) {
  return content.type === "tool_use" || content.type === "server_tool_use";
}
__name(tracksToolInput2, "tracksToolInput");
var MessageStream = class _MessageStream {
  static {
    __name(this, "MessageStream");
  }
  constructor(params, opts) {
    _MessageStream_instances.add(this);
    this.messages = [];
    this.receivedMessages = [];
    _MessageStream_currentMessageSnapshot.set(this, void 0);
    _MessageStream_params.set(this, null);
    this.controller = new AbortController();
    _MessageStream_connectedPromise.set(this, void 0);
    _MessageStream_resolveConnectedPromise.set(this, () => {
    });
    _MessageStream_rejectConnectedPromise.set(this, () => {
    });
    _MessageStream_endPromise.set(this, void 0);
    _MessageStream_resolveEndPromise.set(this, () => {
    });
    _MessageStream_rejectEndPromise.set(this, () => {
    });
    _MessageStream_listeners.set(this, {});
    _MessageStream_ended.set(this, false);
    _MessageStream_errored.set(this, false);
    _MessageStream_aborted.set(this, false);
    _MessageStream_catchingPromiseCreated.set(this, false);
    _MessageStream_response.set(this, void 0);
    _MessageStream_request_id.set(this, void 0);
    _MessageStream_logger.set(this, void 0);
    _MessageStream_handleError.set(this, (error) => {
      __classPrivateFieldSet(this, _MessageStream_errored, true, "f");
      if (isAbortError(error)) {
        error = new APIUserAbortError();
      }
      if (error instanceof APIUserAbortError) {
        __classPrivateFieldSet(this, _MessageStream_aborted, true, "f");
        return this._emit("abort", error);
      }
      if (error instanceof AnthropicError) {
        return this._emit("error", error);
      }
      if (error instanceof Error) {
        const anthropicError = new AnthropicError(error.message);
        anthropicError.cause = error;
        return this._emit("error", anthropicError);
      }
      return this._emit("error", new AnthropicError(String(error)));
    });
    __classPrivateFieldSet(this, _MessageStream_connectedPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet(this, _MessageStream_resolveConnectedPromise, resolve, "f");
      __classPrivateFieldSet(this, _MessageStream_rejectConnectedPromise, reject, "f");
    }), "f");
    __classPrivateFieldSet(this, _MessageStream_endPromise, new Promise((resolve, reject) => {
      __classPrivateFieldSet(this, _MessageStream_resolveEndPromise, resolve, "f");
      __classPrivateFieldSet(this, _MessageStream_rejectEndPromise, reject, "f");
    }), "f");
    __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f").catch(() => {
    });
    __classPrivateFieldGet(this, _MessageStream_endPromise, "f").catch(() => {
    });
    __classPrivateFieldSet(this, _MessageStream_params, params, "f");
    __classPrivateFieldSet(this, _MessageStream_logger, opts?.logger ?? console, "f");
  }
  get response() {
    return __classPrivateFieldGet(this, _MessageStream_response, "f");
  }
  get request_id() {
    return __classPrivateFieldGet(this, _MessageStream_request_id, "f");
  }
  /**
   * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * This is the same as the `APIPromise.withResponse()` method.
   *
   * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
   * as no `Response` is available.
   */
  async withResponse() {
    __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
    const response = await __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f");
    if (!response) {
      throw new Error("Could not resolve a `Response` object");
    }
    return {
      data: this,
      response,
      request_id: response.headers.get("request-id")
    };
  }
  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream) {
    const runner = new _MessageStream(null);
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }
  static createMessage(messages, params, options, { logger: logger2 } = {}) {
    const runner = new _MessageStream(params, { logger: logger2 });
    for (const message of params.messages) {
      runner._addMessageParam(message);
    }
    __classPrivateFieldSet(runner, _MessageStream_params, { ...params, stream: true }, "f");
    runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, "X-Stainless-Helper-Method": "stream" } }));
    return runner;
  }
  _run(executor) {
    executor().then(() => {
      this._emitFinal();
      this._emit("end");
    }, __classPrivateFieldGet(this, _MessageStream_handleError, "f"));
  }
  _addMessageParam(message) {
    this.messages.push(message);
  }
  _addMessage(message, emit = true) {
    this.receivedMessages.push(message);
    if (emit) {
      this._emit("message", message);
    }
  }
  async _createMessage(messages, params, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
      const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
      this._connected(response);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  _connected(response) {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _MessageStream_response, response, "f");
    __classPrivateFieldSet(this, _MessageStream_request_id, response?.headers.get("request-id"), "f");
    __classPrivateFieldGet(this, _MessageStream_resolveConnectedPromise, "f").call(this, response);
    this._emit("connect");
  }
  get ended() {
    return __classPrivateFieldGet(this, _MessageStream_ended, "f");
  }
  get errored() {
    return __classPrivateFieldGet(this, _MessageStream_errored, "f");
  }
  get aborted() {
    return __classPrivateFieldGet(this, _MessageStream_aborted, "f");
  }
  abort() {
    this.controller.abort();
  }
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this MessageStream, so that calls can be chained
   */
  on(event, listener) {
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this MessageStream, so that calls can be chained
   */
  off(event, listener) {
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
    if (!listeners)
      return this;
    const index = listeners.findIndex((l) => l.listener === listener);
    if (index >= 0)
      listeners.splice(index, 1);
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this MessageStream, so that calls can be chained
   */
  once(event, listener) {
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
    listeners.push({ listener, once: true });
    return this;
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * @returns a Promise that resolves the next time given event is triggered,
   * or rejects if an error is emitted.  (If you request the 'error' event,
   * returns a promise that resolves with the error).
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve, reject) => {
      __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
      if (event !== "error")
        this.once("error", reject);
      this.once(event, resolve);
    });
  }
  async done() {
    __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
    await __classPrivateFieldGet(this, _MessageStream_endPromise, "f");
  }
  get currentMessage() {
    return __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
  }
  /**
   * @returns a promise that resolves with the the final assistant Message response,
   * or rejects if an error occurred or the stream ended prematurely without producing a Message.
   * If structured outputs were used, this will be a ParsedMessage with a `parsed_output` field.
   */
  async finalMessage() {
    await this.done();
    return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this);
  }
  /**
   * @returns a promise that resolves with the the final assistant Message's text response, concatenated
   * together if there are more than one text blocks.
   * Rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalText() {
    await this.done();
    return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalText).call(this);
  }
  _emit(event, ...args) {
    if (__classPrivateFieldGet(this, _MessageStream_ended, "f"))
      return;
    if (event === "end") {
      __classPrivateFieldSet(this, _MessageStream_ended, true, "f");
      __classPrivateFieldGet(this, _MessageStream_resolveEndPromise, "f").call(this);
    }
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
    if (listeners) {
      __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
      listeners.forEach(({ listener }) => listener(...args));
    }
    if (event === "abort") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
      return;
    }
    if (event === "error") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
    }
  }
  _emitFinal() {
    const finalMessage = this.receivedMessages.at(-1);
    if (finalMessage) {
      this._emit("finalMessage", __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this));
    }
  }
  async _fromReadableStream(readableStream, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
      this._connected(null);
      const stream = Stream.fromReadableStream(readableStream, this.controller);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  [(_MessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _MessageStream_params = /* @__PURE__ */ new WeakMap(), _MessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_listeners = /* @__PURE__ */ new WeakMap(), _MessageStream_ended = /* @__PURE__ */ new WeakMap(), _MessageStream_errored = /* @__PURE__ */ new WeakMap(), _MessageStream_aborted = /* @__PURE__ */ new WeakMap(), _MessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _MessageStream_response = /* @__PURE__ */ new WeakMap(), _MessageStream_request_id = /* @__PURE__ */ new WeakMap(), _MessageStream_logger = /* @__PURE__ */ new WeakMap(), _MessageStream_handleError = /* @__PURE__ */ new WeakMap(), _MessageStream_instances = /* @__PURE__ */ new WeakSet(), _MessageStream_getFinalMessage = /* @__PURE__ */ __name(function _MessageStream_getFinalMessage2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    return this.receivedMessages.at(-1);
  }, "_MessageStream_getFinalMessage"), _MessageStream_getFinalText = /* @__PURE__ */ __name(function _MessageStream_getFinalText2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
    if (textBlocks.length === 0) {
      throw new AnthropicError("stream ended without producing a content block with type=text");
    }
    return textBlocks.join(" ");
  }, "_MessageStream_getFinalText"), _MessageStream_beginRequest = /* @__PURE__ */ __name(function _MessageStream_beginRequest2() {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
  }, "_MessageStream_beginRequest"), _MessageStream_addStreamEvent = /* @__PURE__ */ __name(function _MessageStream_addStreamEvent2(event) {
    if (this.ended)
      return;
    const messageSnapshot = __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_accumulateMessage).call(this, event);
    this._emit("streamEvent", event, messageSnapshot);
    switch (event.type) {
      case "content_block_delta": {
        const content = messageSnapshot.content.at(-1);
        switch (event.delta.type) {
          case "text_delta": {
            if (content.type === "text") {
              this._emit("text", event.delta.text, content.text || "");
            }
            break;
          }
          case "citations_delta": {
            if (content.type === "text") {
              this._emit("citation", event.delta.citation, content.citations ?? []);
            }
            break;
          }
          case "input_json_delta": {
            if (tracksToolInput2(content) && content.input) {
              this._emit("inputJson", event.delta.partial_json, content.input);
            }
            break;
          }
          case "thinking_delta": {
            if (content.type === "thinking") {
              this._emit("thinking", event.delta.thinking, content.thinking);
            }
            break;
          }
          case "signature_delta": {
            if (content.type === "thinking") {
              this._emit("signature", content.signature);
            }
            break;
          }
          default:
            checkNever2(event.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(messageSnapshot);
        this._addMessage(maybeParseMessage(messageSnapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", messageSnapshot.content.at(-1));
        break;
      }
      case "message_start": {
        __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, messageSnapshot, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, "_MessageStream_addStreamEvent"), _MessageStream_endRequest = /* @__PURE__ */ __name(function _MessageStream_endRequest2() {
    if (this.ended) {
      throw new AnthropicError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
    if (!snapshot) {
      throw new AnthropicError(`request ended without sending any chunks`);
    }
    __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
    return maybeParseMessage(snapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") });
  }, "_MessageStream_endRequest"), _MessageStream_accumulateMessage = /* @__PURE__ */ __name(function _MessageStream_accumulateMessage2(event) {
    let snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
    if (event.type === "message_start") {
      if (snapshot) {
        throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
      }
      return event.message;
    }
    if (!snapshot) {
      throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_stop":
        return snapshot;
      case "message_delta":
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        if (event.usage.input_tokens != null) {
          snapshot.usage.input_tokens = event.usage.input_tokens;
        }
        if (event.usage.cache_creation_input_tokens != null) {
          snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage.cache_read_input_tokens != null) {
          snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage.server_tool_use != null) {
          snapshot.usage.server_tool_use = event.usage.server_tool_use;
        }
        return snapshot;
      case "content_block_start":
        snapshot.content.push({ ...event.content_block });
        return snapshot;
      case "content_block_delta": {
        const snapshotContent = snapshot.content.at(event.index);
        switch (event.delta.type) {
          case "text_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                text: (snapshotContent.text || "") + event.delta.text
              };
            }
            break;
          }
          case "citations_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                citations: [...snapshotContent.citations ?? [], event.delta.citation]
              };
            }
            break;
          }
          case "input_json_delta": {
            if (snapshotContent && tracksToolInput2(snapshotContent)) {
              let jsonBuf = snapshotContent[JSON_BUF_PROPERTY2] || "";
              jsonBuf += event.delta.partial_json;
              const newContent = { ...snapshotContent };
              Object.defineProperty(newContent, JSON_BUF_PROPERTY2, {
                value: jsonBuf,
                enumerable: false,
                writable: true
              });
              if (jsonBuf) {
                newContent.input = partialParse(jsonBuf);
              }
              snapshot.content[event.index] = newContent;
            }
            break;
          }
          case "thinking_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                thinking: snapshotContent.thinking + event.delta.thinking
              };
            }
            break;
          }
          case "signature_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                signature: event.delta.signature
              };
            }
            break;
          }
          default:
            checkNever2(event.delta);
        }
        return snapshot;
      }
      case "content_block_stop":
        return snapshot;
    }
  }, "_MessageStream_accumulateMessage"), Symbol.asyncIterator)]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on("streamEvent", (event) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(event);
      } else {
        pushQueue.push(event);
      }
    });
    this.on("end", () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(void 0);
      }
      readQueue.length = 0;
    });
    this.on("abort", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    this.on("error", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    return {
      next: /* @__PURE__ */ __name(async () => {
        if (!pushQueue.length) {
          if (done) {
            return { value: void 0, done: true };
          }
          return new Promise((resolve, reject) => readQueue.push({ resolve, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
        }
        const chunk = pushQueue.shift();
        return { value: chunk, done: false };
      }, "next"),
      return: /* @__PURE__ */ __name(async () => {
        this.abort();
        return { value: void 0, done: true };
      }, "return")
    };
  }
  toReadableStream() {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
};
function checkNever2(x) {
}
__name(checkNever2, "checkNever");

// node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs
init_esm();
var Batches2 = class extends APIResource {
  static {
    __name(this, "Batches");
  }
  /**
   * Send a batch of Message creation requests.
   *
   * The Message Batches API can be used to process multiple Messages API requests at
   * once. Once a Message Batch is created, it begins processing immediately. Batches
   * can take up to 24 hours to complete.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatch = await client.messages.batches.create({
   *   requests: [
   *     {
   *       custom_id: 'my-custom-id-1',
   *       params: {
   *         max_tokens: 1024,
   *         messages: [
   *           { content: 'Hello, world', role: 'user' },
   *         ],
   *         model: 'claude-opus-4-6',
   *       },
   *     },
   *   ],
   * });
   * ```
   */
  create(body, options) {
    return this._client.post("/v1/messages/batches", { body, ...options });
  }
  /**
   * This endpoint is idempotent and can be used to poll for Message Batch
   * completion. To access the results of a Message Batch, make a request to the
   * `results_url` field in the response.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatch = await client.messages.batches.retrieve(
   *   'message_batch_id',
   * );
   * ```
   */
  retrieve(messageBatchID, options) {
    return this._client.get(path`/v1/messages/batches/${messageBatchID}`, options);
  }
  /**
   * List all Message Batches within a Workspace. Most recently created batches are
   * returned first.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const messageBatch of client.messages.batches.list()) {
   *   // ...
   * }
   * ```
   */
  list(query = {}, options) {
    return this._client.getAPIList("/v1/messages/batches", Page, { query, ...options });
  }
  /**
   * Delete a Message Batch.
   *
   * Message Batches can only be deleted once they've finished processing. If you'd
   * like to delete an in-progress batch, you must first cancel it.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const deletedMessageBatch =
   *   await client.messages.batches.delete('message_batch_id');
   * ```
   */
  delete(messageBatchID, options) {
    return this._client.delete(path`/v1/messages/batches/${messageBatchID}`, options);
  }
  /**
   * Batches may be canceled any time before processing ends. Once cancellation is
   * initiated, the batch enters a `canceling` state, at which time the system may
   * complete any in-progress, non-interruptible requests before finalizing
   * cancellation.
   *
   * The number of canceled requests is specified in `request_counts`. To determine
   * which requests were canceled, check the individual results within the batch.
   * Note that cancellation may not result in any canceled requests if they were
   * non-interruptible.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatch = await client.messages.batches.cancel(
   *   'message_batch_id',
   * );
   * ```
   */
  cancel(messageBatchID, options) {
    return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel`, options);
  }
  /**
   * Streams the results of a Message Batch as a `.jsonl` file.
   *
   * Each line in the file is a JSON object containing the result of a single request
   * in the Message Batch. Results are not guaranteed to be in the same order as
   * requests. Use the `custom_id` field to match results to requests.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatchIndividualResponse =
   *   await client.messages.batches.results('message_batch_id');
   * ```
   */
  async results(messageBatchID, options) {
    const batch = await this.retrieve(messageBatchID);
    if (!batch.results_url) {
      throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
    }
    return this._client.get(batch.results_url, {
      ...options,
      headers: buildHeaders([{ Accept: "application/binary" }, options?.headers]),
      stream: true,
      __binaryResponse: true
    })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
  }
};

// node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
var Messages2 = class extends APIResource {
  static {
    __name(this, "Messages");
  }
  constructor() {
    super(...arguments);
    this.batches = new Batches2(this._client);
  }
  create(body, options) {
    if (body.model in DEPRECATED_MODELS2) {
      console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS2[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    }
    if (MODELS_TO_WARN_WITH_THINKING_ENABLED2.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
      console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    }
    let timeout = this._client._options.timeout;
    if (!body.stream && timeout == null) {
      const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
      timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
    }
    const helperHeader = stainlessHelperHeader(body.tools, body.messages);
    return this._client.post("/v1/messages", {
      body,
      timeout: timeout ?? 6e5,
      ...options,
      headers: buildHeaders([helperHeader, options?.headers]),
      stream: body.stream ?? false
    });
  }
  /**
   * Send a structured list of input messages with text and/or image content, along with an expected `output_config.format` and
   * the response will be automatically parsed and available in the `parsed_output` property of the message.
   *
   * @example
   * ```ts
   * const message = await client.messages.parse({
   *   model: 'claude-sonnet-4-5-20250929',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'What is 2+2?' }],
   *   output_config: {
   *     format: zodOutputFormat(z.object({ answer: z.number() })),
   *   },
   * });
   *
   * console.log(message.parsed_output?.answer); // 4
   * ```
   */
  parse(params, options) {
    return this.create(params, options).then((message) => parseMessage(message, params, { logger: this._client.logger ?? console }));
  }
  /**
   * Create a Message stream.
   *
   * If `output_config.format` is provided with a parseable format (like `zodOutputFormat()`),
   * the final message will include a `parsed_output` property with the parsed content.
   *
   * @example
   * ```ts
   * const stream = client.messages.stream({
   *   model: 'claude-sonnet-4-5-20250929',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'What is 2+2?' }],
   *   output_config: {
   *     format: zodOutputFormat(z.object({ answer: z.number() })),
   *   },
   * });
   *
   * const message = await stream.finalMessage();
   * console.log(message.parsed_output?.answer); // 4
   * ```
   */
  stream(body, options) {
    return MessageStream.createMessage(this, body, options, { logger: this._client.logger ?? console });
  }
  /**
   * Count the number of tokens in a Message.
   *
   * The Token Count API can be used to count the number of tokens in a Message,
   * including tools, images, and documents, without creating it.
   *
   * Learn more about token counting in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)
   *
   * @example
   * ```ts
   * const messageTokensCount =
   *   await client.messages.countTokens({
   *     messages: [{ content: 'Hello, world', role: 'user' }],
   *     model: 'claude-opus-4-6',
   *   });
   * ```
   */
  countTokens(body, options) {
    return this._client.post("/v1/messages/count_tokens", { body, ...options });
  }
};
var DEPRECATED_MODELS2 = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-3-opus-20240229": "January 5th, 2026",
  "claude-2.1": "July 21st, 2025",
  "claude-2.0": "July 21st, 2025",
  "claude-3-7-sonnet-latest": "February 19th, 2026",
  "claude-3-7-sonnet-20250219": "February 19th, 2026",
  "claude-3-5-haiku-latest": "February 19th, 2026",
  "claude-3-5-haiku-20241022": "February 19th, 2026",
  "claude-opus-4-0": "June 15th, 2026",
  "claude-opus-4-20250514": "June 15th, 2026",
  "claude-sonnet-4-0": "June 15th, 2026",
  "claude-sonnet-4-20250514": "June 15th, 2026"
};
var MODELS_TO_WARN_WITH_THINKING_ENABLED2 = ["claude-mythos-preview", "claude-opus-4-6"];
Messages2.Batches = Batches2;

// node_modules/@anthropic-ai/sdk/resources/models.mjs
init_esm();
var Models2 = class extends APIResource {
  static {
    __name(this, "Models");
  }
  /**
   * Get a specific model.
   *
   * The Models API response can be used to determine information about a specific
   * model or resolve a model alias to a model ID.
   */
  retrieve(modelID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/models/${modelID}`, {
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
  /**
   * List available models.
   *
   * The Models API response can be used to determine which models are available for
   * use in the API. More recently released models are listed first.
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/models", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
};

// node_modules/@anthropic-ai/sdk/internal/utils/env.mjs
init_esm();
var readEnv = /* @__PURE__ */ __name((env) => {
  if (typeof globalThis.process !== "undefined") {
    return globalThis.process.env?.[env]?.trim() || void 0;
  }
  if (typeof globalThis.Deno !== "undefined") {
    return globalThis.Deno.env?.get?.(env)?.trim() || void 0;
  }
  return void 0;
}, "readEnv");

// node_modules/@anthropic-ai/sdk/client.mjs
var _BaseAnthropic_instances;
var _a;
var _BaseAnthropic_encoder;
var _BaseAnthropic_baseURLOverridden;
var HUMAN_PROMPT = "\\n\\nHuman:";
var AI_PROMPT = "\\n\\nAssistant:";
var BaseAnthropic = class {
  static {
    __name(this, "BaseAnthropic");
  }
  /**
   * API Client for interfacing with the Anthropic API.
   *
   * @param {string | null | undefined} [opts.apiKey=process.env['ANTHROPIC_API_KEY'] ?? null]
   * @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
   * @param {string} [opts.baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com] - Override the default base URL for the API.
   * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
   * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
   * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
   * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
   * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
   * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
   * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
   */
  constructor({ baseURL = readEnv("ANTHROPIC_BASE_URL"), apiKey = readEnv("ANTHROPIC_API_KEY") ?? null, authToken = readEnv("ANTHROPIC_AUTH_TOKEN") ?? null, ...opts } = {}) {
    _BaseAnthropic_instances.add(this);
    _BaseAnthropic_encoder.set(this, void 0);
    const options = {
      apiKey,
      authToken,
      ...opts,
      baseURL: baseURL || `https://api.anthropic.com`
    };
    if (!options.dangerouslyAllowBrowser && isRunningInBrowser()) {
      throw new AnthropicError("It looks like you're running in a browser-like environment.\n\nThis is disabled by default, as it risks exposing your secret API credentials to attackers.\nIf you understand the risks and have appropriate mitigations in place,\nyou can set the `dangerouslyAllowBrowser` option to `true`, e.g.,\n\nnew Anthropic({ apiKey, dangerouslyAllowBrowser: true });\n");
    }
    this.baseURL = options.baseURL;
    this.timeout = options.timeout ?? _a.DEFAULT_TIMEOUT;
    this.logger = options.logger ?? console;
    const defaultLogLevel = "warn";
    this.logLevel = defaultLogLevel;
    this.logLevel = parseLogLevel(options.logLevel, "ClientOptions.logLevel", this) ?? parseLogLevel(readEnv("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", this) ?? defaultLogLevel;
    this.fetchOptions = options.fetchOptions;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? getDefaultFetch();
    __classPrivateFieldSet(this, _BaseAnthropic_encoder, FallbackEncoder, "f");
    this._options = options;
    this.apiKey = typeof apiKey === "string" ? apiKey : null;
    this.authToken = authToken;
  }
  /**
   * Create a new client instance re-using the same options given to the current client with optional overriding.
   */
  withOptions(options) {
    const client = new this.constructor({
      ...this._options,
      baseURL: this.baseURL,
      maxRetries: this.maxRetries,
      timeout: this.timeout,
      logger: this.logger,
      logLevel: this.logLevel,
      fetch: this.fetch,
      fetchOptions: this.fetchOptions,
      apiKey: this.apiKey,
      authToken: this.authToken,
      ...options
    });
    return client;
  }
  defaultQuery() {
    return this._options.defaultQuery;
  }
  validateHeaders({ values, nulls }) {
    if (values.get("x-api-key") || values.get("authorization")) {
      return;
    }
    if (this.apiKey && values.get("x-api-key")) {
      return;
    }
    if (nulls.has("x-api-key")) {
      return;
    }
    if (this.authToken && values.get("authorization")) {
      return;
    }
    if (nulls.has("authorization")) {
      return;
    }
    throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
  }
  async authHeaders(opts) {
    return buildHeaders([await this.apiKeyAuth(opts), await this.bearerAuth(opts)]);
  }
  async apiKeyAuth(opts) {
    if (this.apiKey == null) {
      return void 0;
    }
    return buildHeaders([{ "X-Api-Key": this.apiKey }]);
  }
  async bearerAuth(opts) {
    if (this.authToken == null) {
      return void 0;
    }
    return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }]);
  }
  /**
   * Basic re-implementation of `qs.stringify` for primitive types.
   */
  stringifyQuery(query) {
    return stringifyQuery(query);
  }
  getUserAgent() {
    return `${this.constructor.name}/JS ${VERSION}`;
  }
  defaultIdempotencyKey() {
    return `stainless-node-retry-${uuid4()}`;
  }
  makeStatusError(status, error, message, headers) {
    return APIError.generate(status, error, message, headers);
  }
  buildURL(path2, query, defaultBaseURL) {
    const baseURL = !__classPrivateFieldGet(this, _BaseAnthropic_instances, "m", _BaseAnthropic_baseURLOverridden).call(this) && defaultBaseURL || this.baseURL;
    const url = isAbsoluteURL(path2) ? new URL(path2) : new URL(baseURL + (baseURL.endsWith("/") && path2.startsWith("/") ? path2.slice(1) : path2));
    const defaultQuery = this.defaultQuery();
    const pathQuery = Object.fromEntries(url.searchParams);
    if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) {
      query = { ...pathQuery, ...defaultQuery, ...query };
    }
    if (typeof query === "object" && query && !Array.isArray(query)) {
      url.search = this.stringifyQuery(query);
    }
    return url.toString();
  }
  _calculateNonstreamingTimeout(maxTokens) {
    const defaultTimeout = 10 * 60;
    const expectedTimeout = 60 * 60 * maxTokens / 128e3;
    if (expectedTimeout > defaultTimeout) {
      throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
    }
    return defaultTimeout * 1e3;
  }
  /**
   * Used as a callback for mutating the given `FinalRequestOptions` object.
   */
  async prepareOptions(options) {
  }
  /**
   * Used as a callback for mutating the given `RequestInit` object.
   *
   * This is useful for cases where you want to add certain headers based off of
   * the request properties, e.g. `method` or `url`.
   */
  async prepareRequest(request, { url, options }) {
  }
  get(path2, opts) {
    return this.methodRequest("get", path2, opts);
  }
  post(path2, opts) {
    return this.methodRequest("post", path2, opts);
  }
  patch(path2, opts) {
    return this.methodRequest("patch", path2, opts);
  }
  put(path2, opts) {
    return this.methodRequest("put", path2, opts);
  }
  delete(path2, opts) {
    return this.methodRequest("delete", path2, opts);
  }
  methodRequest(method, path2, opts) {
    return this.request(Promise.resolve(opts).then((opts2) => {
      return { method, path: path2, ...opts2 };
    }));
  }
  request(options, remainingRetries = null) {
    return new APIPromise(this, this.makeRequest(options, remainingRetries, void 0));
  }
  async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
    const options = await optionsInput;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    if (retriesRemaining == null) {
      retriesRemaining = maxRetries;
    }
    await this.prepareOptions(options);
    const { req, url, timeout } = await this.buildRequest(options, {
      retryCount: maxRetries - retriesRemaining
    });
    await this.prepareRequest(req, { url, options });
    const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
    const retryLogStr = retryOfRequestLogID === void 0 ? "" : `, retryOf: ${retryOfRequestLogID}`;
    const startTime = Date.now();
    loggerFor(this).debug(`[${requestLogID}] sending request`, formatRequestDetails({
      retryOfRequestLogID,
      method: options.method,
      url,
      options,
      headers: req.headers
    }));
    if (options.signal?.aborted) {
      throw new APIUserAbortError();
    }
    const controller = new AbortController();
    const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(castToError);
    const headersTime = Date.now();
    if (response instanceof globalThis.Error) {
      const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
      if (options.signal?.aborted) {
        throw new APIUserAbortError();
      }
      const isTimeout = isAbortError(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
      if (retriesRemaining) {
        loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
        loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, formatRequestDetails({
          retryOfRequestLogID,
          url,
          durationMs: headersTime - startTime,
          message: response.message
        }));
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
      }
      loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
      loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, formatRequestDetails({
        retryOfRequestLogID,
        url,
        durationMs: headersTime - startTime,
        message: response.message
      }));
      if (isTimeout) {
        throw new APIConnectionTimeoutError();
      }
      throw new APIConnectionError({ cause: response });
    }
    const specialHeaders = [...response.headers.entries()].filter(([name]) => name === "request-id").map(([name, value]) => ", " + name + ": " + JSON.stringify(value)).join("");
    const responseInfo = `[${requestLogID}${retryLogStr}${specialHeaders}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
    if (!response.ok) {
      const shouldRetry = await this.shouldRetry(response);
      if (retriesRemaining && shouldRetry) {
        const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
        await CancelReadableStream(response.body);
        loggerFor(this).info(`${responseInfo} - ${retryMessage2}`);
        loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage2})`, formatRequestDetails({
          retryOfRequestLogID,
          url: response.url,
          status: response.status,
          headers: response.headers,
          durationMs: headersTime - startTime
        }));
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID, response.headers);
      }
      const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
      loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
      const errText = await response.text().catch((err2) => castToError(err2).message);
      const errJSON = safeJSON(errText);
      const errMessage = errJSON ? void 0 : errText;
      loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage})`, formatRequestDetails({
        retryOfRequestLogID,
        url: response.url,
        status: response.status,
        headers: response.headers,
        message: errMessage,
        durationMs: Date.now() - startTime
      }));
      const err = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
      throw err;
    }
    loggerFor(this).info(responseInfo);
    loggerFor(this).debug(`[${requestLogID}] response start`, formatRequestDetails({
      retryOfRequestLogID,
      url: response.url,
      status: response.status,
      headers: response.headers,
      durationMs: headersTime - startTime
    }));
    return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
  }
  getAPIList(path2, Page2, opts) {
    return this.requestAPIList(Page2, opts && "then" in opts ? opts.then((opts2) => ({ method: "get", path: path2, ...opts2 })) : { method: "get", path: path2, ...opts });
  }
  requestAPIList(Page2, options) {
    const request = this.makeRequest(options, null, void 0);
    return new PagePromise(this, request, Page2);
  }
  async fetchWithTimeout(url, init, ms, controller) {
    const { signal, method, ...options } = init || {};
    const abort = this._makeAbort(controller);
    if (signal)
      signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, ms);
    const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
    const fetchOptions = {
      signal: controller.signal,
      ...isReadableBody ? { duplex: "half" } : {},
      method: "GET",
      ...options
    };
    if (method) {
      fetchOptions.method = method.toUpperCase();
    }
    try {
      return await this.fetch.call(void 0, url, fetchOptions);
    } finally {
      clearTimeout(timeout);
    }
  }
  async shouldRetry(response) {
    const shouldRetryHeader = response.headers.get("x-should-retry");
    if (shouldRetryHeader === "true")
      return true;
    if (shouldRetryHeader === "false")
      return false;
    if (response.status === 408)
      return true;
    if (response.status === 409)
      return true;
    if (response.status === 429)
      return true;
    if (response.status >= 500)
      return true;
    return false;
  }
  async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
    let timeoutMillis;
    const retryAfterMillisHeader = responseHeaders?.get("retry-after-ms");
    if (retryAfterMillisHeader) {
      const timeoutMs = parseFloat(retryAfterMillisHeader);
      if (!Number.isNaN(timeoutMs)) {
        timeoutMillis = timeoutMs;
      }
    }
    const retryAfterHeader = responseHeaders?.get("retry-after");
    if (retryAfterHeader && !timeoutMillis) {
      const timeoutSeconds = parseFloat(retryAfterHeader);
      if (!Number.isNaN(timeoutSeconds)) {
        timeoutMillis = timeoutSeconds * 1e3;
      } else {
        timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
      }
    }
    if (timeoutMillis === void 0) {
      const maxRetries = options.maxRetries ?? this.maxRetries;
      timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
    }
    await sleep(timeoutMillis);
    return this.makeRequest(options, retriesRemaining - 1, requestLogID);
  }
  calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
    const initialRetryDelay = 0.5;
    const maxRetryDelay = 8;
    const numRetries = maxRetries - retriesRemaining;
    const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
    const jitter = 1 - Math.random() * 0.25;
    return sleepSeconds * jitter * 1e3;
  }
  calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) {
    const maxTime = 60 * 60 * 1e3;
    const defaultTime = 60 * 10 * 1e3;
    const expectedTime = maxTime * maxTokens / 128e3;
    if (expectedTime > defaultTime || maxNonstreamingTokens != null && maxTokens > maxNonstreamingTokens) {
      throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
    }
    return defaultTime;
  }
  async buildRequest(inputOptions, { retryCount = 0 } = {}) {
    const options = { ...inputOptions };
    const { method, path: path2, query, defaultBaseURL } = options;
    const url = this.buildURL(path2, query, defaultBaseURL);
    if ("timeout" in options)
      validatePositiveInteger("timeout", options.timeout);
    options.timeout = options.timeout ?? this.timeout;
    const { bodyHeaders, body } = this.buildBody({ options });
    const reqHeaders = await this.buildHeaders({ options: inputOptions, method, bodyHeaders, retryCount });
    const req = {
      method,
      headers: reqHeaders,
      ...options.signal && { signal: options.signal },
      ...globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" },
      ...body && { body },
      ...this.fetchOptions ?? {},
      ...options.fetchOptions ?? {}
    };
    return { req, url, timeout: options.timeout };
  }
  async buildHeaders({ options, method, bodyHeaders, retryCount }) {
    let idempotencyHeaders = {};
    if (this.idempotencyHeader && method !== "get") {
      if (!options.idempotencyKey)
        options.idempotencyKey = this.defaultIdempotencyKey();
      idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
    }
    const headers = buildHeaders([
      idempotencyHeaders,
      {
        Accept: "application/json",
        "User-Agent": this.getUserAgent(),
        "X-Stainless-Retry-Count": String(retryCount),
        ...options.timeout ? { "X-Stainless-Timeout": String(Math.trunc(options.timeout / 1e3)) } : {},
        ...getPlatformHeaders(),
        ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0,
        "anthropic-version": "2023-06-01"
      },
      await this.authHeaders(options),
      this._options.defaultHeaders,
      bodyHeaders,
      options.headers
    ]);
    this.validateHeaders(headers);
    return headers.values;
  }
  _makeAbort(controller) {
    return () => controller.abort();
  }
  buildBody({ options: { body, headers: rawHeaders } }) {
    if (!body) {
      return { bodyHeaders: void 0, body: void 0 };
    }
    const headers = buildHeaders([rawHeaders]);
    if (
      // Pass raw type verbatim
      ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && // Preserve legacy string encoding behavior for now
      headers.values.has("content-type") || // `Blob` is superset of `File`
      globalThis.Blob && body instanceof globalThis.Blob || // `FormData` -> `multipart/form-data`
      body instanceof FormData || // `URLSearchParams` -> `application/x-www-form-urlencoded`
      body instanceof URLSearchParams || // Send chunked stream (each chunk has own `length`)
      globalThis.ReadableStream && body instanceof globalThis.ReadableStream
    ) {
      return { bodyHeaders: void 0, body };
    } else if (typeof body === "object" && (Symbol.asyncIterator in body || Symbol.iterator in body && "next" in body && typeof body.next === "function")) {
      return { bodyHeaders: void 0, body: ReadableStreamFrom(body) };
    } else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") {
      return {
        bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
        body: this.stringifyQuery(body)
      };
    } else {
      return __classPrivateFieldGet(this, _BaseAnthropic_encoder, "f").call(this, { body, headers });
    }
  }
};
_a = BaseAnthropic, _BaseAnthropic_encoder = /* @__PURE__ */ new WeakMap(), _BaseAnthropic_instances = /* @__PURE__ */ new WeakSet(), _BaseAnthropic_baseURLOverridden = /* @__PURE__ */ __name(function _BaseAnthropic_baseURLOverridden2() {
  return this.baseURL !== "https://api.anthropic.com";
}, "_BaseAnthropic_baseURLOverridden");
BaseAnthropic.Anthropic = _a;
BaseAnthropic.HUMAN_PROMPT = HUMAN_PROMPT;
BaseAnthropic.AI_PROMPT = AI_PROMPT;
BaseAnthropic.DEFAULT_TIMEOUT = 6e5;
BaseAnthropic.AnthropicError = AnthropicError;
BaseAnthropic.APIError = APIError;
BaseAnthropic.APIConnectionError = APIConnectionError;
BaseAnthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
BaseAnthropic.APIUserAbortError = APIUserAbortError;
BaseAnthropic.NotFoundError = NotFoundError;
BaseAnthropic.ConflictError = ConflictError;
BaseAnthropic.RateLimitError = RateLimitError;
BaseAnthropic.BadRequestError = BadRequestError;
BaseAnthropic.AuthenticationError = AuthenticationError;
BaseAnthropic.InternalServerError = InternalServerError;
BaseAnthropic.PermissionDeniedError = PermissionDeniedError;
BaseAnthropic.UnprocessableEntityError = UnprocessableEntityError;
BaseAnthropic.toFile = toFile;
var Anthropic = class extends BaseAnthropic {
  static {
    __name(this, "Anthropic");
  }
  constructor() {
    super(...arguments);
    this.completions = new Completions(this);
    this.messages = new Messages2(this);
    this.models = new Models2(this);
    this.beta = new Beta(this);
  }
};
Anthropic.Completions = Completions;
Anthropic.Messages = Messages2;
Anthropic.Models = Models2;
Anthropic.Beta = Beta;

// src/lib/claude.ts
var anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});
var HAIKU_MODEL = "claude-haiku-4-5-20251001";
var SONNET_MODEL = "claude-sonnet-4-6";
var claudeCallCount = 0;
var claudeCallWindowStart = Date.now();
var CLAUDE_RATE_LIMIT = 20;
function is529Overload(err) {
  if (err instanceof APIError) return err.status === 529;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("529") || msg.toLowerCase().includes("overloaded");
}
__name(is529Overload, "is529Overload");
async function rateLimitedCall(fn) {
  const now = Date.now();
  if (now - claudeCallWindowStart > 6e4) {
    claudeCallCount = 0;
    claudeCallWindowStart = now;
  }
  if (claudeCallCount >= CLAUDE_RATE_LIMIT) {
    const wait = 6e4 - (now - claudeCallWindowStart);
    await new Promise((r) => setTimeout(r, wait));
    claudeCallCount = 0;
    claudeCallWindowStart = Date.now();
  }
  claudeCallCount++;
  return withRetry(fn, { maxAttempts: 4, baseDelayMs: 1e3, isRetryable: is529Overload });
}
__name(rateLimitedCall, "rateLimitedCall");
function getBrandDescription(category) {
  const food = ["Halal Restaurants", "Halal Cafes", "Halal Bakeries / Dessert Shops"];
  const beauty = ["Nail Salons", "Hair Salons", "Beauty / Lash Studios", "Spas / Massage Studios"];
  const travel = ["Travel Agents", "Tour Operators", "Hotels / Resorts"];
  if (food.includes(category)) return "Sydney-based food, travel and lifestyle brand";
  if (beauty.includes(category)) return "Sydney-based lifestyle brand";
  if (travel.includes(category)) return "Sydney-based travel and lifestyle brand";
  return "Sydney-based food, travel and lifestyle brand";
}
__name(getBrandDescription, "getBrandDescription");
function getCategoryPitch(category) {
  const halalFood = ["Halal Restaurants", "Halal Cafes", "Halal Bakeries / Dessert Shops"];
  const beauty = ["Nail Salons", "Hair Salons", "Beauty / Lash Studios"];
  const wellness = ["Spas / Massage Studios"];
  const travel = ["Travel Agents", "Tour Operators"];
  const accommodation = ["Hotels / Resorts"];
  if (halalFood.includes(category)) return "Owais creates halal food content for 500K+ Australians and wants to collab with this business.";
  if (beauty.includes(category)) return "Owais creates lifestyle content for 500K+ Australians and wants to collab with this business.";
  if (wellness.includes(category)) return "Owais creates lifestyle content for 500K+ Australians and wants to collab with this business.";
  if (travel.includes(category)) return "Owais creates Australian travel content for 500K+ Australians and wants to collab with this business.";
  if (accommodation.includes(category)) return "Owais creates Australian travel and lifestyle content for 500K+ Australians and wants to collab with this property.";
  return "Owais creates Australian food, travel and lifestyle content for 500K+ Australians and wants to collab with this business.";
}
__name(getCategoryPitch, "getCategoryPitch");
async function extractWebsiteData(websiteContent) {
  const response = await rateLimitedCall(
    () => anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Extract the following from this business website content:
- Brief description (1-2 sentences)
- Main services offered
- Instagram handle (if mentioned, just the handle like @businessname)
- Facebook URL (if mentioned)
- Any other social media

Website content: ${websiteContent.slice(0, 4e3)}

Respond in JSON only with keys: description, services, instagram_handle, facebook_url, other_social`
        }
      ]
    })
  );
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
  }
  return {
    description: "",
    services: "",
    instagram_handle: null,
    facebook_url: null,
    other_social: null
  };
}
__name(extractWebsiteData, "extractWebsiteData");
async function writeOutreachEmail(params) {
  const response = await rateLimitedCall(
    () => anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: `You are Owais. You run Aussie Venture, an Australian ${getBrandDescription(params.category)}. Write a very short first outreach email to a local business.

FACTS (only use these, never invent others):
- Aussie Venture is a ${getBrandDescription(params.category)} with a national audience
- 500K+ followers across Facebook, Instagram and TikTok

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

WHAT THE EMAIL MUST DO:
1. Open with "Hey ${params.business_name},"
2. Briefly introduce yourself and Aussie Venture — mention the 500K+ followers once
3. Say you'd love to work together or collab
4. End with exactly: "Would you be keen to collab?"

HARD RULES — break any of these and the email is wrong:
- Under 80 words (not counting sign-off)
- NO mention of: visiting, coming in, remote, assets, photos, sponsored post, sponsored feature, content partnership, price, budget, free, paid — save all logistics for after they reply
- Think of it like a first message — just spark interest, nothing more
- No em dashes (no — character)
- No bullet points
- No corporate language: "leverage", "synergy", "reach out", "I wanted to", "I hope this finds you well", "I came across"
- 2 short paragraphs max
- Sound like a real 25-year-old Australian, casual
- Last line must be exactly: "Would you be keen to collab?"

Sign off (use exactly this, every line, nothing more and nothing less):
Cheers,
Owais
Aussie Venture
hello@aussieventure.com
aussieventure.com
instagram.com/aussie.venture
tiktok.com/@aussie.venture
facebook.com/AussieVenture
facebook.com/Sydneyventure

Subject: short and casual, e.g. "Collab with Aussie Venture?" or "Working together?"

Respond in JSON: { "subject": "...", "body": "..." }`
        }
      ]
    })
  );
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
  }
  return {
    subject: `Collab with Aussie Venture - ${params.business_name}`,
    body: `Hey ${params.business_name},

I run Aussie Venture, a ${getBrandDescription(params.category)} with 500K+ followers across Facebook, Instagram and TikTok. Would love to work together.

Would you be keen to collab?

Cheers,
Owais
Aussie Venture
hello@aussieventure.com
aussieventure.com
instagram.com/aussie.venture
tiktok.com/@aussie.venture
facebook.com/AussieVenture
facebook.com/Sydneyventure`
  };
}
__name(writeOutreachEmail, "writeOutreachEmail");
async function fetchPageText(url) {
  try {
    const normalised = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalised, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AussieVentureBot/1.0)" },
      signal: AbortSignal.timeout(1e4)
    });
    const html = await res.text();
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4e3);
  } catch {
    return "";
  }
}
__name(fetchPageText, "fetchPageText");
async function searchWeb(query) {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AussieVentureBot/1.0)",
        Accept: "text/html"
      },
      signal: AbortSignal.timeout(1e4)
    });
    const html = await res.text();
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4e3);
  } catch {
    return "";
  }
}
__name(searchWeb, "searchWeb");
function parseDecision(text) {
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch {
  }
  return { action: "not_found" };
}
__name(parseDecision, "parseDecision");
async function agenticEmailSearch(params) {
  const MAX_ROUNDS = 3;
  const SYSTEM = `You are a research agent that finds contact email addresses for businesses. Respond in valid JSON only — no other text.`;
  const firstPrompt = `Find the contact email for this business.

Business: ${params.business_name}
Website: ${params.website_url}
Category: ${params.category}

Homepage content:
${params.homepage_content}

Choose ONE action and respond with JSON only:
- Found an email → {"action":"found","email":"email@domain.com"}
- Need to fetch a subpage → {"action":"fetch_url","url":"/contact"}
- Need an online search → {"action":"search_google","search_query":"${params.business_name} contact email"}
- Cannot find → {"action":"not_found"}`;
  const messages = [
    { role: "user", content: firstPrompt }
  ];
  let method = "not_found";
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await rateLimitedCall(
      () => anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 256,
        system: SYSTEM,
        messages
      })
    );
    const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
    const decision = parseDecision(raw);
    console.log(`[email-agent] round=${round} action=${decision.action} email=${decision.email ?? "-"}`);
    if (decision.action === "found" && decision.email) {
      if (round === 1) method = "homepage";
      else if (method !== "google_search") method = "subpage";
      return { email: decision.email, method, rounds: round };
    }
    if (decision.action === "not_found") {
      break;
    }
    let fetchedContent = "";
    if (decision.action === "fetch_url" && decision.url) {
      let target = decision.url;
      if (!target.startsWith("http")) {
        try {
          const base = new URL(
            params.website_url.startsWith("http") ? params.website_url : `https://${params.website_url}`
          );
          target = base.origin + (decision.url.startsWith("/") ? decision.url : `/${decision.url}`);
        } catch {
          target = params.website_url + decision.url;
        }
      }
      fetchedContent = await fetchPageText(target);
      method = "subpage";
    } else if (decision.action === "search_google" && decision.search_query) {
      fetchedContent = await searchWeb(decision.search_query);
      method = "google_search";
    }
    messages.push({ role: "assistant", content: raw });
    if (!fetchedContent) {
      messages.push({
        role: "user",
        content: 'That returned no content. Try a different approach or return {"action":"not_found"}.'
      });
      continue;
    }
    messages.push({
      role: "user",
      content: `Content from ${decision.action === "search_google" ? "search results" : "that page"}:

${fetchedContent}

Now decide. JSON only: {"action":"found","email":"..."} or {"action":"fetch_url","url":"..."} or {"action":"search_google","search_query":"..."} or {"action":"not_found"}`
    });
  }
  return { email: null, method: "not_found", rounds: MAX_ROUNDS };
}
__name(agenticEmailSearch, "agenticEmailSearch");
async function writeOutreachDM(params) {
  const pitch = getCategoryPitch(params.category);
  const response = await rateLimitedCall(
    () => anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `You're Owais. You run Aussie Venture, an Australian food, travel and lifestyle brand with 500K+ followers across Facebook, Instagram and TikTok. Write a short Instagram DM to this business.

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

Pitch angle: ${pitch.split("\n")[0]}

Rules:
- Max 2-3 sentences
- Sound like a real person, not a brand
- No em dashes, no bullet points, no corporate language
- No "I wanted to reach out", no "I came across your page"
- You may mention 500K+ followers once if it adds credibility
- NEVER mention free, no cost, no charge, or anything being free
- NEVER say "paid collab" - use "sponsored feature" or "collab" instead
- Never state a price
- Casual and direct
- End with "Would you be keen?" or "Keen to work together?"

Respond with just the DM text, nothing else.`
        }
      ]
    })
  );
  return response.content[0].type === "text" ? response.content[0].text : "";
}
__name(writeOutreachDM, "writeOutreachDM");

// agents/researcher.ts
var MAILTO_RE = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
var EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
var BLOCKED_LOCALS2 = /* @__PURE__ */ new Set([
  "noreply",
  "donotreply",
  "no-reply",
  "wordpress",
  "postmaster",
  "webmaster",
  "bounce",
  "mailer"
]);
function isCleanEmail(email) {
  const local = email.toLowerCase().split("@")[0];
  if (BLOCKED_LOCALS2.has(local)) return false;
  if (local.length < 4) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(email)) return false;
  if (email.toLowerCase().includes("@2x")) return false;
  const hasVowel = /[aeiou]/.test(local);
  const hasSeparator = /[._]/.test(local);
  if (!hasVowel && !hasSeparator) return false;
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false;
  return true;
}
__name(isCleanEmail, "isCleanEmail");
function extractMailtoEmail(html) {
  const re = new RegExp(MAILTO_RE.source, "gi");
  let m;
  while ((m = re.exec(html)) !== null) {
    if (isCleanEmail(m[1])) return m[1];
  }
  const matches = html.match(EMAIL_RE) ?? [];
  return matches.find(isCleanEmail) ?? null;
}
__name(extractMailtoEmail, "extractMailtoEmail");
async function fetchRawHtml(url) {
  const normalised = url.startsWith("http") ? url : `https://${url}`;
  const res = await fetch(normalised, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AussieVentureBot/1.0)" },
    signal: AbortSignal.timeout(1e4)
  });
  return res.text();
}
__name(fetchRawHtml, "fetchRawHtml");
async function fixBouncedEmails(supabase) {
  const { data: bouncedEmails } = await supabase.from("emails").select("id, lead_id, leads(id, email, website, business_name)").eq("status", "bounced");
  if (!bouncedEmails?.length) {
    logger.info("researcher", "No bounced emails to fix");
    return;
  }
  logger.info("researcher", `Found ${bouncedEmails.length} bounced email(s) — attempting to re-extract`);
  for (const emailRecord of bouncedEmails) {
    const lead = emailRecord.leads;
    if (!lead?.website) continue;
    try {
      let html = await fetchRawHtml(lead.website);
      let newEmail = extractMailtoEmail(html);
      if (!newEmail) {
        const base = lead.website.replace(/\/$/, "");
        html = await fetchRawHtml(`${base}/contact`).catch(() => "");
        newEmail = html ? extractMailtoEmail(html) : null;
      }
      if (!newEmail || newEmail === lead.email) continue;
      logger.info("researcher", `Fixed bounced email for ${lead.business_name}`, { old: lead.email, new: newEmail });
      await supabase.from("leads").update({ email: newEmail }).eq("id", lead.id);
      await supabase.from("emails").update({ status: "pending_send" }).eq("id", emailRecord.id);
      await supabase.from("activity_log").insert({
        event_type: "email_fixed",
        lead_id: lead.id,
        description: `Bounced email corrected for ${lead.business_name}: ${lead.email} → ${newEmail}`,
        metadata: { old_email: lead.email, new_email: newEmail }
      });
    } catch (err) {
      logger.error("researcher", `Error fixing bounced email for lead`, { lead_id: emailRecord.lead_id, error: String(err) });
    }
  }
}
__name(fixBouncedEmails, "fixBouncedEmails");
async function runResearcherAgent() {
  const supabase = createServiceClient();
  try {
    const { data: systemSetting } = await supabase.from("settings").select("value").eq("key", "system_active").single();
    if (systemSetting?.value !== "true") {
      logger.info("researcher", "System paused - skipped");
      return 0;
    }
    await fixBouncedEmails(supabase);
    const { data: leads } = await supabase.from("leads").select("*").eq("status", "new");
    logger.info("researcher", `Found ${leads?.length ?? 0} leads with status=new`);
    if (!leads?.length) {
      logger.info("researcher", "Nothing to process");
      return 0;
    }
    let processed = 0;
    let emailsFound = 0;
    const methodCounts = {};
    for (const lead of leads) {
      logger.info("researcher", `Lead: "${lead.business_name}"`, { email: lead.email ?? "NONE", website: lead.website ?? "NONE" });
      try {
        let websiteText = "";
        let rawHtml = "";
        let foundEmail = lead.email ?? null;
        let emailMethod = "outscraper";
        let emailRounds = 0;
        if (lead.website) {
          try {
            rawHtml = await fetchRawHtml(lead.website);
            websiteText = rawHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 5e3);
          } catch {
            logger.info("researcher", `Could not fetch website for "${lead.business_name}"`);
          }
        }
        if (!foundEmail && rawHtml) {
          const mailtoEmail = extractMailtoEmail(rawHtml);
          if (mailtoEmail) {
            foundEmail = mailtoEmail;
            emailMethod = "mailto_link";
            emailsFound++;
            logger.info("researcher", `Found email via mailto for "${lead.business_name}"`, { email: mailtoEmail });
          }
        }
        if (!foundEmail && lead.website && websiteText) {
          logger.info("researcher", `Starting agentic email search for "${lead.business_name}"`);
          const result = await agenticEmailSearch({
            business_name: lead.business_name,
            website_url: lead.website,
            category: lead.category_name ?? "",
            homepage_content: websiteText
          });
          if (result.email) {
            foundEmail = result.email;
            emailsFound++;
            logger.info("researcher", `Found email via ${result.method} in ${result.rounds} round(s)`, { email: result.email });
          } else {
            logger.info("researcher", `No email found for "${lead.business_name}" after ${result.rounds} round(s)`);
          }
          emailMethod = result.method;
          emailRounds = result.rounds;
          methodCounts[result.method] = (methodCounts[result.method] ?? 0) + 1;
        } else if (foundEmail) {
          emailMethod = "outscraper";
          methodCounts["outscraper"] = (methodCounts["outscraper"] ?? 0) + 1;
        } else {
          emailMethod = "no_website";
          methodCounts["no_website"] = (methodCounts["no_website"] ?? 0) + 1;
        }
        let enriched = {
          description: "",
          services: "",
          instagram_handle: null,
          facebook_url: null,
          other_social: null
        };
        if (websiteText) {
          enriched = await extractWebsiteData(websiteText);
        }
        if (!enriched.instagram_handle && lead.business_name) {
          const cleanName = lead.business_name.toLowerCase().replace(/[^a-z0-9]/g, "");
          enriched.instagram_handle = `@${cleanName}`;
        }
        const { error: updateErr } = await supabase.from("leads").update({
          ...foundEmail && !lead.email ? { email: foundEmail } : {},
          description: enriched.description || null,
          services: enriched.services || null,
          instagram_handle: enriched.instagram_handle || null,
          facebook_url: enriched.facebook_url || null,
          status: "researched"
        }).eq("id", lead.id);
        if (updateErr) {
          logger.error("researcher", `Lead update failed for "${lead.business_name}"`, { error: updateErr.message });
        }
        await supabase.from("activity_log").insert({
          event_type: "lead_researched",
          lead_id: lead.id,
          description: `Researched: ${lead.business_name} | email: ${foundEmail ? "found" : "not found"} via ${emailMethod}`,
          metadata: {
            email_found: !!foundEmail,
            email_method: emailMethod,
            email_rounds: emailRounds,
            has_instagram: !!enriched.instagram_handle,
            has_website: !!lead.website
          }
        });
        processed++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("researcher", `Exception for "${lead.business_name}": ${msg}`);
        await supabase.from("activity_log").insert({
          event_type: "agent_error",
          lead_id: lead.id,
          description: `Error researching: ${lead.business_name}: ${msg}`,
          metadata: { error: msg }
        });
        await supabase.from("leads").update({ status: "researched" }).eq("id", lead.id);
      }
    }
    logger.info("researcher", `Done: ${processed} leads processed, ${emailsFound} emails found`, { methodCounts });
    await supabase.from("activity_log").insert({
      event_type: "researcher_complete",
      description: `Researcher agent completed — ${processed} leads, ${emailsFound} emails found`,
      metadata: { total_processed: processed, emails_found: emailsFound, method_counts: methodCounts }
    });
    return processed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("researcher", "Fatal error", { error: message, stack: error instanceof Error ? error.stack : null });
    await supabase.from("activity_log").insert({
      event_type: "agent_error",
      description: `Agent failed: ${message}`,
      metadata: {
        agent: "researcher",
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
    throw error;
  }
}
__name(runResearcherAgent, "runResearcherAgent");

// agents/writer.ts
init_esm();
async function runWriterAgent() {
  logger.info("writer", "Writer agent starting");
  const supabase = createServiceClient();
  try {
    const { data: systemSetting, error: settingErr } = await supabase.from("settings").select("value").eq("key", "system_active").single();
    logger.info("writer", `system_active = "${systemSetting?.value}"`, { err: settingErr?.message ?? "none" });
    if (systemSetting?.value !== "true") {
      logger.info("writer", "System paused — writer skipped");
      return;
    }
    const { data: dmLimitSetting } = await supabase.from("settings").select("value").eq("key", "daily_dm_limit").single();
    const dailyDmLimit = parseInt(dmLimitSetting?.value ?? "10", 10);
    const todayStart = /* @__PURE__ */ new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayDmCount } = await supabase.from("dm_queue").select("*", { count: "exact", head: true }).gte("created_at", todayStart.toISOString());
    let dmsAddedToday = todayDmCount ?? 0;
    logger.info("writer", `DM limit: ${dailyDmLimit}, already queued today: ${dmsAddedToday}`);
    const { data: emailReadyLeads } = await supabase.from("leads").select("id").eq("status", "email_ready");
    if (emailReadyLeads?.length) {
      const emailReadyIds = emailReadyLeads.map((l) => l.id);
      const { data: emailsWithPending } = await supabase.from("emails").select("lead_id").in("lead_id", emailReadyIds).eq("status", "pending_send");
      const withPendingSet = new Set(emailsWithPending?.map((e) => e.lead_id) ?? []);
      const toReset = emailReadyIds.filter((id) => !withPendingSet.has(id));
      if (toReset.length) {
        logger.info("writer", `Resetting ${toReset.length} stale email_ready leads back to researched`);
        const { error: resetErr } = await supabase.from("leads").update({ status: "researched" }).in("id", toReset);
        if (resetErr) logger.error("writer", "Reset error", { error: resetErr.message });
      }
    }
    const { data: leads, error: leadsErr } = await supabase.from("leads").select("*, categories(*)").eq("status", "researched");
    if (leadsErr) logger.error("writer", "Error fetching researched leads", { error: leadsErr.message });
    if (!leads?.length) {
      logger.info("writer", "No researched leads found — nothing to process");
      return;
    }
    logger.info("writer", `${leads.length} researched leads`, {
      withEmail: leads.filter((l) => l.email).length,
      instagramOnly: leads.filter((l) => !l.email && l.instagram_handle).length
    });
    let processed = 0;
    let emailsQueued = 0;
    let dmsQueued = 0;
    let deadCount = 0;
    for (const lead of leads) {
      const hasEmail = !!lead.email;
      const hasInstagram = !!lead.instagram_handle;
      logger.info("writer", `"${lead.business_name}"`, { email: lead.email ?? "NONE", instagram: lead.instagram_handle ?? "NONE" });
      if (!hasEmail && !hasInstagram) {
        logger.info("writer", `Dead (no email, no instagram): "${lead.business_name}"`);
        await supabase.from("leads").update({ status: "dead" }).eq("id", lead.id);
        await supabase.from("activity_log").insert({
          event_type: "lead_dead",
          lead_id: lead.id,
          description: `No email and no Instagram — marked dead: ${lead.business_name}`
        });
        deadCount++;
        continue;
      }
      try {
        const VISIT_ELIGIBLE = [
          "Halal Restaurants",
          "Halal Cafes",
          "Halal Bakeries / Dessert Shops",
          "Nail Salons",
          "Hair Salons",
          "Beauty / Lash Studios",
          "Spas / Massage Studios",
          "Hotels / Resorts"
        ];
        const isSydney = lead.city?.toLowerCase() === "sydney";
        const contentType = isSydney && VISIT_ELIGIBLE.includes(lead.category_name) ? "visit" : "remote";
        if (hasEmail) {
          const emailResult = await writeOutreachEmail({
            business_name: lead.business_name,
            category: lead.category_name,
            suburb: lead.suburb ?? "",
            city: lead.city,
            website: lead.website ?? "",
            description: lead.description ?? "",
            services: lead.services ?? "",
            content_type: contentType
          });
          logger.info("writer", `Email written for "${lead.business_name}"`, { subject: emailResult.subject });
          const { error: insertErr } = await supabase.from("emails").insert({
            lead_id: lead.id,
            type: "initial_pitch",
            subject: emailResult.subject,
            body_html: emailBodyToHtml(emailResult.body),
            body_text: emailResult.body,
            status: "pending_send"
          });
          if (insertErr) {
            logger.error("writer", `Email insert failed for "${lead.business_name}" (${lead.email})`, { error: insertErr.message, code: insertErr.code });
          } else {
            logger.info("writer", `Email queued for "${lead.business_name}" (${lead.email})`);
            await supabase.from("leads").update({ status: "email_ready" }).eq("id", lead.id);
            emailsQueued++;
          }
        } else {
          if (dmsAddedToday >= dailyDmLimit) {
            logger.info("writer", `DM limit reached (${dailyDmLimit}) — skipping DM for "${lead.business_name}"`);
            continue;
          }
          const dmText = await writeOutreachDM({
            business_name: lead.business_name,
            suburb: lead.suburb ?? "",
            city: lead.city,
            category: lead.category_name
          });
          let dmInserted = false;
          if (lead.instagram_handle && dmsAddedToday < dailyDmLimit) {
            const { data: existing } = await supabase.from("dm_queue").select("id").or(`lead_id.eq.${lead.id},handle.eq.${lead.instagram_handle}`).limit(1);
            if (existing?.length) {
              logger.info("writer", `Skip DM for "${lead.business_name}" — already in dm_queue`);
            } else {
              const { error: igErr } = await supabase.from("dm_queue").insert({
                lead_id: lead.id,
                platform: "instagram",
                handle: lead.instagram_handle,
                message_text: dmText,
                status: "pending"
              });
              if (igErr) {
                logger.error("writer", `Instagram DM insert failed for "${lead.business_name}"`, { error: igErr.message });
              } else {
                dmInserted = true;
                dmsAddedToday++;
                dmsQueued++;
                logger.info("writer", `Instagram DM queued for "${lead.business_name}"`, { handle: lead.instagram_handle });
              }
            }
          }
          if (dmInserted) {
            await supabase.from("leads").update({ status: "dm_queued" }).eq("id", lead.id);
          }
        }
        await supabase.from("activity_log").insert({
          event_type: "outreach_written",
          lead_id: lead.id,
          description: `Outreach written: ${lead.business_name} (${hasEmail ? "email" : "dm"})`,
          metadata: { channel: hasEmail ? "email" : "instagram" }
        });
        processed++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("writer", `Exception for "${lead.business_name}": ${msg}`);
        await supabase.from("activity_log").insert({
          event_type: "agent_error",
          lead_id: lead.id,
          description: `Error writing for: ${lead.business_name}: ${msg}`,
          metadata: { error: msg }
        });
      }
    }
    logger.info("writer", "Done", { emailsQueued, dmsQueued, deadCount });
    await supabase.from("activity_log").insert({
      event_type: "writer_complete",
      description: `Writer complete: ${emailsQueued} emails, ${dmsQueued} DMs, ${deadCount} dead`,
      metadata: {
        emails_queued: emailsQueued,
        dms_queued: dmsQueued,
        dead_count: deadCount,
        total_processed: processed
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("writer", "Fatal error", { error: message, stack: error instanceof Error ? error.stack : null });
    await supabase.from("activity_log").insert({
      event_type: "agent_error",
      description: `Agent failed: ${message}`,
      metadata: {
        agent: "writer",
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
    throw error;
  }
}
__name(runWriterAgent, "runWriterAgent");

// agents/sender.ts
init_esm();
async function runSenderAgent() {
  const supabase = createServiceClient();
  try {
    const { data: systemSetting } = await supabase.from("settings").select("value").eq("key", "system_active").single();
    logger.info("sender", `system_active = "${systemSetting?.value}"`);
    if (systemSetting?.value !== "true") {
      logger.info("sender", "System paused - skipped");
      return { sent: 0, failed: 0 };
    }
    const { data: limitSetting } = await supabase.from("settings").select("value").eq("key", "daily_email_limit").single();
    const dailyLimit = parseInt(limitSetting?.value ?? "50", 10);
    logger.info("sender", `daily_email_limit = ${dailyLimit}`);
    const today = getAnalyticsDayRange();
    const { count: sentToday } = await supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "sent").eq("type", "initial_pitch").gte("sent_at", today.start).lt("sent_at", today.end);
    const remainingToday = Math.max(0, dailyLimit - (sentToday ?? 0));
    logger.info("sender", "[OUTREACH_SENT]", {
      new_outreach_sent_today: sentToday ?? 0,
      daily_email_limit: dailyLimit,
      remaining_new_outreach_email_capacity: remainingToday,
      today_range: today
    });
    if (remainingToday <= 0) {
      logger.info("sender", "New outreach email daily limit reached - sender skipped");
      return { sent: 0, failed: 0 };
    }
    const { count: pendingCount } = await supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "pending_send");
    logger.info("sender", `emails with status=pending_send: ${pendingCount ?? 0}`);
    const { count: emailReadyCount } = await supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "email_ready");
    logger.info("sender", `leads with status=email_ready: ${emailReadyCount ?? 0}`);
    const { count: emailReadyWithEmail } = await supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "email_ready").not("email", "is", null);
    logger.info("sender", `email_ready leads with a real email: ${emailReadyWithEmail ?? 0}`);
    const { data: pendingEmails } = await supabase.from("emails").select("*, leads(email, business_name)").eq("status", "pending_send").eq("type", "initial_pitch").order("created_at", { ascending: true }).limit(remainingToday);
    logger.info("sender", `fetched ${pendingEmails?.length ?? 0} pending emails to process`);
    if (!pendingEmails?.length) {
      logger.info("sender", "No pending emails — emails table has no pending_send rows");
      return { sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    const total = pendingEmails.length;
    for (let i = 0; i < pendingEmails.length; i++) {
      const emailRecord = pendingEmails[i];
      const lead = emailRecord.leads;
      if (!lead?.email) {
        logger.info("sender", `#${i + 1}/${total} SKIP — no email address for lead`, { lead_id: emailRecord.lead_id });
        await supabase.from("emails").update({ status: "failed" }).eq("id", emailRecord.id);
        failed++;
        continue;
      }
      const { data: alreadySent } = await supabase.from("emails").select("id").eq("lead_id", emailRecord.lead_id).eq("status", "sent").neq("id", emailRecord.id).limit(1);
      if (alreadySent?.length) {
        logger.warn("sender", `Idempotency skip: already sent to lead`, { lead_id: emailRecord.lead_id });
        await supabase.from("emails").update({ status: "failed" }).eq("id", emailRecord.id);
        continue;
      }
      logger.info("sender", `#${i + 1}/${total} Sending to ${lead.email} (${lead.business_name})`, { subject: emailRecord.subject });
      try {
        const result = await sendEmail({
          to: lead.email,
          subject: emailRecord.subject,
          html: emailRecord.body_html,
          text: emailRecord.body_text,
          leadId: emailRecord.lead_id
        });
        if (result) {
          logger.info("sender", `#${i + 1}/${total} SUCCESS`, { resend_id: result.id, to: lead.email });
          await supabase.from("emails").update({
            status: "sent",
            resend_id: result.id,
            sent_at: (/* @__PURE__ */ new Date()).toISOString()
          }).eq("id", emailRecord.id);
          await supabase.from("leads").update({ status: "contacted" }).eq("id", emailRecord.lead_id);
          await supabase.from("activity_log").insert({
            event_type: "email_sent",
            lead_id: emailRecord.lead_id,
            description: `Email sent to ${lead.business_name} (${lead.email})`,
            metadata: { resend_id: result.id, subject: emailRecord.subject }
          });
          sent++;
        } else {
          logger.error("sender", `#${i + 1}/${total} FAILED — sendEmail returned null`, { to: lead.email });
          await supabase.from("emails").update({ status: "failed" }).eq("id", emailRecord.id);
          await supabase.from("dead_letter_queue").insert({
            operation: "send_email",
            payload: { lead_id: emailRecord.lead_id, email: lead.email, subject: emailRecord.subject, email_id: emailRecord.id },
            error: "Resend API returned null/error"
          });
          await supabase.from("activity_log").insert({
            event_type: "email_failed",
            lead_id: emailRecord.lead_id,
            description: `Failed to send email to ${lead.business_name} (${lead.email})`,
            metadata: { to: lead.email, subject: emailRecord.subject }
          });
          failed++;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("sender", `#${i + 1}/${total} EXCEPTION for ${lead.email}: ${msg}`);
        await supabase.from("emails").update({ status: "failed" }).eq("id", emailRecord.id);
        await supabase.from("dead_letter_queue").insert({
          operation: "send_email",
          payload: { lead_id: emailRecord.lead_id, email: lead.email, subject: emailRecord.subject, email_id: emailRecord.id },
          error: msg
        });
        await supabase.from("activity_log").insert({
          event_type: "agent_error",
          lead_id: emailRecord.lead_id,
          description: `Exception sending to ${lead.business_name} (${lead.email}): ${msg}`,
          metadata: { error: msg, to: lead.email }
        });
        failed++;
      }
    }
    await supabase.from("activity_log").insert({
      event_type: "sender_complete",
      description: `Sender agent completed - ${sent} sent, ${failed} failed`,
      metadata: { sent, failed, daily_email_limit: dailyLimit, initial_pitch_sent_before_run: sentToday ?? 0 }
    });
    const estimatedCost = (sent * 11e-4).toFixed(4);
    logger.info("sender", "[OUTREACH_SENT]", { new_outreach_sent: sent });
    logger.info("sender", "Done", { sent, failed });
    logger.info("sender", `Total pipeline cost estimate: $${estimatedCost} (Haiku writing + Resend; see finder log for Outscraper cost)`);
    return { sent, failed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("sender", "Fatal error", { error: message, stack: error instanceof Error ? error.stack : null });
    await supabase.from("activity_log").insert({
      event_type: "agent_error",
      description: `Agent failed: ${message}`,
      metadata: {
        agent: "sender",
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
    throw error;
  }
}
__name(runSenderAgent, "runSenderAgent");

// trigger/daily-pipeline.ts
var dailyPipelineJob = schedules_exports.task({
  id: "daily-pipeline",
  cron: {
    pattern: "0 8 * * *",
    timezone: "Australia/Sydney"
  },
  maxDuration: 3600,
  run: /* @__PURE__ */ __name(async () => {
    console.log("Starting scheduled daily pipeline...");
    let leadsFound = 0;
    try {
      console.log("Step 1: Finder agent");
      leadsFound = await runFinderAgent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("PIPELINE FAILED at Step 1 (Finder):", error);
      throw new Error(`Pipeline failed at Finder: ${message}`);
    }
    try {
      console.log("Step 2: Researcher agent");
      await runResearcherAgent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("PIPELINE FAILED at Step 2 (Researcher):", error);
      throw new Error(`Pipeline failed at Researcher: ${message}`);
    }
    try {
      console.log("Step 3: Writer agent");
      await runWriterAgent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("PIPELINE FAILED at Step 3 (Writer):", error);
      throw new Error(`Pipeline failed at Writer: ${message}`);
    }
    try {
      console.log("Step 4: Sender agent");
      await runSenderAgent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("PIPELINE FAILED at Step 4 (Sender):", error);
      throw new Error(`Pipeline failed at Sender: ${message}`);
    }
    try {
      console.log("Step 5: Follow-up agent");
      await runFollowUpAgent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("PIPELINE FAILED at Step 5 (Follow-up):", error);
      throw new Error(`Pipeline failed at Follow-up: ${message}`);
    }
    console.log("Daily pipeline complete");
    return { leadsFound };
  }, "run")
});
export {
  dailyPipelineJob
};
//# sourceMappingURL=daily-pipeline.mjs.map
