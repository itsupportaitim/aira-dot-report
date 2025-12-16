require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION = new StringSession(process.env.TELEGRAM_SESSION);

// Express app for health check
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.status(200).json({
    service: "Telegram Inspection Reporter",
    status: "running",
    nextRun: "Monday 8pm Bishkek time (UTC+6)"
  });
});

const SOURCE_CHAT = -1001988053976;
const SOURCE_TOPIC = 3;
const OUTPUT_CHAT = 7229426065;

// Company list for matching
const COMPANIES = [
  "7 LUV Transporting inc", "AAJ COM LLC", "Acarsan Inc", "AJ PARTNERS LLC", "AJS Express LLC",
  "ALL STATE INC", "ALLIANSAS INC", "ALMA CARRIERS CORP", "Amana cargo", "AMG LINE LLC",
  "AMPM TRANSPORT INC", "ASIL FREIGHT LLC", "BALDAN TRANSPORT INC", "BARRE LOGISTICS LLC",
  "CASPIAN EXPRESS INC", "Chuiko Logistics Corporation", "CME TRUCKING LLC", "COLD AIRFLOW LLC",
  "Craiden Logistics Inc", "DAMY TRANSPORTATION LLC", "DLD LOGISTICS LLC", "Dos cargo inc",
  "Draw Express inc", "DRAWX INC", "E & R FREIGHT TRUCKING LLC", "EMPOWER LOGISTIC INC",
  "ERI TRUCKING LLC", "EURO POWER LLC", "FLYING HORSE EXPRESS LLC", "FORTUNE TRANSPORTATION INC",
  "Four Ways Logistics II Inc", "FREIGHT BRIDGE LLC", "Freight Stream Group LLC",
  "FROM POINT TO POINT INC", "GMR XPRESS INCORPORATED", "GREENWAY TRANSPORT LLC",
  "Heyla Transport LLC", "Instant Trucking INC", "J&A PRESTIGE TRANSPORT SERVICES LLC",
  "J&P LOGISTICS USA INC.", "Javohir TRUCKING LLC", "JAY TORRES LLC", "JB RUNNER LLC",
  "JMI TRANSPORT LLC", "JUZZ FREIGHT INC", "KEL LOGISTICS INC", "KEL TRANS INC",
  "KG 996 INC", "KG LINE GROUP INCORPORATED", "KINGS GATE INC", "Kuumade Trucking LLC",
  "Losev Trucking LLC", "Lyndon Express LLC", "MAA USA EXPRESS", "MAKGA INC", "MAKOVSKI INC",
  "MARRX LLC", "MGAL Corp", "MOVE OPS", "MZX INC", "NAIMAN EXPRESS", "NEMO EXPRESS INC",
  "NK PERFORMANCE INC", "OWNERLER EXPRESS INC", "PREMIUM AMERICAN PARTNER INC",
  "RAYNE 2 LOGISTICS INC", "RLJ TRUCKING INC", "SAKARA LLC", "SANLUIS EXPRESS LLC",
  "SCOTT CARTAGE CO INC", "Shiba Trucking LLC", "STEEL EXPRESS INC", "Sterling Express Inc",
  "TAVICO LLC", "TRANSNATIONAL EXPERTS INC", "Truckzilla INC", "TUTASH EXPRESS INC",
  "UK Express INC", "United Freight Service Inc", "US LOAD RUN INC", "USA TRUCKLINK LLC",
  "USTA LOGISTICS INC", "UZB TRANS INC", "VILA TRUCKING INC", "YES WE CAN TRANSPORTATION LLC",
  "ZR Trans LLC"
];

// Create flexible patterns - extract core name without suffixes
const companyPatterns = COMPANIES.map(c => {
  // Remove common suffixes for matching
  const core = c.toUpperCase()
    .replace(/\s+(INC|LLC|CORP|INCORPORATED|CORPORATION)\.?$/i, "")
    .replace(/[^A-Z0-9]/g, "");
  return { name: c, pattern: core };
});

// Add common abbreviations/aliases
const ALIASES = {
  "KELLOG": "KEL LOGISTICS INC",
  "UNITEDFREIGHT": "United Freight Service Inc",
  "GMRXPRESS": "GMR XPRESS INCORPORATED",
  "JAVOHIR": "Javohir TRUCKING LLC",
};

