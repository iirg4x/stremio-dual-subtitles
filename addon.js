/**
 * Stremio Dual Subtitles Addon
 * Fetches subtitles from configured subtitle sources and merges two languages into one file.
 * Perfect for language learners who want to see both original and translation.
 */

const path = require('path');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const pako = require('pako');
const sanitize = require('sanitize-html');
const { debugServer, sanitizeForLogging } = require('./lib/debug');
const pkg = require('./package.json');
/**
 * Simple SRT parser (more reliable than external libraries)
 */
function parseSrtSimple(srtText) {
  const lines = srtText.trim().split('\n');
  const subtitles = [];
  let current = null;
  let pendingId = null;

  function pushCurrent() {
    if (current && current.startTime && current.endTime && current.text.trim()) {
      subtitles.push(current);
    }
    current = null;
  }
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const timing = parseTimestampLine(line);
    
    // Skip empty lines
    if (!line) {
      pushCurrent();
      pendingId = null;
      continue;
    }

    if (timing) {
      pushCurrent();
      current = {
        id: pendingId || String(subtitles.length + 1),
        startTime: timing.startTime,
        endTime: timing.endTime,
        text: ''
      };
      pendingId = null;
      continue;
    }
    
    // Cue IDs are optional in the wild. Treat a line right before a timestamp
    // as an ID, even if it is not numeric (VTT commonly uses named IDs).
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (parseTimestampLine(nextLine)) {
      if (current) pushCurrent();
      pendingId = line;
      continue;
    }

    // Before the first timing line, any other preamble/garbage is ignored.
    if (!current) {
      continue;
    }
    
    // Otherwise it's text
    if (current.text) current.text += '\n';
    current.text += line;
  }
  
  // Add last subtitle if exists
  pushCurrent();
  
  return subtitles;
}

/**
 * Simple SRT formatter
 */
function formatSrtSimple(subtitles) {
  const lines = [];
  
  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i];
    lines.push(String(i + 1));
    lines.push(`${sub.startTime} --> ${sub.endTime}`);
    lines.push(sub.text);
    lines.push('');
  }
  
  return lines.join('\n');
}

const { decodeSubtitleBuffer, isCjkLanguage } = require('./encoding');
const { parseKitsuId } = require('./lib/animeSource');
const { translateSubtitles, isAvailable: isTranslatorAvailable } = require('./lib/localTranslator');
const {
  getLanguageOptions,
  parseLangCode,
  getLanguageName
} = require('./languages');
const { alignAndMatch } = require('./lib/syncEngine');
const { generateCandidatePairs, rankCandidatesForLanguage } = require('./lib/sourceSelection');
const {
  fetchSubtitlesFromEnabledSources,
  getEnabledSubtitleSources,
  getSubtitleSourceSummary
} = require('./lib/subtitleSources');

// Match rate at or above this is considered "good enough" — we stop
// trying further candidate pairs. Empirically high-quality matches land
// 90-99%, decent ones 80-90%, mismatched ones 45-70%. We pick 0.85 so
// the gate trusts a clearly-high pair (1 attempt) but still spends a
// second fetch to triangulate when the first is only "okay".
const QUALITY_GATE_THRESHOLD = 0.85;
// Hard cap on how many pairs we'll fetch+merge before giving up. Three
// is enough to cover (best same-group, zipped-popularity, runner-up)
// while keeping the serverless cold path bounded.
const MAX_PAIR_ATTEMPTS = 3;
const VIDEO_PARAM_KEYS = ['filename', 'videoSize', 'videoHash'];
const TIMING_SOURCES = new Set(['primary', 'secondary']);
const SUBTITLE_MODES = new Set(['dual']);

// Configuration
const ADDON_NAME = process.env.ADDON_NAME || 'Dual Subtitles';
const ADDON_VERSION = pkg.version;



// Create addon manifest
const manifest = {
  id: 'community.dualsubtitles',
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: 'Watch movies and series with dual subtitles - see two languages simultaneously for better language learning!',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: [],
  logo: '/logo.png',
  behaviorHints: {
    configurable: true,
    configurationRequired: true
  },
  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..0dhMmLAGB8GgrgR0k_QVag.QvSVlwg-SctRXOgQgdIhydZx55LSndygGe4uCb2VrwGzHfQm5hyH0j3BxQOMrMZWuBxFkMkVYt9QF4jNx6yyffbx1ub8KJCjnKl9SfBCkI9aFk9RrD7T0FbuPurxIbrd.OH-8gvJWWzw6O7QtreVs_w'
  },
  config: [
    {
      key: 'mainLang',
      type: 'select',
      title: 'Primary Language (Audio/Learning Language)',
      options: getLanguageOptions(),
      required: true,
      default: 'English [eng]'
    },
    {
      key: 'transLang',
      type: 'select',
      title: 'Secondary Language (Your Native Language)',
      options: getLanguageOptions(),
      required: true,
      default: 'Turkish [tur]'
    }
  ]
};

const builder = new addonBuilder(manifest);

async function fetchWithRetry(url, options = {}, retries = 2, backoffMs = 500) {
  try {
    return await axios.get(url, options);
  } catch (error) {
    const status = error && error.response ? error.response.status : null;
    if (retries > 0 && (status === 429 || status === 469 || status === 503 || status === 504)) {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return fetchWithRetry(url, options, retries - 1, backoffMs * 2);
    }
    throw error;
  }
}

/**
 * Fetch all subtitles from enabled source adapters.
 */
async function fetchAllSubtitles(imdbId, type, season = null, episode = null, videoParams = {}, options = {}) {
  const normalizedVideoParams = normalizeVideoParams(videoParams);

  try {
    const result = await fetchSubtitlesFromEnabledSources({
      fetchWithRetry,
      imdbId,
      type,
      season,
      episode,
      videoParams: normalizedVideoParams,
      languages: options.languages || [],
      kitsuId: options.kitsuId || null,
      env: options.env || process.env
    });

    const enabledNames = result.enabledSources.map(source => source.name).join(', ') || 'none';
    debugServer.log(`Enabled subtitle sources: ${enabledNames}`);

    for (const sourceResult of result.sourceResults) {
      if (sourceResult.error) {
        debugServer.warn(
          `Subtitle source failed: ${sourceResult.source.name} - ` +
          sanitizeForLogging(sourceResult.error.message || String(sourceResult.error))
        );
        continue;
      }
      debugServer.log(`Subtitle source ${sourceResult.source.name}: ${sourceResult.count} result(s)`);
    }

    if (!result.subtitles || result.subtitles.length === 0) {
      return null;
    }

    return result.subtitles;
  } catch (error) {
    debugServer.error('Error fetching subtitles:', sanitizeForLogging(error.message));
    return null;
  }
}

