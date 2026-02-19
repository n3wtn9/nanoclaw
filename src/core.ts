/**
 * NanoClaw Core — Shared logic for message processing and agent invocation.
 * Used by both the WhatsApp service (index.ts) and CLI (cli.ts).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  AvailableGroup,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { formatMessages } from './router.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

export interface ChannelCallbacks {
  sendMessage: (jid: string, text: string) => Promise<void>;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
}

export class NanoClawCore {
  lastTimestamp = '';
  sessions: Record<string, string> = {};
  registeredGroups: Record<string, RegisteredGroup> = {};
  lastAgentTimestamp: Record<string, string> = {};
  private messageLoopRunning = false;

  readonly queue = new GroupQueue();
  private channel: ChannelCallbacks;

  constructor(channel: ChannelCallbacks) {
    this.channel = channel;
  }

  loadState(): void {
    this.lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this.registeredGroups = getAllRegisteredGroups();
    logger.info(
      { groupCount: Object.keys(this.registeredGroups).length },
      'State loaded',
    );
  }

  saveState(): void {
    setRouterState('last_timestamp', this.lastTimestamp);
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  registerGroup(jid: string, group: RegisteredGroup): void {
    this.registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);

    const groupDir = path.join(GROUPS_DIR, group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  }

  getAvailableGroups(): AvailableGroup[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(this.registeredGroups));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this.registeredGroups[chatJid];
    if (!group) return true;

    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
    const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

    if (missedMessages.length === 0) return true;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const hasTrigger = missedMessages.some((m) =>
        TRIGGER_PATTERN.test(m.content.trim()),
      );
      if (!hasTrigger) return true;
    }

    const prompt = formatMessages(missedMessages);

    const previousCursor = this.lastAgentTimestamp[chatJid] || '';
    this.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );

    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
        this.queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    };

    await this.channel.setTyping(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;

    const output = await this.runAgent(group, prompt, chatJid, async (result) => {
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          await this.channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    await this.channel.setTyping(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
        return true;
      }
      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
      logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
      return false;
    }

    return true;
  }

  async runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const sessionId = this.sessions[group.folder];

    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this.registeredGroups)),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            this.sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
        },
        (proc, containerName) => this.queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        this.sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    this.messageLoopRunning = true;

    logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

    while (true) {
      try {
        const jids = Object.keys(this.registeredGroups);
        const { messages, newTimestamp } = getNewMessages(jids, this.lastTimestamp, ASSISTANT_NAME);

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          this.lastTimestamp = newTimestamp;
          this.saveState();

          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = this.registeredGroups[chatJid];
            if (!group) continue;

            const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
            const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

            if (needsTrigger) {
              const hasTrigger = groupMessages.some((m) =>
                TRIGGER_PATTERN.test(m.content.trim()),
              );
              if (!hasTrigger) continue;
            }

            const allPending = getMessagesSince(
              chatJid,
              this.lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend);

            if (this.queue.sendMessage(chatJid, formatted)) {
              logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              this.lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              this.saveState();
              this.channel.setTyping(chatJid, true);
            } else {
              this.queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }

  recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this.registeredGroups)) {
      const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        this.queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}

export function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync('docker ps --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans: string[] = [];
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      try {
        const c = JSON.parse(line);
        if (c.Names?.startsWith('nanoclaw-')) {
          orphans.push(c.Names);
        }
      } catch { /* skip non-JSON lines */ }
    }
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
