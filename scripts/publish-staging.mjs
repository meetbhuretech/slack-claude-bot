import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR;
if (!dataDir) {
  console.error("DATA_DIR is not set, so staging has nowhere to go.");
  process.exit(1);
}

const dest = path.join(dataDir, "staging");
mkdirSync(dest, { recursive: true });

let copied = 0;
for (const file of ["index.html", "styles.css"]) {
  const from = path.join(process.cwd(), file);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(dest, file));
  copied += 1;
}

if (copied === 0) {
  console.error("Nothing to publish. The project has no index.html.");
  process.exit(1);
}

const base = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
console.log(`${base}/staging/`);
