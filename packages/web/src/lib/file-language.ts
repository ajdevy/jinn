/** Map a file extension to a Prism language identifier. Falls back to plaintext. */
export const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  css: "css",
  scss: "scss",
  less: "less",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "docker",
  md: "markdown",
  markdown: "markdown",
};

export const MARKDOWN_EXTS = new Set(["md", "markdown"]);

/** Extract a lowercase extension (without the dot) from a path, "" if none. */
export function getExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.toLowerCase(); // e.g. "Dockerfile" → "dockerfile"
  return base.slice(dot + 1).toLowerCase();
}
