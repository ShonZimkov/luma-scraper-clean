const express = require("express");
const cors = require("cors");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { DateTime } = require("luxon");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// 🧭 Robust browser launcher that works across Render environments
async function launchBrowser() {
  const chromePaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];

  let executablePath;
  for (const path of chromePaths) {
    try {
      fs.accessSync(path);
      executablePath = path;
      console.log(`🎯 Found Chrome executable at: ${path}`);
      break;
    } catch {}
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
    executablePath: executablePath || puppeteer.executablePath()
  });

  return browser;
}

const normalizeLumaUrl = (url) => {
  return url
    .replace("https://www.luma.com", "https://lu.ma")
    .replace("https://luma.com", "https://lu.ma");
};

app.post("/scrape-luma-event", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL." });

  // Normalize
  url = normalizeLumaUrl(url);

  if (!url || !url.includes("lu.ma")) {
    return res.status(400).json({ error: "Please provide a valid Luma event URL." });
  }

  try {
    console.log("🚀 Launching headless browser...");

    let browser;
    
    if (process.platform === "darwin") {
      // 🧭 macOS or local dev → use full Puppeteer
      const puppeteer = require("puppeteer");
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath: puppeteer.executablePath(),
      });
      console.log("✅ Local Puppeteer launched");
    } else {
      // 🧭 Render/Linux → use Sparticuz Chromium (lightweight build)
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
      console.log("✅ Render Chromium launched");
    }

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("h1", { timeout: 15000 });

    const raw = await page.evaluate(() => {
      const getText = (selectors) => {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim()) return el.innerText.trim();
          } catch (e) {}
        }
        return "";
      };
    
      const getImage = () => {
        const imgEl = document.querySelector("img[src*='event-covers']");
        if (imgEl) return imgEl.src;
        const meta = document.querySelector('meta[property="og:image"]');
        return meta ? meta.content : "";
      };
    
      // Date details
      const dateTitle = document.querySelector("div.title.text-ellipses")?.innerText.trim() || "";
      const dateDesc = document.querySelector("div.desc.text-ellipses")?.innerText.trim() || "";
    
      // Venue name and location
      const venueAddressEl = document.querySelector("div.text-tinted.fs-sm.mt-05");
      const venueAddress = venueAddressEl?.innerText.trim() || "";
      const venueName = venueAddressEl?.previousElementSibling?.innerText.trim() || "";
    
      // Organizer — only first host name
// Organizer — only first valid host name
// Organizer — reliably get first host name (handles multiple organizers)
let firstHost = "";

try {
  // grab the main container that holds the host names
  const hostContainer =
    document.querySelector('[data-testid="event-host"]') ||
    document.querySelector("div[class*='host']") ||
    document.querySelector("div[class*='OrganizerName']") ||
    document.querySelector("a[href*='/profile/']");

  if (hostContainer) {
    // look for all anchor tags or direct child divs inside
    const hostCandidates = Array.from(
      hostContainer.querySelectorAll("a, div, span")
    )
      .map(el => el.innerText.trim())
      .filter(txt => txt && txt.length > 1);

    // pick the very first name-like entry (ignoring roles or multiline)
    firstHost =
      hostCandidates.find(txt => /^[A-Za-z]/.test(txt) && !txt.includes("\n")) ||
      hostContainer.innerText.split("\n")[0].trim();
  }

  // if still empty, look globally for the first profile link
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
        organizer: firstHost, // 🆕 Only first host
        image: getImage(),
      };
    });

    await browser.close();

    // 🧠 Combine date parts
    const fullDateText = `${raw.dateTitle} ${raw.dateDesc}`.replace("•", " ").trim();

    // Extract time range (e.g. "6:00 PM - 9:00 PM")
    const timeMatch = raw.dateDesc.match(/(\d{1,2}:\d{2}\s*[APMapm]+)\s*-\s*(\d{1,2}:\d{2}\s*[APMapm]+)/);
    const [startTime, endTime] = timeMatch ? [timeMatch[1], timeMatch[2]] : ["", ""];

    // Parse into simple ISO strings (no timezone adjustments)
    let startISO = "", endISO = "";
    try {
      if (raw.dateTitle && startTime && endTime) {
        const baseDate = raw.dateTitle.replace(",", "");
        const start = DateTime.fromFormat(`${baseDate} ${startTime}`, "cccc LLLL d h:mm a");
        const end = DateTime.fromFormat(`${baseDate} ${endTime}`, "cccc LLLL d h:mm a");
        if (start.isValid) startISO = start.toISO({ suppressMilliseconds: true, includeOffset: false });
        if (end.isValid) endISO = end.toISO({ suppressMilliseconds: true, includeOffset: false });
      }
    } catch (err) {
      console.warn("⚠️ Date parse failed:", err.message);
    }

    // ✅ Final structured data for Bubble
    const data = {
      title: raw.title,
      date_text: `${raw.dateTitle} • ${raw.dateDesc}`,
      date_start: startISO,
      date_end: endISO,
      venue: raw.venue, // ✅ new field
      location_text: raw.locationText,
      location_geographic: raw.locationText,
      organizer: raw.organizer, // ✅ now first host only
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
  console.log("🎭 Using Puppeteer base image with pre-installed Chrome");
});
