export interface AccountBriefSource {
  id: string;
  system: string;
  resourceId: string;
}
export interface AccountBrief {
  schemaVersion: "deixic.account-brief.v1";
  accountName: string;
  summary: { text: string; sourceIds: string[] } | null;
  opportunities: { name: string; stage: string; sourceIds: string[] }[];
  risks: { description: string; sourceIds: string[] }[];
  sources: AccountBriefSource[];
  missingData: string[];
}
export const VERSION: "deixic.account-brief.v1";
export const FORMAT_INSTRUCTION: string;
/** Validate the application format and reference linkage, not source truth. */
export function parseAccountBrief(body: string): AccountBrief;
