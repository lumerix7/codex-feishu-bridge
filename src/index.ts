import { loadConfig } from "./config/env.js";
import { App } from "./core/app.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new App(config);

  if (process.argv.includes("--demo")) {
    const response = await app.handleIncoming({
      messageId: "demo-1",
      chatId: "demo-chat",
      chatType: "p2p",
      text: "/status"
    });
    console.log(response);
    process.exit(0);
    return;
  }

  if (process.argv.includes("--cli")) {
    await runCli(app);
    process.exit(0);
    return;
  }

  await app.start();
}

async function runCli(app: App): Promise<void> {
  const chatId = readArg("--chat-id") || "local-cli";
  const rl = readline.createInterface({ input, output });
  let messageSeq = 0;

  console.log(`cli mode chatId=${chatId}`);
  console.log(
    "type /help, /status [check-update], /thread, /new [-C <dir>], /resume <session-id>, /session list [--project <path>], /stop, /project, /project list, /project bind <path>, /project unbind <path>, /approvals [...], /feishu [ws|send|doctor], /log [-n N] [--since <expr>] [--grep <text>], or plain prompts"
  );
  console.log("type /exit to quit");

  try {
    while (true) {
      const answer = await rl.question("> ").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ERR_USE_AFTER_CLOSE") {
          return "/exit";
        }
        throw error;
      });
      const text = answer.trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;

      messageSeq += 1;
      let lastUpdateText: string | undefined;
      const response = await app.handleIncoming({
        messageId: `cli-${messageSeq}`,
        chatId,
        chatType: "p2p",
        text
      }, async (update) => {
        lastUpdateText = update;
        console.log(`\n${update}\n`);
      });
      if (response && response !== lastUpdateText) {
        console.log(`\n${response}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