function extractCategory(text) {
  const match = text.match(/^#(\w+)/i);
  if (match) {
    const tag = match[1].toLowerCase();
    if (tag === "clean") return "Clean";
    if (tag === "hos") return "HOS";
    if (tag.includes("violation")) return "Violation";
    if (tag === "citation") return "Citation";
    if (tag === "warning") return "Warning";
    if (tag === "ticket") return "Ticket";
    return tag.charAt(0).toUpperCase() + tag.slice(1);
  }
  return "Unknown";
}

function extractCompany(text) {
  const textNorm = text.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Check aliases first
  for (const [alias, company] of Object.entries(ALIASES)) {
    if (textNorm.includes(alias)) return company;
  }

  // Check full patterns
  for (const { name, pattern } of companyPatterns) {
    if (textNorm.includes(pattern)) return name;
  }
  return "Unknown";
}

function extractTransferState(text) {
  // Handle common typos: trasnferred, transfered, transffered, etc.
  const transferPattern = /tra[ns]{0,2}f+er+ed/i;
  if (/\b(not|no)\s+/.test(text) && transferPattern.test(text)) return "Not Transferred";
  if (transferPattern.test(text)) return "Transferred";
  return "Unknown";
}

function extractUnitType(text) {
  const units = [];
  const matches = text.matchAll(/unit[\s-]*([DC12])/gi);
  for (const m of matches) {
    const u = m[1].toUpperCase();
    if (!units.includes(u)) units.push(u);
  }
  return units.length > 0 ? units.sort().join(", ") : "";
}

async function runReport() {
  console.log(`[${new Date().toISOString()}] Starting report generation...`);
  console.log("Connecting to Telegram...");

  const client = new TelegramClient(SESSION, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log("Connected!");

  // Calculate date range: last 7 days
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log(`Fetching messages from ${weekAgo.toISOString()} to ${now.toISOString()}`);

  // Fetch messages from source chat
  const messages = await client.getMessages(SOURCE_CHAT, {
    limit: 500,
    replyTo: SOURCE_TOPIC, // Topic/thread filter
  });

  console.log(`Fetched ${messages.length} messages`);

  // Filter inspections (messages starting with #)
  const inspections = [];

  for (const msg of messages) {
    if (!msg.message) continue;

    const msgDate = new Date(msg.date * 1000);
    if (msgDate < weekAgo) continue;

    const text = msg.message.trim();

    // Check if starts with hashtag
    if (!text.startsWith("#")) continue;

    inspections.push({
      date: msgDate.toISOString(),
      category: extractCategory(text),
      company: extractCompany(text),
      transferState: extractTransferState(text),
      unitType: extractUnitType(text),
      text: text.substring(0, 200), // First 200 chars
    });
  }

  console.log(`Found ${inspections.length} inspections in the last week`);

  // Debug: show unknown companies
  const unknownCompanies = inspections.filter(i => i.company === "Unknown");
  if (unknownCompanies.length > 0) {
    console.log(`\n⚠️  DEBUG: ${unknownCompanies.length} inspections with Unknown company:`);
    unknownCompanies.forEach((insp, idx) => {
      console.log(`\n--- Unknown Company #${idx + 1} ---`);
      console.log(`Date: ${insp.date}`);
      console.log(`Text: ${insp.text}`);
    });
  }

  // Debug: show unknown transfer states
  const unknownTransfer = inspections.filter(i => i.transferState === "Unknown");
  if (unknownTransfer.length > 0) {
    console.log(`\n⚠️  DEBUG: ${unknownTransfer.length} inspections with Unknown transfer state:`);
    unknownTransfer.forEach((insp, idx) => {
      console.log(`\n--- Unknown Transfer #${idx + 1} ---`);
      console.log(`Date: ${insp.date}`);
      console.log(`Text: ${insp.text}`);
    });
  }

  // Generate stats
  const stats = {
    total: inspections.length,
    byCategory: {},
    byCompany: {},
    byTransferState: {},
  };

  for (const insp of inspections) {
    stats.byCategory[insp.category] = (stats.byCategory[insp.category] || 0) + 1;
    stats.byCompany[insp.company] = (stats.byCompany[insp.company] || 0) + 1;
    stats.byTransferState[insp.transferState] = (stats.byTransferState[insp.transferState] || 0) + 1;
  }

  // Build report message
  const categoryLines = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `  ${cat}: ${count}`)
    .join("\n");

  const allCompanies = Object.entries(stats.byCompany).sort((a, b) => b[1] - a[1]);
  const companyLines = allCompanies
    .map(([comp, count]) => `  ${comp}: ${count}`)
    .join("\n");

  const transferLines = Object.entries(stats.byTransferState)
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `  ${state}: ${count}`)
    .join("\n");

  const report = `📊 WEEKLY INSPECTION REPORT
📅 ${weekAgo.toLocaleDateString()} - ${now.toLocaleDateString()}

📈 Total Inspections: ${stats.total}

📋 By Category:
${categoryLines}

🏢 Companies (${allCompanies.length}):
${companyLines}

📤 Transfer Status:
${transferLines}`;

  console.log("\n" + report);

  // Send to output chat
  console.log(`\nSending report to chat ${OUTPUT_CHAT}...`);
  await client.sendMessage(OUTPUT_CHAT, { message: report });
  console.log("Report sent!");

  await client.disconnect();
  console.log(`[${new Date().toISOString()}] Report generation complete.`);
}

// Schedule cron job: Monday 8pm Bishkek time (UTC+6 = 14:00 UTC)
// Cron format: minute hour day-of-month month day-of-week
// "0 14 * * 1" = At 14:00 UTC every Monday
cron.schedule("0 14 * * 1", () => {
  console.log("Cron triggered: Running weekly report...");
  runReport().catch(err => {
    console.error("Report generation failed:", err);
  });
}, {
  timezone: "UTC"
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Health check available at /health");
  console.log("Cron scheduled: Every Monday at 8pm Bishkek time (14:00 UTC)");
});

// Also allow manual run via command line argument
if (process.argv.includes("--run-now")) {
  runReport().catch(console.error);
}
