import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const match = html.match(/<h1>([^<]+)<\/h1>/);

if (!match || !match[1].trim()) {
  console.error("Homepage is missing a headline.");
  process.exit(1);
}

console.log(`Homepage looks good: ${match[1].trim()}`);
