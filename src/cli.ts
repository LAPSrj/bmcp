#!/usr/bin/env node

import * as path from "node:path";
import {
  resolveConfig,
  createClient,
  resolveStatus,
  formatTask,
  formatComment,
  formatColumn,
  formatAttachment,
  formatBytes,
  saveFile,
} from "./shared.js";

const config = resolveConfig();
const client = createClient(config);

// ── Arg parsing ─────────────────────────────────────────────

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function requireArg(positional: string[], index: number, name: string): string {
  const val = positional[index];
  if (!val) {
    console.error(`Missing required argument: <${name}>`);
    process.exit(1);
  }
  return val;
}

function parseTaskId(raw: string): { task_id?: number; local_task_id?: number } {
  if (raw.startsWith("#")) {
    return { local_task_id: Number(raw.slice(1)) };
  }
  return { task_id: Number(raw) };
}

// ── Commands ────────────────────────────────────────────────

async function cmdProject() {
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
  console.log(lines.join("\n"));
}

async function cmdColumns() {
  const columns = await client.listColumns();
  if (!columns.length) {
    console.log("No columns found.");
    return;
  }
  console.log(columns.map(c => formatColumn(c)).join("\n"));
}

async function cmdTasks(flags: Record<string, string | true>) {
  const params: Record<string, unknown> = {};
  if (flags.status) params.status = resolveStatus(client, String(flags.status));
  if (flags.priority) params.priority = String(flags.priority);
  if (flags.tag) params.tag = String(flags.tag);
  if (flags["assigned-to"]) params.assigned_to_id = Number(flags["assigned-to"]);
  if (flags["external-id"]) params.external_id = String(flags["external-id"]);
  if (flags["updated-since"]) params.updated_since = String(flags["updated-since"]);
  if (flags["created-since"]) params.created_since = String(flags["created-since"]);
  if (flags.page) params.page = Number(flags.page);

  const { tasks, count } = await client.listTasks(params);
  if (!tasks.length) {
    console.log(`No tasks found (total: ${count}).`);
    return;
  }
  const page = params.page ? Number(params.page) : 1;
  console.log(`Showing ${tasks.length} of ${count} tasks (page ${page}):\n`);
  console.log(tasks.map(t => formatTask(t)).join("\n"));
}

async function cmdTask(positional: string[]) {
  const raw = requireArg(positional, 0, "task-id");
  const id = parseTaskId(raw);
  const task = id.local_task_id
    ? await client.getTaskByLocalId(id.local_task_id)
    : await client.getTask(id.task_id!);
  console.log(formatTask(task));
}

async function cmdCreate(positional: string[], flags: Record<string, string | true>) {
  const description = requireArg(positional, 0, "description");
  const params: Record<string, unknown> = { description };
  if (flags.priority) params.priority = String(flags.priority);
  if (flags.status) params.status = resolveStatus(client, String(flags.status));
  if (flags["assign-email"]) params.assigned_to_email = String(flags["assign-email"]);
  if (flags["assign-id"]) params.assigned_to_id = Number(flags["assign-id"]);
  if (flags.requester) params.requester_email = String(flags.requester);
  if (flags.tags) params.tag_names = String(flags.tags).split(",");
  if (flags["external-id"]) params.external_id = String(flags["external-id"]);

  const task = await client.createTask(params as Parameters<typeof client.createTask>[0]);
  console.log(`Task created:\n${formatTask(task)}`);
}

async function cmdUpdate(positional: string[], flags: Record<string, string | true>) {
  const raw = requireArg(positional, 0, "task-id");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const updates: Record<string, unknown> = {};
  if (flags.description) updates.description = String(flags.description);
  if (flags.priority) updates.priority = String(flags.priority);
  if (flags["assign-email"]) updates.assigned_to_email = String(flags["assign-email"]);
  if (flags["assign-id"]) updates.assigned_to_id = Number(flags["assign-id"]);
  if (flags.unassign) updates.assigned_to_id = null;
  if (flags.tags) updates.tag_names = String(flags.tags).split(",");
  if (flags["external-id"]) updates.external_id = String(flags["external-id"]);
  if (flags.site) updates.site = String(flags.site);
  if (flags.url) updates.url = String(flags.url);

  const task = await client.updateTask(taskId, updates);
  console.log(`Task updated:\n${formatTask(task)}`);
}

async function cmdMove(positional: string[]) {
  const raw = requireArg(positional, 0, "task-id");
  const column = requireArg(positional, 1, "column");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const targetStatus = resolveStatus(client, column);
  const task = await client.updateTask(taskId, { status: targetStatus });
  console.log(`Task #${task.local_task_id} moved to "${task.status}":\n${formatTask(task)}`);
}

async function cmdComments(positional: string[]) {
  const raw = requireArg(positional, 0, "task-id");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const comments = await client.listComments(taskId);
  if (!comments.length) {
    console.log("No comments on this task.");
    return;
  }
  console.log(comments.map(c => formatComment(c)).join("\n"));
}

async function cmdComment(positional: string[], flags: Record<string, string | true>) {
  const raw = requireArg(positional, 0, "task-id");
  const text = requireArg(positional, 1, "text");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const opts: { email?: string; is_private?: boolean } = {};
  if (flags.email) opts.email = String(flags.email);
  if (flags.private === true) opts.is_private = true;

  const comment = await client.addComment(taskId, text, opts);
  console.log(`Comment added:\n${formatComment(comment)}`);
}

