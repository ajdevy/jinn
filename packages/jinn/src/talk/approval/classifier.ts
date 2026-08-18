export type ApprovalClassification =
  | { kind: "approve"; choice?: string }
  | { kind: "reject" }
  | { kind: "modify" | "unrelated" | "ambiguous" };

export function normalizeApprovalTranscript(value: string): string {
  return value.trim().replace(/[.!?]+$/u, "").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function classifyApprovalTranscript(value: string, options: readonly string[] | null): ApprovalClassification {
  const spoken = normalizeApprovalTranscript(value);
  if (spoken === "reject") return { kind: "reject" };
  if (!options?.length && spoken === "approve") return { kind: "approve" };
  const choice = options?.find((candidate) => spoken === `approve ${normalizeApprovalTranscript(candidate)}`);
  if (choice) return { kind: "approve", choice };
  if (/\b(change|modify|instead|after|but|except|with|before)\b/u.test(spoken)) return { kind: "modify" };
  if (/\b(approve|approved|reject|rejected|yes|no|maybe|perhaps|sure|okay|ok)\b/u.test(spoken)) return { kind: "ambiguous" };
  return { kind: "unrelated" };
}
