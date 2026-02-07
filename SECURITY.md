# Security Audit — generatywnie.com

Audited: 2026-02-07
Stack: Node.js / Express / EJS / Cloud Run
Status: **all critical and high issues resolved**

---

## 1. Content Security Policy (nonce-based) — CRITICAL

Every request generates a unique cryptographic nonce via `crypto.randomBytes(16)`. Only inline `<script>` and `<style>` elements carrying that nonce execute. Any injected script without the nonce is blocked by the browser.

```
Content-Security-Policy:
  default-src 'none';
  script-src 'nonce-{unique}';
  style-src 'nonce-{unique}' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  connect-src 'self';
  img-src 'self' data: https://generatywnie.com;
  base-uri 'self';
  form-action 'none';
  upgrade-insecure-requests
```

4 inline elements in template carry the nonce: JSON-LD script, generative seed script, style block, reveal script.

Files: `server.js` (middleware), `templates/page.ejs` (nonce attributes)

## 2. JSON-LD Injection Prevention — CRITICAL

The `<script type="application/ld+json">` block uses `JSON.stringify()` to generate the entire JSON blob. All values are properly JSON-encoded, making `</script>` breakout impossible even if a translation value contains malicious strings.

File: `templates/page.ejs` (JSON-LD block)

## 3. Security Headers — HIGH

All responses include:

| Header | Value | Purpose |
|--------|-------|---------|
| X-Content-Type-Options | nosniff | Prevents MIME sniffing |
| X-Frame-Options | DENY | Prevents clickjacking |
| X-XSS-Protection | 1; mode=block | Legacy XSS filter for older browsers |
| Referrer-Policy | strict-origin-when-cross-origin | Limits referrer leakage |
| Permissions-Policy | camera=(), microphone=(), geolocation=() | Disables device APIs |
| Strict-Transport-Security | max-age=63072000; includeSubDomains; preload | HSTS (production only) |
| Content-Security-Policy | (see above) | Prevents XSS, injection |

File: `server.js` (security middleware)

## 4. Translation Sanitization (17-check validator) — HIGH

The `scripts/translate.js` validates Claude API output before saving with 17 checks:

**Structure checks (1-4):**
1. Missing keys (all source keys must be present)
2. Extra keys (auto-removed with warning)
3. Type match (string vs array)
4. Array length match

**Content checks (5-10):**
5. Empty string detection
6. HTML tag pairing (open/close count per allowed tag)
7. Protected strings (14 names/titles that must not be translated)
8. Length sanity (40%-250% of original)
9. Untranslated detection (identical to English, >30 chars)
10. Arrow → symbol preservation

**Security checks (11-17):**
11. Dangerous patterns — 17 regex patterns:
    - `<script>`, `</script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`
    - `<svg>`, `<form>`, `<input>`, `<img>`
    - `javascript:` URI, `onclick=` / `onerror=` handlers
    - `data:text/html`, `expression()`, `url(javascript:)`, `<!-- HTML comment`
12. Disallowed HTML tags (whitelist: only `<strong>`, `<cite>`, `<em>`)
13. HTML entity-encoded tags (`&lt;script&gt;` etc.)
14. Unicode zero-width / bidi override chars (U+200B, U+FEFF, U+00AD, U+202A-202E, etc.)
15. Unicode escape sequences (`\u003c`, `\u003e`)
16. Bulk untranslated check (>30% identical to English = error)
17. `max_tokens` truncation detection (stop_reason check)

**Retry behavior:**
- Max 3 attempts with error feedback to Claude
- `SECURITY:` errors = immediate abort, no retry
- On failure: file NOT saved → server falls back to English

**Logging:**
- Structured JSON logs to `logs/translate-{lang}-{timestamp}.json`
- Full audit trail: attempts, errors, warnings, token usage, stop_reason

Files: `scripts/translate.js`

## 5. Fingerprinting Prevention — HIGH

- `x-powered-by` header disabled (`app.disable('x-powered-by')`)
- Error handler returns generic "Internal Server Error" without stack traces
- `NODE_ENV=production` set in Dockerfile

Files: `server.js`, `Dockerfile`

## 6. Route Validation — MEDIUM

