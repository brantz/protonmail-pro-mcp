/**
 * Tests for the IMAP connection lifecycle: lazy connect, reconnect after
 * Bridge drops the connection, and errors that must not kill the process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SimpleIMAPService } from '../dist/services/simple-imap-service.js';

function fakeClient({ failConnect } = {}) {
  const client = new EventEmitter();
  client.usable = false;
  client.connect = async () => {
    if (failConnect) throw failConnect;
    client.usable = true;
  };
  client.list = async () => [{ path: 'INBOX' }, { path: 'Drafts', specialUse: '\\Drafts' }];
  client.append = async () => ({ uid: 1 });
  client.logout = async () => {
    client.usable = false;
  };
  client.drop = () => {
    client.usable = false;
    client.emit('close');
  };
  return client;
}

function serviceWith(...clients) {
  const service = new SimpleIMAPService();
  const created = [];
  service.createClient = () => {
    const client = clients[created.length] ?? fakeClient();
    created.push(client);
    return client;
  };
  return { service, created };
}

const DRAFT = { to: 'empfaenger@example.com', subject: 'Test', body: 'Hallo' };

test('a failed connect reports that Bridge is unreachable', async () => {
  const { service } = serviceWith(fakeClient({ failConnect: new Error('connect ECONNREFUSED 127.0.0.1:1143') }));

  await assert.rejects(service.createDraft(DRAFT), /Proton Bridge not reachable.*ECONNREFUSED/);
});

test('an error event on the client is handled and marks the connection dead', async () => {
  const { service, created } = serviceWith();
  await service.createDraft(DRAFT);

  created[0].emit('error', new Error('Socket timeout'));

  assert.equal(service.isConnectionActive(), false);
});

test('a failed connect is retried on the next call', async () => {
  const { service, created } = serviceWith(fakeClient({ failConnect: new Error('ECONNREFUSED') }));
  await assert.rejects(service.createDraft(DRAFT));

  await service.createDraft(DRAFT);

  assert.equal(created.length, 2);
});

test('a connection closed by Bridge is replaced on the next call', async () => {
  const { service, created } = serviceWith();
  await service.createDraft(DRAFT);
  created[0].drop();

  await service.createDraft(DRAFT);

  assert.equal(created.length, 2);
});

test('concurrent calls share one connect', async () => {
  const { service, created } = serviceWith();

  await Promise.all([service.createDraft(DRAFT), service.getFolders()]);

  assert.equal(created.length, 1);
});

test('the first call connects lazily and later calls reuse the connection', async () => {
  const { service, created } = serviceWith();

  await service.createDraft(DRAFT);
  await service.createDraft(DRAFT);

  assert.equal(created.length, 1);
  assert.equal(service.isConnectionActive(), true);
});
