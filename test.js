/**
 * Unit tests for Stremio Dual Subtitles bug fixes.
 * Covers: Issue #1 (ENG+ZHT sync), Issue #2 (some subtitles not working), Issue #5 (Android TV blank label), Issue #9 (dual line styling)
 *
 * Run: npm test  (or: node test.js)
 */

const assert = require('assert');
const iconv = require('iconv-lite');

const {
  _test: {
    parseTimeToMs,
    parseSrt,
    parseSrtSimple,
    normalizeVttToSrt,
    mergeSubtitles,
    joinSubtitleLines,
    formatSrt,
    msToSrtTime,
    parseTimestampLine,
    normalizeVideoParams,
    serializeVideoParams,
    buildDynamicSubtitleUrl,
    normalizeTimingSource,
    normalizeSubtitleMode,
    decodeSubtitleEntities,
    cleanSubtitleText,
    isLikelyForcedUrl,
    isPureSdhCueText,
    stripAssOverrideTags,
    stripMusicMarkers,
    splitIntoSentences,
    splitMultiSentenceCues,
    normalizeAssToSrt,
    isAssFormat
  },
  manifest
} = require('./addon');

const { parseKitsuId } = require('./lib/animeSource');
// Prevent server.js from binding a port when required for tests
process.env.VERCEL = '1';
const { _test: { parseConfigParam } } = require('./server');
delete process.env.VERCEL;

const {
  isCjkLanguage,
  normalizeLanguageCode,
  decodeSubtitleBuffer,
  getLanguageAliases
} = require('./encoding');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

// ============================================================================
// parseTimeToMs
// ============================================================================
console.log('\n--- parseTimeToMs ---');

test('SRT comma format: 00:01:23,456 = 83456', () => {
  assert.strictEqual(parseTimeToMs('00:01:23,456'), 83456);
});

test('VTT period format: 00:01:23.456 = 83456 [Issue #1]', () => {
  assert.strictEqual(parseTimeToMs('00:01:23.456'), 83456);
});

test('With positioning metadata: 00:01:23,456 X1:100 = 83456 [Issue #1]', () => {
  assert.strictEqual(parseTimeToMs('00:01:23,456 X1:100 X2:200'), 83456);
});

test('1-digit hours: 1:01:23,456 = 3683456', () => {
  assert.strictEqual(parseTimeToMs('1:01:23,456'), 3683456);
});

test('2-digit ms padded: 00:01:23,45 = 83450', () => {
  assert.strictEqual(parseTimeToMs('00:01:23,45'), 83450);
});

test('1-digit ms padded: 00:01:23,4 = 83400', () => {
  assert.strictEqual(parseTimeToMs('00:01:23,4'), 83400);
});

test('null returns 0', () => {
  assert.strictEqual(parseTimeToMs(null), 0);
});

test('invalid string returns 0', () => {
  assert.strictEqual(parseTimeToMs('hello'), 0);
});

test('empty string returns 0', () => {
  assert.strictEqual(parseTimeToMs(''), 0);
});

// ============================================================================
// msToSrtTime
// ============================================================================
console.log('\n--- msToSrtTime ---');

test('83456ms = 00:01:23,456', () => {
  assert.strictEqual(msToSrtTime(83456), '00:01:23,456');
});

test('0ms = 00:00:00,000', () => {
  assert.strictEqual(msToSrtTime(0), '00:00:00,000');
});

// ============================================================================
// parseSrt — SRT format
// ============================================================================
console.log('\n--- parseSrt (SRT) ---');

test('Standard SRT parses correctly', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello World\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond line\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, 'Hello World');
  assert.strictEqual(result[1].text, 'Second line');
});

test('Period-separated SRT parses correctly [Issue #1, #2]', () => {
  const srt = '1\n00:00:01.000 --> 00:00:04.000\nHello\n\n2\n00:00:05.000 --> 00:00:08.000\nWorld\n';
  const result = parseSrt(srt);
  assert.ok(result, 'Period SRT should not return null');
  assert.strictEqual(result.length, 2);
});

test('SRT with BOM parses correctly', () => {
  const srt = '\uFEFF1\n00:00:01,000 --> 00:00:04,000\nWith BOM\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
});

test('SRT with Windows line endings parses correctly', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:04,000\r\nWindows\r\n\r\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
});

test('SRT without numeric cue IDs parses correctly', () => {
  const srt = '00:00:01,000 --> 00:00:04,000\nNo index\n\n00:00:05,000 --> 00:00:08,000\nStill parses\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, 'No index');
  assert.strictEqual(result[1].text, 'Still parses');
});

test('SRT without blank separator between cues parses correctly', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nFirst\n2\n00:00:05,000 --> 00:00:08,000\nSecond\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, 'First');
  assert.strictEqual(result[1].text, 'Second');
});

test('Timestamp metadata is stripped during parse', () => {
  const timing = parseTimestampLine('00:00:01.5 --> 00:00:04.25 align:middle line:90%');
  assert.deepStrictEqual(timing, {
    startTime: '00:00:01,500',
    endTime: '00:00:04,250'
  });
});

test('SRT ad lines are filtered out', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:08,000\nAdvertise your product at OpenSubtitles.org\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, 'Hello');
});

test('SRT: pure-SDH bracketed cues are dropped', () => {
  const srt =
    '1\n00:00:01,000 --> 00:00:04,000\n[door slams]\n\n' +
    '2\n00:00:05,000 --> 00:00:08,000\nReal dialogue\n\n' +
    '3\n00:00:09,000 --> 00:00:12,000\n[ENGINE REVVING]\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, 'Real dialogue');
});

test('SRT: bracketed text mixed with dialogue is kept', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\n[softly] Come closer\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, '[softly] Come closer');
});

test('SRT: parenthetical-only cues stay (ambiguous with whispered dialogue)', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\n(don\'t tell anyone)\n';
  const result = parseSrt(srt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
});

test('Empty/null input returns null', () => {
  assert.strictEqual(parseSrt(null), null);
  assert.strictEqual(parseSrt(''), null);
  assert.strictEqual(parseSrt('   '), null);
});

// ============================================================================
// parseSrt — VTT format [Issue #2]
// ============================================================================
console.log('\n--- parseSrt (VTT) [Issue #2] ---');

test('VTT without cue IDs parses correctly', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nFirst cue\n\n00:00:05.000 --> 00:00:08.000\nSecond cue\n';
  const result = parseSrt(vtt);
  assert.ok(result, 'VTT should not return null');
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, 'First cue');
  assert.strictEqual(result[1].text, 'Second cue');
});

test('VTT with numeric cue IDs parses correctly', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello\n\n2\n00:00:05.000 --> 00:00:08.000\nWorld\n';
  const result = parseSrt(vtt);
  assert.ok(result, 'VTT with cue IDs should not return null');
  assert.strictEqual(result.length, 2);
});

test('VTT with STYLE block is handled', () => {
  const vtt = 'WEBVTT\n\nSTYLE\n::cue { color: white; }\n\n00:00:01.000 --> 00:00:04.000\nStyled\n';
  const result = parseSrt(vtt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, 'Styled');
});

test('VTT with Kind/Language headers is handled', () => {
  const vtt = 'WEBVTT\nKind: captions\nLanguage: en\n\n00:00:01.000 --> 00:00:04.000\nCaption\n';
  const result = parseSrt(vtt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
});

test('VTT with NOTE, REGION, cue IDs, and cue settings is handled', () => {
  const vtt = 'WEBVTT\n\nNOTE generated by source\nignore this note\n\nREGION\nid:fred\n\nintro-cue\n00:00:01.000 --> 00:00:04.000 align:middle line:90%\nCaption\n';
  const result = parseSrt(vtt);
  assert.ok(result);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].startTime, '00:00:01,000');
  assert.strictEqual(result[0].endTime, '00:00:04,000');
  assert.strictEqual(result[0].text, 'Caption');
  assert.ok(!formatSrt(result).includes('align:middle'));
});

// ============================================================================
// joinSubtitleLines [Issue #1 — CJK spacing]
// ============================================================================
console.log('\n--- joinSubtitleLines [Issue #1] ---');

test('CJK: no space between lines for zht', () => {
  assert.strictEqual(joinSubtitleLines('A\nB', 'zht'), 'AB');
});

test('CJK: no space between lines for jpn', () => {
  assert.strictEqual(joinSubtitleLines('A\nB', 'jpn'), 'AB');
});

test('CJK: no space between lines for kor', () => {
  assert.strictEqual(joinSubtitleLines('A\nB', 'kor'), 'AB');
});

test('CJK: no space between lines for chi', () => {
  assert.strictEqual(joinSubtitleLines('A\nB', 'chi'), 'AB');
});

test('Latin: space between lines for eng', () => {
  assert.strictEqual(joinSubtitleLines('Hello\nWorld', 'eng'), 'Hello World');
});

test('Latin: space between lines for tur', () => {
  assert.strictEqual(joinSubtitleLines('Merhaba\nDunya', 'tur'), 'Merhaba Dunya');
});

test('null lang defaults to space', () => {
  assert.strictEqual(joinSubtitleLines('A\nB', null), 'A B');
});

test('empty text returns empty', () => {
  assert.strictEqual(joinSubtitleLines('', 'eng'), '');
});

// ============================================================================
// mergeSubtitles [Issue #1 — sync]
// ============================================================================
console.log('\n--- mergeSubtitles [Issue #1] ---');

