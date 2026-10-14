// VM-06: what the studio says about where work is kept matches each mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudioState } from "../src/lib/schema";
const { SettingsView, ViewHeading } =
  await import("../src/components/studio-views");
const { workspaceLabels } = await import("../src/components/studio-ui");

const settings = (
  more: Partial<StudioState["settings"]>,
): StudioState["settings"] => ({
  aiReady: true,
  model: "gpt-test",
  dailyLimit: 20,
  usedToday: 0,
  hosted: false,
  email: null,
  ...more,
});
// The settings page as plain text.
const page = (s: StudioState["settings"]) =>
  renderToStaticMarkup(createElement(SettingsView, { settings: s }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;/g, "’")
    .replace(/\s+/g, " ");

test("hosted settings describe Supabase storage, accounts and backups", () => {
  const text = page(settings({ hosted: true, email: "ana@example.com" }));
  assert.doesNotMatch(text, /this computer|SQLite|data\/|stopped/i);
  assert.match(text, /Private to your account/);
  assert.match(text, /Workspace access ana@example\.com/);
  assert.match(text, /Sign-in Email and password/);
  assert.match(text, /Supabase Postgres \+ private storage/);
  assert.match(text, /Backups Made by the studio’s operator in Supabase/);
  assert.match(text, /sent to OpenAI/);
  assert.match(text, /Hosted studios add accounts with email sign-in/);
  assert.doesNotMatch(text, /cloud authentication/i);
  // Hosted accounts can't edit the server's files.
  const noAi = page(settings({ hosted: true, aiReady: false }));
  assert.doesNotMatch(noAi, /\.env\.local|OPENAI_API_KEY|sent to OpenAI/);
  assert.match(noAi, /isn’t set up for this studio/);
});

test("local settings describe the data folder and embedded Postgres", () => {
  const text = page(settings({}));
  assert.match(text, /Local by design/);
  assert.match(text, /Workspace access This computer only/);
  assert.match(text, /PGlite \(embedded Postgres\) \+ local image files/);
  assert.match(text, /Backups Copy data\/ with the app stopped/);
  assert.doesNotMatch(text, /SQLite|cloud authentication/i);
  assert.match(page(settings({ aiReady: false })), /OPENAI_API_KEY/);
});

test("the sidebar and top bar labels follow the mode", () => {
  assert.deepEqual(workspaceLabels(true), {
    workspace: "Hosted workspace",
    note: "Saved privately to your account",
  });
  assert.deepEqual(workspaceLabels(false), {
    workspace: "Local workspace",
    note: "Saved on this computer",
  });
  // The settings subtitle is shown in both modes.
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(ViewHeading, { view: "Settings" })),
    /local|computer/i,
  );
  // The studio shell takes both labels from workspaceLabels.
  const shell = readFileSync("src/components/studio.tsx", "utf8");
  assert.match(shell, /workspaceLabels\(state\.settings\.hosted\)/);
  assert.doesNotMatch(shell, /stays on this computer|>Local workspace</);
});
