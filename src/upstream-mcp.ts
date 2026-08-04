import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CompatibilityCallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Paths ──────────────────────────────────────────────────────

export const CONFIG_DIR = path.join(os.homedir(), ".config", "bugherd-mcp");
export const UPSTREAM_CONFIG_FILE = path.join(CONFIG_DIR, "upstream.json");

const OAUTH_DIR = path.join(CONFIG_DIR, "oauth");
const TOKENS_FILE = path.join(OAUTH_DIR, "tokens.json");
const CLIENT_INFO_FILE = path.join(OAUTH_DIR, "client-info.json");
const CODE_VERIFIER_FILE = path.join(OAUTH_DIR, "code-verifier");
const DISCOVERY_FILE = path.join(OAUTH_DIR, "discovery.json");

export const BUGHERD_MCP_URL = "https://mcp.bugherd.com/mcp";

// ── Config ─────────────────────────────────────────────────────

export interface UpstreamHttpConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface UpstreamStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type UpstreamConfig = UpstreamHttpConfig | UpstreamStdioConfig;

function configFilePath(): string {
  return process.env.BUGHERD_UPSTREAM_MCP_CONFIG || UPSTREAM_CONFIG_FILE;
}

function loadUpstreamConfig(): UpstreamConfig | null {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw) as UpstreamConfig;
  } catch {
    return null;
  }
}

function configMtime(): number {
  try {
    return fs.statSync(configFilePath()).mtimeMs;
  } catch {
    return 0;
  }
}

// ── File-backed OAuth provider ─────────────────────────────────

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  try { fs.chmodSync(file, 0o600); } catch { /* WSL compat */ }
}

export class FileBackedOAuthProvider implements OAuthClientProvider {
  private redirectPort: number;
  private onRedirect?: (url: URL) => void;

  constructor(opts?: { redirectPort?: number; onRedirect?: (url: URL) => void }) {
    this.redirectPort = opts?.redirectPort ?? 0;
    this.onRedirect = opts?.onRedirect;
  }

  get redirectUrl(): string | URL {
    return `http://127.0.0.1:${this.redirectPort}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [`http://127.0.0.1:${this.redirectPort}`],
      client_name: "bugherd-mcp-proxy",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readJson<OAuthClientInformationMixed>(CLIENT_INFO_FILE);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    writeJson(CLIENT_INFO_FILE, info);
  }

