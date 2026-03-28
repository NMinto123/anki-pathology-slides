/**
 * Main pipeline: extracts relevant slides from CCLN PDFs and adds them to matching Anki cards.
 *
 * Strategy:
 * 1. For each CCLN PDF (matched to an Anki deck by topic):
 *    a. Extract text from each page to build a page→topic map
 *    b. Identify pages that have embedded content images (non-background)
 * 2. For each Anki card:
 *    a. Strip cloze markers, extract keywords
 *    b. Find the best-matching PDF pages by keyword overlap
 *    c. Render matching pages as PNG slides
 *    d. Upload to Anki media, add img tag to Back Extra
 */

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { init as initRenderer, close as closeRenderer, renderPage } from './render_slide.mjs';
import fs from 'fs';
import path from 'path';

const SLIDES_DIR = 'C:\\Users\\noahm\\downloads\\Pathology Slides';
const CACHE_DIR  = 'C:\\Users\\noahm\\pdf_extract\\slide_cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Map PDF files to Anki deck names
const PDF_TO_DECK = {
  '2026 CCLN 1 Disease Mechanisms.pdf':         'Pathology::Disease Mechanisms',
  '2026 CCLN 2 Neoplasia.pdf':                  'Pathology::Neoplastic',
  '2026 CCLN 3 Cardiovascular.pdf':             'Pathology::Cardiovascular Pathology',
  '2026 CCLN 4 Respiratory 1 - Non Neoplastic.pdf': 'Pathology::Respiratory Pathology',
  '2026 CCLN 5 Respiratory 2 - Neoplastic.pdf': 'Pathology::Respiratory Pathology',
};

// Common stop words to ignore during keyword matching
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'to','of','in','for','on','with','at','by','from','as','or','and','but','not',
  'it','its','this','that','these','those','their','they','which','what','where',
  'when','how','if','then','than','so','up','out','into','about','also','more',
  'other','such','between','through','during','before','after','above','below',
  'most','some','all','any','both','each','few','many','same','than','too',
  'very','just','because','while','although','however','therefore','thus',
]);

function extractKeywords(text) {
  // Remove cloze markers
  const clean = text.replace(/\{\{c\d+::(.*?)\}\}/g, '$1').toLowerCase();
  const words = clean.match(/\b[a-z]{3,}\b/g) || [];
  return words.filter(w => !STOP_WORDS.has(w));
}

function scoreMatch(cardKeywords, pageText) {
  const pageWords = new Set(pageText.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
  let score = 0;
  for (const kw of cardKeywords) {
    if (pageWords.has(kw)) score++;
    // Partial match bonus
    for (const pw of pageWords) {
      if (pw.includes(kw) || kw.includes(pw)) score += 0.3;
    }
  }
  return score;
}

async function getPdfPageData(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await getDocument({ data, disableWorker: true }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join(' ');

    // Count non-background images (background is always 1999x1499)
    const opList = await page.getOperatorList();
    let hasContentImages = false;
    for (let j = 0; j < opList.fnArray.length; j++) {
      if (opList.fnArray[j] === OPS.paintImageXObject ||
          opList.fnArray[j] === OPS.paintInlineImageXObject) {
        // We have at least one image — check if it's not the background
        // Background images show up first and are very large; content images follow
        hasContentImages = true;
        break;
      }
    }

    pages.push({ pageNum: i, text, hasImages: hasContentImages });
  }
  return pages;
}

// ── Anki API helper ─────────────────────────────────────────────────────────

async function ankiRequest(action, params = {}) {
  const body = JSON.stringify({ action, version: 6, params });
  const resp = await fetch('http://127.0.0.1:8765', { method: 'POST', body });
  const json = await resp.json();
  if (json.error) throw new Error(`AnkiConnect: ${json.error}`);
  return json.result;
}

async function getNotesInDeck(deckName) {
  const ids = await ankiRequest('findNotes', { query: `deck:"${deckName}"` });
  const notes = await ankiRequest('notesInfo', { notes: ids });
  return notes;
}

async function storeMedia(filename, filepath) {
  return ankiRequest('storeMediaFile', { filename, path: filepath });
}

async function updateNoteField(noteId, fieldName, newValue) {
  return ankiRequest('updateNoteFields', {
    note: { id: noteId, fields: { [fieldName]: newValue } }
  });
}

// ── Main pipeline ────────────────────────────────────────────────────────────

const MIN_SCORE = 2;       // Minimum keyword match score to add a slide
const MAX_SLIDES_PER_CARD = 2; // Max slides to add per card
const SLIDE_SCALE = 1.5;   // Render scale (lower = faster, smaller files)

console.log('Initialising browser renderer...');
await initRenderer();

let totalAdded = 0;
let totalSkipped = 0;

for (const [pdfFile, deckName] of Object.entries(PDF_TO_DECK)) {
  const pdfPath = path.join(SLIDES_DIR, pdfFile);
  console.log(`\n== Processing: ${pdfFile} → ${deckName} ==`);

  // Get all page text + image info
  console.log('  Extracting page data...');
  const pages = await getPdfPageData(pdfPath);
  const contentPages = pages.filter(p => p.hasImages && p.pageNum > 2); // skip title/acknowledgement

  console.log(`  ${pages.length} pages total, ${contentPages.length} with images`);

  // Get Anki notes for this deck
  const notes = await getNotesInDeck(deckName);
  console.log(`  ${notes.length} cards in deck`);

  for (const note of notes) {
    const cardText = note.fields['Text']?.value || '';
    if (!cardText) continue;

    const keywords = extractKeywords(cardText);
    if (keywords.length < 2) continue;

    // Score each page against this card
    const scored = contentPages.map(p => ({
      ...p,
      score: scoreMatch(keywords, p.text)
    })).filter(p => p.score >= MIN_SCORE)
       .sort((a, b) => b.score - a.score)
       .slice(0, MAX_SLIDES_PER_CARD);

    if (scored.length === 0) {
      totalSkipped++;
      continue;
    }

    // Check if card already has images
    const backExtra = note.fields['Back Extra']?.value || '';
    if (backExtra.includes('<img')) {
      console.log(`  [SKIP] Note ${note.noteId} already has images`);
      totalSkipped++;
      continue;
    }

    // Render and upload each matching slide
    let imgHtml = backExtra ? backExtra + '<br>' : '';
    for (const p of scored) {
      const safeName = `path_slide_${pdfFile.replace(/[^a-z0-9]/gi,'_')}_p${p.pageNum}.png`;
      const cachePath = path.join(CACHE_DIR, safeName);

      if (!fs.existsSync(cachePath)) {
        process.stdout.write(`  Rendering p${p.pageNum} (score=${p.score.toFixed(1)})... `);
        try {
          await renderPage(pdfPath, p.pageNum, cachePath, SLIDE_SCALE);
          process.stdout.write('done\n');
        } catch(e) {
          process.stdout.write(`ERROR: ${e.message}\n`);
          continue;
        }
      } else {
        console.log(`  Using cached p${p.pageNum} (score=${p.score.toFixed(1)})`);
      }

      // Upload to Anki
      await storeMedia(safeName, cachePath);
      imgHtml += `<img src="${safeName}">`;
    }

    // Update the card
    await updateNoteField(note.noteId, 'Back Extra', imgHtml);
    totalAdded++;
    const preview = cardText.replace(/\{\{c\d+::/g,'').replace(/\}\}/g,'').substring(0,60);
    console.log(`  [+] Note ${note.noteId}: "${preview}..."`);
  }
}

await closeRenderer();
console.log(`\nDone! Added slides to ${totalAdded} cards, skipped ${totalSkipped}.`);
