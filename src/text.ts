export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug || "change";
}

export function lastLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.at(-1) ?? "The command stopped without an explanation.";
  return line.slice(0, 240);
}

export function extractUrl(output: string): string {
  const matches = output.match(/https?:\/\/[^\s]+/g);
  return matches?.at(-1)?.replace(/[).,]+$/g, "") ?? "";
}

export function tail(output: string, max = 1200): string {
  const clean = output.replace(/```/g, "'''").trim();
  if (clean.length <= max) return clean;
  return `...${clean.slice(-max)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function headlineFrom(request: string): string {
  const match = request.match(/headline to\s+["“]?(.+?)["”]?\s*$/i);
  const raw = (match?.[1] ?? request).replace(/^["“]|["”]$/g, "").trim();
  const compact = raw.replace(/\s+/g, " ");
  return compact.slice(0, 80) || "Welcome";
}
