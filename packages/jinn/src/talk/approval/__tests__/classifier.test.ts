import { describe, expect, it } from "vitest";
import { classifyApprovalTranscript } from "../classifier.js";

describe("approval transcript classifier", () => {
  it("accepts only exact bounded decisions", () => {
    expect(classifyApprovalTranscript("Approve.", null)).toEqual({ kind: "approve" });
    expect(classifyApprovalTranscript("reject", null)).toEqual({ kind: "reject" });
    expect(classifyApprovalTranscript("approve blue lane", ["Blue lane", "Red lane"]))
      .toEqual({ kind: "approve", choice: "Blue lane" });
  });

  it.each([
    ["don't approve", "ambiguous"], ["approve maybe", "ambiguous"], ["approve after changing it", "modify"],
    ["approve or reject", "ambiguous"], ["yes", "ambiguous"], ["what is this?", "unrelated"], ["", "unrelated"],
  ])("classifies %s as %s without approving", (spoken, kind) => {
    expect(classifyApprovalTranscript(spoken, null).kind).toBe(kind);
  });
});
