/**
 * Draft message construction and Drafts folder resolution.
 *
 * Kept free of IMAP so the parts that can actually be wrong -- header encoding,
 * line endings, folder discovery -- are testable without a live connection.
 */

import { parseEmails, isValidEmail } from './helpers.js';

export interface CreateDraftOptions {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  inReplyTo?: string;
  references?: string | string[];
  date?: Date;
}

export interface MailboxLike {
  path: string;
  specialUse?: string;
  flags?: Set<string> | string[];
}

const DRAFTS_SPECIAL_USE = '\\Drafts';
const DRAFTS_FALLBACK_NAMES = ['Drafts', 'INBOX/Drafts', 'Entwuerfe', 'Entwürfe'];

/**
 * RFC 2047 encoded-word, base64 flavour. Only applied when the value is not
 * plain ASCII, because unencoded umlauts in a header are invalid and get
 * mangled by the receiving side.
 */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Message ids travel in angle brackets; accept them with or without. */
function angleWrap(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

function addressList(field: string, value: string | string[] | undefined): string[] {
  const addresses = parseEmails(value);
  if (!addresses.length) return [];
  const invalid = addresses.find(a => !isValidEmail(a));
  if (invalid) throw new Error(`Invalid ${field} address: ${invalid}`);
  return [`${field}: ${addresses.join(', ')}`];
}

/**
 * Build a raw RFC 5322 message ready for IMAP APPEND.
 */
export function buildDraftMessage(options: CreateDraftOptions): string {
  const recipients = parseEmails(options.to);
  if (!recipients.length) throw new Error('At least one recipient is required');

  const headers: string[] = [
    ...addressList('From', options.from),
    ...addressList('To', options.to),
    ...addressList('Cc', options.cc),
    ...addressList('Bcc', options.bcc),
    `Subject: ${encodeHeaderValue(options.subject)}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
  ];

  if (options.inReplyTo) {
    const parent = angleWrap(options.inReplyTo);
    const chain = options.references
      ? (Array.isArray(options.references) ? options.references : options.references.split(/\s+/))
          .filter(Boolean)
          .map(angleWrap)
      : [parent];
    headers.push(`In-Reply-To: ${parent}`, `References: ${chain.join(' ')}`);
  }

  headers.push(
    'MIME-Version: 1.0',
    `Content-Type: text/${options.isHtml ? 'html' : 'plain'}; charset="utf-8"`,
    'Content-Transfer-Encoding: 8bit'
  );

  const body = options.body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * Find the Drafts mailbox. The special-use attribute is authoritative; the
 * name fallback only exists for servers that do not advertise it.
 */
export function resolveDraftsFolder(mailboxes: MailboxLike[]): string {
  const hasDraftsFlag = (mb: MailboxLike): boolean => {
    if (mb.specialUse === DRAFTS_SPECIAL_USE) return true;
    if (!mb.flags) return false;
    const flags = Array.isArray(mb.flags) ? mb.flags : Array.from(mb.flags);
    return flags.includes(DRAFTS_SPECIAL_USE);
  };

  const special = mailboxes.find(hasDraftsFlag);
  if (special) return special.path;

  const byName = mailboxes.find(mb => DRAFTS_FALLBACK_NAMES.includes(mb.path));
  if (byName) return byName.path;

  throw new Error(`No Drafts folder found. Available: ${mailboxes.map(mb => mb.path).join(', ')}`);
}
