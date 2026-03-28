# anki-pathology-slides

Automatically extracts slides from pathology lecture PDFs and adds them as images to matching Anki flashcards.

Built for Monash University pathology, but adaptable to any lecture slide deck + Anki cloze card setup.

## What it does

1. **Reads your PDF lecture slides** — extracts the text from each page to understand what topic each slide covers
2. **Matches slides to cards** — scores each slide against your Anki card text using keyword overlap, finds the best 1–2 matches per card
3. **Renders the slides as images** — uses a local pdfjs renderer via Puppeteer to produce clean, full-quality PNG screenshots
4. **Pushes to Anki** — uploads the images via AnkiConnect and appends them to each card's Back Extra field

101 cards updated in a single run across Disease Mechanisms, Neoplasia, Cardiovascular, and Respiratory decks.

## Requirements

- [Node.js](https://nodejs.org/) v18+
- [Anki](https://apps.ankiweb.net/) with [AnkiConnect](https://ankiweb.net/shared/info/2055492159) plugin installed and running

```bash
npm install
```

## Setup

Edit the top of `add_slides_to_anki.mjs` to point at your files:

```js
const SLIDES_DIR = 'C:\\path\\to\\your\\PDFs';
const CACHE_DIR  = 'C:\\path\\to\\cache\\folder';

const PDF_TO_DECK = {
  'Lecture 1 - Topic.pdf': 'YourDeck::SubDeck',
  // ...
};
```

Make sure AnkiConnect is running (Anki must be open).

## Usage

**Preview matches without touching Anki:**
```bash
node dry_run.mjs
```

**Run the full pipeline:**
```bash
node add_slides_to_anki.mjs
```

Rendered slides are cached in `slide_cache/` so re-runs are fast — only new matches get rendered.

## How matching works

Each card's cloze text is stripped of `{{c1::...}}` markers and tokenised into keywords. Stop words are removed. Each slide page is scored by how many of those keywords appear in the page's extracted text. Pages scoring above the threshold (default: 2) are rendered and added, best matches first (max 2 slides per card).

Cards that already have images are skipped on re-runs.

## Files

| File | Purpose |
|------|---------|
| `add_slides_to_anki.mjs` | Main pipeline |
| `render_slide.mjs` | Puppeteer + local HTTP server for rendering PDF pages |
| `render_page.html` | In-browser pdfjs renderer (served by render_slide.mjs) |
| `dry_run.mjs` | Preview matches without modifying Anki |
