/**
 * Tests for draft attachments: MIME structure, filename encoding and the
 * loader that turns tool input into attachment buffers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';

import { buildDraftMessage, loadAttachments, guessContentType } from '../dist/utils/draft.js';
import { SimpleIMAPService } from '../dist/services/simple-imap-service.js';

const BASE = {
  from: 'mail@tomrudolf.com',
  to: 'empfaenger@example.com',
  subject: 'Mit Anhang',
  body: 'Siehe Anhang\nGruss',
  date: new Date(Date.UTC(2026, 8, 19, 8, 0, 0)),
};

const PDF = { filename: 'rechnung.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'draft-att-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('buildDraftMessage stays single-part without attachments', () => {
  const msg = buildDraftMessage({ ...BASE, attachments: [] });
  assert.doesNotMatch(msg, /multipart/);
  assert.match(msg, /^Content-Type: text\/plain; charset="utf-8"\r$/m);
});

test('buildDraftMessage produces multipart/mixed that a parser reads back', async () => {
  const msg = buildDraftMessage({ ...BASE, attachments: [PDF] });
  assert.match(msg, /^Content-Type: multipart\/mixed; boundary="[^"]+"\r$/m);
  assert.ok(!/[^\r]\n/.test(msg), 'found a bare LF that is not preceded by CR');

  const parsed = await simpleParser(msg);
  assert.equal(parsed.text.trim(), 'Siehe Anhang\nGruss');
  assert.equal(parsed.subject, 'Mit Anhang');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'rechnung.pdf');
  assert.equal(parsed.attachments[0].contentType, 'application/pdf');
  assert.deepEqual(parsed.attachments[0].content, PDF.content);
});

test('buildDraftMessage keeps an html body inside the multipart', async () => {
  const msg = buildDraftMessage({ ...BASE, isHtml: true, body: '<p>Hallo</p>', attachments: [PDF] });
  const parsed = await simpleParser(msg);
  assert.match(parsed.html, /<p>Hallo<\/p>/);
  assert.equal(parsed.attachments.length, 1);
});

test('buildDraftMessage wraps base64 lines at 76 characters', () => {
  const big = { filename: 'blob.bin', content: Buffer.alloc(1000, 7) };
  const msg = buildDraftMessage({ ...BASE, attachments: [big] });
  const longest = Math.max(...msg.split('\r\n').map((l) => l.length));
  assert.ok(longest <= 998, `line of ${longest} chars exceeds RFC 5322 limit`);
  const b64Lines = msg.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
  assert.ok(b64Lines.every((l) => l.length <= 76));
});

test('buildDraftMessage carries several attachments in order', async () => {
  const msg = buildDraftMessage({
    ...BASE,
    attachments: [PDF, { filename: 'notiz.txt', content: Buffer.from('hallo') }],
  });
  const parsed = await simpleParser(msg);
  assert.deepEqual(parsed.attachments.map((a) => a.filename), ['rechnung.pdf', 'notiz.txt']);
  assert.equal(parsed.attachments[1].contentType, 'text/plain');
});

test('buildDraftMessage encodes a filename with umlauts', async () => {
  const msg = buildDraftMessage({
    ...BASE,
    attachments: [{ filename: 'Erklärung Übersicht.pdf', content: Buffer.from('x') }],
  });
  assert.match(msg, /filename\*=UTF-8''Erkl%C3%A4rung%20%C3%9Cbersicht\.pdf/);
  const parsed = await simpleParser(msg);
  assert.equal(parsed.attachments[0].filename, 'Erklärung Übersicht.pdf');
});

test('buildDraftMessage escapes quotes and strips line breaks in filenames', async () => {
  const msg = buildDraftMessage({
    ...BASE,
    attachments: [{ filename: 'a "b"\r\nX-Injected: yes.txt', content: Buffer.from('x') }],
  });
  assert.doesNotMatch(msg, /^X-Injected:/m);
  const parsed = await simpleParser(msg);
  assert.equal(parsed.attachments[0].filename, 'a "b" X-Injected: yes.txt');
});

test('guessContentType maps common extensions and falls back to octet-stream', () => {
  assert.equal(guessContentType('A.PDF'), 'application/pdf');
  assert.equal(guessContentType('x.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(guessContentType('noext'), 'application/octet-stream');
});

test('loadAttachments reads a file and defaults the filename to its name', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'bericht.pdf');
  await writeFile(file, 'inhalt');
  const [att] = await loadAttachments([{ path: file }]);
  assert.equal(att.filename, 'bericht.pdf');
  assert.equal(att.content.toString(), 'inhalt');
});

test('loadAttachments lets filename override the file name', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'tmp123.pdf');
  await writeFile(file, 'x');
  const [att] = await loadAttachments([{ path: file, filename: 'Angebot.pdf' }]);
  assert.equal(att.filename, 'Angebot.pdf');
});

test('loadAttachments decodes base64 content', async () => {
  const [att] = await loadAttachments([
    { content: Buffer.from('hallo welt').toString('base64'), filename: 'a.txt' },
  ]);
  assert.equal(att.content.toString(), 'hallo welt');
});

test('loadAttachments rejects content without a filename', async () => {
  await assert.rejects(() => loadAttachments([{ content: 'aGFsbG8=' }]), /filename/);
});

test('loadAttachments rejects invalid base64', async () => {
  await assert.rejects(() => loadAttachments([{ content: 'not base64!!', filename: 'a.txt' }]), /base64/);
});

test('loadAttachments rejects path and content together', async () => {
  await assert.rejects(
    () => loadAttachments([{ path: '/etc/hosts', content: 'aGFsbG8=', filename: 'a' }]),
    /either path or content/
  );
});

test('loadAttachments rejects an entry with neither path nor content', async () => {
  await assert.rejects(() => loadAttachments([{ filename: 'a.txt' }]), /path or base64/);
});

test('loadAttachments rejects a missing file', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(() => loadAttachments([{ path: join(dir, 'gibtsnicht.pdf') }]), /ENOENT/);
});

test('loadAttachments rejects a directory', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(() => loadAttachments([{ path: dir }]), /not a regular file/);
});

test('loadAttachments enforces the total size limit', async () => {
  const content = Buffer.alloc(600).toString('base64');
  await assert.rejects(
    () => loadAttachments(
      [{ content, filename: 'a.bin' }, { content, filename: 'b.bin' }],
      { maxTotalBytes: 1000 }
    ),
    /b\.bin/
  );
});

function fakeClient() {
  const calls = [];
  return {
    calls,
    list: async () => [{ path: 'Drafts', specialUse: '\\Drafts' }],
    append: async (path, content, flags) => {
      calls.push({ path, content, flags });
      return { uid: 9 };
    },
  };
}

function serviceWith(client) {
  const service = new SimpleIMAPService();
  service.client = client;
  service.isConnected = true;
  return service;
}

test('createDraft appends a message with the attachment and reports it', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'anlage.pdf');
  await writeFile(file, 'pdfdaten');
  const client = fakeClient();
  const result = await serviceWith(client).createDraft({
    to: 'empfaenger@example.com',
    subject: 'Anlage',
    body: 'Hallo',
    attachments: [{ path: file }],
  });
  assert.deepEqual(result.attachments, [{ filename: 'anlage.pdf', size: 8 }]);
  const parsed = await simpleParser(client.calls[0].content);
  assert.equal(parsed.attachments[0].content.toString(), 'pdfdaten');
});

test('createDraft does not append when an attachment cannot be loaded', async (t) => {
  const dir = await tempDir(t);
  const client = fakeClient();
  await assert.rejects(() =>
    serviceWith(client).createDraft({
      to: 'empfaenger@example.com',
      subject: 'Anlage',
      body: 'Hallo',
      attachments: [{ path: join(dir, 'fehlt.pdf') }],
    })
  );
  assert.equal(client.calls.length, 0);
});
