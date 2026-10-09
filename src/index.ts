#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "node:path";
import {
  resolveConfig,
  createClient,
  resolveStatus,
  labelHint,
  countComments,
  formatTask,
  formatComment,
  formatColumn,
  formatAttachment,
  formatBytes,
  saveFile,
} from "./shared.js";

const config = resolveConfig();
const client = createClient(config);

// ── MCP Server ──────────────────────────────────────────────

const server = new McpServer({
  name: "bugherd",
  version: "1.0.0",
});

// ── Tool: get_project ───────────────────────────────────────

server.tool(
  "get_project",
  "Get project details including members, guests, and columns",
  {},
  async () => {
    const project = await client.getProject();
    const columnLabels = client.columnLabels;
    const labelInfo = [];
    if (columnLabels.pending) labelInfo.push(`Pending → "${columnLabels.pending}"`);
    if (columnLabels.inProgress) labelInfo.push(`In Progress → "${columnLabels.inProgress}"`);
    if (columnLabels.done) labelInfo.push(`Done → "${columnLabels.done}"`);

    const lines = [
      `Project: ${project.name} (id: ${project.id})`,
      `URL: ${project.devurl}`,
      `Active: ${project.is_active}`,
      "",
      "Columns:",
      ...project.columns.map(c => `  ${formatColumn(c)}`),
    ];

    if (labelInfo.length) {
      lines.push("", "Configured column labels:", ...labelInfo.map(l => `  ${l}`));
    }

    if (project.members.length) {
      lines.push("", "Members:", ...project.members.map(m => `  ${m.display_name} (${m.email}, id: ${m.id})`));
    }
    if (project.guests.length) {
      lines.push("", "Guests:", ...project.guests.map(g => `  ${g.display_name} (${g.email}, id: ${g.id})`));
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: list_columns ──────────────────────────────────────

server.tool(
  "list_columns",
  "List all columns (statuses) in the project",
  {},
  async () => {
    const columns = await client.listColumns();
    const text = columns.map(c => formatColumn(c)).join("\n");
    return { content: [{ type: "text", text: text || "No columns found." }] };
  }
);

// ── Tool: list_tasks ────────────────────────────────────────

server.tool(
  "list_tasks",
  `List tasks in the project with optional filters. Returns up to 100 tasks per page. Each task shows its comment count (including private comments); use list_comments to read them. The status filter forwards to BH's lifecycle filter, not a true column filter — see the status param description for the conflation; use list_columns / get_project to see the actual columns.${labelHint(client)}`,
  {
    status: z.string().optional().describe(`Filter by BugHerd LIFECYCLE state (forwarded as ?status= to the API). Common values: "closed" (closed tasks, detached from columns), plus column-name strings that BH happens to use as lifecycle labels for OPEN tasks (e.g. "Ready for Review", "In Progress", "IGNITE Review"). Does NOT reliably filter by column — notably "Completed" returns 0 (those tasks have lifecycle "closed"), and any non-default column whose name BH doesn't echo as a lifecycle label will also return 0. Use list_columns + get_project to see which columns actually map to a matching lifecycle. Shorthand: "pending", "in_progress", "done" (resolved to the BUGHERD_COLUMN_* env values).${labelHint(client)}`),
    priority: z.string().optional().describe("Filter by priority: not set, critical, important, normal, minor"),
    tag: z.string().optional().describe("Filter by tag name"),
    assigned_to_id: z.number().optional().describe("Filter by assignee user ID"),
    external_id: z.string().optional().describe("Filter by external ID (e.g. JIRA ticket)"),
    updated_since: z.string().optional().describe("ISO datetime — only return tasks updated after this time"),
    created_since: z.string().optional().describe("ISO datetime — only return tasks created after this time"),
    page: z.number().optional().describe("Page number (default 1, max 100 results per page)"),
  },
  async (params) => {
    const resolved = { ...params };
    if (resolved.status) {
      resolved.status = resolveStatus(client, resolved.status);
    }
    const { tasks, count } = await client.listTasks(resolved);
    if (!tasks.length) {
      return { content: [{ type: "text", text: `No tasks found matching status "${resolved.status ?? "any"}" (total: ${count}).` }] };
    }
    const commentCounts = await countComments(client, tasks);
    const header = `Showing ${tasks.length} of ${count} tasks (page ${params.page ?? 1}):`;
    const text = [header, "", ...tasks.map(t => formatTask(t, commentCounts.get(t.id)))].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: get_task ──────────────────────────────────────────

server.tool(
  "get_task",
  "Get full details of a single task by its global ID or local #number",
  {
    task_id: z.number().optional().describe("Global task ID"),
    local_task_id: z.number().optional().describe("Project-scoped local task number (the # number)"),
  },
  async (params) => {
    if (!params.task_id && !params.local_task_id) {
      return { content: [{ type: "text", text: "Provide either task_id or local_task_id." }], isError: true };
    }
    const task = params.local_task_id
      ? await client.getTaskByLocalId(params.local_task_id)
      : await client.getTask(params.task_id!);
    return { content: [{ type: "text", text: formatTask(task) }] };
  }
);

// ── Tool: create_task ───────────────────────────────────────

server.tool(
  "create_task",
  "Create a new task/bug in the project",
  {
    description: z.string().describe("Task description (required)"),
    priority: z.enum(["not set", "critical", "important", "normal", "minor"]).optional().describe("Task priority"),
    status: z.string().optional().describe(`Column/status name or shorthand ("pending", "in_progress", "done"). Omit for feedback/triage.${labelHint(client)}`),
    assigned_to_email: z.string().optional().describe("Email of the team member to assign"),
    assigned_to_id: z.number().optional().describe("User ID to assign"),
    requester_email: z.string().optional().describe("Email of the person reporting the bug"),
    tag_names: z.array(z.string()).optional().describe("Tags to apply"),
    external_id: z.string().optional().describe("External reference ID (e.g. JIRA-123)"),
  },
  async (params) => {
    const resolved = { ...params };
    if (resolved.status) resolved.status = resolveStatus(client, resolved.status);
    const task = await client.createTask(resolved);
    return { content: [{ type: "text", text: `Task created:\n${formatTask(task)}` }] };
  }
);

// ── Tool: update_task ───────────────────────────────────────

server.tool(
  "update_task",
  "Update an existing task (description, priority, tags, external ID, assignee, etc.)",
  {
    task_id: z.number().describe("Global task ID to update"),
    description: z.string().optional().describe("New description"),
    priority: z.enum(["not set", "critical", "important", "normal", "minor"]).optional().describe("New priority"),
    assigned_to_id: z.number().nullable().optional().describe("User ID to assign (null to unassign all)"),
    assigned_to_email: z.string().optional().describe("Email to assign"),
    unassign_user: z.number().optional().describe("Remove specific assignee by user ID"),
    tag_names: z.array(z.string()).optional().describe("Replace all tags with this list"),
    external_id: z.string().optional().describe("Set external reference ID"),
    site: z.string().optional().describe("Override the site URL"),
    url: z.string().optional().describe("Override the page path"),
  },
  async ({ task_id, ...updates }) => {
    const task = await client.updateTask(task_id, updates);
    return { content: [{ type: "text", text: `Task updated:\n${formatTask(task)}` }] };
  }
);

// ── Tool: move_task ─────────────────────────────────────────

server.tool(
  "move_task",
  `Move a task to a different column/status. Accepts any column name or shorthand labels.${labelHint(client)}`,
  {
    task_id: z.number().describe("Global task ID"),
    column: z.string().describe(`Target column name or shorthand ("pending", "in_progress", "done").${labelHint(client)}`),
  },
  async ({ task_id, column }) => {
    const targetStatus = resolveStatus(client, column);
    const task = await client.updateTask(task_id, { status: targetStatus });
    return { content: [{ type: "text", text: `Task #${task.local_task_id} moved to "${task.status}":\n${formatTask(task)}` }] };
  }
);

// ── Tool: add_comment ───────────────────────────────────────

server.tool(
  "add_comment",
  "Add a comment to a task",
  {
    task_id: z.number().describe("Global task ID"),
    text: z.string().describe("Comment text"),
    email: z.string().optional().describe("Post as this user (by email)"),
    is_private: z.boolean().optional().describe("If true, only visible to team members (not guests/clients)"),
  },
  async ({ task_id, text, email, is_private }) => {
    const comment = await client.addComment(task_id, text, { email, is_private });
    return { content: [{ type: "text", text: `Comment added:\n${formatComment(comment)}` }] };
  }
);

// ── Tool: list_comments ─────────────────────────────────────

server.tool(
  "list_comments",
  "List all comments on a task, including private ones",
  {
    task_id: z.number().describe("Global task ID"),
  },
  async ({ task_id }) => {
    const comments = await client.listComments(task_id);
    if (!comments.length) {
      return { content: [{ type: "text", text: "No comments on this task." }] };
    }
    const text = comments.map(c => formatComment(c)).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: list_attachments ──────────────────────────────────

server.tool(
  "list_attachments",
  "List all attachments on a task",
  {
    task_id: z.number().describe("Global task ID"),
  },
  async ({ task_id }) => {
    const attachments = await client.listAttachments(task_id);
    if (!attachments.length) {
      return { content: [{ type: "text", text: "No attachments on this task." }] };
    }
    const text = attachments.map(a => formatAttachment(a)).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: get_attachment ────────────────────────────────────

server.tool(
  "get_attachment",
  "Download a task attachment, or the task's annotated screenshot, to a file. Always writes to disk and returns the path — file contents are never returned inline, whatever the size or type. Read the returned path to view the file. Select the attachment by attachment_id or file_name (use list_attachments to see them), or pass screenshot:true for the BugHerd capture, which is not in the attachments list.",
  {
    task_id: z.number().describe("Global task ID"),
    attachment_id: z.number().optional().describe("Attachment ID to download"),
    file_name: z.string().optional().describe("Attachment file name to download (case-insensitive), e.g. 'Stacked cards.png'"),
    screenshot: z.boolean().optional().describe("Download the task's annotated screenshot instead of an attachment"),
    save_to: z.string().optional().describe("Path to write the file to. Defaults to a temp directory. Will not overwrite an existing file."),
  },
  async ({ task_id, attachment_id, file_name, screenshot, save_to }) => {
    if (!screenshot && attachment_id === undefined && !file_name) {
      return {
        content: [{ type: "text", text: "Provide attachment_id, file_name, or screenshot:true." }],
        isError: true,
      };
    }

    const { name, contentType, bytes, source } = screenshot
      ? await client.downloadScreenshot(task_id).then(r => ({
          name: path.basename(new URL(r.url).pathname),
          contentType: r.contentType,
          bytes: r.bytes,
          source: `screenshot of task ${task_id}`,
        }))
      : await client.downloadAttachment(task_id, { attachmentId: attachment_id, fileName: file_name }).then(r => ({
          name: r.attachment.file_name,
          contentType: r.contentType,
          bytes: r.bytes,
          source: `${r.attachment.file_name} (id: ${r.attachment.id})`,
        }));

    const savedPath = saveFile(bytes, name, save_to);
    const summary = `${source} — ${contentType}, ${formatBytes(bytes.length)}`;
    return { content: [{ type: "text", text: `${summary}\nSaved to: ${savedPath}` }] };
  }
);

// ── Tool: add_attachment ────────────────────────────────────

server.tool(
  "add_attachment",
  "Add an attachment to a task from a URL or local file path (BugHerd's API accepts both — local paths are read and uploaded by the BH service when reachable from its workers)",
  {
    task_id: z.number().describe("Global task ID"),
    file_name: z.string().describe("Name for the file (e.g. screenshot.png)"),
    url: z.string().describe("Public URL OR local filesystem path of the file to attach (BH accepts both shapes for this endpoint)"),
  },
  async ({ task_id, file_name, url }) => {
    const attachment = await client.addAttachment(task_id, file_name, url);
    return { content: [{ type: "text", text: `Attachment added:\n${formatAttachment(attachment)}` }] };
  }
);

// ── Tool: delete_attachment ─────────────────────────────────

server.tool(
  "delete_attachment",
  "Delete an attachment from a task",
  {
    task_id: z.number().describe("Global task ID"),
    attachment_id: z.number().describe("Attachment ID to delete"),
  },
  async ({ task_id, attachment_id }) => {
    await client.deleteAttachment(task_id, attachment_id);
    return { content: [{ type: "text", text: `Attachment ${attachment_id} deleted.` }] };
  }
);

// ── Tool: list_members ──────────────────────────────────────

server.tool(
  "list_members",
  "List all team members in the organization",
  {},
  async () => {
    const members = await client.listMembers();
    if (!members.length) {
      return { content: [{ type: "text", text: "No members found." }] };
    }
    const text = members.map(m => `${m.display_name} (${m.email}, id: ${m.id})`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: list_guests ───────────────────────────────────────

server.tool(
  "list_guests",
  "List all guests/clients in the organization",
  {},
  async () => {
    const guests = await client.listGuests();
    if (!guests.length) {
      return { content: [{ type: "text", text: "No guests found." }] };
    }
    const text = guests.map(g => `${g.display_name} (${g.email}, id: ${g.id})`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
