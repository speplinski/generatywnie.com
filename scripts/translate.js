#!/usr/bin/env node

// suppress Node 22+ punycode deprecation from SDK dependencies
process.removeAllListeners('warning');

/**
 * Translation generator for generatywnie.com
 *
 * Usage:
 *   node scripts/translate.js pl
 *   node scripts/translate.js pl --force
 *   node scripts/translate.js pl --model sonnet
 *   node scripts/translate.js pl --regen-glossary --force
 *   node scripts/translate.js pl de fr --force --model sonnet
 *
 * Requires ANTHROPIC_API_KEY in environment or .env file.
 *
 * Pipeline:
 *   Phase 0 — Load cached glossary or generate via API (saved to locales/glossary-{lang}.json)
 *   Phase 1a — Translate body per-key (plain text, section context, zero JSON risk)
 *   Phase 1b — Translate derived content as JSON batches (metadata, llms — glossary + full body)
 *   Phase 2 — Validate assembled translation (17 technical checks on whole object)
 *   Phase 3 — Retry failed keys with glossary context, re-validate (up to 2 retry rounds)
 *   Phase 4 — Semantic review with glossary adherence check
 *   Phase 5 — Apply semantic fixes per-key with section context + glossary (up to 3 rounds)
 *   Reorder keys to match source, save only fully validated translation
 *
 * On failure: file not saved → server falls back to English.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── config ──────────────────────────────────────────────

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const SOURCE_FILE = path.join(LOCALES_DIR, 'en.json');
const MAX_ROUNDS = 3;          // technical: 1 batch + up to 2 retry rounds
const MAX_SEMANTIC_ROUNDS = 3; // review + fix + re-review + fix + final verification

const MODELS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5-20250929'
};

const LANG_NAMES = {
  pl: 'Polish', de: 'German', fr: 'French', es: 'Spanish',
  pt: 'Portuguese', it: 'Italian', ja: 'Japanese', zh: 'Chinese (Simplified)',
  ko: 'Korean', uk: 'Ukrainian', cs: 'Czech', nl: 'Dutch',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', nb: 'Norwegian Bokmål',
  ro: 'Romanian', hu: 'Hungarian', tr: 'Turkish', ar: 'Arabic',
  hi: 'Hindi', ru: 'Russian'
};

// proper names — allowed to be grammatically declined in target language
// validator checks word-stems, not exact strings
const PROTECTED_NAMES = [
  'Szymon P. Pepliński',
  'Shoshana Zuboff',
  'Gilbert Simondon',
  'N. Katherine Hayles',
  'Byung-Chul Han',
  'Kyle Chayka',
  'Douglas Rushkoff',
  'James Williams',
  'Kasparov',
  'Tegmark'
];

// brand + book titles — must appear verbatim (no declension)
const PROTECTED_TITLES = [
  'Generatywnie',
  'The Age of Surveillance Capitalism',
  'Du mode d\'existence des objets techniques',
  'How We Became Posthuman'
];

// combined for prompt rules
const PROTECTED_STRINGS = [...PROTECTED_NAMES, ...PROTECTED_TITLES];

// CJK languages produce much shorter text (kanji/kana are denser than Latin).
// Relax length validation thresholds for these.
const CJK_LANGS = new Set(['ja', 'zh', 'ko', 'zh-TW', 'zh-CN', 'zh-HK']);

const ALLOWED_TAGS = ['strong', 'cite', 'em'];
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

const DANGEROUS_PATTERNS = [
  [/javascript\s*:/gi, 'javascript: URI'],
  [/on[a-z]+\s*=/gi, 'inline event handler'],
  [/<script/gi, '<script> tag'],
  [/<\/script/gi, '</script> tag'],
  [/<iframe/gi, '<iframe> tag'],
  [/<object/gi, '<object> tag'],
  [/<embed/gi, '<embed> tag'],
  [/<link[\s>]/gi, '<link> tag'],
  [/<meta[\s>]/gi, '<meta> tag'],
  [/<svg[\s>]/gi, '<svg> tag'],
  [/<form[\s>]/gi, '<form> tag'],
  [/<input[\s>]/gi, '<input> tag'],
  [/<img[\s>]/gi, '<img> tag'],
  [/data\s*:\s*text\/html/gi, 'data:text/html URI'],
  [/expression\s*\(/gi, 'CSS expression()'],
  [/url\s*\(\s*['"]?\s*javascript/gi, 'CSS url(javascript:)'],
  [/<!--/g, 'HTML comment'],
];

// unicode: zero-width and control chars that could hide payloads
const UNICODE_SUSPICIOUS = /[\u200B\u200C\u200D\uFEFF\u00AD\u2028\u2029\u202A-\u202E\u2066-\u2069\u061C]/g;

// HTML entities that could decode to dangerous content
const ENCODED_TAG_RE = /&lt;\s*\/?\s*(script|iframe|svg|object|embed|form|img|input|link|meta)/gi;

// ── semantic batches ────────────────────────────────────
//    grouped by content section for natural context

// Body sections — translated first, sequentially, with context accumulation
const BATCHES_BODY = [
  {
    name: 'header+s01',
    keys: [
      'header.subtitle', 'header.title',
      's01.title', 's01.p1', 's01.p2', 's01.blockquote'
    ],
    context: 'Main header and opening section. Critical theory manifesto arguing that the feedback loop is a political form. References Zuboff, Han, Chayka.'
  },
  {
    name: 's02',
    keys: ['s02.title', 's02.p1', 's02.p2', 's02.p3'],
    context: 'Section about divergence vs variation in generative systems. Key thesis: "Variation is an economy. Divergence is an ontology."'
  },
  {
    name: 's03',
    keys: ['s03.title', 's03.p1', 's03.p2', 's03.p3'],
    context: 'Section about metastability, initial conditions, and distributed agency. References Simondon, Hayles, Kasparov, Tegmark.'
  },
  {
    name: 's04',
    keys: ['s04.title', 's04.p1', 's04.p2', 's04.p3', 's04.p4'],
    context: 'Section about the refusal of memory, operational amnesia, and politics of data extraction. References Rushkoff and Williams.'
  },
  {
    name: 's05',
    keys: ['s05.title', 's05.p1', 's05.p2', 's05.p3'],
    context: 'Section about phenomenology of presence — the body in generative systems, embodied experience of irreversibility.'
  },
  {
    name: 's06',
    keys: ['s06.title', 's06.p1', 's06.p2', 's06.blockquote', 's06.p3'],
    context: 'Closing section — the negative condition: irreversibility, openness, and evidence of presence.'
  }
];

// Derived content — translated after body, with full body as context
const BATCHES_DERIVED = [
  {
    name: 'meta',
    keys: [
      'page.title', 'page.description', 'page.keywords',
      'og.title', 'og.description', 'og.site_name',
      'article.section',
      'twitter.title', 'twitter.description'
    ],
    context: 'Website metadata — page titles, descriptions, social media tags. Must use the same terminology as the body translation.'
  },
  {
    name: 'jsonld',
    keys: ['jsonld.headline', 'jsonld.description'],
    context: 'JSON-LD structured data for search engines. Must use the same terminology as the body translation.'
  },
  {
    name: 'arrays',
    keys: ['article.tags', 'jsonld.keywords'],
    context: 'Tag and keyword arrays for SEO. Use the same translated terms as in the body.'
  },
  {
    name: 'llms',
    keys: [
      'llms.overview', 'llms.thesis1', 'llms.thesis2', 'llms.thesis3',
      'llms.thesis4', 'llms.thesis5', 'llms.thesis6',
      'llms.concepts', 'llms.relevance'
    ],
    context: 'LLM-optimized summaries for AI search engines. Contains markdown formatting (**, -, \\n) that MUST be preserved verbatim. Use the same translated terms as in the body.'
  }
];

// All batches combined (used by findBatch, fixSemanticKey, etc.)
const BATCHES = [...BATCHES_BODY, ...BATCHES_DERIVED];

// ── .env loader ─────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.substring(0, eq).trim();
    let val = trimmed.substring(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── logging ─────────────────────────────────────────────

function writeLog(lang, log) {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(LOGS_DIR, `translate-${lang}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(log, null, 2) + '\n', 'utf8');
  console.log(`  Log: ${file}`);
}

// ── validation (17 checks) ─────────────────────────────

function countTag(str, tag) {
  const open = (str.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')) || []).length;
  const close = (str.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  return { open, close };
}

function validate(translated, source, targetLang) {
  const errors = [];
  const warnings = [];
  const sourceKeys = Object.keys(source);

  // 1. missing keys
  const missing = sourceKeys.filter(k => !(k in translated));
  if (missing.length > 0) {
    errors.push(`Missing keys: ${missing.join(', ')}`);
  }

  // 2. extra keys
  const extra = Object.keys(translated).filter(k => !sourceKeys.includes(k));
  if (extra.length > 0) {
    warnings.push(`Extra keys (removed): ${extra.join(', ')}`);
    extra.forEach(k => delete translated[k]);
  }

  // 3. type match
  for (const key of sourceKeys) {
    if (!(key in translated)) continue;
    const srcType = Array.isArray(source[key]) ? 'array' : typeof source[key];
    const tgtType = Array.isArray(translated[key]) ? 'array' : typeof translated[key];
    if (srcType !== tgtType) {
      errors.push(`Type mismatch on "${key}": expected ${srcType}, got ${tgtType}`);
    }
  }

  // 4. array length match
  for (const key of sourceKeys) {
    if (!Array.isArray(source[key]) || !(key in translated)) continue;
    if (!Array.isArray(translated[key])) continue;
    if (source[key].length !== translated[key].length) {
      errors.push(`Array length mismatch on "${key}": expected ${source[key].length}, got ${translated[key].length}`);
    }
  }

  // per-string validations
  let untranslatedCount = 0;

  for (const key of sourceKeys) {
    if (!(key in translated)) continue;
    const src = source[key];
    const tgt = translated[key];
    if (typeof src !== 'string' || typeof tgt !== 'string') continue;

    // 5. empty string
    if (tgt.trim() === '' && src.trim() !== '') {
      errors.push(`Empty translation for "${key}"`);
      continue;
    }

    // 6. HTML tag pairing
    for (const tag of ALLOWED_TAGS) {
      const srcCounts = countTag(src, tag);
      const tgtCounts = countTag(tgt, tag);
      if (srcCounts.open !== tgtCounts.open || srcCounts.close !== tgtCounts.close) {
        errors.push(`HTML tag mismatch on "${key}": <${tag}> expected ${srcCounts.open}/${srcCounts.close} open/close, got ${tgtCounts.open}/${tgtCounts.close}`);
      }
      if (tgtCounts.open !== tgtCounts.close) {
        errors.push(`Unclosed <${tag}> in "${key}": ${tgtCounts.open} opened, ${tgtCounts.close} closed`);
      }
    }

    // 7a. protected names (allow declension — check word stems)
    for (const name of PROTECTED_NAMES) {
      if (!src.includes(name)) continue;
      // Split into significant words (skip initials like "P.", "N.")
      const words = name.split(/\s+/).filter(w => w.length >= 3 && !w.endsWith('.'));
      for (const word of words) {
        // Stem = first (len-2) chars, min 4 — allows declension suffixes
        const stem = word.length <= 5 ? word : word.substring(0, Math.max(4, word.length - 2));
        if (!tgt.includes(stem)) {
          errors.push(`Protected name missing in "${key}": "${name}" (stem "${stem}" not found)`);
        }
      }
    }

    // 7b. protected titles (exact match — no declension)
    for (const title of PROTECTED_TITLES) {
      if (src.includes(title) && !tgt.includes(title)) {
        errors.push(`Protected title missing in "${key}": "${title}"`);
      }
    }

    // 8. length sanity (CJK scripts are ~2-4x shorter than Latin)
    const ratio = tgt.length / src.length;
    const isCJK = CJK_LANGS.has(targetLang);
    const minRatio = isCJK ? 0.15 : 0.4;
    const maxRatio = isCJK ? 1.5 : 2.5;
    if (ratio < minRatio) {
      errors.push(`Suspiciously short "${key}": ${Math.round(ratio * 100)}% of original`);
    }
    if (ratio > maxRatio) {
      errors.push(`Suspiciously long "${key}": ${Math.round(ratio * 100)}% of original`);
    }

    // 9. untranslated detection — if target lang is not English and value is identical
    if (targetLang !== 'en' && tgt === src && src.length > 30) {
      untranslatedCount++;
    }

    // 10. arrow preserved
    if (src.includes('\u2192') && !tgt.includes('\u2192')) {
      errors.push(`Arrow symbol \u2192 missing in "${key}"`);
    }

    // 11. security: dangerous patterns
    for (const [pattern, label] of DANGEROUS_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(tgt)) {
        errors.push(`SECURITY: ${label} in "${key}"`);
      }
    }

    // 12. security: disallowed HTML tags
    let match;
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(tgt)) !== null) {
      const tagName = match[1].toLowerCase();
      if (!ALLOWED_TAGS.includes(tagName)) {
        errors.push(`SECURITY: disallowed <${tagName}> tag in "${key}"`);
      }
    }

    // 13. security: HTML entities masking dangerous tags
    ENCODED_TAG_RE.lastIndex = 0;
    if (ENCODED_TAG_RE.test(tgt)) {
      errors.push(`SECURITY: encoded HTML tag in "${key}" (entity-escaped <script> etc.)`);
    }

    // 14. security: unicode zero-width / bidi override chars
    const unicodeMatches = tgt.match(UNICODE_SUSPICIOUS);
    if (unicodeMatches) {
      const codepoints = [...new Set(unicodeMatches.map(c => 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')))];
      errors.push(`SECURITY: suspicious unicode in "${key}": ${codepoints.join(', ')}`);
    }

    // 15. security: unicode escape sequences that decode to tags
    if (/\\u003c/gi.test(tgt) || /\\u003e/gi.test(tgt)) {
      errors.push(`SECURITY: unicode escape sequence in "${key}" (\\u003c/\\u003e)`);
    }
  }

  // 16. bulk untranslated check
  const stringKeys = sourceKeys.filter(k => typeof source[k] === 'string' && source[k].length > 30);
  if (targetLang !== 'en' && stringKeys.length > 0 && untranslatedCount > stringKeys.length * 0.3) {
    errors.push(`${untranslatedCount}/${stringKeys.length} keys appear untranslated (identical to English)`);
  }

  return { errors, warnings };
}

// ── JSON extraction helper ──────────────────────────────

function extractJSON(text) {
  let str = text.trim();
  // strip markdown fences (multiple formats: ```json, ```, ~~~, with optional whitespace)
  str = str.replace(/^`{3,}(?:json|JSON)?\s*\n/m, '').replace(/\n\s*`{3,}\s*$/m, '');
  str = str.replace(/^~{3,}(?:json|JSON)?\s*\n/m, '').replace(/\n\s*~{3,}\s*$/m, '');
  str = str.trim();
  // find outermost { } or [ ]
  const startObj = str.indexOf('{');
  const startArr = str.indexOf('[');
  let start = -1, closeChar = '}';
  if (startObj !== -1 && (startArr === -1 || startObj < startArr)) {
    start = startObj;
    closeChar = '}';
  } else if (startArr !== -1) {
    start = startArr;
    closeChar = ']';
  }
  if (start === -1) throw new Error('No JSON found');
  const end = str.lastIndexOf(closeChar);
  if (end <= start) throw new Error('No closing bracket');
  str = str.substring(start, end + 1);
  return JSON.parse(str);
}

// ── typographic quote normalization ──────────────────────
//    Post-processing: replace ASCII straight " with proper pairs per language.

const TYPOGRAPHIC_QUOTES = {
  pl: ['\u201E', '\u201D'],  // „ "
  cs: ['\u201E', '\u201D'],  // „ "
  de: ['\u201E', '\u201C'],  // „ "
  hu: ['\u201E', '\u201D'],  // „ "
  ro: ['\u201E', '\u201D'],  // „ "
  nl: ['\u201C', '\u201D'],  // " "
  sv: ['\u201D', '\u201D'],  // " "
  da: ['\u201C', '\u201D'],  // " "
  fi: ['\u201D', '\u201D'],  // " "
  nb: ['\u00AB', '\u00BB'],  // « »
  fr: ['\u00AB\u202F', '\u202F\u00BB'],  // « » (narrow no-break space)
  es: ['\u00AB', '\u00BB'],  // « »
  it: ['\u00AB', '\u00BB'],  // « »
  pt: ['\u00AB', '\u00BB'],  // « »
  tr: ['\u201C', '\u201D'],  // " "
  ar: ['\u00AB', '\u00BB'],  // « »
  hi: ['\u201C', '\u201D'],  // " "
  ru: ['\u00AB', '\u00BB'],  // « »
  uk: ['\u00AB', '\u00BB'],  // « »
  ja: ['\u300C', '\u300D'],  // 「 」
  zh: ['\u201C', '\u201D'],  // " "
  ko: ['\u201C', '\u201D'],  // " "
};

function normalizeQuotes(text, langCode) {
  const pair = TYPOGRAPHIC_QUOTES[langCode];
  if (!pair) return text;
  const [open, close] = pair;

  let result = text;

  // Fix half-converted pairs: typographic open „ + ASCII close "
  if (open === '\u201E') {
    result = result.replace(/\u201E([^\u201D\u201C"]*?)"/g, `\u201E$1${close}`);
  }

  // Replace remaining paired ASCII straight double quotes
  result = result.replace(/"([^"]*?)"/g, `${open}$1${close}`);

  return result;
}

// Baseline terms that MUST appear in every glossary (hardcoded minimum).
// At runtime, these are merged with all EN keys from the existing cached glossary
// so that any manually curated terms are always required in regeneration.
const REQUIRED_GLOSSARY_BASE = [
  'framework',
  'critical framework',
  'manifesto',
  'generative practice'
];

// Build full required list: base + all EN keys from cached glossary file (if any).
function getRequiredGlossaryTerms(targetLang) {
  const glossaryFile = path.join(LOCALES_DIR, `glossary-${targetLang}.json`);
  let cachedKeys = [];
  try {
    if (fs.existsSync(glossaryFile)) {
      const cached = JSON.parse(fs.readFileSync(glossaryFile, 'utf8'));
      cachedKeys = Object.keys(cached);
    }
  } catch (_) { /* ignore */ }
  const all = new Set([...REQUIRED_GLOSSARY_BASE, ...cachedKeys]);
  return [...all];
}