test('Matching timestamps merge correctly', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hello' },
    { id: '2', startTime: '00:00:05,000', endTime: '00:00:08,000', text: 'World' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hola' },
    { id: '2', startTime: '00:00:05,000', endTime: '00:00:08,000', text: 'Mundo' }
  ];
  const result = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'spa' });
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].text.includes('Hello'));
  assert.ok(result[0].text.includes('Hola'));
  assert.ok(result[1].text.includes('World'));
  assert.ok(result[1].text.includes('Mundo'));
});

test('Slightly offset timestamps still merge', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hello' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,300', endTime: '00:00:04,200', text: 'Hola' }
  ];
  const result = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'spa' });
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].text.includes('Hola'), 'Translation should be merged despite 300ms offset');
});

test('Non-overlapping timestamps do not merge', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:02,000', text: 'Hello' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:10,000', endTime: '00:00:12,000', text: 'Hola' }
  ];
  const result = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'spa' });
  assert.strictEqual(result.length, 1);
  assert.ok(!result[0].text.includes('Hola'), 'Translation should NOT merge with 8s gap');
});

test('Period timestamps merge correctly (both tracks)', () => {
  const mainSrt = '1\n00:00:01.000 --> 00:00:04.000\nHello\n\n2\n00:00:05.000 --> 00:00:08.000\nWorld\n';
  const transSrt = '1\n00:00:01.000 --> 00:00:04.000\nHola\n\n2\n00:00:05.000 --> 00:00:08.000\nMundo\n';
  const mainParsed = parseSrt(mainSrt);
  const transParsed = parseSrt(transSrt);
  assert.ok(mainParsed && transParsed);
  const result = mergeSubtitles(mainParsed, transParsed, { mainLang: 'eng', transLang: 'spa' });
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].text.includes('Hola'));
  assert.ok(result[1].text.includes('Mundo'));
});

test('CJK merge has no space in translation line', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hello' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Line1\nLine2' }
  ];
  const result = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'zht' });
  assert.ok(result[0].text.includes('Line1Line2'), 'CJK translation lines should join without space');
});

test('Backward compat: numeric threshold still works', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hello' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hola' }
  ];
  const result = mergeSubtitles(main, trans, 500);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].text.includes('Hola'));
});

test('Dual merge distinguishes lines: bold primary and colored secondary [Issue #9]', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hello' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'Hola' }
  ];
  const result = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'spa' });
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].text.includes('<b>Hello</b>'), 'primary line should be bold');
  assert.ok(!result[0].text.includes('\u203a '), 'secondary line should not include a visible marker');
  assert.ok(
    result[0].text.includes(`<font color="#94a3b8">`),
    'secondary should use a muted color where the player supports it'
  );
});

test('Dual merge decodes subtitle entities before rendering', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: 'You can do this.' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:04,000', text: '&quot;يمكنك فعل هذا&quot;' }
  ];
  const result = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'ara' });
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].text.includes('"يمكنك فعل هذا"'), 'HTML entities should render as normal quotes');
  assert.ok(!result[0].text.includes('&quot;'), 'quote entities should not leak into rendered subtitle text');
});

test('decodeSubtitleEntities handles common named and numeric entities', () => {
  assert.strictEqual(
    decodeSubtitleEntities('&quot;A&amp;B&#x22; &lt;tag&gt;'),
    '"A&B" <tag>'
  );
});

// ============================================================================
// encoding.js — isCjkLanguage [Issue #1]
// ============================================================================
console.log('\n--- isCjkLanguage [Issue #1] ---');

test('zht is CJK', () => assert.strictEqual(isCjkLanguage('zht'), true));
test('chi is CJK', () => assert.strictEqual(isCjkLanguage('chi'), true));
test('jpn is CJK', () => assert.strictEqual(isCjkLanguage('jpn'), true));
test('kor is CJK', () => assert.strictEqual(isCjkLanguage('kor'), true));
test('zh-tw is CJK', () => assert.strictEqual(isCjkLanguage('zh-tw'), true));
test('eng is not CJK', () => assert.strictEqual(isCjkLanguage('eng'), false));
test('tur is not CJK', () => assert.strictEqual(isCjkLanguage('tur'), false));
test('null is not CJK', () => assert.strictEqual(isCjkLanguage(null), false));

// ============================================================================
// encoding.js — normalizeLanguageCode [Issue #1 — ZHT encoding priority]
// ============================================================================
console.log('\n--- normalizeLanguageCode [Issue #1] ---');

test('zht -> zh-tw (Big5 priority)', () => {
  assert.strictEqual(normalizeLanguageCode('zht'), 'zh-tw');
});

test('zh-tw stays zh-tw (Big5 priority after normalization)', () => {
  assert.strictEqual(normalizeLanguageCode('zh-tw'), 'zh-tw');
});

test('chi -> zh (GBK priority)', () => {
  assert.strictEqual(normalizeLanguageCode('chi'), 'zh');
});

test('eng -> en', () => {
  assert.strictEqual(normalizeLanguageCode('eng'), 'en');
});

test('tur -> tr', () => {
  assert.strictEqual(normalizeLanguageCode('tur'), 'tr');
});

test('2-letter code passes through', () => {
  assert.strictEqual(normalizeLanguageCode('en'), 'en');
});

// ============================================================================
// encoding.js — decodeSubtitleBuffer
// ============================================================================
console.log('\n--- decodeSubtitleBuffer ---');

test('UTF-8 buffer decodes correctly', () => {
  const buf = Buffer.from('Hello World', 'utf8');
  const result = decodeSubtitleBuffer(buf, 'eng');
  assert.ok(result.includes('Hello World'));
});

test('UTF-8 BOM buffer decodes correctly', () => {
  const buf = Buffer.from('\xEF\xBB\xBFHello BOM', 'utf8');
  const result = decodeSubtitleBuffer(buf, 'eng');
  assert.ok(result.includes('Hello BOM'));
  assert.ok(!result.startsWith('\uFEFF'), 'BOM should be stripped');
});

test('Chinese UTF-8 text decodes correctly', () => {
  const text = '1\n00:00:01,000 --> 00:00:04,000\n你好世界\n';
  const buf = Buffer.from(text, 'utf8');
  const result = decodeSubtitleBuffer(buf, 'zht');
  assert.ok(result.includes('你好世界'), 'Chinese characters should be preserved');
});

test('Turkish Windows-1254 subtitles decode with language hint', () => {
  const text = '1\n00:00:01,000 --> 00:00:04,000\nİstanbul ışığı çözdü\n';
  const buf = iconv.encode(text, 'win1254');
  const result = decodeSubtitleBuffer(buf, 'tur');
  assert.ok(result.includes('İstanbul ışığı çözdü'), 'Turkish CP1254 characters should decode correctly');
});

test('Traditional Chinese Big5 subtitles decode with zht hint', () => {
  const text = '1\n00:00:01,000 --> 00:00:04,000\n繁體中文\n';
  const buf = iconv.encode(text, 'big5');
  const result = decodeSubtitleBuffer(buf, 'zht');
  assert.ok(result.includes('繁體中文'), 'Traditional Chinese Big5 characters should decode correctly');
});

// ============================================================================
// Manifest — lang field [Issue #5 — Android TV]
// ============================================================================
console.log('\n--- Manifest & subtitle output [Issue #5] ---');

test('Manifest has correct id', () => {
  assert.strictEqual(manifest.id, 'community.dualsubtitles');
});

test('Manifest resources includes subtitles', () => {
  assert.ok(manifest.resources.includes('subtitles'));
});

// ============================================================================
// formatSrt roundtrip
// ============================================================================
console.log('\n--- formatSrt ---');

test('Parse then format roundtrip preserves content', () => {
  const original = '1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:08,000\nWorld\n\n';
  const parsed = parseSrt(original);
  const formatted = formatSrt(parsed);
  assert.ok(formatted.includes('Hello'));
  assert.ok(formatted.includes('World'));
  assert.ok(formatted.includes('00:00:01,000 --> 00:00:04,000'));
});

// ============================================================================
// Dynamic subtitle URL/video params
// ============================================================================
console.log('\n--- dynamic subtitle URL/video params ---');

test('normalizeVideoParams keeps only supported non-empty values', () => {
  assert.deepStrictEqual(
    normalizeVideoParams({
      filename: ' Movie.2020.mkv ',
      videoSize: 12345,
      videoHash: ['abc123'],
      ignored: 'nope'
    }),
    { filename: 'Movie.2020.mkv', videoSize: '12345', videoHash: 'abc123' }
  );
});

test('buildDynamicSubtitleUrl preserves video matching params as query string', () => {
  const url = buildDynamicSubtitleUrl(
    'movie',
    '0111161',
    '0',
    '0',
    'eng',
    'tur',
    'main-id',
    'trans-id',
    { filename: 'Movie.2020.1080p.mkv', videoSize: '12345', videoHash: 'abc123' }
  );
  assert.ok(url.startsWith('{{ADDON_URL}}/subs/movie/0111161/0/0/eng/tur/main-id/trans-id.srt?'));
  assert.ok(url.includes('filename=Movie.2020.1080p.mkv'));
  assert.ok(url.includes('videoSize=12345'));
  assert.ok(url.includes('videoHash=abc123'));
});

test('buildDynamicSubtitleUrl can request secondary subtitle timing', () => {
  const url = buildDynamicSubtitleUrl(
    'movie',
    '0111161',
    '0',
    '0',
    'eng',
    'ara',
    'main-id',
    'trans-id',
    { filename: 'Movie.2020.mkv' },
    { timingSource: 'secondary' }
  );
  assert.ok(url.includes('filename=Movie.2020.mkv'));
  assert.ok(url.includes('timingSource=secondary'));
});

