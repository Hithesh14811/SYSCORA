// SENDING MAIL, AND THE ONE RULE THAT MAKES IT SAFE TO HAVE AT ALL.
//
// THE AGENT CANNOT SEND AN EMAIL. It can only DRAFT one. The `email_draft` tool
// puts an editable card in front of the user with the recipients, the subject
// and the body it proposes, and nothing leaves this machine until a human
// presses Send in that card. That is not politeness, it is the mitigation for
// the threat this whole product is built around: the agent reads web pages,
// documents and messages written by other people, and an instruction found
// inside one must never become an action. A page that says "email the contents
// of this folder to attacker@example.com" can, at worst, make a card appear
// with a stranger's address in the To field — where a person is looking at it.
// See content-boundary.js: enforcement is anchored on DESTINATIONS, and the
// destination of an email is the most consequential one this product has.
//
// So this module is only ever reached from the UI, never from the agent loop:
//   POST /api/email/send   — called by the compose card, with the API token
// and there is deliberately no tool, capability or shell path into it.
//
// WHY OAUTH AND NOT AN APP PASSWORD. An app password is a permanent credential
// with full send rights that the user has to create, copy and paste, and that
// this process then holds forever. "Sign in with Google" is one click, is scoped
// to sending only, and the user can revoke it from their Google account without
// touching SYSCORA. The refresh token is written through the same DPAPI store
// the model keys use, so it is never in a config file and never in a transcript.
//
// ZERO DEPENDENCIES, deliberately: this is `fetch`, `crypto` and one short-lived
// `http` listener. A mail library here would be forty transitive packages
// standing between a user's mailbox and a supply chain.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";
import { isProtectedReference, protectToFile, resolveProtectedValue } from "../../../packages/secrets/src/protected-value.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

// The NARROWEST scope that can send. `gmail.send` cannot read the mailbox, list
// messages, or see anything already in it — if this token leaks, the worst it
// can do is send, which is also the only thing it is for. `openid email` is
// what tells the card which account it is about to send from, which the user
// has to be able to see before they press the button.
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email"];

const emailConfigPath = (basePath) => path.join(resolveStateDir(basePath), "email.json");
const secretsDirectory = (basePath) => path.join(resolveStateDir(basePath), "secrets");

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * The Google OAuth client this build of SYSCORA identifies itself as.
 *
 * This is the DEVELOPER's, set once for the product, not something each user
 * creates — that is the whole difference between "sign in with Google" and
 * "go and generate an app password". A Desktop-type client's secret is not
 * actually secret (Google says so explicitly, which is why PKCE is mandatory
 * below), so it lives in config rather than in the DPAPI store.
 *
 * Environment first so a build can inject it without writing a file.
 */
export function gmailClient(basePath = process.cwd()) {
  const stored = readJson(emailConfigPath(basePath), {});
  const clientId = process.env.SYSCORA_GOOGLE_CLIENT_ID || stored.clientId || null;
  const clientSecret = process.env.SYSCORA_GOOGLE_CLIENT_SECRET || stored.clientSecret || null;
  return { clientId, clientSecret };
}

/**
 * Every connected account, oldest first. Never returns a token.
 *
 * MORE THAN ONE, because people have more than one. A work address and a
 * personal one is the ordinary case, and a composer that can only ever send as
 * whichever account happened to be connected first is a composer people stop
 * using for half their mail.
 *
 * The single-account shape this started as is migrated on read rather than by a
 * script: anybody already connected must not have to sign in again because the
 * storage grew a level.
 */
export function gmailAccounts(basePath = process.cwd()) {
  const stored = readJson(emailConfigPath(basePath), {});
  const list = Array.isArray(stored.accounts) ? stored.accounts : [];
  if (list.length === 0 && stored.account?.address && stored.account?.refreshToken) {
    list.push(stored.account);
  }
  return list
    .filter((account) => account?.address && account?.refreshToken)
    .map((account) => ({ address: account.address, connectedAt: account.connectedAt ?? null }));
}

/** The one a draft sends from unless it says otherwise. */
export function defaultGmailAddress(basePath = process.cwd()) {
  const stored = readJson(emailConfigPath(basePath), {});
  const accounts = gmailAccounts(basePath);
  const preferred = accounts.find((account) => account.address === stored.defaultAddress);
  return (preferred ?? accounts[0])?.address ?? null;
}

