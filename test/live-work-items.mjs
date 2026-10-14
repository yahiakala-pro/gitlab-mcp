#!/usr/bin/env node
/**
 * Live-path coverage for the work-item tools this fork patches.
 *
 * Upstream zereight/gitlab-mcp had zero live coverage of these paths, which is
 * how the CE-vs-EE GraphQL schema drift landed silently (wayfinder map 77,
 * ticket 96). This suite drives the real server (`build/index.js`) as a stdio
 * MCP client against a real GitLab and exercises every patched tool end to
 * end, on a throwaway work item it deletes afterwards.
 *
 * Skips (exit 0) when GITLAB_PERSONAL_ACCESS_TOKEN (or GITLAB_TOKEN) or
 * TEST_PROJECT_ID is unset — same convention as `test:live`.
 *
 * Optional env:
 *   GITLAB_API_URL      — defaults to the server's own default (gitlab.com)
 *   TEST_PROJECT_ID     — project numeric ID or URL-encoded path
 *   TEST_ASSIGNEE       — username to exercise assignee_usernames (skipped if unset)
 *   TEST_LABEL          — label name to exercise add_labels (created+used if unset:
 *                         "mcp-live-test")
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOKEN = process.env.GITLAB_PERSONAL_ACCESS_TOKEN || process.env.GITLAB_TOKEN;
const PROJECT = process.env.TEST_PROJECT_ID;

if (!TOKEN || !PROJECT) {
  console.log("live work-item tests: skipped (no token or TEST_PROJECT_ID)");
  process.exit(0);
}

const API_URL = process.env.GITLAB_API_URL; // undefined => server default
const LABEL = process.env.TEST_LABEL || "mcp-live-test";
const ASSIGNEE = process.env.TEST_ASSIGNEE;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  env: {
    ...process.env,
    GITLAB_PERSONAL_ACCESS_TOKEN: TOKEN,
    ...(API_URL ? { GITLAB_API_URL: API_URL } : {}),
    // expose the work-items toolset this suite covers (matches the gateway's
    // GITLAB_TOOLS-based deployment, which whitelists these same tools)
    GITLAB_TOOLSETS: "workitems",
  },
});
const client = new Client({ name: "live-work-items-test", version: "0.0.0" });

let failures = 0;
const pass = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { failures += 1; console.error(`  FAIL: ${m}`); };
const j = (r) => JSON.parse(r.content?.[0]?.text ?? "null");
const bad = (r) => r.isError === true || Array.isArray(r.content) === false;

let created = null;

try {
  await client.connect(transport);
  console.log("live work-item tests: against", API_URL || "server default", "project", PROJECT);

  // tools/list: the patched tools must be exposed
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const n of [
    "create_work_item", "get_work_item", "list_work_items", "update_work_item",
    "delete_work_item", "list_work_item_emoji_reactions",
  ]) {
    (names.has(n) ? pass : fail)(`tools/list has ${n}`);
  }
  for (const n of [
    "list_work_item_statuses", "list_custom_field_definitions",
    "list_work_item_note_emoji_reactions",
    "create_work_item_note_emoji_reaction",
    "delete_work_item_note_emoji_reaction",
  ]) {
    (names.has(n) ? fail : pass)(`tools/list no longer exposes ${n} (CE-dead, trimmed)`);
  }

  // create: throwaway task
  let r = await client.callTool({ name: "create_work_item", arguments: {
    project_id: PROJECT, title: "live-work-items throwaway", type: "task",
    description: "throwaway for the live-path suite — deleted at the end",
    labels: [LABEL],
  } });
  if (bad(r)) { fail(`create_work_item: ${j(r)}`); throw new Error("cannot continue"); }
  created = j(r);
  pass(`create_work_item -> #${created.iid} (${created.id})`);

  // update: title, description, label add, assignee, close, reopen
  r = await client.callTool({ name: "update_work_item", arguments: {
    project_id: PROJECT, iid: created.iid,
    title: "live-work-items throwaway (mutated)",
    description: "mutated body",
    add_labels: [LABEL], state_event: "close",
    ...(ASSIGNEE ? { assignee_usernames: [ASSIGNEE] } : {}),
  } });
  if (bad(r)) fail(`update_work_item sink: ${JSON.stringify(j(r)).slice(0, 300)}`);
  else pass("update_work_item sink (title/description/labels/state)");

  // get: readback (the broken-on-CE tool, now patched)
  r = await client.callTool({ name: "get_work_item", arguments: {
    project_id: PROJECT, iid: created.iid,
  } });
  if (bad(r)) fail(`get_work_item: ${JSON.stringify(j(r)).slice(0, 300)}`);
  else {
    const wi = j(r);
    const ok =
      wi.title === "live-work-items throwaway (mutated)" &&
      (wi.state === "closed" || wi.state === "CLOSED") &&
      String(wi.description).includes("mutated body");
    (ok ? pass : fail)(`get_work_item readback (title/state/description)`);
  }

  // list: find it by search
  r = await client.callTool({ name: "list_work_items", arguments: {
    project_id: PROJECT, search: "live-work-items throwaway", state: "closed",
  } });
  if (bad(r)) fail(`list_work_items: ${JSON.stringify(j(r)).slice(0, 300)}`);
  else {
    const nodes = Array.isArray(j(r)) ? j(r) : (j(r).items ?? j(r).nodes ?? j(r));
    const hit = Array.isArray(nodes) && nodes.some((n) => String(n.iid) === String(created.iid));
    (hit ? pass : fail)("list_work_items finds the throwaway (search+state filter)");
  }

  // emoji: add, list (the patched widget path), delete
  r = await client.callTool({ name: "create_work_item_emoji_reaction", arguments: {
    project_id: PROJECT, iid: created.iid, name: "rocket",
  } });
  (bad(r) ? fail : pass)(`create_work_item_emoji_reaction rocket`);

  r = await client.callTool({ name: "list_work_item_emoji_reactions", arguments: {
    project_id: PROJECT, iid: created.iid,
  } });
  if (bad(r)) fail(`list_work_item_emoji_reactions: ${JSON.stringify(j(r)).slice(0, 300)}`);
  else {
    const list = j(r);
    const has = Array.isArray(list) && list.some((e) => e.name === "rocket");
    (has ? pass : fail)("list_work_item_emoji_reactions sees rocket (widget path)");
  }

  await client.callTool({ name: "delete_work_item_emoji_reaction", arguments: {
    project_id: PROJECT, iid: created.iid, name: "rocket",
  } });

  // delete: the throwaway goes away
  r = await client.callTool({ name: "delete_work_item", arguments: {
    project_id: PROJECT, iid: created.iid,
  } });
  (bad(r) ? fail : pass)("delete_work_item");

  // verify: get should now fail (404 path — SDK throws on MCP tool errors)
  let goneOk = false;
  try {
    r = await client.callTool({ name: "get_work_item", arguments: {
      project_id: PROJECT, iid: created.iid,
    } });
    const body = j(r);
    goneOk = bad(r) || body?.error || body?.workItem === null || body?.workItem === undefined;
  } catch (e) {
    goneOk = String(e?.message ?? e).includes("not found");
  }
  (goneOk ? pass : fail)("get_work_item after delete (404 path)");
  created = null;
} catch (e) {
  fail(`unexpected: ${e?.message ?? e}`);
} finally {
  // last-resort cleanup so a failed run never leaves the throwaway behind
  if (created) {
    try {
      await client.callTool({ name: "delete_work_item", arguments: {
        project_id: PROJECT, iid: created.iid,
      } });
      console.log("  (cleanup: throwaway deleted after failure)");
    } catch { /* best effort */ }
  }
  try { await client.close(); } catch { /* best effort */ }
}

console.log(failures === 0 ? "live work-item tests: ALL PASS" : `live work-item tests: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);