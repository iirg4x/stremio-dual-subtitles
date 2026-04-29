/**
 * Subtitle source registry and adapters.
 *
 * The addon needs every provider to return direct subtitle file URLs plus
 * enough metadata to match release timing across languages. Sources without a
 * safe IMDb/file lookup adapter stay registered but disabled.
 */

const { normalizeLanguageCode } = require('../encoding');
const { browserLanguageMap } = require('../languages');

const DEFAULT_WYZIE_SOURCES = 'podnapisi,yify';
const DEFAULT_WYZIE_BASE_URL = 'https://sub.wyzie.io';

const SUBTITLE_SOURCES = [
  {
    id: 'opensubtitles',
    name: 'OpenSubtitles',
    website: 'https://www.opensubtitles.org/',
    type: 'Free/community subtitle database',
    notes: 'Huge multilingual subtitle database; supports search/upload/API. Not fully open-source.',
    status: 'enabled',
    enabledByDefault: true,
    adapter: 'opensubtitles-v3-stremio',
    capabilities: ['imdb-id', 'movie', 'series', 'file-hash', 'filename', 'video-size']
  },
  {
    id: 'wyzie',
    name: 'Wyzie Subs',
    website: 'https://sub.wyzie.io/',
    type: 'Aggregator API',
    notes: 'Optional bridge for IMDb-based sources such as Podnapisi and YIFY.',
    status: 'optional',
    envKey: 'WYZIE_API_KEY',
    adapter: 'wyzie-search',
    capabilities: ['imdb-id', 'movie', 'series', 'filename', 'multi-source']
  },
  {
    id: 'addic7ed',
    name: 'Addic7ed',
    website: 'https://www.addic7ed.com/',
    type: 'Free subtitle downloads',
    notes: 'Strong for TV shows; multilingual subtitles.',
    status: 'candidate',
    enabledByDefault: false,
    reason: 'Needs a maintained Stremio-safe adapter and show-id mapping before it can be queried from IMDb requests.'
  },
  {
    id: 'tvsubtitles',
    name: 'TVsubtitles.net',
    website: 'https://www.tvsubtitles.net/',
    type: 'Free subtitle downloads',
    notes: 'TV-show-focused, searchable by show/season/episode.',
    status: 'candidate',
    enabledByDefault: false,
    reason: 'Needs a maintained adapter for show/season/episode lookup and direct subtitle URLs.'
  },
  {
    id: 'podnapisi',
    name: 'Podnapisi.net',
    website: 'https://www.podnapisi.net/',
    type: 'Free/community subtitle database',
    notes: 'Long-running subtitle site; also supported by Kodi subtitle add-ons.',
    status: 'optional-via-wyzie',
    enabledByDefault: false,
    reason: 'Available through the optional Wyzie adapter when WYZIE_API_KEY is set.'
  },
  {
    id: 'yify-yts',
    name: 'YIFY/YTS Subtitles clones',
    website: null,
    type: 'Free movie subtitles',
    notes: 'Mostly unofficial sites; use carefully because YIFY has many clones.',
    status: 'optional-via-wyzie',
    enabledByDefault: false,
    reason: 'Available as the Wyzie yify source when WYZIE_API_KEY is set; movie-only.'
  },
  {
    id: 'downsub',
    name: 'DownSub',
    website: 'https://downsub.io/',
    type: 'Free subtitle extractor',
    notes: 'Extracts subtitles/captions from video platforms such as YouTube and Viki.',
    status: 'candidate',
    enabledByDefault: false,
    reason: 'It extracts subtitles from video URLs, not IMDb/Stremio media IDs.'
  },
  {
    id: 'amara',
    name: 'Amara',
    website: 'https://amara.org/',
    type: 'Public subtitling workspace + paid services',
    notes: 'Best for creating/collaborating on captions, not mainly movie subtitle downloads.',
    status: 'candidate',
    enabledByDefault: false,
    reason: 'Needs an Amara video-id mapping before it can answer IMDb/Stremio requests.'
  },
  {
    id: 'subtitlecat',
    name: 'SubtitleCat',
    website: 'https://www.subtitlecat.com/',
    type: 'Free subtitle download/translation',
    notes: 'Offers subtitles in many languages and translation options.',
    status: 'candidate',
    enabledByDefault: false,
    reason: 'Needs a maintained adapter that returns direct subtitle files and release metadata.'
  },
  {
    id: 'subtitlebot',
    name: 'SubtitleBot',
    website: 'https://www.subtitlebot.com/',
    type: 'Search/translation tool',
    notes: 'Searches subtitle databases and offers AI translation features.',
    status: 'candidate',
    enabledByDefault: false,
    reason: 'No direct addon adapter is implemented; it is mainly a search/translation product.'
  }
];

