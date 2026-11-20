const crypto = require("crypto");
const { promisify } = require("util");
const express = require("express");
const path = require("path");
require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_AI_KEY });
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : null;
const scrypt = promisify(crypto.scrypt);
const AUTH_COOKIE = "auth_token";
const AUTH_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const FREE_CHAT_LIMIT = 100;
const CHAT_UNLOCK_PRICE_USD = 10;

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

let schemaPromise;

async function ensureSchema() {
    if (!pool) {
        throw new Error("DATABASE_URL is not configured.");
    }

    if (!schemaPromise) {
        schemaPromise = pool.query(`
            CREATE TABLE IF NOT EXISTS yes_ai_users (
                id UUID PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                unlimited_chat BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            ALTER TABLE yes_ai_users
                ADD COLUMN IF NOT EXISTS unlimited_chat BOOLEAN NOT NULL DEFAULT FALSE;

            CREATE TABLE IF NOT EXISTS yes_ai_chat_usage (
                user_id UUID PRIMARY KEY REFERENCES yes_ai_users(id) ON DELETE CASCADE,
                window_started_at TIMESTAMPTZ,
                messages_used INTEGER NOT NULL DEFAULT 0 CHECK (messages_used >= 0),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS yes_ai_conversations (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES yes_ai_users(id) ON DELETE CASCADE,
                title TEXT NOT NULL DEFAULT 'New chat',
                messages JSONB NOT NULL DEFAULT '[]'::jsonb,
                version INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS yes_ai_billing_orders (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES yes_ai_users(id),
                plan_key TEXT NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                currency TEXT NOT NULL,
                tx_ref TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'failed')),
                transaction_id TEXT UNIQUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `).catch(error => {
            schemaPromise = null;
            throw error;
        });
    }

    return schemaPromise;
}

function authSecretIsConfigured() {
    return typeof process.env.AUTH_JWT_SECRET === "string"
        && Buffer.byteLength(process.env.AUTH_JWT_SECRET) >= 32;
}

async function ensureAuthInfrastructure(res) {
    const missingConfiguration = [];
    if (!authSecretIsConfigured()) {
        missingConfiguration.push("AUTH_JWT_SECRET (at least 32 characters)");
    }
    if (!pool) {
        missingConfiguration.push("DATABASE_URL");
    }
    if (missingConfiguration.length > 0) {
        res.status(503).json({
            error: `Server setup is incomplete. Set ${missingConfiguration.join(" and ")} in .env.`
        });
        return false;
    }

    try {
        await ensureSchema();
        return true;
    } catch (error) {
        console.error("Database initialization error:", error.message);
        res.status(503).json({ error: "Database is unavailable." });
        return false;
    }
}

function formatChatUsage(row) {
    const used = Number(row.messages_used);
    return {
        unlimited: false,
        limit: FREE_CHAT_LIMIT,
        used,
        remaining: Math.max(0, FREE_CHAT_LIMIT - used),
        resetsAt: row.resets_at ? new Date(row.resets_at).toISOString() : null
    };
}