All `/:lang` route parameters validated against `/^[a-z]{2}$/` regex. Strict routing enabled (`app.enable('strict routing')`) to prevent `/en` and `/en/` being treated as the same route. This prevents:

- Path traversal (`/../../etc/passwd`)
- CRLF injection (`/%0d%0a`)
- Unexpected parameter values (`/ABC/`, `/e1/`, `/abc/`)
- Duplicate content at `/en` vs `/en/`

Unknown 2-letter codes redirect 301 to detected language. Everything else gets 404.

File: `server.js` (LANG_RE, strict routing)

## 7. Container Hardening — MEDIUM

- Dockerfile runs as `USER node` (not root)
- `.dockerignore` excludes: node_modules, .git, scripts/, logs/, *.md, .env
- Only production dependencies installed (`npm ci --only=production`)
- Translation script excluded from container (runs in CI/locally only)

Files: `Dockerfile`, `.dockerignore`

## 8. CSP Directives Explained — REFERENCE

| Directive | Value | Why |
|-----------|-------|-----|
| default-src | 'none' | Block everything by default |
| script-src | 'nonce-...' | Only nonced inline scripts |
| style-src | 'nonce-...' + fonts.googleapis.com | Nonced inline + Google Fonts CSS |
| font-src | fonts.gstatic.com | Google Fonts files |
| connect-src | 'self' | No external XHR/fetch |
| img-src | 'self' data: generatywnie.com | Self + SVG data URI + OG image |
| base-uri | 'self' | Prevent base tag injection |
| form-action | 'none' | No forms on site |
| upgrade-insecure-requests | (directive) | Auto-upgrade http → https |

---

## Architecture Security Notes

### Translation files are the trust boundary

The locale JSON files (`locales/*.json`) are loaded at startup and rendered with `<%- %>` (unescaped EJS) because they contain intentional HTML (`<strong>`, `<cite>`). This means:

- **en.json** is hand-written and trusted
- **Generated translations** pass through the 17-check validator in `translate.js`
- **Manual edits** to translation files bypass the validator — review before deploying

### No user input reaches templates

This is a static content site. There are no forms, no query parameters used in rendering, no POST routes. The only dynamic values in templates come from:

1. Pre-loaded JSON files (locale data) — validated at translation time
2. The `lang` parameter — validated against regex + known list
3. The `nonce` — server-generated cryptographic value
4. The `buildDate` — server-generated ISO date string

### Accept-Language header handling

The `detectLang()` function parses the `Accept-Language` header but only uses it to match against the `langs` whitelist. No header value is ever interpolated into HTML or used in file paths.

---

## What is NOT covered (out of scope)

- **DDoS protection**: relies on Cloud Run's built-in scaling/rate limiting
- **WAF**: no web application firewall (consider Cloud Armor for production)
- **Dependency vulnerabilities**: run `npm audit` regularly
- **TLS configuration**: handled by Cloud Run's managed load balancer
- **Privacy Policy**: not applicable — site collects zero user data, no cookies, no analytics

---

## Test Coverage

### Integration tests (server)
- All security headers present and correct
- CSP nonce uniqueness per request
- CSP nonce matching between header and HTML (4/4 elements)
- JSON-LD validity (parseable JSON, no EJS leaks)
- No `<script>` injection beyond expected elements
- No inline event handlers
- No `[MISSING]` key exposure
- Route validation (404 for invalid paths, 301 for unknown langs)
- Strict routing (/en → 301 → /en/)
- CRLF injection resistance
- No stack traces in error responses
- Static routes (robots.txt, sitemap.xml, llms.txt)

### Validator unit tests (31 tests)
- Schema errors: missing keys, type mismatch, array length
- Content: empty strings, length sanity, protected strings, arrow preservation
- HTML integrity: tag pairing, disallowed tags
- Security: XSS injection (script, onclick, javascript:, iframe, SVG, form, img)
- Security: HTML comment injection
- Security: CSS expression() injection
- Security: entity-encoded tags (&lt;script&gt;)
- Security: unicode zero-width / bidi chars (U+200B, U+202E, U+00AD)
- Security: unicode escape sequences (\u003c)
- Security: bulk untranslated detection
