/**
 * Tests for SimpleIMAPService.createDraft against a fake IMAP client,
 * so the APPEND contract is pinned without touching the live Bridge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SimpleIMAPService } from '../dist/services/simple-imap-service.js';

function fakeClient({ mailboxes, appendResult } = {}) {
  const calls = [];
  return {
    calls,
    list: async () =>
      mailboxes ?? [{ path: 'INBOX' }, { path: 'Drafts', specialUse: '\\Drafts' }],
    append: async (path, content, flags, date) => {
      calls.push({ path, content, flags, date });
      return appendResult ?? { uid: 42, destination: path };
    },
  };
}

function serviceWith(client) {
  const service = new SimpleIMAPService();
  service.client = client;
  service.isConnected = true;
  return service;
}

const OPTIONS = {
  to: 'empfaenger@example.com',
  subject: 'Testbetreff',
  body: 'Hallo Welt',
};

test('createDraft appends to the folder carrying the Drafts special use', async () => {
  const client = fakeClient({
    mailboxes: [{ path: 'INBOX' }, { path: 'Entwürfe', specialUse: '\\Drafts' }],
  });
  await serviceWith(client).createDraft(OPTIONS);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, 'Entwürfe');
});

test('createDraft sets the \\Draft flag', async () => {
  const client = fakeClient();
  await serviceWith(client).createDraft(OPTIONS);
  assert.deepEqual(client.calls[0].flags, ['\\Draft']);
});

test('createDraft appends the raw message with CRLF endings', async () => {
  const client = fakeClient();
  await serviceWith(client).createDraft({ ...OPTIONS, body: 'eins\nzwei' });
  const raw = client.calls[0].content.toString('utf8');
  assert.match(raw, /^To: empfaenger@example\.com\r$/m);
  assert.match(raw, /eins\r\nzwei/);
});

test('createDraft defaults the sender to the configured mailbox', async () => {
  const previous = process.env.PROTONMAIL_USERNAME;
  process.env.PROTONMAIL_USERNAME = 'mail@tomrudolf.com';
  try {
    const client = fakeClient();
    await serviceWith(client).createDraft(OPTIONS);
    const raw = client.calls[0].content.toString('utf8');
    assert.match(raw, /^From: mail@tomrudolf\.com\r$/m);
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_USERNAME;
    else process.env.PROTONMAIL_USERNAME = previous;
  }
});

test('createDraft returns the folder and uid it wrote to', async () => {
  const client = fakeClient({ appendResult: { uid: 7, destination: 'Drafts' } });
  const result = await serviceWith(client).createDraft(OPTIONS);
  assert.equal(result.folder, 'Drafts');
  assert.equal(result.uid, 7);
});

test('createDraft refuses to run when Bridge is unreachable', async () => {
  const service = new SimpleIMAPService();
  service.createClient = () => Object.assign(new EventEmitter(), {
    connect: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => service.createDraft(OPTIONS), /not reachable/i);
});

test('createDraft surfaces a malformed recipient instead of appending', async () => {
  const client = fakeClient();
  await assert.rejects(
    () => serviceWith(client).createDraft({ ...OPTIONS, to: 'kaputt' }),
    /kaputt/
  );
  assert.equal(client.calls.length, 0, 'nothing should be appended on validation failure');
});