test('normalizeTimingSource rejects unknown values', () => {
  assert.strictEqual(normalizeTimingSource('secondary'), 'secondary');
  assert.strictEqual(normalizeTimingSource('embedded'), 'primary');
  assert.strictEqual(normalizeTimingSource('independent'), 'primary');
  assert.strictEqual(normalizeTimingSource(null), 'primary');
});

test('normalizeSubtitleMode rejects unknown values', () => {
  assert.strictEqual(normalizeSubtitleMode('dual'), 'dual');
  assert.strictEqual(normalizeSubtitleMode('translate-primary'), 'dual');
  assert.strictEqual(normalizeSubtitleMode('translated'), 'dual');
  assert.strictEqual(normalizeSubtitleMode(null), 'dual');
});

test('serializeVideoParams URL-encodes unsafe filename characters', () => {
  assert.strictEqual(
    serializeVideoParams({ filename: 'Movie Name #1.mkv' }),
    'filename=Movie+Name+%231.mkv'
  );
});

test('parseExtra preserves dotted filenames and dotted key separators', () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  const { _test: { parseExtra } } = require('./server');
  if (previousVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = previousVercel;

  assert.deepStrictEqual(
    parseExtra('filename=Movie.2020.1080p.mkv'),
    { filename: 'Movie.2020.1080p.mkv' }
  );
  assert.deepStrictEqual(
    parseExtra('videoHash=abc123.videoSize=456.filename=Movie.2020.1080p.mkv'),
    { videoHash: 'abc123', videoSize: '456', filename: 'Movie.2020.1080p.mkv' }
  );
});

// ============================================================================
// syncEngine — alignment + matching pipeline
// ============================================================================
console.log('\n--- syncEngine ---');

const {
  estimateSequenceOffsetMs,
  estimateOffsetMs,
  applyOffset,
  estimateAffineMapping,
  applyAffine,
  assignMatches,
  alignAndMatch,
  overlapScore
} = require('./lib/syncEngine');

function makeTimedCues(specs) {
  return specs.map(([startMs, endMs, text], i) => ({
    id: String(i + 1),
    startMs,
    endMs,
    text
  }));
}

test('overlapScore: full overlap = 1', () => {
  const m = { startMs: 1000, endMs: 4000 };
  const t = { startMs: 1000, endMs: 4000 };
  assert.strictEqual(overlapScore(m, t), 1);
});

test('overlapScore: no overlap = 0', () => {
  const m = { startMs: 1000, endMs: 2000 };
  const t = { startMs: 3000, endMs: 4000 };
  assert.strictEqual(overlapScore(m, t), 0);
});

test('overlapScore: partial overlap is between 0 and 1', () => {
  const m = { startMs: 1000, endMs: 3000 };
  const t = { startMs: 2000, endMs: 4000 };
  const s = overlapScore(m, t);
  assert.ok(s > 0 && s < 1);
});

test('estimateOffsetMs: detects +2000ms offset on trans track', () => {
  const main = makeTimedCues([
    [1000, 3000, 'a'], [4000, 6000, 'b'], [7000, 9000, 'c'],
    [10000, 12000, 'd'], [13000, 15000, 'e'], [16000, 18000, 'f']
  ]);
  const trans = makeTimedCues([
    [3000, 5000, 'A'], [6000, 8000, 'B'], [9000, 11000, 'C'],
    [12000, 14000, 'D'], [15000, 17000, 'E'], [18000, 20000, 'F']
  ]);
  const offset = estimateOffsetMs(main, trans);
  // trans is delayed by 2s so offset should be -2000 (shift trans earlier)
  assert.ok(Math.abs(offset - -2000) <= 100, `expected ~-2000, got ${offset}`);
});

test('estimateOffsetMs: returns 0 when tracks already aligned', () => {
  const main = makeTimedCues([
    [1000, 3000, 'a'], [4000, 6000, 'b'], [7000, 9000, 'c'],
    [10000, 12000, 'd'], [13000, 15000, 'e']
  ]);
  const trans = makeTimedCues([
    [1000, 3000, 'A'], [4000, 6000, 'B'], [7000, 9000, 'C'],
    [10000, 12000, 'D'], [13000, 15000, 'E']
  ]);
  const offset = estimateOffsetMs(main, trans);
  assert.ok(Math.abs(offset) <= 200, `aligned tracks should yield ~0 offset, got ${offset}`);
});

test('estimateOffsetMs: returns 0 with empty inputs', () => {
  assert.strictEqual(estimateOffsetMs([], []), 0);
  assert.strictEqual(estimateOffsetMs(null, null), 0);
});

test('estimateSequenceOffsetMs: detects a uniform -4000ms secondary offset in dense dialogue', () => {
  const main = makeTimedCues([
    [1000, 2600, 'a'], [3100, 4700, 'b'], [5200, 6800, 'c'], [7300, 8900, 'd'],
    [9400, 11000, 'e'], [11500, 13100, 'f'], [13600, 15200, 'g'], [15700, 17300, 'h'],
    [17800, 19400, 'i'], [19900, 21500, 'j']
  ]);
  const trans = main.map((cue, i) => ({
    ...cue,
    id: `t${i + 1}`,
    startMs: cue.startMs - 4000,
    endMs: cue.endMs - 4000
  }));
  assert.strictEqual(estimateSequenceOffsetMs(main, trans), 4000);
});

test('applyOffset: shifts every cue by offset', () => {
  const subs = makeTimedCues([[1000, 2000, 'a'], [3000, 4000, 'b']]);
  const out = applyOffset(subs, 500);
  assert.strictEqual(out[0].startMs, 1500);
  assert.strictEqual(out[1].endMs, 4500);
  // Original is not mutated
  assert.strictEqual(subs[0].startMs, 1000);
});

test('estimateAffineMapping: detects framerate-style linear drift', () => {
  // Main timestamps; trans is "stretched" by factor 1.01 (drift growing
  // over time) — simulates a small framerate mismatch. We keep the
  // factor small so simple nearest-neighbor anchor pairing stays correct
  // across the whole file; in real use the offset stage runs before this
  // and leaves only the residual drift here.
  const main = [];
  const trans = [];
  for (let i = 0; i < 20; i++) {
    const t = i * 5000 + 1000;
    main.push({ id: String(i + 1), startMs: t, endMs: t + 2000, text: `m${i}` });
    const tt = Math.round(t * 1.01 + 200);
    trans.push({ id: String(i + 1), startMs: tt, endMs: tt + 2000, text: `t${i}` });
  }
  const mapping = estimateAffineMapping(main, trans, { anchorThresholdMs: 5000 });
  assert.ok(mapping, 'expected an affine mapping');
  assert.ok(Math.abs(mapping.a - 1.01) < 0.005, `slope a=${mapping.a}`);
  assert.ok(mapping.anchors >= 8);
});

test('estimateAffineMapping: returns null when too few anchors', () => {
  const main = makeTimedCues([[1000, 2000, 'a'], [5000, 6000, 'b']]);
  const trans = makeTimedCues([[1000, 2000, 'A'], [5000, 6000, 'B']]);
  const mapping = estimateAffineMapping(main, trans);
  assert.strictEqual(mapping, null);
});

test('assignMatches: never assigns same trans cue twice', () => {
  // Two main cues that are both close to a single trans cue
  const main = makeTimedCues([[1000, 2000, 'a'], [2200, 3200, 'b']]);
  const trans = makeTimedCues([[1100, 2100, 'shared']]);
  const matches = assignMatches(main, trans, { threshold: 1500 });
  const assigned = [];
  for (const arr of matches.values()) for (const t of arr) assigned.push(t);
  const seen = new Set(assigned);
  assert.strictEqual(seen.size, assigned.length, 'no trans cue may appear twice');
});

test('assignMatches: 1:N — main cue absorbs multiple short trans cues', () => {
  const main = makeTimedCues([[1000, 5000, 'long']]);
  const trans = makeTimedCues([
    [1000, 2000, 'first half'],
    [3000, 4500, 'second half']
  ]);
  const matches = assignMatches(main, trans, { threshold: 1500, allowMultiTrans: true });
  const idxs = matches.get(0);
  assert.ok(idxs && idxs.length === 2, 'expected both trans cues to be merged into the long main');
});