/**
 * Fetch and decode subtitle content from URL.
 */
// Post-decompress size cap. The 5MB axios cap only bounds the wire payload;
// a small .gz can balloon to hundreds of MB and OOM the function.
const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;

// Minimum usable cue count for a parsed subtitle. Movies and TV episodes
// always have dozens of cues; below this it's almost certainly a "forced"
// track (signs/songs only) or a broken/partial file. Setting it low keeps
// niche short-form content working.
const MIN_USABLE_CUES = 10;

// Matches subtitles flagged as forced via path/filename. Most providers don't
// set Content-Disposition with this hint, but the URL almost always carries
// it (e.g. ".../Movie.2020.eng.forced.srt", ".../forced/eng.srt.gz").
const FORCED_URL_RE = /(?:^|[._\-/])forced(?:[._\-/]|\.[a-z]+(?:\.gz)?$)/i;

function isLikelyForcedUrl(url) {
  return Boolean(url) && FORCED_URL_RE.test(String(url));
}

async function fetchSubtitleContent(url, languageCode = null) {
  if (isLikelyForcedUrl(url)) {
    debugServer.log(`Skipping forced subtitle by URL pattern: ${sanitizeForLogging(url)}`);
    return null;
  }

  try {
    const response = await fetchWithRetry(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024 // 5MB limit
    });

    // Skip forced subtitles — they only contain signs/songs, not full dialogue
    const disposition = response.headers && response.headers['content-disposition'];
    if (disposition && disposition.toLowerCase().includes('forced')) {
      return null;
    }

    let buffer = Buffer.from(response.data);

    // Handle gzip compressed files
    if (url.endsWith('.gz') || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
      try {
        buffer = Buffer.from(pako.ungzip(buffer));
      } catch (e) {
        debugServer.error('Error decompressing gzip:', sanitizeForLogging(e.message));
        return null;
      }
    }

    if (buffer.length > MAX_DECOMPRESSED_BYTES) {
      debugServer.warn(
        `Subtitle exceeds decompressed cap (${buffer.length} > ${MAX_DECOMPRESSED_BYTES}); rejecting`
      );
      return null;
    }

    const text = decodeSubtitleBuffer(buffer, languageCode);
    return text;
  } catch (error) {
    debugServer.error('Error fetching subtitle:', sanitizeForLogging(error.message));
    return null;
  }
}

/**
 * Parse SRT/VTT time format to milliseconds.
 * Accepts both comma (SRT: 00:01:23,456) and period (VTT: 00:01:23.456) separators.
 */
function parseTimeToMs(timeString) {
  if (!timeString) return 0;

  const match = timeString.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const ms = match[4].padEnd(3, '0');
  const milliseconds = parseInt(ms, 10);
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
}

function normalizeVideoParams(params = {}) {
  const normalized = {};
  for (const key of VIDEO_PARAM_KEYS) {
    const value = params && params[key];
    if (Array.isArray(value)) {
      if (value.length > 0 && value[0] != null && String(value[0]).trim() !== '') {
        normalized[key] = String(value[0]).trim();
      }
    } else if (value != null && String(value).trim() !== '') {
      normalized[key] = String(value).trim();
    }
  }
  return normalized;
}

function serializeVideoParams(params = {}) {
  const normalized = normalizeVideoParams(params);
  const search = new URLSearchParams();
  for (const key of VIDEO_PARAM_KEYS) {
    if (normalized[key]) search.set(key, normalized[key]);
  }
  return search.toString();
}

function normalizeTimingSource(timingSource) {
  return TIMING_SOURCES.has(timingSource) ? timingSource : 'primary';
}

function normalizeSubtitleMode(mode) {
  return SUBTITLE_MODES.has(mode) ? mode : 'dual';
}

function videoParamsCacheFragment(params = {}) {
  const serialized = serializeVideoParams(params);
  return serialized ? `_${serialized}` : '';
}

function buildDynamicSubtitleUrl(type, imdbId, season, episode, mainLang, transLang, mainSubId, transSubId, videoParams = {}, options = {}) {
  const dynamicParams = [
    type,
    imdbId,
    season || '0',
    episode || '0',
    mainLang,
    transLang,
    mainSubId,
    transSubId
  ].join('/');

  const search = new URLSearchParams(serializeVideoParams(videoParams));
  const timingSource = normalizeTimingSource(options.timingSource);
  const subtitleMode = normalizeSubtitleMode(options.mode || options.subtitleMode);
  if (timingSource !== 'primary') search.set('timingSource', timingSource);
  if (subtitleMode !== 'dual') search.set('mode', subtitleMode);
  const query = search.toString();
  return `{{ADDON_URL}}/subs/${dynamicParams}.srt${query ? `?${query}` : ''}`;
}

/**
 * Extract and normalize an SRT/VTT timestamp line.
 * Drops cue-position metadata so generated SRT timestamps stay valid.
 */
function parseTimestampLine(line) {
  if (!line || !line.includes('-->')) return null;

  const timePattern = '(\\d{1,2}:\\d{2}:\\d{2}[,.]\\d{1,3})';
  const match = line.match(new RegExp(`^\\s*${timePattern}\\s*-->\\s*${timePattern}`));
  if (!match) return null;

  return {
    startTime: msToSrtTime(parseTimeToMs(match[1])),
    endTime: msToSrtTime(parseTimeToMs(match[2]))
  };
}

/**
 * Normalize VTT content to SRT-compatible format.
 * Strips WEBVTT header, style blocks, and adds numeric cue IDs if missing.
 */