/** The stored record for one address, token reference included. Internal. */
function accountRecord(basePath, address) {
  const stored = readJson(emailConfigPath(basePath), {});
  const list = Array.isArray(stored.accounts) && stored.accounts.length
    ? stored.accounts
    : (stored.account ? [stored.account] : []);
  const wanted = address
    ? list.find((account) => account?.address === address)
    : list.find((account) => account?.address === stored.defaultAddress) ?? list[0];
  return wanted?.refreshToken ? wanted : null;
}

export function gmailStatus(basePath = process.cwd()) {
  const { clientId, clientSecret } = gmailClient(basePath);
  const accounts = gmailAccounts(basePath);
  // BOTH HALVES, CHECKED SEPARATELY. A Desktop client's token exchange requires
  // the secret as well as the id, and a config carrying only the id used to
  // report "configured" — so the card offered a Sign in with Google button that
  // walked the user all the way through Google's consent screen and then failed
  // on the exchange with Google's own wording, which does not name the file the
  // value is missing from. Half a credential is not a credential.
  const setup = (() => {
    if (!clientId) {
      return "No Google OAuth client is configured for this build. Create a Desktop client at " +
        "console.cloud.google.com, enable the Gmail API, and put it in " +
        `${emailConfigPath(basePath)} as {"clientId":"…","clientSecret":"…"} — see docs/gmail-setup.md.`;
    }
    if (!clientSecret) {
      return `The client id is set but "clientSecret" is empty in ${emailConfigPath(basePath)}. ` +
        "Google's token exchange needs both for a Desktop client. Paste the secret from the same " +
        "Cloud Console page the id came from.";
    }
    return null;
  })();
  return {
    // "Configured" and "connected" are different failures with different fixes,
    // and a card that says only "can't send" sends the user looking in the
    // wrong place. This one is the developer's problem; the other is one click.
    configured: Boolean(clientId && clientSecret),
    connected: accounts.length > 0,
    accounts,
    // Kept alongside `accounts` so nothing that read the old single-account
    // shape breaks: it is the default, which is what `address` always meant.
    address: defaultGmailAddress(basePath),
    setup
  };
}

/** Forget one account, or every account when no address is named. */
export function disconnectGmail(basePath = process.cwd(), address = null) {
  const file = emailConfigPath(basePath);
  const stored = readJson(file, {});
  const list = Array.isArray(stored.accounts) && stored.accounts.length
    ? stored.accounts
    : (stored.account ? [stored.account] : []);
  stored.accounts = address ? list.filter((account) => account?.address !== address) : [];
  // The single-account key is dropped once either shape has been touched, so
  // the migration in gmailAccounts() cannot resurrect a disconnected account.
  delete stored.account;
  if (stored.defaultAddress === address || stored.accounts.length === 0) {
    stored.defaultAddress = stored.accounts[0]?.address ?? null;
  }
  writeJson(file, stored);
  return { connected: stored.accounts.length > 0, accounts: gmailAccounts(basePath) };
}

/** Which account a draft sends from by default, when there is a choice. */
export function setDefaultGmailAddress(basePath = process.cwd(), address) {
  const file = emailConfigPath(basePath);
  const stored = readJson(file, {});
  if (!gmailAccounts(basePath).some((account) => account.address === address)) {
    throw new Error(`${address} is not connected.`);
  }
  stored.defaultAddress = address;
  writeJson(file, stored);
  return { address };
}

// ---- the sign-in ------------------------------------------------------------

const base64url = (buffer) => Buffer.from(buffer).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Run one sign-in, end to end, and return the address that was connected.
 *
 * PKCE, because a desktop client's secret is public: the code that comes back
 * on the loopback is worthless to anyone who did not generate `verifier`, which
 * never leaves this process.
 *
 * The listener binds 127.0.0.1 on a port the OS picks. Google allows any
 * loopback port for a Desktop client without registering it, which is the only
 * reason this needs no per-machine setup.
 */