test('mergeSubtitles: fixes Sopranos-style off-by-one shift', () => {
  // Re-creates the bug seen on Sopranos S01E03: trans cues are shifted by ~2.5s
  // so the old greedy nearest-start-time matcher glued each trans cue to the
  // PRECEDING main cue. The new pipeline detects the global offset and lines
  // them back up.
  const main = [
    { id: '1', startTime: '00:01:50,243', endTime: '00:01:52,612', text: 'We found this truck on the side of the road.' },
    { id: '2', startTime: '00:01:52,612', endTime: '00:01:57,117', text: 'There might be some transmission trouble.' },
    { id: '3', startTime: '00:01:57,250', endTime: '00:01:59,252', text: "What's goin' on here? That's the truck." },
    { id: '4', startTime: '00:01:59,752', endTime: '00:02:02,755', text: 'The one stolen in newark?' },
    { id: '5', startTime: '00:02:04,257', endTime: '00:02:07,260', text: "It's a gift from tony soprano." },
    { id: '6', startTime: '00:02:10,763', endTime: '00:02:13,766', text: "Let's call the cops." },
    { id: '7', startTime: '00:02:14,017', endTime: '00:02:17,520', text: "I don't fuckin' believe it." },
    { id: '8', startTime: '00:02:17,520', endTime: '00:02:19,522', text: 'Listen, you fuck.' }
  ];
  // Translation track shifted later by 2.5s
  const trans = [
    { id: '1', startTime: '00:01:52,743', endTime: '00:01:55,112', text: 'Bu kamyonu yolun kenarinda bulduk.' },
    { id: '2', startTime: '00:01:55,112', endTime: '00:01:59,617', text: 'Viteste sorun olabilir.' },
    { id: '3', startTime: '00:01:59,750', endTime: '00:02:01,752', text: "Burada neler oluyor? O bizim kamyonumuz." },
    { id: '4', startTime: '00:02:02,252', endTime: '00:02:05,255', text: 'Newarkta calinan mi?' },
    { id: '5', startTime: '00:02:06,757', endTime: '00:02:09,760', text: 'Tony Sopranonun hediyesi.' },
    { id: '6', startTime: '00:02:13,263', endTime: '00:02:16,266', text: 'Polisi arayalim.' },
    { id: '7', startTime: '00:02:16,517', endTime: '00:02:20,020', text: 'Inanamiyorum.' },
    { id: '8', startTime: '00:02:20,020', endTime: '00:02:22,022', text: 'Dinle gerizekali.' }
  ];

  const merged = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'tur' });

  function transFor(text) {
    const row = merged.find(m => m.text.includes(text));
    return row ? row.text : null;
  }
  assert.ok(transFor('We found this truck').includes('Bu kamyonu yolun kenarinda bulduk.'));
  assert.ok(transFor('transmission trouble').includes('Viteste sorun olabilir.'));
  assert.ok(transFor('stolen in newark').includes('Newarkta calinan mi'));
  assert.ok(transFor('gift from tony soprano').includes('Tony Sopranonun hediyesi.'));
  assert.ok(transFor("Let's call the cops").includes('Polisi arayalim.'));

  // No translation should appear under more than one main line.
  const transTexts = [
    'Bu kamyonu yolun kenarinda bulduk.',
    'Viteste sorun olabilir.',
    'Newarkta calinan mi',
    'Tony Sopranonun hediyesi.',
    'Polisi arayalim.'
  ];
  for (const t of transTexts) {
    const occurrences = merged.filter(m => m.text.includes(t)).length;
    assert.strictEqual(occurrences, 1, `"${t}" should appear in exactly one merged cue, got ${occurrences}`);
  }
});

test('mergeSubtitles: sequence offset keeps dense shifted tracks on the same cue', () => {
  const main = [];
  const trans = [];
  for (let i = 0; i < 12; i++) {
    const start = 10000 + i * 2500;
    const end = start + 1600;
    main.push({
      id: String(i + 1),
      startTime: msToSrtTime(start),
      endTime: msToSrtTime(end),
      text: `primary-${i + 1}`
    });
    trans.push({
      id: String(i + 1),
      startTime: msToSrtTime(start - 4000),
      endTime: msToSrtTime(end - 4000),
      text: `secondary-${i + 1}`
    });
  }

  const merged = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'ara' });
  assert.ok(merged[5].text.includes('primary-6'));
  assert.ok(merged[5].text.includes('secondary-6'), 'translation should stay on the same cue after sequence offset');
});

test('mergeSubtitles: secondary timing source uses matched secondary cue times', () => {
  const main = [
    { id: '1', startTime: '00:00:10,000', endTime: '00:00:12,000', text: 'primary' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:06,000', endTime: '00:00:08,000', text: 'secondary' }
  ];
  const merged = mergeSubtitles(main, trans, {
    mainLang: 'eng',
    transLang: 'ara',
    timingSource: 'secondary',
    matchThresholdMs: 5000
  });
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startTime, '00:00:06,000');
  assert.strictEqual(merged[0].endTime, '00:00:08,000');
  assert.ok(merged[0].text.includes('primary'));
  assert.ok(merged[0].text.includes('secondary'));
});

test('mergeSubtitles: primary timing remains the default timing source', () => {
  const main = [
    { id: '1', startTime: '00:00:10,000', endTime: '00:00:12,000', text: 'primary' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:10,000', endTime: '00:00:12,000', text: 'secondary' }
  ];
  const merged = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'ara' });
  assert.strictEqual(merged[0].startTime, '00:00:10,000');
  assert.strictEqual(merged.alignment.timingSource, 'primary');
});

test('mergeSubtitles: never duplicates a trans cue across mains', () => {
  // Two adjacent main cues, only one trans cue around them — old algorithm
  // would assign that trans cue to BOTH mains. The new one assigns once.
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:02,000', text: 'one' },
    { id: '2', startTime: '00:00:02,200', endTime: '00:00:03,200', text: 'two' }
  ];
  const trans = [
    { id: '1', startTime: '00:00:01,100', endTime: '00:00:02,100', text: 'tek-trans' }
  ];
  const merged = mergeSubtitles(main, trans, { mainLang: 'eng', transLang: 'tur' });
  const occurrences = merged.filter(m => m.text.includes('tek-trans')).length;
  assert.strictEqual(occurrences, 1);
});

test('mergeSubtitles: emits all main cues even when trans is empty', () => {
  const main = [
    { id: '1', startTime: '00:00:01,000', endTime: '00:00:02,000', text: 'alone' }
  ];
  const merged = mergeSubtitles(main, [], { mainLang: 'eng', transLang: 'tur' });
  assert.strictEqual(merged.length, 1);
  assert.ok(merged[0].text.includes('<b>alone</b>'));
});

// ============================================================================
// sourceSelection — pair generation
// ============================================================================
console.log('\n--- sourceSelection ---');

const {
  filterByLanguage,
  rankCandidatesForLanguage,
  generateCandidatePairs
} = require('./lib/sourceSelection');

test('filterByLanguage: filters by exact lang code', () => {
  // OpenSubtitles v3 always uses 3-letter ISO codes here, so we don't
  // need fuzzy alias matching across 2/3-letter codes — but we still
  // honor whatever getLanguageAliases produces.
  const subs = [
    { id: '1', lang: 'eng', g: '1' },
    { id: '2', lang: 'tur', g: '1' },
    { id: '3', lang: 'eng', g: '2' }
  ];
  const eng = filterByLanguage(subs, 'eng');
  assert.strictEqual(eng.length, 2);
  assert.deepStrictEqual(eng.map(s => s.id).sort(), ['1', '3']);
});

test('rankCandidatesForLanguage: stable order, prefers UTF-8', () => {
  const subs = [
    { id: 'a', lang: 'eng', g: '1', SubEncoding: 'CP1254', m: 'i' },
    { id: 'b', lang: 'eng', g: '1', SubEncoding: 'UTF-8', m: 'i' },
    { id: 'c', lang: 'eng', g: '2', SubEncoding: 'ASCII', m: 'i' }
  ];
  const ranked = rankCandidatesForLanguage(subs, 'eng');
  assert.strictEqual(ranked[0].id, 'b', 'UTF-8 should outrank others');
});

test('generateCandidatePairs: prefers same-`g` over zipped fallback (Sopranos pattern)', () => {
  // Mirrors the real Sopranos S01E03 response: ENG only has g=7, TUR has
  // g=1 (first by API ranking) and g=7 (second). Old picker grabbed
  // ENG[0]+TUR[0] = different releases. New picker must produce the
  // same-`g` pair as the head of the list.
  const subs = [
    { id: 'eng-7-A', lang: 'eng', g: '7' },
    { id: 'tur-1',   lang: 'tur', g: '1' },
    { id: 'tur-7',   lang: 'tur', g: '7' }
  ];
  const pairs = generateCandidatePairs(subs, 'eng', 'tur');
  assert.ok(pairs.length >= 1);
  assert.strictEqual(pairs[0].main.id, 'eng-7-A');
  assert.strictEqual(pairs[0].trans.id, 'tur-7');
  assert.strictEqual(pairs[0].sameGroup, true);
  assert.strictEqual(pairs[0].source, 'group');
});

test('generateCandidatePairs: falls back to zipped order when no `g` overlap', () => {
  const subs = [
    { id: 'eng-1', lang: 'eng', g: '1' },
    { id: 'tur-2', lang: 'tur', g: '2' }
  ];
  const pairs = generateCandidatePairs(subs, 'eng', 'tur');
  assert.ok(pairs.length >= 1);
  assert.strictEqual(pairs[0].main.id, 'eng-1');
  assert.strictEqual(pairs[0].trans.id, 'tur-2');
  assert.strictEqual(pairs[0].sameGroup, false);
  assert.strictEqual(pairs[0].source, 'fallback');
});

test('generateCandidatePairs: respects maxPairs cap and returns at most that many', () => {
  const subs = [];
  for (let i = 0; i < 6; i++) subs.push({ id: `e${i}`, lang: 'eng', g: String(i) });
  for (let i = 0; i < 6; i++) subs.push({ id: `t${i}`, lang: 'tur', g: String(i) });
  const pairs = generateCandidatePairs(subs, 'eng', 'tur', { maxPairs: 3 });
  assert.strictEqual(pairs.length, 3);
});

test('generateCandidatePairs: emits no pairs when one language is missing', () => {
  const subs = [{ id: 'eng-1', lang: 'eng', g: '1' }];
  const pairs = generateCandidatePairs(subs, 'eng', 'tur');
  assert.strictEqual(pairs.length, 0);
});

test('generateCandidatePairs: top ranked main with same-`g` peer wins over higher-ranked main without one', () => {
  // ENG[0] is best ranked but has no TUR peer at g=99. ENG[1] has a TUR
  // peer at g=7. We want the same-group pair to lead.
  const subs = [
    { id: 'eng-99', lang: 'eng', g: '99' },
    { id: 'eng-7',  lang: 'eng', g: '7'  },
    { id: 'tur-7',  lang: 'tur', g: '7'  }
  ];
  const pairs = generateCandidatePairs(subs, 'eng', 'tur');
  assert.strictEqual(pairs[0].main.id, 'eng-7');
  assert.strictEqual(pairs[0].trans.id, 'tur-7');
  assert.strictEqual(pairs[0].sameGroup, true);
});

