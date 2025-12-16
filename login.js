require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const readline = require("readline");

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PHONE = process.env.PHONE_NUMBER;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function input(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log("Logging in to Telegram...");

  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => PHONE,
    password: async () => await input("Enter 2FA password (if any): "),
    phoneCode: async () => await input("Enter the code you received: "),
    onError: (err) => console.error(err),
  });

  console.log("\n✅ Logged in successfully!");
  console.log("\n📋 Your new session string (save this to .env as TELEGRAM_SESSION):\n");
  console.log(client.session.save());

  rl.close();
  await client.disconnect();
}

main().catch(console.error);
