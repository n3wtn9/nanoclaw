import { WhatsAppChannel } from './channels/whatsapp.js';
import { writeGroupsSnapshot } from './container-runner.js';
import { initDatabase, storeChatMetadata, storeMessage } from './db.js';
import { startIpcWatcher } from './ipc.js';
import { formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NanoClawCore, ensureDockerRunning } from './core.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let whatsapp: WhatsAppChannel;

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');

  // Create core with WhatsApp-specific callbacks
  const core = new NanoClawCore({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    setTyping: (jid, isTyping) => whatsapp.setTyping(jid, isTyping),
  });
  core.loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await core.queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create WhatsApp channel
  whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => core.registeredGroups,
  });

  // Connect — resolves when first connected
  await whatsapp.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => core.registeredGroups,
    getSessions: () => core.sessions,
    queue: core.queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => core.queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    registeredGroups: () => core.registeredGroups,
    registerGroup: (jid, group) => core.registerGroup(jid, group),
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups: () => core.getAvailableGroups(),
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  core.queue.setProcessMessagesFn((chatJid) => core.processGroupMessages(chatJid));
  core.recoverPendingMessages();
  core.startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