const {
  _internal: {
    tokenizeRelease,
    tokenJaccard,
    tokenRecall,
    subReleaseTokens
  }
} = require('./lib/sourceSelection');

test('tokenizeRelease: drops extension and short noise', () => {
  assert.deepStrictEqual(
    tokenizeRelease('Movie.2020.1080p.WEB-DL.YTS.srt'),
    ['movie', '2020', '1080p', 'web', 'dl', 'yts']
  );
  assert.deepStrictEqual(tokenizeRelease(''), []);
});

test('tokenJaccard: intersection over union', () => {
  assert.strictEqual(
    tokenJaccard(['a', 'b', 'c'], ['b', 'c', 'd']),
    2 / 4
  );
  assert.strictEqual(tokenJaccard([], ['a']), 0);
});

test('tokenRecall: fraction of user tokens hit by candidate tokens', () => {
  assert.strictEqual(tokenRecall(['a', 'b'], ['a', 'b', 'c']), 1);
  assert.strictEqual(tokenRecall(['a', 'b'], ['a']), 0.5);
  assert.strictEqual(tokenRecall([], ['a']), 0);
});

test('subReleaseTokens: pulls from _release, _fileName, and URL', () => {
  const tokens = subReleaseTokens({
    _release: 'Movie 2020 1080p WEB-DL',
    _fileName: 'movie.2020.srt',
    url: 'https://example.com/x/Movie.2020.WEB-DL.srt'
  });
  assert.ok(tokens.includes('movie'));
  assert.ok(tokens.includes('2020'));
  assert.ok(tokens.includes('1080p'));
  assert.ok(tokens.includes('web'));
  assert.ok(tokens.includes('dl'));
});

test('rankCandidatesForLanguage: hash-match (m !== "i") outranks plain results', () => {
  // a) imdb-only match, utf8     → 0 + 5 = 5
  // b) hash match, no encoding   → 50      = 50  ← winner
  // Even though (a) has the encoding bonus, the hash boost dwarfs it.
  const subs = [
    { id: 'a', lang: 'eng', g: '1', SubEncoding: 'UTF-8', m: 'i' },
    { id: 'b', lang: 'eng', g: '2', SubEncoding: 'UTF-8', m: 'h' }
  ];
  const ranked = rankCandidatesForLanguage(subs, 'eng');
  assert.strictEqual(ranked[0].id, 'b');
});

test('rankCandidatesForLanguage: filename overlap boosts matching candidate', () => {
  // (a) has no release info; (b)'s _release shares tokens with the user
  // filename. (b) should move to the top even though (a) is listed first.
  const subs = [
    { id: 'a', lang: 'eng', g: '1', SubEncoding: 'UTF-8', m: 'i' },
    {
      id: 'b',
      lang: 'eng',
      g: '2',
      SubEncoding: 'UTF-8',
      m: 'i',
      _release: 'Movie.2020.1080p.WEB-DL.YTS'
    }
  ];
  const ranked = rankCandidatesForLanguage(subs, 'eng', {
    videoParams: { filename: 'Movie.2020.1080p.WEB-DL.YTS.mkv' }
  });
  assert.strictEqual(ranked[0].id, 'b');
});

test('rankCandidatesForLanguage: no filename → existing encoding ranking holds', () => {
  // Sanity check that adding the new signals didn't regress old ordering.
  const subs = [
    { id: 'a', lang: 'eng', g: '1', SubEncoding: 'CP1254', m: 'i' },
    { id: 'b', lang: 'eng', g: '1', SubEncoding: 'UTF-8',  m: 'i' }
  ];
  const ranked = rankCandidatesForLanguage(subs, 'eng');
  assert.strictEqual(ranked[0].id, 'b');
});

test('generateCandidatePairs: cross-source same-release pair detected by token overlap', () => {
  // ENG sub from OpenSubtitles (g='os-7'), TUR sub from Wyzie (g='movie.2020.web.dl').
  // Their `g` keys don't match, but both have release tokens that overlap.
  // We expect a `cross-release` pair, not just a zipped fallback.
  const subs = [
    {
      id: 'eng-os',
      lang: 'eng',
      g: 'os-7',
      _release: 'Movie.2020.1080p.WEB-DL'
    },
    {
      id: 'tur-wyzie',
      lang: 'tur',
      g: 'movie.2020.1080p.web.dl',
      _release: 'Movie.2020.1080p.WEB-DL.Podnapisi'
    }
  ];
  const pairs = generateCandidatePairs(subs, 'eng', 'tur');
  assert.ok(pairs.length >= 1);
  const crossPair = pairs.find(p => p.source === 'cross-release');
  assert.ok(crossPair, 'should produce at least one cross-release pair');
  assert.strictEqual(crossPair.main.id, 'eng-os');
  assert.strictEqual(crossPair.trans.id, 'tur-wyzie');
});

test('generateCandidatePairs: strict same-`g` still wins over cross-release', () => {
  // Make sure the cross-release queue doesn't accidentally outrank the
  // strict-`g` queue when both exist.
  const subs = [
    { id: 'eng-7',  lang: 'eng', g: '7' },
    { id: 'tur-7',  lang: 'tur', g: '7' },
    {
      id: 'eng-cross',
      lang: 'eng',
      g: 'os-9',
      _release: 'Movie.2020.1080p.WEB-DL'
    },
    {
      id: 'tur-cross',
      lang: 'tur',
      g: 'wy-9',
      _release: 'Movie.2020.1080p.WEB-DL.Podnapisi'
    }
  ];
  const pairs = generateCandidatePairs(subs, 'eng', 'tur');
  assert.strictEqual(pairs[0].source, 'group');
  assert.strictEqual(pairs[0].main.id, 'eng-7');
  assert.strictEqual(pairs[0].trans.id, 'tur-7');
});

// ============================================================================
// syncEngine — sliding-window local offsets
// ============================================================================
console.log('\n--- syncEngine.estimateLocalOffsets ---');

const {
  estimateLocalOffsets,
  applyLocalOffsets
} = require('./lib/syncEngine');

// Build a non-periodic dialogue pattern so cross-correlation can't lock
// onto a self-similarity peak. We use an LCG-based pseudo-random spacing,
// reproducible across runs without depending on Math.random.
function buildDialogueTrack(count, startMs = 1000, seed = 42) {
  let s = seed;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const cues = [];
  let t = startMs;
  for (let i = 0; i < count; i++) {
    const dur = 1500 + Math.floor(rng() * 2500);   // 1.5–4.0s cues
    const gap = 500 + Math.floor(rng() * 6000);    // 0.5–6.5s gaps
    cues.push({ id: String(i + 1), startMs: t, endMs: t + dur, text: `c${i}` });
    t += dur + gap;
  }
  return cues;
}

test('estimateLocalOffsets: detects piecewise drift across windows', () => {
  // First half: trans is +1500ms; second half: trans is -2500ms. We turn
  // off the global offset stage by feeding a dataset where each segment
  // averages to its own local offset; the test is just that the sliding
  // window finds segment-specific anchors.
  const main = buildDialogueTrack(60);
  const split = main.length / 2;
  const trans = main.map((c, i) => {
    const o = i < split ? 1500 : -2500;
    return { ...c, startMs: c.startMs + o, endMs: c.endMs + o };
  });
  const anchors = estimateLocalOffsets(main, trans, {
    windowMs: 60000, stepMs: 30000, minCuesPerWindow: 4, maxLocalOffsetMs: 5000
  });
  assert.ok(anchors.length >= 3, `expected several anchors, got ${anchors.length}`);
  // We don't pin exact offsets (cross-correlation has step granularity),
  // but we expect early anchors to lean positive (trans is delayed) and
  // late anchors to lean negative (trans is early). estimateOffsetMs
  // returns the shift applied TO trans, so positive = shift later.
  const half = main[main.length - 1].startMs / 2;
  const early = anchors.filter(a => a.centerMs < half);
  const late = anchors.filter(a => a.centerMs > half);
  assert.ok(early.length > 0 && late.length > 0);
  const earlyMean = early.reduce((s, a) => s + a.offsetMs, 0) / early.length;
  const lateMean = late.reduce((s, a) => s + a.offsetMs, 0) / late.length;
  assert.ok(
    earlyMean < lateMean,
    `early anchors should differ from late ones; got early=${earlyMean} late=${lateMean}`
  );
});

test('estimateLocalOffsets: returns empty list with too-short tracks', () => {
  const anchors = estimateLocalOffsets([], []);
  assert.deepStrictEqual(anchors, []);
});

test('applyLocalOffsets: piecewise-linear interpolation between anchors', () => {
  const subs = [
    { startMs: 0,     endMs: 1000 },
    { startMs: 60000, endMs: 61000 },
    { startMs: 120000,endMs: 121000 }
  ];
  const anchors = [
    { centerMs: 0,      offsetMs: 0 },
    { centerMs: 120000, offsetMs: 1000 }
  ];
  const out = applyLocalOffsets(subs, anchors);
  assert.strictEqual(out[0].startMs, 0,       'first anchor end held');
  assert.strictEqual(out[1].startMs, 60500,   'midpoint interpolated');
  assert.strictEqual(out[2].startMs, 121000,  'second anchor end held');
});

