# SiteCrawler3000

Download an entire website by crawling its sitemap. Works similarly to `wget --mirror` but with automatic asset discovery and reference rewriting.

## How it works

1. Fetches `sitemap.txt` (falls back to `sitemap.xml`, then the root page)
2. Downloads all HTML pages, discovering linked pages along the way
3. Extracts and downloads assets from HTML (CSS, JS, images, fonts, srcset, meta images)
4. Parses CSS for `url()` and `@import` references, downloading sub-assets
5. Rewrites all references in HTML and CSS to relative paths pointing to local files

The local file structure mirrors the URL structure (`hostname/path/file`), with invalid filesystem characters replaced.

## Usage

```bash
# Install dependencies
pnpm install

# Run (prompts for missing args)
pnpm start

# Full args
pnpm start -- --site https://example.com --domains cdn.example.com,static.example.com --destination out --throttle
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--site` | Site URL to crawl | *(prompted)* |
| `--domains` | Comma-separated extra domains to allow for asset downloads (CDNs, etc.) | *(prompted)* |
| `--destination` | Output folder | `out` |
| `--throttle` | Wait 1 second between requests | `false` |

## Building

```bash
pnpm run build
```
