/**
 * Simple in-memory analytics for tracking addon usage.
 * Note: Data resets on server restart. For persistent analytics,
 * consider using a database or external service.
 *
 * All time bucketing uses UTC so a long-running server doesn't get confusing
 * hour-rollovers from local-TZ math, and so multi-instance deployments agree.
 */

// Caps prevent unbounded growth from many unique IPs / IMDB ids / language
// strings. When a cap is hit, the oldest entry is evicted (LRU-ish for stats
// keyed by lastSeen; FIFO for the visitor set).
const MAX_UNIQUE_VISITORS = 50_000;
const MAX_CONTENT_STATS = 2_000;
const MAX_LANGUAGE_STATS = 500;
const MAX_RECENT_ACTIVITY = 100;

const analytics = {
  // General stats
  totalPageViews: 0,
  totalInstalls: 0,
  totalSubtitleRequests: 0,
  totalSubtitlesServed: 0,

  // Time-based stats (last 24 hours, hourly buckets)
  hourlyStats: new Array(24).fill(null).map(() => ({
    pageViews: 0,
    installs: 0,
    subtitleRequests: 0,
    timestamp: null
  })),

  // Language popularity
  languageStats: {},

  // Daily stats (last 7 days)
  dailyStats: new Array(7).fill(null).map(() => ({
    pageViews: 0,
    installs: 0,
    subtitleRequests: 0,
    date: null
  })),

  // Recent activity log (last MAX_RECENT_ACTIVITY events)
  recentActivity: [],

  // Server start time
  serverStartTime: Date.now(),

  // Unique visitors (approximate, based on IP hash; FIFO-capped)
  uniqueVisitors: new Set(),

  // Popular content (IMDB IDs only, anonymous)
  contentStats: {}
};

