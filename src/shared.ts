import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { BugherdClient } from "./bugherd-client.js";
import type { Task, Comment, Column, TaskAttachment } from "./bugherd-client.js";

// ── Config: env first, then on-disk credential files ────────

const CREDENTIALS_DIR = path.join(os.homedir(), ".config", "bmcp");
const API_KEY_FILE = path.join(CREDENTIALS_DIR, "api-key");
const PROJECT_ID_FILE = path.join(CREDENTIALS_DIR, "project-id");

function readTrimmed(file: string): string | undefined {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export function resolveRequired(
  envVar: string,
  fileVar: string,
  defaultFile: string,
  label: string,
): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const file = process.env[fileVar] || defaultFile;
  const fromFile = readTrimmed(file);
  if (fromFile) return fromFile;
  console.error(
    `No BugHerd ${label} found: set ${envVar}, or write it to ${file} (mode 0600).`,
  );
  process.exit(1);
}

export function resolveConfig() {
  const apiKey = resolveRequired(
    "BUGHERD_API_KEY",
    "BUGHERD_API_KEY_FILE",
    API_KEY_FILE,
    "API key",
  );
  const projectId = resolveRequired(
    "BUGHERD_PROJECT_ID",
    "BUGHERD_PROJECT_ID_FILE",
    PROJECT_ID_FILE,
    "project ID",
  );

  const maxConcurrency = process.env.BUGHERD_MAX_CONCURRENT_REQUESTS
    ? Number(process.env.BUGHERD_MAX_CONCURRENT_REQUESTS)
    : undefined;
  const maxRetryDelayMs = process.env.BUGHERD_MAX_RETRY_DELAY_MS
    ? Number(process.env.BUGHERD_MAX_RETRY_DELAY_MS)
    : undefined;
  const maxRetries = process.env.BUGHERD_MAX_RETRIES
    ? Number(process.env.BUGHERD_MAX_RETRIES)
    : undefined;

  return { apiKey, projectId, maxConcurrency, maxRetryDelayMs, maxRetries };
}

export function createClient(config: ReturnType<typeof resolveConfig>): BugherdClient {
  return new BugherdClient({
    apiKey: config.apiKey,
    projectId: config.projectId,
    columnLabels: {
      pending: process.env.BUGHERD_COLUMN_PENDING || undefined,
      inProgress: process.env.BUGHERD_COLUMN_IN_PROGRESS || undefined,
      done: process.env.BUGHERD_COLUMN_DONE || undefined,
    },
    maxConcurrency: config.maxConcurrency,
    maxRetryDelayMs: config.maxRetryDelayMs,
    maxRetries: config.maxRetries,
  });
}

// ── Label resolution ────────────────────────────────────────

export function resolveStatus(client: BugherdClient, input: string): string {
  const lower = input.toLowerCase();
  const labels = client.columnLabels;
  if (labels.pending && (lower === "pending" || lower === labels.pending.toLowerCase())) {
    return labels.pending;
  }
  if (labels.inProgress && (lower === "in_progress" || lower === "in progress" || lower === labels.inProgress.toLowerCase())) {
    return labels.inProgress;
  }
  if (labels.done && (lower === "done_label" || lower === "done" || lower === labels.done.toLowerCase())) {
    return labels.done;
  }
  return input;
}

export function labelHint(client: BugherdClient): string {
  const labels = client.columnLabels;
  const parts: string[] = [];
  if (labels.pending) parts.push(`"pending" → "${labels.pending}"`);
  if (labels.inProgress) parts.push(`"in_progress" → "${labels.inProgress}"`);
  if (labels.done) parts.push(`"done" → "${labels.done}"`);
  if (!parts.length) return "";
  return ` Configured shorthand labels: ${parts.join(", ")}.`;
}

// ── Formatting ──────────────────────────────────────────────

export function formatTask(t: Task): string {
  const lines = [
    `#${t.local_task_id} (id: ${t.id})`,
    `  Status: ${t.status}`,
    `  Priority: ${t.priority}`,
  ];
  if (t.description) lines.push(`  Description: ${t.description}`);
  if (t.assigned_to) lines.push(`  Assigned to: ${t.assigned_to.display_name} (${t.assigned_to.email})`);
  if (t.assignees?.length) {
    lines.push(`  Assignees: ${t.assignees.map(a => a.display_name).join(", ")}`);
  }
  if (t.tag_names?.length) lines.push(`  Tags: ${t.tag_names.join(", ")}`);
  if (t.external_id) lines.push(`  External ID: ${t.external_id}`);
  if (t.site) lines.push(`  Site: ${t.site}`);
  if (t.url) lines.push(`  URL: ${t.url}`);
  if (t.screenshot_url) lines.push(`  Screenshot: ${t.screenshot_url}`);
  if (t.attachments?.length) {
    lines.push(`  Attachments:`, ...t.attachments.map(a => `    ${formatAttachment(a)}`));
  }
  if (t.requester) lines.push(`  Requester: ${t.requester.display_name} (${t.requester.email})`);
  if (t.requester_browser) lines.push(`  Browser: ${t.requester_browser}`);
  if (t.requester_os) lines.push(`  OS: ${t.requester_os}`);
  if (t.requester_resolution) lines.push(`  Resolution: ${t.requester_resolution}`);
  if (t.due_at) lines.push(`  Due: ${t.due_at}`);
  if (t.secret_link) lines.push(`  Public link: ${t.secret_link}`);
  lines.push(`  Created: ${t.created_at}`);
  lines.push(`  Updated: ${t.updated_at}`);
  return lines.join("\n");
}

export function formatComment(c: Comment): string {
  const author = c.user_id === null ? "unknown user" : `user ${c.user_id}`;
  return `[${c.created_at}] (${author}${c.is_private ? ", private" : ""}): ${c.text}`;
}

export function formatColumn(c: Column): string {
  return `${c.name} (id: ${c.id}, tasks: ${c.tasks_count})`;
}

export function formatAttachment(a: TaskAttachment): string {
  return `${a.file_name} (id: ${a.id}) — ${a.url}`;
}

export function formatBytes(n: number): string {
  return n < 1024 * 1024
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function saveFile(bytes: Buffer, fileName: string, saveTo?: string): string {
  const target = saveTo
    ? path.resolve(saveTo)
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bugherd-")), path.basename(fileName));
  if (fs.existsSync(target)) {
    throw new Error(`Refusing to overwrite existing file: ${target}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}
