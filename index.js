const express = require("express");
const cors = require("cors");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { DateTime } = require("luxon");

const app = express();
app.use(cors());
app.use(express.json());

// ─── API Key Authentication Middleware ───────────────────────────────
const requireApiKey = (req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next(); // skip auth if no key configured
  const provided = req.headers["x-api-key"];
  if (provided !== apiKey) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }
  next();
};

// ─── Google Maps Distance Matrix Helper ──────────────────────────────
const GOOGLE_MAPS_BASE = "https://maps.googleapis.com/maps/api/distancematrix/json";

async function distanceMatrix(origins, destinations) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not configured");

  const formatPoints = (points) =>
    points.map((p) => `${p.lat},${p.lng}`).join("|");

  const params = new URLSearchParams({
    origins: formatPoints(origins),
    destinations: formatPoints(destinations),
    key: apiKey,
  });

  const resp = await fetch(`${GOOGLE_MAPS_BASE}?${params}`);
  const data = await resp.json();

  if (data.status !== "OK") {
    throw new Error(`Distance Matrix API error: ${data.status} – ${data.error_message || ""}`);
  }
  return data;
}

// ─── POST /matches/ranked ────────────────────────────────────────────
app.post("/matches/ranked", requireApiKey, async (req, res) => {
  try {
    const { mainTrip, candidates } = req.body;

    // Validate request
    if (!mainTrip || !candidates) {
      return res.status(400).json({
        success: false,
        error: "Request body must include mainTrip and candidates",
      });
    }

    const requiredFields = ["originLat", "originLng", "destLat", "destLng", "directDuration"];
    for (const field of requiredFields) {
      if (mainTrip[field] == null) {
        return res.status(400).json({
          success: false,
          error: `mainTrip is missing required field: ${field}`,
        });
      }
    }

    // Empty candidates → return early
    if (candidates.length === 0) {
      return res.json({ success: true, matches: [] });
    }

    // Validate each candidate
    for (let i = 0; i < candidates.length; i++) {
      for (const field of requiredFields) {
        if (candidates[i][field] == null) {
          return res.status(400).json({
            success: false,
            error: `candidates[${i}] is missing required field: ${field}`,
          });
        }
      }
    }

    // Build origins/destinations for the 2 Distance Matrix calls
    const mainOrigin = { lat: mainTrip.originLat, lng: mainTrip.originLng };
    const mainDest = { lat: mainTrip.destLat, lng: mainTrip.destLng };

    const candidateOrigins = candidates.map((c) => ({ lat: c.originLat, lng: c.originLng }));
    const candidateDests = candidates.map((c) => ({ lat: c.destLat, lng: c.destLng }));

    // Call 1: mainOrigin → each candidate origin
    // Call 2: each candidate dest → mainDest
    const [toPickup, toDest] = await Promise.all([
      distanceMatrix([mainOrigin], candidateOrigins),
      distanceMatrix(candidateDests, [mainDest]),
    ]);

    // Compute detour for each candidate
    const matches = candidates.map((candidate, i) => {
      const leg1Element = toPickup.rows[0].elements[i];
      const leg2Element = toDest.rows[i].elements[0];

      // If Google Maps can't route to/from a candidate, skip it
      if (leg1Element.status !== "OK" || leg2Element.status !== "OK") {
        return { id: candidate.id, detourSeconds: null, error: "Route not found" };
      }

      const leg1 = leg1Element.duration.value; // mainOrigin → candidateOrigin
      const leg2 = leg2Element.duration.value; // candidateDest → mainDest
      const detour = leg1 + candidate.directDuration + leg2 - mainTrip.directDuration;

      return { id: candidate.id, detourSeconds: detour };
    });

    // Sort: routable matches by detour ascending, unroutable at end
    matches.sort((a, b) => {
      if (a.detourSeconds == null && b.detourSeconds == null) return 0;
      if (a.detourSeconds == null) return 1;
      if (b.detourSeconds == null) return -1;
      return a.detourSeconds - b.detourSeconds;
    });

    res.json({ success: true, matches });
  } catch (error) {
    console.error("❌ /matches/ranked failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /matches/calendar-check ───────────────────────────────────
app.post("/matches/calendar-check", requireApiKey, async (req, res) => {
  try {
    const { trips, detourThreshold = 1800 } = req.body;

    if (!trips || !Array.isArray(trips) || trips.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Request body must include a non-empty trips array",
      });
    }

    const requiredFields = ["originLat", "originLng", "destLat", "destLng", "directDuration"];

    // Validate all trips up front
    for (let t = 0; t < trips.length; t++) {
      const { mainTrip, candidates } = trips[t];
      if (!mainTrip || !candidates) {
        return res.status(400).json({
          success: false,
          error: `trips[${t}] must include mainTrip and candidates`,
        });
      }
      for (const field of requiredFields) {
        if (mainTrip[field] == null) {
          return res.status(400).json({
            success: false,
            error: `trips[${t}].mainTrip is missing required field: ${field}`,
          });
        }
      }
      for (let c = 0; c < candidates.length; c++) {
        for (const field of requiredFields) {
          if (candidates[c][field] == null) {
            return res.status(400).json({
              success: false,
              error: `trips[${t}].candidates[${c}] is missing required field: ${field}`,
            });
          }
        }
      }
    }

    // Process each trip sequentially (each may need Google Maps calls)
    const results = [];

    for (const trip of trips) {
      const { mainTrip, candidates } = trip;

      // No candidates → no match
      if (candidates.length === 0) {
        results.push({ id: mainTrip.id, hasMatch: false, matchCount: 0, bestDetour: null });
        continue;
      }

      const mainOrigin = { lat: mainTrip.originLat, lng: mainTrip.originLng };
      const mainDest = { lat: mainTrip.destLat, lng: mainTrip.destLng };

      const candidateOrigins = candidates.map((c) => ({ lat: c.originLat, lng: c.originLng }));
      const candidateDests = candidates.map((c) => ({ lat: c.destLat, lng: c.destLng }));

      // 2 Distance Matrix calls per trip (same as /matches/ranked)
      const [toPickup, toDest] = await Promise.all([
        distanceMatrix([mainOrigin], candidateOrigins),
        distanceMatrix(candidateDests, [mainDest]),
      ]);

      let matchCount = 0;
      let bestDetour = null;

      for (let i = 0; i < candidates.length; i++) {
        const leg1Element = toPickup.rows[0].elements[i];
        const leg2Element = toDest.rows[i].elements[0];

        if (leg1Element.status !== "OK" || leg2Element.status !== "OK") continue;

        const leg1 = leg1Element.duration.value;
        const leg2 = leg2Element.duration.value;
        const detour = leg1 + candidates[i].directDuration + leg2 - mainTrip.directDuration;

        if (detour <= detourThreshold) {
          matchCount++;
          if (bestDetour === null || detour < bestDetour) {
            bestDetour = detour;
          }
        }
      }

      results.push({
        id: mainTrip.id,
        hasMatch: matchCount > 0,
        matchCount,
        bestDetour,
      });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error("❌ /matches/calendar-check failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Normalize Luma URLs
const normalizeLumaUrl = (url) =>
  url
    .replace("https://www.luma.com", "https://lu.ma")
    .replace("https://luma.com", "https://lu.ma");

app.post("/scrape-luma-event", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing URL" });

  url = normalizeLumaUrl(url);
  if (!url.includes("lu.ma")) {
    return res
      .status(400)
      .json({ success: false, error: "Please provide a valid Luma event URL." });
  }

  try {
    console.log("🚀 Launching headless Chromium...");

    // const browser = await puppeteer.launch({
    //   args: chromium.args,
    //   defaultViewport: chromium.defaultViewport,
    //   executablePath: await chromium.executablePath(),
    //   headless: chromium.headless,
    // });
    const isLocal = process.platform === "darwin"; // macOS check
    const execPath = isLocal
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : await chromium.executablePath();
    
    console.log("🧭 Using Chrome executable:", execPath);
    
    const browser = await puppeteer.launch({
      args: isLocal
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: execPath,
      headless: chromium.headless,
    });

    console.log("✅ Browser launched successfully");

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("h1", { timeout: 15000 });

    const raw = await page.evaluate(() => {
      const getText = (selectors) => {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim()) return el.innerText.trim();
          } catch {}
        }
        return "";
      };

      const getImage = () => {
        const imgEl = document.querySelector("img[src*='event-covers']");
        if (imgEl) return imgEl.src;
        const meta = document.querySelector('meta[property="og:image"]');
        return meta ? meta.content : "";
      };

// 🕒 Date extraction — updated for 2025 Luma layout
let dateTitle = "";
let dateDesc = "";

try {
  // ✅ Directly target the current Luma structure
  const titleEl = document.querySelector("div.title.text-ellipses");
  const descEl = document.querySelector("div.desc.text-ellipses");

  if (titleEl && titleEl.innerText.trim()) dateTitle = titleEl.innerText.trim();
  if (descEl && descEl.innerText.trim()) dateDesc = descEl.innerText.trim();

  // 🪄 Fallback for legacy layout with "•" separator
  if ((!dateTitle || !dateDesc) && !dateDesc.includes("PST")) {
    const possibleDateEls = Array.from(document.querySelectorAll("div, span, p"))
      .map(el => el.innerText?.trim())
      .filter(txt => txt && txt.match(/(AM|PM)/) && txt.includes("•"));

    if (possibleDateEls.length > 0) {
      const fullDateText = possibleDateEls[0];
      if (fullDateText.includes("•")) {
        [dateTitle, dateDesc] = fullDateText.split("•").map(t => t.trim());
      } else {
        dateTitle = fullDateText.trim();
      }
    }
  }

  // 🧭 Fallback to meta tags if all else fails
  if (!dateTitle && !dateDesc) {
    const metaStart = document.querySelector('meta[property="event:start_time"]')?.content;
    const metaEnd = document.querySelector('meta[property="event:end_time"]')?.content;
    if (metaStart) {
      const start = new Date(metaStart);
      dateTitle = start.toDateString();
      dateDesc = metaEnd
        ? `${new Date(metaStart).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })} - ${new Date(metaEnd).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : "";
    }
  }

  console.log("🧭 Extracted date:", { dateTitle, dateDesc }); // log to verify
} catch (err) {
  console.warn("⚠️ Date extraction error:", err);
}

      // Venue name & location
      const venueAddressEl = document.querySelector("div.text-tinted.fs-sm.mt-05");
      const venueAddress = venueAddressEl?.innerText.trim() || "";
      const venueName =
        venueAddressEl?.previousElementSibling?.innerText.trim() || "";

      // Organizer — prefer the "Presented by" section, then fall back
      let firstHost = "";
      try {
        // 1) Exact structure from provided DOM:
        //    <div.fs-xxs.text-tinted.reduced-line-height>Presented by</div>
        //    <a.title> ... <div.fw-medium.text-ellipses>ORG</div> ... </a>
        const labelEl = Array.from(
          document.querySelectorAll("div.fs-xxs.text-tinted.reduced-line-height")
        ).find((el) => (el.innerText || "").trim().toLowerCase() === "presented by");

        if (labelEl) {
          // Prefer the next sibling anchor with class 'title'
          let anchor = labelEl.nextElementSibling;
          while (anchor && !(anchor.tagName === "A" && anchor.classList.contains("title"))) {
            anchor = anchor.nextElementSibling;
          }

          if (!anchor) {
            // Fallback: search within the same parent container
            anchor = labelEl.parentElement?.querySelector("a.title") || null;
          }

          if (anchor) {
            const orgNode = anchor.querySelector("div.fw-medium.text-ellipses");
            const orgText = orgNode?.innerText?.trim();
            if (orgText) firstHost = orgText;
          }
        }

        // 1b) Generic presented-by search as a softer fallback (nearby text)
        if (!firstHost) {
          const allNodes = Array.from(document.querySelectorAll("div, section, article, aside, span, p, li"));
          const presentedByContainer = allNodes.find((el) => {
            const text = (el.innerText || "").trim().toLowerCase();
            return text.startsWith("presented by") || text.includes("\npresented by") || text === "presented by";
          });
          if (presentedByContainer) {
            const candidates = Array.from(presentedByContainer.querySelectorAll("a, strong, b, span, div"))
              .map((el) => el.innerText?.trim())
              .filter((t) => t && t.length > 1 && !/^presented by$/i.test(t));
            const candidate = candidates.find((t) => /^[A-Za-z]/.test(t) && !t.includes("\n"));
            if (candidate) firstHost = candidate;
            if (!firstHost) {
              const raw = (presentedByContainer.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
              const labelIdx = raw.findIndex((t) => /^presented by$/i.test(t) || t.toLowerCase().startsWith("presented by"));
              if (labelIdx > -1 && raw[labelIdx + 1]) firstHost = raw[labelIdx + 1];
            }
          }
        }

        // 2) If not found, try dedicated host containers
        if (!firstHost) {
          const hostContainer =
            document.querySelector('[data-testid="event-host"]') ||
            document.querySelector("div[class*='host']") ||
            document.querySelector("div[class*='OrganizerName']") ||
            document.querySelector("a[href*='/profile/']");

          if (hostContainer) {
            const hostCandidates = Array.from(hostContainer.querySelectorAll("a, div, span"))
              .map((el) => el.innerText.trim())
              .filter((txt) => txt && txt.length > 1);
            firstHost = hostCandidates.find((txt) => /^[A-Za-z]/.test(txt) && !txt.includes("\n")) || hostContainer.innerText.split("\n")[0].trim();
          }
        }

        // 3) Last resort: any profile link
        if (!firstHost) {
          const globalHost = document.querySelector("a[href*='/profile/']");
          if (globalHost) firstHost = globalHost.innerText.trim();
        }
      } catch (e) {
        console.warn("⚠️ Organizer parse failed:", e);
      }

      return {
        title: getText(["h1"]),
        dateTitle,
        dateDesc,
        venue: venueName,
        locationText: venueAddress,
        organizer: firstHost,
        image: getImage(),
      };
    });

    await browser.close();

    // 🧠 Combine date parts
    const timeMatch = raw.dateDesc.match(
      /(\d{1,2}:\d{2}\s*[APMapm]+)\s*-\s*(\d{1,2}:\d{2}\s*[APMapm]+)/
    );
    const [startTime, endTime] = timeMatch ? [timeMatch[1], timeMatch[2]] : ["", ""];

    let startISO = "",
      endISO = "";
    try {
      if (raw.dateTitle && startTime && endTime) {
        const baseDate = raw.dateTitle.replace(",", "");
        const start = DateTime.fromFormat(
          `${baseDate} ${startTime}`,
          "cccc LLLL d h:mm a"
        );
        const end = DateTime.fromFormat(
          `${baseDate} ${endTime}`,
          "cccc LLLL d h:mm a"
        );
        if (start.isValid)
          startISO = start.toISO({ suppressMilliseconds: true, includeOffset: false });
        if (end.isValid)
          endISO = end.toISO({ suppressMilliseconds: true, includeOffset: false });
      }
    } catch (err) {
      console.warn("⚠️ Date parse failed:", err.message);
    }

    // Blank out non-real addresses (hidden behind registration or city-only)
    const isHiddenVenue = (text) => {
      if (!text) return false;
      const lower = text.toLowerCase();
      if (lower.includes("register") && (lower.includes("address") || lower.includes("location"))) return true;
      if (lower.includes("rsvp") && (lower.includes("address") || lower.includes("location"))) return true;
      return false;
    };

    const isCityOnly = (text) => {
      if (!text) return true;
      if (/\d/.test(text)) return false; // has a street number → real address
      // "City, ST" or "City, State" (e.g. "San Francisco, CA" or "San Francisco, California")
      if (/^[A-Za-z\s]+,\s*[A-Za-z]{2,}$/.test(text.trim())) return true;
      return false;
    };

    if (isHiddenVenue(raw.venue) || isHiddenVenue(raw.locationText) || isCityOnly(raw.locationText)) {
      raw.locationText = "";
      raw.venue = "";
    }

    const data = {
      title: raw.title,
      date_text: `${raw.dateTitle} • ${raw.dateDesc}`,
      date_start: startISO,
      date_end: endISO,
      venue: raw.venue,
      location_text: raw.locationText,
      location_geographic: raw.locationText,
      organizer: raw.organizer,
      image: raw.image,
    };

    console.log("✅ Successfully scraped:", data.title);
    res.json({ success: true, url, data });
  } catch (error) {
    console.error("❌ Scraping failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});