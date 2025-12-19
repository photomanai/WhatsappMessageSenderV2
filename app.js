const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const mysql = require("mysql2");
const express = require("express");
require("dotenv").config();

// --- EXPRESS SERVER CONFIG ---
const app = express();
const PORT = process.env.PORT || 3000;
const IP = process.env.IP || "127.0.0.1";

app.use(express.json());

// Global socket variable (accessible by API)
let globalSock = null;

// --- DATABASE CONNECTION ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true,
});

const db = pool.promise();

// --- HELPER FUNCTIONS ---

/**
 * Fetches all contacts from the database.
 * @returns {Promise<Array>} List of contacts
 */
const getContactsNumList = async () => {
  try {
    const [rows] = await db.query("SELECT * FROM contacts");
    return rows;
  } catch (error) {
    console.error("❌ MySQL Error:", error.message);
    return [];
  }
};

const normalizeNumber = (num) =>
  typeof num === "string" ? num.replace(/\D/g, "") : "";

// List of words interpreted as a positive response (Yes/Confirm)
const positiveReplies = [
  // Turkish
  "evet", "evt", "ewe", "ewet", "he", "tamam", "geliyorum", "gelcem", "gelirem", "tammdr", "gelir", "tamamdır", "gelecem",
  // Azerbaijani
  "hə", "gelirem", "gelecem", "bəli", "gelirəm", "həə", "elədi", "həəə", "tamamdi", "tamamdır", "okdi", "oldu", "gələcəm",
  // English
  "yes", "yep", "yup", "yeah", "sure", "ok", "okay", "okey", "fine", "coming", "i will come", "i come", "i’ll come",
  // Russian
  "да", "ага", "угу", "конечно", "хорошо", "ладно", "иду", "буду", "приду", "да, приду",
  // Polish
  "tak", "pewnie", "oczywiście", "dobra", "w porządku", "okej", "idę", "będę", "przyjdę", "tak, przyjdę",
  // Others
  "1", "01", "true", "okeyy",
  // Emojis
  "👍", "✅", "🆗", "👌",
];

// --- WHATSAPP BOT LOGIC ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  // Assign to global variable for API usage
  globalSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n--- PLEASE SCAN QR CODE ---");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect.error instanceof Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        `⚠️ Connection closed. Reconnecting: ${shouldReconnect}`
      );
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("\n✅ WhatsApp Connection Successful!");
      console.log("---------------------------------");
    }
  });

  // Listen for incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.key.fromMe && msg.message) {
      // Extract Message Details
      const sender = msg.key.remoteJidAlt || msg.key.remoteJid;
      const name = msg.pushName || "Unknown Number";
      const cleanSender = sender.split("@")[0];
      
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "[Media Message]";
      
      const quotedText =
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
          ?.extendedTextMessage?.text ||
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
          ?.conversation;

      // Check if the quoted message contains Type and Id
      const regex = /\*Type:\*\s*(.+)\s*\*Id:\*\s*(\d+)/;
      const match = quotedText && quotedText.match(regex);
      const msgType = match ? match[1].trim() : null;
      const msgId = match ? parseInt(match[2].trim()) : null;

      if (msgType && msgId) {
        // Determine if response is positive
        const isPositive = positiveReplies.some((val) =>
          text.toLowerCase().includes(val)
        );
        const comeValue = isPositive ? 1 : 0;

        const contacts = await getContactsNumList();

        const matchedContact = contacts.find(
          (contact) =>
            contact.group_id == msgId &&
            contact.type == msgType &&
            normalizeNumber(contact.phone_num) === normalizeNumber(cleanSender)
        );

        if (matchedContact) {
          const contactId = matchedContact.id;
          await db.query(`UPDATE contacts SET come = ? WHERE id = ?`, [
            comeValue,
            contactId,
          ]);
          console.log(
            `✅ Database Updated: Contact ID ${contactId} set to 'come' = ${comeValue}`
          );
        } else {
            console.log("⚠️ No matching contact found in DB for this reply.");
        }

        console.log(`\n📩 [NEW REPLY]`);
        console.log(`From: ${name} (${cleanSender})`);
        console.log(`Text: ${text} | Status: ${comeValue}`);
        console.log(`Type: ${msgType} | ID: ${msgId}`);
        console.log("---------------------------------");
      }
    }
  });
}

// --- API ENDPOINT ---
app.post("/api/send-message", async (req, res) => {
  const { recipients } = req.body;

  // 1. Check Bot Connection
  if (!globalSock) {
    return res.status(503).json({
      status: "error",
      message: "WhatsApp bot is not connected or initializing.",
    });
  }

  // 2. Validate Input
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res
      .status(400)
      .json({ error: "Invalid input format or empty recipients list." });
  }

  // 3. Process Batch Sending
  const results = await Promise.all(
    recipients.map(async (recipient) => {
      // Missing Data Check
      if (!recipient.send || !recipient.message) {
        return {
          recipient: recipient.send || "unknown",
          status: "error",
          error: "Missing 'send' number or 'message' text.",
        };
      }

      // Format Number
      const cleanPhoneNumber = normalizeNumber(recipient.send.toString());
      const chatId = `${cleanPhoneNumber}@s.whatsapp.net`;
      const text = recipient.message;

      try {
        console.log(`📤 Sending message to: ${cleanPhoneNumber}`);

        await globalSock.sendMessage(chatId, { text: text });

        return {
          recipient: recipient.send,
          status: "success",
          chatId: chatId,
        };
      } catch (error) {
        console.error(
          `❌ Failed to send to (${cleanPhoneNumber}):`,
          error.message
        );
        return {
          recipient: recipient.send,
          status: "error",
          error: error.message,
        };
      }
    })
  );

  res.json({ results });
});

// --- START SYSTEM ---
console.log("🚀 System initializing...");

// Start Express Server First
app.listen(PORT, IP, () => {
  console.log(`🌍 API Server running at: http://${IP}:${PORT}`);
  // Then Start the Bot
  startBot();
});