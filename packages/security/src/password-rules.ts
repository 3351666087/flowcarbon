/**
 * The password rules, free of Node APIs so the web app can show them as a live checklist while someone types and
 * the API can enforce exactly the same thing. NIST SP 800-63B style: length, a deny-list, no composition rules.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// a short deny-list of passwords that pass the length rule but appear at the top of breach corpora
const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwertyuiop12",
  "passwordpassword",
  "iloveyou1234",
  "administrator",
  "flowcarbon123",
]);

export interface PasswordCheck {
  /** between PASSWORD_MIN_LENGTH and PASSWORD_MAX_LENGTH characters */
  length: boolean;
  /** not on the deny-list */
  notCommon: boolean;
  /** does not contain the part of the email before the @; null when there is no email name to compare with */
  noEmailName: boolean | null;
}

export function checkPassword(password: string, email?: string): PasswordCheck {
  const lower = password.toLowerCase();
  const local = email?.split("@")[0]?.toLowerCase();
  return {
    length: password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH,
    notCommon: !COMMON.has(lower),
    noEmailName: local && local.length >= 4 ? !lower.includes(local) : null,
  };
}

/** Returns the problems with a proposed password; empty when acceptable. */
export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  const check = checkPassword(password, context.email);
  if (!check.notCommon) problems.push("This password is too common.");
  if (check.noEmailName === false) problems.push("Do not include your email name in the password.");
  return problems;
}