// Simple hash function for IP anonymization
function hashIP(ip) {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

function getCurrentHourIndex() {
  return new Date().getUTCHours();
}

function getCurrentDayIndex() {
  return new Date().getUTCDay();
}

function getCurrentDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentHourTimestamp() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

function updateHourlyStats(field) {
  const hourIndex = getCurrentHourIndex();
  const currentHour = getCurrentHourTimestamp();

  if (analytics.hourlyStats[hourIndex].timestamp !== currentHour) {
    analytics.hourlyStats[hourIndex] = {
      pageViews: 0,
      installs: 0,
      subtitleRequests: 0,
      timestamp: currentHour
    };
  }

  analytics.hourlyStats[hourIndex][field]++;
}

function updateDailyStats(field) {
  const dayIndex = getCurrentDayIndex();
  const today = getCurrentDayKey();

  if (analytics.dailyStats[dayIndex].date !== today) {
    analytics.dailyStats[dayIndex] = {
      pageViews: 0,
      installs: 0,
      subtitleRequests: 0,
      date: today
    };
  }

  analytics.dailyStats[dayIndex][field]++;
}

function addActivity(type, details) {
  analytics.recentActivity.unshift({
    type,
    details,
    timestamp: Date.now()
  });

  if (analytics.recentActivity.length > MAX_RECENT_ACTIVITY) {
    analytics.recentActivity.pop();
  }
}

function addUniqueVisitor(hashedIP) {
  if (analytics.uniqueVisitors.has(hashedIP)) return;
  if (analytics.uniqueVisitors.size >= MAX_UNIQUE_VISITORS) {
    // Sets iterate in insertion order; drop oldest.
    const oldest = analytics.uniqueVisitors.values().next().value;
    analytics.uniqueVisitors.delete(oldest);
  }
  analytics.uniqueVisitors.add(hashedIP);
}

function bumpLanguageStat(key) {
  if (!key) return;
  if (analytics.languageStats[key] != null) {
    analytics.languageStats[key]++;
    return;
  }
  if (Object.keys(analytics.languageStats).length >= MAX_LANGUAGE_STATS) {
    // Evict the least-used key — keeps the popular long tail in place.
    let evictKey = null;
    let evictCount = Infinity;
    for (const [k, v] of Object.entries(analytics.languageStats)) {
      if (v < evictCount) {
        evictKey = k;
        evictCount = v;
      }
    }
    if (evictKey != null) delete analytics.languageStats[evictKey];
  }
  analytics.languageStats[key] = 1;
}

function bumpContentStat(contentType, contentId) {
  if (!contentId) return;
  const imdbId = contentId.split(':')[0];
  const key = contentType + '/' + imdbId;
  const existing = analytics.contentStats[key];
  if (existing) {
    existing.count++;
    existing.lastSeen = Date.now();
    return;
  }
  if (Object.keys(analytics.contentStats).length >= MAX_CONTENT_STATS) {
    let evictKey = null;
    let evictSeen = Infinity;
    for (const [k, v] of Object.entries(analytics.contentStats)) {
      if (v.lastSeen < evictSeen) {
        evictKey = k;
        evictSeen = v.lastSeen;
      }
    }
    if (evictKey != null) delete analytics.contentStats[evictKey];
  }
  analytics.contentStats[key] = {
    type: contentType,
    imdbId,
    count: 1,
    lastSeen: Date.now()
  };
}

// Track page view
function trackPageView(ip, page) {
  analytics.totalPageViews++;
  updateHourlyStats('pageViews');
  updateDailyStats('pageViews');

  addUniqueVisitor(hashIP(ip || 'unknown'));

  addActivity('pageView', { page });
}

// Track addon install
function trackInstall(ip, mainLang, transLang) {
  analytics.totalInstalls++;
  updateHourlyStats('installs');
  updateDailyStats('installs');

  // Track language popularity
  const langPair = `${mainLang}+${transLang}`;
  bumpLanguageStat(langPair);
  bumpLanguageStat(mainLang);
  bumpLanguageStat(transLang);

  addActivity('install', { mainLang, transLang });
}

// Track subtitle request
function trackSubtitleRequest(mainLang, transLang, contentType, contentId) {
  analytics.totalSubtitleRequests++;
  updateHourlyStats('subtitleRequests');
  updateDailyStats('subtitleRequests');

  bumpContentStat(contentType, contentId);

  addActivity('subtitleRequest', {
    mainLang,
    transLang,
    contentType,
    contentId: contentId ? contentId.split(':')[0] : null
  });
}

// Track subtitle served
function trackSubtitleServed() {
  analytics.totalSubtitlesServed++;
}

// Get analytics summary
function getAnalyticsSummary() {
  const now = Date.now();
  const uptime = Math.floor((now - analytics.serverStartTime) / 1000);

  // Calculate today's stats
  const todayIndex = getCurrentDayIndex();
  const todayStats = analytics.dailyStats[todayIndex].date === getCurrentDayKey()
    ? analytics.dailyStats[todayIndex]
    : { pageViews: 0, installs: 0, subtitleRequests: 0 };

  // Get top languages
  const topLanguages = Object.entries(analytics.languageStats)
    .filter(([key]) => !key.includes('+')) // Exclude pairs
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Get top language pairs
  const topPairs = Object.entries(analytics.languageStats)
    .filter(([key]) => key.includes('+'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Calculate hourly chart data (last 24 hours)
  const hourlyChart = [];
  for (let i = 0; i < 24; i++) {
    const hourIndex = (getCurrentHourIndex() - 23 + i + 24) % 24;
    hourlyChart.push({
      hour: hourIndex,
      ...analytics.hourlyStats[hourIndex]
    });
  }

  // Get popular content
  const popularContent = Object.values(analytics.contentStats)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    overview: {
      totalPageViews: analytics.totalPageViews,
      totalInstalls: analytics.totalInstalls,
      totalSubtitleRequests: analytics.totalSubtitleRequests,
      totalSubtitlesServed: analytics.totalSubtitlesServed,
      uniqueVisitors: analytics.uniqueVisitors.size,
      uptime: formatUptime(uptime)
    },
    today: todayStats,
    topLanguages,
    topPairs,
    popularContent,
    hourlyChart,
    recentActivity: analytics.recentActivity.slice(0, 20)
  };
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

module.exports = {
  trackPageView,
  trackInstall,
  trackSubtitleRequest,
  trackSubtitleServed,
  getAnalyticsSummary
};
