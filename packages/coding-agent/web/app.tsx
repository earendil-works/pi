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

type GitChangedLines = {
  added: number;
  deleted: number;
  total: number;
};

type GitProjectStatus = {
  cwd: string;
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  hasRemote: boolean;
  ghLoggedIn: boolean;
  githubReady: boolean;
  changedLines: GitChangedLines;
  lastCheckpointAt: string | null;
  lastCheckpointRef: string | null;
  error: string | null;
};

type ChatItem = {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'thinking' | 'question';
  title: string;
  text: string;
  running?: boolean;
  error?: boolean;
  toolName?: string;
  args?: any;
};

type ViewName = 'chat' | 'agents' | 'skills' | 'tools';
type ThemePreference = 'system' | 'light' | 'dark';

declare const React: any;
declare const ReactDOM: any;

const {
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
  projectRouteId,
  conversationRouteId,
  sessionRoute,
  routeInfo,
  formatK,
  useEffect,
  useMemo,
  useRef,
  useState,
} = (window as any).PiWebShared;

const {
  SidebarButton,
  NewChatIcon,
  SearchIcon,
  ProjectTree,
  ChatView,
  TerminalPane,
  Menu,
  MenuItem,
  SearchModal,
  FolderModal,
  CommandOutputModal,
  SkillsView,
  ToolsView,
  AgentsView,
  SkillModal,
  ToolModal,
  AgentModal,
} = (window as any).PiWebComponents;

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
  const [progressTracker, setProgressTracker] = useState<any>(null);
  const [gitStatus, setGitStatus] = useState<GitProjectStatus | null>(null);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [gitPanelHidden, setGitPanelHidden] = useState(() => localStorage.getItem('piWebGitPanelHidden') === 'true');
  const [gitBusy, setGitBusy] = useState('');
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
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
  const [terminalOpenByProject, setTerminalOpenByProject] = useState<Record<string, boolean>>(() => safeJson(localStorage.getItem('piWebTerminalOpenByProject'), {}));
  const [terminalOpen, setTerminalOpenState] = useState(false);
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem('piWebTheme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches || false);
  const activeTools = useRef<Record<string, string>>({});
  const activeAssistantId = useRef<string | null>(null);
  const activeThinkingId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const stateRef = useRef<any>(null);
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
  const currentProjectCwd = useMemo(() => {
    if (state?.cwd) return state.cwd;
    return projects.find(project => project.sessions.some(session => session.path === currentSessionPath))?.cwd || '';
  }, [projects, currentSessionPath, state?.cwd]);

  function pushRoute(path: string) { if (location.pathname !== path) history.pushState({}, '', path); }
  function replaceRoute(path: string) { if (location.pathname !== path) history.replaceState({}, '', path); }
  function go(path: string, nextView?: ViewName) { pushRoute(path); if (nextView) setView(nextView); applyRoute(projects); }
  function setTerminalOpen(value: boolean) {
    const key = currentProjectCwd || 'default';
    setTerminalOpenState(value);
    setTerminalOpenByProject(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('piWebTerminalOpenByProject', JSON.stringify(next));
      return next;
    });
  }
  function setThemePreference(value: ThemePreference) {
    setThemePreferenceState(value);
    localStorage.setItem('piWebTheme', value);
  }
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
    try { const json = await (await fetch('/api/progress-tracker')).json(); setProgressTracker(json.data || null); } catch { setProgressTracker(null); }
    await loadGitStatus();
  }
  async function loadGitStatus() {
    try { const json = await (await fetch('/api/git/status')).json(); setGitStatus(json.data || null); } catch { setGitStatus(null); }
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
    const previousRoute = window.location.pathname + window.location.search;
    if (updateUrl) pushRoute(sessionRoute(project, session));
    if (currentSessionPath === session.path) return;
    setStatus('switching session…');
    setQueue([]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch('/api/switch-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: session.path }), signal: controller.signal });
      if (!res.ok) throw new Error(await res.text());
      setCurrentSessionPath(session.path);
      await loadMessages();
      setProgressTracker(null);
      await loadState();
    } catch (err: any) {
      const message = err?.name === 'AbortError' ? 'Session switch timed out.' : String(err?.message || err);
      addItem({ kind: 'tool', title: 'Session switch failed', text: message, error: true });
      if (updateUrl) replaceRoute(previousRoute);
    } finally {
      clearTimeout(timeout);
      setStatus('ready');
    }
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
    setProgressTracker(null);
    setStatus('ready');
    await loadProjects();
  }

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { stateRef.current = state; }, [state]);
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
    const key = currentProjectCwd || 'default';
    setTerminalOpenState(view === 'chat' && terminalOpenByProject[key] === true);
  }, [currentProjectCwd, terminalOpenByProject, view]);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    const dark = themePreference === 'dark' || (themePreference === 'system' && systemDark);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [themePreference, systemDark]);
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
    if (e.type === 'ask_question') {
      setMessages(prev => prev.some(item => item.id === e.id) ? prev : [...prev, { id: e.id, kind: 'question', title: 'Question', text: e.question, running: true, args: { request: e, options: e.options || [] } }]);
      setStatus('waiting for answer…');
    }
    if (e.type === 'progress_tracker') {
      setProgressTracker((current: any) => {
        const sessionFile = stateRef.current?.sessionFile;
        return (!sessionFile || sessionFile === e.sessionFile || current?.sessionFile === e.sessionFile) ? { sessionFile: e.sessionFile, path: e.path, tasks: e.tasks || [] } : current;
      });
    }
    if (e.type === 'progress_tracker_removed') {
      setProgressTracker((current: any) => current?.sessionFile === e.sessionFile ? null : current);
    }
    if (e.type === 'git_status' || e.type === 'git_checkpoint') {
      setGitStatus(e.data || null);
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
      if (id) updateItem(id, item => ({ ...item, text: toolResultText(e.partialResult) || item.text, images: toolResultImages(e.partialResult) || item.images }));
    }
    if (e.type === 'tool_execution_end') {
      const id = e.toolCallId || e.id;
      if (id) updateItem(id, item => ({ ...item, text: toolResultText(e.result) || item.text, images: toolResultImages(e.result) || item.images, running: false, error: !!(e.error || e.isError) }));
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
      if (msg.role === 'user') result.push({ id: uid('user'), kind: 'user', title: 'You', text: messageText(msg), images: contentImages(msg.content) });
      else if (msg.role === 'assistant') {
        let text = '';
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === 'text') text += block.text || '';
          if (block.type === 'toolCall') result.push({ id: uid('tool'), kind: 'tool', title: formatToolTitle(block.name, block.arguments), text: toolResultText(toolResults.get(block.id)), images: toolResultImages(toolResults.get(block.id)), running: false, error: !!toolResults.get(block.id)?.isError, toolName: block.name, args: block.arguments || {} });
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
  async function answerQuestion(request: any, answer: any) {
    if (!request?.id) return;
    setStatus('sending answer…');
    try {
      const res = await fetch('/api/ask-question/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: request.id, ...answer }) });
      if (!res.ok) throw new Error(await res.text());
      updateItem(request.id, item => ({ ...item, title: 'Question answered', running: false, args: { ...(item.args || {}), answer } }));
      setStatus('answer sent');
      setTimeout(() => setStatus('ready'), 1200);
    } catch (err: any) {
      updateItem(request.id, item => ({ ...item, running: false, error: true }));
      addItem({ kind: 'tool', title: 'Question answer failed', text: String(err.message || err), error: true });
      setStatus('ready');
    }
  }
  async function removeProgressTracker() {
    const previous = progressTracker;
    setProgressTracker(null);
    try {
      const res = await fetch('/api/progress-tracker', { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
    } catch (err: any) {
      setProgressTracker(previous);
      addItem({ kind: 'tool', title: 'Progress tracker remove failed', text: String(err.message || err), error: true });
    }
  }
  async function runGitAction(action: string, body?: Record<string, unknown>) {
    setGitBusy(action);
    try {
      const res = await fetch('/api/git/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json().catch(() => null);
      setGitStatus(json?.data || null);
    } catch (err: any) {
      addItem({ kind: 'tool', title: 'Git ' + action + ' failed', text: String(err.message || err), error: true });
      await loadGitStatus();
    } finally {
      setGitBusy('');
    }
  }
  function openCommitModal() {
    setCommitMessage('');
    setCommitModalOpen(true);
  }
  async function confirmCommit(ev: { preventDefault(): void }) {
    ev.preventDefault();
    const message = commitMessage.trim();
    if (!message) return;
    setCommitModalOpen(false);
    await runGitAction('commit', { message });
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

  const gitPanelVisible = view === 'chat';
  function setDesktopGitPanelHidden(hidden: boolean) {
    setGitPanelHidden(hidden);
    localStorage.setItem('piWebGitPanelHidden', hidden ? 'true' : 'false');
  }

  return <div className="grid h-screen grid-cols-[290px_minmax(0,1fr)] bg-white text-[#202124] dark:bg-black dark:text-slate-100 max-[820px]:grid-cols-1">
    {sidebarOpen && <div className="fixed inset-0 z-30 bg-gray-900/30 min-[821px]:hidden" onClick={() => setSidebarOpen(false)} />}
    <aside className={'h-screen overflow-y-auto bg-piPanel px-3 py-3 text-piText scrollbar-thin dark:bg-neutral-950 dark:text-slate-100 max-[820px]:fixed max-[820px]:inset-y-0 max-[820px]:left-0 max-[820px]:z-40 max-[820px]:w-[290px] max-[820px]:transition-transform ' + (sidebarOpen ? 'max-[820px]:translate-x-0' : 'max-[820px]:-translate-x-full')}>
      <SidebarButton icon={<NewChatIcon />} label="New chat" onClick={() => { setSidebarOpen(false); newChat(); }} />
      <SidebarButton icon={<SearchIcon />} label="Search" onClick={() => { setSidebarOpen(false); setSearchOpen(true); }} />
      <SidebarButton icon="◎" label="Agents" onClick={() => { setSidebarOpen(false); go('/agents', 'agents'); }} />
      <SidebarButton icon="✦" label="Skills" onClick={() => { setSidebarOpen(false); go('/skills', 'skills'); loadSkills(); }} />
      <SidebarButton icon="⚙" label="Tools" onClick={() => { setSidebarOpen(false); go('/tools', 'tools'); }} />
      <SidebarButton icon="＋" label="Add project" onClick={() => browseFolder('')} />
      <div className="mx-1 mb-2 mt-4 text-[11px] font-medium uppercase tracking-wide text-[#9a9a9a] dark:text-slate-500">Projects</div>
      <div className="space-y-1.5">
        {filteredProjects.length === 0 && <div className="pl-8 text-[11px] text-piMuted">No projects yet. Use Add project to open a folder.</div>}
        {filteredProjects.map(project => <ProjectTree key={project.cwd} project={project} collapsed={collapsedProjects.has(project.cwd) && !projectQuery} icon={projectIcons[project.cwd]} currentSessionPath={currentSessionPath} onToggle={() => setCollapsed(project.cwd)} onOpen={(project: ProjectInfo, session: SessionInfo, updateUrl: boolean) => { setSidebarOpen(false); openSession(project, session, updateUrl); }} onMenu={(kind, payload, ev) => setMenu({ kind, payload, x: ev.currentTarget.getBoundingClientRect().left, y: ev.currentTarget.getBoundingClientRect().bottom + 6 })} />)}
      </div>
    </aside>
    <section className="relative flex h-screen min-w-0 flex-col">
      {view === 'chat' && <header className="fixed left-[290px] right-0 top-0 z-10 flex h-12 items-center justify-between border-b border-gray-100 bg-white/95 px-4 dark:border-neutral-900 dark:bg-black/95 max-[820px]:left-0">
        <div className="flex items-center gap-2"><button type="button" className="hidden rounded-lg bg-gray-100 px-2 py-1 text-gray-700 dark:bg-neutral-900 dark:text-slate-200 max-[820px]:block" onClick={() => setSidebarOpen(true)}>☰</button><h1 className="text-xs font-semibold">π Pi Web</h1></div>
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400"><ThemeToggle value={themePreference} onChange={setThemePreference} /><span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-neutral-900 dark:text-slate-300">{contextText}</span><span>{status}</span><button type="button" className={'rounded-lg px-3 py-1 font-semibold text-gray-700 hover:bg-gray-200 dark:text-slate-200 dark:hover:bg-neutral-800 max-[1099px]:hidden ' + (gitPanelHidden ? 'bg-gray-100 dark:bg-neutral-900' : 'bg-gray-200 dark:bg-neutral-800')} onClick={() => setDesktopGitPanelHidden(!gitPanelHidden)}>Git</button><button type="button" className="hidden rounded-lg bg-gray-100 px-3 py-1 font-semibold text-gray-700 hover:bg-gray-200 dark:bg-neutral-900 dark:text-slate-200 dark:hover:bg-neutral-800 max-[1099px]:block" onClick={() => setGitPanelOpen(true)}>Git</button><button type="button" className={'rounded-lg px-3 py-1 font-semibold ' + (terminalOpen ? 'bg-gray-900 text-white dark:bg-slate-100 dark:text-black' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-neutral-900 dark:text-slate-200 dark:hover:bg-neutral-800')} onClick={() => setTerminalOpen(!terminalOpen)}>Terminal</button></div>
      </header>}
      {view !== 'chat' && <header className="fixed left-[290px] right-0 top-0 z-10 flex h-12 items-center justify-between border-b border-gray-100 bg-white/95 px-4 dark:border-neutral-900 dark:bg-black/95 max-[820px]:left-0">
        <div className="flex items-center gap-2"><button type="button" className="hidden rounded-lg bg-gray-100 px-2 py-1 text-gray-700 dark:bg-neutral-900 dark:text-slate-200 max-[820px]:block" onClick={() => setSidebarOpen(true)}>☰</button><h1 className="text-xs font-semibold">{view === 'skills' ? 'Skills' : view === 'tools' ? 'Tools' : 'Agents'}</h1></div>
        <div className="flex items-center gap-3 text-xs text-gray-400 dark:text-slate-500"><ThemeToggle value={themePreference} onChange={setThemePreference} /><span>π Pi Web</span></div>
      </header>}
      {view === 'chat' && <ChatView logRef={logRef} messages={messages} input={input} setInput={setInput} submitPrompt={submitPrompt} submitMessage={submitMessage} answerQuestion={answerQuestion} abortGeneration={abortGeneration} busy={busy} queuedPrompts={queuedPrompts} removeQueuedPrompt={(id: string) => setQueue(queuedPromptsRef.current.filter(item => item.id !== id))} progressTracker={progressTracker} removeProgressTracker={removeProgressTracker} models={models} commands={commands} state={state} loadState={loadState} focusKey={(state?.cwd || '') + ':' + currentSessionPath} terminalOpen={terminalOpen} setTerminalOpen={setTerminalOpen} />}
      {view === 'skills' && <SkillsView skills={skills} reload={async () => { await loadSkills(); await loadCommands(); }} openModal={setSkillModal} />}
      {view === 'tools' && <ToolsView tools={[...builtinTools, ...tools]} openModal={setToolModal} saveTools={saveTools} customTools={tools} />}
      {view === 'agents' && <AgentsView builtinAgents={builtinAgents.map(agent => ({ ...agent, systemPrompt: mainSystemPrompt, skills: skills.filter((skill: any) => skill.name !== 'ask-question' && skill.name !== 'progress-tracker').map((skill: any) => skill.name), tools: [...builtinTools, ...tools].map((tool: any) => tool.name), ...(builtinAgentOverrides[agent.id] || {}) }))} customAgents={agents} openModal={setAgentModal} saveAgents={saveAgents} />}
    </section>
    {gitPanelVisible && (!gitPanelHidden || gitPanelOpen) && <GitPanel status={gitStatus} busy={gitBusy} mobileOpen={gitPanelOpen} closeMobile={() => setGitPanelOpen(false)} hideDesktop={() => setDesktopGitPanelHidden(true)} refresh={loadGitStatus} commit={openCommitModal} push={() => runGitAction('push')} init={() => runGitAction('init')} createRepo={() => runGitAction('create-github-repo')} />}
    {commitModalOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4" onClick={() => setCommitModalOpen(false)}>
      <form className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-4 shadow-pi dark:border-neutral-800 dark:bg-neutral-950" onClick={ev => ev.stopPropagation()} onSubmit={confirmCommit}>
        <div className="mb-3 text-xs font-bold text-gray-900 dark:text-slate-100">Commit changes</div>
        <input autoFocus className="mb-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-[#6c5ce7] dark:border-neutral-800 dark:bg-black dark:text-slate-100" value={commitMessage} onChange={ev => setCommitMessage(ev.target.value)} placeholder="Commit message" />
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 dark:bg-neutral-900 dark:text-slate-200" onClick={() => setCommitModalOpen(false)}>Cancel</button>
          <button type="submit" className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-black" disabled={!commitMessage.trim()}>Commit</button>
        </div>
      </form>
    </div>}
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
    {agentModal && <AgentModal agent={agentModal === true ? null : agentModal} skills={skills} tools={[...builtinTools, ...tools]} cwd={state?.cwd} onClose={() => setAgentModal(null)} onSave={(agent: any) => { if (agent.builtin) saveBuiltinAgent(agent); else if (agent.id) saveAgents(agents.map(a => a.id === agent.id ? agent : a)); else saveAgents([...agents, { ...agent, id: uid('agent'), createdAt: new Date().toISOString() }]); setAgentModal(null); }} />}
    {commandModal && <CommandOutputModal command={commandModal.title} text={commandModal.text} onClose={() => setCommandModal(null)} />}
  </div>;
}

function ThemeToggle({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options: { value: ThemePreference; label: string; icon: string }[] = [
    { value: 'system', label: 'System theme', icon: '◐' },
    { value: 'light', label: 'Light theme', icon: '☼' },
    { value: 'dark', label: 'Dark theme', icon: '☾' },
  ];
  const selected = options.find(option => option.value === value) || options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  return <div ref={menuRef} className="relative hidden min-[821px]:block">
    <button type="button" title="Theme" aria-label={'Theme: ' + selected.label.replace(' theme', '')} aria-haspopup="menu" aria-expanded={open} className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-700 hover:bg-gray-200 dark:bg-neutral-900 dark:text-slate-200 dark:hover:bg-neutral-800" onClick={() => setOpen(!open)}>{selected.icon}</button>
    {open && <div className="absolute right-0 top-9 z-50 min-w-36 rounded-xl border border-gray-200 bg-white p-1.5 shadow-pi dark:border-neutral-800 dark:bg-neutral-950" role="menu" aria-label="Theme">
      {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={value === option.value} className={'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-neutral-900 ' + (value === option.value ? 'font-semibold text-gray-900 dark:text-slate-100' : 'text-gray-600 dark:text-slate-400')} onClick={() => { onChange(option.value); setOpen(false); }}><span className="w-4 text-center">{option.icon}</span><span>{option.label.replace(' theme', '')}</span></button>)}
    </div>}
  </div>;
}

type GitPanelProps = {
  status: GitProjectStatus | null;
  busy: string;
  mobileOpen: boolean;
  closeMobile(): void;
  hideDesktop(): void;
  refresh(): void;
  commit(): void;
  push(): void;
  init(): void;
  createRepo(): void;
};

function GitPanel({ status, busy, mobileOpen, closeMobile, hideDesktop, refresh, commit, push, init, createRepo }: GitPanelProps) {
  const lines = status?.changedLines || { added: 0, deleted: 0, total: 0 };
  const checkpoint = status?.lastCheckpointAt ? new Date(status.lastCheckpointAt).toLocaleTimeString() : 'none';
  const panelClass = 'fixed right-4 top-16 z-20 max-h-[calc(100vh-5rem)] w-[280px] overflow-y-auto rounded-2xl border border-gray-200 bg-white/95 p-4 shadow-pi backdrop-blur dark:border-neutral-900 dark:bg-black/95 max-[1099px]:inset-0 max-[1099px]:z-50 max-[1099px]:h-screen max-[1099px]:max-h-none max-[1099px]:w-full max-[1099px]:rounded-none max-[1099px]:border-0 ' + (mobileOpen ? 'max-[1099px]:block' : 'max-[1099px]:hidden');
  const buttonClass = 'rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-black';
  const secondaryClass = 'rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-neutral-900 dark:text-slate-200 dark:hover:bg-neutral-800';
  const disabled = !!busy;
  return <aside className={panelClass} aria-label="Git project status">
    <div className="mb-4 flex items-center justify-between gap-2">
      <div><div className="text-xs font-bold text-gray-900 dark:text-slate-100">Git</div><div className="truncate text-[11px] text-gray-400 dark:text-slate-500" title={status?.cwd}>{status?.cwd ? baseName(status.cwd) : 'loading'}</div></div>
      <button type="button" className="rounded-lg bg-gray-100 px-2 py-1 text-xs dark:bg-neutral-900 min-[1100px]:hidden" onClick={closeMobile}>Close</button>
      <button type="button" className="rounded-lg bg-gray-100 px-2 py-1 text-xs dark:bg-neutral-900 max-[1099px]:hidden" onClick={hideDesktop}>Hide</button>
    </div>
    {!status && <div className="text-xs text-gray-500 dark:text-slate-400">Loading git status…</div>}
    {status && <div className="space-y-4 text-xs">
      <div className="rounded-2xl border border-gray-200 p-3 dark:border-neutral-800">
        <div className="mb-2 flex items-center justify-between"><span className="text-gray-500 dark:text-slate-400">Changed lines</span><span className="text-base font-bold text-gray-900 dark:text-slate-100">{lines.total}</span></div>
        <div className="flex gap-2 text-xs"><span className="rounded-full bg-green-50 px-2 py-0.5 text-green-700 dark:bg-green-400/10 dark:text-green-300">+{lines.added}</span><span className="rounded-full bg-red-50 px-2 py-0.5 text-red-700 dark:bg-red-400/10 dark:text-red-300">-{lines.deleted}</span></div>
      </div>
      <div className="space-y-1 text-xs text-gray-500 dark:text-slate-400">
        <div>Repo: <span className="font-medium text-gray-800 dark:text-slate-200">{status.isRepo ? 'ready' : 'not initialized'}</span></div>
        <div>Branch: <span className="font-medium text-gray-800 dark:text-slate-200">{status.branch || 'none'}</span></div>
        <div>Upstream: <span className="font-medium text-gray-800 dark:text-slate-200">{status.upstream || 'none'}</span></div>
        <div>GitHub: <span className="font-medium text-gray-800 dark:text-slate-200">{status.githubReady ? 'ready' : status.ghLoggedIn ? 'needs repo' : 'login needed'}</span></div>
        <div>Checkpoint: <span className="font-medium text-gray-800 dark:text-slate-200">{checkpoint}</span></div>
      </div>
      {status.error && <div className="rounded-xl bg-red-50 p-2 text-xs text-red-700 dark:bg-red-400/10 dark:text-red-300">{status.error}</div>}
      <div className="grid grid-cols-2 gap-2">
        {status.isRepo ? <>
          <button type="button" className={buttonClass} disabled={disabled} onClick={commit}>{busy === 'commit' ? 'Committing…' : 'Commit'}</button>
          <button type="button" className={buttonClass} disabled={disabled || !status.hasRemote} onClick={push}>{busy === 'push' ? 'Pushing…' : 'Push'}</button>
        </> : <button type="button" className={buttonClass + ' col-span-2'} disabled={disabled} onClick={init}>{busy === 'init' ? 'Initializing…' : 'Initialize Git'}</button>}
        {status.isRepo && !status.githubReady && <button type="button" className={secondaryClass + ' col-span-2'} disabled={disabled || !status.ghLoggedIn} onClick={createRepo}>{busy === 'create-github-repo' ? 'Creating…' : 'Create GitHub repo'}</button>}
        <button type="button" className={secondaryClass + ' col-span-2'} disabled={disabled} onClick={refresh}>Refresh</button>
      </div>
      {!status.ghLoggedIn && <div className="text-xs text-gray-400 dark:text-slate-500">Run <code className="rounded bg-gray-100 px-1 dark:bg-neutral-900">gh auth login</code> to enable GitHub setup.</div>}
    </div>}
  </aside>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