async function getChatUsage(userId) {
    await pool.query(
        `INSERT INTO yes_ai_chat_usage (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
    );
    await pool.query(
        `UPDATE yes_ai_chat_usage
         SET window_started_at = NULL, messages_used = 0, updated_at = NOW()
         WHERE user_id = $1
           AND window_started_at <= NOW() - INTERVAL '72 hours'`,
        [userId]
    );
    const result = await pool.query(
        `SELECT messages_used, window_started_at + INTERVAL '72 hours' AS resets_at
         FROM yes_ai_chat_usage
         WHERE user_id = $1`,
        [userId]
    );
    return formatChatUsage(result.rows[0]);
}

async function reserveChatPrompt(userId) {
    await pool.query(
        `INSERT INTO yes_ai_chat_usage (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
    );
    const result = await pool.query(
        `UPDATE yes_ai_chat_usage
         SET window_started_at = CASE
                 WHEN window_started_at IS NULL OR window_started_at <= NOW() - INTERVAL '72 hours'
                 THEN NOW()
                 ELSE window_started_at
             END,
             messages_used = CASE
                 WHEN window_started_at IS NULL OR window_started_at <= NOW() - INTERVAL '72 hours'
                 THEN 1
                 ELSE messages_used + 1
             END,
             updated_at = NOW()
         WHERE user_id = $1
           AND (
               window_started_at IS NULL
               OR window_started_at <= NOW() - INTERVAL '72 hours'
               OR messages_used < $2
           )
         RETURNING messages_used,
                   window_started_at::text AS window_started_at,
                   window_started_at + INTERVAL '72 hours' AS resets_at`,
        [userId, FREE_CHAT_LIMIT]
    );
    return result.rows[0] || null;
}

async function refundChatPrompt(userId, windowStartedAt) {
    await pool.query(
        `UPDATE yes_ai_chat_usage
         SET messages_used = GREATEST(messages_used - 1, 0),
             window_started_at = CASE WHEN messages_used = 1 THEN NULL ELSE window_started_at END,
             updated_at = NOW()
         WHERE user_id = $1 AND window_started_at = $2`,
        [userId, windowStartedAt]
    );
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64, { maxmem: 64 * 1024 * 1024 });
    return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const parts = storedHash.split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt" || !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) {
        return false;
    }

    const expected = Buffer.from(parts[2], "hex");
    const actual = await scrypt(password, Buffer.from(parts[1], "hex"), expected.length, { maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
}

function signAuthToken(user) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
        sub: user.id,
        email: user.email,
        iat: now,
        exp: now + AUTH_TOKEN_LIFETIME_SECONDS
    })).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = crypto.createHmac("sha256", process.env.AUTH_JWT_SECRET)
        .update(signingInput)
        .digest("base64url");
    return `${signingInput}.${signature}`;
}

function verifyAuthToken(token) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        return null;
    }

    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac("sha256", process.env.AUTH_JWT_SECRET)
        .update(signingInput)
        .digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return null;
    }

    try {
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (header.alg !== "HS256"
            || typeof payload.sub !== "string"
            || typeof payload.email !== "string"
            || !Number.isInteger(payload.exp)
            || payload.exp <= Math.floor(Date.now() / 1000)) {
            return null;
        }
        return { id: payload.sub, email: payload.email };
    } catch {
        return null;
    }
}

function setAuthCookie(res, token) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
        "Set-Cookie",
        `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_TOKEN_LIFETIME_SECONDS}${secure}`
    );
}

function readAuthCookie(req) {
    const cookieHeader = req.headers.cookie || "";
    for (const part of cookieHeader.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0 || part.slice(0, separator).trim() !== AUTH_COOKIE) {
            continue;
        }
        try {
            return decodeURIComponent(part.slice(separator + 1).trim());
        } catch {
            return null;
        }
    }
    return null;
}

async function requireAuth(req, res, next) {
    if (!(await ensureAuthInfrastructure(res))) {
        return;
    }

    const token = readAuthCookie(req);
    const user = token ? verifyAuthToken(token) : null;
    if (!user) {
        return res.status(401).json({ error: "Authentication required." });
    }

    try {
        const result = await pool.query(
            "SELECT id, email, unlimited_chat FROM yes_ai_users WHERE id = $1",
            [user.id]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Authentication required." });
        }
        req.user = {
            id: result.rows[0].id,
            email: result.rows[0].email,
            unlimitedChat: result.rows[0].unlimited_chat
        };
        return next();
    } catch (error) {
        console.error("Authentication lookup error:", error.message);
        return res.status(503).json({ error: "Could not verify your account right now." });
    }
}

