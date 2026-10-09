import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import test, { before, after } from "node:test";
import { decode, encode } from "@msgpack/msgpack";

// CURSOR_TEST_URL can target the deployed Worker after cutover, using an
// isolated room per test run. Otherwise start an isolated local runtime.
const base = process.env.CURSOR_TEST_URL || "http://localhost:8799";
const from = "https://ankeshbharti.com/";
const room = `migration-test-${crypto.randomUUID()}`;
let worker;
let workerLog = "";
before(async () => {
  if (process.env.CURSOR_TEST_URL) return;
  worker = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", "8799", "--inspector-port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [worker.stdout, worker.stderr]) stream.on("data", (data) => { workerLog += data; });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    if (worker.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Worker did not start: ${workerLog}`);
});
after(() => { worker?.kill("SIGTERM"); });

function connect(id, path = `/parties/main/${room}`) {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ _pk: id, from, name: id, color: "#0000f0" }).toString();
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const messages = [];
  ws.addEventListener("message", (event) => messages.push(decode(new Uint8Array(event.data))));
  return {
    ws,
    async waitFor(predicate) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index !== -1) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${id}: ${JSON.stringify(messages)}`);
    },
  };
}

test("serves the portable client and health endpoint", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const response = await fetch(`${base}/cursors.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, /currentScript/);
  assert.doesNotMatch(source, /\.partykit\.dev/);
});

test("syncs two clients, binary cursor/chat updates, room isolation and disconnects", async (t) => {
  const first = connect("first");
  t.after(() => first.ws.close());
  const firstSync = await first.waitFor((m) => m.type === "sync");
  assert.ok(firstSync.users.first);

  const second = connect("second");
  t.after(() => second.ws.close());
  const secondSync = await second.waitFor((m) => m.type === "sync");
  assert.deepEqual(Object.keys(secondSync.users).sort(), ["first", "second"]);

  const presence = { name: "Second", color: "#123456", cursor: { x: 20, y: 40, pointer: "mouse" }, message: "hello" };
  second.ws.send("{invalid json");
  second.ws.send(encode({ type: "update", presence }));
  const update = await first.waitFor((m) => m.presence?.second?.message === "hello");
  assert.deepEqual(update.presence.second, presence);

  const isolated = connect("isolated", `/parties/main/${room}-other`);
  t.after(() => isolated.ws.close());
  const isolatedSync = await isolated.waitFor((m) => m.type === "sync");
  assert.deepEqual(Object.keys(isolatedSync.users), ["isolated"]);

  const legacy = connect("legacy", `/party/${room}`);
  t.after(() => legacy.ws.close());
  const legacySync = await legacy.waitFor((m) => m.type === "sync");
  assert.ok(legacySync.users.first);

  const snapshot = await (await fetch(`${base}/parties/main/${room}`)).json();
  assert.equal(snapshot.users.second.presence.message, "hello");

  second.ws.close();
  await first.waitFor((m) => m.remove?.includes("second"));
});

test("rejects disallowed websites and malformed page URLs before upgrading", { skip: base.startsWith("https:") }, async () => {
  for (const [page, expected] of [["https://unrelated.example/", 403], ["invalid", 400]]) {
    const url = new URL(`/parties/main/${room}?from=${encodeURIComponent(page)}`, base);
    const status = await new Promise((resolve, reject) => {
      const req = request(url, { headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("upgrade", (_, socket) => { socket.destroy(); reject(new Error("Unexpected upgrade")); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, expected);
  }
});
