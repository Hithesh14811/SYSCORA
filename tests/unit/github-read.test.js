// READING A REPOSITORY INSTEAD OF DOWNLOADING IT.
//
// Live, 24 Aug 2026: the user pasted a GitHub URL and the agent ran `git clone`.
// That was the rational move, because both machine-readable routes were shut —
// measured the same day:
//
//   github.com/nodejs/node                   200  text/html         583,751 bytes
//   api.github.com/repos/nodejs/node         200  application/json    5,945 bytes
//   raw.githubusercontent.com/.../README.md  200  text/plain         41,700 bytes
//
// web-page.js allows html/xhtml/plain/xml only, so the API answered "that URL is
// application/json, not a web page"; and the HTML page, read through this
// project's own reader, is 6,503 characters of "Skip to content / You signed in
// with another tab or window" with no file contents in it at all.
//
// The network is stubbed here so the paths that matter — a rate limit, a private
// repository, a gateway blip, a truncated tree — can be made to happen on
// demand. The live round trip is covered by tool-evidence.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TREE_ENTRIES,
  parseRepoReference,
  readFile,
  readReadme,
  readRepository,
  readTree
} from "../../packages/fast-agent/src/github.js";

const respond = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url: "https://api.github.com/stub",
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body))
});

/** A fetch that answers from a table and records what it was asked for. */
function stub(table) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    for (const [pattern, answer] of table) {
      if (String(url).includes(pattern)) return typeof answer === "function" ? answer(String(url)) : answer;
    }
    return respond("not found", { status: 404 });
  };
  fetchImpl.asked = asked;
  return fetchImpl;
}

// A /blob/ URL naming one file is the most common paste there is, and it has to
// land on that file rather than on the repository's front page.
test("every shape a person pastes resolves to the same repository", () => {
  const cases = [
    ["https://github.com/nodejs/node", { owner: "nodejs", repo: "node", ref: null, path: null, kind: "repo" }],
    ["https://www.github.com/nodejs/node/", { owner: "nodejs", repo: "node", ref: null, path: null, kind: "repo" }],
    ["https://github.com/nodejs/node.git", { owner: "nodejs", repo: "node", ref: null, path: null, kind: "repo" }],
    ["nodejs/node", { owner: "nodejs", repo: "node", ref: null, path: null, kind: "repo" }],
    ["github.com/nodejs/node/pull/12345", { owner: "nodejs", repo: "node", ref: null, path: null, kind: "repo" }],
    ["https://github.com/nodejs/node/blob/main/README.md",
      { owner: "nodejs", repo: "node", ref: "main", path: "README.md", kind: "file" }],
    ["https://github.com/nodejs/node/tree/v20.x/lib",
      { owner: "nodejs", repo: "node", ref: "v20.x", path: "lib", kind: "tree" }],
    ["https://raw.githubusercontent.com/nodejs/node/main/lib/fs.js",
      { owner: "nodejs", repo: "node", ref: "main", path: "lib/fs.js", kind: "file" }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseRepoReference(input), expected, input);
  }
  for (const notARepo of ["https://example.com/foo", "https://gitlab.com/a/b", "", null, "just some words"]) {
    assert.equal(parseRepoReference(notARepo), null, String(notARepo));
  }
});

// THE WHOLE POINT OF THE TREE ENDPOINT. One request returns every path, and an
// alphabetical listing of a real project is `.git` hashes and `node_modules`
// until it runs out of room — so the model is shown the files somebody WROTE.
test("the file tree leaves out machinery, and says how much it left out", async () => {
  const tree = [
    { type: "blob", path: "README.md", size: 100 },
    { type: "blob", path: "src/index.js", size: 200 },
    { type: "blob", path: "src/deep/nested/thing.js", size: 50 },
    { type: "tree", path: "src" },
    { type: "blob", path: "node_modules/left-pad/index.js", size: 10 },
    { type: "blob", path: ".git/objects/aa/bb", size: 10 },
    { type: "blob", path: "dist/bundle.js", size: 900 },
    { type: "blob", path: "__pycache__/x.cpython-310.pyc", size: 10 }
  ];
  const result = await readTree({ owner: "o", repo: "r", ref: "main" }, {
    fetchImpl: stub([["git/trees", respond({ tree, truncated: false })]])
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => entry.path),
    ["README.md", "src/index.js", "src/deep/nested/thing.js"],
    "only the files somebody wrote, shallowest first");
  assert.equal(result.fileCount, 7, "the count is still every file — that is a real fact about the repository");
  assert.equal(result.machinery, 4, "what was left out has to be countable, or the listing reads as complete");
  assert.equal(result.mostly[0].extension, "js");
});