function normalizeEmail(email) {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setUserSession(res, user) {
    setAuthCookie(res, signAuthToken(user));
    return res.json({ user: { id: user.id, email: user.email } });
}

app.post("/api/auth/register", async (req, res) => {
    if (!(await ensureAuthInfrastructure(res))) {
        return;
    }

    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!isValidEmail(email) || typeof password !== "string" || password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: "Enter a valid email and a password between 8 and 128 characters." });
    }

    let client;
    let transactionStarted = false;
    try {
        const passwordHash = await hashPassword(password);
        const userId = crypto.randomUUID();
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;

        const result = await client.query(
            `INSERT INTO yes_ai_users (id, email, password_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO NOTHING
             RETURNING id, email, unlimited_chat`,
            [userId, email, passwordHash]
        );
        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({ error: "An account with that email already exists." });
        }

        await client.query(
            "INSERT INTO yes_ai_chat_usage (user_id) VALUES ($1)",
            [userId]
        );
        await client.query("COMMIT");
        transactionStarted = false;

        return setUserSession(res, result.rows[0]);
    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(rollbackError => {
                console.error("Registration rollback error:", rollbackError.message);
            });
        }
        console.error("Registration error:", error.message);
        return res.status(500).json({ error: "Could not create your account." });
    } finally {
        if (client) {
            client.release();
        }
    }
});

app.post("/api/auth/login", async (req, res) => {
    if (!(await ensureAuthInfrastructure(res))) {
        return;
    }

    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!isValidEmail(email) || typeof password !== "string" || password.length > 128) {
        return res.status(400).json({ error: "Enter a valid email and password." });
    }

    try {
        const result = await pool.query(
            "SELECT id, email, password_hash FROM yes_ai_users WHERE email = $1",
            [email]
        );
        const user = result.rows[0];
        if (!user || !(await verifyPassword(password, user.password_hash))) {
            return res.status(401).json({ error: "Email or password is incorrect." });
        }
        return setUserSession(res, user);
    } catch (error) {
        console.error("Login error:", error.message);
        return res.status(500).json({ error: "Could not sign in." });
    }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
    return res.json({ user: req.user });
});

app.post("/api/auth/logout", (req, res) => {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
    return res.json({ success: true });
});

app.get("/api/chat/quota", requireAuth, async (req, res) => {
    if (req.user.unlimitedChat) {
        return res.json({ unlimited: true, limit: null, used: 0, remaining: null, resetsAt: null });
    }

    try {
        return res.json(await getChatUsage(req.user.id));
    } catch (error) {
        console.error("Chat quota error:", error.message);
        return res.status(500).json({ error: "Could not load your free chat limit." });
    }
});

app.get("/api/chat/conversations", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, title, updated_at
             FROM yes_ai_conversations
             WHERE user_id = $1
             ORDER BY updated_at DESC
             LIMIT 100`,
            [req.user.id]
        );
        return res.json({ conversations: result.rows });
    } catch (error) {
        console.error("Conversation list error:", error.message);
        return res.status(500).json({ error: "Could not load recent chats." });
    }
});

app.post("/api/chat/conversations", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `INSERT INTO yes_ai_conversations (id, user_id)
             VALUES ($1, $2)
             RETURNING id, title, updated_at`,
            [crypto.randomUUID(), req.user.id]
        );
        return res.status(201).json({ conversation: result.rows[0] });
    } catch (error) {
        console.error("Conversation creation error:", error.message);
        return res.status(500).json({ error: "Could not start a new chat." });
    }
});

app.get("/api/chat/conversations/:id", requireAuth, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid chat ID." });
    }

    try {
        const result = await pool.query(
            `SELECT id, title, messages, updated_at
             FROM yes_ai_conversations
             WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Chat not found." });
        }
        return res.json({ conversation: result.rows[0] });
    } catch (error) {
        console.error("Conversation load error:", error.message);
        return res.status(500).json({ error: "Could not load this chat." });
    }
});

