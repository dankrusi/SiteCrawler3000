import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import { log, warn, error } from "./logger.js";

// Tracks every downloaded resource
interface DownloadEntry {
  url: string; // original absolute URL
  localPath: string; // path on disk relative to destination
  contentType: string;
  isPage: boolean;
}

const downloaded = new Map<string, DownloadEntry>(); // keyed by normalized URL
const failed = new Set<string>();
let destination = "out";
let allowedDomains = new Set<string>();
let siteOrigin = "";
let throttle = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── URL helpers ──────────────────────────────────────────────────────────────

function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    u.hash = "";
    // drop trailing slash for consistency (except root)
    let s = u.href;
    if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

function isDomainAllowed(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return allowedDomains.has(hostname);
  } catch {
    return false;
  }
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

function sanitizeSegment(seg: string): string {
  // Replace characters invalid on Windows/most FS
  return seg.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/\.+$/, "_");
}

function urlToLocalPath(urlStr: string, isPage: boolean): string {
  const u = new URL(urlStr);
  let pathname = decodeURIComponent(u.pathname);

  // All files go under the main site hostname folder.
  // For external domains, nest under _assets/<domain> to avoid collisions.
  const siteHostname = new URL(siteOrigin).hostname;
  const segments = [sanitizeSegment(siteHostname)];
  if (u.hostname !== siteHostname) {
    segments.push("_assets", sanitizeSegment(u.hostname));
  }

  const parts = pathname.split("/").filter(Boolean);
  for (const p of parts) {
    segments.push(sanitizeSegment(p));
  }

  // If this is a page and has no extension, add index.html
  if (isPage) {
    const last = segments[segments.length - 1];
    if (!last || !last.includes(".")) {
      segments.push("index.html");
    } else if (!last.match(/\.html?$/i)) {
      // e.g. /about -> about/index.html to avoid confusion
      segments.push("index.html");
    }
  }

  // If it's an asset with no extension, keep as-is (binary blob)
  if (!isPage && segments.length > 0) {
    const last = segments[segments.length - 1];
    // If path ends with / treat it as index
    if (!last || pathname.endsWith("/")) {
      segments.push("index.html");
    }
  }

  // Append query string hash to filename to differentiate variants
  if (u.search) {
    const last = segments.pop()!;
    const ext = path.extname(last);
    const base = last.slice(0, last.length - ext.length);
    const querySafe = u.search.slice(1).replace(/[<>:"|?*&=\x00-\x1f]/g, "_");
    segments.push(`${base}_${querySafe}${ext}`);
  }

  return segments.join("/");
}

// ── Download ─────────────────────────────────────────────────────────────────

async function fetchUrl(
  url: string
): Promise<{ data: Buffer; contentType: string } | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SiteCrawler3000/1.0)",
        Accept: "*/*",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      warn(`  ⚠ ${resp.status} ${url}`);
      return null;
    }
    const ct = resp.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (throttle) await sleep(1000);
    return { data: buf, contentType: ct };
  } catch (err: any) {
    error(`  ⚠ fetch error ${url}: ${err.message}`);
    return null;
  }
}

async function download(
  url: string,
  isPage: boolean
): Promise<DownloadEntry | null> {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  if (downloaded.has(norm)) return downloaded.get(norm)!;
  if (failed.has(norm)) return null;

  if (!isDomainAllowed(norm)) return null;

  const localPath = urlToLocalPath(norm, isPage);
  const fullPath = path.join(destination, localPath);

  log(`  ↓ ${norm}`);

  const result = await fetchUrl(norm);
  if (!result) {
    failed.add(norm);
    return null;
  }

  // Write file
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, result.data);

  const entry: DownloadEntry = {
    url: norm,
    localPath,
    contentType: result.contentType,
    isPage,
  };
  downloaded.set(norm, entry);
  return entry;
}

// ── Sitemap parsing ──────────────────────────────────────────────────────────