// ── API: glossary generation ────────────────────────────

async function generateGlossary(client, model, source, langName, requiredTerms) {
  const prompt = `You are an expert academic translator specializing in critical theory, media studies, and philosophy of technology.

Analyze this English academic text and extract ALL key domain-specific terms that require consistent translation into ${langName}. Include:
- Philosophical/theoretical concepts (e.g. "metastability", "distributed agency")
- Technical terms used in specific academic senses (e.g. "feedback loop", "initial conditions")
- Key phrases that form the argumentative backbone (e.g. "beyond the loop", "negative condition")
- Meta-terms that refer to the text itself (e.g. "framework", "critical framework", "manifesto")
- Any term that appears in multiple places and MUST be translated consistently

IMPORTANT: You MUST include translations for ALL of these terms:
${requiredTerms.map(t => `- "${t}"`).join('\n')}

Return ONLY a JSON object mapping English term → canonical ${langName} translation.
No markdown fences, no explanation. Example format:
{"feedback loop": "translated term", "divergence": "translated term"}

TEXT:
${JSON.stringify(source, null, 2)}`;

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const usage = response.usage;

  if (response.stop_reason === 'max_tokens') {
    return { glossary: null, usage, error: 'Response truncated' };
  }

  try {
    const glossary = extractJSON(response.content[0].text);
    if (typeof glossary !== 'object' || Array.isArray(glossary)) {
      return { glossary: null, usage, error: 'Expected object' };
    }

    // Warn about missing required terms (they should have been generated)
    const glossaryLower = Object.fromEntries(
      Object.entries(glossary).map(([k, v]) => [k.toLowerCase(), v])
    );
    const missing = requiredTerms.filter(t => !glossaryLower[t.toLowerCase()]);
    if (missing.length > 0) {
      console.log(`  WARN Missing required terms (model skipped): ${missing.join(', ')}`);
    }

    return { glossary, usage, error: null };
  } catch (e) {
    return { glossary: null, usage, error: `JSON parse: ${response.content[0].text.substring(0, 200)}` };
  }
}

