// THE ONE CONVERSATION, READ AND WRITTEN BY BOTH SURFACES.
//
// The floating pill and the chat window are two views onto the same product, and
// "expand" is supposed to show the SAME conversation. They are separate
// renderers, so the only thing they genuinely share is the origin — and
// therefore `localStorage`, which is where the chat has always kept its history.
//
// This module is the small, exact part of that store the pill needs: the message
// list the model is sent as `history`, and the ability to start a new one.
// Deliberately NOT a rewrite of the chat's own storage code. `demo.js` owns the
// full shape — titles, turns, transcripts, trimming — and reproducing any of
// that here would be a second implementation of a format, which is how two
// surfaces come to disagree about what the user said. What is shared is the KEYS
// and the two fields underneath them, and nothing else.
//
// WHY WRITING IS SAFE. The chat holds its chats in memory and saves the whole
// array, so a naive second writer would be clobbered. Two things prevent it:
// this module always re-reads immediately before it writes, and `demo.js`
// re-reads whenever the pill hands it a session (see `refreshChatsFromStorage`).
// Between those, the window in which either could overwrite the other is the
// time it takes to run one request, during which only one of them is being used.

const CHATS_KEY = "syscora_chats";
const ACTIVE_CHAT_KEY = "syscora_active_chat";
// The chat sends the last 24 messages as history and trims its stored copy to
// the same. Matched here so the pill and the chat send the model the same thing.
const MAX_MESSAGES = 24;
const MAX_CHATS = 25;

const newId = () => `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function readChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function writeChats(list) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(list.slice(0, MAX_CHATS)));
  } catch {
    // Out of room. Losing the oldest chats is much better than losing the one
    // being written — the same fallback the chat itself makes.
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(list.slice(0, Math.ceil(list.length / 2))));
    } catch { /* storage unavailable entirely; the session still works */ }
  }
}

/** The chat the user is on, creating one only if there is nothing at all. */
function activeChat(chats) {
  const id = localStorage.getItem(ACTIVE_CHAT_KEY);
  const found = chats.find((chat) => chat?.id === id);
  if (found) return found;
  if (chats[0]) return chats[0];
  const fresh = { id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), turns: [], conversation: [] };
  chats.unshift(fresh);
  try { localStorage.setItem(ACTIVE_CHAT_KEY, fresh.id); } catch { /* not fatal */ }
  return fresh;
}

/**
 * The conversation so far, oldest first, as the daemon wants it.
 *
 * Read fresh every time rather than cached: the chat window may have added to it
 * since the pill last looked, and a follow-up answered from a stale history is
 * the exact defect this shares storage to avoid.
 */
export function readHistory() {
  const chats = readChats();
  if (chats.length === 0) return [];
  const chat = activeChat(chats);
  return Array.isArray(chat?.conversation) ? chat.conversation.slice(-MAX_MESSAGES) : [];
}

/**
 * Append one message to the conversation the chat window will show.
 *
 * `shown` is what to TITLE the chat with when it is still untitled — the words
 * the user typed, never the body that was sent, because a chat called
 * "--- Attached folder: BotStorm ---" is useless in a list. Same rule as
 * `rememberInChat` in demo.js.
 */
export function appendMessage(role, text, shown = null) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  const chats = readChats();
  const chat = activeChat(chats);
  chat.conversation = Array.isArray(chat.conversation) ? chat.conversation : [];
  chat.conversation.push({ role, text: trimmed });
  if (chat.conversation.length > MAX_MESSAGES) {
    chat.conversation.splice(0, chat.conversation.length - MAX_MESSAGES);
  }
  if (role === "user" && (!chat.title || chat.title === "New chat")) {
    const naming = String(shown ?? trimmed).trim() || trimmed;
    chat.title = naming.length > 42 ? `${naming.slice(0, 42).trimEnd()}…` : naming;
  }
  chat.updatedAt = Date.now();
  chats.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  writeChats(chats);
}

/**
 * Start a new conversation, and make it the one the chat window opens on.
 *
 * The old one is kept — this is "new chat", not "delete chat", and the chat's
 * own list is where the user goes back to it.
 */
export function startNewChat() {
  const chats = readChats();
  const fresh = { id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), turns: [], conversation: [] };
  chats.unshift(fresh);
  writeChats(chats);
  try { localStorage.setItem(ACTIVE_CHAT_KEY, fresh.id); } catch { /* not fatal */ }
  return fresh.id;
}

/**
 * Record one finished exchange so the CHAT WINDOW shows it.
 *
 * THE CONVERSATION AND THE TRANSCRIPT ARE TWO DIFFERENT FIELDS, and the first
 * version of this module only wrote one of them. `conversation` is what the
 * model is sent as history; `turns` is what `renderStoredChat` draws. So a task
 * run from the pill continued correctly in the next message and then appeared
 * NOWHERE in the chat window — "the chat is not stored in the chat interface at
 * all", which is exactly right.
 *
 * A turn from the pill carries no `events` and no `session`: the pill does not
 * keep a transcript, and inventing one would put a different story in the chat
 * from the one the daemon actually recorded. `renderStoredChat` handles both
 * being absent — it draws the user's bubble, opens a Turn, replays nothing and
 * settles it — so the exchange reads as a plain question and answer, which is
 * what it was.
 *
 * The exception is a run the user EXPANDED: `attachToSession` in demo.js writes
 * the full transcript for that one, and it is the writer for those.
 */
export function recordTurn(userText, replyText) {
  const asked = String(userText ?? "").trim();
  const answered = String(replyText ?? "").trim();
  if (!asked && !answered) return;
  const chats = readChats();
  const chat = activeChat(chats);
  chat.turns = Array.isArray(chat.turns) ? chat.turns : [];
  chat.turns.push({
    id: `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    user: asked,
    sent: asked,
    reply: answered,
    attachments: [],
    at: Date.now(),
    events: [],
    // Enough for `renderFinal` to draw the answer. The daemon's own session is
    // richer; this is the honest subset the pill actually has.
    session: answered ? { finalResponse: { status: "COMPLETED", message: answered } } : null
  });
  // The chat trims to 40 and so does this, or a long pill session would push the
  // store past what localStorage will hold.
  if (chat.turns.length > 40) chat.turns.splice(0, chat.turns.length - 40);
  chat.updatedAt = Date.now();
  chats.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  writeChats(chats);
}

/** Which conversation the pill is on, for the header that says so. */
export function activeChatTitle() {
  const chats = readChats();
  if (chats.length === 0) return "New chat";
  return String(activeChat(chats)?.title ?? "New chat") || "New chat";
}
