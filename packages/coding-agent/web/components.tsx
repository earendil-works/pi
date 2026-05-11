(() => {
const React = (window as any).React;
const {
  useEffect,
  useRef,
  useState,
  baseName,
  shortPath,
  sessionTitle,
  relTime,
  contentText,
  pretty,
  parseFrontmatter,
  toolResultText,
} = (window as any).PiWebShared;

type ChatItem = any;
type ProjectInfo = any;

function SidebarButton({ icon, label, onClick }: any) { return <button className="mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[18px] font-medium hover:bg-piHover dark:hover:bg-neutral-900" onClick={onClick}><span className="w-6 text-center">{icon}</span><span>{label}</span></button>; }
function ProjectTree({ project, collapsed, icon, currentSessionPath, onToggle, onOpen, onMenu }: any) {
  const shown = collapsed ? [] : project.sessions.slice(0, 10);
  return <div className="mb-5">
    <div className="group mx-1 flex cursor-pointer items-center gap-2 rounded-xl px-1.5 py-1 text-[18px] text-[#666] hover:bg-piHover dark:text-slate-300 dark:hover:bg-neutral-900" onClick={onToggle} title={project.cwd}>
      <span className={'w-4 text-gray-500 transition dark:text-slate-500 ' + (collapsed ? '-rotate-90' : '')}>⌄</span>
      <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-md">{icon ? <img src={icon} className="h-5 w-5 object-cover" /> : '▱'}</span>
      <span className="min-w-0 flex-1 truncate">{shortPath(project.cwd)}</span>
      <button className="rounded-lg px-1.5 text-lg leading-none text-gray-500 opacity-0 hover:bg-[#d3d2cd] dark:text-slate-500 dark:hover:bg-neutral-800 group-hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); onMenu('project', project, ev); }}>…</button>
    </div>
    {shown.map((session: SessionInfo) => <div key={session.path} className={'group ml-0 flex cursor-pointer items-center gap-2 rounded-[14px] py-2 pl-11 pr-2 text-[#333] hover:bg-piActive dark:text-slate-200 dark:hover:bg-neutral-900 ' + (currentSessionPath === session.path ? 'bg-piActive dark:bg-neutral-900' : '')} onClick={() => onOpen(project, session, true)} title={sessionTitle(session)}>
      <div className="min-w-0 flex-1 truncate text-base">{sessionTitle(session)}</div><div className="whitespace-nowrap text-sm text-piMuted dark:text-slate-500">{relTime(session.modified)}</div>
      <button className="rounded-lg px-1.5 text-lg leading-none text-gray-500 opacity-0 hover:bg-[#d3d2cd] dark:text-slate-500 dark:hover:bg-neutral-800 group-hover:opacity-100" onClick={(ev) => { ev.stopPropagation(); onMenu('session', session, ev); }}>…</button>
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
    <main ref={logRef} onScroll={handleChatScroll} style={{ paddingBottom: composerHeight + 64 }} className={'flex-1 overflow-y-auto px-6 pt-16 scrollbar-thin dark:bg-black ' + terminalOffsetClass}><div className="mx-auto w-full max-w-6xl space-y-4">
      {renderStart > 0 && <div className="py-3 text-center text-xs text-gray-400">Scroll up to load older messages</div>}
      {messages.slice(renderStart).map((item: ChatItem) => <Message key={item.id} item={item} />)}
    </div></main>
    {terminalOpen && <TerminalPane focusKey={focusKey} onClose={() => setTerminalOpen(false)} />}
    <form ref={formRef} onSubmit={submitPrompt} className={'fixed bottom-0 left-[290px] bg-gradient-to-t from-white via-white px-6 pb-4 pt-3 dark:from-black dark:via-black max-[820px]:left-0 ' + terminalFormClass}><div className="mx-auto w-full max-w-6xl">
      {showSuggestions && <div className="mb-2 max-h-64 overflow-auto rounded-2xl border border-gray-200 bg-white p-1.5 shadow-pi dark:border-neutral-800 dark:bg-neutral-950">
        {slashMatches.map((command: any, index: number) => <button key={command.name} type="button" className={'flex w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left hover:bg-[#f2f4ff] dark:hover:bg-neutral-900 ' + (index === selectedSuggestion ? 'bg-[#f2f4ff] dark:bg-neutral-900' : '')} onMouseDown={ev => { ev.preventDefault(); runSuggestion(command); }}>
          <span className="min-w-36 font-bold text-piAccent">/{command.name}</span><span className="truncate text-xs text-gray-500 dark:text-slate-400">{command.description || command.source || ''}</span>
        </button>)}
      </div>}
      {queuedPrompts.length > 0 && <div className="mb-2 max-h-28 overflow-auto rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-sm dark:border-neutral-800 dark:bg-neutral-950/95">
        {queuedPrompts.map((item: any, index: number) => <div key={item.id} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-neutral-900"><div className="font-bold text-piAccent">Queued {index + 1}</div><div className="min-w-0 flex-1 truncate">{item.message}{item.attachments?.length ? ' · ' + item.attachments.length + ' file' + (item.attachments.length === 1 ? '' : 's') : ''}</div><button type="button" className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-slate-500 dark:hover:bg-neutral-800 dark:hover:text-slate-200" onClick={() => removeQueuedPrompt(item.id)}>×</button></div>)}
      </div>}
      <div className={'rounded-3xl border bg-white p-3 shadow-sm dark:bg-neutral-950 ' + (dragOver ? 'border-piAccent ring-2 ring-piAccent/20' : 'border-gray-300 dark:border-neutral-800')} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => addFiles(e.target.files)} />
      {attachments.length > 0 && <AttachmentPreview files={attachments} remove={(index: number) => setAttachments(attachments.filter((_, i) => i !== index))} />}
      <textarea ref={textareaRef} className="max-h-[180px] min-h-[42px] w-full resize-none overflow-y-auto border-0 bg-white p-1 text-[15px] outline-none dark:bg-neutral-950" placeholder="Ask for additional changes" value={input} onPaste={e => { const files = e.clipboardData?.files; if (files && files.length > 0) addFiles(files); }} onChange={e => { completedSuggestionRef.current = null; setInput(e.target.value); setSelectedSuggestion(0); }} onInput={autoResize} onKeyDown={e => {
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
      <div className="flex items-center gap-2"><button type="button" className="h-8 w-8 rounded-full text-xl text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-neutral-900" onClick={() => fileInputRef.current?.click()}>＋</button><ModelControls models={models} state={state} loadState={loadState} /><div className="flex-1" />{busy && (input.trim() || attachments.length > 0) && <button type="button" className="rounded-full bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-neutral-900 dark:text-slate-200 dark:hover:bg-neutral-800" onClick={submitCurrentInput}>Queue</button>}<button type="button" className={'flex h-8 w-8 items-center justify-center rounded-full text-white ' + (busy || input.trim() || attachments.length > 0 ? 'bg-gray-900 dark:bg-slate-100 dark:text-black' : 'bg-gray-300 dark:bg-neutral-800')} disabled={!busy && !input.trim() && attachments.length === 0} onClick={busy ? abortGeneration : submitCurrentInput}>{busy ? <span className="h-3 w-3 rounded-sm bg-white dark:bg-black" /> : '↑'}</button></div>
      </div>
    </div></form>
  </>;
}
function TerminalPane({ focusKey, onClose }: any) {
  const [cwd, setCwd] = useState('');
  const [pid, setPid] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const cwdRef = useRef('');
  const startGenerationRef = useRef(0);

  function writeToTerminal(text: string) {
    terminalRef.current?.write(text);
  }

  async function start(restart = false) {
    const generation = ++startGenerationRef.current;
    const res = await fetch(restart ? '/api/terminal/restart' : '/api/terminal/start', { method: 'POST' });
    if (!res.ok) {
      writeToTerminal('\r\nTerminal error: ' + await res.text() + '\r\n');
      return;
    }
    const json = await res.json();
    const data = json.data || {};
    if (generation !== startGenerationRef.current) return;
    setCwd(data.cwd || '');
    cwdRef.current = data.cwd || '';
    setPid(data.pid || null);
    setRunning(!!data.running);
    terminalRef.current?.reset();
    if (data.buffer) writeToTerminal(data.buffer);
    fitAndResize();
    setTimeout(() => terminalRef.current?.focus(), 0);
  }

  async function send(data: string) {
    if (!data) return;
    const res = await fetch('/api/terminal/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
    if (!res.ok) writeToTerminal('\r\nTerminal error: ' + await res.text() + '\r\n');
  }

  async function resize(cols: number, rows: number) {
    await fetch('/api/terminal/resize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cols, rows }) }).catch(() => {});
  }

  function fitAndResize() {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!fitAddon || !terminal) return;
    try {
      fitAddon.fit();
      resize(terminal.cols, terminal.rows);
    } catch {}
  }

  useEffect(() => {
    const XTerm = (window as any).Terminal;
    const FitAddon = (window as any).FitAddon?.FitAddon;
    if (!terminalElementRef.current || !XTerm || !FitAddon) return;
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#000000', foreground: '#f3f4f6', cursor: '#f3f4f6', selectionBackground: '#262626' },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElementRef.current);
    terminal.onData((data: string) => send(data));
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalReady(true);
    fitAndResize();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitAndResize);
    if (resizeObserver) resizeObserver.observe(terminalElementRef.current);
    window.addEventListener('resize', fitAndResize);
    return () => {
      window.removeEventListener('resize', fitAndResize);
      resizeObserver?.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      setTerminalReady(false);
    };
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;
    start(false);
  }, [focusKey, terminalReady]);

  useEffect(() => {
    const handler = (event: any) => {
      const detail = event.detail || {};
      if (detail.cwd && cwdRef.current && detail.cwd !== cwdRef.current) return;
      if (detail.type === 'terminal_start') {
        setCwd(detail.cwd || '');
        cwdRef.current = detail.cwd || '';
        setPid(detail.pid || null);
        setRunning(true);
      } else if (detail.type === 'terminal_output') {
        writeToTerminal(detail.data || '');
      } else if (detail.type === 'terminal_exit') {
        setRunning(false);
        writeToTerminal('\r\n[terminal exited code=' + detail.code + ' signal=' + detail.signal + ']\r\n');
      }
    };
    window.addEventListener('pi-terminal-event', handler);
    return () => window.removeEventListener('pi-terminal-event', handler);
  }, []);

  return <aside className="terminal-panel fixed bottom-0 right-0 top-12 z-20 flex w-[420px] max-w-full flex-col border-l border-gray-200 bg-black text-gray-100 shadow-pi dark:border-neutral-900 max-[999px]:left-0 max-[999px]:w-full max-[999px]:border-l-0">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 px-3">
      <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-gray-100">Terminal</div><div className="truncate font-mono text-[10px] text-gray-400">{cwd || 'starting'}{pid ? ' · pid ' + pid : ''}</div></div>
      <span className={'rounded-full px-2 py-0.5 text-[10px] font-semibold ' + (running ? 'bg-green-400/15 text-green-200' : 'bg-gray-400/15 text-gray-300')}>{running ? 'Running' : 'Stopped'}</span>
      <button type="button" className="rounded-lg bg-white/10 px-2 py-1 text-xs text-gray-100 hover:bg-white/15" onClick={() => start(true)}>Restart</button>
      <button type="button" className="rounded-lg bg-white/10 px-2 py-1 text-xs text-gray-100 hover:bg-white/15" onClick={onClose}>Close</button>
    </div>
    <div className="min-h-0 flex-1 p-3" onClick={() => terminalRef.current?.focus()}>
      <div ref={terminalElementRef} className="h-full w-full overflow-hidden" />
    </div>
  </aside>;
}
function AttachmentPreview({ files, remove }: any) { return <div className="mb-2 flex flex-wrap gap-2">{files.map((file: any, index: number) => <div key={index} className="group relative overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-neutral-800 dark:bg-neutral-900">{String(file.type || '').startsWith('image/') && file.dataUrl ? <img src={file.dataUrl} className="h-20 w-20 object-cover" /> : <div className="flex h-20 w-40 items-center justify-center px-3 text-center text-xs text-gray-500 dark:text-slate-400">{file.name}</div>}<div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[10px] text-white">{file.name}</div>{remove && <button type="button" className="absolute right-1 top-1 hidden rounded-full bg-black/60 px-1.5 text-xs text-white group-hover:block" onClick={() => remove(index)}>×</button>}</div>)}</div>; }
function Message({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <div className="ml-auto max-w-[74%]"><div className="ml-auto w-fit whitespace-pre-wrap rounded-2xl bg-black px-4 py-3 text-[15px] text-white dark:bg-slate-100 dark:text-black">{item.text}</div>{item.attachments?.length > 0 && <div className="mt-2 flex justify-end"><AttachmentPreview files={item.attachments} /></div>}</div>;
  if (item.kind === 'assistant') return <div className="whitespace-pre-wrap py-2 text-[15px] leading-7 text-[#202124] dark:text-slate-100">{item.text}{item.running && <span className="ml-1 animate-pulse">●</span>}</div>;
  if (item.kind === 'system') return <div className="rounded-xl bg-[#fff7df] px-4 py-3 text-sm text-[#6b5b1a] dark:bg-amber-400/10 dark:text-amber-200"><div className="mb-1 text-xs font-bold uppercase">{item.title}</div>{item.text}</div>;
  if (item.kind === 'thinking') return <details className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-400" open={!!item.running}><summary className="cursor-pointer font-medium">{item.running ? '◌ ' : '✓ '}Thinking</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{item.text}</pre></details>;
  if (item.toolName === 'bash') return <BashToolBlock item={item} />;
  if (item.toolName === 'read') return <ReadToolBlock item={item} />;
  if (item.toolName === 'edit') return <EditToolBlock item={item} />;
  if (item.toolName === 'write') return <WriteToolBlock item={item} />;
  return <GenericToolBlock item={item} />;
}
function ToolStatus({ item }: { item: ChatItem }) { return <span className="mr-2 inline-block w-4 text-center">{item.running ? '◌' : item.error ? '✕' : '✓'}</span>; }
function BashToolBlock({ item }: { item: ChatItem }) {
  const command = item.args?.command || item.title || 'bash';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300' : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-300')}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Bash</summary>
    <pre className="mt-2 overflow-auto rounded-lg bg-black p-3 text-xs text-gray-100"><code>{command}</code></pre>
    {item.text && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs text-gray-600 dark:bg-black dark:text-slate-300">{item.text}</pre>}
  </details>;
}
function ReadToolBlock({ item }: { item: ChatItem }) {
  const file = item.args?.path || item.title.replace(/^Read\s+/, '') || 'file';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300' : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-300')}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Read <span className="font-mono">{baseName(file)}</span></summary>
    {item.text && <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs text-gray-700 dark:bg-black dark:text-slate-300">{item.text}</pre>}
  </details>;
}
function EditToolBlock({ item }: { item: ChatItem }) {
  const file = item.args?.path || 'file';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300' : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-300')} open={!!item.running}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Edited <span className="font-mono">{baseName(file)}</span></summary>
    <DiffView edits={item.args?.edits} fallback={item.text} />
  </details>;
}
function WriteToolBlock({ item }: { item: ChatItem }) {
  const file = item.args?.path || 'file';
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300' : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-300')} open={!!item.running}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />Wrote <span className="font-mono">{baseName(file)}</span></summary>
    <AddedFileView content={item.args?.content || item.text} />
  </details>;
}
function GenericToolBlock({ item }: { item: ChatItem }) {
  return <details className={'rounded-xl border px-3 py-2 text-sm ' + (item.error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300' : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-300')} open={!!item.running || !!item.text}>
    <summary className="cursor-pointer font-medium"><ToolStatus item={item} />{item.title}</summary>{item.text && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{item.text}</pre>}
  </details>;
}
function DiffView({ edits, fallback }: any) {
  const normalized = Array.isArray(edits) ? edits : [];
  if (normalized.length === 0) return fallback ? <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs text-gray-700 dark:bg-black dark:text-slate-300">{fallback}</pre> : null;
  return <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white font-mono text-xs dark:border-neutral-800 dark:bg-black">
    {normalized.map((edit: any, index: number) => <div key={index} className="border-b border-gray-100 dark:border-neutral-900 last:border-b-0">
      {String(edit.oldText || '').split('\n').map((line, i) => <div key={'old-' + i} className="flex bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"><span className="w-8 shrink-0 select-none border-r border-red-100 px-2 text-right text-red-300 dark:border-red-900/60 dark:text-red-500">-</span><span className="whitespace-pre-wrap px-3">{line || ' '}</span></div>)}
      {String(edit.newText || '').split('\n').map((line, i) => <div key={'new-' + i} className="flex bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"><span className="w-8 shrink-0 select-none border-r border-green-100 px-2 text-right text-green-300 dark:border-green-900/60 dark:text-green-500">+</span><span className="whitespace-pre-wrap px-3">{line || ' '}</span></div>)}
    </div>)}
  </div>;
}
function AddedFileView({ content }: any) {
  return <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white font-mono text-xs dark:border-neutral-800 dark:bg-black">
    {String(content || '').split('\n').map((line, i) => <div key={i} className="flex bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"><span className="w-8 shrink-0 select-none border-r border-green-100 px-2 text-right text-green-300 dark:border-green-900/60 dark:text-green-500">+</span><span className="whitespace-pre-wrap px-3">{line || ' '}</span></div>)}
  </div>;
}
function ModelControls({ models, state, loadState }: any) {
  const modelKey = (m: any) => (m?.provider || '') + '::' + (m?.id || '');
  const current = state?.model ? modelKey(state.model) : '';
  return <><select className="w-32 border-0 bg-transparent text-sm font-medium outline-none dark:text-slate-200" value={current} onChange={async e => { const model = models.find((m: any) => modelKey(m) === e.target.value); if (model) await fetch('/api/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: model.provider, modelId: model.id }) }); await loadState(); }}>
    <option value="">Model</option>{models.map((m: any) => <option key={modelKey(m)} value={modelKey(m)}>{m.name || m.id}</option>)}
  </select><select className="w-24 border-0 bg-transparent text-sm font-medium text-gray-500 outline-none dark:text-slate-400" value={state?.thinkingLevel || 'off'} onChange={async e => { await fetch('/api/thinking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: e.target.value }) }); await loadState(); }}><option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option></select></>;
}
function Menu({ x, y, children, onClose }: any) { useEffect(() => { const fn = () => onClose(); setTimeout(() => document.addEventListener('click', fn), 0); return () => document.removeEventListener('click', fn); }, []); return <div className="fixed z-50 min-w-40 rounded-xl border border-gray-200 bg-white p-1.5 shadow-pi dark:border-neutral-800 dark:bg-neutral-950" style={{ left: Math.min(x, window.innerWidth - 180), top: y }} onClick={e => e.stopPropagation()}>{children}</div>; }
function MenuItem({ children, onClick, neutral }: any) { return <button className={'block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-neutral-900 ' + (neutral ? 'text-gray-700 dark:text-slate-200' : 'text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40')} onClick={onClick}>{children}</button>; }
function SearchModal({ projects, onClose, onOpen }: any) { const [q, setQ] = useState(''); const results = projects.flatMap((project: ProjectInfo) => project.sessions.filter(s => (sessionTitle(s) + ' ' + (s.firstMessage || '') + ' ' + project.cwd).toLowerCase().includes(q.toLowerCase())).map(session => ({ project, session }))).slice(0, 50); return <Modal onClose={onClose}><div className="flex items-center gap-3 border-b border-gray-200 p-4 text-lg dark:border-neutral-900"><span>⌕</span><input autoFocus className="flex-1 bg-transparent outline-none" placeholder="Search projects and sessions…" value={q} onChange={e => setQ(e.target.value)} /></div><div className="max-h-[70vh] overflow-auto p-2">{!q && <div className="p-8 text-center text-gray-400 dark:text-slate-500">Type to search projects and sessions</div>}{q && results.length === 0 && <div className="p-8 text-center text-gray-400 dark:text-slate-500">No results</div>}{results.map(({ project, session }: any) => <button key={session.path} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-neutral-900" onClick={() => onOpen(project, session)}><div className="font-bold">{sessionTitle(session)}</div><div className="text-sm text-gray-500 dark:text-slate-400">{shortPath(project.cwd)} · {relTime(session.modified)}</div></button>)}</div></Modal>; }
function FolderModal({ path, entries, browse, close, select }: any) { return <Modal onClose={close}><div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-neutral-900"><h2 className="font-bold">Add project</h2><button className="rounded-lg bg-gray-100 px-3 py-2 dark:bg-neutral-900" onClick={close}>Cancel</button></div><div className="border-b border-gray-200 px-4 py-2 font-mono text-xs text-gray-500 dark:border-neutral-900 dark:text-slate-400">{path}</div><div className="max-h-[60vh] overflow-auto p-2">{entries.map((entry: any) => <button key={entry.path} className={'block w-full rounded-lg px-3 py-2 text-left ' + (entry.type === 'directory' ? 'hover:bg-gray-100 dark:hover:bg-neutral-900' : 'text-gray-400 dark:text-slate-600')} disabled={entry.type !== 'directory'} onClick={() => browse(entry.path)}>{entry.parent ? '↰' : entry.type === 'directory' ? '▱' : '·'} {entry.name}</button>)}</div><div className="flex justify-end gap-2 border-t border-gray-200 p-4 dark:border-neutral-900"><button className="rounded-xl bg-gray-100 px-4 py-2 dark:bg-neutral-900" onClick={close}>Cancel</button><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={select}>Select folder</button></div></Modal>; }
function Modal({ children, onClose }: any) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/30 p-5 dark:bg-black/50" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="flex max-h-[calc(100vh-40px)] w-[min(760px,94vw)] max-w-3xl flex-col overflow-hidden rounded-[18px] border border-gray-200 bg-white shadow-modal dark:border-neutral-800 dark:bg-neutral-950">{children}</div></div>;
}
function CommandOutputModal({ command, text, onClose }: any) { return <Modal onClose={onClose}><div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-neutral-900"><h2 className="font-bold">{command}</h2><button className="rounded-lg bg-gray-100 px-3 py-2 dark:bg-neutral-900" onClick={onClose}>Close</button></div><pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-gray-700 dark:text-slate-300">{text}</pre></Modal>; }
function AskQuestionModal({ request, onAnswer, onClose }: any) {
  const [customAnswer, setCustomAnswer] = useState('');
  return <Modal onClose={onClose}><div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-neutral-900"><h2 className="font-bold">Question</h2><button className="rounded-lg bg-gray-100 px-3 py-2 dark:bg-neutral-900" onClick={onClose}>Cancel</button></div>
    <div className="space-y-4 p-4">
      <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700 dark:text-slate-300">{request.question}</p>
      <div className="grid gap-2">{(request.options || []).map((option: string, index: number) => <button key={index} type="button" className="rounded-xl border border-gray-200 px-4 py-3 text-left text-sm font-medium hover:border-piAccent hover:bg-gray-50 dark:border-neutral-800 dark:hover:bg-neutral-900" onClick={() => onAnswer({ answer: option, optionIndex: index, custom: false })}>{option}</button>)}</div>
      <div className="rounded-xl border border-gray-200 p-3 dark:border-neutral-800"><label className="mb-2 block text-sm font-semibold text-gray-600 dark:text-slate-300">Other</label><textarea className="h-24 w-full resize-none rounded-lg border border-gray-300 bg-white p-3 text-sm outline-none dark:border-neutral-800 dark:bg-black" value={customAnswer} onChange={e => setCustomAnswer(e.target.value)} placeholder="Write your own answer" /></div>
    </div>
    <div className="flex justify-end gap-2 border-t border-gray-200 p-4 dark:border-neutral-900"><button className="rounded-xl bg-gray-100 px-4 py-2 dark:bg-neutral-900" onClick={onClose}>Cancel</button><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white disabled:opacity-50" disabled={!customAnswer.trim()} onClick={() => onAnswer({ answer: customAnswer.trim(), optionIndex: null, custom: true })}>Send Other</button></div>
  </Modal>;
}
function SkillsView({ skills, reload, openModal }: any) {
  const [query, setQuery] = useState('');
  useEffect(() => { reload(); }, []);
  const filtered = skills.filter((s: any) => (s.name + ' ' + (s.description || '') + ' ' + (s.path || '')).toLowerCase().includes(query.toLowerCase()));
  return <main className="flex-1 overflow-auto px-6 pb-10 pt-20 dark:bg-black"><div className="mx-auto max-w-6xl">
    <div className="mb-6 overflow-hidden rounded-[28px] border border-gray-200 bg-gradient-to-br from-[#fbfaf6] to-white p-6 shadow-sm dark:border-neutral-800 dark:from-neutral-950 dark:to-black">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><h2 className="text-3xl font-bold text-gray-900 dark:text-slate-100">Skills</h2><button className="w-fit rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={() => openModal(true)}>Add skill</button></div>
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950"><span className="text-gray-400 dark:text-slate-500">⌕</span><input className="flex-1 bg-transparent outline-none" placeholder="Search skills…" value={query} onChange={e => setQuery(e.target.value)} /><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{filtered.length} / {skills.length}</span></div>
    </div>
    {filtered.length === 0 ? <Empty>No skills found.</Empty> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((s: any) => <SkillTile key={s.path} skill={s} open={() => openModal(s)} reload={reload} />)}</div>}
  </div></main>;
}
function SkillTile({ skill, open, reload }: any) {
  const excerpt = String(skill.content || '').replace(/^---[\s\S]*?---/, '').trim().split(/\s+/).slice(0, 26).join(' ');
  return <button className="group flex min-h-56 flex-col rounded-[24px] border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-piAccent/40 hover:shadow-pi dark:border-neutral-800 dark:bg-neutral-950" onClick={skill.builtin ? undefined : open}>
    <div className="mb-4 flex items-start justify-between gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-piAccent text-xl font-bold text-white">✦</div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{skill.builtin ? 'Built-in' : 'Skill'}</span></div>
    <h3 className="text-lg font-bold text-gray-900 group-hover:text-piAccent dark:text-slate-100">{skill.name}</h3><p className="mt-2 line-clamp-2 text-sm text-gray-500 dark:text-slate-400">{skill.description || 'No description'}</p>
    <p className="mt-4 line-clamp-4 flex-1 text-xs leading-5 text-gray-400 dark:text-slate-500">{excerpt || 'No instructions yet.'}</p>
    <div className="mt-4 flex items-center justify-between gap-2 border-t border-gray-100 pt-3 dark:border-neutral-900"><span className="min-w-0 truncate text-xs text-gray-400 dark:text-slate-500">{skill.path}</span>{skill.builtin ? <span className="text-sm text-gray-400 dark:text-slate-500">Read-only</span> : <span className="flex gap-2 text-sm text-piAccent"><span>Edit</span><span onClick={async e => { e.stopPropagation(); if (confirm('Delete skill "' + skill.name + '"?')) { await fetch('/api/skills', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: skill.path }) }); reload(); } }}>Delete</span></span>}</div>
  </button>;
}
function ToolsView({ tools, customTools, saveTools, openModal }: any) {
  const [query, setQuery] = useState('');
  const filtered = tools.filter((t: any) => (t.name + ' ' + (t.description || '') + ' ' + (t.content || '')).toLowerCase().includes(query.toLowerCase()));
  return <main className="flex-1 overflow-auto px-6 pb-10 pt-20 dark:bg-black"><div className="mx-auto max-w-6xl">
    <div className="mb-6 overflow-hidden rounded-[28px] border border-gray-200 bg-gradient-to-br from-[#fbfaf6] to-white p-6 shadow-sm dark:border-neutral-800 dark:from-neutral-950 dark:to-black"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><h2 className="text-3xl font-bold text-gray-900 dark:text-slate-100">Tools</h2><button className="w-fit rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={() => openModal(true)}>Add tool</button></div><div className="mt-5 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950"><span className="text-gray-400 dark:text-slate-500">⌕</span><input className="flex-1 bg-transparent outline-none" placeholder="Search tools…" value={query} onChange={e => setQuery(e.target.value)} /><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{filtered.length} / {tools.length}</span></div></div>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((t: any) => <ToolTile key={t.id || t.name} tool={t} open={() => openModal(t)} canEdit={!t.builtin} canDelete={!t.builtin} onDelete={() => { if (confirm('Delete tool "' + t.name + '"?')) saveTools(customTools.filter((x: any) => x.id !== t.id)); }} />)}</div>
  </div></main>;
}
function ToolTile({ tool, open, canEdit, canDelete, onDelete }: any) {
  const excerpt = String(tool.content || '').trim().split(/\s+/).slice(0, 28).join(' ');
  return <button className="group flex min-h-56 flex-col rounded-[24px] border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-piAccent/40 hover:shadow-pi dark:border-neutral-800 dark:bg-neutral-950" onClick={canEdit ? open : undefined}>
    <div className="mb-4 flex items-start justify-between gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-piAccent text-xl font-bold text-white">⚙</div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{tool.builtin ? 'Built-in' : 'Custom'}</span></div>
    <h3 className="text-lg font-bold text-gray-900 group-hover:text-piAccent dark:text-slate-100">{tool.name}</h3><p className="mt-2 line-clamp-2 text-sm text-gray-500 dark:text-slate-400">{tool.description || 'No description'}</p><p className="mt-4 line-clamp-4 flex-1 text-xs leading-5 text-gray-400 dark:text-slate-500">{excerpt || 'No instructions.'}</p>
    <div className="mt-4 flex items-center justify-end gap-3 border-t border-gray-100 pt-3 text-sm text-piAccent dark:border-neutral-900">{canEdit && <span>Edit</span>}{canDelete && <span onClick={e => { e.stopPropagation(); onDelete(); }}>Delete</span>}{tool.builtin && <span className="text-gray-400 dark:text-slate-500">Read-only</span>}</div>
  </button>;
}
function AgentsView({ builtinAgents, customAgents, saveAgents, openModal }: any) {
  const [query, setQuery] = useState('');
  const all = [...builtinAgents.map((a: any) => ({ ...a, _custom: false })), ...customAgents.map((a: any) => ({ ...a, _custom: true }))];
  const matches = (a: any) => (a.name + ' ' + (a.description || '') + ' ' + (a.systemPrompt || '') + ' ' + (a.skills || []).join(' ') + ' ' + (a.tools || []).join(' ')).toLowerCase().includes(query.toLowerCase());
  const filteredBuiltins = builtinAgents.filter(matches);
  const filteredCustom = customAgents.filter(matches);
  const renderAgent = (a: any, custom = false) => <AgentTile key={a.id} agent={a} custom={custom} onEdit={() => openModal(a)} onDelete={custom ? () => { if (confirm('Delete agent "' + a.name + '"?')) saveAgents(customAgents.filter((x: any) => x.id !== a.id)); } : null} />;
  return <main className="flex-1 overflow-auto px-6 pb-10 pt-20 dark:bg-black"><div className="mx-auto max-w-6xl">
    <div className="mb-6 overflow-hidden rounded-[28px] border border-gray-200 bg-gradient-to-br from-[#fbfaf6] to-white p-6 shadow-sm dark:border-neutral-800 dark:from-neutral-950 dark:to-black"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><h2 className="text-3xl font-bold text-gray-900 dark:text-slate-100">Agents</h2><button className="w-fit rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={() => openModal(true)}>Add custom agent</button></div><div className="mt-5 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950"><span className="text-gray-400 dark:text-slate-500">⌕</span><input className="flex-1 bg-transparent outline-none" placeholder="Search agents…" value={query} onChange={e => setQuery(e.target.value)} /><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{filteredBuiltins.length + filteredCustom.length} / {all.length}</span></div></div>
    <section className="mb-8"><h2 className="mb-4 text-xl font-bold">Built-in agents</h2><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filteredBuiltins.map((a: any) => renderAgent(a, false))}</div></section>
    <section><h2 className="mb-4 text-xl font-bold">Custom agents</h2>{filteredCustom.length === 0 ? <Empty>No custom agents yet.</Empty> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filteredCustom.map((a: any) => renderAgent(a, true))}</div>}</section>
  </div></main>;
}
function AgentTile({ agent, custom, onEdit, onDelete }: any) {
  const prompt = stripGeneratedPromptSections(agent.systemPrompt || '').split(/\s+/).slice(0, 28).join(' ');
  return <button className="group flex min-h-60 flex-col rounded-[24px] border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-piAccent/40 hover:shadow-pi dark:border-neutral-800 dark:bg-neutral-950" onClick={onEdit}>
    <div className="mb-4 flex items-start justify-between gap-3"><div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-piAccent text-xl font-bold text-white">{agent.icon ? <img src={agent.icon} className="h-full w-full object-cover" /> : (agent.name || 'A')[0]}</div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{custom ? 'Custom' : 'Built-in'}</span></div>
    <h3 className="text-lg font-bold text-gray-900 group-hover:text-piAccent dark:text-slate-100">{agent.name}</h3><p className="mt-2 line-clamp-2 text-sm text-gray-500 dark:text-slate-400">{agent.description || 'No description'}</p><p className="mt-4 line-clamp-3 text-xs leading-5 text-gray-400 dark:text-slate-500">{prompt || 'No system prompt.'}</p>
    <div className="mt-4 flex flex-wrap gap-1">{(agent.skills || []).slice(0, 3).map((s: string) => <span key={s} className="rounded-full bg-[#f2f4ff] px-2 py-1 text-[11px] text-piAccent dark:bg-piAccent/15">{s}</span>)}{(agent.tools || []).slice(0, 4).map((t: string) => <span key={t} className="rounded-full bg-gray-100 px-2 py-1 text-[11px] text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{t}</span>)}</div>
    <div className="mt-auto flex items-center justify-end gap-3 border-t border-gray-100 pt-3 text-sm text-piAccent dark:border-neutral-900"><span>Edit</span>{onDelete && <span onClick={e => { e.stopPropagation(); onDelete(); }}>Delete</span>}</div>
  </button>;
}
function Page({ title, action, onAction, children }: any) { return <main className="flex-1 overflow-auto px-6 pb-10 pt-20 dark:bg-black"><div className="mx-auto max-w-4xl"><section><div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-bold">{title}</h2><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={onAction}>{action}</button></div><div className="space-y-3">{children}</div></section></div></main>; }
function Empty({ children }: any) { return <div className="rounded-2xl border border-gray-200 bg-white p-5 text-gray-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-slate-400">{children}</div>; }
function Card({ icon, title, desc, meta, content, badge, actions }: any) { const [open, setOpen] = useState(false); return <div className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-piAccent font-bold text-white">{icon}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-bold">{title}<span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-neutral-900 dark:text-slate-400">{badge}</span></div><div className="mt-1 text-sm text-gray-500 dark:text-slate-400">{desc || 'No description'}</div>{meta && <div className="mt-1 truncate text-xs text-gray-400 dark:text-slate-500">{meta}</div>}<div className="mt-3 flex gap-2 text-sm text-piAccent [&>button]:rounded-lg [&>button]:bg-gray-100 [&>button]:px-3 [&>button]:py-1 dark:[&>button]:bg-neutral-900"><button onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Expand'}</button>{actions}</div>{open && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-50 p-3 text-xs dark:bg-black">{content}</pre>}</div></div>; }
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
    <div><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold text-gray-600 dark:text-slate-300">Additional metadata</span><button type="button" className="rounded-lg bg-gray-100 px-3 py-1 text-sm dark:bg-neutral-900" onClick={() => setMetaFields([...metaFields, { key: '', value: '' }])}>Add field</button></div>
      <div className="space-y-2">{metaFields.length === 0 ? <div className="text-sm text-gray-400 dark:text-slate-500">No additional fields.</div> : metaFields.map((field, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2"><input placeholder="field" value={field.key} onChange={e => updateMetaField(index, { key: e.target.value })} /><input placeholder="value" value={field.value} onChange={e => updateMetaField(index, { value: e.target.value })} /><button type="button" className="rounded-xl bg-gray-100 px-3 dark:bg-neutral-900" onClick={() => setMetaFields(metaFields.filter((_, i) => i !== index))}>×</button></div>)}</div>
    </div>
  </EditorModal>;
}
function ToolModal({ tool, onClose, onSave }: any) { const [name, setName] = useState(tool?.name || ''); const [description, setDescription] = useState(tool?.description || ''); const [content, setContent] = useState(tool?.content || ''); return <EditorModal title={tool ? 'Edit tool' : 'Create tool'} onClose={onClose} onSave={() => onSave({ ...tool, name, description, content })}><Field label="Name"><input disabled={!!tool} value={name} onChange={e => setName(e.target.value)} /></Field><Field label="Description"><input value={description} onChange={e => setDescription(e.target.value)} /></Field><Field label="Content"><textarea value={content} onChange={e => setContent(e.target.value)} /></Field></EditorModal>; }
function AgentModal({ agent, skills, tools, cwd, onClose, onSave }: any) {
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [systemPrompt, setSystemPrompt] = useState(stripGeneratedPromptSections(agent?.systemPrompt || ''));
  const [selectedSkills, setSelectedSkills] = useState<string[]>(agent?.skills || []);
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools || []);
  const [addCurrentDate, setAddCurrentDate] = useState(agent?.addCurrentDate ?? (agent ? hasCurrentDate(agent.systemPrompt || '') : true));
  const [addCurrentWorkingDirectory, setAddCurrentWorkingDirectory] = useState(agent?.addCurrentWorkingDirectory ?? (agent ? hasCurrentWorkingDirectory(agent.systemPrompt || '') : true));
  const toggle = (list: string[], setList: any, value: string) => setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  return <EditorModal title={agent ? (agent.builtin ? 'Edit built-in agent' : 'Edit custom agent') : 'Create custom agent'} onClose={onClose} onSave={() => onSave({ ...agent, name, description, systemPrompt: buildAgentSystemPrompt(systemPrompt, selectedSkills, selectedTools, skills, { addCurrentDate, addCurrentWorkingDirectory, cwd }), skills: selectedSkills, tools: selectedTools, addCurrentDate, addCurrentWorkingDirectory })}>
    <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
    <Field label="Short description"><input value={description} onChange={e => setDescription(e.target.value)} /></Field>
    <Field label="System prompt"><textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} /></Field>
    <div><div className="mb-2 text-sm font-semibold text-gray-600 dark:text-slate-300">Generated context</div><div className="grid gap-2 rounded-xl border border-gray-200 p-2 dark:border-neutral-800">
      <ToggleRow label="Add current date" checked={addCurrentDate} onChange={setAddCurrentDate} />
      <ToggleRow label="Add current working directory" checked={addCurrentWorkingDirectory} onChange={setAddCurrentWorkingDirectory} />
    </div></div>
    <Checklist title="Skills this agent can use" empty="No skills found." items={skills.map((skill: any) => ({ key: skill.name, label: skill.name, desc: skill.description }))} selected={selectedSkills} toggle={(value: string) => toggle(selectedSkills, setSelectedSkills, value)} />
    <Checklist title="Tools this agent can use" items={tools.map((tool: any) => ({ key: tool.name, label: tool.name, desc: tool.description }))} selected={selectedTools} toggle={(value: string) => toggle(selectedTools, setSelectedTools, value)} />
  </EditorModal>;
}
function Checklist({ title, items, selected, toggle, empty }: any) { return <div><div className="mb-2 text-sm font-semibold text-gray-600 dark:text-slate-300">{title}</div><div className="max-h-44 overflow-auto rounded-xl border border-gray-200 p-1.5 dark:border-neutral-800">{items.length === 0 ? <div className="p-2 text-sm text-gray-400 dark:text-slate-500">{empty || 'Nothing available.'}</div> : items.map((item: any) => <label key={item.key} className="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-gray-50 dark:hover:bg-neutral-900"><input type="checkbox" className="!h-4 !w-4 !rounded !border-gray-300 !p-0 accent-piAccent dark:!border-neutral-700" checked={selected.includes(item.key)} onChange={() => toggle(item.key)} /><span className="min-w-0 truncate text-sm font-medium">{item.label}</span></label>)}</div></div>; }
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-gray-50 dark:hover:bg-neutral-900"><input type="checkbox" className="!h-4 !w-4 !rounded !border-gray-300 !p-0 accent-piAccent dark:!border-neutral-700" checked={checked} onChange={e => onChange(e.target.checked)} /><span className="min-w-0 truncate text-sm font-medium">{label}</span></label>; }
function stripGeneratedPromptSections(prompt: string) {
  return stripCurrentWorkingDirectory(stripCurrentDate(stripAvailableSkillsSection(prompt))).trim();
}
function stripAvailableSkillsSection(prompt: string) {
  return String(prompt || '').replace(/\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>\n*/g, '\n').trim();
}
function stripCurrentDate(prompt: string) {
  return String(prompt || '').replace(/\n*Current date(?: and time)?:[^\n]*/g, '\n').trim();
}
function stripCurrentWorkingDirectory(prompt: string) {
  return String(prompt || '').replace(/\n*Current working directory:[^\n]*/g, '\n').trim();
}
function hasCurrentDate(prompt: string) {
  return /(?:^|\n)Current date(?: and time)?:[^\n]*/.test(String(prompt || ''));
}
function hasCurrentWorkingDirectory(prompt: string) {
  return /(?:^|\n)Current working directory:[^\n]*/.test(String(prompt || ''));
}
type AgentSkillOption = { name: string; description?: string; path?: string; filePath?: string };
function buildAgentSystemPrompt(basePrompt: string, selectedSkills: string[], _selectedTools: string[], skills: AgentSkillOption[], options: { addCurrentDate: boolean; addCurrentWorkingDirectory: boolean; cwd?: string }) {
  let prompt = stripGeneratedPromptSections(basePrompt);
  const selected = skills.filter(skill => selectedSkills.includes(skill.name));
  if (selected.length > 0) {
    const lines = [
      '',
      '',
      'The following skills provide specialized instructions for specific tasks.',
      "Use the read tool to load a skill's file when the task matches its description.",
      'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
      '',
      '<available_skills>',
    ];
    for (const skill of selected) {
      lines.push('  <skill>');
      lines.push('    <name>' + escapeXml(skill.name) + '</name>');
      lines.push('    <description>' + escapeXml(skill.description || '') + '</description>');
      lines.push('    <location>' + escapeXml(skill.path || skill.filePath || '') + '</location>');
      lines.push('  </skill>');
    }
    lines.push('</available_skills>');
    prompt += lines.join('\n');
  }
  if (options.addCurrentDate) {
    prompt += '\nCurrent date: ' + formatCurrentDate();
  }
  if (options.addCurrentWorkingDirectory && options.cwd) {
    prompt += '\nCurrent working directory: ' + String(options.cwd).replace(/\\/g, '/');
  }
  return prompt;
}
function formatCurrentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
function escapeXml(value: unknown) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function EditorModal({ title, children, onClose, onSave }: any) { return <Modal onClose={onClose}><div className="flex shrink-0 items-center justify-between border-b border-gray-200 p-4 dark:border-neutral-900"><h2 className="font-bold">{title}</h2><button className="rounded-lg bg-gray-100 px-3 py-2 dark:bg-neutral-900" onClick={onClose}>Cancel</button></div><div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-gray-300 [&_input]:bg-white [&_input]:p-3 [&_textarea]:h-64 [&_textarea]:w-full [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-gray-300 [&_textarea]:bg-white [&_textarea]:p-3 dark:[&_input]:border-neutral-800 dark:[&_input]:bg-black dark:[&_textarea]:border-neutral-800 dark:[&_textarea]:bg-black">{children}</div><div className="flex shrink-0 justify-end gap-2 border-t border-gray-200 p-4 dark:border-neutral-900"><button className="rounded-xl bg-gray-100 px-4 py-2 dark:bg-neutral-900" onClick={onClose}>Cancel</button><button className="rounded-xl bg-piAccent px-4 py-2 font-bold text-white" onClick={onSave}>Save</button></div></Modal>; }
function Field({ label, children }: any) { return <label className="block"><span className="mb-1 block text-sm font-semibold text-gray-600 dark:text-slate-300">{label}</span>{children}</label>; }

(window as any).PiWebComponents = {
  SidebarButton,
  ProjectTree,
  ChatView,
  TerminalPane,
  AttachmentPreview,
  Message,
  ToolStatus,
  BashToolBlock,
  ReadToolBlock,
  EditToolBlock,
  WriteToolBlock,
  GenericToolBlock,
  DiffView,
  AddedFileView,
  ModelControls,
  Menu,
  MenuItem,
  SearchModal,
  FolderModal,
  Modal,
  CommandOutputModal,
  AskQuestionModal,
  SkillsView,
  SkillTile,
  ToolsView,
  ToolTile,
  AgentsView,
  AgentTile,
  Page,
  Empty,
  Card,
  SkillModal,
  ToolModal,
  AgentModal,
  Checklist,
  EditorModal,
  Field,
};
})();
