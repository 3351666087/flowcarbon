"use client";

import { checkPassword } from "@flowcarbon/security/password-rules";
import { clsx } from "clsx";
import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * The password rules under a new-password field, each ticked as it is met while the person types: the same rules
 * the API enforces (shared code), so a password with every box ticked is accepted. The email rule only shows when
 * there is an email to compare with.
 */
export function PasswordRules({
  password,
  email,
  className,
}: {
  password: string;
  email?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const r = t.passwordRules;
  const check = checkPassword(password, email);
  const typed = password.length > 0;
  const rules: [string, boolean][] = [
    [r.length, check.length],
    [r.common, typed && check.notCommon],
    ...(check.noEmailName === null
      ? []
      : ([[r.emailName, typed && check.noEmailName]] as [string, boolean][])),
  ];
  return (
    <ul aria-label={r.title} className={clsx("mt-2.5 space-y-1.5 px-1", className)}>
      {rules.map(([label, met]) => (
        <li key={label} className="flex items-center gap-2 text-[13px]">
          <span
            className={clsx(
              "grid size-[18px] shrink-0 place-items-center rounded-full transition-colors duration-200",
              met ? "bg-accent text-white" : "shadow-[inset_0_0_0_1.5px_var(--glass-hairline)]",
            )}
          >
            <Check
              className={clsx("size-3 transition-transform duration-200", met ? "scale-100" : "scale-0")}
              strokeWidth={3}
              aria-hidden
            />
          </span>
          <span className={clsx("transition-colors duration-200", met ? "text-text" : "text-muted")}>
            {label}
          </span>
          <span className="sr-only">{met ? r.met : r.unmet}</span>
        </li>
      ))}
    </ul>
  );
}
