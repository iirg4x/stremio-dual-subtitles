/**
 * Anime-specific subtitle sources.
 *
 * Handles two problems the generic adapters can't solve:
 *   1. Kitsu-prefixed IDs ("kitsu:12345") don't map to an IMDb ID, so
 *      OpenSubtitles returns nothing. We resolve Kitsu→AniList ID via the
 *      Kitsu REST API and then query Jimaku (jimaku.cc) which indexes
 *      high-quality anime fansub tracks keyed by AniList ID.
 *
 *   2. Even for IMDb-catalogued anime, Jimaku often has Japanese-specific
 *      subtitle releases that OpenSubtitles doesn't carry.
 *
 * Environment variables:
 *   JIMAKU_API_KEY   - optional; required by some Jimaku endpoints
 */

const KITSU_API = 'https://kitsu.app/api/edge';
const JIMAKU_API = 'https://jimaku.cc/api';

// In-process cache: kitsu numeric ID → AniList numeric ID
const kitsuToAnilistCache = new Map();

/**
 * Resolve a Kitsu anime ID to an AniList ID via Kitsu's mappings endpoint.
 * Returns null when the mapping is unavailable or the fetch fails.
 */
async function resolveKitsuToAnilist(fetchWithRetry, kitsuId) {
  const key = String(kitsuId);
  if (kitsuToAnilistCache.has(key)) return kitsuToAnilistCache.get(key);

  try {
    const res = await fetchWithRetry(
      `${KITSU_API}/anime/${key}?include=mappings`,
      { timeout: 8000 }
    );
    const included = res && res.data && Array.isArray(res.data.included)
      ? res.data.included
      : [];

    for (const item of included) {
      if (
        item.type === 'mappings' &&
        item.attributes &&
        item.attributes.externalSite === 'anilist' &&
        item.attributes.externalId
      ) {
        const anilistId = parseInt(item.attributes.externalId, 10);
        if (anilistId > 0) {
          kitsuToAnilistCache.set(key, anilistId);
          return anilistId;
        }
      }
    }
  } catch (_) {}

  // Fallback: try the /mappings sub-resource directly
  try {
    const res = await fetchWithRetry(
      `${KITSU_API}/anime/${key}/mappings`,
      { timeout: 8000 }
    );
    const rows = res && res.data && Array.isArray(res.data.data) ? res.data.data : [];
    for (const row of rows) {
      if (
        row.attributes &&
        row.attributes.externalSite === 'anilist' &&
        row.attributes.externalId
      ) {
        const anilistId = parseInt(row.attributes.externalId, 10);
        if (anilistId > 0) {
          kitsuToAnilistCache.set(key, anilistId);
          return anilistId;
        }
      }
    }
  } catch (_) {}

  kitsuToAnilistCache.set(key, null);
  return null;
}

/**
 * Search Jimaku for entries matching an AniList ID.
 * Optionally filter by episode.
 */
async function searchJimakuEntries(fetchWithRetry, { anilistId, episode, apiKey }) {
  const params = new URLSearchParams({ anilist_id: String(anilistId) });
  if (episode != null) params.set('episode', String(episode));

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const res = await fetchWithRetry(
      `${JIMAKU_API}/entries/search?${params}`,
      { timeout: 10000, headers }
    );
    return Array.isArray(res && res.data) ? res.data : [];
  } catch (_) {
    return [];
  }
}

/**
 * Fetch the subtitle file list for a Jimaku entry.
 */
async function fetchJimakuFiles(fetchWithRetry, entryId, { episode, apiKey } = {}) {
  const params = new URLSearchParams();
  if (episode != null) params.set('episode', String(episode));

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const qs = params.toString();
  try {
    const res = await fetchWithRetry(
      `${JIMAKU_API}/entries/${entryId}/files${qs ? `?${qs}` : ''}`,
      { timeout: 10000, headers }
    );
    return Array.isArray(res && res.data) ? res.data : [];
  } catch (_) {
    return [];
  }
}

const SUPPORTED_EXT_RE = /\.(srt|vtt|ass|ssa)(?:\.gz)?$/i;

function inferLangFromFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (/[\b._-](jpn?|japanese|jp)[\b._-]|[\b._](ja)[\b._]/.test(lower)) return 'jpn';
  if (/[\b._-](eng?|english|en)[\b._-]/.test(lower)) return 'eng';
  if (/[\b._-](chi|chinese|zho?|chs|cht|zh)[\b._-]/.test(lower)) return 'chi';
  if (/[\b._-](kor?|korean|ko)[\b._-]/.test(lower)) return 'kor';
  return 'jpn'; // Jimaku is primarily Japanese
}

function sanitizeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function normalizeJimakuFile(file, entryId) {
  if (!file || !file.url) return null;
  const name = file.name || '';
  if (!SUPPORTED_EXT_RE.test(name)) return null;

  return {
    id: `jimaku-${entryId}-${sanitizeId(name)}`,
    url: file.url,
    lang: inferLangFromFilename(name),
    SubEncoding: 'UTF-8',
    m: 'i',
    g: `jimaku-${entryId}`,
    downloads: 0,
    _sourceId: 'jimaku',
    _sourceName: 'Jimaku',
    _fileName: name,
    _release: name
  };
}

/**
 * Main entry point called by subtitleSources.js.
 *
 * @param {object} context
 * @param {Function} context.fetchWithRetry
 * @param {string|null} context.kitsuId     - numeric Kitsu ID (no prefix)
 * @param {string|null} context.anilistId   - AniList ID if already resolved
 * @param {string|number|null} context.episode
 * @param {string} context.env              - process.env
 * @returns {Promise<object[]>}             - normalized subtitle objects
 */
async function fetchJimakuSubtitles({ fetchWithRetry, kitsuId, anilistId, episode, env }) {
  const apiKey = (env || process.env).JIMAKU_API_KEY || null;

  let resolvedAnilistId = anilistId ? parseInt(anilistId, 10) : null;
  if (!resolvedAnilistId && kitsuId) {
    resolvedAnilistId = await resolveKitsuToAnilist(fetchWithRetry, kitsuId);
  }

  if (!resolvedAnilistId) return [];

  const entries = await searchJimakuEntries(fetchWithRetry, {
    anilistId: resolvedAnilistId,
    episode,
    apiKey
  });

  if (entries.length === 0) return [];

  const subtitles = [];
  for (const entry of entries.slice(0, 4)) {
    if (!entry.id) continue;
    const files = await fetchJimakuFiles(fetchWithRetry, entry.id, { episode, apiKey });
    for (const file of files) {
      const sub = normalizeJimakuFile(file, entry.id);
      if (sub) subtitles.push(sub);
    }
  }

  return subtitles;
}

/**
 * Parse a `kitsu:ID` or `kitsu:ID:season:episode` string from Stremio.
 * Returns { kitsuId, season, episode } or null.
 */
function parseKitsuId(idString) {
  if (!idString || !idString.startsWith('kitsu:')) return null;
  const parts = idString.slice('kitsu:'.length).split(':');
  const kitsuId = parts[0];
  if (!kitsuId) return null;
  return {
    kitsuId,
    season: parts[1] || null,
    episode: parts[2] || null
  };
}

module.exports = {
  fetchJimakuSubtitles,
  resolveKitsuToAnilist,
  parseKitsuId
};
