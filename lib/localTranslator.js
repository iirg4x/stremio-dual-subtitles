/**
 * Local subtitle translation via LibreTranslate (self-hosted or public instance).
 *
 * Set LIBRETRANSLATE_URL to enable. Example:
 *   LIBRETRANSLATE_URL=http://localhost:5000
 *   LIBRETRANSLATE_API_KEY=your-key   (only needed on protected instances)
 *
 * When available, this module translates the primary-language subtitles into
 * the secondary language. The translated cues are synthesized as if they were
 * a second subtitle track fetched from a source, and handed to the merge
 * pipeline which pairs them 1:1 by timing (they share the exact same timing).
 *
 * This is the fallback path: it only runs when no real secondary-language
 * subtitle was found from any configured source.
 */

const ISO3_TO_2 = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  spa: 'es', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja',
  chi: 'zh', zho: 'zh', kor: 'ko', ara: 'ar', tur: 'tr',
  dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', nor: 'no',
  fin: 'fi', dan: 'da', heb: 'he', hin: 'hi', hun: 'hu',
  cze: 'cs', ces: 'cs', rum: 'ro', ron: 'ro', bul: 'bg',
  hrv: 'hr', srp: 'sr', scc: 'sr', ukr: 'uk', vie: 'vi',
  tha: 'th', ind: 'id', may: 'ms', msa: 'ms', per: 'fa',
  fas: 'fa', cat: 'ca', lat: 'la', glg: 'gl', ell: 'el',
  gre: 'el', alb: 'sq', sqi: 'sq', arm: 'hy', hye: 'hy',
  geo: 'ka', kat: 'ka', aze: 'az', bel: 'be', bos: 'bs',
  est: 'et', lav: 'lv', lit: 'lt', mkd: 'mk', mac: 'mk',
  slk: 'sk', slo: 'sk', slv: 'sl', ice: 'is', isl: 'is',
  wel: 'cy', cym: 'cy', hat: 'ht', ben: 'bn', tgl: 'tl',
  afr: 'af', epo: 'eo', gle: 'ga', ltz: 'lb', mal: 'ml',
  mar: 'mr', mon: 'mn', nep: 'ne', sin: 'si', som: 'so',
  swa: 'sw', tam: 'ta', tel: 'te', urd: 'ur', uzb: 'uz',
  zht: 'zh',
};

function toLang2(code3) {
  if (!code3) return null;
  const lower = code3.toLowerCase();
  if (lower.length === 2) return lower;
  return ISO3_TO_2[lower] || null;
}

function isAvailable(env) {
  return Boolean((env || process.env).LIBRETRANSLATE_URL);
}

/**
 * Translate a batch of texts via LibreTranslate.
 * Sends texts one-by-one to avoid request-size limits on public instances.
 * Falls back to the original text on per-text errors so one bad cue doesn't
 * abort the whole translation.
 *
 * @param {string[]} texts
 * @param {string} sourceLang - 2-letter language code
 * @param {string} targetLang - 2-letter language code
 * @param {Function} fetchWithRetry
 * @param {object} env
 * @returns {Promise<string[]>}
 */
async function translateBatch(texts, sourceLang, targetLang, fetchWithRetry, env) {
  const baseUrl = (env.LIBRETRANSLATE_URL || '').replace(/\/+$/, '');
  const apiKey = env.LIBRETRANSLATE_API_KEY || null;
  const endpoint = `${baseUrl}/translate`;

  // Batch multiple texts into one request using the array form if available,
  // otherwise fall back to sequential single-text requests.
  // LibreTranslate supports batching via `q` as an array.
  const BATCH_SIZE = 20;
  const results = new Array(texts.length).fill('');

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const body = {
      q: slice,
      source: sourceLang,
      target: targetLang,
      format: 'text'
    };
    if (apiKey) body.api_key = apiKey;

    try {
      const res = await fetchWithRetry(endpoint, {
        method: 'POST',
        data: body,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      });
      const data = res && res.data;
      // LibreTranslate returns { translatedText: string | string[] }
      const translated = data && data.translatedText;
      if (Array.isArray(translated)) {
        for (let k = 0; k < slice.length; k++) {
          results[i + k] = translated[k] || slice[k];
        }
      } else if (typeof translated === 'string' && slice.length === 1) {
        results[i] = translated || slice[0];
      } else {
        // Fallback: try individually
        for (let k = 0; k < slice.length; k++) {
          results[i + k] = await translateSingle(
            slice[k], sourceLang, targetLang, endpoint, apiKey, fetchWithRetry
          );
        }
      }
    } catch (_) {
      // On batch failure, copy originals so output is still complete
      for (let k = 0; k < slice.length; k++) results[i + k] = slice[k];
    }
  }

  return results;
}

async function translateSingle(text, sourceLang, targetLang, endpoint, apiKey, fetchWithRetry) {
  const body = { q: text, source: sourceLang, target: targetLang, format: 'text' };
  if (apiKey) body.api_key = apiKey;
  try {
    const res = await fetchWithRetry(endpoint, {
      method: 'POST',
      data: body,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return (res && res.data && res.data.translatedText) || text;
  } catch (_) {
    return text;
  }
}

/**
 * Translate an array of parsed subtitle cues into a different language.
 * Returns a new array of cues with the same timing but translated text.
 * Returns null if translation is not configured or fails.
 *
 * @param {Array<{startTime, endTime, text, ...}>} cues - parsed SRT cues
 * @param {string} sourceLang3 - 3-letter ISO code of source language
 * @param {string} targetLang3 - 3-letter ISO code of target language
 * @param {Function} fetchWithRetry
 * @param {object} [env]
 * @returns {Promise<Array|null>}
 */
async function translateSubtitles(cues, sourceLang3, targetLang3, fetchWithRetry, env = process.env) {
  if (!isAvailable(env)) return null;

  const sourceLang = toLang2(sourceLang3);
  const targetLang = toLang2(targetLang3);
  if (!sourceLang || !targetLang || sourceLang === targetLang) return null;
  if (!Array.isArray(cues) || cues.length === 0) return null;

  const texts = cues.map(c => c.text || '');

  let translated;
  try {
    translated = await translateBatch(texts, sourceLang, targetLang, fetchWithRetry, env);
  } catch (_) {
    return null;
  }

  return cues.map((cue, i) => ({
    ...cue,
    text: translated[i] || cue.text
  }));
}

module.exports = { translateSubtitles, isAvailable, toLang2 };
