---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** - Ask clarifying questions
2. **Plan the changes** - Identify files to modify
3. **Implement** - Make changes directly to the code
4. **Update documentation** - Update all docs that reference changed behavior (see below)
5. **Test guidance** - Tell user how to verify

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
| `src/types.ts` | TypeScript interfaces (includes Channel) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | Database initialization and queries |
| `src/whatsapp-auth.ts` | Standalone WhatsApp authentication script |
| `groups/CLAUDE.md` | Global memory/persona |

## Common Customization Patterns

### Adding a New Input Channel (e.g., Telegram, Slack, Email)

Questions to ask:
- Which channel? (Telegram, Slack, Discord, email, SMS, etc.)
- Same trigger word or different?
- Same memory hierarchy or separate?
- Should messages from this channel go to existing groups or new ones?

Implementation pattern:
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/types.ts` (see `src/channels/whatsapp.ts` or `src/channels/cli.ts` for reference)
2. Create an entry point (e.g., `src/{name}.ts`) that creates a `NanoClawCore` from `src/core.ts` and wires the channel callbacks
3. Messages are stored via `storeMessageDirect()` from `src/db.ts`; routing is automatic through the core's message loop

### Adding a New MCP Integration

Questions to ask:
- What service? (Calendar, Notion, database, etc.)
- What operations needed? (read, write, both)
- Which groups should have access?

Implementation:
1. Add MCP server config to the container settings (see `src/container-runner.ts` for how MCP servers are mounted)
2. Document available tools in `groups/CLAUDE.md`

### Changing Assistant Behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all groups or specific ones?

Simple changes → edit `src/config.ts`
Persona changes → edit `groups/CLAUDE.md`
Per-group behavior → edit specific group's `CLAUDE.md`

### Adding New Commands

Questions to ask:
- What should the command do?
- Available in all groups or main only?
- Does it need new MCP tools?

Implementation:
1. Commands are handled by the agent naturally — add instructions to `groups/CLAUDE.md` or the group's `CLAUDE.md`
2. For trigger-level routing changes, modify `processGroupMessages()` in `src/core.ts`

### Changing Deployment

Questions to ask:
- Target platform? (Linux server, Docker, different Mac)
- Service manager? (systemd, Docker, supervisord)

Implementation:
1. Create appropriate service files
2. Update paths in config
3. Provide setup instructions

## Update Documentation (REQUIRED)

After every change, update all documentation that references the modified behavior. Documentation drift makes the codebase untrustworthy for both humans and AI. Check each of these files and update any that are now out of date:

| File | What to check |
|------|---------------|
| `CLAUDE.md` | Key Files table, Development commands, Quick Context description |
| `README.md` | "What It Supports" list, Architecture diagram and key files, FAQ |
| `README_zh.md` | Chinese translation — mirror all changes from README.md |
| `docs/SPEC.md` | Architecture diagram, Folder Structure tree, Technology Stack table, Startup Sequence, Message Flow, Session Management, any section describing behavior you changed |
| `docs/REQUIREMENTS.md` | Architecture Decisions, Integration Points, Vision |
| `docs/SECURITY.md` | Trust model, security boundaries, credential handling, architecture diagram |
| `.claude/skills/customize/SKILL.md` | Key Files table (this file — keep it current) |
| `.claude/skills/debug/SKILL.md` | Architecture Overview, if container or mount behavior changed |
| `.claude/skills/setup/SKILL.md` | If setup steps, dependencies, or service config changed |

**Rule of thumb:** If you added a new file, it should appear in every "key files" list. If you added a new feature, it should appear in every "what it supports" list. If you changed how something works, every description of that thing must be updated. Read each doc and ask: "Does this still accurately describe the system?"

## After Changes

Always tell the user:
```bash
# Rebuild and restart
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Example Interaction

User: "Add Telegram as an input channel"

1. Ask: "Should Telegram use the same @Andy trigger, or a different one?"
2. Ask: "Should Telegram messages create separate conversation contexts, or share with WhatsApp groups?"
3. Create `src/channels/telegram.ts` implementing the `Channel` interface (see `src/channels/whatsapp.ts` or `src/channels/cli.ts`)
4. Create an entry point or add to an existing one, wiring the channel to `NanoClawCore` from `src/core.ts`
5. Tell user how to authenticate and test
