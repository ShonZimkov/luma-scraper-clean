# Luma Event Scraper - Fixed for Render

## 🔧 What Was Fixed

The original error was:
```
Could not find Chrome (ver. 141.0.7390.54). This can occur if either
1. you did not perform an installation before running the script
2. your cache path is incorrectly configured (which is: /opt/render/.cache/puppeteer)
```

### Changes Made:

1. **Dockerfile Updates:**
   - Removed `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` environment variable
   - Removed `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` (was pointing to wrong location)
   - Added `RUN npx puppeteer browsers install chrome` to explicitly install Chrome after npm install
   - Added missing Chrome dependencies (`libxss1`, `libxtst6`)

2. **index.js Updates:**
   - Removed `executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined` from browser launch
   - Now uses Puppeteer's default Chrome installation path

## 📦 Deployment Instructions

### Step 1: Update Your GitHub Repository

Replace these files in your repository:
- `Dockerfile`
- `index.js`
- `package.json`
- `.gitignore`
- `render.yaml`

```bash
# In your local repo directory:
git add .
git commit -m "Fix Puppeteer Chrome installation"
git push origin main
```

### Step 2: Deploy on Render

Option A: **If you already have a service on Render:**
1. Go to your Render dashboard
2. Click on your `luma-scraper` service
3. Click "Manual Deploy" → "Deploy latest commit"
4. Wait for the build to complete

Option B: **If this is a new deployment:**
1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Render will auto-detect the `render.yaml` configuration
5. Click "Apply" and wait for deployment

### Step 3: Test the API

Once deployed, test with:
```bash
curl -X POST https://your-service.onrender.com/scrape-luma-event \
  -H "Content-Type: application/json" \
  -d '{"url": "https://lu.ma/your-event-slug"}'
```

## 🐛 Troubleshooting

If you still encounter issues:

1. **Check Render Logs:**
   - Go to your service → "Logs" tab
   - Look for any error messages during build or runtime

2. **Build Time Issues:**
   - The first build may take 5-10 minutes (installing Chrome is slow)
   - Subsequent builds should be faster due to Docker layer caching

3. **Memory Issues on Free Tier:**
   - If Chrome crashes, you may need to upgrade to a paid plan
   - Free tier has 512MB RAM which is tight for Puppeteer

## 📝 API Endpoint

**POST** `/scrape-luma-event`

Request body:
```json
{
  "url": "https://lu.ma/your-event-slug"
}
```

Response:
```json
{
  "success": true,
  "url": "https://lu.ma/your-event-slug",
  "data": {
    "title": "Event Title",
    "date_text": "Monday, January 20 • 6:00 PM - 9:00 PM",
    "date_start": "2025-01-20T18:00:00",
    "date_end": "2025-01-20T21:00:00",
    "location_text": "123 Main St, City, State",
    "location_geographic": "123 Main St, City, State",
    "organizer": "Event Organizer Name",
    "image": "https://image-url.jpg"
  }
}
```

## 🚀 How It Works

1. Accepts a Luma event URL
2. Launches headless Chrome via Puppeteer
3. Navigates to the event page
4. Extracts event data using DOM selectors
5. Parses dates using Luxon
6. Returns structured JSON data

## 📄 License

ISC
