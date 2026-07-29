/**
 * Tests for draft message construction and Drafts folder resolution.
 * Run: npm test   (tests the compiled output in dist/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDraftMessage, resolveDraftsFolder } from '../dist/utils/draft.js';

const BASE = {
  from: 'mail@tomrudolf.com',
  to: 'empfaenger@example.com',
  subject: 'Testbetreff',
  body: 'Hallo Welt',
  date: new Date(Date.UTC(2026, 6, 29, 8, 0, 0)),
};

test('buildDraftMessage uses CRLF line endings throughout', () => {
  const msg = buildDraftMessage({ ...BASE, body: 'Zeile eins\nZeile zwei' });
  assert.ok(!/[^\r]\n/.test(msg), 'found a bare LF that is not preceded by CR');
  assert.match(msg, /Zeile eins\r\nZeile zwei/);
});

test('buildDraftMessage separates headers from body with one blank line', () => {
  const msg = buildDraftMessage(BASE);
  const [headers, ...rest] = msg.split('\r\n\r\n');
  assert.match(headers, /^From: /m);
  assert.equal(rest.join('\r\n\r\n'), 'Hallo Welt');
});

test('buildDraftMessage joins multiple recipients with a comma', () => {
  const msg = buildDraftMessage({
    ...BASE,
    to: ['a@example.com', 'b@example.com'],
    cc: ['c@example.com'],
  });
  assert.match(msg, /^To: a@example\.com, b@example\.com\r$/m);
  assert.match(msg, /^Cc: c@example\.com\r$/m);
});

test('buildDraftMessage omits Cc and Bcc when not given', () => {
  const msg = buildDraftMessage(BASE);
  assert.doesNotMatch(msg, /^Cc:/m);
  assert.doesNotMatch(msg, /^Bcc:/m);
});

test('buildDraftMessage RFC 2047 encodes a subject containing umlauts', () => {
  const msg = buildDraftMessage({ ...BASE, subject: 'Erklärungen übermittelt' });
  const line = msg.split('\r\n').find((l) => l.startsWith('Subject:'));
  assert.match(line, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const encoded = line.slice('Subject: =?UTF-8?B?'.length, -'?='.length);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Erklärungen übermittelt');
});

test('buildDraftMessage leaves a pure ASCII subject unencoded', () => {
  const msg = buildDraftMessage(BASE);
  assert.match(msg, /^Subject: Testbetreff\r$/m);
});

test('buildDraftMessage declares utf-8 plain text by default', () => {
  const msg = buildDraftMessage(BASE);
  assert.match(msg, /^Content-Type: text\/plain; charset="utf-8"\r$/m);
  assert.match(msg, /^MIME-Version: 1\.0\r$/m);
});

test('buildDraftMessage declares html when isHtml is set', () => {
  const msg = buildDraftMessage({ ...BASE, isHtml: true, body: '<p>Hi</p>' });
  assert.match(msg, /^Content-Type: text\/html; charset="utf-8"\r$/m);
});

test('buildDraftMessage emits threading headers when inReplyTo is given', () => {
  const parent = '<abc123@example.com>';
  const msg = buildDraftMessage({ ...BASE, inReplyTo: parent });
  assert.match(msg, /^In-Reply-To: <abc123@example\.com>\r$/m);
  assert.match(msg, /^References: <abc123@example\.com>\r$/m);
});

test('buildDraftMessage wraps a bare message id in angle brackets', () => {
  const msg = buildDraftMessage({ ...BASE, inReplyTo: 'abc123@example.com' });
  assert.match(msg, /^In-Reply-To: <abc123@example\.com>\r$/m);
});

test('buildDraftMessage keeps an explicit references chain', () => {
  const msg = buildDraftMessage({
    ...BASE,
    inReplyTo: '<second@example.com>',
    references: ['<first@example.com>', '<second@example.com>'],
  });
  assert.match(msg, /^References: <first@example\.com> <second@example\.com>\r$/m);
});

test('buildDraftMessage omits threading headers when not replying', () => {
  const msg = buildDraftMessage(BASE);
  assert.doesNotMatch(msg, /^In-Reply-To:/m);
  assert.doesNotMatch(msg, /^References:/m);
});

test('buildDraftMessage writes the given date as an RFC 5322 Date header', () => {
  const msg = buildDraftMessage(BASE);
  const line = msg.split('\r\n').find((l) => l.startsWith('Date:'));
  assert.ok(line, 'no Date header');
  assert.ok(!Number.isNaN(Date.parse(line.slice('Date: '.length))), 'Date header not parseable');
});

test('buildDraftMessage rejects an empty recipient list', () => {
  assert.throws(() => buildDraftMessage({ ...BASE, to: [] }), /recipient/i);
});

test('buildDraftMessage rejects a malformed recipient', () => {
  assert.throws(() => buildDraftMessage({ ...BASE, to: 'not-an-email' }), /not-an-email/);
});

test('resolveDraftsFolder prefers the \\Drafts special-use attribute', () => {
  const path = resolveDraftsFolder([
    { path: 'INBOX' },
    { path: 'Entwürfe', specialUse: '\\Drafts' },
    { path: 'Drafts' },
  ]);
  assert.equal(path, 'Entwürfe');
});

test('resolveDraftsFolder reads special use from the flags set', () => {
  const path = resolveDraftsFolder([
    { path: 'INBOX' },
    { path: 'Meine Entwuerfe', flags: new Set(['\\Drafts']) },
  ]);
  assert.equal(path, 'Meine Entwuerfe');
});

test('resolveDraftsFolder falls back to well-known folder names', () => {
  const path = resolveDraftsFolder([{ path: 'INBOX' }, { path: 'Drafts' }]);
  assert.equal(path, 'Drafts');
});

test('resolveDraftsFolder throws and lists what it saw when nothing matches', () => {
  assert.throws(
    () => resolveDraftsFolder([{ path: 'INBOX' }, { path: 'Archive' }]),
    /INBOX.*Archive/s
  );
});
