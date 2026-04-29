/**
 * Machine-translation helpers for generated subtitle tracks.
 *
 * Uses MyMemory's public API, which is free and does not require a key for
 * public translation lookup.
 */

const axios = require('axios');
const { normalizeLanguageCode } = require('../encoding');

const DEFAULT_MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const MAX_MYMEMORY_BYTES = 480;

function isTranslationConfigured() {
  return true;
}

function buildMyMemoryUrl(env = process.env) {
  return String(env.MYMEMORY_URL || DEFAULT_MYMEMORY_URL).replace(/\/+$/, '');
}

function toTranslationLanguageCode(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) return null;
  if (normalized === 'zh-tw') return 'zh-TW';
  return normalized;
}

function chunkMyMemoryText(text, options = {}) {
  const maxBytes = options.maxBytes || MAX_MYMEMORY_BYTES;
  const words = String(text || '').split(/(\s+)/);
  const chunks = [];
  let current = '';

  function pushCurrent() {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  }

  for (const word of words) {
    if (!word) continue;
    const candidate = current + word;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (Buffer.byteLength(word, 'utf8') <= maxBytes) {
      current = word;
      continue;
    }

    let fragment = '';
    for (const char of Array.from(word)) {
      const next = fragment + char;
      if (Buffer.byteLength(next, 'utf8') > maxBytes) {
        if (fragment) chunks.push(fragment);
        fragment = char;
      } else {
        fragment = next;
      }
    }
    current = fragment;
  }

  pushCurrent();
  return chunks.length > 0 ? chunks : [''];
}

function normalizeMyMemoryResponse(data) {
  const status = Number(data && data.responseStatus);
  if (status >= 400) {
    throw new Error(data.responseDetails || `MyMemory translation failed with status ${status}`);
  }

  const translatedText = data && data.responseData && data.responseData.translatedText;
  if (translatedText == null) {
    throw new Error('MyMemory response did not include responseData.translatedText');
  }

  return String(translatedText || '');
}

function buildMyMemoryRequestUrl({ text, source, target, env = process.env }) {
  const params = new URLSearchParams();
  params.set('q', String(text || ''));
  params.set('langpair', `${source}|${target}`);
  params.set('mt', '1');

  if (env.MYMEMORY_EMAIL) params.set('de', env.MYMEMORY_EMAIL);
  if (env.MYMEMORY_KEY) params.set('key', env.MYMEMORY_KEY);

  return `${buildMyMemoryUrl(env)}?${params.toString()}`;
}

async function getJsonWithRetry(url, options = {}, retries = 2, backoffMs = 500) {
  try {
    return await axios.get(url, options);
  } catch (error) {
    const status = error && error.response ? error.response.status : null;
    if (retries > 0 && (status === 429 || status === 503 || status === 504)) {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return getJsonWithRetry(url, options, retries - 1, backoffMs * 2);
    }
    throw error;
  }
}

async function translateTexts(texts, options = {}) {
  const env = options.env || process.env;
  const source = toTranslationLanguageCode(options.sourceLang);
  const target = toTranslationLanguageCode(options.targetLang);
  if (!source || !target) {
    throw new Error(`Unsupported translation language pair: ${options.sourceLang} -> ${options.targetLang}`);
  }

  const normalizedTexts = (texts || []).map(text => String(text || ''));
  if (source === target || normalizedTexts.length === 0) return normalizedTexts;

  const request = options.getRequest || options.request || getJsonWithRetry;
  const translated = [];

  for (const text of normalizedTexts) {
    const chunks = chunkMyMemoryText(text, options);
    const translatedChunks = [];

    for (const chunk of chunks) {
      const url = buildMyMemoryRequestUrl({ text: chunk, source, target, env });
      const response = await request(url, { timeout: options.timeout || 15000 });
      translatedChunks.push(normalizeMyMemoryResponse(response.data));
    }

    translated.push(translatedChunks.join(' '));
  }

  return translated;
}

module.exports = {
  DEFAULT_MYMEMORY_URL,
  MAX_MYMEMORY_BYTES,
  isTranslationConfigured,
  buildMyMemoryUrl,
  buildMyMemoryRequestUrl,
  toTranslationLanguageCode,
  chunkMyMemoryText,
  normalizeMyMemoryResponse,
  translateTexts
};
