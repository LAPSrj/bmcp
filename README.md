# BugHerd MCP Server & CLI

An MCP (Model Context Protocol) server **and standalone CLI** for managing [BugHerd](https://bugherd.com) bug tracking tasks. Lets AI assistants — or you, from the terminal — list, create, update, and comment on BugHerd tickets directly.

## Features

- **Tasks** — list, view, create, update, and move tasks between columns
- **Comments** — list and add comments (public or private)
- **Attachments** — list, download, add (from URL), and delete
- **Columns** — list all project columns/statuses
- **Members & Guests** — list team members and clients
- **Column label shortcuts** — configure aliases for "pending", "in progress", and "done" columns

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- A BugHerd account with an API key (Settings > General)
- The numeric ID of the BugHerd project you want to manage

### Install & Build

```bash
bun install
bun run build
```

This produces two binaries in `dist/`:
- `bugherd-mcp` — MCP server (stdio transport)
- `bugherd` — standalone CLI

### MCP Configuration

The server resolves the API key from the first source that has it:

1. `BUGHERD_API_KEY` environment variable
2. `BUGHERD_API_KEY_FILE` environment variable (path to a file holding the key)
3. Default credential file `~/.config/bugherd-mcp/api-key` (mode `0600`)

The project ID resolves the same way: `BUGHERD_PROJECT_ID` env,
`BUGHERD_PROJECT_ID_FILE`, then `~/.config/bugherd-mcp/project-id`.

**Option A — inline in your MCP client config** (e.g. `claude_desktop_config.json`
or `.mcp.json`):

```json
{
  "mcpServers": {
    "bugherd": {
      "command": "bun",
      "args": ["/path/to/bugherd-mcp/dist/index.js"],
      "env": {
        "BUGHERD_API_KEY": "your-api-key-here",
        "BUGHERD_PROJECT_ID": "12345",
        "BUGHERD_COLUMN_PENDING": "Backlog",
        "BUGHERD_COLUMN_IN_PROGRESS": "In Progress",
        "BUGHERD_COLUMN_DONE": "Done"
      }
    }
  }
}
```

Or copy `.env.example` to `.env` and fill in the same variables.

**Option B — credential file** (recommended when the key and project are shared
across projects, or to keep secrets out of your MCP config). Write them once and
keep each project's `.mcp.json` a bare launch block with no `env`:

```bash
mkdir -p -m 700 ~/.config/bugherd-mcp
printf %s 'your-api-key-here' > ~/.config/bugherd-mcp/api-key
printf %s '12345'             > ~/.config/bugherd-mcp/project-id
chmod 600 ~/.config/bugherd-mcp/api-key ~/.config/bugherd-mcp/project-id
```

```json
{
  "mcpServers": {
    "bugherd": {
      "command": "bun",
      "args": ["/path/to/bugherd-mcp/dist/index.js"]
    }
  }
}
```

The server reads the files itself regardless of how it's launched, so no secret
(and no `${VAR}` reference) ever needs to live in a per-project config.

#### Environment variables

| Variable | Required | Description |
|---|---|---|
| `BUGHERD_API_KEY` | ✅¹ | Your BugHerd API key (found in Settings > General) |
| `BUGHERD_API_KEY_FILE` | – | Path to a file holding the key; overrides the default `~/.config/bugherd-mcp/api-key` |
| `BUGHERD_PROJECT_ID` | ✅¹ | The numeric ID of your BugHerd project |
| `BUGHERD_PROJECT_ID_FILE` | – | Path to a file holding the project ID; overrides the default `~/.config/bugherd-mcp/project-id` |
| `BUGHERD_COLUMN_PENDING` | – | Column name to map to the "pending" shorthand |
| `BUGHERD_COLUMN_IN_PROGRESS` | – | Column name to map to the "in_progress" shorthand |
| `BUGHERD_COLUMN_DONE` | – | Column name to map to the "done_label" shorthand |
| `BUGHERD_MAX_CONCURRENT_REQUESTS` | – | Max concurrent requests |
| `BUGHERD_MAX_RETRY_DELAY_MS` | – | Max ms to wait on a 429 retry before giving up |
| `BUGHERD_MAX_RETRIES` | – | Max retries on 429 |

¹ Required only if no credential file is present — the server needs each value
from **one** of its three sources above.

## Available Tools

| Tool | Description |
|---|---|
| `get_project` | Get project details, members, guests, and columns |
| `list_columns` | List all columns/statuses in the project |
| `list_tasks` | List tasks with filters (status, priority, tag, assignee, etc.) |
| `get_task` | Get a single task by global ID or local #number |
| `create_task` | Create a new task/bug |
| `update_task` | Update task fields (description, priority, tags, assignee, etc.) |
| `move_task` | Move a task to a different column/status |
| `add_comment` | Add a comment to a task |
| `list_comments` | List all comments on a task |
| `list_attachments` | List attachments on a task |
| `get_attachment` | Download an attachment, or the task's annotated screenshot, to a file |
| `add_attachment` | Add an attachment from a URL |
| `delete_attachment` | Delete an attachment |
| `list_members` | List organization team members |
| `list_guests` | List organization guests/clients |

### Downloading attachments

`get_attachment` takes a `task_id` plus one selector:

- `attachment_id` or `file_name` — an attachment from the task. Both `get_task`
  and `list_attachments` print the name and ID, so either can be passed straight
  back in.
- `screenshot: true` — the screenshot BugHerd captures when the bug is reported.
  This is **not** an attachment and does not appear in `list_attachments`; it
  hangs off the task itself.

The file is **always written to disk** and the path returned — contents are never
returned inline, regardless of size or type. `save_to` sets the destination;
without it the file lands in a temp directory. An existing file is never
overwritten. To view a downloaded image, read the returned path.

```
"Download the attachment on task #40 and show me what's wrong"
"Save the screenshot from task #40 to ~/Desktop/bug.jpg"
```

## CLI Usage

The same operations are available from the terminal via the `bugherd` command.
It uses the same credential resolution as the MCP server (env vars or
`~/.config/bugherd-mcp/` files).

```bash
bugherd <command> [args] [flags]
```

Task IDs accept global numeric IDs or `#N` for local task numbers.

| Command | Description |
|---|---|
| `bugherd project` | Show project details |
| `bugherd columns` | List columns/statuses |
| `bugherd tasks [--status=X] [--priority=X] [--tag=X] [--page=N]` | List tasks |
| `bugherd task <id>` | Show a single task (`#42` or `12345`) |
| `bugherd create <description> [--priority=X] [--status=X] [--tags=a,b]` | Create a task |
| `bugherd update <id> [--description=X] [--priority=X] [--tags=a,b]` | Update a task |
| `bugherd move <id> <column>` | Move a task to a column |
| `bugherd comments <id>` | List comments on a task |
| `bugherd comment <id> <text> [--private] [--email=X]` | Add a comment |
| `bugherd attachments <id>` | List attachments on a task |
| `bugherd download <id> [--attachment-id=N \| --file-name=X \| --screenshot]` | Download an attachment or screenshot |
| `bugherd attach <id> <file-name> <url>` | Add an attachment |
| `bugherd detach <id> <attachment-id>` | Delete an attachment |
| `bugherd members` | List team members |
| `bugherd guests` | List guests/clients |

### Examples

```bash
bugherd tasks --status=pending --priority=critical
bugherd task "#42"
bugherd create "Login button broken on mobile Safari" --priority=important --tags=mobile,auth
bugherd move "#42" "In Progress"
bugherd comment "#42" "Fixed in commit abc123" --private
bugherd download "#40" --screenshot --save-to=~/Desktop/bug.jpg
```

## MCP Example Usage

Once configured, you can ask your AI assistant things like:

- "Show me all critical bugs"
- "What tasks are assigned to me?"
- "Create a bug: the login button doesn't work on mobile Safari"
- "Move task #42 to In Progress"
- "Add a comment to task #15: Fixed in commit abc123"
- "What are the columns in this project?"
- "Download the screenshot on task #40 — what's wrong with those cards?"

## API Reference

This server wraps the [BugHerd API v2](https://docs.bugherd.com/api). Authentication uses HTTP Basic with your API key.

A few behaviours of the upstream API that this server papers over, noted here
because they are not in BugHerd's docs and were confirmed against the live API:

- **Attachment and screenshot URLs are unsigned and public.** They point at
  `files.bugherd.com/<token>/<name>`, need no `Authorization` header, and are
  readable by anyone holding the URL. The server sends no credentials when
  fetching them and refuses to download from any other host.
- **An attachment's name has two spellings.** Inline on a task the field is
  `name`; on `/attachments.json` it is `file_name`. `BugherdClient` normalizes
  both to `file_name`, so nothing outside the client sees `name`.
- **`?status=` filters the lifecycle state, not the column** — see the
  `list_tasks` tool description for the full caveat.
