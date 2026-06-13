/**
 * Per-cue text features for cross-language alignment.
 *
 * Why this module exists
 * ----------------------
 * The timing-only sync engine (lib/syncEngine.js) does an excellent job
 * when both subtitle tracks are timed against the same release: a constant
 * offset and a linear drift cover ~95% of cases. The remaining 5% are
 * harder: dense-dialogue scenes where many cues overlap each other in time
 * and timing alone can't tell which trans cue belongs with which main cue.
 *
 * Text content carries cross-language signal that survives translation:
 *
 *   • Digits & numbers — "1985", "3:00", "100%" appear identically in
 *     basically every language. A shared digit token is the strongest
 *     anchor signal we can get without doing actual translation lookup.
 *
 *   • Punctuation — `?` at the end of a cue strongly correlates across
 *     languages. So do `!`, `…` (trailing-off), and `—` (speaker breaks).
 *
 *   • Length ratio — the same line never differs by 3×+ in length between
 *     two real languages. A wild ratio means we're looking at the wrong
 *     pair.
 *
 * Each feature returns a 0..1 score, combined with weights tuned so that
 * digit matches dominate (they're nearly unambiguous) and punct/length
 * provide softer tiebreakers. The combined `textSimilarity` is then fed
 * into the syncEngine as an additive signal next to overlap-based timing.
 *
 * Not implemented intentionally
 * -----------------------------
 *   • Proper-noun matching — works fine inside Latin-script pairs (en↔es,
 *     en↔tr) but breaks the moment one side is transliterated (en↔ja).
 *     Digit matching gives most of the same signal at lower noise.
 *   • Language-pair length priors — a static "Turkish is 1.15× English"
 *     prior is fragile across content types. The per-cue length-ratio fit
 *     used here is parameter-free and works for any pair.
 */

// Digits, decimals, times like 3:00, ranges like 1995-1999.
const DIGIT_TOKEN_RE = /\b\d+(?:[:.,\-]\d+)*\b/g;

// Inline markup the alignment shouldn't see: HTML tags from the parser,
// ASS/SSA override blocks, leftover music glyphs.
const MARKUP_RE = /<[^>]+>|\{\\[^}]*\}|[♪♫]/g;

function stripMarkup(text) {
  if (!text) return '';
  return String(text).replace(MARKUP_RE, '');
}

function extractDigits(text) {
  if (!text) return [];
  const matches = String(text).match(DIGIT_TOKEN_RE);
  if (!matches) return [];
  // Dedupe — a cue with "3-2-1" should count as one anchor signal, not three.
  return Array.from(new Set(matches));
}

function visibleLength(text) {
  if (!text) return 0;
  return String(text).replace(/\s+/g, ' ').trim().length;
}

function punctFlags(text) {
  const t = String(text || '').trim();
  return {
    q: /\?/.test(t),
    excl: /!/.test(t),
    ellipsis: /\.{2,}|…/.test(t),
    dash: /—|\B--\B/.test(t)
  };
}

// Sentence-final terminators across the scripts we routinely see.
const SENTENCE_TERMINATOR_RE = /[.!?؟。]/;

function endsSentenceFlag(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return SENTENCE_TERMINATOR_RE.test(trimmed[trimmed.length - 1]);
}

/**
 * Build the feature object for one cue. Cheap (string ops only) so it's
 * fine to call once per cue at the start of alignment.
 */
function extractCueFeatures(text) {
  const cleaned = stripMarkup(text);
  return {
    digits: extractDigits(cleaned),
    punct: punctFlags(cleaned),
    len: visibleLength(cleaned),
    endsSentence: endsSentenceFlag(cleaned)
  };
}

/**
 * Build an array of features parallel to a cue array.
 *
 * Returns an array of feature objects where `out[i]` corresponds to
 * `cues[i]`. Cues without `.text` get an empty-but-safe feature object
 * so downstream code never needs null checks.
 */
function buildFeatureArray(cues) {
  if (!Array.isArray(cues)) return [];
  return cues.map(c => extractCueFeatures(c && c.text));
}

function jaccard(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const unionSize = setA.size + setB.size - intersect;
  return unionSize === 0 ? 0 : intersect / unionSize;
}

/**
 * Digit similarity: Jaccard of the two digit-token sets. Returns 0 when
 * EITHER side has no digits (no signal — not a vote for or against).
 */
function digitSimilarity(featA, featB) {
  if (!featA || !featB) return 0;
  if (featA.digits.length === 0 || featB.digits.length === 0) return 0;
  return jaccard(featA.digits, featB.digits);
}

/**
 * Returns true when both cues have digits but those digits don't overlap
 * at all. Strong "these are NOT the same line" signal — used as a hard
 * penalty in pair scoring, not just a missing-bonus.
 */
