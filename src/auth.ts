#!/usr/bin/env node

import http from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  FileBackedOAuthProvider,
  BUGHERD_MCP_URL,
  CONFIG_DIR,
} from "./upstream-mcp.js";

function usage(): never {
  console.error(`bugherd-mcp-auth — manage BugHerd MCP OAuth state

Usage:
  bugherd-mcp-auth login     Interactive browser sign-in (one-time)
  bugherd-mcp-auth status    Check if signed in and token is valid
  bugherd-mcp-auth logout    Clear local token cache

The OAuth tokens are stored under ${CONFIG_DIR}/oauth/.
The running bugherd-mcp server hot-reloads tokens from disk —
no restart needed after login.
`);
  process.exit(2);
}

function openBrowser(url: string): void {
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === "darwin") {
    cmd = "open";
    args = [url];
  } else if (p === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "sh";
    args = [
      "-c",
      `xdg-open '${url}' >/dev/null 2>&1 || wslview '${url}' >/dev/null 2>&1 || powershell.exe -NoProfile -Command "Start-Process '${url}'" >/dev/null 2>&1`,
    ];
  }
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function login(): Promise<void> {
  // Start a loopback server to receive the OAuth callback.
  const { port, waitForCode, close } = await startLoopback();

  const provider = new FileBackedOAuthProvider({
    redirectPort: port,
    onRedirect: (url) => {
      console.error(`Opening browser for BugHerd sign-in...`);
      console.error(`If nothing happens, visit:\n  ${url.toString()}`);
      openBrowser(url.toString());
    },
  });

  try {
    // Start the OAuth flow — this calls redirectToAuthorization, which opens
    // the browser and returns 'REDIRECT'.
    const result = await auth(provider, { serverUrl: BUGHERD_MCP_URL });

    if (result === "AUTHORIZED") {
      console.log("Already authorized — tokens are valid.");
      close();
      return;
    }

    // Wait for the browser callback with the authorization code.
    console.error("Waiting for browser authorization...");
    const code = await waitForCode();
    close();

    // Exchange the code for tokens.
    await auth(provider, {
      serverUrl: BUGHERD_MCP_URL,
      authorizationCode: code,
    });

    console.log("Signed in to BugHerd MCP.");
    console.log(`Tokens saved to: ${CONFIG_DIR}/oauth/tokens.json`);

    // Verify by connecting.
    await verify();
  } catch (err) {
    close();
    throw err;
  }
}

async function verify(): Promise<boolean> {
  const provider = new FileBackedOAuthProvider();
  const tokens = provider.tokens();
  if (!tokens?.access_token && !tokens?.refresh_token) {
    console.log("Not signed in. Run `bugherd-mcp-auth login`.");
    return false;
  }

  try {
    const client = new Client(
      { name: "bugherd-mcp-auth-probe", version: "1.0.0" },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(BUGHERD_MCP_URL),
      { authProvider: provider },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`Connected to BugHerd MCP — ${tools.length} tools available.`);
    await client.close();
    return true;
  } catch (err) {
    console.error(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function status(): Promise<void> {
  const ok = await verify();
  process.exit(ok ? 0 : 1);
}

async function logout(): Promise<void> {
  const provider = new FileBackedOAuthProvider();
  await provider.invalidateCredentials("all");
  console.log("Local token cache cleared.");
}

// ── Loopback redirect server ───────────────────────────────────

function startLoopback(): Promise<{
  port: number;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;
    let codeResolve: ((code: string) => void) | null = null;
    let codeReject: ((err: Error) => void) | null = null;

    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = u.searchParams.get("code");
      const error = u.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Sign-in failed", escapeHtml(error)));
        codeReject?.(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Missing authorization code", ""));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Signed in", "You can close this tab and return to the terminal."));
      codeResolve?.(code);
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      settled = true;
      resolve({
        port: addr.port,
        waitForCode: () => codePromise,
        close: () => { try { server.close(); } catch { /* ignore */ } },
      });
    });
  });
}

function page(title: string, body: string): string {
  return `<html><body style="font-family:system-ui;text-align:center;padding:4em"><h2>${title}</h2><p>${body}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") usage();

  switch (cmd) {
    case "login":
      await login();
      break;
    case "status":
      await status();
      break;
    case "logout":
      await logout();
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
