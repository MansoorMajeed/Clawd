#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const endpoint = "http://localhost:9222/json/version";
const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = join(homedir(), ".cache", "agent-web", "chrome-profile");

export function buildChromeArgs(dedicatedProfileDir) {
  return [
    "-n",
    "-a",
    "Google Chrome",
    "--args",
    "--remote-debugging-port=9222",
    `--user-data-dir=${dedicatedProfileDir}`,
    "--profile-directory=Default",
    "--disable-search-engine-choice-screen",
    "--no-first-run",
  ];
}

function hasCommandArgument(command, argument) {
  const index = command.indexOf(argument);
  if (index === -1) return false;
  const before = command[index - 1];
  const after = command[index + argument.length];
  return (!before || /\s/.test(before)) && (!after || /\s/.test(after));
}

function isDedicatedChromeCommand(command, dedicatedProfileDir) {
  if (
    command !== chromeExecutable &&
    !command.startsWith(`${chromeExecutable} `)
  ) {
    return false;
  }
  return hasCommandArgument(
    command,
    `--user-data-dir=${dedicatedProfileDir}`,
  );
}

export function classifyListenerCommands(commands, dedicatedProfileDir) {
  if (commands.length === 0) return "free";
  return commands.every((command) =>
    isDedicatedChromeCommand(command, dedicatedProfileDir)
  )
    ? "dedicated"
    : "foreign";
}

function listenerCommands() {
  let output;
  try {
    output = execFileSync(
      "lsof",
      ["-nP", "-t", "-iTCP:9222", "-sTCP:LISTEN"],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (error.status === 1 && !error.stderr?.trim()) return [];
    throw new Error(`Failed to inspect port 9222: ${error.message}`);
  }

  const pids = [...new Set(output.trim().split(/\s+/).filter(Boolean))];
  return pids.map((pid) => {
    try {
      return execFileSync("ps", ["-ww", "-p", pid, "-o", "command="], {
        encoding: "utf8",
      }).trim();
    } catch (error) {
      throw new Error(`Failed to inspect process ${pid}: ${error.message}`);
    }
  });
}

function portOwner() {
  return classifyListenerCommands(listenerCommands(), profileDir);
}

function assertSafeOwner(owner) {
  if (owner === "foreign") {
    throw new Error(
      "Port 9222 is used by another process or Chrome profile; refusing to attach",
    );
  }
}

async function isCdpReady() {
  try {
    const response = await fetch(endpoint);
    if (!response.ok) return false;
    const version = await response.json();
    return typeof version.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

async function hasDedicatedConnection() {
  const ownerBefore = portOwner();
  assertSafeOwner(ownerBefore);
  if (ownerBefore !== "dedicated") return false;

  const ready = await isCdpReady();
  const ownerAfter = portOwner();
  assertSafeOwner(ownerAfter);
  return ready && ownerAfter === "dedicated";
}

async function main() {
  if (process.argv[2]) {
    console.log("Usage: start.js");
    console.log("\nStarts Chrome with a persistent, dedicated automation profile.");
    process.exitCode = 1;
    return;
  }

  const initialOwner = portOwner();
  assertSafeOwner(initialOwner);

  let connected = await hasDedicatedConnection();
  let started = false;

  if (!connected && initialOwner === "free") {
    mkdirSync(profileDir, { recursive: true });
    spawn("open", buildChromeArgs(profileDir), {
      detached: true,
      stdio: "ignore",
    }).unref();
    started = true;
  }

  for (let i = 0; !connected && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    connected = await hasDedicatedConnection();
  }

  if (!connected) {
    throw new Error("Failed to connect to dedicated Chrome");
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const watcherPath = join(scriptDir, "watch.js");
  spawn(process.execPath, [watcherPath], {
    detached: true,
    stdio: "ignore",
  }).unref();

  console.log(
    `✓ Chrome ${started ? "started" : "already running"} on :9222 with dedicated profile`,
  );
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