// GitHub says so itself when a repository is too big for one request. A
// truncated tree presented as a whole one is a lie about the project.
test("a truncated tree says it is truncated", async () => {
  const many = Array.from({ length: MAX_TREE_ENTRIES + 40 }, (unused, index) => ({
    type: "blob", path: `src/file-${index}.js`, size: 10
  }));
  const result = await readTree({ owner: "o", repo: "r" }, {
    fetchImpl: stub([["git/trees", respond({ tree: many, truncated: true })]])
  });
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, MAX_TREE_ENTRIES);
  assert.equal(result.omitted, 40);
});

// "Could not read the repository" is the wrong answer to "you have used your 60
// requests this hour": it sends the agent looking for another route when the
// only useful thing is a time.
test("a rate limit is reported as a rate limit, with when it lifts", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 1800;
  const result = await readRepository({ owner: "o", repo: "r" }, {
    fetchImpl: stub([["/repos/", respond("rate limited", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }
    })]])
  });
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
  assert.match(result.reason, /rate limit/i);
  assert.match(result.reason, /60 requests an hour/, "without a token, say what the limit actually is");
  assert.match(result.reason, /\d{1,2}[:.]\d{2}/, "a reset with no time in it is not actionable");
  assert.match(result.reason, /Nothing is wrong with the repository/);
});

// Private and missing look identical without a token, and the next move differs.
test("a 404 says it might be private rather than pretending to know", async () => {
  const result = await readRepository({ owner: "o", repo: "r" }, {
    fetchImpl: stub([["/repos/", respond("{}", { status: 404 })]])
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /private/);
  assert.match(result.reason, /no GitHub token/);
});

// Measured while building this: api.github.com answered 504 to /repos for
// several minutes while raw.githubusercontent.com served everything. Reporting
// that as a broken repository sends the agent hunting for another route.
test("a gateway blip is retried once, then reported as GitHub's problem", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return calls === 1 ? respond("bad gateway", { status: 504 }) : respond({ full_name: "o/r", default_branch: "main" });
  };
  const recovered = await readRepository({ owner: "o", repo: "r" }, { fetchImpl: flaky });
  assert.equal(recovered.ok, true, "one retry has to be enough for a blip");
  assert.equal(calls, 2);

  const downForGood = await readRepository({ owner: "o", repo: "r" }, {
    fetchImpl: stub([["/repos/", respond("bad gateway", { status: 504 })]])
  });
  assert.equal(downForGood.ok, false);
  assert.match(downForGood.reason, /GitHub itself/, "do not blame the repository for GitHub being down");
  assert.match(downForGood.reason, /try again shortly/);
});

// raw.githubusercontent.com is text/plain and costs no API quota — it is the
// door that was open all along and nothing told the model it was there.
test("a file comes back as its exact bytes, from raw, and says when it was clipped", async () => {
  const fetchImpl = stub([["raw.githubusercontent.com", respond("line one\nline two\n")]]);
  const file = await readFile({ owner: "o", repo: "r", ref: "main", path: "src/a.js" }, { fetchImpl });
  assert.equal(file.ok, true);
  assert.equal(file.text, "line one\nline two\n");
  assert.equal(file.truncated, false);
  assert.match(fetchImpl.asked[0], /^https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/src\/a\.js$/,
    "a file must not be fetched through the API — it costs quota and arrives base64");

  const huge = stub([["raw.githubusercontent.com", respond("x".repeat(200_000))]]);
  const clipped = await readFile({ owner: "o", repo: "r", ref: "main", path: "big.js" }, { fetchImpl: huge });
  assert.equal(clipped.truncated, true, "silence here reads as 'the file is this short'");
  assert.equal(clipped.bytes, 200_000);
});

// Some proxies answer the raw accept header with the JSON envelope anyway, and
// base64 in the transcript helps nobody.
test("a README arrives as text whichever way GitHub sends it", async () => {
  const plain = await readReadme({ owner: "o", repo: "r" }, {
    fetchImpl: stub([["/readme", respond("# Title\n\nbody")]])
  });
  assert.equal(plain.text, "# Title\n\nbody");

  const wrapped = await readReadme({ owner: "o", repo: "r" }, {
    fetchImpl: stub([["/readme", respond({ encoding: "base64", content: Buffer.from("# Title").toString("base64") })]])
  });
  assert.equal(wrapped.text, "# Title");
});
