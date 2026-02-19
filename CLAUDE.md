# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/core.ts` | Shared logic: NanoClawCore class (state, message loop, agent invocation) |
| `src/index.ts` | WhatsApp entry point: wires WhatsApp channel to core |
| `src/cli.ts` | CLI entry point: interactive REPL with session management |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/channels/cli.ts` | CLI channel: readline-based terminal I/O |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run WhatsApp service with hot reload
npm run cli          # Interactive CLI (new session)
npm run cli -- --resume  # Resume a previous CLI session
npm run cli -- --clean   # Clean up old CLI sessions
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

Docker's buildkit caches layers aggressively. To force a truly clean rebuild:

```bash
docker builder prune -af
./container/build.sh
```

Always verify after rebuild: `docker run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## Testing Best Practices

After writing code, do all of these before declaring the task done:

1. **Run `npm run build` and `npm test`.** Type errors and test failures are the minimum bar.
2. **Enumerate every code path you touched, then smoke test each one.** If you added 3 CLI flags, test all 3 — not just the default. If you added an error handler, trigger the error.
3. **Test with real I/O, not just compilation.** `tsc` passing does not mean the code works. Runtime bugs (async misuse, wrong call order, missing DB rows) only surface when you actually run it.
4. **Pipe test input for interactive prompts.** e.g. `echo "1" | npm run cli -- --resume` to verify prompts accept input. If it exits without waiting, the async handling is broken.
5. **Verify side effects.** If your code writes to SQLite, check the rows exist. If it creates files, check they're there. If it sends output, check the format.
6. **Test the edges, not just the center.** Empty state (no sessions to resume), invalid input (non-numeric selection), and error paths (missing files, FK violations) are where bugs hide.

## Gotchas

- `ASSISTANT_NAME` is set in `.env`, falls back to `Andy` in `src/config.ts`. If the name looks wrong, check `.env`.
- Credentials are passed to containers via stdin JSON, never mounted as files. `data/env/env` does not exist.
- After any code change, check all docs listed in `.claude/skills/customize/SKILL.md` under "Update Documentation (REQUIRED)" for drift.
