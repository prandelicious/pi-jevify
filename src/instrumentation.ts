const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}
export function inspectDeclarations(payload: unknown): {
  names: string[];
  bytes: number | null;
  estimatedTokens: number | null;
  exact: boolean;
  format: string;
} {
  if (!record(payload))
    return {
      names: [],
      bytes: null,
      estimatedTokens: null,
      exact: false,
      format: "unsupported",
    };
  const declarations =
    payload.tools ??
    payload.functions ??
    (record(payload.config) ? payload.config.tools : undefined) ??
    (record(payload.toolConfig) ? payload.toolConfig.tools : undefined);
  if (declarations === undefined)
    return {
      names: [],
      bytes: 0,
      estimatedTokens: 0,
      exact: true,
      format: "none",
    };
  if (!Array.isArray(declarations))
    return {
      names: [],
      bytes: null,
      estimatedTokens: null,
      exact: false,
      format: "unsupported",
    };
  const names: string[] = [];
  let known = true;
  for (const item of declarations) {
    if (!record(item)) {
      known = false;
      continue;
    }
    if (typeof item.name === "string") names.push(item.name);
    else if (record(item.function) && typeof item.function.name === "string")
      names.push(item.function.name);
    else if (record(item.toolSpec) && typeof item.toolSpec.name === "string")
      names.push(item.toolSpec.name);
    else if (Array.isArray(item.functionDeclarations))
      for (const f of item.functionDeclarations) {
        if (record(f) && typeof f.name === "string") names.push(f.name);
        else known = false;
      }
    else if (typeof item.type === "string") names.push(`provider:${item.type}`);
    else known = false;
  }
  const bytes = Buffer.byteLength(JSON.stringify(declarations), "utf8");
  return {
    names,
    bytes,
    estimatedTokens: estimatedTokens(bytes),
    exact: known,
    format: payload.functions ? "legacy-functions" : "tools",
  };
}
export function inspectSkills(prompt: string): {
  bytes: number;
  estimatedTokens: number;
  sections: number;
} {
  const sections =
    prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/g) ?? [];
  const bytes = Buffer.byteLength(sections.join("\n"), "utf8");
  return {
    bytes,
    estimatedTokens: estimatedTokens(bytes),
    sections: sections.length,
  };
}