// ── format glossary for prompts ─────────────────────────

function formatGlossary(glossary) {
  if (!glossary || Object.keys(glossary).length === 0) return '';
  const entries = Object.entries(glossary)
    .map(([en, tl]) => `  "${en}" → "${tl}"`)
    .join('\n');
  return `\nGLOSSARY (use these EXACT terms for consistency):\n${entries}\n`;
}

// ── API: batch translation ──────────────────────────────

async function translateBatch(client, model, source, batch, langName, glossary, priorTranslations) {
  const batchSource = {};
  for (const key of batch.keys) {
    if (key in source) batchSource[key] = source[key];
  }

  // Build prior translations context (only string keys, truncated for token efficiency)
  let priorBlock = '';
  if (priorTranslations && Object.keys(priorTranslations).length > 0) {
    // Include titles + first 120 chars of paragraphs for terminology reference
    const priorSummary = {};
    for (const [k, v] of Object.entries(priorTranslations)) {
      if (typeof v === 'string') {
        priorSummary[k] = v.length > 120 ? v.substring(0, 120) + '...' : v;
      }
    }
    priorBlock = `\nPRIOR TRANSLATIONS (maintain consistent terminology with these):\n${JSON.stringify(priorSummary, null, 2)}\n`;
  }

  const prompt = `Translate the following JSON from English to ${langName}.

CONTEXT: ${batch.context}
${formatGlossary(glossary)}${priorBlock}
RULES:
1. Return ONLY valid JSON with the exact same keys. No markdown fences, no explanation.
2. Proper names (Szymon P. Pepli\u0144ski, Shoshana Zuboff, Gilbert Simondon, N. Katherine Hayles, Byung-Chul Han, Kyle Chayka, Douglas Rushkoff, James Williams, Kasparov, Tegmark) — keep recognizable. Grammatical declension for natural ${langName} grammar IS ALLOWED and encouraged (e.g. "Rushkoffa", "Kasparova"). Do NOT transliterate or translate.
3. Brand "Generatywnie" and book titles VERBATIM (no declension): "The Age of Surveillance Capitalism", "Du mode d'existence des objets techniques", "How We Became Posthuman".
4. Preserve ALL HTML tags exactly (<strong>, </strong>, <cite>, </cite>, <em>, </em>). Tag count must match source.
5. Preserve \u2192 arrow symbols in <cite> references.
6. Preserve markdown formatting (**, -, \\n) if present.
7. Academic critical theory register \u2014 maintain precision, rigor, and intellectual depth. Do not simplify.
8. For array values, return arrays with the SAME number of items.
9. Translate EVERY value into ${langName}. Do not leave anything in English.
10. Use EXACTLY the terms from the GLOSSARY above — do not deviate.
11. Use proper typographic quotation marks for ${langName} (e.g. Polish: \u201E...\u201D, German: \u201E...\u201C, French: \u00AB...\u00BB). Never leave ASCII straight quotes.
12. GRAMMAR: Ensure verb number agrees with its subject. If the subject is plural, the verb MUST be plural (e.g. Polish: "Te ramy proponują…" NOT "Te ramy proponuje…").

SOURCE:
${JSON.stringify(batchSource, null, 2)}`;

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });

  const usage = response.usage;

  if (response.stop_reason === 'max_tokens') {
    return { result: null, usage, error: 'Response truncated (max_tokens)' };
  }

  try {
    const parsed = extractJSON(response.content[0].text);
    return { result: parsed, usage, error: null };
  } catch (e) {
    return { result: null, usage, error: `JSON parse: ${response.content[0].text.substring(0, 200)}` };
  }
}

