const BASE_URL = "https://www.bugherd.com";

const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

export interface BugherdConfig {
  apiKey: string;
  projectId: string;
  columnLabels?: {
    pending?: string;
    inProgress?: string;
    done?: string;
  };
  /** Maximum number of concurrent API requests (default: 3) */
  maxConcurrency?: number;
  /** Maximum time in ms to wait on a 429 retry before returning the error (default: 30000) */
  maxRetryDelayMs?: number;
  /** Maximum number of retries on 429 responses (default: 3) */
  maxRetries?: number;
}

// ── Simple promise-based semaphore ─────────────────────────

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

export interface User {
  id: number;
  email: string;
  display_name: string;
  avatar_url?: string;
}

export interface Column {
  id: number;
  name: string;
  project_id: number;
  tasks_count: number;
}

export interface Task {
  id: number;
  local_task_id: number;
  project_id: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  title?: string;
  description: string;
  status: string;
  status_id: number | null;
  priority: string;
  priority_id: number;
  site?: string;
  url?: string;
  tag_names: string[];
  external_id: string | null;
  requester_email?: string;
  attachments?: string[];
  screenshot_url: string | null;
  secret_link?: string;
  admin_link?: string;
  assigned_to?: User | null;
  requester?: User | null;
  assignees?: User[];
  due_at?: string | null;
  metadata?: Record<string, string> | null;
  requester_os?: string | null;
  requester_browser?: string | null;
  requester_browser_size?: string | null;
  requester_resolution?: string | null;
}

export interface Comment {
  id: number;
  text: string;
  created_at: string;
  user_id: number;
  is_private: boolean;
}

export interface Attachment {
  id: number;
  file_name: string;
  url: string;
  created_at: string;
}

export interface Project {
  id: number;
  name: string;
  devurl: string;
  is_active: boolean;
  is_public: boolean;
  members: User[];
  guests: User[];
  columns: Column[];
}

interface ListParams {
  page?: number;
  updated_since?: string;
  created_since?: string;
  status?: string;
  priority?: string;
  tag?: string;
  assigned_to_id?: number;
  external_id?: string;
}

export class BugherdClient {
  private authHeader: string;
  public projectId: string;
  public columnLabels: { pending?: string; inProgress?: string; done?: string };
  private semaphore: Semaphore;
  private maxRetryDelayMs: number;
  private maxRetries: number;

  constructor(config: BugherdConfig) {
    this.authHeader =
      "Basic " + Buffer.from(config.apiKey + ":x").toString("base64");
    this.projectId = config.projectId;
    this.columnLabels = config.columnLabels ?? {};
    this.semaphore = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Parse the Retry-After header value into milliseconds.
   * Supports both delta-seconds and HTTP-date formats.
   */
  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const date = new Date(header).getTime();
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };

    if (body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    await this.semaphore.acquire();
    try {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const res = await fetch(url, init);

        if (res.status !== 429) {
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`BugHerd API ${method} ${path} → ${res.status}: ${text}`);
          }
          if (res.status === 204) return {} as T;
          const text = await res.text();
          try {
            return JSON.parse(text) as T;
          } catch {
            const ct = res.headers.get("content-type") ?? "n/a";
            const preview = text.length > 500 ? text.slice(0, 500) + "…[truncated]" : text;
            throw new Error(
              `BugHerd API ${method} ${path} → ${res.status} returned non-JSON ` +
              `(content-type: ${ct}, body length: ${text.length}): ${preview}`
            );
          }
        }

        // 429 — figure out how long to wait
        const retryAfterMs =
          this.parseRetryAfter(res.headers.get("Retry-After")) ??
          Math.min(1000 * 2 ** attempt, this.maxRetryDelayMs);

        if (retryAfterMs > this.maxRetryDelayMs) {
          const text = await res.text();
          throw new Error(
            `BugHerd API ${method} ${path} → 429: rate limited and retry delay ` +
            `(${Math.ceil(retryAfterMs / 1000)}s) exceeds maximum ` +
            `(${Math.ceil(this.maxRetryDelayMs / 1000)}s). ${text}`
          );
        }

