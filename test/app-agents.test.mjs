import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render, cleanup } from "ink-testing-library";

// Drives the real App against the bundled mock server's scripted agent
// scenarios (see mock/server.mjs → agentScenario).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-app-agents-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-app-work-"));
fs.writeFileSync(path.join(work, "calc.py"), "def add(a,b):\n    return a-b\n");
const port = 18_000 + Math.floor(Math.random() * 2000);
process.env.UNJAILED_HOME = home;
process.env.UNJAILED_API_KEY = "sk-mock-test-a1b2";
process.env.UNJAILED_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.UNJAILED_MODEL = "glm-5.3";
process.env.UNJAILED_NO_FX = "1";
process.env.NO_COLOR = "1";

const mock = spawn(process.execPath, [path.resolve("mock/server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => mock.stdout.once("data", resolve));

const { App } = await import("../dist/ui/App.js");
const { writeConfig } = await import("../dist/config.js");
process.chdir(work);

test.after(() => {
  cleanup(); // unmounting also stops any turn still running
  mock.kill();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (ui) => ui.frames.join("\n");
async function waitFor(ui, pattern, label, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pattern.test(all(ui))) return;
    await sleep(40);
  }
  assert.fail(`Timed out waiting for ${label}\n--- last frame ---\n${ui.lastFrame()}`);
}
async function type(ui, text) {
  ui.stdin.write(text);
  await sleep(60);
  ui.stdin.write("\r");
  await sleep(60);
}

test("workflow tool: asks permission in cmds mode, then runs parallel and schema agents", async () => {
  writeConfig({ tools: "cmds", plan: false, autoMode: "ask", fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:workflow review please");
    await waitFor(ui, /Permission needed[\s\S]*Workflow\(mock-review\)[\s\S]*Two reviewers in parallel/, "workflow approval with its description");
    await waitFor(ui, /Waiting for your approval/, "the activity bar shows the approval wait");
    await sleep(200);
    ui.stdin.write("y");
    await waitFor(ui, /Done \(3 agents/, "workflow block with agent stats");
    await waitFor(ui, /Worked for/, "turn summary");
    assert.match(all(ui), /mock-review: reports: 2/, "workflow log lines are shown");
    // The model receives the full result (the transcript shows a one-line preview).
    const { listSessions, loadSession } = await import("../dist/sessions.js");
    const saved = loadSession(listSessions()[0].id);
    const wf = saved.toolHistory.find((e) => e.name === "workflow");
    assert.equal(wf.ok, true);
    assert.deepEqual(JSON.parse(wf.output.split("Result:\n")[1].split("\n\nLog:")[0]).verdict, { ok: true, count: 2 }, "the schema agent's JSON is parsed into the result");
  } finally { ui.unmount(); }
});

test("declining a workflow runs nothing and tells the model", async () => {
  writeConfig({ tools: "cmds", plan: false, autoMode: "ask", fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:workflow again");
    await waitFor(ui, /Permission needed/, "approval");
    await sleep(200);
    ui.stdin.write("n");
    await waitFor(ui, /Worked for/, "turn end");
    assert.match(all(ui), /declined the workflow/);
    assert.doesNotMatch(all(ui), /Done \(3 agents/);
  } finally { ui.unmount(); }
});

test("parallel subagents show live in the activity panel and report with stats", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:agents split it");
    await waitFor(ui, /Inspect left side[\s\S]*Inspect right side/, "both subagents in the live panel");
    await waitFor(ui, /Worked for/, "turn end");
    const out = all(ui);
    assert.equal(out.match(/Done \(1 tool use/g)?.length >= 2, true, "each Agent block has its stats");
    assert.match(out, /Both subagents reported back/);
  } finally { ui.unmount(); }
});

test("/goal keeps working until the evaluator says the goal is met", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "/goal mock:goal finish everything");
    await waitFor(ui, /Goal set/, "goal acknowledged");
    await waitFor(ui, /Goal met after 3 turns/, "goal reached after two continuations", 20_000);
    const out = all(ui);
    assert.equal(out.match(/Goal not met yet/g)?.length, 2);
    await type(ui, "/goal");
    await waitFor(ui, /No goal set/, "goal cleared once met");
  } finally { ui.unmount(); }
});

test("a message typed while the agent works is delivered at its next step", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:edit fix calc");
    await sleep(80);
    await type(ui, "also keep the old name");
    await waitFor(ui, /Sent to the agent/, "mid-turn acknowledgement");
    await waitFor(ui, /Delivered to the agent mid-turn/, "delivery at the next tool step");
    await waitFor(ui, /Worked for/, "turn end");
    assert.equal(fs.readFileSync(path.join(work, "calc.py"), "utf8"), "def add(a,b):\n    return a+b\n");
    assert.doesNotMatch(all(ui), /Queued — runs when this turn ends/);
  } finally { ui.unmount(); }
});

test("an outage is ridden out with a visible countdown and the turn completes", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:outage are you there");
    await waitFor(ui, /retrying automatically/, "outage notice");
    await waitFor(ui, /Reconnecting…[\s\S]*retrying in/, "live retry countdown");
    await waitFor(ui, /Reconnected — continuing[\s\S]*Recovered after the outage[\s\S]*Worked for/, "recovery", 20_000);
  } finally { ui.unmount(); }
});

test("commands queued during a turn don't strand the messages queued after them", async () => {
  writeConfig({ tools: "off", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "markdown please");
    await sleep(100);
    await type(ui, "/effort low");
    await type(ui, "second message");
    await waitFor(ui, /Queued — runs when this turn ends[\s\S]*Queued — runs when this turn ends/, "both queued");
    await waitFor(ui, /Effort set to low/, "queued command ran", 30_000);
    await waitFor(ui, /You said: "second message"[\s\S]*Worked for/, "the message behind it ran too", 30_000);
  } finally { ui.unmount(); writeConfig({ effort: "auto" }); }
});