// ── API: translate single key with full context ─────────
//    Used for body sections — no JSON, no parsing risk.

async function translateKey(client, model, key, sourceValue, langName, glossary, batch, source, priorTranslations) {
  const isArray = Array.isArray(sourceValue);
  const glossaryBlock = formatGlossary(glossary);

  // Build section context: other keys in the same batch
  let sectionBlock = '';
  if (batch) {
    const sectionEN = {};
    const sectionTL = {};
    for (const k of batch.keys) {
      if (k !== key && k in source) {
        if (typeof source[k] === 'string') {
          sectionEN[k] = source[k].length > 200 ? source[k].substring(0, 200) + '...' : source[k];
        }
        if (k in priorTranslations && typeof priorTranslations[k] === 'string') {
          sectionTL[k] = priorTranslations[k].length > 200 ? priorTranslations[k].substring(0, 200) + '...' : priorTranslations[k];
        }
      }
    }
    if (Object.keys(sectionEN).length > 0) {
      sectionBlock = `\nSECTION CONTEXT (${batch.context}):\nEnglish: ${JSON.stringify(sectionEN, null, 2)}`;
      if (Object.keys(sectionTL).length > 0) {
        sectionBlock += `\nAlready translated: ${JSON.stringify(sectionTL, null, 2)}`;
      }
      sectionBlock += '\n';
    }
  }

  let prompt;
  if (isArray) {
    prompt = `Translate these ${sourceValue.length} items from English to ${langName}.
Return ONLY a JSON array with exactly ${sourceValue.length} translated strings. No explanation, no fences.
${glossaryBlock}
SOURCE: ${JSON.stringify(sourceValue)}`;
  } else {
    prompt = `Translate this text from English to ${langName}.
Return ONLY the translated text. No quotes around it, no explanation, no labels.
${glossaryBlock}${sectionBlock}
RULES:
- Use EXACTLY the terms from the GLOSSARY above
- Proper names (Szymon P. Pepliński, Shoshana Zuboff, Gilbert Simondon, N. Katherine Hayles, Byung-Chul Han, Kyle Chayka, Douglas Rushkoff, James Williams, Kasparov, Tegmark) — keep recognizable. Grammatical declension IS ALLOWED (e.g. "Rushkoffa", "Kasparova"). Do NOT transliterate.
- Brand "Generatywnie" VERBATIM, book titles VERBATIM (The Age of Surveillance Capitalism, Du mode d'existence des objets techniques, How We Became Posthuman)
- Preserve HTML tags (<strong>, </strong>, <cite>, </cite>) exactly \u2014 same count
- Preserve \u2192 arrow symbols
- Preserve markdown formatting (**, -, \\n) if present
- Academic critical theory register
- Use proper typographic quotation marks for ${langName} (e.g. Polish: \u201E...\u201D, German: \u201E...\u201C, French: \u00AB...\u00BB). Never leave ASCII straight quotes.
- GRAMMAR: Verb number must agree with its subject. Plural subject → plural verb (e.g. Polish: "Te ramy proponują…" NOT "Te ramy proponuje…").

SOURCE:
${sourceValue}`;
  }

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const usage = response.usage;

  if (isArray) {
    try {
      const arr = extractJSON(text);
      if (!Array.isArray(arr)) return { value: null, usage, error: 'Expected array, got object' };
      return { value: arr, usage, error: null };
    } catch (e) {
      return { value: null, usage, error: 'Array parse failed' };
    }
  }

  // plain text — strip wrapping quotes if model added them
  let value = text;
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\u201c') && value.endsWith('\u201d'))) {
    value = value.slice(1, -1);
  }
  return { value, usage, error: null };
}

