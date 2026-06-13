/**
 * Smart source-pair selection for the dual-subtitle merger.
 *
 * Background
 * ----------
 * The OpenSubtitles v3 stream API returns a flat list of subtitles per IMDB
 * id, where each entry has only six fields:
 *
 *   { id, url, lang, SubEncoding, m, g }
 *
 * No fps, no filename, no download counts, no video size. The historical
 * picker therefore just took the first hit per language and hoped for the
 * best. On titles like The Sopranos S01E03 ENG+TUR that strategy paired
 * subtitles from different releases, producing nonlinear local drift no
 * sync engine can fully repair.
 *
 * Empirically the `g` field is a release/source grouping id: subtitles
 * that share the same `g` come from the same source upload and are timed
 * against the same video release. We measured the impact on Sopranos
 * S01E03:
 *   - cross-group pair (production today): 75.3% match rate
 *   - same-`g` pair                       : 89.4% match rate
 *
 * Ranking signals (smarter discovery)
 * -----------------------------------
 * On top of `g` we now use:
 *
 *   • Hash-match boost — `sub.m !== 'i'` indicates the OpenSubtitles API
 *     matched on something stronger than the IMDb id (typically file-hash
 *     or file-name). These results are heavily preferred when present.
 *
 *   • Filename-overlap score — when Stremio passes us the user's filename
 *     via extras, we tokenize it and score each candidate by Jaccard token
 *     overlap with whatever release info the candidate exposes
 *     (`_release` / `_fileName` for Wyzie; URL path tokens otherwise).
 *
 *   • Cross-source same-release — `g` namespaces don't agree across
 *     providers (OpenSubtitles vs Wyzie). We supplement strict-`g` pairing
 *     with token-Jaccard pairing on `_release`/`_fileName`, so a Wyzie
 *     Podnapisi sub can pair with an OpenSubtitles sub from the same
 *     release name even when their `g` keys differ.
 *
 * This module exposes:
 *   • rankCandidatesForLanguage  - rank the in-language candidates so the
 *                                  top one is the best stand-alone choice.
 *   • generateCandidatePairs     - produce ordered (main, trans) pairs to
 *                                  try, preferring same-`g`, then same-
 *                                  release (cross-source), then ranked.
 */

const { getLanguageAliases } = require('../encoding');

// Token-overlap thresholds. Calibrated so a "same-release" Jaccard ≥ 0.5
// implies the two subtitles describe (almost) the same release name.
const RELEASE_TOKEN_MIN_LENGTH = 2;
const RELEASE_TOKEN_MIN_OVERLAP = 0.5;

/**
 * Filter the flat sub list down to the ones whose lang code matches a given
 * canonical language id (with all language aliases).
 */
function filterByLanguage(allSubtitles, languageId) {
  if (!Array.isArray(allSubtitles) || !languageId) return [];
  const aliases = getLanguageAliases(languageId);
  return allSubtitles.filter(s => s && aliases.includes(s.lang));
}

/**
 * Tokenize a release-like string. Lowercased, split on non-alphanumerics,
 * tiny noise tokens dropped. Strip the trailing subtitle extension first so
 * "Movie.2020.WEB-DL.srt" doesn't keep "srt" as a token.
 */
function tokenizeRelease(text) {
  if (!text) return [];
  const lowered = String(text)
    .toLowerCase()
    .replace(/\.(srt|vtt|ass|ssa|sub|gz|zip)$/i, '');
  const tokens = lowered.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.filter(t => t.length >= RELEASE_TOKEN_MIN_LENGTH);
}

/**
 * Extract release-identifying tokens from a candidate subtitle.
 * Pulls from Wyzie's explicit `_release`/`_fileName` first, then falls back
 * to the last path segment of the URL when nothing else is exposed.
 */
