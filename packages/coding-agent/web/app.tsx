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
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'thinking';
  title: string;
  text: string;
  running?: boolean;
  error?: boolean;
  toolName?: string;
  args?: any;
};

type ViewName = 'chat' | 'agents' | 'skills' | 'tools';

declare const React: any;
declare const ReactDOM: any;

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
function pretty(value: any) { try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { return String(value); } }
function parseFrontmatter(content: string) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (match) for (const line of match[1].split(/\r?\n/)) { const idx = line.indexOf(':'); if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
  return { meta, body: String(content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim() };
}
function yamlScalar(value: any) { return String(value || '').replace(/\r?\n/g, ' ').trim(); }
function toolResultText(result: any) { return result ? (contentText(result.content) || result.output || pretty(result)) : ''; }
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

function App() {
  const [view, setView] = useState<ViewName>('chat');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set(safeJson('' + localStorage.getItem('piWebCollapsedProjects'), [])));
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => new Set(safeJson('' + localStorage.getItem('piWebHiddenProjects'), [])));
  const [projectIcons, setProjectIcons] = useState<Record<string, string>>(() => safeJson(localStorage.getItem('piWebProjectIcons'), {}));
  const [projectQuery, setProjectQuery] = useState('');
  const [currentSessionPath, setCurrentSessionPath] = useState('');
  const [messages, setMessages] = useState<ChatItem[]>([SYSTEM_ITEM]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<any[]>(() => safeJson(localStorage.getItem('piWebQueuedPrompts'), []));
  const [status, setStatus] = useState('connecting…');
  const [state, setState] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [mainSystemPrompt, setMainSystemPrompt] = useState(MAIN_AGENT_SYSTEM_PROMPT);
  const [models, setModels] = useState<any[]>([]);
  const [commands, setCommands] = useState<any[]>([]);
  const [menu, setMenu] = useState<any>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [folderEntries, setFolderEntries] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [skillModal, setSkillModal] = useState<any>(null);
  const [tools, setTools] = useState<any[]>(() => safeJson(localStorage.getItem('piWebCustomTools'), []));
  const [toolModal, setToolModal] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>(() => safeJson(localStorage.getItem('piWebCustomAgents'), []));
  const [builtinAgentOverrides, setBuiltinAgentOverrides] = useState<Record<string, any>>(() => safeJson(localStorage.getItem('piWebBuiltinAgentOverrides'), {}));
  const [agentModal, setAgentModal] = useState<any>(null);
  const [commandModal, setCommandModal] = useState<any>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const activeTools = useRef<Record<string, string>>({});
  const activeAssistantId = useRef<string | null>(null);
  const activeThinkingId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const queuedPromptsRef = useRef<any[]>([]);
  const drainingQueueRef = useRef(false);
  const projectsRef = useRef<ProjectInfo[]>([]);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const allProjects = useMemo(() => {
    const visible = projects.filter(project => !hiddenProjects.has(project.cwd));
    if (visible.length === 0 && projects.length > 0) return projects;
    return visible;
  }, [projects, hiddenProjects]);

  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return allProjects;
    return allProjects.map(project => {
      const projectMatches = project.cwd.toLowerCase().includes(q) || shortPath(project.cwd).toLowerCase().includes(q);
      const sessions = project.sessions.filter(session => sessionTitle(session).toLowerCase().includes(q) || String(session.firstMessage || '').toLowerCase().includes(q));
      if (projectMatches) return project;
      if (sessions.length) return { ...project, sessions };
      return null;
    }).filter(Boolean) as ProjectInfo[];
  }, [allProjects, projectQuery]);

  function pushRoute(path: string) { if (location.pathname !== path) history.pushState({}, '', path); }
  function replaceRoute(path: string) { if (location.pathname !== path) history.replaceState({}, '', path); }
  function go(path: string, nextView?: ViewName) { pushRoute(path); if (nextView) setView(nextView); applyRoute(projects); }
  function addItem(item: Partial<ChatItem>) {
    setMessages(prev => [...prev, { id: uid('msg'), kind: 'tool', title: '', text: '', ...item } as ChatItem]);
  }
  function updateItem(id: string, updater: (item: ChatItem) => ChatItem) {
    setMessages(prev => prev.map(item => item.id === id ? updater(item) : item));
  }
  function appendAssistant(delta: string) {
    let id = activeAssistantId.current;
    if (!id) {
      id = uid('assistant');
      activeAssistantId.current = id;
      setMessages(prev => [...prev, { id, kind: 'assistant', title: 'Assistant', text: delta, running: true }]);
      return;
    }
    updateItem(id, item => ({ ...item, text: item.text + delta, running: true }));
  }
  function startThinking() {
    if (activeThinkingId.current) return;
    const id = uid('thinking');
    activeThinkingId.current = id;
    setMessages(prev => [...prev, { id, kind: 'thinking', title: 'Thinking', text: '', running: true }]);
  }
  function appendThinking(delta: string) {
    if (!activeThinkingId.current) startThinking();
    const id = activeThinkingId.current;
    if (!id) return;
    updateItem(id, item => ({ ...item, text: item.text + delta, running: true }));
  }
  function finishThinking() {
    const id = activeThinkingId.current;
    if (!id) return;
    updateItem(id, item => ({ ...item, running: false }));
    activeThinkingId.current = null;
  }
  function finishAssistant() {
    const id = activeAssistantId.current;
    if (!id) return;
    updateItem(id, item => ({ ...item, running: false }));
    activeAssistantId.current = null;
  }
  function resetStreamingRefs() {
    activeAssistantId.current = null;
    activeThinkingId.current = null;
  }
  function setBusyState(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  function setQueue(next: any[]) {
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
    localStorage.setItem('piWebQueuedPrompts', JSON.stringify(next));
  }
  function enqueuePrompt(message: string, attachments: any[] = []) {
    const next = [...queuedPromptsRef.current, { id: uid('queued'), message, attachments }];
    setQueue(next);
    setStatus('queued ' + next.length + ' message' + (next.length === 1 ? '' : 's'));
    if (!busyRef.current) setTimeout(drainPromptQueue, 0);
  }
  function promptPayload(message: string, attachments: any[] = []) {
    let finalMessage = message;
    const images = attachments.filter(file => String(file.type || '').startsWith('image/') && file.dataUrl).map(file => ({ name: file.name, type: file.type, data: file.dataUrl }));
    const textFiles = attachments.filter(file => file.text && !String(file.type || '').startsWith('image/'));
    if (textFiles.length) finalMessage += '\n\nAttached files:\n' + textFiles.map(file => '--- ' + file.name + ' ---\n' + file.text).join('\n\n');
    return { message: finalMessage, images };
  }
  async function sendPrompt(message: string, streamingBehavior?: 'followUp' | 'steer', renderUser = true, attachments: any[] = []) {
    if (renderUser) setMessages(prev => [...prev, { id: uid('user'), kind: 'user', title: 'You', text: message, attachments }]);
    setBusyState(true);
    setStatus(streamingBehavior ? 'queued follow-up…' : 'queued/running…');
    const payload = promptPayload(message, attachments);
    const res = await fetch('/api/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, streamingBehavior }) });
    if (!res.ok) throw new Error(await res.text());
  }
  async function runSlashCommand(message: string) {
    const commandText = message.trim();
    const commandName = commandText.slice(1).split(/\s+/)[0]?.toLowerCase() || '';
    const modalCommands = new Set(['changelog', 'hotkeys', 'session', 'commands', 'copy', 'settings', 'scoped-models', 'resume', 'tree', 'fork', 'model']);
    if (modalCommands.has(commandName)) setCommandModal({ title: commandText, text: 'Running…' });
    setStatus('running command…');
    const res = await fetch('/api/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: commandText }) });
    if (!res.ok) throw new Error(await res.text());
    const response = await res.json().catch(() => null);
    await loadState();
    const lower = commandText.toLowerCase();
    if (lower.startsWith('/new')) {
      resetStreamingRefs();
      drainingQueueRef.current = false;
      setBusyState(false);
      setQueue([]);
      setMessages([SYSTEM_ITEM]);
      setCurrentSessionPath('');
      replaceRoute('/');
      await loadProjects();
      setStatus('ready');
      return;
    }
    if (lower.startsWith('/abort')) { setStatus('ready'); return; }
    if (response && response.detached) { setBusyState(true); return; }
    const text = commandResponseText(response);
    if (text && text !== 'Done.') {
      setCommandModal({ title: commandText, text });
      setStatus('ready');
    } else {
      setStatus('command done');
      setTimeout(() => setStatus('ready'), 1200);
    }
  }
  function commandResponseText(response: any) {
    if (!response) return 'Done.';
    if (response.success === false) return response.error || 'Command failed.';
    if (response.data?.text) return response.data.text;
    if (response.command === 'get_session_stats' || response.command === 'session') return pretty(response.data || response);
    if (response.command === 'get_last_assistant_text') return response.data?.text || '';
    if (response.command === 'export_html') return 'Exported to ' + (response.data?.path || 'HTML');
    if (response.command === 'get_commands') return (response.data?.commands || []).map((command: any) => '/' + command.name + (command.description ? ' — ' + command.description : '')).join('\n');
    if (response.command === 'get_state' && response.data?.model) return 'Current model: ' + response.data.model.provider + '/' + response.data.model.id;
    return response.data ? pretty(response.data) : 'Done.';
  }
  async function drainPromptQueue() {
    if (drainingQueueRef.current || busyRef.current || queuedPromptsRef.current.length === 0) return;
    drainingQueueRef.current = true;
    const [next, ...rest] = queuedPromptsRef.current;
    setQueue(rest);
    try {
      // Drain as a normal prompt. If the RPC is still finalizing the previous turn,
      // retry below instead of using backend followUp, which can sit queued when no
      // agent turn is active anymore.
      await sendPrompt(next.message, undefined, !next.rendered, next.attachments || []);
    } catch (err: any) {
      const text = String(err.message || err);
      if (text.includes('already processing')) {
        setQueue([{ ...next, rendered: true }, ...queuedPromptsRef.current]);
        setBusyState(false);
        setTimeout(drainPromptQueue, 500);
      } else {
        addItem({ kind: 'tool', title: 'Error', text, error: true });
        setBusyState(false);
        setTimeout(drainPromptQueue, 0);
      }
    } finally {
      drainingQueueRef.current = false;
      if (!busyRef.current && queuedPromptsRef.current.length > 0) setTimeout(drainPromptQueue, 0);
    }
  }

  async function loadProjects() {
    const res = await fetch('/api/projects');
    const json = await res.json();
    const data = json.projects || [];
    setProjects(data);
    setTimeout(() => applyRoute(data), 0);
    return data;
  }
  async function loadMessages() {
    resetStreamingRefs();
    const res = await fetch('/api/messages');
    const json = await res.json();
    const raw = json.data?.messages || [];
    setMessages(renderStoredMessages(raw));
  }
  async function loadState() {
    try { const json = await (await fetch('/api/state')).json(); setState(json.data || null); } catch {}
    try { const json = await (await fetch('/api/stats')).json(); setStats(json.data || null); } catch {}
    try { const json = await (await fetch('/api/system-prompt')).json(); setMainSystemPrompt(json.data?.systemPrompt || MAIN_AGENT_SYSTEM_PROMPT); } catch {}
  }
  async function loadModels() {
    try { const json = await (await fetch('/api/models')).json(); setModels(json.data?.models || []); } catch { setModels([]); }
  }
  async function loadCommands() {
    try {
      const json = await (await fetch('/api/commands')).json();
      setCommands((json.data?.commands || []).map((command: any) => ({ ...command, slash: '/' + command.name })));
    } catch { setCommands([]); }
  }
  async function loadSkills() {
    try { const json = await (await fetch('/api/skills')).json(); setSkills(json.skills || []); } catch { setSkills([]); }
  }
  async function applyRoute(projectList = projects) {
    const route = routeInfo();
    if (route.page === 'skills') { setView('skills'); loadSkills(); return; }
    if (route.page === 'tools') { setView('tools'); return; }
    if (route.page === 'agents') { setView('agents'); loadSkills(); return; }
    setView('chat');
    if (route.page === 'conversation') {
      const project = projectList.find(project => projectRouteId(project) === route.projectId);
      const session = project?.sessions.find(session => conversationRouteId(session) === route.conversationId || session.id === route.conversationId);
      if (project && session) await openSession(project, session, false);
    }
  }
  async function openSession(project: ProjectInfo, session: SessionInfo, updateUrl = true) {
    setView('chat');
    if (updateUrl) pushRoute(sessionRoute(project, session));
    if (currentSessionPath === session.path) return;
    setStatus('switching session…');
    setQueue([]);
    const res = await fetch('/api/switch-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: session.path }) });
    if (!res.ok) { alert(await res.text()); setStatus('ready'); return; }
    setCurrentSessionPath(session.path);
    await loadMessages();
    await loadState();
    setStatus('ready');
  }
  async function newChat() {
    await fetch('/api/new-session', { method: 'POST' });
    setCurrentSessionPath('');
    replaceRoute('/');
    setView('chat');
    resetStreamingRefs();
    drainingQueueRef.current = false;
    setBusyState(false);
    setQueue([]);
    setMessages([SYSTEM_ITEM]);
    setStatus('ready');
    await loadProjects();
  }

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { queuedPromptsRef.current = queuedPrompts; setTimeout(drainPromptQueue, 1000); }, []);
  useEffect(() => {
    loadState(); loadModels(); loadCommands(); loadProjects();
    if (routeInfo().page === 'chat') loadMessages();
    const pop = () => applyRoute(projectsRef.current);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages]);
  useEffect(() => {
    if (view !== 'chat') return;
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }, [view]);
  useEffect(() => {
    const es = new EventSource('/events');
    es.onopen = () => setStatus('connected');
    es.onerror = () => setStatus('disconnected');
    es.onmessage = ev => handleEvent(JSON.parse(ev.data));
    return () => es.close();
  }, []);
  useEffect(() => {
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      touchStartRef.current = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    };
    const onTouchEnd = (ev: TouchEvent) => {
      const start = touchStartRef.current;
      if (!start || ev.changedTouches.length !== 1) return;
      const dx = ev.changedTouches[0].clientX - start.x;
      const dy = ev.changedTouches[0].clientY - start.y;
      const isPhone = window.matchMedia('(max-width: 820px)').matches;
      if (isPhone && !sidebarOpen && dx > 80 && Math.abs(dy) < 60) setSidebarOpen(true);
      if (isPhone && sidebarOpen && dx < -80 && Math.abs(dy) < 60) setSidebarOpen(false);
      touchStartRef.current = null;
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [sidebarOpen]);

  function handleEvent(e: any) {
    if (e.type === 'terminal_start' || e.type === 'terminal_output' || e.type === 'terminal_exit') {
      window.dispatchEvent(new CustomEvent('pi-terminal-event', { detail: e }));
    }
    if (e.type === 'agent_start') { resetStreamingRefs(); setBusyState(true); setStatus('thinking…'); }
    if (e.type === 'web_connected' && e.rpcBusy) { setBusyState(true); setStatus('thinking…'); loadState(); }
    if (e.type === 'agent_end') { finishThinking(); finishAssistant(); setBusyState(false); setStatus('ready'); setMessages(prev => prev.map(item => item.running ? { ...item, running: false } : item)); loadMessages(); loadProjects(); loadState(); setTimeout(drainPromptQueue, 150); }
    if (e.type === 'message_start') { resetStreamingRefs(); }
    if (e.type === 'message_end') { finishThinking(); finishAssistant(); }
    if (e.type === 'message_update') {
      const d = e.assistantMessageEvent || {};
      if (d.type === 'text_delta') appendAssistant(d.delta || '');
      else if (d.type === 'thinking_start') startThinking();
      else if (d.type === 'thinking_delta') appendThinking(d.delta || '');
      else if (d.type === 'thinking_end') finishThinking();
      else if (d.type === 'error') addItem({ kind: 'tool', title: 'Assistant error', text: pretty(d), error: true });
    }
    if (e.type === 'tool_execution_start') {
      finishAssistant();
      finishThinking();
      const id = e.toolCallId || uid('tool');
      activeTools.current[id] = id;
      addItem({ id, kind: 'tool', title: formatToolTitle(e.toolName, e.args), text: '', running: true, toolName: e.toolName, args: e.args || {} });
    }
    if (e.type === 'tool_execution_update') {
      const id = e.toolCallId || e.id;
      if (id) updateItem(id, item => ({ ...item, text: toolResultText(e.partialResult) || item.text }));
    }
    if (e.type === 'tool_execution_end') {
      const id = e.toolCallId || e.id;
      if (id) updateItem(id, item => ({ ...item, text: toolResultText(e.result) || item.text, running: false, error: !!(e.error || e.isError) }));
    }
  }
  function formatToolTitle(name: string, args: any) {
    if (name === 'bash') return args?.command || 'bash';
    if (name === 'read') return 'Read ' + (args?.path || 'file');
    if (name === 'edit') return 'Edit ' + (args?.path || 'file');
    if (name === 'write') return 'Write ' + (args?.path || 'file');
    return String(name || 'tool');
  }
  function renderStoredMessages(raw: any[]): ChatItem[] {
    const result: ChatItem[] = [SYSTEM_ITEM];
    const toolResults = new Map<string, any>();
    for (const msg of raw) if (msg.role === 'toolResult') toolResults.set(msg.toolCallId, msg);
    for (const msg of raw) {
      if (msg.role === 'user') result.push({ id: uid('user'), kind: 'user', title: 'You', text: messageText(msg) });
      else if (msg.role === 'assistant') {
        let text = '';
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === 'text') text += block.text || '';
          if (block.type === 'toolCall') result.push({ id: uid('tool'), kind: 'tool', title: formatToolTitle(block.name, block.arguments), text: toolResultText(toolResults.get(block.id)), running: false, error: !!toolResults.get(block.id)?.isError, toolName: block.name, args: block.arguments || {} });
        }
        if (text.trim()) result.push({ id: uid('assistant'), kind: 'assistant', title: 'Assistant', text });
      } else if (msg.role === 'bashExecution') result.push({ id: uid('bash'), kind: 'tool', title: msg.command || 'bash', text: msg.output || '', error: msg.exitCode !== 0, toolName: 'bash', args: { command: msg.command } });
    }
    return result;
  }
  async function abortGeneration() {
    try {
      setStatus('aborting…');
      await fetch('/api/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '/abort' }) });
    } catch (err: any) {
      addItem({ kind: 'tool', title: 'Abort error', text: String(err.message || err), error: true });
    }
  }
  async function submitMessage(message: string, attachments: any[] = []) {
    message = message.trim();
    if (!message) return;
    if (message.startsWith('/')) {
      try { await runSlashCommand(message); }
      catch (err: any) { setCommandModal({ title: message, text: String(err.message || err) }); setStatus('ready'); }
      return;
    }
    if (busyRef.current || queuedPromptsRef.current.length > 0) {
      enqueuePrompt(message, attachments);
      return;
    }
    try {
      await sendPrompt(message, undefined, true, attachments);
    } catch (err: any) { addItem({ kind: 'tool', title: 'Error', text: String(err.message || err), error: true }); setBusyState(false); setTimeout(drainPromptQueue, 0); }
  }
  async function submitPrompt(ev: any) {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    const textarea = form.querySelector('textarea') as HTMLTextAreaElement | null;
    const message = (textarea?.value || input).trim();
    if (!message) return;
    setInput('');
    await submitMessage(message);
  }
  async function deleteConversation(session: SessionInfo) {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    const deletingActive = currentSessionPath === session.path;
    setMenu(null); setStatus('deleting conversation…');
    const res = await fetch('/api/session', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: session.path }) });
    if (!res.ok) { alert(await res.text()); setStatus('ready'); return; }
    if (deletingActive) await newChat();
    await loadProjects(); setStatus('ready');
  }
  function setCollapsed(cwd: string) {
    const next = new Set(collapsedProjects);
    next.has(cwd) ? next.delete(cwd) : next.add(cwd);
    setCollapsedProjects(next);
    localStorage.setItem('piWebCollapsedProjects', JSON.stringify([...next]));
  }
  function removeProject(cwd: string) {
    const next = new Set(hiddenProjects); next.add(cwd); setHiddenProjects(next);
    localStorage.setItem('piWebHiddenProjects', JSON.stringify([...next])); setMenu(null);
  }
  function chooseProjectIcon(cwd: string) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { const next = { ...projectIcons, [cwd]: String(reader.result) }; setProjectIcons(next); localStorage.setItem('piWebProjectIcons', JSON.stringify(next)); setMenu(null); };
      reader.readAsDataURL(file);
    };
    input.click();
  }
  async function browseFolder(targetPath = '') {
    setFolderOpen(true);
    const res = await fetch('/api/browse?path=' + encodeURIComponent(targetPath));
    if (!res.ok) { alert(await res.text()); return; }
    const data = await res.json();
    setFolderPath(data.path); setFolderEntries([...(data.parent ? [{ name: '..', path: data.parent, type: 'directory', parent: true }] : []), ...(data.entries || [])]);
  }
  async function openProject() {
    const res = await fetch('/api/open-project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: folderPath }) });
    if (!res.ok) { alert(await res.text()); return; }
    setFolderOpen(false); replaceRoute('/'); setMessages([SYSTEM_ITEM]); await loadProjects(); await loadState();
  }
  async function saveSkill(data: any) {
    const editing = !!data.path;
    const meta: Record<string, string> = { name: slugPart(data.name), description: yamlScalar(data.description) };
    for (const field of data.metaFields || []) {
      const key = yamlScalar(field.key);
      if (!key || key === 'name' || key === 'description') continue;
      meta[key] = yamlScalar(field.value);
    }
    const frontmatter = '---\n' + Object.entries(meta).map(([key, value]) => key + ': ' + value).join('\n') + '\n---';
    const body = data.content.trim();
    const content = frontmatter + '\n\n' + (body.match(/^#\s+/) ? body : '# ' + data.name + '\n\n' + body);
    const res = await fetch('/api/skills', { method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, content }) });
    if (!res.ok) { alert(await res.text()); return; }
    setSkillModal(null); await loadSkills(); await loadCommands();
  }
  function saveTools(next: any[]) { setTools(next); localStorage.setItem('piWebCustomTools', JSON.stringify(next)); }
  function saveAgents(next: any[]) { setAgents(next); localStorage.setItem('piWebCustomAgents', JSON.stringify(next)); }
  async function saveBuiltinAgent(agent: any) {
    const res = await fetch('/api/system-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: agent.systemPrompt }) });
    if (!res.ok) { alert(await res.text()); return; }
    const json = await res.json().catch(() => null);
    setMainSystemPrompt(json?.data?.systemPrompt || agent.systemPrompt);
    const next = { ...builtinAgentOverrides, [agent.id]: { ...agent, systemPrompt: json?.data?.systemPrompt || agent.systemPrompt } };
    setBuiltinAgentOverrides(next);
    localStorage.setItem('piWebBuiltinAgentOverrides', JSON.stringify(next));
  }

  const contextText = useMemo(() => {
    const usage = state?.contextUsage || stats?.contextUsage || stats?.estimatedContextUsage;
    if (!usage || usage.tokens == null || usage.contextWindow == null) return 'Context: waiting for usage';
    const used = Number(usage.tokens), total = Number(usage.contextWindow), left = Math.max(0, total - used);
    const pct = usage.percent != null ? Math.round(Number(usage.percent)) : Math.round((used / total) * 100);
    return 'Context: ' + formatK(used) + ' used · ' + formatK(left) + ' left · ' + pct + '%';
  }, [state, stats]);

  return <div className="grid h-screen grid-cols-[290px_minmax(0,1fr)] bg-white text-[#202124] max-[820px]:grid-cols-1">
    {sidebarOpen && <div className="fixed inset-0 z-30 bg-gray-900/30 min-[821px]:hidden" onClick={() => setSidebarOpen(false)} />}
    <aside className={'h-screen overflow-y-auto bg-piPanel px-3 py-4 text-piText scrollbar-thin max-[820px]:fixed max-[820px]:inset-y-0 max-[820px]:left-0 max-[820px]:z-40 max-[820px]:w-[290px] max-[820px]:transition-transform ' + (sidebarOpen ? 'max-[820px]:translate-x-0' : 'max-[820px]:-translate-x-full')}>
      <SidebarButton icon="✎" label="New chat" onClick={() => { setSidebarOpen(false); newChat(); }} />
      <SidebarButton icon="⌕" label="Search" onClick={() => { setSidebarOpen(false); setSearchOpen(true); }} />
      <SidebarButton icon="◎" label="Agents" onClick={() => { setSidebarOpen(false); go('/agents', 'agents'); }} />
      <SidebarButton icon="✦" label="Skills" onClick={() => { setSidebarOpen(false); go('/skills', 'skills'); loadSkills(); }} />
      <SidebarButton icon="⚙" label="Tools" onClick={() => { setSidebarOpen(false); go('/tools', 'tools'); }} />
      <SidebarButton icon="＋" label="Add project" onClick={() => browseFolder('')} />
      <div className="mx-1 mb-4 mt-7 text-[17px] text-[#9a9a9a]">Projects</div>
      <div className="space-y-3">
        {filteredProjects.length === 0 && <div className="pl-11 text-sm text-piMuted">No projects yet. Use Add project to open a folder.</div>}
        {filteredProjects.map(project => <ProjectTree key={project.cwd} project={project} collapsed={collapsedProjects.has(project.cwd) && !projectQuery} icon={projectIcons[project.cwd]} currentSessionPath={currentSessionPath} onToggle={() => setCollapsed(project.cwd)} onOpen={(project: ProjectInfo, session: SessionInfo, updateUrl: boolean) => { setSidebarOpen(false); openSession(project, session, updateUrl); }} onMenu={(kind, payload, ev) => setMenu({ kind, payload, x: ev.currentTarget.getBoundingClientRect().left, y: ev.currentTarget.getBoundingClientRect().bottom + 6 })} />)}
      </div>
    </aside>
    <section className="relative flex h-screen min-w-0 flex-col">
      {view === 'chat' && <header className="fixed left-[290px] right-0 top-0 z-10 flex h-12 items-center justify-between border-b border-gray-100 bg-white/95 px-4 max-[820px]:left-0">
        <div className="flex items-center gap-2"><button type="button" className="hidden rounded-lg bg-gray-100 px-2 py-1 text-gray-700 max-[820px]:block" onClick={() => setSidebarOpen(true)}>☰</button><h1 className="text-sm font-semibold">π Pi Web</h1></div>
        <div className="flex items-center gap-2 text-xs text-gray-500"><span className="rounded-full bg-gray-100 px-3 py-1">{contextText}</span><span>{status}</span><button type="button" className={'rounded-lg px-3 py-1 font-semibold ' + (terminalOpen ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')} onClick={() => setTerminalOpen(!terminalOpen)}>Terminal</button></div>
      </header>}
      {view !== 'chat' && <header className="fixed left-[290px] right-0 top-0 z-10 flex h-12 items-center justify-between border-b border-gray-100 bg-white/95 px-4 max-[820px]:left-0">
        <div className="flex items-center gap-2"><button type="button" className="hidden rounded-lg bg-gray-100 px-2 py-1 text-gray-700 max-[820px]:block" onClick={() => setSidebarOpen(true)}>☰</button><h1 className="text-sm font-semibold">{view === 'skills' ? 'Skills' : view === 'tools' ? 'Tools' : 'Agents'}</h1></div>
        <div className="text-xs text-gray-400">π Pi Web</div>
      </header>}
      {view === 'chat' && <ChatView logRef={logRef} messages={messages} input={input} setInput={setInput} submitPrompt={submitPrompt} submitMessage={submitMessage} abortGeneration={abortGeneration} busy={busy} queuedPrompts={queuedPrompts} removeQueuedPrompt={(id: string) => setQueue(queuedPromptsRef.current.filter(item => item.id !== id))} models={models} commands={commands} state={state} loadState={loadState} focusKey={(state?.cwd || '') + ':' + currentSessionPath} terminalOpen={terminalOpen} setTerminalOpen={setTerminalOpen} />}
      {view === 'skills' && <SkillsView skills={skills} reload={async () => { await loadSkills(); await loadCommands(); }} openModal={setSkillModal} />}
      {view === 'tools' && <ToolsView tools={[...builtinTools, ...tools]} openModal={setToolModal} saveTools={saveTools} customTools={tools} />}
      {view === 'agents' && <AgentsView builtinAgents={builtinAgents.map(agent => ({ ...agent, systemPrompt: mainSystemPrompt, skills: skills.map((skill: any) => skill.name), tools: [...builtinTools, ...tools].map((tool: any) => tool.name), ...(builtinAgentOverrides[agent.id] || {}) }))} customAgents={agents} openModal={setAgentModal} saveAgents={saveAgents} />}
    </section>
    {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      {menu.kind === 'project' && <>
        <MenuItem neutral onClick={() => chooseProjectIcon(menu.payload.cwd)}>Set Icon</MenuItem>
        <MenuItem onClick={() => removeProject(menu.payload.cwd)}>Remove Project</MenuItem>
      </>}
      {menu.kind === 'session' && <MenuItem onClick={() => deleteConversation(menu.payload)}>Delete Conversation</MenuItem>}
    </Menu>}
    {searchOpen && <SearchModal projects={allProjects} onClose={() => setSearchOpen(false)} onOpen={(project, session) => { setSearchOpen(false); openSession(project, session, true); }} />}
    {folderOpen && <FolderModal path={folderPath} entries={folderEntries} browse={browseFolder} close={() => setFolderOpen(false)} select={openProject} />}
    {skillModal && <SkillModal skill={skillModal === true ? null : skillModal} onClose={() => setSkillModal(null)} onSave={saveSkill} />}
    {toolModal && <ToolModal tool={toolModal === true ? null : toolModal} onClose={() => setToolModal(null)} onSave={(tool: any) => { if (tool.id) saveTools(tools.map(t => t.id === tool.id ? tool : t)); else saveTools([...tools, { ...tool, id: uid('tool'), createdAt: new Date().toISOString() }]); setToolModal(null); }} />}
    {agentModal && <AgentModal agent={agentModal === true ? null : agentModal} skills={skills} tools={[...builtinTools, ...tools]} onClose={() => setAgentModal(null)} onSave={(agent: any) => { if (agent.builtin) saveBuiltinAgent(agent); else if (agent.id) saveAgents(agents.map(a => a.id === agent.id ? agent : a)); else saveAgents([...agents, { ...agent, id: uid('agent'), createdAt: new Date().toISOString() }]); setAgentModal(null); }} />}
    {commandModal && <CommandOutputModal command={commandModal.title} text={commandModal.text} onClose={() => setCommandModal(null)} />}
  </div>;
}

function SidebarButton({ icon, label, onClick }: any) { return <button className="mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[18px] font-medium hover:bg-piHover" onClick={onClick}><span className="w-6 text-center">{icon}</span><span>{label}</span></button>; }
function ProjectTree({ project, collapsed, icon, currentSessionPath, onToggle, onOpen, onMenu }: any) {
  const shown = collapsed ? [] : project.sessions.slice(0, 10);
  return <div className="mb-5">
    <div className="group mx-1 flex cursor-pointer items-center gap-2 rounded-xl px-1.5 py-1 text-[18px] text-[#666] hover:bg-piHover" onClick={onToggle} title={project.cwd}>
      <span className={'w-4 text-gray-500 transition ' + (collapsed ? '-rotate-90' : '')}>⌄</span>
      <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-md">{icon ? <img src={icon} className="h-5 w-5 object-cover" /> : '▱'}</span>
      <span className="min-w-0 flex-1 truncate">{shortPath(project.cwd)}</span>
      <button className="rounded-lg px-1.5 text-lg leading-none text-gray-500 opacity-0 hover:bg-[#d3d2cd] group-hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); onMenu('project', project, ev); }}>…</button>
    </div>
    {shown.map((session: SessionInfo) => <div key={session.path} className={'group ml-0 flex cursor-pointer items-center gap-2 rounded-[14px] py-2 pl-11 pr-2 text-[#333] hover:bg-piActive ' + (currentSessionPath === session.path ? 'bg-piActive' : '')} onClick={() => onOpen(project, session, true)} title={sessionTitle(session)}>
      <div className="min-w-0 flex-1 truncate text-base">{sessionTitle(session)}</div><div className="whitespace-nowrap text-sm text-piMuted">{relTime(session.modified)}</div>
      <button className="rounded-lg px-1.5 text-lg leading-none text-gray-500 opacity-0 hover:bg-[#d3d2cd] group-hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); onMenu('session', session, ev); }}>…</button>
    </div>)}
  </div>;
}
function ChatView({ logRef, messages, input, setInput, submitPrompt, submitMessage, abortGeneration, busy, queuedPrompts, removeQueuedPrompt, models, commands, state, loadState, focusKey, terminalOpen, setTerminalOpen }: any) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [composerHeight, setComposerHeight] = useState(160);
  const MESSAGE_CHUNK_SIZE = 30;
  const [renderStart, setRenderStart] = useState(Math.max(0, messages.length - MESSAGE_CHUNK_SIZE));
  const prevRenderStartRef = useRef(renderStart);
  const prevScrollHeightRef = useRef(0);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const completedSuggestionRef = useRef<string | null>(null);
  function slashToken() {
    // Slash command suggestions only appear when `/` is the first character.
    // Keep them visible for an exact command and for one trailing space so the
    // user can still press Enter/click to run after tab-completing.
    if (!input.startsWith('/')) return null;
    const match = input.match(/^(\/[\w:-]*)(\s*)$/);
    if (!match) return null;
    if (match[2].length > 1) return null;
    return { token: match[1], start: 0, end: match[1].length, hasTrailingSpace: match[2].length === 1 };
  }
  const tokenInfo = slashToken();
  const slashQuery = tokenInfo ? tokenInfo.token.slice(1).toLowerCase() : '';
  const slashMatches = tokenInfo ? commands.filter((command: any) => command.name.toLowerCase().startsWith(slashQuery)).slice(0, 8) : [];
  const showSuggestions = slashMatches.length > 0;
  function runSuggestion(command: any) {
    completedSuggestionRef.current = null;
    setInput('');
    setSelectedSuggestion(0);
    submitMessage('/' + command.name);
  }
  function applySuggestion(command: any) {
    const commandText = '/' + command.name + ' ';
    completedSuggestionRef.current = '/' + command.name;
    setInput(commandText);
    setSelectedSuggestion(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(commandText.length, commandText.length);
    });
  }
  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }
  function readAttachment(file: File) {
    return new Promise<any>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Failed to read ' + file.name));
      reader.onload = () => {
        const value = String(reader.result || '');
        const isText = String(file.type || '').startsWith('text/') || /\.(md|txt|json|js|ts|tsx|jsx|css|html|xml|yaml|yml|py|rs|go|java|c|cpp|h|hpp)$/i.test(file.name);
        let text = '';
        if (isText) { try { text = decodeURIComponent(escape(atob(value.split(',')[1] || ''))); } catch { text = atob(value.split(',')[1] || ''); } }
        resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, dataUrl: value, text });
      };
      reader.readAsDataURL(file);
    });
  }
  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const read = await Promise.all(Array.from(files).map(readAttachment));
    setAttachments(prev => [...prev, ...read]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
  function submitCurrentInput() {
    const message = textareaRef.current?.value.trim() || input.trim();
    if (!message && attachments.length === 0) return;
    const files = attachments;
    completedSuggestionRef.current = null;
    setInput('');
    setAttachments([]);
    submitMessage(message || 'Please review the attached file(s).', files);
  }
  useEffect(autoResize, [input]);
  useEffect(() => {
    setRenderStart(Math.max(0, messages.length - MESSAGE_CHUNK_SIZE));
  }, [messages.length > 0 ? messages[0].id : '', messages.length > 0 ? messages[messages.length - 1].id : '']);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (renderStart < prevRenderStartRef.current) {
      const oldHeight = prevScrollHeightRef.current;
      requestAnimationFrame(() => {
        const diff = el.scrollHeight - oldHeight;
        el.scrollTop += diff;
      });
    }
    prevRenderStartRef.current = renderStart;
  }, [renderStart]);
  function handleChatScroll() {
    const el = logRef.current;
    if (!el || renderStart <= 0) return;
    if (el.scrollTop < 160) {
      prevScrollHeightRef.current = el.scrollHeight;
      setRenderStart(Math.max(0, renderStart - MESSAGE_CHUNK_SIZE));
    }
  }
  useEffect(() => { setSelectedSuggestion(index => Math.min(index, Math.max(0, slashMatches.length - 1))); }, [input, commands.length]);
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [messages.length > 0 ? messages[0].id : '']);
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [focusKey]);
  useEffect(() => {
    const el = formRef.current;
    if (!el) return;
    const update = () => setComposerHeight(el.getBoundingClientRect().height);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const terminalOffsetClass = terminalOpen ? 'min-[1000px]:pr-[420px]' : '';
  const terminalFormClass = terminalOpen ? 'min-[1000px]:right-[420px]' : 'right-0';
  return <>
    <main ref={logRef} onScroll={handleChatScroll} style={{ paddingBottom: composerHeight + 64 }} className={'flex-1 overflow-y-auto px-6 pt-16 scrollbar-thin ' + terminalOffsetClass}><div className="mx-auto w-full max-w-6xl space-y-4">
      {renderStart > 0 && <div className="py-3 text-center text-xs text-gray-400">Scroll up to load older messages</div>}
      {messages.slice(renderStart).map((item: ChatItem) => <Message key={item.id} item={item} />)}
    </div></main>
    {terminalOpen && <TerminalPane focusKey={focusKey} onClose={() => setTerminalOpen(false)} />}
    <form ref={formRef} onSubmit={submitPrompt} className={'fixed bottom-0 left-[290px] bg-gradient-to-t from-white via-white px-6 pb-4 pt-3 max-[820px]:left-0 ' + terminalFormClass}><div className="mx-auto w-full max-w-6xl">
      {showSuggestions && <div className="mb-2 max-h-64 overflow-auto rounded-2xl border border-gray-200 bg-white p-1.5 shadow-pi">
        {slashMatches.map((command: any, index: number) => <button key={command.name} type="button" className={'flex w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left hover:bg-[#f2f4ff] ' + (index === selectedSuggestion ? 'bg-[#f2f4ff]' : '')} onMouseDown={ev => { ev.preventDefault(); runSuggestion(command); }}>
          <span className="min-w-36 font-bold text-piAccent">/{command.name}</span><span className="truncate text-xs text-gray-500">{command.description || command.source || ''}</span>
        </button>)}
      </div>}
      {queuedPrompts.length > 0 && <div className="mb-2 max-h-28 overflow-auto rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-sm">
        {queuedPrompts.map((item: any, index: number) => <div key={item.id} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"><div className="font-bold text-piAccent">Queued {index + 1}</div><div className="min-w-0 flex-1 truncate">{item.message}{item.attachments?.length ? ' · ' + item.attachments.length + ' file' + (item.attachments.length === 1 ? '' : 's') : ''}</div><button type="button" className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" onClick={() => removeQueuedPrompt(item.id)}>×</button></div>)}
      </div>}
      <div className={'rounded-3xl border bg-white p-3 shadow-sm ' + (dragOver ? 'border-piAccent ring-2 ring-piAccent/20' : 'border-gray-300')} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => addFiles(e.target.files)} />
      {attachments.length > 0 && <AttachmentPreview files={attachments} remove={(index: number) => setAttachments(attachments.filter((_, i) => i !== index))} />}
      <textarea ref={textareaRef} className="max-h-[180px] min-h-[42px] w-full resize-none overflow-y-auto border-0 bg-white p-1 text-[15px] outline-none" placeholder="Ask for additional changes" value={input} onPaste={e => { const files = e.clipboardData?.files; if (files && files.length > 0) addFiles(files); }} onChange={e => { completedSuggestionRef.current = null; setInput(e.target.value); setSelectedSuggestion(0); }} onInput={autoResize} onKeyDown={e => {
        if (showSuggestions && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          setSelectedSuggestion((selectedSuggestion + (e.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length);
          return;
        }
        if (slashMatches.length > 0 && e.key === 'Tab') {
          e.preventDefault();
          applySuggestion(slashMatches[selectedSuggestion]);
          return;
        }
        if (showSuggestions && e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          runSuggestion(slashMatches[selectedSuggestion]);
          return;
        }
        if (e.key === 'Escape' && showSuggestions) { e.preventDefault(); setSelectedSuggestion(0); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const currentValue = (e.currentTarget as HTMLTextAreaElement).value;
          const completedCommand = completedSuggestionRef.current;
          if (completedCommand && currentValue.trim() === completedCommand) {
            completedSuggestionRef.current = null;
            setInput('');
            submitMessage(completedCommand);
          } else {
            submitCurrentInput();
          }
        }
      }} />
      <div className="flex items-center gap-2"><button type="button" className="h-8 w-8 rounded-full text-xl text-gray-500 hover:bg-gray-100" onClick={() => fileInputRef.current?.click()}>＋</button><ModelControls models={models} state={state} loadState={loadState} /><div className="flex-1" />{busy && (input.trim() || attachments.length > 0) && <button type="button" className="rounded-full bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200" onClick={submitCurrentInput}>Queue</button>}<button type="button" className={'flex h-8 w-8 items-center justify-center rounded-full text-white ' + (busy || input.trim() || attachments.length > 0 ? 'bg-gray-900' : 'bg-gray-300')} disabled={!busy && !input.trim() && attachments.length === 0} onClick={busy ? abortGeneration : submitCurrentInput}>{busy ? <span className="h-3 w-3 rounded-sm bg-white" /> : '↑'}</button></div>
      </div>
    </div></form>
  </>;
}
function TerminalPane({ focusKey, onClose }: any) {
  const [cwd, setCwd] = useState('');
  const [pid, setPid] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const outputRef = useRef<HTMLPreElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function append(text: string) {
    setOutput(prev => {
      const next = prev + text;
      return next.length > 200000 ? next.slice(-200000) : next;
    });
  }

  async function start(restart = false) {
    const res = await fetch(restart ? '/api/terminal/restart' : '/api/terminal/start', { method: 'POST' });
    if (!res.ok) {
      append('\nTerminal error: ' + await res.text() + '\n');
      return;
    }
    const json = await res.json();
    const data = json.data || {};
    setCwd(data.cwd || '');
    setPid(data.pid || null);
    setRunning(!!data.running);
    setOutput(data.buffer || '');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function send(data: string) {
    if (!data) return;
    const res = await fetch('/api/terminal/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
    if (!res.ok) append('\nTerminal error: ' + await res.text() + '\n');
  }

  function submitLine() {
    const value = input;
    setInput('');
    send(value + '\n');
  }

  useEffect(() => { start(false); }, [focusKey]);
  useEffect(() => {
    const handler = (event: any) => {
      const detail = event.detail || {};
      if (detail.cwd && cwd && detail.cwd !== cwd) return;
      if (detail.type === 'terminal_start') {
        setCwd(detail.cwd || '');
        setPid(detail.pid || null);
        setRunning(true);
      } else if (detail.type === 'terminal_output') {
        append(detail.data || '');
      } else if (detail.type === 'terminal_exit') {
        setRunning(false);
        append('\n[terminal exited code=' + detail.code + ' signal=' + detail.signal + ']\n');
      }
    };
    window.addEventListener('pi-terminal-event', handler);
    return () => window.removeEventListener('pi-terminal-event', handler);
  }, [cwd]);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [output]);

  return <aside className="fixed bottom-0 right-0 top-12 z-20 flex w-[420px] max-w-full flex-col border-l border-gray-200 bg-[#0b1020] text-gray-100 shadow-pi max-[999px]:left-0 max-[999px]:top-auto max-[999px]:h-[45vh] max-[999px]:w-full max-[999px]:border-l-0 max-[999px]:border-t">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 px-3">
      <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-gray-100">Terminal</div><div className="truncate font-mono text-[10px] text-gray-400">{cwd || 'starting'}{pid ? ' · pid ' + pid : ''}</div></div>
      <span className={'rounded-full px-2 py-0.5 text-[10px] font-semibold ' + (running ? 'bg-green-400/15 text-green-200' : 'bg-gray-400/15 text-gray-300')}>{running ? 'Running' : 'Stopped'}</span>
      <button type="button" className="rounded-lg bg-white/10 px-2 py-1 text-xs text-gray-100 hover:bg-white/15" onClick={() => start(true)}>Restart</button>
      <button type="button" className="rounded-lg bg-white/10 px-2 py-1 text-xs text-gray-100 hover:bg-white/15" onClick={onClose}>Close</button>
    </div>
    <pre ref={outputRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-gray-100 scrollbar-thin">{output || 'Starting terminal…'}</pre>
    <div className="flex shrink-0 items-center gap-2 border-t border-white/10 p-2">
      <button type="button" className="rounded-md bg-white/10 px-2 py-1 font-mono text-xs text-gray-100 hover:bg-white/15" title="Send Ctrl+C" onClick={() => send('\u0003')}>^C</button>
      <span className="font-mono text-xs text-gray-500">$</span>
      <input ref={inputRef} className="min-w-0 flex-1 border-0 bg-transparent font-mono text-xs text-gray-100 outline-none placeholder:text-gray-600" value={input} disabled={!running} placeholder={running ? 'type command and press Enter' : 'terminal stopped'} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitLine(); } }} />
    </div>
  </aside>;
}
function AttachmentPreview({ files, remove }: any) { return <div className="mb-2 flex flex-wrap gap-2">{files.map((file: any, index: number) => <div key={index} className="group relative overflow-hidden rounded-xl border border-gray-200 bg-gray-50">{String(file.type || '').startsWith('image/') && file.dataUrl ? <img src={file.dataUrl} className="h-20 w-20 object-cover" /> : <div className="flex h-20 w-40 items-center justify-center px-3 text-center text-xs text-gray-500">{file.name}</div>}<div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[10px] text-white">{file.name}</div>{remove && <button type="button" className="absolute right-1 top-1 hidden rounded-full bg-black/60 px-1.5 text-xs text-white group-hover:block" onClick={() => remove(index)}>×</button>}</div>)}</div>; }
function Message({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <div className="ml-auto max-w-[74%]"><div className="ml-auto w-fit whitespace-pre-wrap rounded-2xl bg-black px-4 py-3 text-[15px] text-white">{item.text}</div>{item.attachments?.length > 0 && <div className="mt-2 flex justify-end"><AttachmentPreview files={item.attachments} /></div>}</div>;
  if (item.kind === 'assistant') return <div className="whitespace-pre-wrap py-2 text-[15px] leading-7 text-[#202124]">{item.text}{item.running && <span className="ml-1 animate-pulse">●</span>}</div>;
  if (item.kind === 'system') return <div className="rounded-xl bg-[#fff7df] px-4 py-3 text-sm text-[#6b5b1a]"><div className="mb-1 text-xs font-bold uppercase">{item.title}</div>{item.text}</div>;
  if (item.kind === 'thinking') return <details className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500" open={!!item.running}><summary className="cursor-pointer font-medium">{item.running ? '◌ ' : '✓ '}Thinking</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{item.text}</pre></details>;
  if (item.toolName === 'bash') return <BashToolBlock item={item} />;
  if (item.toolName === 'read') return <ReadToolBlock item={item} />;
  if (item.toolName === 'edit') return <EditToolBlock item={item} />;
  if (item.toolName === 'write') return <WriteToolBlock item={item} />;
  return <GenericToolBlock item={item} />;
}
function ToolStatus({ item }: { item: ChatItem }) { return <span className="mr-2 inline-block w-4 text-center">{item.running ? '◌' : item.error ? '✕' : '✓'}</span>; }
function BashToolBlock({ item }: { item: ChatItem }) {
  const command = item.args?.command || item.title || 'bash';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-gray-50 text-gray-700')}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Bash</summary>
    <pre className="mt-2 overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs text-gray-100"><code>{command}</code></pre>
    {item.text && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs text-gray-600">{item.text}</pre>}
  </details>;
}
function ReadToolBlock({ item }: { item: ChatItem }) {
  const file = item.args?.path || item.title.replace(/^Read\s+/, '') || 'file';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-gray-50 text-gray-700')}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Read <span className="font-mono">{baseName(file)}</span></summary>
    {item.text && <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs text-gray-700">{item.text}</pre>}
  </details>;
}
function EditToolBlock({ item }: { item: ChatItem }) {
  const file = item.args?.path || 'file';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-gray-50 text-gray-700')} open={!!item.running}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Edited <span className="font-mono">{baseName(file)}</span></summary>
    <DiffView edits={item.args?.edits} fallback={item.text} />
  </details>;
}
function WriteToolBlock({ item }: { item: ChatItem }) {
  const file = item.args?.path || 'file';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-gray-50 text-gray-700')} open={!!item.running}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Wrote <span className="font-mono">{baseName(file)}</span></summary>
    <AddedFileView content={item.args?.content || item.text} />
  </details>;
}
function GenericToolBlock({ item }: { item: ChatItem }) {
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-gray-50 text-gray-600')} open={!!item.running || !!item.text}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />{item.title}</summary>{item.text && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{item.text}</pre>}
  </details>;
}
function DiffView({ edits, fallback }: any) {
  const normalized = Array.isArray(edits) ? edits : [];
  if (normalized.length === 0) return fallback ? <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs text-gray-700">{fallback}</pre> : null;
  return <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white font-mono text-xs">
    {normalized.map((edit: any, index: number) => <div key={index} className="border-b border-gray-100 last:border-b-0">
      {String(edit.oldText || '').split('\n').map((line, i) => <div key={'old-' + i} className="flex bg-red-50 text-red-800"><span className="w-8 shrink-0 select-none border-r border-red-100 px-2 text-right text-red-300">-</span><span className="whitespace-pre-wrap px-3">{line || ' '}</span></div>)}
      {String(edit.newText || '').split('\n').map((line, i) => <div key={'new-' + i} className="flex bg-green-50 text-green-800"><span className="w-8 shrink-0 select-none border-r border-green-100 px-2 text-right text-green-300">+</span><span className="whitespace-pre-wrap px-3">{line || ' '}</span></div>)}
    </div>)}
  </div>;
}
function AddedFileView({ content }: any) {
  return <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white font-mono text-xs">
    {String(content || '').split('\n').map((line, i) => <div key={i} className="flex bg-green-50 text-green-800"><span className="w-8 shrink-0 select-none border-r border-green-100 px-2 text-right text-green-300">+</span><span className="whitespace-pre-wrap px-3">{line || ' '}</span></div>)}
  </div>;
}
function ModelControls({ models, state, loadState }: any) {
  const modelKey = (m: any) => (m?.provider || '') + '::' + (m?.id || '');
  const current = state?.model ? modelKey(state.model) : '';
  return <><select className="w-32 border-0 bg-transparent text-sm font-medium outline-none" value={current} onChange={async e => { const model = models.find((m: any) => modelKey(m) === e.target.value); if (model) await fetch('/api/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: model.provider, modelId: model.id }) }); await loadState(); }}>
    <option value="">Model</option>{models.map((m: any) => <option key={modelKey(m)} value={modelKey(m)}>{m.name || m.id}</option>)}
  </select><select className="w-24 border-0 bg-transparent text-sm font-medium text-gray-500 outline-none" value={state?.thinkingLevel || 'off'} onChange={async e => { await fetch('/api/thinking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: e.target.value }) }); await loadState(); }}><option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option></select></>;
}
function Menu({ x, y, children, onClose }: any) { useEffect(() => { const fn = () => onClose(); setTimeout(() => document.addEventListener('click', fn), 0); return () => document.removeEventListener('click', fn); }, []); return <div className="fixed z-50 min-w-40 rounded-xl border border-gray-200 bg-white p-1.5 shadow-pi" style={{ left: Math.min(x, window.innerWidth - 180), top: y }} onClick={e => e.stopPropagation()}>{children}</div>; }
function MenuItem({ children, onClick, neutral }: any) { return <button className={'block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 ' + (neutral ? 'text-gray-700' : 'text-red-700 hover:bg-red-50')} onClick={onClick}>{children}</button>; }
function SearchModal({ projects, onClose, onOpen }: any) { const [q, setQ] = useState(''); const results = projects.flatMap((project: ProjectInfo) => project.sessions.filter(s => (sessionTitle(s) + ' ' + (s.firstMessage || '') + ' ' + project.cwd).toLowerCase().includes(q.toLowerCase())).map(session => ({ project, session }))).slice(0, 50); return <Modal onClose={onClose}><div className="flex items-center gap-3 border-b p-4 text-lg"><span>⌕</span><input autoFocus className="flex-1 outline-none" placeholder="Search projects and sessions…" value={q} onChange={e => setQ(e.target.value)} /></div><div className="max-h-[70vh] overflow-auto p-2">{!q && <div className="p-8 text-center text-gray-400">Type to search projects and sessions</div>}{q && results.length === 0 && <div className="p-8 text-center text-gray-400">No results</div>}{results.map(({ project, session }: any) => <button key={session.path} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-gray-100" onClick={() => onOpen(project, session)}><div className="font-bold">{sessionTitle(session)}</div><div className="text-sm text-gray-500">{shortPath(project.cwd)} · {relTime(session.modified)}</div></button>)}</div></Modal>; }
function FolderModal({ path, entries, browse, close, select }: any) { return <Modal onClose={close}><div className="flex items-center justify-between border-b p-4"><h2 className="font-bold">Add project</h2><button className="rounded-lg bg-gray-100 px-3 py-2" onClick={close}>Cancel</button></div><div className="border-b px-4 py-2 font-mono text-xs text-gray-500">{path}</div><div className="max-h-[60vh] overflow-auto p-2">{entries.map((entry: any) => <button key={entry.path} className={'block w-full rounded-lg px-3 py-2 text-left ' + (entry.type === 'directory' ? 'hover:bg-gray-100' : 'text-gray-400')} disabled={entry.type !== 'directory'} onClick={() => browse(entry.path)}>{entry.parent ? '↰' : entry.type === 'directory' ? '▱' : '·'} {entry.name}</button>)}</div><div className="flex justify-end gap-2 border-t p-4"><button className="rounded-xl bg-gray-100 px-4 py-2" onClick={close}>Cancel</button><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={select}>Select folder</button></div></Modal>; }
function Modal({ children, onClose }: any) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/30 p-5" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="w-[min(760px,94vw)] max-w-3xl overflow-hidden rounded-[18px] border border-gray-200 bg-white shadow-modal">{children}</div></div>;
}
function CommandOutputModal({ command, text, onClose }: any) { return <Modal onClose={onClose}><div className="flex items-center justify-between border-b p-4"><h2 className="font-bold">{command}</h2><button className="rounded-lg bg-gray-100 px-3 py-2" onClick={onClose}>Close</button></div><pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-gray-700">{text}</pre></Modal>; }
function SkillsView({ skills, reload, openModal }: any) {
  const [query, setQuery] = useState('');
  useEffect(() => { reload(); }, []);
  const filtered = skills.filter((s: any) => (s.name + ' ' + (s.description || '') + ' ' + (s.path || '')).toLowerCase().includes(query.toLowerCase()));
  return <main className="flex-1 overflow-auto px-6 pb-10 pt-20"><div className="mx-auto max-w-6xl">
    <div className="mb-6 overflow-hidden rounded-[28px] border border-gray-200 bg-gradient-to-br from-[#fbfaf6] to-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><h2 className="text-3xl font-bold text-gray-900">Skills</h2><button className="w-fit rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={() => openModal(true)}>Add skill</button></div>
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3"><span className="text-gray-400">⌕</span><input className="flex-1 outline-none" placeholder="Search skills…" value={query} onChange={e => setQuery(e.target.value)} /><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">{filtered.length} / {skills.length}</span></div>
    </div>
    {filtered.length === 0 ? <Empty>No skills found.</Empty> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((s: any) => <SkillTile key={s.path} skill={s} open={() => openModal(s)} reload={reload} />)}</div>}
  </div></main>;
}
function SkillTile({ skill, open, reload }: any) {
  const excerpt = String(skill.content || '').replace(/^---[\s\S]*?---/, '').trim().split(/\s+/).slice(0, 26).join(' ');
  return <button className="group flex min-h-56 flex-col rounded-[24px] border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-piAccent/40 hover:shadow-pi" onClick={open}>
    <div className="mb-4 flex items-start justify-between gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-piAccent text-xl font-bold text-white">✦</div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">Skill</span></div>
    <h3 className="text-lg font-bold text-gray-900 group-hover:text-piAccent">{skill.name}</h3><p className="mt-2 line-clamp-2 text-sm text-gray-500">{skill.description || 'No description'}</p>
    <p className="mt-4 line-clamp-4 flex-1 text-xs leading-5 text-gray-400">{excerpt || 'No instructions yet.'}</p>
    <div className="mt-4 flex items-center justify-between gap-2 border-t border-gray-100 pt-3"><span className="min-w-0 truncate text-xs text-gray-400">{skill.path}</span><span className="flex gap-2 text-sm text-piAccent"><span>Edit</span><span onClick={async e => { e.stopPropagation(); if (confirm('Delete skill "' + skill.name + '"?')) { await fetch('/api/skills', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: skill.path }) }); reload(); } }}>Delete</span></span></div>
  </button>;
}
function ToolsView({ tools, customTools, saveTools, openModal }: any) {
  const [query, setQuery] = useState('');
  const filtered = tools.filter((t: any) => (t.name + ' ' + (t.description || '') + ' ' + (t.content || '')).toLowerCase().includes(query.toLowerCase()));
  return <main className="flex-1 overflow-auto px-6 pb-10 pt-20"><div className="mx-auto max-w-6xl">
    <div className="mb-6 overflow-hidden rounded-[28px] border border-gray-200 bg-gradient-to-br from-[#fbfaf6] to-white p-6 shadow-sm"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><h2 className="text-3xl font-bold text-gray-900">Tools</h2><button className="w-fit rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={() => openModal(true)}>Add tool</button></div><div className="mt-5 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3"><span className="text-gray-400">⌕</span><input className="flex-1 outline-none" placeholder="Search tools…" value={query} onChange={e => setQuery(e.target.value)} /><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">{filtered.length} / {tools.length}</span></div></div>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((t: any) => <ToolTile key={t.id || t.name} tool={t} open={() => openModal(t)} canEdit={!t.builtin} canDelete={!t.builtin} onDelete={() => { if (confirm('Delete tool "' + t.name + '"?')) saveTools(customTools.filter((x: any) => x.id !== t.id)); }} />)}</div>
  </div></main>;
}
function ToolTile({ tool, open, canEdit, canDelete, onDelete }: any) {
  const excerpt = String(tool.content || '').trim().split(/\s+/).slice(0, 28).join(' ');
  return <button className="group flex min-h-56 flex-col rounded-[24px] border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-piAccent/40 hover:shadow-pi" onClick={canEdit ? open : undefined}>
    <div className="mb-4 flex items-start justify-between gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-piAccent text-xl font-bold text-white">⚙</div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">{tool.builtin ? 'Built-in' : 'Custom'}</span></div>
    <h3 className="text-lg font-bold text-gray-900 group-hover:text-piAccent">{tool.name}</h3><p className="mt-2 line-clamp-2 text-sm text-gray-500">{tool.description || 'No description'}</p><p className="mt-4 line-clamp-4 flex-1 text-xs leading-5 text-gray-400">{excerpt || 'No instructions.'}</p>
    <div className="mt-4 flex items-center justify-end gap-3 border-t border-gray-100 pt-3 text-sm text-piAccent">{canEdit && <span>Edit</span>}{canDelete && <span onClick={e => { e.stopPropagation(); onDelete(); }}>Delete</span>}{tool.builtin && <span className="text-gray-400">Read-only</span>}</div>
  </button>;
}
function AgentsView({ builtinAgents, customAgents, saveAgents, openModal }: any) {
  const [query, setQuery] = useState('');
  const all = [...builtinAgents.map((a: any) => ({ ...a, _custom: false })), ...customAgents.map((a: any) => ({ ...a, _custom: true }))];
  const matches = (a: any) => (a.name + ' ' + (a.description || '') + ' ' + (a.systemPrompt || '') + ' ' + (a.skills || []).join(' ') + ' ' + (a.tools || []).join(' ')).toLowerCase().includes(query.toLowerCase());
  const filteredBuiltins = builtinAgents.filter(matches);
  const filteredCustom = customAgents.filter(matches);
  const renderAgent = (a: any, custom = false) => <AgentTile key={a.id} agent={a} custom={custom} onEdit={() => openModal(a)} onDelete={custom ? () => { if (confirm('Delete agent "' + a.name + '"?')) saveAgents(customAgents.filter((x: any) => x.id !== a.id)); } : null} />;
  return <main className="flex-1 overflow-auto px-6 pb-10 pt-20"><div className="mx-auto max-w-6xl">
    <div className="mb-6 overflow-hidden rounded-[28px] border border-gray-200 bg-gradient-to-br from-[#fbfaf6] to-white p-6 shadow-sm"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><h2 className="text-3xl font-bold text-gray-900">Agents</h2><button className="w-fit rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={() => openModal(true)}>Add custom agent</button></div><div className="mt-5 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3"><span className="text-gray-400">⌕</span><input className="flex-1 outline-none" placeholder="Search agents…" value={query} onChange={e => setQuery(e.target.value)} /><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">{filteredBuiltins.length + filteredCustom.length} / {all.length}</span></div></div>
    <section className="mb-8"><h2 className="mb-4 text-xl font-bold">Built-in agents</h2><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filteredBuiltins.map((a: any) => renderAgent(a, false))}</div></section>
    <section><h2 className="mb-4 text-xl font-bold">Custom agents</h2>{filteredCustom.length === 0 ? <Empty>No custom agents yet.</Empty> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filteredCustom.map((a: any) => renderAgent(a, true))}</div>}</section>
  </div></main>;
}
function AgentTile({ agent, custom, onEdit, onDelete }: any) {
  const prompt = String(agent.systemPrompt || '').trim().split(/\s+/).slice(0, 28).join(' ');
  return <button className="group flex min-h-60 flex-col rounded-[24px] border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-piAccent/40 hover:shadow-pi" onClick={onEdit}>
    <div className="mb-4 flex items-start justify-between gap-3"><div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-piAccent text-xl font-bold text-white">{agent.icon ? <img src={agent.icon} className="h-full w-full object-cover" /> : (agent.name || 'A')[0]}</div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">{agent.enabled === false ? 'Disabled' : (custom ? 'Custom' : 'Built-in')}</span></div>
    <h3 className="text-lg font-bold text-gray-900 group-hover:text-piAccent">{agent.name}</h3><p className="mt-2 line-clamp-2 text-sm text-gray-500">{agent.description || 'No description'}</p><p className="mt-4 line-clamp-3 text-xs leading-5 text-gray-400">{prompt || 'No system prompt.'}</p>
    <div className="mt-4 flex flex-wrap gap-1">{(agent.skills || []).slice(0, 3).map((s: string) => <span key={s} className="rounded-full bg-[#f2f4ff] px-2 py-1 text-[11px] text-piAccent">{s}</span>)}{(agent.tools || []).slice(0, 4).map((t: string) => <span key={t} className="rounded-full bg-gray-100 px-2 py-1 text-[11px] text-gray-500">{t}</span>)}</div>
    <div className="mt-auto flex items-center justify-end gap-3 border-t border-gray-100 pt-3 text-sm text-piAccent"><span>Edit</span>{onDelete && <span onClick={e => { e.stopPropagation(); onDelete(); }}>Delete</span>}</div>
  </button>;
}
function Page({ title, action, onAction, children }: any) { return <main className="flex-1 overflow-auto px-6 pb-10 pt-20"><div className="mx-auto max-w-4xl"><section><div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-bold">{title}</h2><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={onAction}>{action}</button></div><div className="space-y-3">{children}</div></section></div></main>; }
function Empty({ children }: any) { return <div className="rounded-2xl border border-gray-200 bg-white p-5 text-gray-500">{children}</div>; }
function Card({ icon, title, desc, meta, content, badge, actions }: any) { const [open, setOpen] = useState(false); return <div className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white p-4"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-piAccent font-bold text-white">{icon}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-bold">{title}<span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">{badge}</span></div><div className="mt-1 text-sm text-gray-500">{desc || 'No description'}</div>{meta && <div className="mt-1 truncate text-xs text-gray-400">{meta}</div>}<div className="mt-3 flex gap-2 text-sm text-piAccent [&>button]:rounded-lg [&>button]:bg-gray-100 [&>button]:px-3 [&>button]:py-1"><button onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Expand'}</button>{actions}</div>{open && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-50 p-3 text-xs">{content}</pre>}</div></div>; }
function SkillModal({ skill, onClose, onSave }: any) {
  const parsed = parseFrontmatter(skill?.content || '');
  const meta = skill?.meta || parsed.meta || {};
  const [name, setName] = useState(skill?.name || meta.name || '');
  const [description, setDescription] = useState(skill?.description || meta.description || '');
  const [content, setContent] = useState(skill?.body || parsed.body || '');
  const [metaFields, setMetaFields] = useState<any[]>(Object.entries(meta).filter(([key]) => key !== 'name' && key !== 'description').map(([key, value]) => ({ key, value })));
  const updateMetaField = (index: number, patch: any) => setMetaFields(metaFields.map((field, i) => i === index ? { ...field, ...patch } : field));
  return <EditorModal title={skill ? 'Edit skill' : 'Create skill'} onClose={onClose} onSave={() => onSave({ name, description, content, metaFields, path: skill?.path })}>
    <Field label="Name"><input disabled={!!skill} value={name} onChange={e => setName(e.target.value)} /></Field>
    <Field label="Description"><input value={description} onChange={e => setDescription(e.target.value)} /></Field>
    <Field label="Instructions"><textarea value={content} onChange={e => setContent(e.target.value)} /></Field>
    <div><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold text-gray-600">Additional metadata</span><button type="button" className="rounded-lg bg-gray-100 px-3 py-1 text-sm" onClick={() => setMetaFields([...metaFields, { key: '', value: '' }])}>Add field</button></div>
      <div className="space-y-2">{metaFields.length === 0 ? <div className="text-sm text-gray-400">No additional fields.</div> : metaFields.map((field, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2"><input placeholder="field" value={field.key} onChange={e => updateMetaField(index, { key: e.target.value })} /><input placeholder="value" value={field.value} onChange={e => updateMetaField(index, { value: e.target.value })} /><button type="button" className="rounded-xl bg-gray-100 px-3" onClick={() => setMetaFields(metaFields.filter((_, i) => i !== index))}>×</button></div>)}</div>
    </div>
  </EditorModal>;
}
function ToolModal({ tool, onClose, onSave }: any) { const [name, setName] = useState(tool?.name || ''); const [description, setDescription] = useState(tool?.description || ''); const [content, setContent] = useState(tool?.content || ''); return <EditorModal title={tool ? 'Edit tool' : 'Create tool'} onClose={onClose} onSave={() => onSave({ ...tool, name, description, content })}><Field label="Name"><input disabled={!!tool} value={name} onChange={e => setName(e.target.value)} /></Field><Field label="Description"><input value={description} onChange={e => setDescription(e.target.value)} /></Field><Field label="Content"><textarea value={content} onChange={e => setContent(e.target.value)} /></Field></EditorModal>; }
function AgentModal({ agent, skills, tools, onClose, onSave }: any) {
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [enabled, setEnabled] = useState(agent?.enabled !== false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(agent?.skills || []);
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools || []);
  const toggle = (list: string[], setList: any, value: string) => setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  return <EditorModal title={agent ? (agent.builtin ? 'Edit built-in agent' : 'Edit custom agent') : 'Create custom agent'} onClose={onClose} onSave={() => onSave({ ...agent, name, description, systemPrompt, enabled, skills: selectedSkills, tools: selectedTools })}>
    <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
    <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled</label>
    <Field label="Short description"><input value={description} onChange={e => setDescription(e.target.value)} /></Field>
    <Field label="System prompt"><textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} /></Field>
    <Checklist title="Skills this agent can use" empty="No skills found." items={skills.map((skill: any) => ({ key: skill.name, label: skill.name, desc: skill.description }))} selected={selectedSkills} toggle={(value: string) => toggle(selectedSkills, setSelectedSkills, value)} />
    <Checklist title="Tools this agent can use" items={tools.map((tool: any) => ({ key: tool.name, label: tool.name, desc: tool.description }))} selected={selectedTools} toggle={(value: string) => toggle(selectedTools, setSelectedTools, value)} />
  </EditorModal>;
}
function Checklist({ title, items, selected, toggle, empty }: any) { return <div><div className="mb-2 text-sm font-semibold text-gray-600">{title}</div><div className="max-h-44 overflow-auto rounded-xl border border-gray-200 p-2">{items.length === 0 ? <div className="p-2 text-sm text-gray-400">{empty || 'Nothing available.'}</div> : items.map((item: any) => <label key={item.key} className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-gray-50"><input type="checkbox" className="mt-1" checked={selected.includes(item.key)} onChange={() => toggle(item.key)} /><span><span className="block text-sm font-medium">{item.label}</span>{item.desc && <span className="block text-xs text-gray-400">{item.desc}</span>}</span></label>)}</div></div>; }
function EditorModal({ title, children, onClose, onSave }: any) { return <Modal onClose={onClose}><div className="flex items-center justify-between border-b p-4"><h2 className="font-bold">{title}</h2><button className="rounded-lg bg-gray-100 px-3 py-2" onClick={onClose}>Cancel</button></div><div className="space-y-4 p-4 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-gray-300 [&_input]:p-3 [&_textarea]:h-64 [&_textarea]:w-full [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-gray-300 [&_textarea]:p-3">{children}</div><div className="flex justify-end gap-2 border-t p-4"><button className="rounded-xl bg-gray-100 px-4 py-2" onClick={onClose}>Cancel</button><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={onSave}>Save</button></div></Modal>; }
function Field({ label, children }: any) { return <label className="block"><span className="mb-1 block text-sm font-semibold text-gray-600">{label}</span>{children}</label>; }

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