// ── API: retry single key ───────────────────────────────

async function retryKey(client, model, key, sourceValue, langName, keyErrors, glossary) {
  const isArray = Array.isArray(sourceValue);
  const glossaryBlock = formatGlossary(glossary);

  let prompt;
  if (isArray) {
    prompt = `Translate these ${sourceValue.length} items from English to ${langName}.
Return ONLY a JSON array with exactly ${sourceValue.length} translated strings. No explanation, no fences.
${glossaryBlock}${keyErrors.length > 0 ? `\nFIX THESE ERRORS:\n${keyErrors.join('\n')}\n` : ''}
SOURCE: ${JSON.stringify(sourceValue)}`;
  } else {
    prompt = `Translate this text from English to ${langName}.
Return ONLY the translated text. No quotes around it, no explanation, no labels.
${glossaryBlock}
RULES:
- Use EXACTLY the terms from the GLOSSARY above
- Proper names (Szymon P. Pepliński, Shoshana Zuboff, Gilbert Simondon, N. Katherine Hayles, Byung-Chul Han, Kyle Chayka, Douglas Rushkoff, James Williams, Kasparov, Tegmark) — keep recognizable. Grammatical declension IS ALLOWED. Do NOT transliterate.
- Brand "Generatywnie" VERBATIM, book titles VERBATIM (The Age of Surveillance Capitalism, Du mode d'existence des objets techniques, How We Became Posthuman)
- Preserve HTML tags (<strong>, </strong>, <cite>, </cite>) exactly \u2014 same count
- Preserve \u2192 arrow symbols
- Preserve markdown formatting (**, -, \\n) if present
- Academic critical theory register
- Use proper typographic quotation marks for ${langName} (e.g. Polish: \u201E...\u201D, German: \u201E...\u201C, French: \u00AB...\u00BB). Never leave ASCII straight quotes.
- GRAMMAR: Verb number must agree with its subject. Plural subject → plural verb.
${keyErrors.length > 0 ? `\nFIX THESE ERRORS:\n${keyErrors.join('\n')}\n` : ''}
SOURCE:
${sourceValue}`;
  }

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const usage = response.usage;

  if (isArray) {
    try {
      const arr = extractJSON(text);
      if (!Array.isArray(arr)) return { value: null, usage, error: 'Expected array, got object' };
      return { value: arr, usage, error: null };
    } catch (e) {
      return { value: null, usage, error: 'Array parse failed' };
    }
  }

  // plain text — strip wrapping quotes if model added them
  let value = text;
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\u201c') && value.endsWith('\u201d'))) {
    value = value.slice(1, -1);
  }
  return { value, usage, error: null };
}

// ── find which keys failed from validation errors ───────

function findFailedKeys(errors, source, translated, targetLang) {
  const keys = new Set();

  for (const err of errors) {
    // "Missing keys: k1, k2, k3"
    if (err.startsWith('Missing keys:')) {
      err.replace('Missing keys: ', '').split(', ').forEach(k => {
        const key = k.trim();
        if (key in source) keys.add(key);
      });
      continue;
    }

    // "X/Y keys appear untranslated" — find which ones are identical
    if (err.includes('appear untranslated')) {
      for (const key of Object.keys(source)) {
        if (typeof source[key] === 'string' && source[key].length > 30
            && translated[key] === source[key]) {
          keys.add(key);
        }
      }
      continue;
    }

    // Extract key name from quotes: ... "keyname" ...
    const match = err.match(/"([^"]+)"/);
    if (match && match[1] in source) {
      keys.add(match[1]);
    }
  }

  return keys;
}

// ── per-key validation (safety check for semantic fixes) ─

function validateValue(key, tgt, src) {
  const errors = [];
  if (typeof src !== 'string' || typeof tgt !== 'string') return errors;

  if (tgt.trim() === '' && src.trim() !== '') {
    errors.push('Empty translation');
    return errors;
  }

  for (const tag of ALLOWED_TAGS) {
    const srcC = countTag(src, tag);
    const tgtC = countTag(tgt, tag);
    if (srcC.open !== tgtC.open || srcC.close !== tgtC.close) {
      errors.push(`HTML <${tag}> count mismatch`);
    }
    if (tgtC.open !== tgtC.close) {
      errors.push(`Unclosed <${tag}>`);
    }
  }

  for (const name of PROTECTED_NAMES) {
    if (!src.includes(name)) continue;
    const words = name.split(/\s+/).filter(w => w.length >= 3 && !w.endsWith('.'));
    for (const word of words) {
      const stem = word.length <= 5 ? word : word.substring(0, Math.max(4, word.length - 2));
      if (!tgt.includes(stem)) {
        errors.push(`Missing protected name: "${name}" (stem "${stem}")`);
      }
    }
  }

  for (const title of PROTECTED_TITLES) {
    if (src.includes(title) && !tgt.includes(title)) {
      errors.push(`Missing protected title: "${title}"`);
    }
  }

  const ratio = tgt.length / src.length;
  if (ratio < 0.4) errors.push(`Too short: ${Math.round(ratio * 100)}%`);
  if (ratio > 2.5) errors.push(`Too long: ${Math.round(ratio * 100)}%`);

  if (src.includes('\u2192') && !tgt.includes('\u2192')) {
    errors.push('Missing \u2192 arrow');
  }

  for (const [pattern, label] of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(tgt)) errors.push(`SECURITY: ${label}`);
  }

  let match;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(tgt)) !== null) {
    if (!ALLOWED_TAGS.includes(match[1].toLowerCase())) {
      errors.push(`SECURITY: <${match[1]}>`);
    }
  }

  ENCODED_TAG_RE.lastIndex = 0;
  if (ENCODED_TAG_RE.test(tgt)) errors.push('SECURITY: encoded HTML tag');

  const um = tgt.match(UNICODE_SUSPICIOUS);
  if (um) errors.push('SECURITY: suspicious unicode');

  if (/\\u003c/gi.test(tgt) || /\\u003e/gi.test(tgt)) {
    errors.push('SECURITY: unicode escape');
  }

  return errors;
}

