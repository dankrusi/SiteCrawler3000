import * as fs from "node:fs";
import { parseArgs } from "node:util";
import * as readline from "node:readline";
import { crawl } from "./crawler.js";
import { initLogger, closeLogger, log } from "./logger.js";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      domains: { type: "string" },
      destination: { type: "string", default: "out" },
      delay: { type: "string" },
      urls: { type: "string", multiple: true },
      "no-discover": { type: "boolean", default: false },
    },
    strict: false,
  });

  let site = values.site as string | undefined;
  let domains = values.domains as string | undefined;
  let destination = (values.destination as string) || "out";
  const delay = values.delay ? parseInt(values.delay as string, 10) : 0;
  const urlsFiles = values.urls as string[] | undefined;
  const noDiscover = values["no-discover"] as boolean;

  if (!site) {
    site = await prompt("Enter site URL (e.g. https://example.com): ");
    if (!site) {
      console.error("Site URL is required.");
      process.exit(1);
    }
  }

  if (!domains) {
    domains = await prompt(
      "Enter additional asset domains (comma-separated, or press Enter for none): "
    );
  }

  // Normalize site URL
  if (!site.startsWith("http://") && !site.startsWith("https://")) {
    site = "https://" + site;
  }
  site = site.replace(/\/+$/, "");

  const siteUrl = new URL(site);
  const allowedDomains = new Set<string>([siteUrl.hostname]);
  if (domains) {
    for (const d of domains.split(",")) {
      const trimmed = d.trim();
      if (trimmed) allowedDomains.add(trimmed);
    }
  }

  initLogger();

  log(`\nSite:        ${site}`);
  log(`Domains:     ${[...allowedDomains].join(", ")}`);
  log(`Destination: ${destination}`);
  log(`Delay:       ${delay > 0 ? `${delay}ms` : "off"}`);
  log(`URL files:   ${urlsFiles?.length ? urlsFiles.join(", ") : "none (using sitemap)"}`);
  log(`Discover:    ${noDiscover ? "off" : "on"}\n`);

  let urls: string[] | undefined;
  if (urlsFiles && urlsFiles.length > 0) {
    urls = [];
    for (const urlsFile of urlsFiles) {
      if (!fs.existsSync(urlsFile)) {
        console.error(`URL file not found: ${urlsFile}`);
        process.exit(1);
      }
      const lines = fs.readFileSync(urlsFile, "utf-8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      urls.push(...lines);
      log(`Loaded ${lines.length} URL(s) from ${urlsFile}`);
    }
    log(`Total: ${urls.length} URL(s) from ${urlsFiles.length} file(s)\n`);
  }

  await crawl(site, allowedDomains, destination, delay, urls, noDiscover);

  closeLogger();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