async function fetchSitemapUrls(siteUrl: string): Promise<string[]> {
  const urls: string[] = [];

  // Try sitemap.txt first
  const txtUrl = siteUrl + "/sitemap.txt";
  log(`Fetching sitemap: ${txtUrl}`);
  let result = await fetchUrl(txtUrl);
  if (result) {
    const text = result.data.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && trimmed.startsWith("http")) {
        urls.push(trimmed);
      }
    }
    if (urls.length > 0) return urls;
  }

  // Fallback to sitemap.xml
  const xmlUrl = siteUrl + "/sitemap.xml";
  log(`Trying sitemap.xml: ${xmlUrl}`);
  result = await fetchUrl(xmlUrl);
  if (result) {
    const text = result.data.toString("utf-8");
    const locMatches = text.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi);
    for (const m of locMatches) {
      urls.push(m[1]);
    }
    if (urls.length > 0) return urls;
  }

  // Last resort: just crawl the root page
  log("No sitemap found, will crawl from root page.");
  urls.push(siteUrl + "/");
  return urls;
}

// ── HTML asset extraction ────────────────────────────────────────────────────

interface ExtractedRefs {
  pages: string[];
  assets: string[];
}

function extractRefs(html: string, baseUrl: string): ExtractedRefs {
  const $ = cheerio.load(html);
  const pages: string[] = [];
  const assets: string[] = [];

  // Links to other pages
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = normalizeUrl(href, baseUrl);
    if (abs && isDomainAllowed(abs)) {
      // Treat as page if same origin and looks like a page (not a file extension for assets)
      try {
        const u = new URL(abs);
        const ext = path.extname(u.pathname).toLowerCase();
        const assetExts = [
          ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg",
          ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf",
          ".zip", ".mp4", ".webm", ".mp3", ".ogg",
        ];
        if (assetExts.includes(ext)) {
          assets.push(abs);
        } else if (u.origin === new URL(baseUrl).origin) {
          pages.push(abs);
        }
      } catch { /* skip */ }
    }
  });

  // CSS
  $('link[rel="stylesheet"][href], link[rel="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]').each(
    (_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const abs = normalizeUrl(href, baseUrl);
        if (abs) assets.push(abs);
      }
    }
  );

  // Scripts
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) {
      const abs = normalizeUrl(src, baseUrl);
      if (abs) assets.push(abs);
    }
  });

  // Images
  $("img[src], img[data-src]").each((_, el) => {
    for (const attr of ["src", "data-src"]) {
      const val = $(el).attr(attr);
      if (val) {
        const abs = normalizeUrl(val, baseUrl);
        if (abs) assets.push(abs);
      }
    }
  });

  // Source elements (picture, video, audio)
  $("source[src], source[srcset]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) {
      const abs = normalizeUrl(src, baseUrl);
      if (abs) assets.push(abs);
    }
    const srcset = $(el).attr("srcset");
    if (srcset) {
      for (const entry of srcset.split(",")) {
        const u = entry.trim().split(/\s+/)[0];
        if (u) {
          const abs = normalizeUrl(u, baseUrl);
          if (abs) assets.push(abs);
        }
      }
    }
  });

  // srcset on img
  $("img[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (srcset) {
      for (const entry of srcset.split(",")) {
        const u = entry.trim().split(/\s+/)[0];
        if (u) {
          const abs = normalizeUrl(u, baseUrl);
          if (abs) assets.push(abs);
        }
      }
    }
  });

  // Alternate language links (hreflang)
  $('link[rel="alternate"][href]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const abs = normalizeUrl(href, baseUrl);
      if (abs && isDomainAllowed(abs)) {
        pages.push(abs);
      }
    }
  });

  // Inline style url() references (e.g. background-image)
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (style) {
      const styleUrls = extractCssUrls(style, baseUrl);
      for (const u of styleUrls) {
        if (isDomainAllowed(u)) assets.push(u);
      }
    }
  });

  // Open Graph / meta images
  $("meta[content]").each((_, el) => {
    const prop = $(el).attr("property") || $(el).attr("name") || "";
    if (prop.includes("image") || prop.includes("icon")) {
      const content = $(el).attr("content");
      if (content) {
        const abs = normalizeUrl(content, baseUrl);
        if (abs) assets.push(abs);
      }
    }
  });

  // Inline <script> blocks: extract quoted paths that look like assets
  $("script:not([src])").each((_, el) => {
    const code = $(el).html();
    if (!code) return;
    const re = /["'](\/[^"'\s]+\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot|mp4|webm|mp3|ogg|pdf))["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const abs = normalizeUrl(m[1], baseUrl);
      if (abs && isDomainAllowed(abs)) assets.push(abs);
    }
  });

  return { pages, assets };
}

