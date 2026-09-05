// "EXPAND" MUST OPEN THE SAME CONVERSATION, and the two surfaces are separate
// renderers. The only thing they genuinely share is the origin, and therefore
// `localStorage` — which is where the chat has always kept its history.
//
// This module is the small, exact part of that store the floating pill needs.
// The risk it carries is silent divergence: a shape mismatch here does not throw,
// it just means the pill sends the model a different history than the chat shows,
// and a follow-up answers from the wrong thread. So the keys and the field are
// pinned, not merely exercised.

import test from "node:test";
import assert from "node:assert/strict";

// A localStorage that behaves like the real one, because these functions are
// nothing but reads and writes through it.
function installStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  };
  return data;
}

async function freshStore() {
  // Re-imported per test so nothing is carried between them in module scope.
  return import(`../../apps/desktop/chat-store.js?${Math.random()}`);
}

test("an empty machine reads an empty history rather than failing", async () => {
  installStorage();
  const store = await freshStore();
  assert.deepEqual(store.readHistory(), []);
});

// THE KEYS ARE THE CONTRACT. `demo.js` owns the full shape and this module only
// touches two fields underneath it — if either name drifts, the pill writes into
// a store the chat never reads and neither of them says anything.
test("it reads the chat's own keys, and the conversation the chat sends", async () => {
  const data = installStorage({
    syscora_chats: JSON.stringify([
      { id: "a", title: "one", updatedAt: 2, conversation: [{ role: "user", text: "play something" }] },
      { id: "b", title: "two", updatedAt: 1, conversation: [{ role: "user", text: "other thread" }] }
    ]),
    syscora_active_chat: "a"
  });
  const store = await freshStore();
  assert.deepEqual(store.readHistory(), [{ role: "user", text: "play something" }]);
  assert.ok(data.has("syscora_chats"), "the chat's key, not one of our own");
});

test("a message written by the pill is in the chat's active conversation", async () => {
  const data = installStorage({
    syscora_chats: JSON.stringify([{ id: "a", title: "New chat", updatedAt: 1, turns: [], conversation: [] }]),
    syscora_active_chat: "a"
  });
  const store = await freshStore();
  store.appendMessage("user", "play apsara aali", "play apsara aali");
  store.appendMessage("assistant", "Playing it.");

  const chats = JSON.parse(data.get("syscora_chats"));
  assert.deepEqual(chats[0].conversation, [
    { role: "user", text: "play apsara aali" },
    { role: "assistant", text: "Playing it." }
  ]);
  // A follow-up must see what was just said, or "next song" has no subject.
  assert.equal(store.readHistory().length, 2);
});

// The title comes from what the user TYPED, never from the body that was sent —
// a chat called "--- Attached folder: BotStorm ---" is useless in a list. Same
// rule as `rememberInChat` in demo.js.
test("an untitled chat is named from the typed words, not the sent body", async () => {
  const data = installStorage({
    syscora_chats: JSON.stringify([{ id: "a", title: "New chat", updatedAt: 1, conversation: [] }]),
    syscora_active_chat: "a"
  });
  const store = await freshStore();
  store.appendMessage("user", "summarise this\n\n--- Attached folder: BotStorm ---", "summarise this");
  assert.equal(JSON.parse(data.get("syscora_chats"))[0].title, "summarise this");
});

test("a new chat becomes the active one and starts empty", async () => {
  const data = installStorage({
    syscora_chats: JSON.stringify([{ id: "a", title: "old", updatedAt: 1, conversation: [{ role: "user", text: "before" }] }]),
    syscora_active_chat: "a"
  });
  const store = await freshStore();
  const id = store.startNewChat();

  assert.equal(data.get("syscora_active_chat"), id);
  assert.deepEqual(store.readHistory(), [], "a new subject starts with nothing behind it");
  // NEW chat, not DELETE chat: the old one is still there to go back to.
  assert.ok(JSON.parse(data.get("syscora_chats")).some((chat) => chat.id === "a"));
});

// Both surfaces trim to the same number, so both send the model the same thing.
test("history is bounded the way the chat bounds it", async () => {
  installStorage({
    syscora_chats: JSON.stringify([{
      id: "a", updatedAt: 1,
      conversation: Array.from({ length: 60 }, (_, index) => ({ role: "user", text: `m${index}` }))
    }]),
    syscora_active_chat: "a"
  });
  const store = await freshStore();
  const history = store.readHistory();
  assert.equal(history.length, 24);
  assert.equal(history.at(-1).text, "m59", "the NEWEST must survive, not the oldest");
});

// Storage that is corrupt or unavailable must not take the pill down with it.
test("unreadable storage degrades to an empty history", async () => {
  installStorage({ syscora_chats: "{not json" });
  const store = await freshStore();
  assert.deepEqual(store.readHistory(), []);
});
