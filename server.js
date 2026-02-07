const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// ── security: disable fingerprinting ──
app.disable('x-powered-by');
app.enable('strict routing');

// ── security: headers + CSP nonce ──
app.use((req, res, next) => {
  // generate unique nonce per request for inline scripts/styles
  res.locals.nonce = crypto.randomBytes(16).toString('base64');

  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${res.locals.nonce}'`,
      `style-src 'nonce-${res.locals.nonce}' https://fonts.googleapis.com`,
      "font-src https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'self' data: https://generatywnie.com",
      "base-uri 'self'",
      "form-action 'none'",
      "upgrade-insecure-requests"
    ].join('; ')
  });

  // HSTS — only in production behind HTTPS
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  next();
});

// ── load available languages ──
const LOCALES_DIR = path.join(__dirname, 'locales');
const translations = {};
const langs = [];

fs.readdirSync(LOCALES_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('glossary-'))
  .forEach(f => {
    const lang = f.replace('.json', '');
    translations[lang] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'));
    langs.push(lang);
  });

console.log(`Loaded languages: ${langs.join(', ')}`);

// ── EJS setup ──
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

// ── static files ──
app.use('/public', express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  immutable: true
}));

// ── detect language from Accept-Language header ──
function detectLang(req) {
  const header = req.get('Accept-Language');
  if (!header) return 'en';
  const preferred = header
    .split(',')
    .map(part => {
      const [locale, q] = part.trim().split(';q=');
      return { lang: locale.trim().substring(0, 2).toLowerCase(), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .find(item => langs.includes(item.lang));
  return preferred ? preferred.lang : 'en';
}

// ── favicon.ico fallback ──
app.get('/favicon.ico', (req, res) => {
  res.redirect(301, '/public/favicon.svg');
});

// ── robots.txt ──
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Googlebot-Extended
Allow: /

User-agent: anthropic-ai
Allow: /

Sitemap: https://generatywnie.com/sitemap.xml`
  );
});

// ── sitemap.xml — dynamic, all languages with hreflang ──
app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = langs.map(l => {
    const alternates = langs
      .map(al => `      <xhtml:link rel="alternate" hreflang="${al}" href="https://generatywnie.com/${al}/"/>`)
      .join('\n');
    return `  <url>
    <loc>https://generatywnie.com/${l}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>${l === 'en' ? '1.0' : '0.9'}</priority>
${alternates}
  </url>`;
  }).join('\n');

  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>`
  );
});

// ── root redirect ──
app.get('/', (req, res) => {
  const lang = detectLang(req);
  res.redirect(301, `/${lang}/`);
});

// ── llms.txt per language ──
app.get('/:lang/llms.txt', (req, res) => {
  const lang = req.params.lang;
  if (!LANG_RE.test(lang) || !langs.includes(lang)) return res.status(404).send('Not found');
  const t = (key) => translations[lang][key] || `[MISSING: ${key}]`;

  res.type('text/plain; charset=utf-8').send(
`# Generatywnie: ${t('header.title')}

> ${t('header.subtitle')}

By Szymon P. Pepliński — https://generatywnie.com/${lang}/

## Overview

${t('llms.overview')}

## Core Theses

1. ${t('llms.thesis1')}

2. ${t('llms.thesis2')}

3. ${t('llms.thesis3')}

4. ${t('llms.thesis4')}

5. ${t('llms.thesis5')}

6. ${t('llms.thesis6')}

## Key Concepts

${t('llms.concepts')}

## Key References

- Shoshana Zuboff — data capitalism and surveillance
- Byung-Chul Han — analytics of fatigue and optimization culture
- Kyle Chayka — algorithmic homogenization
- Gilbert Simondon — Du mode d'existence des objets techniques (technical ontology)
- N. Katherine Hayles — How We Became Posthuman (distributed agency)
- Douglas Rushkoff, James Williams — feed-based system critique

## Relevance

${t('llms.relevance')}

## Citation

Pepliński, Szymon P. "Beyond the Loop: A Critical Framework for Non-Recursive Generative Practice." Generatywnie, 2025. https://generatywnie.com/${lang}/
`
  );
});

// ── backward compat: /llms.txt → /en/llms.txt ──
app.get('/llms.txt', (req, res) => {
  res.redirect(301, '/en/llms.txt');
});

// ── validate lang format: exactly 2 lowercase letters ──
const LANG_RE = /^[a-z]{2}$/;

// ── page route ──
app.get('/:lang/', (req, res) => {
  const lang = req.params.lang;
  if (!LANG_RE.test(lang)) return res.status(404).send('Not found');
  if (!langs.includes(lang)) {
    return res.redirect(301, `/${detectLang(req)}/`);
  }

  const locale = translations[lang];
  const t = (key) => locale[key] || `[MISSING: ${key}]`;

  const buildDate = new Date().toISOString().slice(0, 10);

  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.render('page', { lang, langs, t, nonce: res.locals.nonce, buildDate });
});

// ── trailing slash redirect: /en → /en/ ──
app.get('/:lang', (req, res) => {
  const lang = req.params.lang;
  if (LANG_RE.test(lang)) {
    return res.redirect(301, `/${lang}/`);
  }
  res.status(404).send('Not found');
});

// ── error handler — no stack traces in production ──
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Internal Server Error');
});

// ── start ──
app.listen(PORT, () => {
  console.log(`Generatywnie running on port ${PORT}`);
});