test('alignAndMatch: piecewise-drifted track matches better with local offsets enabled', () => {
  // Build a non-periodic dialogue pattern with two segments that have
  // different local offsets. Local-offsets-on must beat local-offsets-off
  // when global offset is disabled (so we measure only the local stage).
  const main = buildDialogueTrack(80);
  const split = main.length / 2;
  const trans = main.map((c, i) => {
    const o = i < split ? 1500 : -2500;
    return { ...c, startMs: c.startMs + o, endMs: c.endMs + o };
  });
  const withLocal = alignAndMatch(main, trans, {
    matchThreshold: 1500, enableLocalOffsets: true,
    enableOffset: false, enableDrift: false
  });
  const withoutLocal = alignAndMatch(main, trans, {
    matchThreshold: 1500, enableLocalOffsets: false,
    enableOffset: false, enableDrift: false
  });
  assert.ok(
    withLocal.matchRate > withoutLocal.matchRate + 0.1,
    `expected local-offset path to outperform by >10pp; got ${withLocal.matchRate.toFixed(3)} vs ${withoutLocal.matchRate.toFixed(3)}`
  );
});

// ============================================================================
// subtitleSources - source registry and optional adapters
// ============================================================================
console.log('\n--- subtitleSources ---');

const {
  SUBTITLE_SOURCES,
  DEFAULT_WYZIE_SOURCES,
  getEnabledSubtitleSources,
  getSubtitleSourceSummary,
  buildOpenSubtitlesStreamUrl,
  buildWyzieSearchUrl,
  _internal: {
    normalizeWyzieSubtitle,
    toOpenSubtitlesLanguageCode,
    releaseToGroupKey
  }
} = require('./lib/subtitleSources');

test('subtitleSources: registers requested source candidates', () => {
  const ids = SUBTITLE_SOURCES.map(source => source.id);
  for (const id of [
    'opensubtitles',
    'jimaku',
    'subdl',
    'addic7ed',
    'tvsubtitles',
    'podnapisi',
    'yify-yts',
    'downsub',
    'amara',
    'subtitlecat',
    'subtitlebot'
  ]) {
    assert.ok(ids.includes(id), `${id} should be registered`);
  }
});

test('subtitleSources: default sources are enabled without optional keys', () => {
  const enabled = getEnabledSubtitleSources({});
  const enabledIds = enabled.map(source => source.id);
  // opensubtitles and jimaku are both enabled by default.
  // jimaku returns [] quickly when no anime context is provided, so it's safe to leave on.
  assert.ok(enabledIds.includes('opensubtitles'), 'opensubtitles should be enabled by default');
  assert.ok(enabledIds.includes('jimaku'), 'jimaku should be enabled by default for anime support');

  const summary = getSubtitleSourceSummary({});
  assert.strictEqual(summary.find(source => source.id === 'opensubtitles').enabled, true);
  assert.strictEqual(summary.find(source => source.id === 'wyzie').enabled, false);
  assert.strictEqual(summary.find(source => source.id === 'subdl').enabled, false);
  assert.strictEqual(summary.find(source => source.id === 'downsub').enabled, false);
});

test('buildOpenSubtitlesStreamUrl: preserves existing Stremio v3 URL shape', () => {
  const url = buildOpenSubtitlesStreamUrl({
    imdbId: 'tt1234567',
    type: 'series',
    season: 2,
    episode: 5,
    videoParams: {
      filename: 'Example Release.mkv',
      videoHash: 'abc123',
      videoSize: '999'
    }
  });

  assert.strictEqual(
    url,
    'https://opensubtitles-v3.strem.io/subtitles/series/tt1234567:2:5/filename=Example%20Release.mkv&videoSize=999&videoHash=abc123.json'
  );
});

test('buildWyzieSearchUrl: builds optional IMDb search with language and file hints', () => {
  const url = buildWyzieSearchUrl({
    imdbId: '7654321',
    type: 'series',
    season: 1,
    episode: 3,
    languages: ['eng', 'tur'],
    videoParams: { filename: 'Show.S01E03.WEB-DL.mkv' },
    env: { WYZIE_API_KEY: 'wyzie-test-key' }
  });
  const parsed = new URL(url);

  assert.strictEqual(`${parsed.origin}${parsed.pathname}`, 'https://sub.wyzie.io/search');
  assert.strictEqual(parsed.searchParams.get('id'), 'tt7654321');
  assert.strictEqual(parsed.searchParams.get('season'), '1');
  assert.strictEqual(parsed.searchParams.get('episode'), '3');
  assert.strictEqual(parsed.searchParams.get('language'), 'en,tr');
  assert.strictEqual(parsed.searchParams.get('format'), 'srt');
  assert.strictEqual(parsed.searchParams.get('source'), DEFAULT_WYZIE_SOURCES);
  assert.strictEqual(parsed.searchParams.get('file'), 'Show.S01E03.WEB-DL.mkv');
  assert.strictEqual(parsed.searchParams.get('key'), 'wyzie-test-key');
});

test('normalizeWyzieSubtitle: maps Wyzie rows into matcher-compatible subtitles', () => {
  const sub = normalizeWyzieSubtitle({
    id: '1955024019',
    url: 'https://sub.wyzie.io/c/example/id/1955024019?format=srt',
    encoding: 'UTF-8',
    language: 'en',
    source: 'podnapisi',
    release: 'Example.Show.S01E03.1080p.WEB-DL',
    downloadCount: 42,
    fileName: 'example.show.s01e03.srt'
  });

  assert.strictEqual(sub.id, 'wyzie-podnapisi-1955024019');
  assert.strictEqual(sub.lang, 'eng');
  assert.strictEqual(sub.g, 'example.show.s01e03.1080p.web.dl');
  assert.strictEqual(sub.downloads, 42);
  assert.strictEqual(sub._sourceId, 'wyzie');
  assert.strictEqual(sub._providerId, 'podnapisi');
});

test('subtitleSources helpers: normalize language and release keys', () => {
  assert.strictEqual(toOpenSubtitlesLanguageCode('tr'), 'tur');
  assert.strictEqual(toOpenSubtitlesLanguageCode('pt-BR'), 'pob');
  assert.strictEqual(releaseToGroupKey('Movie 2020 1080p WEB-DL'), 'movie.2020.1080p.web.dl');
});

// ============================================================================
// subtitle content filters (forced / SDH / ASS / music)
// ============================================================================
console.log('\n--- subtitle content filters ---');

test('isLikelyForcedUrl: detects .forced. in filename', () => {
  assert.strictEqual(
    isLikelyForcedUrl('https://example.com/Movie.2020.eng.forced.srt'),
    true
  );
  assert.strictEqual(
    isLikelyForcedUrl('https://example.com/forced/eng.srt.gz'),
    true
  );
  assert.strictEqual(
    isLikelyForcedUrl('https://example.com/path/Movie.eng.srt'),
    false
  );
  assert.strictEqual(isLikelyForcedUrl(''), false);
  assert.strictEqual(isLikelyForcedUrl(null), false);
});

test('isPureSdhCueText: only drops square-bracketed sound descriptions', () => {
  assert.strictEqual(isPureSdhCueText('[door slams]'), true);
  assert.strictEqual(isPureSdhCueText('[ENGINE REVVING]'), true);
  assert.strictEqual(isPureSdhCueText('[music]\n[crowd noise]'), true);
  assert.strictEqual(isPureSdhCueText('Real dialogue'), false);
  assert.strictEqual(isPureSdhCueText('[whisper] Come here'), false);
  // Parenthetical asides are ambiguous with whispered dialogue — keep them.
  assert.strictEqual(isPureSdhCueText("(don't tell anyone)"), false);
  assert.strictEqual(isPureSdhCueText(''), false);
});

test('stripAssOverrideTags: removes inline {\\...} blocks', () => {
  assert.strictEqual(
    stripAssOverrideTags('{\\an8}top text'),
    'top text'
  );
  assert.strictEqual(
    stripAssOverrideTags('{\\pos(100,200)}{\\fad(0,200)}Hello'),
    'Hello'
  );
  assert.strictEqual(stripAssOverrideTags('No tags here'), 'No tags here');
});

test('stripMusicMarkers: removes ♪/♫ but keeps the lyrics', () => {
  assert.strictEqual(
    stripMusicMarkers('♪ Yesterday all my troubles ♪'),
    ' Yesterday all my troubles '
  );
  assert.strictEqual(stripMusicMarkers('Plain text'), 'Plain text');
});

test('cleanSubtitleText: strips ASS overrides and music markers end-to-end', () => {
  assert.strictEqual(
    cleanSubtitleText('{\\an8}♪ La la la ♪', 'eng').trim(),
    'La la la'
  );
});

// ============================================================================
// textFeatures
// ============================================================================
console.log('\n--- textFeatures ---');

const {
  extractCueFeatures,
  buildFeatureArray,
  textSimilarity,
  digitSimilarity,
  digitsContradict,
  punctSimilarity,
  lengthRatioFit,
  isHighConfidenceTextMatch
} = require('./lib/textFeatures');

test('extractCueFeatures: pulls digit tokens, length, punctuation', () => {
  const f = extractCueFeatures('In 1985 we met at 3:00, right?');
  assert.deepStrictEqual(f.digits, ['1985', '3:00']);
  assert.strictEqual(f.punct.q, true);
  assert.strictEqual(f.punct.excl, false);
  assert.ok(f.len > 0);
});

test('extractCueFeatures: strips HTML, ASS overrides, and music notes', () => {
  const f = extractCueFeatures('<i>{\\an8}♪ Track 7 ♪</i>');
  assert.deepStrictEqual(f.digits, ['7']);
});

test('digitSimilarity: zero when either side has no digits', () => {
  const a = extractCueFeatures('hello world');
  const b = extractCueFeatures('1985 era');
  assert.strictEqual(digitSimilarity(a, b), 0);
});