async function cmdAttachments(positional: string[]) {
  const raw = requireArg(positional, 0, "task-id");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const attachments = await client.listAttachments(taskId);
  if (!attachments.length) {
    console.log("No attachments on this task.");
    return;
  }
  console.log(attachments.map(a => formatAttachment(a)).join("\n"));
}

async function cmdDownload(positional: string[], flags: Record<string, string | true>) {
  const raw = requireArg(positional, 0, "task-id");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const screenshot = flags.screenshot === true;
  const attachmentId = flags["attachment-id"] ? Number(flags["attachment-id"]) : undefined;
  const fileName = flags["file-name"] ? String(flags["file-name"]) : undefined;
  const saveTo = flags["save-to"] ? String(flags["save-to"]) : undefined;

  if (!screenshot && attachmentId === undefined && !fileName) {
    console.error("Provide --attachment-id, --file-name, or --screenshot.");
    process.exit(1);
  }

  const { name, contentType, bytes, source } = screenshot
    ? await client.downloadScreenshot(taskId).then(r => ({
        name: path.basename(new URL(r.url).pathname),
        contentType: r.contentType,
        bytes: r.bytes,
        source: `screenshot of task ${taskId}`,
      }))
    : await client.downloadAttachment(taskId, { attachmentId, fileName }).then(r => ({
        name: r.attachment.file_name,
        contentType: r.contentType,
        bytes: r.bytes,
        source: `${r.attachment.file_name} (id: ${r.attachment.id})`,
      }));

  const savedPath = saveFile(bytes, name, saveTo);
  console.log(`${source} — ${contentType}, ${formatBytes(bytes.length)}`);
  console.log(`Saved to: ${savedPath}`);
}

async function cmdAttach(positional: string[]) {
  const raw = requireArg(positional, 0, "task-id");
  const fileName = requireArg(positional, 1, "file-name");
  const url = requireArg(positional, 2, "url");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  const attachment = await client.addAttachment(taskId, fileName, url);
  console.log(`Attachment added:\n${formatAttachment(attachment)}`);
}

async function cmdDetach(positional: string[]) {
  const raw = requireArg(positional, 0, "task-id");
  const attachmentIdStr = requireArg(positional, 1, "attachment-id");
  const id = parseTaskId(raw);
  let taskId: number;
  if (id.local_task_id) {
    const task = await client.getTaskByLocalId(id.local_task_id);
    taskId = task.id;
  } else {
    taskId = id.task_id!;
  }

  await client.deleteAttachment(taskId, Number(attachmentIdStr));
  console.log(`Attachment ${attachmentIdStr} deleted.`);
}

async function cmdMembers() {
  const members = await client.listMembers();
  if (!members.length) {
    console.log("No members found.");
    return;
  }
  console.log(members.map(m => `${m.display_name} (${m.email}, id: ${m.id})`).join("\n"));
}

async function cmdGuests() {
  const guests = await client.listGuests();
  if (!guests.length) {
    console.log("No guests found.");
    return;
  }
  console.log(guests.map(g => `${g.display_name} (${g.email}, id: ${g.id})`).join("\n"));
}

// ── Help ────────────────────────────────────────────────────

function usage(): never {
  console.error(`bugherd — CLI for the BugHerd API

Usage: bugherd <command> [args] [flags]

Commands:
  project                          Show project details
  columns                          List columns/statuses
  tasks [--status=X] [--priority=X] [--tag=X] [--page=N]
                                   List tasks (filters optional)
  task <id>                        Show a single task (use #N for local ID)
  create <description> [--priority=X] [--status=X] [--tags=a,b]
                                   Create a task
  update <id> [--description=X] [--priority=X] [--tags=a,b]
                                   Update a task
  move <id> <column>               Move a task to a column
  comments <id>                    List comments on a task
  comment <id> <text> [--private] [--email=X]
                                   Add a comment
  attachments <id>                 List attachments on a task
  download <id> [--attachment-id=N | --file-name=X | --screenshot]
                                   Download an attachment or screenshot
  attach <id> <file-name> <url>    Add an attachment
  detach <id> <attachment-id>      Delete an attachment
  members                          List team members
  guests                           List guests/clients

Task IDs accept global numeric IDs or #N for local task numbers.
Configuration: BUGHERD_API_KEY, BUGHERD_PROJECT_ID (env or ~/.config/bmcp/).
`);
  process.exit(2);
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") usage();

  const command = args[0]!;
  const { positional, flags } = parseFlags(args.slice(1));

  switch (command) {
    case "project":   await cmdProject(); break;
    case "columns":   await cmdColumns(); break;
    case "tasks":     await cmdTasks(flags); break;
    case "task":      await cmdTask(positional); break;
    case "create":    await cmdCreate(positional, flags); break;
    case "update":    await cmdUpdate(positional, flags); break;
    case "move":      await cmdMove(positional); break;
    case "comments":  await cmdComments(positional); break;
    case "comment":   await cmdComment(positional, flags); break;
    case "attachments": await cmdAttachments(positional); break;
    case "download":  await cmdDownload(positional, flags); break;
    case "attach":    await cmdAttach(positional); break;
    case "detach":    await cmdDetach(positional); break;
    case "members":   await cmdMembers(); break;
    case "guests":    await cmdGuests(); break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
