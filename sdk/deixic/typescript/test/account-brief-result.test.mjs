import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountBrief } from "../examples/account-brief-result.mjs";

const brief = { schemaVersion: "deixic.account-brief.v1", accountName: "Example account",
  summary: { text: 'Account with a quoted name: "Acme"', sourceIds: ["account"] },
  opportunities: [{ name: "Renewal", stage: "Open", sourceIds: ["account"] }],
  risks: [], sources: [{ id: "account", system: "crm", resourceId: "account-1" }], missingData: [] };

test("application parser validates linked facts and missing data", () => {
  assert.deepEqual(parseAccountBrief(JSON.stringify(brief)), brief);
  const unavailable = { ...brief, summary: null, opportunities: [], sources: [], missingData: ["CRM unavailable"] };
  assert.deepEqual(parseAccountBrief(JSON.stringify(unavailable)), unavailable);
});
for (const fault of ["extra", "unlinked", "duplicate_source", "empty_text", "wrong_type", "missing_explanation", "version"]) {
  test(`application parser rejects ${fault}`, () => {
    const value = structuredClone(brief);
    if (fault === "extra") value.unexpected = true;
    if (fault === "unlinked") value.summary.sourceIds = ["invented"];
    if (fault === "duplicate_source") value.sources.push(value.sources[0]);
    if (fault === "empty_text") value.summary.text = " ";
    if (fault === "wrong_type") value.opportunities = "not a list";
    if (fault === "missing_explanation") { value.summary = null; value.missingData = []; }
    if (fault === "version") value.schemaVersion = "future";
    assert.throws(() => parseAccountBrief(JSON.stringify(value)));
  });
}
test("duplicate JSON keys, including escaped keys, are rejected at every depth", () => {
  const body = JSON.stringify(brief);
  assert.throws(() => parseAccountBrief(body.replace('"accountName":', '"accountName":"Other","accountName":')));
  assert.throws(() => parseAccountBrief(body.replace('"text":', '"text":"Other","te\\u0078t":')));
  assert.throws(() => parseAccountBrief(body.replace('"system":', '"system":"Other","system":')));
});
