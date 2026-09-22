// In-browser receipt reading: image clarity measurement and OCR (Tesseract.js from CDN).
import { parseReceipt } from '/shared/receipt-parser.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tesseractPromise = null;
let workerPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.async = true;
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR library failed to load')));
      s.onerror = () => { tesseractPromise = null; reject(new Error('OCR library could not be downloaded')); };
      document.head.append(s);
    });
  }
  return tesseractPromise;
}

let progressCb = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = loadTesseract().then((T) => T.createWorker('eng', 1, {
      logger: (m) => { if (m.status === 'recognizing text' && progressCb) progressCb(m.progress); },
    }));
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a readable image. Upload a JPG or PNG screenshot/photo.')); };
    img.src = url;
  });
}

/**
 * Sharpness score = variance of the Laplacian on a grayscale copy scaled to 1000px wide.
 * Crisp screenshots score in the hundreds; out-of-focus photos score low.
 */
export function measureSharpness(img) {
  const w = Math.min(1000, img.naturalWidth);
  const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.round(sumSq / n - mean * mean);
}

/** Upscale small images and convert to grayscale to improve OCR accuracy. */
function prepareForOcr(img) {
  const scale = img.naturalWidth < 1000 ? 2 : img.naturalWidth > 2400 ? 2400 / img.naturalWidth : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/**
 * Read a receipt image. Returns
 * { width, height, sharpness, ocrText, confidence, parsed, ocrError }.
 */
export async function scanReceipt(file, { onProgress } = {}) {
  const { img, url } = await loadImage(file);
  try {
    const result = { width: img.naturalWidth, height: img.naturalHeight, sharpness: measureSharpness(img), ocrText: '', confidence: null, parsed: null, ocrError: null };
    try {
      onProgress?.('Loading receipt reader…', 0);
      progressCb = (p) => onProgress?.('Reading receipt text…', p);
      const worker = await getWorker();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Receipt reading timed out')), 90000));
      const { data } = await Promise.race([worker.recognize(prepareForOcr(img)), timeout]);
      result.ocrText = data.text || '';
      result.confidence = Math.round(data.confidence ?? 0);
    } catch (e) {
      result.ocrError = e.message || 'Receipt reading failed';
    } finally {
      progressCb = null;
    }
    result.parsed = parseReceipt(result.ocrText);
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