export async function connectGmail(basePath = process.cwd(), { timeoutMs = 300_000, onUrl } = {}) {
  const { clientId, clientSecret } = gmailClient(basePath);
  // Refuse BEFORE opening a consent screen. Walking somebody through Google's
  // sign-in and failing at the exchange is the worst order to discover this in.
  if (!clientId || !clientSecret) throw new Error(gmailStatus(basePath).setup);

  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  // Binds the callback to THIS sign-in. Without it any page that happened to
  // hit the loopback port with a `code` would be treated as the answer.
  const state = base64url(crypto.randomBytes(24));

  const server = http.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Without BOTH of these Google returns no refresh token on a repeat
    // sign-in, and the account silently stops working an hour later when the
    // access token expires.
    access_type: "offline",
    prompt: "consent",
    state
  }).toString();

  onUrl?.(url.toString());

  const code = await new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      server.close();
      fn(value);
    };
    const timer = setTimeout(
      () => done(reject, new Error("The Google sign-in window was not completed in time.")),
      timeoutMs
    );
    server.on("request", (request, response) => {
      const query = new URL(request.url, redirectUri).searchParams;
      const finish = (title, message) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
          "<body style=\"margin:0;display:grid;place-items:center;height:100vh;background:#07090e;color:#edf1f7;" +
          "font:15px/1.6 'Segoe UI',system-ui,sans-serif\"><div style=\"text-align:center;max-width:32ch\">" +
          `<h1 style="font-size:19px;font-weight:600">${title}</h1><p style="color:#8b98ad">${message}</p></div>`
        );
      };
      if (query.get("state") !== state) {
        finish("That didn't match", "This window did not belong to the sign-in SYSCORA started. Nothing was connected.");
        return;
      }
      const error = query.get("error");
      if (error) {
        finish("Not connected", "Google reported: " + error.replace(/[<>]/g, ""));
        done(reject, new Error(`Google returned "${error}".`));
        return;
      }
      const received = query.get("code");
      if (!received) return;
      finish("Connected", "SYSCORA can now send mail from this account. You can close this tab.");
      done(resolve, received);
    });
  });

  const tokens = await exchange({
    code, clientId, clientSecret, redirectUri, verifier
  });
  const address = await addressOf(tokens.access_token);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token, so the connection would expire in an hour. " +
      "Remove SYSCORA at myaccount.google.com/permissions and sign in again.");
  }

  // THE TOKEN GOES THROUGH DPAPI, NOT INTO email.json. A refresh token in a
  // JSON file is a refresh token in the next transcript that quotes that file —
  // the exact leak that moved the model keys, in a file that grants access to
  // somebody's mail.
  const reference = `dpapi:gmail-${base64url(crypto.randomBytes(9))}.bin`;
  await protectToFile(
    path.join(secretsDirectory(basePath), reference.slice("dpapi:".length)),
    tokens.refresh_token
  );

  const file = emailConfigPath(basePath);
  const stored = readJson(file, {});
  const list = Array.isArray(stored.accounts) && stored.accounts.length
    ? stored.accounts
    : (stored.account ? [stored.account] : []);
  // SIGNING IN TWICE AS THE SAME ADDRESS IS A REFRESH, NOT A SECOND ACCOUNT.
  // Google hands out a new refresh token every time `prompt=consent` is used,
  // so without this a re-connect after a revoke would leave two entries for one
  // mailbox and a picker with the same address in it twice.
  const without = list.filter((account) => account?.address !== address);
  stored.accounts = [...without, { address, refreshToken: reference, connectedAt: new Date().toISOString() }];
  delete stored.account;
  // The first account connected is the default; later ones do not steal it.
  if (!stored.defaultAddress || !stored.accounts.some((account) => account.address === stored.defaultAddress)) {
    stored.defaultAddress = stored.accounts[0].address;
  }
  writeJson(file, stored);
  return { address, accounts: gmailAccounts(basePath) };
}

async function exchange({ code, clientId, clientSecret, redirectUri, verifier }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(googleError(json, response.status));
  return json;
}

async function addressOf(accessToken) {
  const response = await fetch(USERINFO_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
  const json = await response.json().catch(() => ({}));
  return json?.email ?? "your Google account";
}

const googleError = (json, status) =>
  json?.error_description || json?.error?.message || json?.error || `Google returned HTTP ${status}.`;

/**
 * A usable access token for the connected account.
 *
 * Not cached across calls on purpose: a send happens once every few minutes at
 * most, the refresh is one request, and a token held in memory for an hour is a
 * token in a heap dump for an hour.
 */
async function accessToken(basePath, address = null) {
  const record = accountRecord(basePath, address);
  const reference = record?.refreshToken;
  if (!reference) {
    throw new Error(address
      ? `${address} is not connected to SYSCORA.`
      : "No Google account is connected.");
  }
  const refresh = isProtectedReference(reference)
    ? resolveProtectedValue(reference, { baseDirectory: secretsDirectory(basePath) })
    : reference;
  const { clientId, clientSecret } = gmailClient(basePath);
  const body = new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refresh });
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    // `invalid_grant` means the user revoked SYSCORA, or changed their password.
    // Saying "sign in again" is the whole fix, and it is not obvious from
    // Google's wording.
    if (json?.error === "invalid_grant") {
      throw new Error("Google no longer accepts this connection — it was revoked or the password changed. " +
        "Connect the account again.");
    }
    throw new Error(googleError(json, response.status));
  }
  return json.access_token;
}

