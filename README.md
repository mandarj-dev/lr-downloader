# LR Document Downloader

A small web app that fetches LR (docket) documents from an S3 bucket and
downloads them as a ZIP file in your browser, organized by Invoice No.

For each LR number you provide, it tries (in order):

```
<BASE_S3_URL><LR_NO><POD_SUFFIX>.pdf
<BASE_S3_URL><LR_NO><POD_SUFFIX>.jpg
<BASE_S3_URL><LR_NO><POD_SUFFIX>.jpeg
<BASE_S3_URL><LR_NO><POD_SUFFIX>.png
```

(`POD_SUFFIX` defaults to `_pod`, so e.g. `LR1001_pod.pdf`. Files are saved in the ZIP as `<LR_NO>.<ext>`.)

...and includes the first one that exists in:

```
<Invoice No.>/<LR_NO>.<ext>
```

inside a downloaded ZIP.

## Setup (local)

1. **Install Python 3.10+** if you don't already have it.

2. **Create a virtual environment and install dependencies:**

   ```bash
   cd lr-downloader
   python3 -m venv venv
   source venv/bin/activate      # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. **Configure your `.env` file:**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` if you need to change the S3 URL or extension order.

## Run locally

```bash
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Then open **http://127.0.0.1:8000** in your browser.

- Enter the **Invoice No.** (this becomes the ZIP / folder name)
- Paste your **LR Numbers**, one per line (or comma-separated)
- Click **Download Documents** — your browser will save a ZIP

## Deploy to Vercel

1. Install the Vercel CLI (if needed): `npm i -g vercel`
2. From this folder, run: `vercel`
3. For production: `vercel --prod`
4. Optional: set `BASE_S3_URL`, `EXTENSIONS`, etc. in the Vercel project
   **Settings → Environment Variables**

The app is a FastAPI project (`app` in `app.py`). Vercel detects it
automatically. `vercel.json` sets `maxDuration` to 60s so larger batches
can finish.

## Notes

- Only alphanumeric characters, spaces, hyphens, underscores, and dots are
  allowed in the Invoice No. and LR numbers — anything else is stripped.
- LR numbers are de-duplicated automatically.
- Downloads run concurrently (default: 5 at a time).
- A `_results.json` manifest is included inside each ZIP.
- On Vercel, keep batch sizes reasonable — serverless functions have time
  and response-size limits.