test('digitSimilarity: Jaccard of digit token sets', () => {
  const a = extractCueFeatures('In 1985 and 1990 we met');
  const b = extractCueFeatures('1985 was the year');
  // sets: {1985, 1990} ∩ {1985} = 1; union = 2 → 0.5
  assert.strictEqual(digitSimilarity(a, b), 0.5);
});

test('digitsContradict: true only when both have digits and none overlap', () => {
  const a = extractCueFeatures('Apollo 13 launched');
  const b = extractCueFeatures('Apollo 11 a décollé');
  assert.strictEqual(digitsContradict(a, b), true);

  const c = extractCueFeatures('no digits here');
  // c has no digits → no contradiction signal
  assert.strictEqual(digitsContradict(a, c), false);
});

test('lengthRatioFit: ~1 for equal lengths, ~0 for 3× differences', () => {
  const a = extractCueFeatures('hello');
  const b = extractCueFeatures('world');
  assert.ok(lengthRatioFit(a, b) > 0.9);

  const c = extractCueFeatures('short');
  const d = extractCueFeatures('this is a much much longer line than the other');
  assert.ok(lengthRatioFit(c, d) < 0.3);
});

test('punctSimilarity: matches only on flags TRUE somewhere', () => {
  const a = extractCueFeatures('Really?');
  const b = extractCueFeatures('Gerçekten?');
  assert.strictEqual(punctSimilarity(a, b), 1);

  // Neither has any of the tracked punctuation flags — uninformative.
  const c = extractCueFeatures('hello');
  const d = extractCueFeatures('world');
  assert.strictEqual(punctSimilarity(c, d), 0);
});

test('isHighConfidenceTextMatch: triggers on shared digit token', () => {
  const a = extractCueFeatures('In 1985 we met');
  const b = extractCueFeatures('En 1985 nous nous sommes rencontrés');
  assert.strictEqual(isHighConfidenceTextMatch(a, b), true);

  const c = extractCueFeatures('No digits');
  assert.strictEqual(isHighConfidenceTextMatch(a, c), false);
});

test('textSimilarity: digit-driven score dominates length+punct soft signals', () => {
  // a/b agree on digit "1985" + same end punctuation → high score.
  // a/c have no digits but similar length+punct → moderate score.
  const a = extractCueFeatures('In 1985 we met?');
  const b = extractCueFeatures('1985 - did we?');
  const c = extractCueFeatures('Where are you?');
  assert.ok(textSimilarity(a, b) > textSimilarity(a, c));
});

test('buildFeatureArray: parallel to cue array, safe for cues without text', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'In 1985' },
    { startMs: 1000, endMs: 2000 },
    { startMs: 2000, endMs: 3000, text: '' }
  ];
  const feats = buildFeatureArray(cues);
  assert.strictEqual(feats.length, 3);
  assert.deepStrictEqual(feats[0].digits, ['1985']);
  assert.deepStrictEqual(feats[1].digits, []);
  assert.deepStrictEqual(feats[2].digits, []);
});

// ============================================================================
// syncEngine — text-feature-driven alignment
// ============================================================================
console.log('\n--- syncEngine.alignAndMatch (text features) ---');

const { alignAndMatch: alignAndMatchTxt } = require('./lib/syncEngine');

test('alignAndMatch: shared digit pairs win over a temporally-closer non-digit cue', () => {
  // Main cue "In 1985 we met." Two trans candidates overlap it heavily.
  // One has no digits; the other shares "1985". Text features should
  // pick the digit-sharing cue even though both timings are valid.
  const main = [
    { startMs: 5000, endMs: 7000, text: 'In 1985 we met.' }
  ];
  const trans = [
    { startMs: 4800, endMs: 6800, text: 'Nous nous rencontrions.' },
    { startMs: 5400, endMs: 7400, text: 'En 1985 nous nous sommes rencontrés.' }
  ];
  const result = alignAndMatchTxt(main, trans, { enableOffset: false, enableDrift: false, enableLocalOffsets: false });
  assert.ok(result.matches.has(0));
  const matched = result.matches.get(0);
  // Trans index 1 has the shared "1985"; we expect it to be the picked one.
  assert.ok(matched.includes(1));
});

test('alignAndMatch: digit contradiction blocks a timing-perfect pairing', () => {
  // Without text features, this would match perfectly (full overlap).
  // With text features, "Apollo 13" vs "Apollo 11" is rejected outright.
  const main = [
    { startMs: 5000, endMs: 7000, text: 'Apollo 13 launched.' }
  ];
  const trans = [
    { startMs: 5000, endMs: 7000, text: 'Apollo 11 a décollé.' }
  ];
  const result = alignAndMatchTxt(main, trans, {
    enableOffset: false, enableDrift: false, enableLocalOffsets: false
  });
  assert.strictEqual(result.matches.has(0), false);

  // Sanity check: with text features disabled, the same input DOES match,
  // proving the new rejection is what's making the difference.
  const baseline = alignAndMatchTxt(main, trans, {
    enableOffset: false, enableDrift: false, enableLocalOffsets: false,
    enableTextFeatures: false
  });
  assert.strictEqual(baseline.matches.has(0), true);
});

// ============================================================================
// Multi-sentence cue splitter
// ============================================================================
console.log('\n--- splitIntoSentences / splitMultiSentenceCues ---');

test('splitIntoSentences: splits English at clean . space-uppercase boundaries', () => {
  assert.deepStrictEqual(
    splitIntoSentences('I was eating. You were dirty.'),
    ['I was eating.', 'You were dirty.']
  );
});

test('splitIntoSentences: splits Arabic at ؟ boundaries', () => {
  const arabic = 'ألم يكن باستطاعتك فعل هذا قبل ساعة؟ كنت آكل وأنت مُتسخ.';
  assert.deepStrictEqual(
    splitIntoSentences(arabic),
    [
      'ألم يكن باستطاعتك فعل هذا قبل ساعة؟',
      'كنت آكل وأنت مُتسخ.'
    ]
  );
});

test('splitIntoSentences: stays whole for single-sentence text', () => {
  assert.deepStrictEqual(
    splitIntoSentences('A single sentence.'),
    ['A single sentence.']
  );
});

test('splitMultiSentenceCues: splits the screenshot Arabic cue', () => {
  const arabic = [{
    startMs: 60000,
    endMs: 64000,
    text: 'ألم يكن باستطاعتك فعل هذا قبل ساعة؟ كنت آكل وأنت مُتسخ.'
  }];
  const out = splitMultiSentenceCues(arabic);
  assert.strictEqual(out.length, 2);
  assert.ok(out[0].text.endsWith('؟'));
  assert.ok(out[1].text.endsWith('.'));
  // Timing is contiguous and bounded by the original cue.
  assert.strictEqual(out[0].startMs, 60000);
  assert.strictEqual(out[1].endMs, 64000);
  assert.ok(out[0].endMs > out[0].startMs);
  assert.ok(out[1].startMs >= out[0].endMs);
});

test('splitMultiSentenceCues: leaves short rapid-fire cues alone', () => {
  // 1.5s cue is below the duration floor; stays as one cue.
  const rapid = [{
    startMs: 0,
    endMs: 1500,
    text: 'Yes. No. Maybe so. Indeed.'
  }];
  const out = splitMultiSentenceCues(rapid);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, 'Yes. No. Maybe so. Indeed.');
});

test('splitMultiSentenceCues: refuses to split when an abbreviation creates a tiny segment', () => {
  // The candidate "segment" "Mr" is well under the 15-char floor, so we
  // refuse the whole split rather than producing a junk fragment.
  const cue = [{
    startMs: 0,
    endMs: 3000,
    text: 'He said hi. Mr. Smith left the room.'
  }];
  const out = splitMultiSentenceCues(cue);
  assert.strictEqual(out.length, 1);
});

test('splitMultiSentenceCues: distributes timing proportionally to segment length', () => {
  // First segment is 50% longer than the second — share of the time
  // budget should reflect that.
  const cue = [{
    startMs: 0,
    endMs: 5000,
    text: 'This is the longer first half here. Shorter second one.'
  }];
  const out = splitMultiSentenceCues(cue);
  assert.strictEqual(out.length, 2);
  const firstDur = out[0].endMs - out[0].startMs;
  const secondDur = out[1].endMs - out[1].startMs;
  assert.ok(firstDur > secondDur, 'longer segment should take longer slice');
});

test('alignAndMatch: Pass 2 wall stops absorption across a sentence terminator', () => {
  // Setup: ONE main cue that timing-wise overlaps TWO adjacent trans
  // cues — but the first trans cue ends a sentence. Without the wall,
  // Pass 1 picks one and Pass 2 absorbs the other, gluing them together.
  // With the wall, only the bipartite-best pair stays.
  const main = [
    { startMs: 0, endMs: 5000, text: 'I was eating, and you are dirty.' }
  ];
  const trans = [
    { startMs:    0, endMs: 2500, text: 'Could you not have done this before?' },
    { startMs: 2500, endMs: 5000, text: 'I was eating and you are dirty.' }
  ];
  const result = alignAndMatchTxt(main, trans, {
    enableOffset: false, enableDrift: false, enableLocalOffsets: false
  });
  const picked = result.matches.get(0) || [];
  // Only one trans cue should be matched — the bipartite-best one.
  // Without the wall this came out as [0, 1].
  assert.strictEqual(picked.length, 1, 'wall should stop multi-trans absorption across sentence end');
});