app.post("/api/chat", requireAuth, async (req, res) => {
    const userMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!userMessage || userMessage.length > 10000) {
        return res.status(400).json({ error: "Enter a message up to 10,000 characters." });
    }
    const conversationId = req.body?.conversationId;
    if (typeof conversationId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
        return res.status(400).json({ error: "A valid chat ID is required." });
    }

    let reservedWindowStartedAt;
    try {
        const conversationResult = await pool.query(
            `SELECT messages, title, version
             FROM yes_ai_conversations
             WHERE id = $1 AND user_id = $2`,
            [conversationId, req.user.id]
        );
        const conversation = conversationResult.rows[0];
        if (!conversation) {
            return res.status(404).json({ error: "Chat not found." });
        }

        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        const contents = messages.slice(-10).map(item => {
            if (!item || (item.role !== "user" && item.role !== "model") || typeof item.text !== "string") {
                throw new Error("Stored chat history is invalid.");
            }
            return { role: item.role, parts: [{ text: item.text }] };
        });
        contents.push({ role: "user", parts: [{ text: userMessage }] });

        let usage = { unlimited: true, limit: null, used: 0, remaining: null, resetsAt: null };
        if (!req.user.unlimitedChat) {
            const reservedUsage = await reserveChatPrompt(req.user.id);
            if (!reservedUsage) {
                const freeUsage = await getChatUsage(req.user.id);
                return res.status(429).json({
                    error: "You’ve reached the free chat limit. Your chats will be available again within 72-hour or you upgrade  to start using unlimited chat",
                    usage: freeUsage
                });
            }
            reservedWindowStartedAt = reservedUsage.window_started_at;
            usage = formatChatUsage(reservedUsage);
        }
        

        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash-lite",
            contents: userMessage,
            config: {
        systemInstruction: "Your name is GEMA. You are an advanced AI assistant specializing in coding, programming, and web development. Only state your name or introduce yourself if the user explicitly asks for your name (e.g., 'What is your name?', 'Who are you?'). For normal questions, just answer directly without introducing yourself."
    }
        });
        const reply = response.text || "I couldn't generate a response.";
        const savedMessages = [
            ...messages,
            { role: "user", text: userMessage },
            { role: "model", text: reply }
        ].slice(-200);
        const title = conversation.title === "New chat"
            ? userMessage.replace(/\s+/g, " ").slice(0, 60)
            : conversation.title;
        const saveResult = await pool.query(
            `UPDATE yes_ai_conversations
             SET title = $1, messages = $2::jsonb, version = version + 1, updated_at = NOW()
             WHERE id = $3 AND user_id = $4 AND version = $5
             RETURNING id`,
            [title, JSON.stringify(savedMessages), conversationId, req.user.id, conversation.version]
        );
        if (saveResult.rows.length === 0) {
            if (reservedWindowStartedAt) {
                await refundChatPrompt(req.user.id, reservedWindowStartedAt).catch(refundError => {
                    console.error("Chat quota refund error:", refundError.message);
                });
                reservedWindowStartedAt = null;
            }
            return res.status(409).json({ error: "This chat changed in another tab. Reload it and try again." });
        }
        reservedWindowStartedAt = null;
        return res.json({
            message: reply,
            usage,
            conversation: { id: conversationId, title }
        });
    } catch (error) {
        if (reservedWindowStartedAt) {
            await refundChatPrompt(req.user.id, reservedWindowStartedAt).catch(refundError => {
                console.error("Chat quota refund error:", refundError.message);
            });
        }
        console.error("Chat error:", error.message);
        return res.status(500).json({ error: "Failed to communicate with AI chat service." });
    }
});

