// Application schema validation does not verify source existence or authorize actions.
export const VERSION = "deixic.account-brief.v1";
export const FORMAT_INSTRUCTION = ' Return only JSON with schemaVersion "deixic.account-brief.v1", accountName '
  + '(the requested name), summary (null or {text, sourceIds}), opportunities '
  + '([{name, stage, sourceIds}]), risks ([{description, sourceIds}]), sources '
  + '([{id, system, resourceId}]), and missingData ([strings]). No extra fields '
  + 'or markdown. Every factual item must reference at least one sources.id. '
  + 'Use null summary and empty lists when facts are unavailable, explaining '
  + 'the missing data. Never invent records, references or opportunities.';

export function parseAccountBrief(body) {
  const brief = JSON.parse(body);
  const invalid = () => { throw new Error("Invalid account-brief result"); };
  // JSON.parse accepts duplicate keys. Reject them before validating the projection.
  const tokens = body.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g);
  const scopes = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const key = JSON.parse(token);
      const keys = scopes.at(-1);
      if (keys.has(key)) invalid();
      keys.add(key);
    }
  }
  const fields = (value, names) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
  };
  const text = value => { if (typeof value !== "string" || !value.trim()) invalid(); };
  const items = value => { if (!Array.isArray(value) || value.length > 100) invalid(); return value; };
  fields(brief, ["schemaVersion", "accountName", "summary", "opportunities", "risks", "sources", "missingData"]);
  if (brief.schemaVersion !== VERSION) invalid();
  text(brief.accountName);
  const ids = new Set();
  for (const source of items(brief.sources)) {
    fields(source, ["id", "system", "resourceId"]);
    Object.values(source).forEach(text);
    if (ids.has(source.id)) invalid();
    ids.add(source.id);
  }
  const fact = (value, names) => {
    fields(value, [...names, "sourceIds"]);
    names.forEach(name => text(value[name]));
    const refs = items(value.sourceIds);
    if (!refs.length || refs.some(ref => typeof ref !== "string" || !ids.has(ref))
      || new Set(refs).size !== refs.length) invalid();
  };
  if (brief.summary !== null) fact(brief.summary, ["text"]);
  items(brief.opportunities).forEach(item => fact(item, ["name", "stage"]));
  items(brief.risks).forEach(item => fact(item, ["description"]));
  items(brief.missingData).forEach(text);
  if (brief.summary === null && !brief.missingData.length) invalid();
  return brief;
}