  tokens(): OAuthTokens | undefined {
    return readJson<OAuthTokens>(TOKENS_FILE);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    writeJson(TOKENS_FILE, tokens);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.onRedirect) {
      this.onRedirect(url);
    }
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    ensureDir(path.dirname(CODE_VERIFIER_FILE));
    fs.writeFileSync(CODE_VERIFIER_FILE, verifier, "utf8");
    try { fs.chmodSync(CODE_VERIFIER_FILE, 0o600); } catch { /* WSL compat */ }
  }

  codeVerifier(): string {
    try {
      return fs.readFileSync(CODE_VERIFIER_FILE, "utf8").trim();
    } catch {
      throw new Error("No code verifier saved. Run `bugherd-mcp-auth login` first.");
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    writeJson(DISCOVERY_FILE, state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readJson<OAuthDiscoveryState>(DISCOVERY_FILE);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const targets: Record<string, string> = {
      tokens: TOKENS_FILE,
      client: CLIENT_INFO_FILE,
      verifier: CODE_VERIFIER_FILE,
      discovery: DISCOVERY_FILE,
    };
    if (scope === "all") {
      for (const f of Object.values(targets)) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    } else if (targets[scope]) {
      try { fs.unlinkSync(targets[scope]!); } catch { /* ignore */ }
    }
  }
}

// ── No-op JSON schema validator ────────────────────────────────
// BugHerd's MCP declares an outputSchema for get_task_details that
// requires `user` to be an object, but the API returns `null` for
// agent-posted comments. Skip client-side output validation entirely.

const permissiveValidator: jsonSchemaValidator = {
  getValidator: (() => (input: unknown) =>
    ({ valid: true, data: input, errorMessage: undefined })
  ) as jsonSchemaValidator["getValidator"],
};

// ── Comment extraction from get_task_details response ──────────

interface UpstreamComment {
  id?: number;
  comment?: string;
  text?: string;
  created_at?: string;
  is_private?: boolean;
  user?: { id?: number; email?: string; display_name?: string } | null;
}

function extractComments(rawText: string): string | null {
  try {
    const data = JSON.parse(rawText);
    const comments: UpstreamComment[] = data.comments ?? data;
    if (!Array.isArray(comments) || !comments.length) return null;

    return comments.map((c) => {
      const who = c.user?.display_name ?? c.user?.email ?? `user ${c.user?.id ?? "unknown"}`;
      const priv = c.is_private ? ", private" : "";
      const body = c.comment ?? c.text ?? "";
      return `[${c.created_at ?? ""}] (${who}${priv}): ${body}`;
    }).join("\n");
  } catch {
    return rawText;
  }
}

// ── Token-file mtime watcher (hot-reload after external login) ─

function tokensMtime(): number {
  try {
    return fs.statSync(TOKENS_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

// ── Proxy ──────────────────────────────────────────────────────

type ToolEntry = { name: string; description?: string };

export class UpstreamMcp {
  private config: UpstreamConfig | null;
  private configLoadedMtime: number;
  private tokensLoadedMtime = 0;
  private client: Client | null = null;
  private connected = false;
  private connectAttempted = false;
  private availableTools: ToolEntry[] = [];
  private commentToolName: string | null = null;
  private taskDetailToolName: string | null = null;
  private lastAuthError = false;

  constructor() {
    this.config = loadUpstreamConfig();
    this.configLoadedMtime = configMtime();
  }

  get configured(): boolean {
    return this.config !== null || this.hasOAuthTokens();
  }

  private hasOAuthTokens(): boolean {
    const tokens = readJson<OAuthTokens>(TOKENS_FILE);
    return !!(tokens?.access_token || tokens?.refresh_token);
  }

  private async maybeReloadConfig(): Promise<void> {
    const currentMtime = configMtime();
    if (currentMtime > this.configLoadedMtime) {
      this.configLoadedMtime = currentMtime;
      const newConfig = loadUpstreamConfig();
      if (JSON.stringify(newConfig) !== JSON.stringify(this.config)) {
        await this.close();
        this.config = newConfig;
        this.connectAttempted = false;
      }
    }

    // Also check if OAuth tokens appeared/changed on disk (external login).
    const currentTokensMtime = tokensMtime();
    if (currentTokensMtime > this.tokensLoadedMtime && !this.config) {
      this.tokensLoadedMtime = currentTokensMtime;
      if (this.lastAuthError || !this.connected) {
        await this.close();
        this.connectAttempted = false;
        this.lastAuthError = false;
      }
    }
  }

  private async connect(): Promise<Client | null> {
    await this.maybeReloadConfig();

    if (this.connected) return this.client;
    if (this.connectAttempted) return null;
    this.connectAttempted = true;

    try {
      const client = new Client(
        { name: "bugherd-mcp-proxy", version: "1.0.0" },
        { jsonSchemaValidator: permissiveValidator },
      );

      let transport;

      if (this.config) {
        if (this.config.transport === "http") {
          const requestInit: RequestInit = {};
          if (this.config.headers) {
            requestInit.headers = this.config.headers;
          }
          transport = new StreamableHTTPClientTransport(
            new URL(this.config.url),
            { requestInit },
          );
        } else {
          transport = new StdioClientTransport({
            command: this.config.command,
            args: this.config.args,
            env: this.config.env
              ? { ...process.env, ...this.config.env } as Record<string, string>
              : undefined,
          });
        }
      } else {
        // Default: BugHerd's official MCP with OAuth
        const authProvider = new FileBackedOAuthProvider();
        if (!authProvider.tokens()) return null;

        transport = new StreamableHTTPClientTransport(
          new URL(BUGHERD_MCP_URL),
          { authProvider },
        );
        this.tokensLoadedMtime = tokensMtime();
      }

      await client.connect(transport);
      this.client = client;
      this.connected = true;

      const { tools } = await client.listTools();
      this.availableTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
      }));

      this.commentToolName = this.findTool(
        "list_comments", "get_comments", "list_task_comments",
      );
      this.taskDetailToolName = this.findTool(
        "get_task_details", "get_task", "show_task",
      );

      return client;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.lastAuthError = true;
      }
      this.client = null;
      this.connected = false;
      return null;
    }
  }

  private findTool(...candidates: string[]): string | null {
    for (const name of candidates) {
      if (this.availableTools.some((t) => t.name === name)) return name;
    }
    return null;
  }

  /**
   * Fetch comments for a task via the upstream BugHerd MCP.
   * `localTaskId` is the project-scoped task number (the # number).
   */
  async getComments(
    localTaskId: number,
    projectId: string,
  ): Promise<{ text: string; source: "upstream" } | null> {
    const client = await this.connect();
    if (!client) return null;

    try {
      let result;

      const toolArgs = { task_id: String(localTaskId), project_id: projectId };

      if (this.commentToolName) {
        result = await client.callTool(
          { name: this.commentToolName, arguments: toolArgs },
          CompatibilityCallToolResultSchema,
        );
      } else if (this.taskDetailToolName) {
        result = await client.callTool(
          { name: this.taskDetailToolName, arguments: toolArgs },
          CompatibilityCallToolResultSchema,
        );
      } else {
        return null;
      }

      if (!result || result.isError) return null;

      const rawText = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      if (!rawText) return null;

      const text = extractComments(rawText);
      return text ? { text, source: "upstream" } : null;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.lastAuthError = true;
      }
      this.handleDisconnect();
      return null;
    }
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.connectAttempted = false;
    this.client = null;
  }

  async close(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* best effort */ }
      this.client = null;
      this.connected = false;
    }
  }
}
