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
      throttle: { type: "boolean", default: false },
    },
    strict: false,
  });

  let site = values.site as string | undefined;
  let domains = values.domains as string | undefined;
  let destination = (values.destination as string) || "out";
  const throttle = (values.throttle as boolean) || false;

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
  log(`Throttle:    ${throttle ? "on (1s delay)" : "off"}\n`);

  await crawl(site, allowedDomains, destination, throttle);

  closeLogger();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