function normalizeVttToSrt(text) {
  const lines = text.split('\n');
  const output = [];
  let cueIndex = 0;
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (inBlock) {
      if (line === '') inBlock = false;
      continue;
    }

    if (line === '' || line.startsWith('WEBVTT') ||
        /^Kind:/i.test(line) || /^Language:/i.test(line) ||
        /^X-TIMESTAMP-MAP:/i.test(line)) {
      continue;
    }

    if (/^(STYLE|REGION|NOTE)(\s|$)/i.test(line) || /^::cue/i.test(line)) {
      inBlock = true;
      continue;
    }

    const timing = parseTimestampLine(line);
    if (timing) {
      cueIndex++;
      output.push('');
      output.push(String(cueIndex));
      output.push(`${timing.startTime} --> ${timing.endTime}`);
      continue;
    }

    // Skip VTT cue identifiers (numeric or named) right before a timestamp.
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (parseTimestampLine(nextLine)) {
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

/**
 * Convert ASS/SSA subtitle format to SRT-compatible text.
 *
 * ASS timing: H:MM:SS.cc (centiseconds, NOT milliseconds).
 * The Text column is field 9 (0-indexed) in the Dialogue line.
 * Override tags like {\an8}, {\pos(...)}, {\c&H...&} are stripped.
 */
function normalizeAssToSrt(text) {
  const lines = text.split('\n');
  const output = [];
  let inEvents = false;
  let formatFields = null;
  let cueIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '[Events]') {
      inEvents = true;
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      inEvents = false;
      formatFields = null;
      continue;
    }

    if (!inEvents) continue;

    if (line.startsWith('Format:')) {
      formatFields = line.slice('Format:'.length).split(',').map(f => f.trim().toLowerCase());
      continue;
    }

    if (!line.startsWith('Dialogue:')) continue;

    // Split: "Dialogue: " + 9 comma-separated fields, last = Text (may contain commas)
    const rest = line.slice('Dialogue:'.length).trimStart();
    const parts = rest.split(',');
    if (parts.length < 10) continue;

    const startRaw = parts[1].trim();
    const endRaw = parts[2].trim();
    const textRaw = parts.slice(9).join(',');

    // Convert H:MM:SS.cc → H:MM:SS,mmm (centiseconds → milliseconds)
    function assTimeToSrt(t) {
      const m = t.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
      if (!m) return null;
      const ms = parseInt(m[4], 10) * 10;
      return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]},${String(ms).padStart(3, '0')}`;
    }

    const startSrt = assTimeToSrt(startRaw);
    const endSrt = assTimeToSrt(endRaw);
    if (!startSrt || !endSrt) continue;

    // Strip ASS override blocks, drawing commands, and hard line-break tags
    const cleanText = textRaw
      .replace(/\{[^}]*\}/g, '')    // {\an8}, {\pos(...)}, {\1c&H...&}, etc.
      .replace(/\\N/g, '\n')        // soft line breaks
      .replace(/\\n/g, '\n')
      .replace(/\\h/g, ' ')         // non-breaking space
      .trim();

    if (!cleanText) continue;

    cueIndex++;
    output.push(String(cueIndex));
    output.push(`${startSrt} --> ${endSrt}`);
    output.push(cleanText);
    output.push('');
  }

  return output.join('\n');
}

function isAssFormat(text) {
  const first = text.trimStart().slice(0, 200);
  return /^\[Script Info\]/i.test(first) || /^\[V4/i.test(first);
}

/**
 * Parse SRT text into subtitle objects. Also handles VTT and ASS/SSA input.
 */
function parseSrt(srtText) {
  if (!srtText || typeof srtText !== 'string') return null;

  try {
    // Normalize line endings
    srtText = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Remove BOM if present
    if (srtText.charCodeAt(0) === 0xFEFF) {
      srtText = srtText.substring(1);
    }

    // Detect and convert VTT or ASS/SSA format
    const trimmed = srtText.trimStart();
    if (trimmed.startsWith('WEBVTT')) {
      srtText = normalizeVttToSrt(srtText);
    } else if (isAssFormat(srtText)) {
      srtText = normalizeAssToSrt(srtText);
    }
    
    // Normalize period-separated timestamps to comma-separated for the parser
    srtText = srtText.replace(
      /(\d{1,2}:\d{2}:\d{2})\.(\d{1,3})/g,
      '$1,$2'
    );
    
    // Use simple parser
    const parsed = parseSrtSimple(srtText);
    
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    // Filter out subtitle-pack ad lines so they don't appear in the dual track.
    const adKeywords = [
      'opensubtitles.org',
      'opensubtitles.com',
      'osdb.link',
      'advertise your',
      'subscene.com',
      'subscene.net',
      'yifysubtitles',
      'addic7ed.com',
      'support us and become vip',
      'please rate this subtitle',
      'api.opensubtitles'
    ];
    const filtered = parsed.filter(sub => {
      const text = (sub.text || '').toLowerCase();
      if (adKeywords.some(keyword => text.includes(keyword))) return false;
      // Pure-SDH cues only confuse cross-language alignment; the secondary
      // language almost never has a peer for "[door slams]".
      if (isPureSdhCueText(sub.text)) return false;
      return true;
    });

    return filtered;
  } catch (error) {
    debugServer.error('Error parsing SRT:', sanitizeForLogging(error.message));
    return null;
  }
}

/**
 * Convert milliseconds to SRT time format.
 */
function msToSrtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

/**
 * Join multi-line subtitle text into a single line.
 * For CJK languages, joins without spaces to avoid breaking character flow.
 */
function joinSubtitleLines(text, langCode) {
  if (!text) return '';
  const cjk = isCjkLanguage(langCode);
  return text.replace(/\r?\n|\r/g, cjk ? '' : ' ').trim();
}

// Inline ASS/SSA override blocks (e.g. {\an8}, {\pos(100,200)}, {\fad(0,200)})
// occasionally leak into .srt files and render as visible junk. They are not
// HTML so sanitize-html doesn't touch them.
function stripAssOverrideTags(text) {
  if (!text) return '';
  return String(text).replace(/\{\\[^}]*\}/g, '');
}

// Strip music notation glyphs but keep the lyrics — the secondary language
// usually has the same lyrics, so we still want them paired.
function stripMusicMarkers(text) {
  if (!text) return '';
  return String(text).replace(/[♪♫]/g, '');
}

// A cue is "pure SDH" when every non-empty line is just a square-bracketed
// sound description like "[door slams]" or "[ENGINE REVVING]". These have no
// peer in the other language and only add noise to the alignment.
//
// Parenthetical content stays — it is sometimes used for whispered/quoted
// dialogue and is too ambiguous to drop reliably.
const PURE_SDH_LINE_RE = /^\s*\[[^\]]*\]\s*$/;

function isPureSdhCueText(text) {
  if (!text) return false;
  const lines = String(text).split(/\r?\n/);
  let hasAny = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    hasAny = true;
    if (!PURE_SDH_LINE_RE.test(trimmed)) return false;
  }
  return hasAny;
}

function decodeSubtitleEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&#60;/g, '<')
    .replace(/&#x3c;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#62;/g, '>')
    .replace(/&#x3e;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanSubtitleText(text, langCode) {
  const withoutAss = stripAssOverrideTags(text || '');
  const sanitized = sanitize(withoutAss, { allowedTags: [], allowedAttributes: {} });
  const decoded = decodeSubtitleEntities(sanitized);
  const withoutMusic = stripMusicMarkers(decoded);
  return joinSubtitleLines(withoutMusic, langCode);
}

// Multi-sentence cue splitter ------------------------------------------------
//
// Some subtitle releases pack multiple sentences into one long cue while the
// peer-language release uses one cue per sentence. The bipartite matcher
// then assigns the long packed cue to exactly one main cue, producing the
// "two Arabic sentences glued under one English line" failure mode visible
// in the rendered SRT.
//
// We pre-split cues whose timing spans multiple full sentences before
// alignment runs, so the matcher sees comparable cue boundaries on both
// sides. The split is conservative: only long cues with clean sentence
// boundaries and substantial resulting segments are split. "Rapid-fire
// dialogue" cues (short duration with multiple sentences) are left alone.

const SENTENCE_END_RE = /[.!?؟。]/;
// Characters that plausibly start a new sentence. Cased scripts (Latin,
// Cyrillic, Greek) require uppercase; non-cased scripts accept any letter
// in their block.
const SENTENCE_START_RE = new RegExp(
  '[A-ZÀ-ÞĀ-ſ'   // Latin uppercase + extended
  + 'А-Я'                  // Cyrillic uppercase
  + 'Α-Ω'                  // Greek uppercase
  + '؀-ۿ'                  // Arabic
  + '֐-׿'                  // Hebrew
  + 'ऀ-ॿ'                  // Devanagari
  + '฀-๿'                  // Thai
  + '一-鿿'                  // CJK Unified Ideographs
  + '぀-ゟ゠-ヿ'     // Hiragana + Katakana
  + '가-힯'                  // Hangul
  + ']'
);

const SPLIT_MIN_DURATION_MS = 2500;
// 15 is empirically the sweet spot: rejects abbreviation splits ("Mr.",
// "Dr." → 2-3 char "segments") while accepting genuinely short sentences
// like "I was eating." or the trailing half of an Arabic cue.
const SPLIT_MIN_SEGMENT_CHARS = 15;

/**
 * Split a cue's text at sentence boundaries. A "boundary" is a
 * sentence-terminator (`.`, `?`, `!`, `؟`, `。`) followed by whitespace
 * and a sentence-start character.
 *
 * Returns the original text as a single-element array if no boundary
 * passes the strict lookahead — this is the common case.
 */
function splitIntoSentences(text) {
  if (!text) return [];
  const segments = [];
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    if (!SENTENCE_END_RE.test(text[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (j >= text.length) break;
    if (!SENTENCE_START_RE.test(text[j])) {
      i++;
      continue;
    }
    const segment = text.slice(cursor, i + 1).trim();
    if (segment) segments.push(segment);
    cursor = j;
    i = j;
  }
  const tail = text.slice(cursor).trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * Split each multi-sentence cue into one cue per sentence, distributing
 * the original timing proportionally to character count. Cues that don't
 * meet all guards are passed through unchanged so this transform never
 * regresses well-formed releases.
 *
 * Guards (all required, tunable via options):
 *   • cue duration ≥ minDurationMs (rapid-fire dialogue stays whole)
 *   • text length ≥ 2 × minSegmentChars (skip trivially short cues)
 *   • every resulting segment ≥ minSegmentChars (rejects abbreviation
 *     splits like "Mr. Smith")
 */
function splitMultiSentenceCues(subs, options = {}) {
  const minDurationMs = options.minDurationMs != null
    ? options.minDurationMs : SPLIT_MIN_DURATION_MS;
  const minSegmentChars = options.minSegmentChars != null
    ? options.minSegmentChars : SPLIT_MIN_SEGMENT_CHARS;

  const out = [];
  if (!Array.isArray(subs)) return out;

  for (const sub of subs) {
    if (!sub) continue;
    const dur = (sub.endMs || 0) - (sub.startMs || 0);
    const text = sub.text || '';
    if (dur < minDurationMs || text.length < 2 * minSegmentChars) {
      out.push(sub);
      continue;
    }
    const segments = splitIntoSentences(text);
    if (segments.length < 2 || segments.some(s => s.length < minSegmentChars)) {
      out.push(sub);
      continue;
    }
    const totalChars = segments.reduce((sum, s) => sum + s.length, 0);
    let cursor = sub.startMs;
    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;
      const portion = segments[i].length / totalChars;
      const endMs = isLast
        ? sub.endMs
        : Math.min(cursor + Math.max(1, Math.round(dur * portion)), sub.endMs - 1);
      out.push({
        ...sub,
        startMs: cursor,
        endMs,
        text: segments[i]
      });
      cursor = endMs;
    }
  }
  return out;
}

/** Escape text embedded in SRT HTML tags (avoid breaking markup / injection). */
function htmlEncodeSrt(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Muted color for secondary line; players that ignore <font> still show both lines. */
const DUAL_SUB_TRANS_COLOR = '#94a3b8';

/**
 * Merge two subtitle arrays into one, aligning the secondary track to the
 * primary track's timebase before matching.
 *
 * The actual alignment work (global offset detection via cross-correlation,
 * affine drift correction, and overlap-based bipartite assignment) is in
 * lib/syncEngine.js. This function is a thin wrapper that converts SRT
 * timestamp strings to milliseconds, runs the engine, and renders the
 * dual-line SRT text.
 *
 * @param {Array} mainSubs - Primary language subtitles (SRT-time strings)
 * @param {Array} transSubs - Translation language subtitles (SRT-time strings)
 * @param {Object|number} options - Merge options (number = legacy threshold)
 * @param {string|null} [options.mainLang]  - For CJK-aware line joining
 * @param {string|null} [options.transLang] - For CJK-aware line joining
 * @param {number}      [options.matchThresholdMs=1500]
 * @param {boolean}     [options.allowMultiTrans=true]
 *        If true, several short trans cues may be concatenated into one
 *        primary cue (handles cue-boundary mismatches).
 * @param {boolean}     [options.enableOffset=true]
 * @param {boolean}     [options.enableDrift=true]
 * @param {'primary'|'secondary'} [options.timingSource='primary']
 *        Which track's original timestamps to use for the generated cue.
 */
function mergeSubtitles(mainSubs, transSubs, options = {}) {
  const opts = typeof options === 'number'
    ? { matchThresholdMs: Math.max(options, 1500) }
    : options;

  const {
    mainLang = null,
    transLang = null,
    matchThresholdMs = 1500,
    allowMultiTrans = true,
    enableOffset = true,
    enableDrift = true,
    timingSource = 'primary'
  } = opts;
  const renderTimingSource = normalizeTimingSource(timingSource);

  const mainTimed = [];
  for (const s of mainSubs || []) {
    if (!s || !s.startTime || !s.endTime) continue;
    const startMs = parseTimeToMs(s.startTime);
    const endMs = parseTimeToMs(s.endTime);
    if (endMs <= startMs) continue;
    mainTimed.push({ ...s, startMs, endMs });
  }

  const transTimed = [];
  for (const s of transSubs || []) {
    if (!s || !s.startTime || !s.endTime) continue;
    const startMs = parseTimeToMs(s.startTime);
    const endMs = parseTimeToMs(s.endTime);
    if (endMs <= startMs) continue;
    transTimed.push({ ...s, startMs, endMs });
  }

  // Pre-alignment cue splitting: when one side packs multiple sentences
  // into a long cue while the peer side uses one cue per sentence, the
  // bipartite matcher binds the long packed cue to a single main and
  // renders both peer-language sentences under it. Splitting both sides
  // at sentence boundaries (with guards so it only fires on long, clearly
  // multi-sentence cues) lets the matcher pair them one-to-one.
  const mainTimedSplit = splitMultiSentenceCues(mainTimed);
  const transTimedSplit = splitMultiSentenceCues(transTimed);

  const alignment = alignAndMatch(mainTimedSplit, transTimedSplit, {
    enableOffset,
    enableDrift,
    matchThreshold: matchThresholdMs,
    allowMultiTrans,
    log: msg => debugServer.log(sanitizeForLogging(msg))
  });
  const { matches } = alignment;

  const transJoiner = isCjkLanguage(transLang) ? '' : ' ';
  const mergedSubs = [];

  for (let mi = 0; mi < mainTimedSplit.length; mi++) {
    const mainSub = mainTimedSplit[mi];

    const cleanMainText = cleanSubtitleText(mainSub.text, mainLang);
    if (!cleanMainText) continue;

    const transIdxs = matches.get(mi);
    let mergedText;
    if (transIdxs && transIdxs.length > 0) {
      const transParts = [];
      for (const ti of transIdxs) {
        const t = transTimedSplit[ti];
        if (!t) continue;
        const piece = cleanSubtitleText(t.text, transLang);
        if (piece) transParts.push(piece);
      }
      if (transParts.length > 0) {
        const cleanTransText = transParts.join(transJoiner);
        const encMain = htmlEncodeSrt(cleanMainText);
        const encTrans = htmlEncodeSrt(cleanTransText);
        mergedText =
          `<b>${encMain}</b>\n<i><font color="${DUAL_SUB_TRANS_COLOR}">${encTrans}</font></i>`;
      }
    }

    if (mergedText === undefined) {
      mergedText = `<b>${htmlEncodeSrt(cleanMainText)}</b>`;
    }

    if (!mergedText) continue;

    // Output timing always follows the primary (main) cue. Split-derived
    // cues carry the proportionally-divided startMs/endMs from
    // splitMultiSentenceCues; original cues carry their parsed timings.
    // We re-derive the SRT strings from the ms values so split cues get
    // their new boundaries instead of inheriting the parent cue's strings.
    let outputStartTime = mainSub.startTime;
    let outputEndTime = mainSub.endTime;
    if (Number.isFinite(mainSub.startMs) && Number.isFinite(mainSub.endMs)) {
      outputStartTime = msToSrtTime(mainSub.startMs);
      outputEndTime = msToSrtTime(mainSub.endMs);
    }
    if (renderTimingSource === 'secondary' && transIdxs && transIdxs.length > 0) {
      const timingSubs = transIdxs
        .map(ti => transTimedSplit[ti])
        .filter(Boolean);
      if (timingSubs.length > 0) {
        const startMs = Math.min(...timingSubs.map(t => t.startMs));
        const endMs = Math.max(...timingSubs.map(t => t.endMs));
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
          outputStartTime = msToSrtTime(startMs);
          outputEndTime = msToSrtTime(endMs);
        }
      }
    }

    mergedSubs.push({
      id: mainSub.id,
      startTime: outputStartTime,
      endTime: outputEndTime,
      text: mergedText
    });
  }

  // Backwards compatible: callers that used `mergeSubtitles` as a plain
  // array still iterate / .length / spread it as before. Quality-gate
  // callers can read alignment metrics from non-enumerable properties.
  Object.defineProperty(mergedSubs, 'matchRate', {
    value: alignment.matchRate || 0,
    enumerable: false
  });
  Object.defineProperty(mergedSubs, 'alignment', {
    value: {
      offsetMs: alignment.offsetMs,
      drift: alignment.drift,
      localAnchors: alignment.localAnchors,
      matchedCount: matches.size,
      mainCount: mainTimedSplit.length,
      timingSource: renderTimingSource
    },
    enumerable: false
  });
  return mergedSubs;
}

/**
 * Format subtitle array back to SRT string.
 */
function formatSrt(subtitleArray) {
  if (!Array.isArray(subtitleArray)) return null;

  try {
    return formatSrtSimple(subtitleArray);
  } catch (error) {
    debugServer.error('Error formatting SRT:', sanitizeForLogging(error.message));
    return null;
  }
}

// In-memory cache for merged subtitles
const subtitleCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // sweep at most every 15 min
let lastCacheSweep = 0;

function sweepSubtitleCache(now) {
  for (const [k, v] of subtitleCache) {
    if (now - v.timestamp > CACHE_TTL) subtitleCache.delete(k);
  }
  lastCacheSweep = now;
}

function maybeSweepSubtitleCache(now) {
  if (now - lastCacheSweep > CACHE_SWEEP_INTERVAL_MS) sweepSubtitleCache(now);
}

/**
 * Store subtitle in cache and return data URL.
 */
function storeSubtitle(key, srtContent) {
  const now = Date.now();
  sweepSubtitleCache(now);
  subtitleCache.set(key, {
    content: srtContent,
    timestamp: now
  });
  return key;
}

/**
 * Get subtitle from cache.
 */
function getSubtitle(key) {
  const now = Date.now();
  maybeSweepSubtitleCache(now);

  const entry = subtitleCache.get(key);
  if (!entry) return null;

  if (now - entry.timestamp > CACHE_TTL) {
    subtitleCache.delete(key);
    return null;
  }

  return entry.content;
}

/**
 * Try candidate (main, trans) pairs in order. For each pair, fetch both
 * subtitle files, parse them, and run mergeSubtitles. The first pair whose
 * match rate clears QUALITY_GATE_THRESHOLD wins; otherwise we return the
 * best pair we saw, capped at MAX_PAIR_ATTEMPTS.
 *
 * Each fetched subtitle is cached in `parsedCache` so retrying with the
 * same main against a different trans (or vice versa) doesn't re-download.
 *
 * @param {Array} candidatePairs    output of generateCandidatePairs
 * @param {string} mainLang
 * @param {string} transLang
 * @returns {Promise<{
 *   merged: Array, mergedSrt: string, matchRate: number,
 *   mainSub: object, transSub: object, attempts: number,
 *   passedGate: boolean
 * } | null>}
 */
async function selectAndMergeBestPair(candidatePairs, mainLang, transLang, options = {}) {
  if (!Array.isArray(candidatePairs) || candidatePairs.length === 0) {
    // If no pairs exist, try translating-only path below
    return tryTranslatorFallback(null, null, mainLang, transLang, options);
  }
  const timingSource = normalizeTimingSource(options.timingSource);

  const parsedCache = new Map();
  async function getParsed(sub, lang) {
    if (parsedCache.has(sub.id)) return parsedCache.get(sub.id);
    const content = await fetchSubtitleContent(sub.url, lang);
    const parsed = content ? parseSrt(content) : null;
    parsedCache.set(sub.id, parsed);
    return parsed;
  }

  let best = null;
  const attempts = Math.min(candidatePairs.length, MAX_PAIR_ATTEMPTS);

  for (let i = 0; i < attempts; i++) {
    const pair = candidatePairs[i];
    debugServer.log(
      `Pair attempt ${i + 1}/${attempts}: main=${pair.main.id} trans=${pair.trans.id} ` +
      `source=${pair.source} sameGroup=${pair.sameGroup} g=${pair.group}`
    );

    const [mainParsed, transParsed] = await Promise.all([
      getParsed(pair.main, mainLang),
      getParsed(pair.trans, transLang)
    ]);
    if (!mainParsed || mainParsed.length < MIN_USABLE_CUES) {
      debugServer.warn(
        `  main subtitle ${pair.main.id} unusable ` +
        `(${mainParsed ? mainParsed.length : 0} cues), skipping`
      );
      continue;
    }
    if (!transParsed || transParsed.length < MIN_USABLE_CUES) {
      debugServer.warn(
        `  trans subtitle ${pair.trans.id} unusable ` +
        `(${transParsed ? transParsed.length : 0} cues), skipping`
      );
      continue;
    }

    const merged = mergeSubtitles(mainParsed, transParsed, { mainLang, transLang, timingSource });
    const matchRate = merged && merged.matchRate != null ? merged.matchRate : 0;
    debugServer.log(`  match rate: ${(matchRate * 100).toFixed(1)}%`);

    if (!best || matchRate > best.matchRate) {
      best = {
        merged,
        mergedSrt: merged && merged.length > 0 ? formatSrt(merged) : null,
        matchRate,
        mainSub: pair.main,
        transSub: pair.trans,
        attempts: i + 1,
        passedGate: matchRate >= QUALITY_GATE_THRESHOLD
      };
    }
    if (matchRate >= QUALITY_GATE_THRESHOLD) {
      debugServer.log(`  passed quality gate, stopping`);
      break;
    }
  }

  if (best) {
    debugServer.log(
      `Selected pair: main=${best.mainSub.id} trans=${best.transSub.id} ` +
      `matchRate=${(best.matchRate * 100).toFixed(1)}% attempts=${best.attempts} ` +
      `passedGate=${best.passedGate}`
    );
    return best;
  }

  // No usable pair found — try translating the best available main subtitle
  const bestMainSub = candidatePairs.length > 0 ? candidatePairs[0].main : null;
  return tryTranslatorFallback(bestMainSub, parsedCache, mainLang, transLang, options);
}

/**
 * When no secondary subtitle is available, translate the primary track using
 * LibreTranslate. Returns the same shape as selectAndMergeBestPair results.
 */
async function tryTranslatorFallback(mainSub, parsedCache, mainLang, transLang, options = {}) {
  const env = options.env || process.env;
  if (!isTranslatorAvailable(env)) return null;

  debugServer.log(`No trans subtitle found; attempting local translation (${mainLang}→${transLang})`);

  let mainParsed = null;
  if (mainSub) {
    const cached = parsedCache && parsedCache.get(mainSub.id);
    if (cached && cached.length >= MIN_USABLE_CUES) {
      mainParsed = cached;
    } else {
      const content = await fetchSubtitleContent(mainSub.url, mainLang);
      mainParsed = content ? parseSrt(content) : null;
    }
  }

  if (!mainParsed || mainParsed.length < MIN_USABLE_CUES) {
    debugServer.warn('No usable main subtitle for translation fallback');
    return null;
  }

  const timingSource = normalizeTimingSource(options.timingSource);
  const translated = await translateSubtitles(mainParsed, mainLang, transLang, fetchWithRetry, env);
  if (!translated) {
    debugServer.warn('Local translation returned no output');
    return null;
  }

  debugServer.log(`Translated ${translated.length} cues (${mainLang}→${transLang}) via LibreTranslate`);

  // The translated cues share exact timing with main — merge is trivially 100%
  const merged = mergeSubtitles(mainParsed, translated, { mainLang, transLang, timingSource });
  return {
    merged,
    mergedSrt: merged && merged.length > 0 ? formatSrt(merged) : null,
    matchRate: 1.0,
    mainSub: mainSub || { id: 'translated' },
    transSub: { id: `translated-${mainLang}-${transLang}` },
    attempts: 1,
    passedGate: true,
    translatedLocally: true
  };
}

// Subtitle handler function
async function subtitlesHandler({ type, id, extra, config }) {
  debugServer.log('Subtitle request:', sanitizeForLogging({ type, id }));

  // Get configured languages and any per-request API key overrides
  const mainLangRaw = config?.mainLang || 'English [eng]';
  const transLangRaw = config?.transLang || 'Turkish [tur]';
  const envOverrides = (config?.envOverrides && typeof config.envOverrides === 'object')
    ? config.envOverrides : {};
  const requestEnv = Object.keys(envOverrides).length > 0
    ? { ...process.env, ...envOverrides }
    : process.env;

  const mainLang = parseLangCode(mainLangRaw);
  const transLang = parseLangCode(transLangRaw);

  debugServer.log(`Languages: Primary=${mainLang}, Secondary=${transLang}`);

  // Prevent same language selection
  if (mainLang === transLang) {
    debugServer.warn('Error: Same language selected for both');
    return { subtitles: [] };
  }

  // Parse ID — may be IMDb ("tt1234567", "tt1234567:1:5") or Kitsu ("kitsu:12345", "kitsu:12345:1:5")
  const rawId = extra?.imdbId || id;
  let imdbId = null;
  let kitsuId = null;
  let season = extra?.season || null;
  let episode = extra?.episode || null;

  const kitsuParsed = parseKitsuId(rawId);
  if (kitsuParsed) {
    kitsuId = kitsuParsed.kitsuId;
    season = season || kitsuParsed.season;
    episode = episode || kitsuParsed.episode;
  } else {
    // IMDb path (possibly colon-separated series ID)
    let parsed = rawId;
    if (parsed.includes(':')) {
      const parts = parsed.split(':');
      parsed = parts[0];
      if (parts.length >= 3) {
        season = season || parts[1];
        episode = episode || parts[2];
      }
    }
    imdbId = parsed.replace(/^tt/i, '') || null;
  }

  if (!imdbId && !kitsuId) {
    debugServer.warn('No valid IMDb or Kitsu ID');
    return { subtitles: [] };
  }

  try {
    // Video params for better matching
    const videoParams = normalizeVideoParams(extra || {});

    // Fetch all subtitles
    debugServer.log('Fetching subtitles from enabled sources...');
    const allSubtitles = await fetchAllSubtitles(
      imdbId,
      type,
      season,
      episode,
      videoParams,
      { languages: [mainLang, transLang], kitsuId, env: requestEnv }
    );

    if (!allSubtitles) {
      debugServer.warn('No subtitles found');
      return { subtitles: [] };
    }

    debugServer.log(`Found ${allSubtitles.length} total subtitles`);

    const mainCandidates = rankCandidatesForLanguage(allSubtitles, mainLang, { videoParams });
    if (mainCandidates.length === 0) {
      debugServer.warn(`No ${mainLang} subtitle candidates available`);
      return { subtitles: [] };
    }

    // Build the ordered list of (main, trans) candidates. Same-`g`
    // (same release) pairs come first; this is our biggest single
    // accuracy win on titles like Sopranos S01E03. Passing videoParams
    // also lets the ranker prefer hash-matched and filename-matching subs.
    const candidatePairs = generateCandidatePairs(
      allSubtitles, mainLang, transLang, { videoParams }
    );

    debugServer.log(
      `Built ${candidatePairs.length} candidate pair(s); ` +
      `same-group: ${candidatePairs.filter(p => p.sameGroup).length}`
    );

    // CPU-cheap path: do NOT fetch / parse / merge here. Just publish
    // the URL of the best-ranked pair. The actual download + alignment
    // happens once, on demand, when Stremio fetches the .srt URL.
    const subtitleTitle =
      `Dual (${mainLang.toUpperCase()}+${transLang.toUpperCase()}) - ` +
      `${getLanguageName(mainLang)} + ${getLanguageName(transLang)}`;

    const finalSubtitles = [];
    const best = candidatePairs[0];

    // For Kitsu anime, encode the Kitsu ID as "kitsu-{id}" in the URL's
    // imdbId segment so generateDynamicSubtitle can resolve it back.
    const urlImdbId = imdbId || (kitsuId ? `kitsu-${kitsuId}` : null);

    if (best && urlImdbId) {
      // Only the primary-timing variant is published. mergeSubtitles still
      // accepts `timingSource: 'secondary'` for legacy URLs, but exposing
      // both variants confused users — secondary timing makes the merged
      // cue follow the trans cue, which combines with packed cues to
      // produce the "two sentences glued under one line" failure mode.
      finalSubtitles.push({
        id: `dual-${best.main.id}-${best.trans.id}`,
        url: buildDynamicSubtitleUrl(
          type,
          urlImdbId,
          season,
          episode,
          mainLang,
          transLang,
          best.main.id,
          best.trans.id,
          videoParams,
          { timingSource: 'primary' }
        ),
        lang: mainLang,
        SubtitlesName: subtitleTitle
      });

      debugServer.log(
        `Selected pair (no merge): main=${best.main.id} trans=${best.trans.id} ` +
        `source=${best.source} sameGroup=${best.sameGroup}`
      );
    } else {
      debugServer.warn(`No ${mainLang}/${transLang} candidate pairs available`);
    }

    if (finalSubtitles.length === 0) return { subtitles: [] };

    return {
      subtitles: finalSubtitles,
      cacheMaxAge: 0
    };

  } catch (error) {
    debugServer.error('Error in subtitle handler:', sanitizeForLogging(error.message));
    return { subtitles: [] };
  }
}

// Register the handler with the builder
builder.defineSubtitlesHandler(subtitlesHandler);

/**
 * Generate merged subtitle dynamically (for serverless environments)
 * Called directly by URL. Results are cached in `subtitleCache` so any
 * repeat hit on the same Vercel instance skips fetch + parse + merge
 * entirely — even ahead of Vercel's edge cache (which ALSO caches via
 * Cache-Control headers in server.js routes).
 */
async function generateDynamicSubtitle(type, imdbId, season, episode, mainLang, transLang, mainSubId, transSubId, videoParams = {}, options = {}) {
  debugServer.log('Dynamic subtitle generation:', { type, imdbId, mainLang, transLang });

  const normalizedVideoParams = normalizeVideoParams(videoParams);
  const timingSource = normalizeTimingSource(options.timingSource);
  const subtitleMode = normalizeSubtitleMode(options.mode || options.subtitleMode);
  const cacheKey =
    `${imdbId}_${season || ''}_${episode || ''}_${mainLang}_${transLang}_${mainSubId}_${transSubId}` +
    videoParamsCacheFragment(normalizedVideoParams) +
    `_mode_${subtitleMode}_timing_${timingSource}`;
  const cached = getSubtitle(cacheKey);
  if (cached) {
    debugServer.log(`Cache hit (in-instance): ${cacheKey}`);
    return cached;
  }

  // Decode Kitsu ID encoded in imdbId segment ("kitsu-12345" → kitsuId="12345")
  const kitsuMatch = imdbId && imdbId.startsWith('kitsu-') ? imdbId.slice('kitsu-'.length) : null;
  const resolvedImdbId = kitsuMatch ? null : imdbId;
  const resolvedKitsuId = kitsuMatch || null;

  try {
    // Fetch all subtitles
    const allSubtitles = await fetchAllSubtitles(
      resolvedImdbId,
      type,
      season !== '0' ? season : null,
      episode !== '0' ? episode : null,
      normalizedVideoParams,
      { languages: [mainLang, transLang], kitsuId: resolvedKitsuId }
    );

    if (!allSubtitles) {
      debugServer.warn('No subtitles found');
      return null;
    }

    // Build candidate pairs for this title; we'll start by trying the
    // exact pair encoded in the URL (the one subtitlesHandler picked),
    // then fall back to other candidates if the match rate is too low.
    const candidatePairs = generateCandidatePairs(
      allSubtitles, mainLang, transLang,
      { videoParams: normalizedVideoParams }
    );

    const requestedMain = allSubtitles.find(s => String(s.id) === String(mainSubId));
    const requestedTrans = allSubtitles.find(s => String(s.id) === String(transSubId));

    let orderedPairs = candidatePairs;
    if (requestedMain && requestedTrans) {
      // Move the URL-requested pair to the front (or insert it if it
      // wasn't in the candidate list, e.g. addon was upgraded mid-cache).
      const isSameGroup =
        requestedMain.g === requestedTrans.g && requestedMain.g != null;
      const head = {
        main: requestedMain,
        trans: requestedTrans,
        sameGroup: isSameGroup,
        group: isSameGroup ? requestedMain.g : null,
        source: 'requested'
      };
      orderedPairs = [
        head,
        ...candidatePairs.filter(
          p => !(String(p.main.id) === String(mainSubId) &&
                 String(p.trans.id) === String(transSubId))
        )
      ];
    } else {
      debugServer.warn(
        'Requested specific pair not present in fresh subtitle list; ' +
        'falling back to ranked candidates'
      );
    }

    if (orderedPairs.length === 0) return null;

    const best = await selectAndMergeBestPair(orderedPairs, mainLang, transLang, { timingSource });
    if (!best || !best.merged || best.merged.length === 0) {
      debugServer.warn('No usable merged subtitle from any pair');
      return null;
    }

    const srtContent = best.mergedSrt;
    debugServer.log(
      `Generated ${best.merged.length} merged subtitle entries ` +
      `(matchRate=${(best.matchRate * 100).toFixed(1)}%, attempts=${best.attempts})`
    );

    if (srtContent) storeSubtitle(cacheKey, srtContent);
    return srtContent;
  } catch (error) {
    debugServer.error('Error generating dynamic subtitle:', sanitizeForLogging(error.message));
    return null;
  }
}

module.exports = {
  builder,
  manifest,
  getSubtitle,
  subtitleCache,
  subtitlesHandler,
  generateDynamicSubtitle,
  // Exported for testing
  _test: {
    parseTimeToMs,
    parseSrt,
    parseSrtSimple,
    normalizeVttToSrt,
    normalizeAssToSrt,
    isAssFormat,
    mergeSubtitles,
    joinSubtitleLines,
    formatSrt,
    formatSrtSimple,
    msToSrtTime,
    parseTimestampLine,
    normalizeVideoParams,
    serializeVideoParams,
    buildDynamicSubtitleUrl,
    normalizeTimingSource,
    normalizeSubtitleMode,
    fetchAllSubtitles,
    getEnabledSubtitleSources,
    getSubtitleSourceSummary,
    decodeSubtitleEntities,
    cleanSubtitleText,
    isLikelyForcedUrl,
    isPureSdhCueText,
    stripAssOverrideTags,
    stripMusicMarkers,
    splitIntoSentences,
    splitMultiSentenceCues,
    MIN_USABLE_CUES
  }
};
