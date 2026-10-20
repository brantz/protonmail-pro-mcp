/**
 * Simple IMAP Service for reading emails via Proton Bridge
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Email, Folder, SearchOptions } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { buildDraftMessage, loadAttachments, resolveDraftsFolder } from '../utils/draft.js';
import type { AttachmentInput, CreateDraftOptions, LoadAttachmentsOptions } from '../utils/draft.js';

export class SimpleIMAPService {
  private client: ImapFlow | null = null;
  private isConnected: boolean = false;
  private emailCache: Map<string, Email> = new Map();
  private folderCache: Folder[] = [];
  private emailFolderMap: Map<string, string> = new Map(); // emailId -> folder
  private connecting: Promise<void> | null = null;

  protected createClient(): ImapFlow {
    return new ImapFlow({
      host: process.env.PROTONMAIL_IMAP_HOST || 'localhost',
      port: parseInt(process.env.PROTONMAIL_IMAP_PORT || '1143', 10),
      secure: false,
      auth: {
        user: process.env.PROTONMAIL_USERNAME || '',
        pass: process.env.PROTONMAIL_PASSWORD || '',
      },
      logger: false,
      // Fail fast when Bridge accepts the socket but cannot log in (offline, still syncing)
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      tls: {
        rejectUnauthorized: false, // ProtonMail Bridge uses self-signed certificates
      },
    });
  }

  /**
   * Connect on first use and again whenever Bridge has dropped the connection.
   * Concurrent callers share one connect attempt.
   */
  async connect(): Promise<void> {
    if (this.client && this.isConnected && this.client.usable !== false) return;
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openConnection(): Promise<void> {
    const client = this.createClient();
    // Without listeners an IMAP error becomes an uncaught exception and ends the process
    client.on('error', (error: Error) => this.markDead(client, error));
    client.on('close', () => this.markDead(client));

    try {
      await client.connect();
    } catch (error) {
      this.markDead(client);
      logger.error('IMAP connection failed', 'IMAPService', error);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Proton Bridge not reachable: ${reason}`);
    }

    this.client = client;
    this.isConnected = true;
    logger.info('IMAP connection established', 'IMAPService');
  }

  private markDead(client: ImapFlow, error?: Error): void {
    if (error) logger.warn('IMAP connection error', 'IMAPService', error);
    if (this.client !== client) return;
    this.isConnected = false;
    this.client = null;
    logger.info('IMAP connection lost, reconnecting on next call', 'IMAPService');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.isConnected = false;
      this.client = null;
      await client.logout().catch(() => client.close());
      logger.info('IMAP connection closed', 'IMAPService');
    }
  }

  isConnectionActive(): boolean {
    return this.isConnected;
  }

  /**
   * Store a message in the Drafts folder. Nothing is sent: the draft sits in
   * Proton Mail until a human opens and sends it.
   */
  async createDraft(
    options: Omit<CreateDraftOptions, 'from' | 'attachments'> & {
      from?: string;
      attachments?: AttachmentInput[];
    },
    attachmentOptions: LoadAttachmentsOptions = {}
  ): Promise<{ folder: string; uid?: number; attachments: { filename: string; size: number }[] }> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP client is not connected');
    }

    const from = options.from || process.env.PROTONMAIL_USERNAME || '';
    // Load and build before touching the mailbox so a bad address or a
    // missing file fails without a write.
    const attachments = await loadAttachments(options.attachments, attachmentOptions);
    const raw = buildDraftMessage({ ...options, from, attachments });

    const folder = resolveDraftsFolder(await this.client.list());
    const result = await this.client.append(folder, Buffer.from(raw, 'utf8'), ['\\Draft']);

    logger.info(`Draft created in "${folder}"`, 'IMAPService');
    return {
      folder,
      uid: (result as { uid?: number } | undefined)?.uid,
      attachments: attachments.map(a => ({ filename: a.filename, size: a.content.length })),
    };
  }

  async getFolders(): Promise<Folder[]> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    try {
      const mailboxes = await this.client.list();
      const folders: Folder[] = [];

      for (const mb of mailboxes) {
        try {
          const status = await this.client.status(mb.path, { messages: true, unseen: true });
          folders.push({
            name: mb.name,
            path: mb.path,
            delimiter: mb.delimiter,
            totalMessages: status.messages || 0,
            unreadMessages: status.unseen || 0,
          });
        } catch {
          // If status fails for a folder, use defaults
          folders.push({
            name: mb.name,
            path: mb.path,
            delimiter: mb.delimiter,
            totalMessages: 0,
            unreadMessages: 0,
          });
        }
      }

      this.folderCache = folders;
      return this.folderCache;
    } catch (error) {
      logger.error('Failed to get folders', 'IMAPService', error);
      throw error;
    }
  }

  async getEmails(folder: string = 'INBOX', limit: number = 50, offset: number = 0): Promise<{ emails: Email[]; totalMessages: number; hasMore: boolean }> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    const emails: Email[] = [];
    let totalMessages = 0;

    try {
      const lock = await this.client.getMailboxLock(folder);
      try {
        // Use mailbox.exists after selecting folder (more reliable than status)
        const mailbox = this.client.mailbox;
        totalMessages = mailbox ? (mailbox as { exists: number }).exists : 0;

        if (totalMessages === 0) {
          return { emails, totalMessages: 0, hasMore: false };
        }

        // Search all emails in folder (no date restriction)
        const allUids = await this.client.search({ all: true }, { uid: true });
        let recentUids = allUids;

        if (!recentUids || recentUids.length === 0) {
          return { emails, totalMessages, hasMore: false };
        }

        // Fetch envelopes to get dates for proper sorting
        const emailsWithDates: { uid: number; date: Date }[] = [];

        for await (const message of this.client.fetch(recentUids, {
          envelope: true,
          uid: true,
        }, { uid: true })) {
          const date = message.envelope?.date || new Date(0);
          emailsWithDates.push({ uid: message.uid, date });
        }

        // Sort by date descending (newest first)
        emailsWithDates.sort((a, b) => b.date.getTime() - a.date.getTime());

        // Apply pagination
        const paginatedUids = emailsWithDates.slice(offset, offset + limit).map(e => e.uid);

        if (paginatedUids.length === 0) {
          return { emails, totalMessages, hasMore: false };
        }

        // Now fetch full content for the paginated UIDs
        for await (const message of this.client.fetch(paginatedUids, {
          envelope: true,
          source: true,
          flags: true,
          uid: true,
        }, { uid: true })) {
          try {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            const email = this.parsedMailToEmail(parsed, message, folder);
            emails.push(email);
            this.emailCache.set(email.id, email);
            this.emailFolderMap.set(email.id, folder);
          } catch (parseError) {
            logger.warn('Failed to parse email', 'IMAPService', parseError);
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to get emails', 'IMAPService', error);
      throw error;
    }

    // Sort by date descending (newest first) to ensure correct order
    emails.sort((a, b) => b.date.getTime() - a.date.getTime());

    const hasMore = offset + emails.length < totalMessages;
    return { emails, totalMessages, hasMore };
  }

  async getEmailById(emailId: string, folder?: string): Promise<Email | null> {
    // Check cache first
    if (this.emailCache.has(emailId)) {
      return this.emailCache.get(emailId) || null;
    }

    // If not in cache, try to fetch from IMAP
    await this.connect();
    if (!this.client) {
      return null;
    }

    // Determine folder to search
    const targetFolder = folder || this.emailFolderMap.get(emailId) || 'INBOX';

    try {
      const lock = await this.client.getMailboxLock(targetFolder);
      try {
        // Fetch by UID
        const uid = parseInt(emailId, 10);
        if (isNaN(uid)) {
          return null;
        }

        for await (const message of this.client.fetch(uid, {
          envelope: true,
          source: true,
          flags: true,
          uid: true,
        }, { uid: true })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          const email = this.parsedMailToEmail(parsed, message, targetFolder);
          this.emailCache.set(email.id, email);
          this.emailFolderMap.set(email.id, targetFolder);
          return email;
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.warn(`Failed to fetch email by ID: ${emailId}`, 'IMAPService', error);
    }

    return null;
  }

  async searchEmails(options: SearchOptions): Promise<Email[]> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    // Use "All Mail" folder by default to search across all emails
    const folder = options.folder || 'All Mail';
    const emails: Email[] = [];

    try {
      const lock = await this.client.getMailboxLock(folder);
      try {
        // Build search query
        const searchQuery: Record<string, unknown> = {};

        // Use IMAP TEXT search for query - searches both headers and body
        if (options.query) {
          searchQuery.text = options.query;
        }
        if (options.from) {
          searchQuery.from = options.from;
        }
        if (options.to) {
          searchQuery.to = options.to;
        }
        if (options.subject) {
          searchQuery.subject = options.subject;
        }
        if (options.isRead === true) {
          searchQuery.seen = true;
        } else if (options.isRead === false) {
          searchQuery.unseen = true;
        }
        if (options.isStarred === true) {
          searchQuery.flagged = true;
        }
        if (options.dateFrom) {
          searchQuery.since = options.dateFrom;
        }
        if (options.dateTo) {
          searchQuery.before = options.dateTo;
        }

        // If no criteria, search all
        if (Object.keys(searchQuery).length === 0) {
          searchQuery.all = true;
        }

        logger.info(`Searching in folder "${folder}" with query: ${JSON.stringify(searchQuery)}`, 'IMAPService');

        const results = await this.client.search(searchQuery as any, { uid: true });

        const limit = options.limit || 100;
        if (!results || !Array.isArray(results) || results.length === 0) {
          logger.info(`No results found for search`, 'IMAPService');
          return emails;
        }

        logger.info(`Found ${results.length} matching emails, fetching last ${limit}`, 'IMAPService');

        // Get the most recent matches (last N UIDs since UIDs are sequential)
        const uids = results.slice(-limit);

        for await (const message of this.client.fetch(uids, {
          envelope: true,
          source: true,
          flags: true,
          uid: true,
        }, { uid: true })) {
          try {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            const email = this.parsedMailToEmail(parsed, message, folder);

            emails.push(email);
            this.emailCache.set(email.id, email);
            this.emailFolderMap.set(email.id, folder);
          } catch (parseError) {
            logger.warn('Failed to parse email in search', 'IMAPService', parseError);
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to search emails', 'IMAPService', error);
      throw error;
    }

    // Sort by date newest-first
    return emails.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async markAsRead(emailId: string, isRead: boolean = true): Promise<void> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    const folder = this.emailFolderMap.get(emailId) || 'INBOX';
    const uid = parseInt(emailId, 10);
    if (isNaN(uid)) {
      throw new Error(`Invalid email ID: ${emailId}`);
    }

    try {
      const lock = await this.client.getMailboxLock(folder);
      try {
        if (isRead) {
          await this.client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } else {
          await this.client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
        }
        // Update cache
        const email = this.emailCache.get(emailId);
        if (email) {
          email.isRead = isRead;
        }
        logger.info(`Marked email ${emailId} as ${isRead ? 'read' : 'unread'}`, 'IMAPService');
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error(`Failed to mark email as read: ${emailId}`, 'IMAPService', error);
      throw error;
    }
  }

  async starEmail(emailId: string, isStarred: boolean = true): Promise<void> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    const folder = this.emailFolderMap.get(emailId) || 'INBOX';
    const uid = parseInt(emailId, 10);
    if (isNaN(uid)) {
      throw new Error(`Invalid email ID: ${emailId}`);
    }

    try {
      const lock = await this.client.getMailboxLock(folder);
      try {
        if (isStarred) {
          await this.client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
        } else {
          await this.client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
        }
        // Update cache
        const email = this.emailCache.get(emailId);
        if (email) {
          email.isStarred = isStarred;
        }
        logger.info(`${isStarred ? 'Starred' : 'Unstarred'} email ${emailId}`, 'IMAPService');
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error(`Failed to star email: ${emailId}`, 'IMAPService', error);
      throw error;
    }
  }

  async moveEmail(emailId: string, targetFolder: string): Promise<void> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    const sourceFolder = this.emailFolderMap.get(emailId) || 'INBOX';
    const uid = parseInt(emailId, 10);
    if (isNaN(uid)) {
      throw new Error(`Invalid email ID: ${emailId}`);
    }

    try {
      const lock = await this.client.getMailboxLock(sourceFolder);
      try {
        await this.client.messageMove(uid, targetFolder, { uid: true });
        // Update folder mapping
        this.emailFolderMap.set(emailId, targetFolder);
        // Update cache
        const email = this.emailCache.get(emailId);
        if (email) {
          email.folder = targetFolder;
        }
        logger.info(`Moved email ${emailId} from ${sourceFolder} to ${targetFolder}`, 'IMAPService');
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error(`Failed to move email: ${emailId}`, 'IMAPService', error);
      throw error;
    }
  }

  async deleteEmail(emailId: string): Promise<void> {
    await this.connect();
    if (!this.client) {
      throw new Error('IMAP not connected');
    }

    const folder = this.emailFolderMap.get(emailId) || 'INBOX';
    const uid = parseInt(emailId, 10);
    if (isNaN(uid)) {
      throw new Error(`Invalid email ID: ${emailId}`);
    }

    try {
      const lock = await this.client.getMailboxLock(folder);
      try {
        await this.client.messageDelete(uid, { uid: true });
        // Clear from cache
        this.emailCache.delete(emailId);
        this.emailFolderMap.delete(emailId);
        logger.info(`Deleted email ${emailId}`, 'IMAPService');
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error(`Failed to delete email: ${emailId}`, 'IMAPService', error);
      throw error;
    }
  }

  async syncFolder(folder: string): Promise<void> {
    await this.getEmails(folder, 100, 0);
    logger.info(`Synced folder: ${folder}`, 'IMAPService');
  }

  clearCache(): void {
    this.emailCache.clear();
    this.folderCache = [];
    this.emailFolderMap.clear();
    logger.info('Cache cleared', 'IMAPService');
  }

  private extractAddresses(addressField: unknown): { name?: string; address: string }[] {
    if (!addressField) return [];

    // Handle AddressObject (has 'value' property with array of addresses)
    const field = addressField as any;
    if (field.value && Array.isArray(field.value)) {
      return field.value.map((addr: any) => ({
        name: addr.name,
        address: addr.address || '',
      }));
    }

    // Handle array of AddressObject
    if (Array.isArray(field)) {
      return field.flatMap((item: any) => {
        if (item.value && Array.isArray(item.value)) {
          return item.value.map((addr: any) => ({
            name: addr.name,
            address: addr.address || '',
          }));
        }
        return [];
      });
    }

    return [];
  }

  private parsedMailToEmail(parsed: any, message: any, folder: string): Email {
    const flags = message.flags || new Set();

    return {
      id: message.uid?.toString() || generateId(),
      messageId: parsed.messageId,
      from: this.extractAddresses(parsed.from),
      to: this.extractAddresses(parsed.to),
      cc: this.extractAddresses(parsed.cc),
      subject: parsed.subject || '(No Subject)',
      body: parsed.text || '',
      html: parsed.html || undefined,
      date: parsed.date || new Date(),
      isRead: flags.has('\\Seen'),
      isStarred: flags.has('\\Flagged'),
      folder,
      attachments: parsed.attachments?.map((att: any) => ({
        filename: att.filename || 'attachment',
        content: att.content.toString('base64'),
        contentType: att.contentType,
      })),
    };
  }
}
