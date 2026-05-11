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
      theme: { background: '#0b1020', foreground: '#f3f4f6', cursor: '#f3f4f6', selectionBackground: '#374151' },
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

  return <aside className="terminal-panel fixed bottom-0 right-0 top-12 z-20 flex w-[420px] max-w-full flex-col border-l border-gray-200 bg-[#0b1020] text-gray-100 shadow-pi max-[999px]:left-0 max-[999px]:top-auto max-[999px]:h-[45vh] max-[999px]:w-full max-[999px]:border-l-0 max-[999px]:border-t">
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
