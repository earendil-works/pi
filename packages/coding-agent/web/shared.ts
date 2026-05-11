type SessionInfo = {
  path: string;
  id?: string;
  cwd?: string;
  name?: string;
  firstMessage?: string;
  modified?: string;
  created?: string;
  messageCount?: number;
};

type ProjectInfo = {
  cwd: string;
  sessions: SessionInfo[];
  modified?: string;
};

type ChatItem = {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'thinking' | 'question';
  title: string;
  text: string;
  images?: Array<{ src: string; alt?: string; title?: string }>;
  running?: boolean;
  error?: boolean;
  toolName?: string;
  args?: any;
};

type ViewName = 'chat' | 'agents' | 'skills' | 'tools';

(() => {
const React = (window as any).React;
const { useEffect, useMemo, useRef, useState } = React;

const SYSTEM_ITEM: ChatItem = {
  id: 'system-ready',
  kind: 'system',
  title: 'System',
  text: 'Pi web UI is ready. It talks to a headless pi --mode rpc process.'
};

const builtinTools = [
  { name: 'read', builtin: true, description: 'Read text files and images from the current machine.', content: 'Input: { path: string, offset?: number, limit?: number }\n\nReads file contents for inspection.' },
  { name: 'bash', builtin: true, description: 'Execute shell commands in the current working directory.', content: 'Input: { command: string, timeout?: number }\n\nRuns bash commands for listing files, tests, builds, grep/ripgrep, and other development tasks.' },
  { name: 'edit', builtin: true, description: 'Edit a file with exact text replacements.', content: 'Input: { path: string, edits: [{ oldText: string, newText: string }] }\n\nApplies precise non-overlapping replacements.' },
  { name: 'write', builtin: true, description: 'Create or overwrite a file.', content: 'Input: { path: string, content: string }\n\nWrites complete file content and creates parent directories automatically.' }
];
const MAIN_AGENT_SYSTEM_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools are shown to you by the harness for each conversation.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed
- Use edit for precise changes
- Use write only for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files

When working on pi itself, read the relevant pi docs and examples before implementing.`;
const builtinAgents = [
  { id: 'builtin-main', builtin: true, name: 'Main', description: 'The main Pi coding agent.', systemPrompt: MAIN_AGENT_SYSTEM_PROMPT, skills: [], tools: [], enabled: true }
];

function uid(prefix = 'id') { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
function safeJson<T>(value: string | null, fallback: T): T { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function baseName(filePath?: string) { return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || String(filePath || 'file'); }
function shortPath(cwd?: string) { const parts = String(cwd || '').split('/').filter(Boolean); return parts[parts.length - 1] || cwd || 'Unknown'; }
function sessionTitle(session: SessionInfo) { return session.name || session.firstMessage || '(no messages)'; }
function relTime(value?: string) {
  if (!value) return '';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minute = 60000, hour = 60 * minute, day = 24 * hour, week = 7 * day, month = 30 * day;
  if (diff < hour) return Math.max(1, Math.floor(diff / minute)) + ' m';
  if (diff < day) return Math.floor(diff / hour) + ' h';
  if (diff < week) return Math.floor(diff / day) + ' d';
  if (diff < month) return Math.floor(diff / week) + ' w';
  return Math.floor(diff / month) + ' m';
}
function contentText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part && (part.text || part.content || part.thinking || '')).filter(Boolean).join('\n');
  return String(content);
}
function messageText(message: any): string { return contentText(message && message.content); }
function contentImages(content: any): Array<{ src: string; alt?: string; title?: string }> {
  if (!Array.isArray(content)) return [];
  return content.filter(part => part?.type === 'image' && part.data && part.mimeType).map((part, index) => ({ src: 'data:' + part.mimeType + ';base64,' + part.data, alt: part.name || 'image ' + (index + 1), title: part.name || part.mimeType }));
}
function pretty(value: any) { try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { return String(value); } }
function parseFrontmatter(content: string) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (match) for (const line of match[1].split(/\r?\n/)) { const idx = line.indexOf(':'); if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
  return { meta, body: String(content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim() };
}
function yamlScalar(value: any) { return String(value || '').replace(/\r?\n/g, ' ').trim(); }
function toolResultText(result: any) { return result ? (contentText(result.content) || result.output || pretty(result)) : ''; }
function toolResultImages(result: any) { return result ? contentImages(result.content) : []; }
function slugPart(value: any) { return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item'; }
function hashString(value: any) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
function projectRouteId(project: ProjectInfo | string) { const cwd = typeof project === 'string' ? project : project.cwd; return slugPart(shortPath(cwd)) + '-' + hashString(cwd); }
function conversationRouteId(session: SessionInfo) { return slugPart(session.id || baseName(session.path)); }
function sessionRoute(project: ProjectInfo | string, session: SessionInfo) { return '/' + projectRouteId(project) + '/' + conversationRouteId(session); }
function routeInfo(pathname = location.pathname) {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'skills') return { page: 'skills' };
  if (segments[0] === 'tools') return { page: 'tools' };
  if (segments[0] === 'agents') return { page: 'agents' };
  if (segments.length >= 2) return { page: 'conversation', projectId: segments[0], conversationId: segments[1] };
  return { page: 'chat' };
}
function formatK(n: number) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }

(window as any).PiWebShared = {
  SYSTEM_ITEM,
  builtinTools,
  MAIN_AGENT_SYSTEM_PROMPT,
  builtinAgents,
  uid,
  safeJson,
  baseName,
  shortPath,
  sessionTitle,
  relTime,
  contentText,
  contentImages,
  messageText,
  pretty,
  parseFrontmatter,
  yamlScalar,
  toolResultText,
  toolResultImages,
  slugPart,
  hashString,
  projectRouteId,
  conversationRouteId,
  sessionRoute,
  routeInfo,
  formatK,
  useEffect,
  useMemo,
  useRef,
  useState,
};
})();