// Extract url() references from CSS
function extractCssUrls(css: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*['"]?(.*?)['"]?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const raw = m[1];
    if (raw.startsWith("data:")) continue;
    const abs = normalizeUrl(raw, baseUrl);
    if (abs) urls.push(abs);
  }
  // Also @import
  const importRe = /@import\s+['"]([^'"]+)['"]/gi;
  while ((m = importRe.exec(css)) !== null) {
    const abs = normalizeUrl(m[1], baseUrl);
    if (abs) urls.push(abs);
  }
  return urls;
}

// ── Main crawl loop ──────────────────────────────────────────────────────────

export async function crawl(
  siteUrl: string,
  domains: Set<string>,
  dest: string,
  enableThrottle: boolean = false
) {
  destination = dest;
  allowedDomains = domains;
  siteOrigin = new URL(siteUrl).origin;
  throttle = enableThrottle;

  // 1. Get page list from sitemap
  const sitemapUrls = await fetchSitemapUrls(siteUrl);
  log(`\nFound ${sitemapUrls.length} URL(s) in sitemap.\n`);

  // 2. Download all pages & discover assets
  const pageQueue = [...sitemapUrls];
  const seen = new Set<string>();
  const assetQueue: string[] = [];

  log("=== Downloading pages ===");
  while (pageQueue.length > 0) {
    const url = pageQueue.shift()!;
    const norm = normalizeUrl(url, siteOrigin);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    const entry = await download(norm, true);
    if (!entry) continue;

    // Parse HTML for refs
    const fullPath = path.join(destination, entry.localPath);
    const html = fs.readFileSync(fullPath, "utf-8");
    const refs = extractRefs(html, norm);

    for (const p of refs.pages) {
      const pn = normalizeUrl(p);
      if (pn && !seen.has(pn)) pageQueue.push(pn);
    }
    for (const a of refs.assets) {
      assetQueue.push(a);
    }
  }

  // 3. Download all assets (including CSS sub-assets)
  log("\n=== Downloading assets ===");
  const assetSeen = new Set<string>();
  while (assetQueue.length > 0) {
    const url = assetQueue.shift()!;
    const norm = normalizeUrl(url);
    if (!norm || assetSeen.has(norm)) continue;
    assetSeen.add(norm);

    const entry = await download(norm, false);
    if (!entry) continue;

    // If CSS, parse for sub-assets
    if (
      entry.contentType.includes("css") ||
      entry.localPath.endsWith(".css")
    ) {
      const fullPath = path.join(destination, entry.localPath);
      const css = fs.readFileSync(fullPath, "utf-8");
      const subUrls = extractCssUrls(css, norm);
      for (const su of subUrls) {
        if (!assetSeen.has(su)) assetQueue.push(su);
      }
    }
  }

  // 4. Final pass: rewrite all references in HTML and CSS
  log("\n=== Rewriting references ===");
  rewriteAll();

  log(
    `\nDone! Downloaded ${downloaded.size} files to ./${destination}/`
  );
}

// ── Rewrite pass ─────────────────────────────────────────────────────────────

function buildLookup(): Map<string, string> {
  // Map from original URL -> localPath
  const map = new Map<string, string>();
  for (const [url, entry] of downloaded) {
    map.set(url, entry.localPath);
  }
  return map;
}