        lastError = new Error(
          `BugHerd API ${method} ${path} → 429: rate limited (attempt ${attempt + 1}/${this.maxRetries + 1})`
        );

        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        }
      }

      throw lastError!;
    } finally {
      this.semaphore.release();
    }
  }

  // ── Projects ──────────────────────────────────────────────

  async getProject(): Promise<Project> {
    const data = await this.request<{ project: Project }>(
      "GET",
      `/api_v2/projects/${this.projectId}.json`
    );
    return data.project;
  }

  // ── Columns ───────────────────────────────────────────────

  async listColumns(): Promise<Column[]> {
    const data = await this.request<{ columns: Column[] }>(
      "GET",
      `/api_v2/projects/${this.projectId}/columns.json`
    );
    return data.columns;
  }

  // ── Tasks ─────────────────────────────────────────────────

  async listTasks(params?: ListParams): Promise<{ tasks: Task[]; count: number }> {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    const query = qs.toString() ? `?${qs.toString()}` : "";
    const data = await this.request<{ tasks: Task[]; meta: { count: number } }>(
      "GET",
      `/api_v2/projects/${this.projectId}/tasks.json${query}`
    );
    return { tasks: data.tasks, count: data.meta.count };
  }

  async getTask(taskId: number): Promise<Task> {
    const data = await this.request<{ task: Task }>(
      "GET",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}.json`
    );
    return data.task;
  }

  async getTaskByLocalId(localTaskId: number): Promise<Task> {
    const data = await this.request<{ task: Task }>(
      "GET",
      `/api_v2/projects/${this.projectId}/local_tasks/${localTaskId}.json`
    );
    return data.task;
  }

  async createTask(task: {
    description: string;
    priority?: string;
    status?: string;
    assigned_to_id?: number;
    assigned_to_email?: string;
    requester_email?: string;
    tag_names?: string[];
    external_id?: string;
  }): Promise<Task> {
    const data = await this.request<{ task: Task }>(
      "POST",
      `/api_v2/projects/${this.projectId}/tasks.json`,
      { task }
    );
    return data.task;
  }

  async updateTask(
    taskId: number,
    updates: {
      description?: string;
      priority?: string;
      status?: string;
      assigned_to_id?: number | null;
      assigned_to_email?: string;
      unassign_user?: number;
      tag_names?: string[];
      external_id?: string;
      site?: string;
      url?: string;
    }
  ): Promise<Task> {
    const data = await this.request<{ task: Task }>(
      "PUT",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}.json`,
      { task: updates }
    );
    return data.task;
  }

  // ── Comments ──────────────────────────────────────────────

  async listComments(taskId: number): Promise<Comment[]> {
    const data = await this.request<{ comments: Comment[] }>(
      "GET",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}/comments.json`
    );
    return data.comments;
  }

  async addComment(
    taskId: number,
    text: string,
    options?: { email?: string; is_private?: boolean }
  ): Promise<Comment> {
    const comment: Record<string, unknown> = { text };
    if (options?.email) comment.email = options.email;
    if (options?.is_private !== undefined) comment.is_private = options.is_private;
    const data = await this.request<{ comment: Comment }>(
      "POST",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}/comments.json`,
      { comment }
    );
    return data.comment;
  }

  // ── Attachments ───────────────────────────────────────────

  async listAttachments(taskId: number): Promise<Attachment[]> {
    const data = await this.request<{ attachments: Attachment[] }>(
      "GET",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}/attachments.json`
    );
    return data.attachments;
  }

  async addAttachment(
    taskId: number,
    fileName: string,
    url: string
  ): Promise<Attachment> {
    const data = await this.request<{ attachment: Attachment }>(
      "POST",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}/attachments.json`,
      { attachment: { file_name: fileName, url } }
    );
    return data.attachment;
  }

  async deleteAttachment(taskId: number, attachmentId: number): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api_v2/projects/${this.projectId}/tasks/${taskId}/attachments/${attachmentId}.json`
    );
  }

  // ── Users ─────────────────────────────────────────────────

  async listMembers(): Promise<User[]> {
    const data = await this.request<{ users: User[] }>(
      "GET",
      `/api_v2/users/members.json`
    );
    return data.users;
  }

  async listGuests(): Promise<User[]> {
    const data = await this.request<{ users: User[] }>(
      "GET",
      `/api_v2/users/guests.json`
    );
    return data.users;
  }

  // ── Webhooks ──────────────────────────────────────────────

  async listWebhooks(): Promise<unknown[]> {
    const data = await this.request<{ webhooks: unknown[] }>(
      "GET",
      `/api_v2/webhooks.json`
    );
    return data.webhooks;
  }

  async createWebhook(
    targetUrl: string,
    event: string,
    projectId?: number
  ): Promise<unknown> {
    const body: Record<string, unknown> = { target_url: targetUrl, event };
    if (projectId) body.project_id = projectId;
    const data = await this.request<{ webhook: unknown }>(
      "POST",
      `/api_v2/webhooks.json`,
      body
    );
    return data.webhook;
  }

  async deleteWebhook(webhookId: number): Promise<void> {
    await this.request<void>("DELETE", `/api_v2/webhooks/${webhookId}.json`);
  }
}
