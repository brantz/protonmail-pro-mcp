/**
 * Draft message construction and Drafts folder resolution.
 *
 * Kept free of IMAP so the parts that can actually be wrong -- header encoding,
 * line endings, folder discovery -- are testable without a live connection.
 */

import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import { parseEmails, isValidEmail } from './helpers.js';

/** An attachment ready to be encoded into the message. */
export interface DraftAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * An attachment as it arrives from a tool call: either a local file path or
 * base64 content, never both.
 */
export interface AttachmentInput {
  path?: string;
  content?: string;
  filename?: string;
  contentType?: string;
}

export interface LoadAttachmentsOptions {
  /** Upper bound on the decoded size of all attachments together. */
  maxTotalBytes?: number;
}

/** Proton Mail rejects messages above 25 MB. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
  attachments?: DraftAttachment[];
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

  const bodyHeaders = [
    `Content-Type: text/${options.isHtml ? 'html' : 'plain'}; charset="utf-8"`,
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = options.body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

  headers.push('MIME-Version: 1.0');

  if (!options.attachments?.length) {
    headers.push(...bodyHeaders);
    return `${headers.join('\r\n')}\r\n\r\n${body}`;
  }

  const boundary = `----=_draft_${randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [
    `${bodyHeaders.join('\r\n')}\r\n\r\n${body}`,
    ...options.attachments.map(attachmentPart),
  ];

  return [
    headers.join('\r\n'),
    '',
    'This is a multi-part message in MIME format.',
    ...parts.map(part => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ics': 'text/calendar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
};

export function guessContentType(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Filename parameters for Content-Type and Content-Disposition. Non-ASCII
 * names get RFC 2231 for compliant clients plus an RFC 2047 fallback, which
 * is what most mail clients actually read.
 */
function filenameParams(filename: string): { name: string; filename: string } {
  if (/^[\x20-\x7e]*$/.test(filename)) {
    const quoted = `"${filename.replace(/[\\"]/g, '\\$&')}"`;
    return { name: `name=${quoted}`, filename: `filename=${quoted}` };
  }
  const encodedWord = `"${encodeHeaderValue(filename)}"`;
  const extended = encodeURIComponent(filename).replace(/['()*]/g, c =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return {
    name: `name=${encodedWord}`,
    filename: `filename=${encodedWord}; filename*=UTF-8''${extended}`,
  };
}

function attachmentPart(attachment: DraftAttachment): string {
  // Header values cannot carry line breaks; a name with one would inject headers.
  const filename = attachment.filename.replace(/[\r\n]+/g, ' ').trim() || 'attachment';
  const params = filenameParams(filename);
  const contentType = attachment.contentType || guessContentType(filename);
  if (/[\r\n]/.test(contentType)) throw new Error(`Invalid content type for ${filename}`);

  const base64 = attachment.content.toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `Content-Type: ${contentType}; ${params.name}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${params.filename}`,
    '',
    base64.replace(/\r\n$/, ''),
  ].join('\r\n');
}

async function loadOne(input: AttachmentInput): Promise<DraftAttachment> {
  if (input.path && input.content) {
    throw new Error(`Attachment ${input.filename ?? input.path}: give either path or content, not both`);
  }

  if (input.path) {
    const file = resolve(input.path);
    if (!(await stat(file)).isFile()) throw new Error(`Attachment is not a regular file: ${input.path}`);
    return {
      filename: input.filename || basename(file),
      content: await readFile(file),
      contentType: input.contentType,
    };
  }

  if (input.content !== undefined) {
    if (!input.filename) throw new Error('Attachment with inline content needs a filename');
    const cleaned = input.content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
      throw new Error(`Attachment ${input.filename}: content is not valid base64`);
    }
    return {
      filename: input.filename,
      content: Buffer.from(cleaned, 'base64'),
      contentType: input.contentType,
    };
  }

  throw new Error('Attachment needs either a path or base64 content');
}

/**
 * Turn tool-call attachment inputs into encodable attachments, reading files
 * from disk and enforcing the size limit before anything reaches the mailbox.
 */
export async function loadAttachments(
  inputs: AttachmentInput[] | undefined,
  options: LoadAttachmentsOptions = {}
): Promise<DraftAttachment[]> {
  if (!inputs?.length) return [];
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENT_BYTES;

  const attachments: DraftAttachment[] = [];
  let total = 0;
  for (const input of inputs) {
    const attachment = await loadOne(input);
    total += attachment.content.length;
    if (total > maxTotalBytes) {
      throw new Error(
        `Attachments exceed ${Math.round(maxTotalBytes / 1024 / 1024)} MB in total (at ${attachment.filename})`
      );
    }
    attachments.push(attachment);
  }
  return attachments;
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