function relativePath(from: string, to: string): string {
  const fromDir = path.posix.dirname(from);
  let rel = path.posix.relative(fromDir, to);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function rewriteAll() {
  const lookup = buildLookup();

  for (const [, entry] of downloaded) {
    const fullPath = path.join(destination, entry.localPath);
    if (!fs.existsSync(fullPath)) continue;

    if (entry.isPage || entry.contentType.includes("html")) {
      rewriteHtml(fullPath, entry.localPath, lookup);
    } else if (
      entry.contentType.includes("css") ||
      entry.localPath.endsWith(".css")
    ) {
      rewriteCss(fullPath, entry.localPath, lookup);
    }
  }
}

function htmlEncodeUrl(url: string): string {
  return url.replace(/&/g, "&amp;");
}

function replaceUrlVariants(
  html: string,
  originalUrl: string,
  rel: string
): string {
  // Build all variants of the URL that might appear in the raw HTML
  const variants: string[] = [originalUrl];

  // HTML-entity-encoded version (& -> &amp;) - critical for URLs with query params
  const ampEncoded = htmlEncodeUrl(originalUrl);
  if (ampEncoded !== originalUrl) variants.push(ampEncoded);

  try {
    const u = new URL(originalUrl);

    // Protocol-relative
    const protoRel = "//" + u.host + u.pathname + u.search;
    variants.push(protoRel);
    const protoRelAmp = htmlEncodeUrl(protoRel);
    if (protoRelAmp !== protoRel) variants.push(protoRelAmp);

    // Path-only for same-origin refs (including root "/")
    if (u.origin === siteOrigin) {
      const pathOnly = u.pathname + u.search;
      if (pathOnly.length >= 1) {
        variants.push(pathOnly);
        const pathOnlyAmp = htmlEncodeUrl(pathOnly);
        if (pathOnlyAmp !== pathOnly) variants.push(pathOnlyAmp);
      }
    }
  } catch { /* skip */ }

  // Sort longest first to avoid partial replacements
  variants.sort((a, b) => b.length - a.length);

  for (const variant of variants) {
    const escaped = escapeRegex(variant);
    // Match URL in quotes or parentheses (attribute values & url())
    const pattern = new RegExp(
      `(["'(])\\s*${escaped}\\s*(["')])`,
      "g"
    );
    html = html.replace(pattern, (_, open, close) => `${open}${rel}${close}`);
  }

  return html;
}

function rewriteHtml(
  filePath: string,
  localPath: string,
  lookup: Map<string, string>
) {
  let html = fs.readFileSync(filePath, "utf-8");

  // Build a sorted list of URLs to replace (longest first to avoid partial matches)
  const urlsToReplace = [...lookup.keys()].sort(
    (a, b) => b.length - a.length
  );

  for (const originalUrl of urlsToReplace) {
    const targetLocal = lookup.get(originalUrl)!;
    const rel = relativePath(localPath, targetLocal);
    html = replaceUrlVariants(html, originalUrl, rel);
  }

  fs.writeFileSync(filePath, html);
}

function rewriteCss(
  filePath: string,
  localPath: string,
  lookup: Map<string, string>
) {
  let css = fs.readFileSync(filePath, "utf-8");

  const urlsToReplace = [...lookup.keys()].sort(
    (a, b) => b.length - a.length
  );

  for (const originalUrl of urlsToReplace) {
    const targetLocal = lookup.get(originalUrl)!;
    const rel = relativePath(localPath, targetLocal);
    const escaped = escapeRegex(originalUrl);

    // url("...")  url('...')  url(...)
    css = css.replace(
      new RegExp(`url\\(\\s*['"]?${escaped}['"]?\\s*\\)`, "g"),
      `url(${rel})`
    );

    // @import "..."
    css = css.replace(
      new RegExp(`@import\\s+['"]${escaped}['"]`, "g"),
      `@import "${rel}"`
    );

    // Also path-only for same-origin (including root path)
    try {
      const u = new URL(originalUrl);
      if (u.origin === siteOrigin) {
        const pathOnly = u.pathname + u.search;
        if (pathOnly.length >= 1) {
          const escapedPath = escapeRegex(pathOnly);
          css = css.replace(
            new RegExp(`url\\(\\s*['"]?${escapedPath}['"]?\\s*\\)`, "g"),
            `url(${rel})`
          );
        }
      }
    } catch { /* skip */ }
  }

  fs.writeFileSync(filePath, css);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
