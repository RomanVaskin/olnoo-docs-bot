export type PolicyEmailMessage = {
  email: string;
  insurer: "ingos" | "reso";
  policyNumber: string;
  pdfPath: string;
};

/** Integration seam for the existing mail provider when one is selected.
 * TODO(email-provider): implement this without introducing an unapproved
 * external service; policy issuance must not depend on email delivery. */
export async function sendIssuedPolicyEmail(_message: PolicyEmailMessage): Promise<void> {
  throw new Error("Отправка email не настроена");
}