// ── semantic review via API ─────────────────────────────
//    Returns issues only (no corrected values) to keep response small & parseable.
//    Fixes are applied per-key via fixSemanticKey().

async function semanticReview(client, model, source, translated, langName, glossary) {
  const glossaryBlock = formatGlossary(glossary);

  const prompt = `You are a professional ${langName} translation quality reviewer.

Compare the ${langName} translation against the English source and find issues:

1. UNTRANSLATED: English words left untranslated in ${langName} text (except protected names/titles)
2. INCONSISTENCY: Same English concept translated with different ${langName} terms across keys
3. GLOSSARY: Term translated differently than the canonical glossary entry below
4. QUOTES: Mismatched or inconsistent quotation mark styles
5. REGISTER: Breaks in academic critical theory register
6. MEANING: Significant meaning shifts, omissions, or additions vs English source
${glossaryBlock}
PROTECTED (must stay in original language — do NOT flag these):
${PROTECTED_STRINGS.join('; ')}

IMPORTANT: Use this EXACT line-based format (NOT JSON). One issue per line:
KEY: the.key | TYPE: untranslated | DESC: concise description of the problem and how to fix it

If translation is clean, write ONLY: CLEAN

Do NOT flag:
- Protected names/titles staying in original language (by design)
- Minor stylistic preferences — only clear errors
- Key ordering (handled separately)
- Grammatical case of protected names after prepositions (trade-off by design)

ENGLISH SOURCE:
${JSON.stringify(source, null, 2)}

${langName.toUpperCase()} TRANSLATION:
${JSON.stringify(translated, null, 2)}`;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  const usage = response.usage;

  if (response.stop_reason === 'max_tokens') {
    return { issues: null, usage, error: 'Response truncated' };
  }

  const text = response.content[0].text.trim();

  // Check for clean translation
  if (text === 'CLEAN' || text.startsWith('CLEAN')) {
    return { issues: [], usage, error: null };
  }

  // Parse line-based format: KEY: x | TYPE: y | DESC: z
  const issues = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('KEY:')) continue;

    const parts = trimmed.split('|').map(p => p.trim());
    if (parts.length < 3) continue;

    const keyMatch = parts[0].match(/^KEY:\s*(.+)/);
    const typeMatch = parts[1].match(/^TYPE:\s*(.+)/);
    const descMatch = parts[2].match(/^DESC:\s*(.+)/);

    if (keyMatch && typeMatch && descMatch) {
      issues.push({
        key: keyMatch[1].trim(),
        type: typeMatch[1].trim().toLowerCase(),
        description: descMatch[1].trim()
      });
    }
  }

  return { issues, usage, error: null };
}

// ── fix a single key based on semantic review feedback ───

async function fixSemanticKey(client, model, key, sourceValue, currentValue, issue, source, translated, langName, glossary) {
  // Find the batch (section) this key belongs to — neighboring paragraphs as context
  const batch = BATCHES.find(b => b.keys.includes(key));

  let contextBlock = '';
  if (batch) {
    const sectionEN = {};
    const sectionTL = {};
    for (const k of batch.keys) {
      if (k !== key && k in source && typeof source[k] === 'string') {
        sectionEN[k] = source[k];
        if (k in translated) sectionTL[k] = translated[k];
      }
    }
    if (Object.keys(sectionEN).length > 0) {
      contextBlock = `
SECTION CONTEXT (neighboring paragraphs — maintain consistent terminology):
English:
${JSON.stringify(sectionEN, null, 2)}
${langName}:
${JSON.stringify(sectionTL, null, 2)}
`;
    }
  }

  const prompt = `Fix this ${langName} translation based on the review feedback.

KEY: ${key}
ISSUE TYPE: ${issue.type}
ISSUE: ${issue.description}
${formatGlossary(glossary)}${contextBlock}
ENGLISH SOURCE:
${sourceValue}

CURRENT ${langName.toUpperCase()} TRANSLATION:
${currentValue}

RULES:
- Return ONLY the corrected translation. No quotes around it, no explanation, no labels.
- Use EXACTLY the terms from the GLOSSARY above
- Proper names (Szymon P. Pepliński, Shoshana Zuboff, Gilbert Simondon, N. Katherine Hayles, Byung-Chul Han, Kyle Chayka, Douglas Rushkoff, James Williams, Kasparov, Tegmark) — keep recognizable. Grammatical declension IS ALLOWED. Do NOT transliterate.
- Brand "Generatywnie" and book titles VERBATIM (no declension)
- Preserve ALL HTML tags exactly (<strong>, </strong>, <cite>, </cite>, <em>, </em>)
- Preserve \u2192 arrow symbols
- Preserve markdown formatting (**, -, \\n) if present
- Academic critical theory register
- Use proper typographic quotation marks for ${langName} (e.g. Polish: \u201E...\u201D, German: \u201E...\u201C, French: \u00AB...\u00BB). Never leave ASCII straight quotes.`;

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const usage = response.usage;

  // strip wrapping quotes if model added them
  let value = text;
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\u201c') && value.endsWith('\u201d'))) {
    value = value.slice(1, -1);
  }
  return { value, usage, error: null };
}

// ── reorder keys to match source ────────────────────────

function reorderKeys(translated, source) {
  const ordered = {};
  for (const key of Object.keys(source)) {
    if (key in translated) ordered[key] = translated[key];
  }
  return ordered;
}

// ── main translate function ─────────────────────────────