function getSubtitleSourceById(id) {
  return SUBTITLE_SOURCES.find(source => source.id === id) || null;
}

function isSubtitleSourceEnabled(source, env = process.env) {
  if (!source) return false;
  if (source.enabledByDefault) return true;
  if (source.envKey) return Boolean(env[source.envKey]);
  return false;
}

function getEnabledSubtitleSources(env = process.env) {
  return SUBTITLE_SOURCES.filter(source => isSubtitleSourceEnabled(source, env));
}

function getSubtitleSourceSummary(env = process.env) {
  return SUBTITLE_SOURCES.map(source => ({
    id: source.id,
    name: source.name,
    status: source.status,
    enabled: isSubtitleSourceEnabled(source, env),
    adapter: source.adapter || null,
    reason: source.reason || null
  }));
}

function buildOpenSubtitlesStreamUrl({ imdbId, type, season = null, episode = null, videoParams = {} }) {
  let apiUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/tt${normalizeImdbId(imdbId)}`;

  if (type === 'series' && season && episode) {
    apiUrl += `:${season}:${episode}`;
  }

  const queryParams = [];
  if (videoParams.filename) queryParams.push(`filename=${encodeURIComponent(videoParams.filename)}`);
  if (videoParams.videoSize) queryParams.push(`videoSize=${encodeURIComponent(videoParams.videoSize)}`);
  if (videoParams.videoHash) queryParams.push(`videoHash=${encodeURIComponent(videoParams.videoHash)}`);

  if (queryParams.length > 0) {
    apiUrl += `/${queryParams.join('&')}`;
  }

  return `${apiUrl}.json`;
}

async function fetchOpenSubtitles({ fetchWithRetry, imdbId, type, season, episode, videoParams }) {
  const apiUrl = buildOpenSubtitlesStreamUrl({ imdbId, type, season, episode, videoParams });
  const response = await fetchWithRetry(apiUrl, { timeout: 15000 });
  const subtitles = response && response.data && Array.isArray(response.data.subtitles)
    ? response.data.subtitles
    : [];

  return subtitles.map(sub => ({
    ...sub,
    _sourceId: 'opensubtitles',
    _sourceName: 'OpenSubtitles'
  }));
}

function buildWyzieSearchUrl({
  imdbId,
  type,
  season = null,
  episode = null,
  videoParams = {},
  languages = [],
  env = process.env
}) {
  const key = env.WYZIE_API_KEY;
  if (!key) return null;

  const baseUrl = (env.WYZIE_BASE_URL || DEFAULT_WYZIE_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('id', `tt${normalizeImdbId(imdbId)}`);
  params.set('format', 'srt');
  params.set('source', env.WYZIE_SOURCES || DEFAULT_WYZIE_SOURCES);

  if (type === 'series' && season && episode) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }

  const languageList = Array.from(new Set(
    languages.map(normalizeLanguageCode).filter(Boolean)
  ));
  if (languageList.length > 0) params.set('language', languageList.join(','));

  if (videoParams.filename) params.set('file', videoParams.filename);
  params.set('key', key);

  return `${baseUrl}/search?${params.toString()}`;
}

async function fetchWyzieSubtitles(context) {
  const apiUrl = buildWyzieSearchUrl(context);
  if (!apiUrl) return [];

  const response = await context.fetchWithRetry(apiUrl, { timeout: 15000 });
  const data = response ? response.data : null;
  const rows = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.subtitles) ? data.subtitles : []);

  return rows
    .map(normalizeWyzieSubtitle)
    .filter(sub => sub && sub.url && sub.lang);
}

async function fetchSubtitlesFromEnabledSources(context) {
  const env = context.env || process.env;
  const enabledSources = getEnabledSubtitleSources(env);
  const results = await Promise.allSettled(
    enabledSources.map(source => fetchFromSource(source, { ...context, env }))
  );

  const subtitles = [];
  const sourceResults = [];
  const errors = [];

  results.forEach((result, index) => {
    const source = enabledSources[index];
    if (result.status === 'fulfilled') {
      const sourceSubtitles = Array.isArray(result.value) ? result.value : [];
      subtitles.push(...sourceSubtitles);
      sourceResults.push({ source, count: sourceSubtitles.length });
      return;
    }

    errors.push({ source, error: result.reason });
    sourceResults.push({ source, count: 0, error: result.reason });
  });

  return {
    enabledSources,
    sourceResults,
    errors,
    subtitles: dedupeSubtitles(subtitles)
  };
}

function fetchFromSource(source, context) {
  if (source.id === 'opensubtitles') return fetchOpenSubtitles(context);
  if (source.id === 'wyzie') return fetchWyzieSubtitles(context);
  return Promise.resolve([]);
}

function normalizeWyzieSubtitle(row) {
  if (!row || !row.url) return null;

  const providerId = sanitizeId(row.source || 'wyzie');
  const rawId = row.id || row.url;
  const release = row.matchedRelease || row.release || firstArrayValue(row.releases) || row.fileName || '';

  return {
    id: `wyzie-${providerId}-${sanitizeId(rawId)}`,
    url: row.url,
    lang: toOpenSubtitlesLanguageCode(row.language),
    SubEncoding: row.encoding || 'UTF-8',
    m: 'i',
    g: releaseToGroupKey(release),
    downloads: Number(row.downloadCount || 0),
    _sourceId: 'wyzie',
    _sourceName: 'Wyzie Subs',
    _providerId: row.source || null,
    _release: release || null,
    _fileName: row.fileName || null
  };
}

function dedupeSubtitles(subtitles) {
  const seen = new Set();
  const deduped = [];

  for (const sub of subtitles) {
    const key = `${sub._sourceId || ''}:${sub.id || ''}:${sub.url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sub);
  }

  return deduped;
}

function normalizeImdbId(imdbId) {
  return String(imdbId || '').replace(/^tt/i, '');
}

function toOpenSubtitlesLanguageCode(language) {
  if (!language) return null;

  const lower = String(language).trim().toLowerCase();
  if (lower.length === 3) return lower;
  if (browserLanguageMap[lower]) return browserLanguageMap[lower];

  const base = lower.split('-')[0];
  return browserLanguageMap[base] || lower;
}

function releaseToGroupKey(release) {
  const normalized = String(release || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');

  return normalized || null;
}

function sanitizeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

module.exports = {
  SUBTITLE_SOURCES,
  DEFAULT_WYZIE_SOURCES,
  getSubtitleSourceById,
  getEnabledSubtitleSources,
  getSubtitleSourceSummary,
  isSubtitleSourceEnabled,
  buildOpenSubtitlesStreamUrl,
  buildWyzieSearchUrl,
  fetchSubtitlesFromEnabledSources,
  _internal: {
    normalizeWyzieSubtitle,
    toOpenSubtitlesLanguageCode,
    releaseToGroupKey,
    dedupeSubtitles
  }
};