function subReleaseTokens(sub) {
  if (!sub) return [];
  const candidates = [];
  if (sub._release) candidates.push(sub._release);
  if (sub._fileName) candidates.push(sub._fileName);
  if (sub.url) {
    // Try the last URL path segment, which often carries the release name
    // when the provider exposes nice URLs. Hash-style opaque IDs produce no
    // useful tokens here, which is fine.
    try {
      const u = new URL(sub.url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      if (last) candidates.push(decodeURIComponent(last));
    } catch (_) {
      // Not a parseable URL — skip.
    }
  }
  const tokens = new Set();
  for (const c of candidates) {
    for (const t of tokenizeRelease(c)) tokens.add(t);
  }
  return Array.from(tokens);
}

/**
 * Jaccard token overlap |A ∩ B| / |A ∪ B|. Returns 0 when either side
 * has no usable tokens.
 */
function tokenJaccard(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const unionSize = setA.size + setB.size - intersection;
  if (unionSize === 0) return 0;
  return intersection / unionSize;
}

/**
 * Asymmetric token-recall: what fraction of the user's filename tokens
 * appear in the candidate. We use recall (not Jaccard) for filename
 * ranking because a candidate's release name may include extras (group,
 * codec) the user's filename doesn't.
 */
function tokenRecall(userTokens, subTokens) {
  if (!userTokens || userTokens.length === 0) return 0;
  if (!subTokens || subTokens.length === 0) return 0;
  const set = new Set(subTokens);
  let hits = 0;
  for (const t of userTokens) if (set.has(t)) hits++;
  return hits / userTokens.length;
}

/**
 * Score a candidate subtitle on its own merits.
 *
 * Heuristics (all additive, weights tuned so each one can outvote the
 * encoding bonus when justified):
 *   • 0 / +50  hash-match boost (m !== 'i' AND m present)
 *   • 0..+30   filename token-recall × 30 (only when filename was given)
 *   •     +5   utf8 / ascii encoding
 *   •     +2   common Windows codepage encoding
 *
 * @param {object} sub
 * @param {object} [context]
 * @param {string[]} [context.filenameTokens]
 */
function selfScore(sub, context = {}) {
  if (!sub) return 0;
  let s = 0;

  // Hash-match boost — `m !== 'i'` indicates the OS API matched on
  // something stronger than IMDb. If providers never differentiate, this
  // is a no-op; if they ever do, we already prefer the stronger match.
  if (sub.m && sub.m !== 'i') s += 50;

  // Filename overlap — only when the user gave us a filename to score by.
  const filenameTokens = context.filenameTokens || [];
  if (filenameTokens.length > 0) {
    const recall = tokenRecall(filenameTokens, subReleaseTokens(sub));
    if (recall > 0) s += Math.round(recall * 30);
  }

  // Encoding bonus (existing) — utf8/ascii are safest, common Windows
  // codepages second-best, obscure ones tend to break decoders.
  const encoding = String(sub.SubEncoding || '').toLowerCase().replace(/[-_]/g, '');
  if (encoding === 'utf8' || encoding === 'ascii') s += 5;
  else if (encoding === 'cp1254' || encoding === 'windows1254' ||
           encoding === 'cp1251' || encoding === 'windows1251') s += 2;

  return s;
}

function buildFilenameTokens(videoParams) {
  if (!videoParams || !videoParams.filename) return [];
  return tokenizeRelease(videoParams.filename);
}

/**
 * Rank candidates of a single language. Stable: ties keep original order
 * (which the API delivers in download/popularity order).
 *
 * @param {Array} allSubtitles
 * @param {string} languageId
 * @param {object} [options]
 * @param {object} [options.videoParams] - { filename, videoHash, videoSize }
 */
function rankCandidatesForLanguage(allSubtitles, languageId, options = {}) {
  const filenameTokens = buildFilenameTokens(options.videoParams);
  const list = filterByLanguage(allSubtitles, languageId);
  return list
    .map((sub, idx) => ({ sub, idx, score: selfScore(sub, { filenameTokens }) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map(x => x.sub);
}

/**
 * Cross-source same-release predicate. Returns true when the two subs share
 * a `g` key OR their release tokens overlap above the Jaccard threshold.
 */
function sameReleaseAcrossSources(a, b) {
  if (!a || !b) return false;
  if (a.g && b.g && a.g === b.g) return true;
  const ta = subReleaseTokens(a);
  const tb = subReleaseTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return tokenJaccard(ta, tb) >= RELEASE_TOKEN_MIN_OVERLAP;
}

/**
 * Build an ordered list of (main, trans) candidate pairs to try.
 *
 * Strategy (in order of preference, capped at `maxPairs`):
 *   1. Same-`g` pairs (strict, inside one provider).
 *   2. Same-release pairs across providers (release-token Jaccard ≥ 0.5).
 *   3. Zipped-popularity pairs (post-ranking, so hash/filename signals
 *      already promoted the right candidates to the top).
 *   4. Top-main × remaining-trans / top-trans × remaining-main fallbacks.
 *
 * @param {Array} allSubtitles
 * @param {string} mainLang
 * @param {string} transLang
 * @param {object} [options]
 * @param {number} [options.maxPairs=6]
 * @param {number} [options.maxPerGroup=2]
 * @param {object} [options.videoParams] - { filename, videoHash, videoSize }
 * @returns {Array<{
 *   main: object, trans: object, sameGroup: boolean,
 *   group: (string|null),
 *   source: 'group'|'cross-release'|'fallback'|'requested'
 * }>}
 */
function generateCandidatePairs(allSubtitles, mainLang, transLang, options = {}) {
  const { maxPairs = 6, maxPerGroup = 2 } = options;

  const mainList = rankCandidatesForLanguage(allSubtitles, mainLang, options);
  const transList = rankCandidatesForLanguage(allSubtitles, transLang, options);
  if (mainList.length === 0 || transList.length === 0) return [];

  const seen = new Set();
  const pairKey = (m, t) => `${m.id}:${t.id}`;

  // 1) Strict same-`g` pair queue (FIFO), highest-ranked main first.
  const transByG = new Map();
  for (const t of transList) {
    const g = t.g;
    if (g == null || g === '') continue;
    if (!transByG.has(g)) transByG.set(g, []);
    transByG.get(g).push(t);
  }
  const groupQueue = [];
  for (const m of mainList) {
    const peers = transByG.get(m.g);
    if (!peers || peers.length === 0) continue;
    let emittedForThisMain = 0;
    for (const t of peers) {
      const key = pairKey(m, t);
      if (seen.has(key)) continue;
      groupQueue.push({ main: m, trans: t, sameGroup: true, group: m.g, source: 'group' });
      seen.add(key);
      emittedForThisMain++;
      if (emittedForThisMain >= maxPerGroup) break;
    }
  }

  // 2) Cross-source same-release queue. Use release-token Jaccard for any
  // main without same-`g` peers (or whose same-`g` peers are exhausted).
  const crossQueue = [];
  for (const m of mainList) {
    const mainTokens = subReleaseTokens(m);
    if (mainTokens.length === 0) continue;
    let emittedForThisMain = 0;
    for (const t of transList) {
      const key = pairKey(m, t);
      if (seen.has(key)) continue;
      // Skip strict same-g cases — those are already in groupQueue.
      if (m.g && t.g && m.g === t.g) continue;
      const transTokens = subReleaseTokens(t);
      if (transTokens.length === 0) continue;
      if (tokenJaccard(mainTokens, transTokens) < RELEASE_TOKEN_MIN_OVERLAP) continue;
      crossQueue.push({
        main: m,
        trans: t,
        sameGroup: false,
        group: null,
        source: 'cross-release'
      });
      seen.add(key);
      emittedForThisMain++;
      if (emittedForThisMain >= maxPerGroup) break;
    }
  }

  // 3) Zipped-popularity queue (post-ranking).
  const zipQueue = [];
  const zipLen = Math.min(mainList.length, transList.length);
  for (let i = 0; i < zipLen; i++) {
    const key = pairKey(mainList[i], transList[i]);
    if (seen.has(key)) continue;
    zipQueue.push({
      main: mainList[i],
      trans: transList[i],
      sameGroup: mainList[i].g === transList[i].g && mainList[i].g != null,
      group: mainList[i].g === transList[i].g ? mainList[i].g : null,
      source: 'fallback'
    });
    seen.add(key);
  }

  // Interleave so the gate sees diverse pairs early:
  // first strict-group, first cross-release, first zip — repeat.
  const pairs = [];
  const order = [groupQueue, crossQueue, zipQueue, groupQueue, crossQueue, zipQueue];
  for (const queue of order) {
    if (pairs.length >= maxPairs) break;
    if (queue.length > 0) pairs.push(queue.shift());
  }
  while (
    pairs.length < maxPairs &&
    (groupQueue.length > 0 || crossQueue.length > 0 || zipQueue.length > 0)
  ) {
    if (groupQueue.length > 0) pairs.push(groupQueue.shift());
    if (pairs.length >= maxPairs) break;
    if (crossQueue.length > 0) pairs.push(crossQueue.shift());
    if (pairs.length >= maxPairs) break;
    if (zipQueue.length > 0) pairs.push(zipQueue.shift());
  }

  // Last-resort cross-products: top main × each remaining trans, top trans
  // × each remaining main. Useful when languages have very few subs.
  for (let i = 1; i < transList.length && pairs.length < maxPairs; i++) {
    const key = pairKey(mainList[0], transList[i]);
    if (seen.has(key)) continue;
    pairs.push({
      main: mainList[0],
      trans: transList[i],
      sameGroup: mainList[0].g === transList[i].g && mainList[0].g != null,
      group: null,
      source: 'fallback'
    });
    seen.add(key);
  }
  for (let i = 1; i < mainList.length && pairs.length < maxPairs; i++) {
    const key = pairKey(mainList[i], transList[0]);
    if (seen.has(key)) continue;
    pairs.push({
      main: mainList[i],
      trans: transList[0],
      sameGroup: mainList[i].g === transList[0].g && mainList[i].g != null,
      group: null,
      source: 'fallback'
    });
    seen.add(key);
  }

  return pairs;
}

module.exports = {
  filterByLanguage,
  rankCandidatesForLanguage,
  generateCandidatePairs,
  _internal: {
    selfScore,
    tokenizeRelease,
    tokenJaccard,
    tokenRecall,
    subReleaseTokens,
    sameReleaseAcrossSources
  }
};