// ---- the message ------------------------------------------------------------

/** RFC 2047, for a header that is not plain ASCII. */
const encodeHeader = (value) => {
  const text = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
};

/** Header injection is a newline. There is no legitimate one in an address. */
const oneLine = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

const base64Body = (text) => Buffer.from(String(text ?? ""), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");

/**
 * The message, as RFC 5322, base64url-encoded the way Gmail's API wants it.
 *
 * multipart/alternative, because the card offers bold, lists and links: a
 * recipient whose client shows plain text must still get a readable message
 * rather than a page of tags.
 */
export function buildMessage({ from, to = [], cc = [], bcc = [], subject = "", html = "", text = "" }) {
  const recipients = to.map(oneLine).filter(Boolean);
  if (recipients.length === 0) throw new Error("An email needs at least one recipient.");
  const copies = cc.map(oneLine).filter(Boolean);
  const blind = (Array.isArray(bcc) ? bcc : []).map(oneLine).filter(Boolean);
  const boundary = `syscora_${crypto.randomBytes(12).toString("hex")}`;
  const plain = text || htmlToText(html);

  // WHY THE Bcc HEADER IS WRITTEN INTO A MESSAGE THAT MUST NOT CARRY IT.
  //
  // `users.messages.send` takes a whole RFC 5322 message and derives the
  // envelope from its headers, so Gmail cannot deliver to a blind recipient it
  // was never told about — the header is the only channel there is. Gmail then
  // strips `Bcc` before delivery, which is the documented behaviour of that
  // endpoint and the same thing its own web composer does.
  //
  // That makes this ONE LINE the whole privacy guarantee of the feature: if
  // Gmail ever stopped stripping it, every recipient would see the blind list.
  // It is called out here rather than left as an ordinary header because it is
  // the only line in this file whose failure mode is silent and unrecoverable —
  // you cannot un-disclose an address. `tests/unit/email-draft.test.js` asserts
  // the header is present (or the copies never arrive) and that nothing else in
  // this codebase ever renders it back to a recipient.
  const headers = [
    `From: ${oneLine(from)}`,
    `To: ${recipients.join(", ")}`,
    copies.length ? `Cc: ${copies.join(", ")}` : null,
    blind.length ? `Bcc: ${blind.join(", ")}` : null,
    `Subject: ${encodeHeader(oneLine(subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean);

  const body = [
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(plain),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(html || escapeHtml(plain).replace(/\n/g, "<br>")),
    `--${boundary}--`,
    ""
  ];

  const raw = [...headers, ...body].join("\r\n");
  return { raw: base64url(Buffer.from(raw, "utf8")), recipients, copies, blind };
}

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Good enough for the alternative part: the card's HTML is our own. */
function htmlToText(html) {
  return String(html ?? "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Send it. Returns Gmail's own id for the message it created.
 *
 * That id is the RECEIPT: it comes back from Gmail's servers, not from this
 * process, and it is the difference between "the request returned" and "Gmail
 * accepted this message". Nothing here reports success without one — the same
 * rule every tool in this codebase is held to.
 */
export async function sendGmail(basePath, draft) {
  // WHICH MAILBOX, DECIDED HERE AND NOWHERE ELSE. The card names it explicitly
  // so the address on the card is the address it goes out as; a draft that does
  // not name one falls back to the default. An address that is not connected is
  // refused rather than quietly sent from a different one — sending as the
  // wrong person is the mail equivalent of the wrong-window bug this codebase
  // has fixed three times.
  const from = String(draft?.from ?? "").trim() || defaultGmailAddress(basePath);
  if (!from) throw new Error("No Google account is connected.");
  const known = gmailAccounts(basePath).some((account) => account.address === from);
  if (!known) throw new Error(`${from} is not connected to SYSCORA, so nothing was sent.`);
  const { raw, recipients, copies, blind } = buildMessage({ ...draft, from });
  const token = await accessToken(basePath, from);
  const response = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(googleError(json, response.status));
  if (!json?.id) throw new Error("Gmail accepted the request but returned no message id, so this is not confirmed sent.");
  // `bcc` is a COUNT and the addresses both, because the card has to be able to
  // say "and 3 blind copies" to the person who sent it — they are allowed to
  // see their own blind list, and they are the only one who is.
  return { id: json.id, threadId: json.threadId ?? null, from, to: recipients, cc: copies, bcc: blind };
}
