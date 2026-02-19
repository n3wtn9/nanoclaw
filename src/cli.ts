#!/usr/bin/env node
/**
 * NanoClaw CLI — Interactive terminal REPL for talking to the agent.
 *
 * Usage:
 *   npm run cli              # New session
 *   npm run cli -- --resume  # Resume a previous session
 *   npm run cli -- --clean   # Delete old CLI sessions
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createInterface } from 'readline/promises';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR } from './config.js';
import { CLIChannel } from './channels/cli.js';
import { NanoClawCore, ensureDockerRunning } from './core.js';
import {
  deleteMessagesForChat,
  deleteRegisteredGroup,
  deleteSession,
  getAllRegisteredGroups,
  getLastMessageForChat,
  initDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { logger } from './logger.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ── Helpers ──────────────────────────────────────────────────────

interface CLISession {
  jid: string;
  folder: string;
  name: string;
  added_at: string;
  lastMessage?: string;
}

function getCLISessions(): CLISession[] {
  const groups = getAllRegisteredGroups();
  const sessions: CLISession[] = [];

  for (const [jid, group] of Object.entries(groups)) {
    if (!jid.endsWith('@local') || !group.folder.startsWith('cli-')) continue;
    const lastMsg = getLastMessageForChat(jid);
    sessions.push({
      jid,
      folder: group.folder,
      name: group.name,
      added_at: group.added_at,
      lastMessage: lastMsg?.content?.slice(0, 60),
    });
  }

  // Sort by date descending (most recent first)
  sessions.sort((a, b) => b.added_at.localeCompare(a.added_at));
  return sessions;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getFolderSize(folderPath: string): string {
  try {
    let total = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(folderPath);
    if (total < 1024) return `${total} B`;
    if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
    return `${(total / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return '?';
  }
}

async function askChoice(question: string, choices: string[]): Promise<number> {
  console.log(`\n${question}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}. ${choices[i]}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nSelect: ');
    const n = parseInt(answer.trim(), 10);
    return n >= 1 && n <= choices.length ? n - 1 : -1;
  } catch {
    return -1;
  } finally {
    rl.close();
  }
}

// ── Commands ─────────────────────────────────────────────────────

async function handleResume(): Promise<void> {
  const sessions = getCLISessions();
  if (sessions.length === 0) {
    console.log('No previous CLI sessions found.');
    process.exit(0);
  }

  const choices = sessions.map((s) => {
    const preview = s.lastMessage || '(empty session)';
    return `${formatDate(s.added_at)} — "${preview}"`;
  });

  const idx = await askChoice('Previous sessions:', choices);
  if (idx < 0) {
    console.log('Invalid selection.');
    process.exit(1);
  }

  startSession(sessions[idx].jid, sessions[idx].folder);
}

async function handleClean(): Promise<void> {
  const sessions = getCLISessions();
  if (sessions.length === 0) {
    console.log('No CLI sessions to clean.');
    process.exit(0);
  }

  const choices = sessions.map((s) => {
    const preview = s.lastMessage || '(empty session)';
    const groupPath = path.join(GROUPS_DIR, s.folder);
    const size = getFolderSize(groupPath);
    return `${formatDate(s.added_at)} — "${preview}" (${size})`;
  });
  choices.push('Delete all');

  const idx = await askChoice('CLI sessions:', choices);
  if (idx < 0) {
    console.log('Invalid selection.');
    process.exit(1);
  }

  const toDelete = idx === sessions.length ? sessions : [sessions[idx]];

  for (const s of toDelete) {
    // Remove group folder
    const groupPath = path.join(GROUPS_DIR, s.folder);
    fs.rmSync(groupPath, { recursive: true, force: true });

    // Remove session data
    const sessionPath = path.join(DATA_DIR, 'sessions', s.folder);
    fs.rmSync(sessionPath, { recursive: true, force: true });

    // Remove DB records
    deleteMessagesForChat(s.jid);
    deleteRegisteredGroup(s.jid);
    deleteSession(s.folder);

    console.log(`  Deleted: ${s.folder}`);
  }

  console.log(`\nCleaned ${toDelete.length} session(s).`);
  process.exit(0);
}

// ── Main session ─────────────────────────────────────────────────

function startSession(jid: string, folder: string): void {
  const cliChannel = new CLIChannel({
    jid,
    onMessage: (_chatJid, msg) => {
      // Chat row must exist before message insert (FK constraint)
      storeChatMetadata(msg.chat_jid, msg.timestamp);
      storeMessageDirect({ ...msg, is_from_me: !!msg.is_from_me });
    },
  });

  const core = new NanoClawCore({
    sendMessage: (j, text) => cliChannel.sendMessage(j, text),
    setTyping: (j, isTyping) => cliChannel.setTyping(j, isTyping),
  });
  core.loadState();

  // Ensure this CLI group is registered
  if (!core.registeredGroups[jid]) {
    core.registerGroup(jid, {
      name: `CLI ${folder}`,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
  }

  core.queue.setProcessMessagesFn((chatJid) => core.processGroupMessages(chatJid));
  core.recoverPendingMessages();

  console.log(`${BOLD}NanoClaw CLI${RESET} — session: ${folder}`);
  console.log(`${DIM}Type a message to talk to the agent. Type "exit" to quit.${RESET}\n`);

  cliChannel.connect();
  core.startMessageLoop();
}

// ── Entry point ──────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();

  const args = process.argv.slice(2);

  if (args.includes('--resume')) {
    return handleResume();
  }

  if (args.includes('--clean')) {
    return handleClean();
  }

  // New session
  const ts = Math.floor(Date.now() / 1000);
  const folder = `cli-${ts}`;
  const jid = `${folder}@local`;

  startSession(jid, folder);
}

main().catch((err) => {
  logger.error({ err }, 'CLI failed');
  process.exit(1);
});