test('alignAndMatch: recovers from off-by-one shift via candidate-offset search', () => {
  // Rick-and-Morty failure mode: trans track is constantly shifted ~3s
  // late. Pure-overlap matching pairs every trans cue with the NEXT main
  // (one position too late). Signal correlator is too timid in dense
  // dialogue; sequence estimator catches it. Multi-candidate selection
  // applies the sequence offset and recovers the correct pairing.
  const SHIFT = 3000;
  const main = [];
  const trans = [];
  for (let i = 0; i < 12; i++) {
    const start = 10000 + i * 3000;
    main.push({ startMs: start, endMs: start + 2000, text: `Line ${i + 1}.` });
    trans.push({ startMs: start + SHIFT, endMs: start + SHIFT + 2000, text: `Reply ${i + 1}.` });
  }

  const result = alignAndMatchTxt(main, trans, {
    enableDrift: false,
    enableLocalOffsets: false
  });

  // Without recovery, each main would pair with the next trans (one off);
  // with recovery, main[i] pairs with trans[i].
  for (let i = 0; i < main.length; i++) {
    const picked = result.matches.get(i);
    assert.ok(picked && picked.length > 0, `main[${i}] should have a match`);
    assert.strictEqual(picked[0], i, `main[${i}] should pair with trans[${i}], got trans[${picked[0]}]`);
  }
  assert.ok(result.offsetMs !== 0, 'a non-zero offset should be applied');
});

test('alignAndMatch: leaves correctly-aligned tracks alone (no spurious offset)', () => {
  // Inverse safety check: with no shift between tracks, no offset should
  // be applied. Strict-`>` tie-break means `0` stays the winner.
  const main = [];
  const trans = [];
  for (let i = 0; i < 10; i++) {
    const start = 5000 + i * 2000;
    main.push({ startMs: start, endMs: start + 1500, text: `Line ${i + 1}.` });
    trans.push({ startMs: start, endMs: start + 1500, text: `Reply ${i + 1}.` });
  }
  const result = alignAndMatchTxt(main, trans, {
    enableDrift: false,
    enableLocalOffsets: false
  });
  assert.strictEqual(result.offsetMs, 0, 'no shift should be applied to aligned tracks');
});

test('sentenceShapeSignal: +1 both end, -1 mixed, 0 both mid-fragment', () => {
  const { sentenceShapeSignal, extractCueFeatures: extract } = require('./lib/textFeatures');
  const sentence = extract('A complete sentence.');
  const fragment = extract('a mid-fragment continuation');
  assert.strictEqual(sentenceShapeSignal(sentence, sentence), 1);
  assert.strictEqual(sentenceShapeSignal(sentence, fragment), -1);
  assert.strictEqual(sentenceShapeSignal(fragment, fragment), 0);
});

test('textSimilarity: penalizes endsSentence mismatch (rules out fragment misalignment)', () => {
  const { textSimilarity, extractCueFeatures: extract } = require('./lib/textFeatures');
  const sentenceMain = extract('Total waste of snakes.');
  const sentenceTrans = extract('Total waste of snakes.');  // same shape — both terminal
  const fragmentTrans = extract('If you want to take a beat');  // mid-fragment, no terminator
  // The shape-matching pair should score strictly higher than the
  // mid-fragment pair, even though all three are similar lengths.
  assert.ok(
    textSimilarity(sentenceMain, sentenceTrans) > textSimilarity(sentenceMain, fragmentTrans),
    'sentence-shape mismatch should drag the similarity score down'
  );
});

test('mergeSubtitles: split secondary cue is distributed across two main cues', () => {
  // The actual screenshot scenario: English file has two separate cues;
  // Arabic file has both sentences packed into one long cue. We expect
  // the splitter to produce two Arabic cues, and the bipartite matcher
  // to pair each with the corresponding English cue.
  const main = [
    { id: '1', startTime: '00:01:00,000', endTime: '00:01:02,000',
      text: 'Could you not have done this an hour ago?' },
    { id: '2', startTime: '00:01:02,000', endTime: '00:01:04,000',
      text: 'I was eating, and you are dirty.' }
  ];
  const trans = [
    { id: '1', startTime: '00:01:00,000', endTime: '00:01:04,000',
      text: 'ألم يكن باستطاعتك فعل هذا قبل ساعة؟ كنت آكل وأنت مُتسخ.' }
  ];
  const merged = mergeSubtitles(main, trans, {
    mainLang: 'eng', transLang: 'ara',
    enableOffset: false, enableDrift: false
  });

  assert.strictEqual(merged.length, 2);
  // First merged cue: English question + first Arabic sentence (ends with ؟).
  assert.ok(merged[0].text.includes('done this'));
  assert.ok(merged[0].text.includes('؟'));
  assert.ok(!merged[0].text.includes('مُتسخ'), 'first merged cue must not carry the second sentence');
  // Second merged cue: English statement + second Arabic sentence.
  assert.ok(merged[1].text.includes('I was eating'));
  assert.ok(merged[1].text.includes('مُتسخ'));
  assert.ok(!merged[1].text.includes('ساعة؟'), 'second merged cue must not carry the first sentence');
});

// ============================================================================
// ASS/SSA parser
// ============================================================================
console.log('\n--- normalizeAssToSrt / isAssFormat ---');

const ASS_SAMPLE = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Hello World
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Line two{\\fad(0,200)} text
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\pos(320,400)}Override stripped
`;

test('isAssFormat: detects ASS/SSA by Script Info header', () => {
  assert.strictEqual(isAssFormat(ASS_SAMPLE), true);
  assert.strictEqual(isAssFormat('1\n00:00:01,000 --> 00:00:03,000\nHello\n\n'), false);
  assert.strictEqual(isAssFormat('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHi\n'), false);
});

test('normalizeAssToSrt: converts ASS dialogue to SRT timestamps (centiseconds)', () => {
  const srt = normalizeAssToSrt(ASS_SAMPLE);
  // 0:00:01.00 → 00:00:01,000 ; 0:00:03.50 → 00:00:03,500
  assert.ok(srt.includes('00:00:01,000 --> 00:00:03,500'), `timing: ${srt.slice(0, 200)}`);
  assert.ok(srt.includes('00:00:04,000 --> 00:00:06,000'), 'second timing');
});

test('normalizeAssToSrt: strips ASS override tags from text', () => {
  const srt = normalizeAssToSrt(ASS_SAMPLE);
  assert.ok(!srt.includes('{\\'), 'override tags should be stripped');
  assert.ok(srt.includes('Hello World'), 'text should survive');
  assert.ok(srt.includes('Line two text'), 'override inside text should strip cleanly');
  assert.ok(srt.includes('Override stripped'), 'pos override should be stripped');
});

test('parseSrt: handles ASS input end-to-end', () => {
  const cues = parseSrt(ASS_SAMPLE);
  assert.ok(Array.isArray(cues) && cues.length >= 3, `expected 3+ cues, got ${cues ? cues.length : 'null'}`);
  assert.ok(cues[0].text.includes('Hello World'), `first cue text: ${cues[0].text}`);
});

// ============================================================================
// Kitsu ID parsing
// ============================================================================
console.log('\n--- parseKitsuId ---');

test('parseKitsuId: parses kitsu movie ID', () => {
  const r = parseKitsuId('kitsu:12345');
  assert.deepStrictEqual(r, { kitsuId: '12345', season: null, episode: null });
});

test('parseKitsuId: parses kitsu series ID with season+episode', () => {
  const r = parseKitsuId('kitsu:12345:1:5');
  assert.deepStrictEqual(r, { kitsuId: '12345', season: '1', episode: '5' });
});

test('parseKitsuId: returns null for IMDb IDs', () => {
  assert.strictEqual(parseKitsuId('tt1234567'), null);
  assert.strictEqual(parseKitsuId(null), null);
  assert.strictEqual(parseKitsuId(''), null);
});

// ============================================================================
// parseConfigParam (server.js)
// ============================================================================
console.log('\n--- parseConfigParam ---');

test('parseConfigParam: parses legacy two-field format', () => {
  const r = parseConfigParam(encodeURIComponent('English [eng]|Turkish [tur]'));
  assert.strictEqual(r.mainLang, 'English [eng]');
  assert.strictEqual(r.transLang, 'Turkish [tur]');
  assert.deepStrictEqual(r.envOverrides, {});
});

test('parseConfigParam: parses all API key fields', () => {
  const raw = encodeURIComponent('English [eng]|Turkish [tur]|wyzie=wk|subdl=sk|jimaku=jk|lt=http://localhost:5000|ltkey=lk');
  const r = parseConfigParam(raw);
  assert.strictEqual(r.mainLang, 'English [eng]');
  assert.deepStrictEqual(r.envOverrides, {
    WYZIE_API_KEY: 'wk',
    SUBDL_API_KEY: 'sk',
    JIMAKU_API_KEY: 'jk',
    LIBRETRANSLATE_URL: 'http://localhost:5000',
    LIBRETRANSLATE_API_KEY: 'lk'
  });
});

test('parseConfigParam: returns null for empty/invalid input', () => {
  assert.strictEqual(parseConfigParam(''), null);
  assert.strictEqual(parseConfigParam(null), null);
  assert.strictEqual(parseConfigParam(encodeURIComponent('onlyone')), null);
});

test('parseConfigParam: ignores unknown extra keys', () => {
  const raw = encodeURIComponent('English [eng]|Turkish [tur]|unknown=val');
  const r = parseConfigParam(raw);
  assert.deepStrictEqual(r.envOverrides, {});
});

test('manifest: includes kitsu in idPrefixes', () => {
  assert.ok(manifest.idPrefixes.includes('kitsu'), 'kitsu must be in idPrefixes for anime support');
  assert.ok(manifest.idPrefixes.includes('tt'), 'tt must still be in idPrefixes');
});

// ============================================================================
// RESULTS
// ============================================================================
console.log('\n========================================');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
