#!/usr/bin/env node

/**
 * Extract session transcript from Claude Code, Pi, or Codex session files.
 *
 * Usage:
 *   ./extract-session.js [session-path]
 *   ./extract-session.js --agent claude|pi|codex [--cwd /path/to/dir]
 *
 * If no arguments, uses PI_SESSION_FILE when available, then selects the
 * newest session for the current working directory across supported agents.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
let sessionPath = null;
let agent = null;
let cwd = process.cwd();
let explicitCwd = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) {
    agent = args[++i];
  } else if (args[i] === '--cwd' && args[i + 1]) {
    cwd = args[++i];
    explicitCwd = true;
  } else if (!args[i].startsWith('-')) {
    sessionPath = args[i];
  }
}

const supportedAgents = new Set(['claude', 'pi', 'codex']);
if (agent && !supportedAgents.has(agent)) {
  console.error(`Unknown agent: ${agent}`);
  process.exit(1);
}

function encodeCwd(targetCwd, style) {
  if (style === 'pi') {
    return `--${targetCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  }
  return targetCwd.replace(/\//g, '-');
}

function findMostRecentSession(dir) {
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => {
      const session = path.join(dir, file);
      return { path: session, mtime: fs.statSync(session).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return files[0] || null;
}

function findCodexSession(targetCwd) {
  const baseDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(baseDir)) return null;

  const allSessions = [];
  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        allSessions.push({ path: fullPath, mtime: fs.statSync(fullPath).mtimeMs });
      }
    }
  }

  walkDir(baseDir);
  allSessions.sort((a, b) => b.mtime - a.mtime);

  for (const session of allSessions.slice(0, 50)) {
    try {
      const firstLine = fs.readFileSync(session.path, 'utf8').split('\n')[0];
      const data = JSON.parse(firstLine);
      if (data.payload?.cwd === targetCwd) return session;
    } catch {
      // Skip invalid files.
    }
  }

  return null;
}

function findSessionForAgent(selectedAgent, targetCwd) {
  if (selectedAgent === 'claude') {
    return findMostRecentSession(
      path.join(os.homedir(), '.claude', 'projects', encodeCwd(targetCwd, 'claude')),
    );
  }
  if (selectedAgent === 'pi') {
    return findMostRecentSession(
      path.join(os.homedir(), '.pi', 'agent', 'sessions', encodeCwd(targetCwd, 'pi')),
    );
  }
  return findCodexSession(targetCwd);
}

function autoDetectSession(targetCwd) {
  const candidates = ['claude', 'pi', 'codex']
    .map((candidateAgent) => {
      const session = findSessionForAgent(candidateAgent, targetCwd);
      return session ? { agent: candidateAgent, ...session } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) return null;
  return { ...candidates[0], selection: 'newest fallback for cwd' };
}

function inferAgent(file) {
  if (file.includes(`${path.sep}.claude${path.sep}`)) return 'claude';
  if (file.includes(`${path.sep}.pi${path.sep}`)) return 'pi';
  if (file.includes(`${path.sep}.codex${path.sep}`)) return 'codex';

  try {
    const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').find(Boolean));
    if (first.type === 'session' && typeof first.version === 'number') return 'pi';
    if (first.type === 'response_item') return 'codex';
  } catch {
    // Preserve the previous fallback for unknown files.
  }
  return 'claude';
}

function parseLines(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip invalid lines.
    }
  }
  return entries;
}

function parseClaudeSession(content) {
  const messages = [];
  for (const entry of parseLines(content)) {
    if (entry.message?.role && entry.message?.content) {
      messages.push({
        role: entry.message.role,
        content: extractContent(entry.message.content),
        timestamp: entry.timestamp,
      });
    }
  }
  return messages;
}

function activePiEntries(entries) {
  const treeEntries = entries.filter((entry) => entry.id && 'parentId' in entry);
  if (treeEntries.length === 0) return entries;

  const byId = new Map(treeEntries.map((entry) => [entry.id, entry]));
  const branch = [];
  const visited = new Set();
  let entry = treeEntries.at(-1);

  while (entry && !visited.has(entry.id)) {
    branch.push(entry);
    visited.add(entry.id);
    entry = entry.parentId ? byId.get(entry.parentId) : null;
  }

  return branch.reverse();
}

function parsePiSession(content) {
  const messages = [];
  const entries = activePiEntries(parseLines(content));

  for (const entry of entries) {
    if (entry.type === 'message' && entry.message?.role) {
      messages.push({
        role: entry.message.role,
        content: extractContent(entry.message.content),
        timestamp: entry.timestamp,
      });
    } else if (entry.type === 'branch_summary' && entry.summary) {
      messages.push({ role: 'branchSummary', content: entry.summary, timestamp: entry.timestamp });
    } else if (entry.type === 'compaction' && entry.summary) {
      messages.push({ role: 'compactionSummary', content: entry.summary, timestamp: entry.timestamp });
    } else if (entry.type === 'custom_message' && entry.content) {
      messages.push({
        role: `custom:${entry.customType || 'unknown'}`,
        content: extractContent(entry.content),
        timestamp: entry.timestamp,
      });
    }
  }

  return messages;
}

function parseCodexSession(content) {
  const messages = [];
  for (const entry of parseLines(content)) {
    if (entry.type === 'response_item' && entry.payload?.role) {
      messages.push({
        role: entry.payload.role,
        content: extractContent(entry.payload.content),
        timestamp: entry.timestamp,
      });
    }
  }
  return messages;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item.type === 'text' || item.type === 'input_text') {
      parts.push(item.text);
    } else if (item.type === 'tool_use') {
      parts.push(`[Tool: ${item.name}]\n${JSON.stringify(item.input, null, 2)}`);
    } else if (item.type === 'toolCall') {
      parts.push(`[Tool: ${item.name}]\n${JSON.stringify(item.arguments, null, 2)}`);
    } else if (item.type === 'tool_result') {
      const result = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
      const truncated = result.length > 500 ? `${result.slice(0, 500)}\n[... truncated ...]` : result;
      parts.push(`[Tool Result]\n${truncated}`);
    } else if (item.type === 'thinking') {
      parts.push(`[Thinking]\n${item.thinking}`);
    } else {
      parts.push(`[${item.type}]`);
    }
  }

  return parts.join('\n');
}

function formatTranscript(messages, maxMessages = 100) {
  const recent = messages.slice(-maxMessages);
  const lines = [];

  for (const message of recent) {
    const role = message.role.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
    lines.push(`\n### ${role}:\n`);
    lines.push(message.content);
  }

  if (messages.length > maxMessages) {
    lines.unshift(`\n[... ${messages.length - maxMessages} earlier messages omitted ...]\n`);
  }

  return lines.join('\n');
}

async function main() {
  let result;

  if (sessionPath) {
    if (!fs.existsSync(sessionPath)) {
      console.error(`Session file not found: ${sessionPath}`);
      process.exit(1);
    }
    result = {
      agent: agent || inferAgent(sessionPath),
      path: sessionPath,
      selection: 'explicit path',
    };
  } else if (agent) {
    const session = findSessionForAgent(agent, cwd);
    if (!session) {
      console.error(`No ${agent} session found for: ${cwd}`);
      process.exit(1);
    }
    result = { agent, path: session.path, selection: `explicit agent (${agent})` };
  } else if (!explicitCwd && process.env.PI_SESSION_FILE && fs.existsSync(process.env.PI_SESSION_FILE)) {
    result = {
      agent: 'pi',
      path: process.env.PI_SESSION_FILE,
      selection: 'current PI_SESSION_FILE',
    };
  } else {
    result = autoDetectSession(cwd);
    if (!result) {
      console.error(`No session found for: ${cwd}`);
      console.error('Try specifying --agent claude|pi|codex or provide a session path directly.');
      process.exit(1);
    }
  }

  const content = fs.readFileSync(result.path, 'utf8');
  let messages;
  if (result.agent === 'claude') messages = parseClaudeSession(content);
  if (result.agent === 'pi') messages = parsePiSession(content);
  if (result.agent === 'codex') messages = parseCodexSession(content);

  console.log('# Session Transcript');
  console.log(`Agent: ${result.agent}`);
  console.log(`Selection: ${result.selection}`);
  console.log(`File: ${result.path}`);
  console.log(`Messages: ${messages.length}`);
  console.log('');
  console.log(formatTranscript(messages));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