function digitsContradict(featA, featB) {
  if (!featA || !featB) return false;
  if (featA.digits.length === 0 || featB.digits.length === 0) return false;
  return jaccard(featA.digits, featB.digits) === 0;
}

/**
 * Punctuation similarity. We only credit flags that are TRUE on at least
 * one side — "neither has `?`" is a near-zero-information match because
 * most short cues have neither.
 *
 * `endsSentence` is treated separately by sentenceShapeSignal — it's a
 * boolean that's true on most cues (most lines end with `.`), so folding
 * it into the agree/possible accounting would dilute the per-flag
 * signal. Disagreement (one ends a sentence, the other is mid-fragment)
 * is a strong negative signal handled by sentenceShapeSignal directly.
 */
function punctSimilarity(featA, featB) {
  if (!featA || !featB) return 0;
  const keys = ['q', 'excl', 'ellipsis', 'dash'];
  let possible = 0;
  let agree = 0;
  for (const k of keys) {
    if (featA.punct[k] || featB.punct[k]) {
      possible++;
      if (featA.punct[k] === featB.punct[k]) agree++;
    }
  }
  return possible === 0 ? 0 : agree / possible;
}

/**
 * Sentence-shape signal in [-1, +1]: +1 when both cues end a sentence,
 * -1 when one ends a sentence and the other is mid-fragment, 0 when both
 * are mid-fragment. Negative values flag mismatched utterance boundaries,
 * which strongly suggests the cues describe different lines.
 *
 * Crucial for shifted tracks: in Rick and Morty, "Total waste of snakes."
 * (ends sentence) was mispairing with "If you want to take a beat" (mid-
 * fragment). Pure timing overlap couldn't tell them apart; this signal
 * can.
 */
function sentenceShapeSignal(featA, featB) {
  if (!featA || !featB) return 0;
  if (featA.endsSentence && featB.endsSentence) return 1;
  if (!featA.endsSentence && !featB.endsSentence) return 0;
  return -1;
}

/**
 * Length-ratio fit: how close are the two cues to having the same number
 * of visible characters? Returns ~1 for equal-length cues, ~0 when one is
 * more than 3× the other.
 *
 * Parameter-free; works for any language pair (including CJK↔Latin which
 * has wildly different absolute lengths but consistent within itself).
 */
function lengthRatioFit(featA, featB) {
  if (!featA || !featB) return 0;
  if (featA.len === 0 || featB.len === 0) return 0;
  const ratio = Math.min(featA.len, featB.len) / Math.max(featA.len, featB.len);
  // ratio == 1: identical lengths → 1.0
  // ratio == 0.33: 3× difference → 0.0
  return Math.max(0, (ratio - 0.33) / 0.67);
}

const TEXT_SIM_WEIGHTS = {
  digit: 0.55,
  length: 0.2,
  punct: 0.1,
  shape: 0.15
};

/**
 * Combined text-similarity score in [0, 1].
 *
 * Digits dominate because a shared digit is near-deterministic evidence.
 * Length and punctuation are softer tiebreakers; sentence-shape (whether
 * both cues end a sentence) adds a small negative signal when one is a
 * complete sentence and the other is mid-fragment.
 */
function textSimilarity(featA, featB) {
  if (!featA || !featB) return 0;
  // shape can be negative; clamp the total so callers see a [0, 1] range.
  const raw =
    TEXT_SIM_WEIGHTS.digit * digitSimilarity(featA, featB) +
    TEXT_SIM_WEIGHTS.length * lengthRatioFit(featA, featB) +
    TEXT_SIM_WEIGHTS.punct * punctSimilarity(featA, featB) +
    TEXT_SIM_WEIGHTS.shape * sentenceShapeSignal(featA, featB);
  return Math.max(0, Math.min(1, raw));
}

// Empirically: any pair with digitSim ≥ 0.5 (i.e., at least half the
// digit tokens shared, often exactly one digit on each side and the same
// one) is a high-confidence anchor and can override timing ambiguity.
const HIGH_CONFIDENCE_DIGIT_SIM = 0.5;

function isHighConfidenceTextMatch(featA, featB) {
  return digitSimilarity(featA, featB) >= HIGH_CONFIDENCE_DIGIT_SIM;
}

module.exports = {
  extractCueFeatures,
  buildFeatureArray,
  textSimilarity,
  digitSimilarity,
  digitsContradict,
  punctSimilarity,
  sentenceShapeSignal,
  lengthRatioFit,
  isHighConfidenceTextMatch,
  endsSentenceFlag,
  HIGH_CONFIDENCE_DIGIT_SIM,
  SENTENCE_TERMINATOR_RE,
  TEXT_SIM_WEIGHTS,
  _internal: {
    extractDigits,
    visibleLength,
    punctFlags,
    stripMarkup,
    jaccard
  }
};