async function translate(targetLang, force, modelKey, regenGlossary) {
  const langName = LANG_NAMES[targetLang];
  if (!langName) {
    console.error(`Unknown language: ${targetLang}`);
    console.error(`Supported: ${Object.keys(LANG_NAMES).join(', ')}`);
    process.exit(1);
  }

  const outFile = path.join(LOCALES_DIR, `${targetLang}.json`);
  if (fs.existsSync(outFile) && !force) {
    console.log(`${outFile} exists. Use --force to overwrite.`);
    return;
  }

  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const client = new Anthropic();
  const model = MODELS[modelKey] || MODELS.opus;

  console.log(`\nModel: ${model}`);
  console.log(`Target: ${langName} (${targetLang})`);
  console.log(`Keys: ${Object.keys(source).length}`);

  const log = {
    lang: targetLang,
    langName,
    model,
    startedAt: new Date().toISOString(),
    phases: [],
    totalTokensIn: 0,
    totalTokensOut: 0,
    result: null
  };

  // ── Phase 0: Glossary (load cached or generate) ──

  const glossaryFile = path.join(LOCALES_DIR, `glossary-${targetLang}.json`);
  let glossary = {};
  let glossarySource = 'none';

  if (!regenGlossary && fs.existsSync(glossaryFile)) {
    // ── Load cached glossary ──
    console.log(`\n=== Phase 0: Loading cached glossary ===\n`);
    try {
      glossary = JSON.parse(fs.readFileSync(glossaryFile, 'utf8'));
      glossarySource = 'cached';
      const termCount = Object.keys(glossary).length;
      console.log(`  OK ${termCount} terms from ${glossaryFile}`);
      log.phases.push({ phase: 'glossary', source: 'cached', terms: termCount });
    } catch (e) {
      console.log(`  WARN Failed to load cached glossary: ${e.message} (regenerating)`);
    }
  }

  if (glossarySource === 'none') {
    // ── Generate glossary via API ──
    console.log(`\n=== Phase 0: Generating terminology glossary ===\n`);

    const requiredTerms = getRequiredGlossaryTerms(targetLang);
    console.log(`  Required terms: ${requiredTerms.length} (${REQUIRED_GLOSSARY_BASE.length} base + ${requiredTerms.length - REQUIRED_GLOSSARY_BASE.length} from cached glossary)`);
    const { glossary: genGlossary, usage: glossaryUsage, error: glossaryError } = await generateGlossary(client, model, source, langName, requiredTerms);

    log.totalTokensIn += glossaryUsage.input_tokens;
    log.totalTokensOut += glossaryUsage.output_tokens;

    if (glossaryError) {
      console.log(`  WARN Glossary failed: ${glossaryError} (proceeding without)`);
      log.phases.push({ phase: 'glossary', error: glossaryError });
    } else {
      glossary = genGlossary;
      glossarySource = 'generated';
      const termCount = Object.keys(glossary).length;
      console.log(`  OK ${termCount} terms:`);
      for (const [en, tl] of Object.entries(glossary)) {
        console.log(`    "${en}" -> "${tl}"`);
      }

      // Cache glossary for next run
      fs.writeFileSync(glossaryFile, JSON.stringify(glossary, null, 2) + '\n', 'utf8');
      console.log(`  Saved: ${glossaryFile}`);

      log.phases.push({ phase: 'glossary', source: 'generated', terms: termCount, glossary });
    }
  }

  // ── Phase 1a: Body translation (sequential, with context accumulation) ──

  const bodyCount = BATCHES_BODY.length;
  const derivedCount = BATCHES_DERIVED.length;
  console.log(`\n=== Phase 1: Translating body (${bodyCount} sections) + derived (${derivedCount} batches) ===\n`);

  const translated = {};
  const phase1 = { phase: 'batch-translate', batches: [] };

  // ── Phase 1a: Body — always per-key (no JSON risk, full section context) ──

  for (const batch of BATCHES_BODY) {
    console.log(`  ${batch.name} (${batch.keys.length} keys):`);

    let sectionOk = 0;
    for (const key of batch.keys) {
      process.stdout.write(`    ${key.padEnd(22)} `);

      const { value, usage: kUsage, error: kError } = await translateKey(
        client, model, key, source[key], langName, glossary, batch, source, translated
      );

      log.totalTokensIn += kUsage.input_tokens;
      log.totalTokensOut += kUsage.output_tokens;

      if (kError) {
        console.log(`FAIL ${kError}`);
        phase1.batches.push({ name: batch.name, key, error: kError });
        continue;
      }

      translated[key] = value;
      sectionOk++;
      console.log(`OK (${kUsage.input_tokens}+${kUsage.output_tokens} tok)`);
    }

    phase1.batches.push({ name: batch.name, keys: batch.keys.length, translated: sectionOk });
    console.log(`  ${batch.name}: ${sectionOk}/${batch.keys.length}\n`);
  }

  // ── Phase 1b: Derived — JSON batch (simple metadata, rarely fails) ──

  console.log(`  --- derived content (JSON batch) ---\n`);

  for (const batch of BATCHES_DERIVED) {
    const label = `  ${batch.name.padEnd(14)} (${String(batch.keys.length).padStart(2)} keys) `;
    process.stdout.write(label);

    let { result, usage, error } = await translateBatch(client, model, source, batch, langName, glossary, translated);

    log.totalTokensIn += usage.input_tokens;
    log.totalTokensOut += usage.output_tokens;

    // JSON batch succeeded
    if (!error && result) {
      let merged = 0;
      for (const key of batch.keys) {
        if (key in result) {
          translated[key] = result[key];
          merged++;
        }
      }
      phase1.batches.push({ name: batch.name, keys: batch.keys.length, merged });
      console.log(`OK ${merged}/${batch.keys.length} (${usage.input_tokens}+${usage.output_tokens} tok)`);
      continue;
    }

    // JSON failed → per-key fallback
    console.log(`JSON-> per-key`);

    let perKeyOk = 0;
    for (const key of batch.keys) {
      process.stdout.write(`    ${key.padEnd(22)} `);

      const { value, usage: kUsage, error: kError } = await retryKey(
        client, model, key, source[key], langName, [], glossary
      );

      log.totalTokensIn += kUsage.input_tokens;
      log.totalTokensOut += kUsage.output_tokens;

      if (kError) {
        console.log(`FAIL ${kError}`);
        continue;
      }

      translated[key] = value;
      perKeyOk++;
      console.log(`OK`);
    }

    phase1.batches.push({ name: batch.name, keys: batch.keys.length, merged: perKeyOk, perKey: true });
  }

  log.phases.push(phase1);

  // ── Phase 2 + 3: Technical validation → Retry → Validate loop ──

  let technicallyClean = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const isRetry = round > 1;
    const phaseLabel = isRetry
      ? `Retry round ${round - 1} -> re-validate`
      : 'Technical validation';

    console.log(`\n=== Phase ${round + 1}: ${phaseLabel} ===\n`);

    const { errors, warnings } = validate(translated, source, targetLang);

    for (const w of warnings) console.log(`  ! ${w}`);

    // ── clean: proceed to semantic review ──
    if (errors.length === 0) {
      console.log(`  OK All ${Object.keys(translated).length} keys passed technical validation`);
      log.phases.push({ phase: phaseLabel, errors: 0, warnings: warnings.length });
      technicallyClean = true;
      break;
    }

    // ── security errors: abort immediately ──
    const securityErrors = errors.filter(e => e.startsWith('SECURITY:'));
    if (securityErrors.length > 0) {
      console.log(`  FAIL SECURITY VIOLATION - aborting:`);
      securityErrors.forEach(e => console.log(`    ${e}`));
      log.phases.push({ phase: phaseLabel, errors, securityAbort: true });
      break;
    }

    console.log(`  FAIL ${errors.length} error(s):`);
    errors.forEach(e => console.log(`    - ${e}`));

    // ── last round: no more retries ──
    if (round === MAX_ROUNDS) {
      log.phases.push({ phase: phaseLabel, errors, warnings: warnings.length });
      break;
    }

    // ── find failed keys and retry individually ──
    const failedKeys = findFailedKeys(errors, source, translated, targetLang);

    if (failedKeys.size === 0) {
      console.log(`\n  Cannot identify specific keys to retry.`);
      log.phases.push({ phase: phaseLabel, errors, warnings: warnings.length });
      break;
    }

    console.log(`\n  Retrying ${failedKeys.size} key(s)...\n`);

    const retryLog = { phase: `retry-${round}`, keys: [] };

    for (const key of failedKeys) {
      const keyErrors = errors.filter(e => e.includes(`"${key}"`));
      process.stdout.write(`    ${key.padEnd(22)} `);

      const { value, usage, error } = await retryKey(
        client, model, key, source[key], langName, keyErrors, glossary
      );

      log.totalTokensIn += usage.input_tokens;
      log.totalTokensOut += usage.output_tokens;

      retryLog.keys.push({
        key,
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
        error
      });

      if (error) {
        console.log(`FAIL ${error}`);
        continue;
      }

      translated[key] = value;
      console.log(`OK`);
    }

    log.phases.push(retryLog);
  }

  // ── Technical validation failed → exit ──

  if (!technicallyClean) {
    log.finishedAt = new Date().toISOString();
    log.result = 'failed';

    console.log(`\n=== Done ===`);
    console.log(`  FAILED technical validation after ${MAX_ROUNDS} rounds. Fallback -> EN`);
    console.log(`  Tokens: ${log.totalTokensIn} in / ${log.totalTokensOut} out`);
    writeLog(targetLang, log);
    return;
  }

  // ── Phase 4 + 5: Semantic review → Fix → Re-review ──

  for (let sround = 1; sround <= MAX_SEMANTIC_ROUNDS; sround++) {
    const phaseLabel = sround === 1
      ? 'Semantic review'
      : `Semantic review (round ${sround})`;

    console.log(`\n=== Phase ${3 + sround}: ${phaseLabel} ===\n`);

    const { issues, usage, error } = await semanticReview(
      client, model, source, translated, langName, glossary
    );

    log.totalTokensIn += usage.input_tokens;
    log.totalTokensOut += usage.output_tokens;

    if (error) {
      console.log(`  FAIL Review failed: ${error}`);
      log.phases.push({ phase: phaseLabel, error });
      break; // save what we have
    }

    const semanticLog = {
      phase: phaseLabel,
      issuesFound: issues.length,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      issues: issues.map(i => ({ key: i.key, type: i.type, description: i.description })),
      applied: []
    };

    if (issues.length === 0) {
      console.log(`  OK No semantic issues found`);
      log.phases.push(semanticLog);
      break;
    }

    console.log(`  Found ${issues.length} issue(s):\n`);

    let applied = 0;

    for (const issue of issues) {
      console.log(`    [${issue.type}] ${issue.key}: ${issue.description}`);

      if (!(issue.key in source)) {
        console.log(`      -> skipped (unknown key)`);
        continue;
      }

      const src = source[issue.key];

      // skip array keys for semantic fixes
      if (Array.isArray(src)) {
        console.log(`      -> skipped (array key)`);
        continue;
      }

      process.stdout.write(`      -> fixing... `);

      const { value, usage: fixUsage, error: fixError } = await fixSemanticKey(
        client, model, issue.key, src, translated[issue.key], issue, source, translated, langName, glossary
      );

      log.totalTokensIn += fixUsage.input_tokens;
      log.totalTokensOut += fixUsage.output_tokens;

      if (fixError) {
        console.log(`FAIL ${fixError}`);
        semanticLog.applied.push({ key: issue.key, status: 'failed', reason: fixError });
        continue;
      }

      // safety: run per-key technical validation on the fix
      const techErrors = validateValue(issue.key, value, src);

      if (techErrors.length > 0) {
        console.log(`reverted (${techErrors[0]})`);
        semanticLog.applied.push({ key: issue.key, status: 'reverted', reason: techErrors[0] });
        continue;
      }

      translated[issue.key] = value;
      applied++;
      console.log(`OK`);
      semanticLog.applied.push({ key: issue.key, status: 'applied' });
    }

    console.log(`\n  Applied ${applied}/${issues.length} fix(es)`);
    log.phases.push(semanticLog);

    if (applied === 0) break; // nothing changed, no point re-reviewing
  }

  // ── Post-processing: normalize typographic quotes ──

  let quotesFixed = 0;
  for (const key of Object.keys(translated)) {
    if (typeof translated[key] !== 'string') continue;
    const normalized = normalizeQuotes(translated[key], targetLang);
    if (normalized !== translated[key]) {
      translated[key] = normalized;
      quotesFixed++;
    }
  }
  if (quotesFixed > 0) {
    console.log(`\n  Normalized quotes in ${quotesFixed} key(s)`);
  }

  // ── Reorder keys to match source and save ──

  const ordered = reorderKeys(translated, source);

  log.finishedAt = new Date().toISOString();
  log.result = 'success';

  fs.writeFileSync(outFile, JSON.stringify(ordered, null, 2) + '\n', 'utf8');

  console.log(`\n=== Done ===`);
  console.log(`  Saved: ${outFile}`);
  console.log(`  Tokens: ${log.totalTokensIn} in / ${log.totalTokensOut} out`);
  writeLog(targetLang, log);
}

// ── CLI ─────────────────────────────────────────────────

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const regenGlossary = args.includes('--regen-glossary');

  // parse --model
  let modelKey = 'opus';
  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1) {
    const val = args[modelIdx + 1];
    if (!val || !(val in MODELS)) {
      console.error(`--model requires: ${Object.keys(MODELS).join(' | ')}`);
      process.exit(1);
    }
    modelKey = val;
  }

  // collect language codes (skip flags and their values)
  const targetLangs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force' || args[i] === '--regen-glossary') continue;
    if (args[i] === '--model') { i++; continue; }
    targetLangs.push(args[i]);
  }

  if (targetLangs.length === 0) {
    console.log('Usage: node scripts/translate.js <lang> [lang2 ...] [--force] [--model opus|sonnet] [--regen-glossary]');
    console.log(`\nLanguages: ${Object.keys(LANG_NAMES).join(', ')}`);
    console.log(`Models: ${Object.entries(MODELS).map(([k, v]) => `${k} → ${v}`).join(', ')}`);
    console.log(`Default model: opus`);
    process.exit(0);
  }

  for (const lang of targetLangs) {
    await translate(lang, force, modelKey, regenGlossary);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
