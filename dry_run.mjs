/**
 * Dry run — shows which slides would be matched to which cards, without modifying Anki.
 */
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import path from 'path';

const SLIDES_DIR = 'C:\\Users\\noahm\\downloads\\Pathology Slides';

const PDF_TO_DECK = {
  '2026 CCLN 1 Disease Mechanisms.pdf':              'Pathology::Disease Mechanisms',
  '2026 CCLN 2 Neoplasia.pdf':                       'Pathology::Neoplastic',
  '2026 CCLN 3 Cardiovascular.pdf':                  'Pathology::Cardiovascular Pathology',
  '2026 CCLN 4 Respiratory 1 - Non Neoplastic.pdf':  'Pathology::Respiratory Pathology',
  '2026 CCLN 5 Respiratory 2 - Neoplastic.pdf':      'Pathology::Respiratory Pathology',
};

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
  const clean = text.replace(/\{\{c\d+::(.*?)\}\}/g, '$1').toLowerCase();
  const words = clean.match(/\b[a-z]{3,}\b/g) || [];
  return words.filter(w => !STOP_WORDS.has(w));
}

function scoreMatch(cardKeywords, pageText) {
  const pageWords = new Set(pageText.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
  let score = 0;
  for (const kw of cardKeywords) {
    if (pageWords.has(kw)) score++;
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
    const opList = await page.getOperatorList();
    const imgCount = opList.fnArray.filter(f =>
      f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject
    ).length;
    pages.push({ pageNum: i, text, imgCount });
  }
  return pages;
}

async function ankiRequest(action, params = {}) {
  const body = JSON.stringify({ action, version: 6, params });
  const resp = await fetch('http://127.0.0.1:8765', { method: 'POST', body });
  const json = await resp.json();
  if (json.error) throw new Error(`AnkiConnect: ${json.error}`);
  return json.result;
}

const MIN_SCORE = 2;
const MAX_SLIDES = 2;

// Just check one deck: Cardiovascular
const pdfFile = '2026 CCLN 3 Cardiovascular.pdf';
const deckName = 'Pathology::Cardiovascular Pathology';

console.log(`Checking: ${pdfFile} → ${deckName}\n`);
const pages = await getPdfPageData(path.join(SLIDES_DIR, pdfFile));
const contentPages = pages.filter(p => p.imgCount > 1 && p.pageNum > 2); // >1 = has content beyond background

const noteIds = await ankiRequest('findNotes', { query: `deck:"${deckName}"` });
const notes = await ankiRequest('notesInfo', { notes: noteIds });

let matched = 0;
for (const note of notes) {
  const text = note.fields['Text']?.value || '';
  const keywords = extractKeywords(text);
  if (keywords.length < 2) continue;

  const scored = contentPages
    .map(p => ({ ...p, score: scoreMatch(keywords, p.text) }))
    .filter(p => p.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SLIDES);

  const preview = text.replace(/\{\{c\d+::/g,'').replace(/\}\}/g,'').substring(0, 70);
  if (scored.length > 0) {
    matched++;
    const slideInfo = scored.map(p => `p${p.pageNum}(score=${p.score})`).join(', ');
    console.log(`✓ "${preview}..."`);
    console.log(`  → slides: ${slideInfo}`);
    console.log(`  → page text preview: "${scored[0].text.substring(0,80)}..."\n`);
  } else {
    console.log(`✗ "${preview}..." — no match\n`);
  }
}

console.log(`\nMatched ${matched}/${notes.length} cards.`);
