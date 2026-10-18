import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";
import type { Config } from "./config";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outgoing mail. The API speaks SMTP to a relay (a provider's submission port, 465 or 587); cloud servers usually
 * cannot deliver on port 25 themselves, and a relay keeps deliverability (SPF, DKIM, reputation) with the provider.
 */
export interface Mailer {
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
}

export function createMailer(config: Config, log: FastifyBaseLogger): Mailer {
  if (!config.SMTP_URL) {
    // without a relay nothing leaves the server; in development mail is printed to the log instead, so the email
    // code flows can be used locally
    const printed = config.NODE_ENV === "development";
    return {
      enabled: printed,
      async send(message) {
        if (printed)
          log.info({ to: message.to, subject: message.subject, text: message.text }, "mail (printed)");
        else log.warn({ to: message.to, subject: message.subject }, "mail not sent (SMTP_URL unset)");
      },
    };
  }
  const transport = nodemailer.createTransport({
    url: config.SMTP_URL,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const user = decodeURIComponent(new URL(config.SMTP_URL).username);
  const from = config.MAIL_FROM ?? `FlowCarbon <${user}>`;
  return {
    enabled: true,
    async send(message) {
      await transport.sendMail({ from, ...message });
      log.info({ to: message.to, subject: message.subject }, "mail sent");
    },
  };
}

// ---- messages ------------------------------------------------------------------------------------------------------

type Locale = "en" | "zh";
const pick = (locale: string): Locale => (locale === "zh" ? "zh" : "en");

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain, branded HTML body that renders in every client: one column, inline styles, no images. */
function layout(title: string, body: string, footer: string) {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#121821">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;padding:32px 28px">
<tr><td style="font-size:15px;font-weight:600;color:#0d7068;padding-bottom:20px">FlowCarbon</td></tr>
<tr><td style="font-size:22px;font-weight:600;padding-bottom:12px">${escapeHtml(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55">${body}</td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#5d6675;padding-top:24px">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

const codeBlock = (code: string) =>
  `<div style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'SF Mono',Menlo,Consolas,monospace">${code}</div>`;

export function codeMessage(
  purpose: "sign_in" | "password_reset",
  locale: string,
  to: string,
  code: string,
  minutes: number,
): MailMessage {
  const l = pick(locale);
  const t = {
    en: {
      sign_in: {
        subject: `${code} is your FlowCarbon sign-in code`,
        title: "Your sign-in code",
        lead: "Enter this code to sign in to FlowCarbon:",
      },
      password_reset: {
        subject: `${code} is your FlowCarbon password reset code`,
        title: "Reset your password",
        lead: "Enter this code to choose a new password:",
      },
      expires: `It expires in ${minutes} minutes and works once.`,
      footer:
        "If you did not ask for this code, you can ignore this email; nobody can use it without access to your inbox.",
    },
    zh: {
      sign_in: {
        subject: `FlowCarbon 登录验证码：${code}`,
        title: "登录验证码",
        lead: "输入以下验证码登录 FlowCarbon：",
      },
      password_reset: {
        subject: `FlowCarbon 重置密码验证码：${code}`,
        title: "重置密码",
        lead: "输入以下验证码设置新密码：",
      },
      expires: `${minutes} 分钟内有效，仅可使用一次。`,
      footer: "如果不是你本人操作，请忽略此邮件；没有你的邮箱就无法使用该验证码。",
    },
  }[l];
  const m = t[purpose];
  return {
    to,
    subject: m.subject,
    text: `${m.lead}\n\n${code}\n\n${t.expires}\n\n${t.footer}`,
    html: layout(m.title, `${escapeHtml(m.lead)}${codeBlock(code)}${escapeHtml(t.expires)}`, t.footer),
  };
}

export function invitationMessage(
  to: string,
  orgName: string,
  inviter: string | null,
  acceptUrl: string,
  expiresAt: Date,
): MailMessage {
  // the invitee's language is unknown, so the invitation is written in both
  const date = expiresAt.toISOString().slice(0, 10);
  const en = `${inviter ? `${inviter} invited you` : "You are invited"} to join ${orgName} on FlowCarbon.`;
  const zh = `${inviter ? `${inviter} 邀请你` : "你受邀"}加入 FlowCarbon 上的「${orgName}」。`;
  const button = `<a href="${escapeHtml(acceptUrl)}" style="display:inline-block;margin:20px 0;padding:12px 22px;border-radius:999px;background:#0d7068;color:#ffffff;text-decoration:none;font-weight:600">Accept · 接受邀请</a>`;
  return {
    to,
    subject: `Join ${orgName} on FlowCarbon · 加入 FlowCarbon 上的「${orgName}」`,
    text: `${en}\n${zh}\n\n${acceptUrl}\n\nThe link works until ${date}. · 链接有效期至 ${date}。`,
    html: layout(
      "FlowCarbon",
      `${escapeHtml(en)}<br>${escapeHtml(zh)}<br>${button}<br><span style="font-size:13px;color:#5d6675">The link works until ${date}. · 链接有效期至 ${date}。</span>`,
      "If you were not expecting this, you can ignore it. · 如非预期，可忽略此邮件。",
    ),
  };
}
