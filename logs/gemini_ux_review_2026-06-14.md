# Gemini UX Review — 2026-06-14

## Overall UX verdict
These changes represent a substantial leap forward in clarity and transparency, particularly in the Review Queue and job status reporting, effectively addressing customer confusion around "what was ordered vs what was produced" and simplifying complex workflows.

## Strengths
*   **Enhanced Clarity in Review Queue:** The explicit separation of "What was ordered" and "What was produced" columns, combined with human-readable labels for enhancements and detailed source information (submitted clips vs. used in output), drastically improves transparency and the reviewer's ability to understand discrepancies.
*   **Improved Job Status Reporting:** Presenting "processing" instead of internal jargon like "operator_review" and showing "failed" for "zombie" jobs significantly reduces customer confusion and aligns job statuses with user expectations.
*   **Proactive User Guidance in Wizard:** Template clip min/max enforcement with amber hints effectively guides users during job creation, preventing errors and improving the initial submission quality.
*   **Richer Contextual Information:** The addition of "Submitted via," "Brand," "Topic," and "Tone" fields provides crucial metadata, offering a more complete picture of each job for review.
*   **Relevant Dashboard Data:** Limiting system error tiles to the last 24 hours ensures the dashboard focuses on current, actionable information, improving its utility.

## Issues / confusion risks
*   **Medium: "GPT-4o QA" Jargon in FeatureComplianceSection:** While internally accurate, the label "GPT-4o QA" is technical and might be confusing for customers. It doesn't immediately convey the *purpose* or *benefit* of this section from a user's perspective. It could imply internal processing rather than a clear quality or compliance check.
*   **Medium: New Wizard Features - Missing Explanations (Show/film path, PiP URL, HeyGen/Imagen):** The introduction of new input fields for advanced features is great, but without clear inline explanations, tooltips, or contextual help, users might struggle to understand their purpose, expected input format, or how these features integrate into their video production. This could lead to incorrect submissions or underutilization of new capabilities.
*   **Low: OrderOriginBanner Message Specificity:** The amber warning for jobs not from the dashboard wizard is a good alert. However, the exact message needs to be carefully crafted to be informative and helpful (e.g., explaining *why* it's a warning or what implications it might have for interaction with the dashboard) rather than just stating the origin.
*   **Low: Clarity of "Fallback" in Template Row:** While "fallback" is technically correct, ensuring the UI clearly explains *why* a fallback template was used (e.g., "Original template unavailable, automatically applied default: [Fallback Template Name]") would provide better context to the user.

## Quick wins for next session
1.  **Rename "GPT-4o QA" to "AI Quality Check" or "Production Checklist"** in the FeatureComplianceSection, and add a tooltip explaining its role in ensuring video quality and compliance.
2.  **Add concise, descriptive tooltips or inline help text** next to the new wizard fields ("Show/film path," "PiP URL," HeyGen/Imagen features) to clarify their function and expected input format.
3.  **Refine the OrderOriginBanner message** to be more specific and helpful, e.g., "This job was created outside the dashboard wizard. Some fields may not be editable or fully trackable here."