app.post("/api/billing/initialize", requireAuth, async (req, res) => {
    if (req.user.unlimitedChat) {
        return res.status(409).json({ error: "Unlimited chat is already active on your account." });
    }
    if (!process.env.FLW_SECRET_KEY) {
        return res.status(503).json({ error: "Flutterwave key is not configured." });
    }

    const txRef = `yesai-${crypto.randomUUID()}`;
    try {
        await pool.query(
            `INSERT INTO yes_ai_billing_orders (id, user_id, plan_key, amount, currency, tx_ref)
             VALUES ($1, $2, 'lifetime_chat', $3, 'USD', $4)`,
            [crypto.randomUUID(), req.user.id, CHAT_UNLOCK_PRICE_USD, txRef]
        );

        const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
        const response = await fetch("https://api.flutterwave.com/v3/payments", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                tx_ref: txRef,
                amount: CHAT_UNLOCK_PRICE_USD,
                currency: "USD",
                redirect_url: `${appUrl}/checkout-result.html`,
                customer: {
                    email: req.user.email,
                    name: req.user.email.split("@")[0]
                },
                customizations: {
                    title: "YES AI Chat",
                    description: "One-time payment for lifetime unlimited chat access."
                }
            })
        });

        const data = await response.json();
        if (!response.ok || data.status !== "success" || !data.data?.link) {
            await pool.query(
                "UPDATE yes_ai_billing_orders SET status = 'failed', updated_at = NOW() WHERE tx_ref = $1",
                [txRef]
            );
            throw new Error(data.message || "Failed to initialize Flutterwave payment.");
        }

        return res.json({ authorizationUrl: data.data.link });
    } catch (error) {
        console.error("Flutterwave init error:", error.message);
        return res.status(500).json({ error: "Could not start checkout." });
    }
});

app.post("/api/billing/verify-flw", requireAuth, async (req, res) => {
    const transactionId = req.body?.transaction_id;
    if (typeof transactionId !== "string" || !transactionId) {
        return res.status(400).json({ error: "Missing transaction ID." });
    }
    if (!process.env.FLW_SECRET_KEY) {
        return res.status(503).json({ error: "Flutterwave key is not configured." });
    }

    let client;
    let transactionStarted = false;
    try {
        const verifyRes = await fetch(
            `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok || verifyData.status !== "success" || verifyData.data?.status !== "successful") {
            return res.status(400).json({ error: "Payment was not completed." });
        }

        const tx = verifyData.data;
        if (typeof tx.tx_ref !== "string") {
            return res.status(400).json({ error: "Payment reference is invalid." });
        }

        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const orderResult = await client.query(
            `SELECT id, plan_key, amount, currency, status, transaction_id
             FROM yes_ai_billing_orders
             WHERE tx_ref = $1 AND user_id = $2
             FOR UPDATE`,
            [tx.tx_ref, req.user.id]
        );
        const order = orderResult.rows[0];
        if (!order) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(400).json({ error: "Payment does not belong to this account." });
        }

        if (order.status === "paid") {
            await client.query("ROLLBACK");
            transactionStarted = false;
            if (order.transaction_id === transactionId && order.plan_key === "lifetime_chat") {
                return res.json({
                    success: true,
                    unlimited: true,
                    alreadyProcessed: true
                });
            }
            return res.status(400).json({ error: "This payment order has already been processed." });
        }

        const paidAmount = Number(tx.amount);
        if (order.plan_key !== "lifetime_chat"
            || order.status !== "pending"
            || tx.currency !== order.currency
            || !Number.isFinite(paidAmount)
            || paidAmount < Number(order.amount)) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(400).json({ error: "Payment amount, currency, or order status mismatch." });
        }

        await client.query(
            "UPDATE yes_ai_users SET unlimited_chat = TRUE WHERE id = $1",
            [req.user.id]
        );
        await client.query(
            `UPDATE yes_ai_billing_orders
             SET status = 'paid', transaction_id = $1, updated_at = NOW()
             WHERE id = $2`,
            [transactionId, order.id]
        );
        await client.query("COMMIT");
        transactionStarted = false;

        return res.json({ success: true, unlimited: true });
    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(rollbackError => {
                console.error("Flutterwave verification rollback error:", rollbackError.message);
            });
        }
        console.error("Flutterwave verify error:", error.message);
        return res.status(500).json({ error: "Failed to verify payment." });
    } finally {
        if (client) {
            client.release();
        }
    }
});

if (pool) {
    pool.on("error", error => {
        console.error("Unexpected PostgreSQL pool error:", error.message);
    });
}

app.listen(port, () => {
    console.log(`Chat app running at http://localhost:${port}`);
});
