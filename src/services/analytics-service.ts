/**
 * Analytics Service for email statistics and insights
 */

import type { Email, Contact, EmailStats } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface DailyVolume {
  date: string;
  sent: number;
  received: number;
}

export class AnalyticsService {
  private emailData: Map<string, Email> = new Map();
  private contacts: Map<string, Contact> = new Map();
  private stats: EmailStats = {
    totalEmails: 0,
    unreadEmails: 0,
    sentEmails: 0,
    receivedEmails: 0,
    starredEmails: 0,
    folderCounts: {},
  };

  updateWithEmails(emails: Email[]): void {
    // Merge new emails into existing data (deduplication by ID)
    for (const email of emails) {
      this.emailData.set(email.id, email);
    }
    this.recalculateStats();
    this.updateContacts();
    logger.debug(`Analytics updated with ${emails.length} new emails (total: ${this.emailData.size})`, 'AnalyticsService');
  }

  private recalculateStats(): void {
    const allEmails = Array.from(this.emailData.values());
    this.stats = {
      totalEmails: allEmails.length,
      unreadEmails: allEmails.filter(e => !e.isRead).length,
      sentEmails: allEmails.filter(e => e.folder.toLowerCase() === 'sent').length,
      receivedEmails: allEmails.filter(e => e.folder.toLowerCase() === 'inbox').length,
      starredEmails: allEmails.filter(e => e.isStarred).length,
      folderCounts: {},
    };

    for (const email of allEmails) {
      const folder = email.folder || 'Unknown';
      this.stats.folderCounts[folder] = (this.stats.folderCounts[folder] || 0) + 1;
    }
  }

  private updateContacts(): void {
    this.contacts.clear();

    for (const email of this.emailData.values()) {
      // Track senders
      for (const from of email.from) {
        const addr = from.address.toLowerCase();
        const existing = this.contacts.get(addr) || {
          email: addr,
          name: from.name,
          sentCount: 0,
          receivedCount: 0,
          lastInteraction: email.date,
        };
        existing.receivedCount++;
        if (email.date > existing.lastInteraction) {
          existing.lastInteraction = email.date;
        }
        this.contacts.set(addr, existing);
      }

      // Track recipients
      for (const to of email.to) {
        const addr = to.address.toLowerCase();
        const existing = this.contacts.get(addr) || {
          email: addr,
          name: to.name,
          sentCount: 0,
          receivedCount: 0,
          lastInteraction: email.date,
        };
        existing.sentCount++;
        if (email.date > existing.lastInteraction) {
          existing.lastInteraction = email.date;
        }
        this.contacts.set(addr, existing);
      }
    }
  }

  getStats(): EmailStats {
    return { ...this.stats };
  }

  getContacts(limit: number = 100): Contact[] {
    const sorted = Array.from(this.contacts.values())
      .sort((a, b) => (b.sentCount + b.receivedCount) - (a.sentCount + a.receivedCount));
    return sorted.slice(0, limit);
  }

  getAnalytics(): object {
    const contacts = this.getContacts(10);
    const topSenders = contacts
      .sort((a, b) => b.receivedCount - a.receivedCount)
      .slice(0, 5);
    const topRecipients = contacts
      .sort((a, b) => b.sentCount - a.sentCount)
      .slice(0, 5);

    return {
      overview: this.stats,
      topSenders: topSenders.map(c => ({ email: c.email, count: c.receivedCount })),
      topRecipients: topRecipients.map(c => ({ email: c.email, count: c.sentCount })),
      emailsByFolder: this.stats.folderCounts,
      totalContacts: this.contacts.size,
    };
  }

  getVolumeTrends(days: number = 30): DailyVolume[] {
    const trends: Map<string, DailyVolume> = new Map();
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Initialize all days
    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      trends.set(dateStr, { date: dateStr, sent: 0, received: 0 });
    }

    // Count emails per day
    for (const email of this.emailData.values()) {
      if (email.date < cutoff) continue;
      const dateStr = email.date.toISOString().split('T')[0];
      const existing = trends.get(dateStr);
      if (existing) {
        if (email.folder.toLowerCase() === 'sent') {
          existing.sent++;
        } else {
          existing.received++;
        }
      }
    }

    return Array.from(trends.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  clearCache(): void {
    this.emailData.clear();
    this.contacts.clear();
    this.stats = {
      totalEmails: 0,
      unreadEmails: 0,
      sentEmails: 0,
      receivedEmails: 0,
      starredEmails: 0,
      folderCounts: {},
    };
    logger.info('Analytics cache cleared', 'AnalyticsService');
  }
}
