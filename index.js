const express = require("express");
const cors = require("cors");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { DateTime } = require("luxon");

const app = express();
app.use(cors());
app.use(express.json());

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

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
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

// 🕒 Robust date detection for all Luma layouts
let dateTitle = "";
let dateDesc = "";

try {
  // 1️⃣ Try explicit test-id (new layout)
  const testIdEl = document.querySelector("[data-testid='event-date']");
  if (testIdEl && testIdEl.innerText.trim()) {
    const txt = testIdEl.innerText.trim();
    if (txt.includes("•")) {
      [dateTitle, dateDesc] = txt.split("•").map(t => t.trim());
    } else {
      dateTitle = txt;
    }
  }

  // 2️⃣ Try old structure (title/desc pair)
  if (!dateTitle) {
    const titleEl = document.querySelector("div.title.text-ellipses");
    const descEl = document.querySelector("div.desc.text-ellipses");
    if (titleEl) dateTitle = titleEl.innerText.trim();
    if (descEl) dateDesc = descEl.innerText.trim();
  }

  // 3️⃣ Try meta tag (some new events store it there)
  if (!dateTitle) {
    const metaDate = document.querySelector('meta[property="event:start_time"]')?.content;
    if (metaDate) dateTitle = new Date(metaDate).toDateString();
  }

  // 4️⃣ Last fallback — scan all divs for pattern like "Sunday, November 2 • 8:30 AM"
  if (!dateTitle) {
    const candidate = Array.from(document.querySelectorAll("div"))
      .map(d => d.innerText)
      .find(t => t?.match(/\d{1,2}:\d{2}\s*[APMapm]/) && t.includes("•"));
    if (candidate) {
      [dateTitle, dateDesc] = candidate.split("•").map(t => t.trim());
    }
  }
} catch (err) {
  console.warn("⚠️ Date extraction failed:", err);
}

      // Venue name & location
      const venueAddressEl = document.querySelector("div.text-tinted.fs-sm.mt-05");
      const venueAddress = venueAddressEl?.innerText.trim() || "";
      const venueName =
        venueAddressEl?.previousElementSibling?.innerText.trim() || "";

      // Organizer — only first valid host name
      let firstHost = "";
      try {
        const hostContainer =
          document.querySelector('[data-testid="event-host"]') ||
          document.querySelector("div[class*='host']") ||
          document.querySelector("div[class*='OrganizerName']") ||
          document.querySelector("a[href*='/profile/']");

        if (hostContainer) {
          const hostCandidates = Array.from(
            hostContainer.querySelectorAll("a, div, span")
          )
            .map((el) => el.innerText.trim())
            .filter((txt) => txt && txt.length > 1);

          firstHost =
            hostCandidates.find(
              (txt) => /^[A-Za-z]/.test(txt) && !txt.includes("\n")
            ) || hostContainer.innerText.split("\n")[0].trim();
        }

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