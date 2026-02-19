import readline from 'readline';

import { ASSISTANT_NAME } from '../config.js';
import { stripInternalTags } from '../router.js';
import { Channel, NewMessage } from '../types.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_LINE = '\x1b[2K\r';

export interface CLIChannelOpts {
  jid: string;
  onMessage: (chatJid: string, msg: NewMessage) => void;
}

export class CLIChannel implements Channel {
  name = 'cli';

  private jid: string;
  private opts: CLIChannelOpts;
  private rl!: readline.Interface;
  private connected = false;
  private typingActive = false;

  constructor(opts: CLIChannelOpts) {
    this.jid = opts.jid;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${DIM}>${RESET} `,
    });

    this.connected = true;

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        this.rl.prompt();
        return;
      }

      if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
        this.disconnect();
        return;
      }

      const msg: NewMessage = {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: this.jid,
        sender: 'user',
        sender_name: 'You',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: false,
      };

      this.opts.onMessage(this.jid, msg);
    });

    this.rl.on('close', () => {
      this.connected = false;
    });

    this.rl.prompt();
  }

  async sendMessage(_jid: string, rawText: string): Promise<void> {
    const text = stripInternalTags(rawText);
    if (!text) return;

    // Clear typing indicator if active
    if (this.typingActive) {
      process.stdout.write(CLEAR_LINE);
      this.typingActive = false;
    }

    console.log(`${BOLD}${ASSISTANT_NAME}${RESET}: ${text}\n`);
    this.rl.prompt();
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    if (isTyping && !this.typingActive) {
      process.stdout.write(`${DIM}thinking...${RESET}`);
      this.typingActive = true;
    } else if (!isTyping && this.typingActive) {
      process.stdout.write(CLEAR_LINE);
      this.typingActive = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === this.jid;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.typingActive) {
      process.stdout.write(CLEAR_LINE);
    }
    this.rl?.close();
    console.log(`\n${DIM}Session ended.${RESET}`);
    process.exit(0);
  }
}
