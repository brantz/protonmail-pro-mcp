#!/usr/bin/env node

/**
 * Proton Mail MCP Server
 *
 * A secure MCP server for Proton Mail with read-only mode support.
 *
 * Features:
 * - Email reading (IMAP) via Proton Bridge
 * - Email search with advanced filters
 * - Email statistics & analytics
 * - Folder management
 * - Optional: Email sending (disabled in read-only mode)
 *
 * Security: Set READ_ONLY_MODE=true to disable all write operations
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import path from "node:path";

import { ProtonMailConfig } from './types/index.js';
import { SMTPService } from './services/smtp-service.js';
import { SimpleIMAPService } from './services/simple-imap-service.js';
import { AnalyticsService } from './services/analytics-service.js';
import { logger } from './utils/logger.js';
import type { AttachmentInput } from './utils/draft.js';

// Environment configuration
const PROTONMAIL_USERNAME = process.env.PROTONMAIL_USERNAME;
const PROTONMAIL_PASSWORD = process.env.PROTONMAIL_PASSWORD;
const PROTONMAIL_SMTP_HOST = process.env.PROTONMAIL_SMTP_HOST || "127.0.0.1";
const PROTONMAIL_SMTP_PORT = parseInt(process.env.PROTONMAIL_SMTP_PORT || "1025", 10);
const PROTONMAIL_IMAP_HOST = process.env.PROTONMAIL_IMAP_HOST || "127.0.0.1";
const PROTONMAIL_IMAP_PORT = parseInt(process.env.PROTONMAIL_IMAP_PORT || "1143", 10);
const DEBUG = process.env.DEBUG === "true";
const READ_ONLY_MODE = process.env.READ_ONLY_MODE !== "false"; // Default: true (safe)
// Drafts are their own tier: a draft is never sent and destroys nothing, so it
// can be allowed without opening up send/delete.
const ALLOW_DRAFTS = process.env.ALLOW_DRAFTS === "true" || !READ_ONLY_MODE;
// Optional allowlist for create_draft attachment paths, separated like PATH.
// Unset means any file readable by this process may be attached.
const ATTACHMENT_DIRS = (process.env.ATTACHMENT_DIRS || "")
  .split(path.delimiter)
  .map((dir) => dir.trim())
  .filter(Boolean);

// Validate required environment variables
if (!PROTONMAIL_USERNAME || !PROTONMAIL_PASSWORD) {
  console.error("Missing required environment variables: PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD");
  process.exit(1);
}

// Configure logger
logger.setDebugMode(DEBUG);

if (READ_ONLY_MODE) {
  logger.info("Running in READ-ONLY mode - send/delete operations disabled", "MCPServer");
} else {
  logger.warn("Running in FULL ACCESS mode - send/delete operations enabled", "MCPServer");
}

if (ALLOW_DRAFTS && READ_ONLY_MODE) {
  logger.info("Draft creation enabled (ALLOW_DRAFTS) - sending stays disabled", "MCPServer");
}

// Create configuration
const config: ProtonMailConfig = {
  smtp: {
    host: PROTONMAIL_SMTP_HOST,
    port: PROTONMAIL_SMTP_PORT,
    secure: PROTONMAIL_SMTP_PORT === 465,
    username: PROTONMAIL_USERNAME,
    password: PROTONMAIL_PASSWORD,
  },
  imap: {
    host: PROTONMAIL_IMAP_HOST,
    port: PROTONMAIL_IMAP_PORT,
    secure: false,
    username: PROTONMAIL_USERNAME,
    password: PROTONMAIL_PASSWORD,
  },
  debug: DEBUG,
  cacheEnabled: true,
  analyticsEnabled: true,
  autoSync: true,
  syncInterval: 5
};

// Initialize services
const smtpService = new SMTPService(config);
const imapService = new SimpleIMAPService();
const analyticsService = new AnalyticsService();

// Tool definitions
const READ_ONLY_TOOLS = [
  {
    name: "get_emails",
    description: "Get emails from a folder with pagination",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        limit: { type: "number", description: "Number of emails to fetch (default: 20)", default: 20 },
        offset: { type: "number", description: "Pagination offset", default: 0 }
      }
    }
  },
  {
    name: "get_email_by_id",
    description: "Get a specific email by its ID",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID to retrieve" },
        folder: { type: "string", description: "Folder to search in (optional, uses cached folder or INBOX)" }
      },
      required: ["emailId"]
    }
  },
  {
    name: "search_emails",
    description: "Search emails with filters",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in subject/body" },
        folder: { type: "string", description: "Folder to search in" },
        from: { type: "string", description: "Filter by sender" },
        to: { type: "string", description: "Filter by recipient" },
        subject: { type: "string", description: "Filter by subject" },
        isRead: { type: "boolean", description: "Filter by read status" },
        isStarred: { type: "boolean", description: "Filter starred emails" },
        dateFrom: { type: "string", description: "Start date (ISO format)" },
        dateTo: { type: "string", description: "End date (ISO format)" },
        limit: { type: "number", description: "Max results (default: 50)", default: 50 }
      }
    }
  },
  {
    name: "get_folders",
    description: "Get all email folders",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_email_stats",
    description: "Get email statistics",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_contacts",
    description: "Get contact list with interaction counts",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max contacts to return", default: 50 }
      }
    }
  },
  {
    name: "get_connection_status",
    description: "Check IMAP connection status",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sync_emails",
    description: "Sync emails from server",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to sync (default: INBOX)" }
      }
    }
  }
];

const DRAFT_TOOLS = [
  {
    name: "create_draft",
    description:
      "Save an email as a draft in Proton Mail. Nothing is sent: the draft waits in the Drafts folder until a human opens and sends it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma-separated" },
        cc: { type: "string", description: "CC recipients, comma-separated" },
        bcc: { type: "string", description: "BCC recipients, comma-separated" },
        subject: { type: "string", description: "Email subject (umlauts are encoded automatically)" },
        body: { type: "string", description: "Email body content" },
        isHtml: { type: "boolean", description: "Whether body is HTML", default: false },
        from: { type: "string", description: "Sender address (defaults to the configured mailbox)" },
        inReplyTo: {
          type: "string",
          description:
            "Message-Id of the email being replied to. Note: Proton Bridge rewrites drafts on APPEND and discards this header, so it does NOT thread the draft in Proton Mail. Kept for other IMAP servers and for when the message is sent."
        },
        references: {
          type: "string",
          description:
            "Full References chain, space-separated; defaults to inReplyTo alone. Proton Bridge replaces it with its own internal id (see inReplyTo)."
        },
        attachments: {
          type: "array",
          description:
            "Files to attach (25 MB total). Prefer path for local files; use content only for small generated data.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to a local file on the machine running this server" },
              content: { type: "string", description: "Base64-encoded file content (alternative to path)" },
              filename: { type: "string", description: "File name shown to the recipient; required with content, defaults to the file's name with path" },
              contentType: { type: "string", description: "MIME type; guessed from the file extension when omitted" }
            }
          }
        }
      },
      required: ["to", "subject", "body"]
    }
  }
];

const WRITE_TOOLS = [
  {
    name: "send_email",
    description: "Send an email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma-separated" },
        cc: { type: "string", description: "CC recipients, comma-separated" },
        bcc: { type: "string", description: "BCC recipients, comma-separated" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body content" },
        isHtml: { type: "boolean", description: "Whether body is HTML", default: false }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "delete_email",
    description: "Delete an email",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID to delete" }
      },
      required: ["emailId"]
    }
  },
  {
    name: "move_email",
    description: "Move email to a different folder",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        targetFolder: { type: "string", description: "Target folder name" }
      },
      required: ["emailId", "targetFolder"]
    }
  },
  {
    name: "mark_email_read",
    description: "Mark email as read/unread",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        isRead: { type: "boolean", description: "Read status", default: true }
      },
      required: ["emailId"]
    }
  },
  {
    name: "star_email",
    description: "Star/unstar an email",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        isStarred: { type: "boolean", description: "Star status", default: true }
      },
      required: ["emailId"]
    }
  }
];

// Create MCP server
const server = new Server(
  {
    name: "protonmail-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools based on mode
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    ...READ_ONLY_TOOLS,
    ...(ALLOW_DRAFTS ? DRAFT_TOOLS : []),
    ...(READ_ONLY_MODE ? [] : WRITE_TOOLS),
  ];

  logger.debug(
    `Listing ${tools.length} tools (read-only: ${READ_ONLY_MODE}, drafts: ${ALLOW_DRAFTS})`,
    "MCPServer"
  );
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.debug(`Tool called: ${name}`, "MCPServer");

  // Block write operations in read-only mode
  const writeOps = ["send_email", "delete_email", "move_email", "mark_email_read", "star_email"];
  if (READ_ONLY_MODE && writeOps.includes(name)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Operation "${name}" is disabled in read-only mode. Set READ_ONLY_MODE=false to enable.`
    );
  }

  if (name === "create_draft" && !ALLOW_DRAFTS) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Operation "create_draft" is disabled. Set ALLOW_DRAFTS=true to enable draft creation without enabling sending.`
    );
  }

  try {
    switch (name) {
      // === READ OPERATIONS ===

      case "get_emails": {
        const folder = (args?.folder as string) || "INBOX";
        const limit = (args?.limit as number) || 20;
        const offset = (args?.offset as number) || 0;

        const result = await imapService.getEmails(folder, limit, offset);
        analyticsService.updateWithEmails(result.emails);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              folder,
              count: result.emails.length,
              totalMessages: result.totalMessages,
              hasMore: result.hasMore,
              emails: result.emails.map(e => ({
                id: e.id,
                from: e.from,
                to: e.to,
                subject: e.subject,
                date: e.date,
                isRead: e.isRead,
                isStarred: e.isStarred,
                preview: e.body.substring(0, 200)
              }))
            }, null, 2)
          }]
        };
      }

      case "get_email_by_id": {
        const emailId = args?.emailId as string;
        const folder = args?.folder as string | undefined;
        if (!emailId) {
          throw new McpError(ErrorCode.InvalidParams, "emailId is required");
        }

        const email = await imapService.getEmailById(emailId, folder);
        if (!email) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Email not found" }) }]
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(email, null, 2) }]
        };
      }

      case "search_emails": {
        const searchOptions = {
          query: args?.query as string | undefined,
          folder: args?.folder as string | undefined,
          from: args?.from as string | undefined,
          to: args?.to as string | undefined,
          subject: args?.subject as string | undefined,
          isRead: args?.isRead as boolean | undefined,
          isStarred: args?.isStarred as boolean | undefined,
          dateFrom: args?.dateFrom ? new Date(args.dateFrom as string) : undefined,
          dateTo: args?.dateTo ? new Date(args.dateTo as string) : undefined,
          limit: (args?.limit as number) || 50
        };

        const emails = await imapService.searchEmails(searchOptions);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: emails.length,
              emails: emails.map(e => ({
                id: e.id,
                from: e.from,
                subject: e.subject,
                date: e.date,
                preview: e.body.substring(0, 200)
              }))
            }, null, 2)
          }]
        };
      }

      case "get_folders": {
        const folders = await imapService.getFolders();
        return {
          content: [{ type: "text", text: JSON.stringify({ folders }, null, 2) }]
        };
      }

      case "get_email_stats": {
        const stats = analyticsService.getStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }]
        };
      }

      case "get_contacts": {
        const limit = (args?.limit as number) || 50;
        const contacts = analyticsService.getContacts(limit);
        return {
          content: [{ type: "text", text: JSON.stringify({ contacts }, null, 2) }]
        };
      }

      case "get_connection_status": {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              imap: imapService.isConnectionActive(),
              smtp: READ_ONLY_MODE ? "disabled (read-only mode)" : smtpService.isConnectionActive(),
              readOnlyMode: READ_ONLY_MODE
            }, null, 2)
          }]
        };
      }

      case "sync_emails": {
        const folder = (args?.folder as string) || "INBOX";
        await imapService.syncFolder(folder);
        return {
          content: [{ type: "text", text: JSON.stringify({ synced: folder }) }]
        };
      }

      // === DRAFT OPERATIONS (gated by ALLOW_DRAFTS, never send anything) ===

      case "create_draft": {
        const result = await imapService.createDraft({
          to: args?.to as string,
          cc: args?.cc as string | undefined,
          bcc: args?.bcc as string | undefined,
          subject: args?.subject as string,
          body: args?.body as string,
          isHtml: args?.isHtml as boolean | undefined,
          from: args?.from as string | undefined,
          inReplyTo: args?.inReplyTo as string | undefined,
          references: args?.references as string | undefined,
          attachments: args?.attachments as AttachmentInput[] | undefined
        }, { allowedDirs: ATTACHMENT_DIRS });

        logger.info(`Draft created in "${result.folder}"`, "MCPServer");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, sent: false, ...result }, null, 2)
          }]
        };
      }

      // === WRITE OPERATIONS (blocked in read-only mode) ===

      case "send_email": {
        const result = await smtpService.sendEmail({
          to: args?.to as string,
          cc: args?.cc as string | undefined,
          bcc: args?.bcc as string | undefined,
          subject: args?.subject as string,
          body: args?.body as string,
          isHtml: args?.isHtml as boolean | undefined
        });

        logger.info(`Email sent: ${result.messageId}`, "MCPServer");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, messageId: result.messageId })
          }]
        };
      }

      case "delete_email": {
        const emailId = args?.emailId as string;
        await imapService.deleteEmail(emailId);
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted: emailId }) }]
        };
      }

      case "move_email": {
        const emailId = args?.emailId as string;
        const targetFolder = args?.targetFolder as string;
        await imapService.moveEmail(emailId, targetFolder);
        return {
          content: [{ type: "text", text: JSON.stringify({ moved: emailId, to: targetFolder }) }]
        };
      }

      case "mark_email_read": {
        const emailId = args?.emailId as string;
        const isRead = args?.isRead !== false;
        await imapService.markAsRead(emailId, isRead);
        return {
          content: [{ type: "text", text: JSON.stringify({ emailId, isRead }) }]
        };
      }

      case "star_email": {
        const emailId = args?.emailId as string;
        const isStarred = args?.isStarred !== false;
        await imapService.starEmail(emailId, isStarred);
        return {
          content: [{ type: "text", text: JSON.stringify({ emailId, isStarred }) }]
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;

    logger.error(`Tool error: ${name}`, "MCPServer", error);
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Main startup
async function main() {
  logger.info("Starting Proton Mail MCP Server...", "MCPServer");

  try {
    // Connect to IMAP (Proton Bridge)
    logger.info("Connecting to IMAP...", "MCPServer");
    try {
      await imapService.connect();
      logger.info("IMAP connected", "MCPServer");
    } catch (imapError) {
      logger.warn("IMAP connection failed - make sure Proton Bridge is running", "MCPServer", imapError);
    }

    // Verify SMTP only if not in read-only mode
    if (!READ_ONLY_MODE) {
      logger.info("Verifying SMTP connection...", "MCPServer");
      try {
        await smtpService.verifyConnection();
        logger.info("SMTP connected", "MCPServer");
      } catch (smtpError) {
        logger.warn("SMTP connection failed", "MCPServer", smtpError);
      }
    }

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info(`MCP Server started (read-only: ${READ_ONLY_MODE})`, "MCPServer");

  } catch (error) {
    logger.error("Server startup failed", "MCPServer", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("Shutting down...", "MCPServer");
  try {
    await imapService.disconnect();
    if (!READ_ONLY_MODE) await smtpService.close();
    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", "MCPServer", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", "MCPServer", reason);
  process.exit(1);
});

main();
