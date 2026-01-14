
import React, { useState, useRef, useCallback } from 'react';
import { Upload, Play, Pause, Square, Loader2, Volume2, Sparkles, AlertCircle, Headphones, ArrowLeft, User, Settings, Eye, EyeOff, Save, ExternalLink, BookOpen, Gauge } from 'lucide-react';
import { ProcessingState, AppState, SpeechBlock, BlockType, VoiceType, PaperSection, PlaybackSpeed } from './types';
import { parsePdf } from './services/pdfService';
import { extractSections, processSectionText, generateAudio, generateAudioBatch } from './services/geminiService';

const SPEED_OPTIONS: { value: PlaybackSpeed; label: string }[] = [
  { value: 0.75, label: 'Slow' },
  { value: 1.0, label: 'Normal' },
  { value: 1.25, label: 'Fast' },
  { value: 1.5, label: 'Faster' },
  { value: 2.0, label: '2x' },
];

const App: React.FC = () => {
  // API keys
  const [openRouterKey, setOpenRouterKey] = useState<string>(localStorage.getItem('openrouter_api_key') || '');
  const [deepgramKey, setDeepgramKey] = useState<string>(localStorage.getItem('deepgram_api_key') || '');

  const [showKeyInput, setShowKeyInput] = useState<boolean>(!openRouterKey || !deepgramKey);
  const [tempOpenRouterKey, setTempOpenRouterKey] = useState<string>(openRouterKey);
  const [tempDeepgramKey, setTempDeepgramKey] = useState<string>(deepgramKey);
  const [isOpenRouterKeyVisible, setIsOpenRouterKeyVisible] = useState<boolean>(false);
  const [isDeepgramKeyVisible, setIsDeepgramKeyVisible] = useState<boolean>(false);

  const [state, setState] = useState<AppState>({
    file: null,
    status: ProcessingState.IDLE,
    progress: 0,
    totalPages: 0,
    currentPage: 0,
    error: null,
    sections: [],
    currentSectionIndex: 0,
    currentlyPlayingBlockId: null,
    selectedVoice: 'female',
    playbackSpeed: 1.0
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<{ id: string, source: AudioBufferSourceNode }[]>([]);
  const nextStartTimeRef = useRef<number>(0);
  const allBlocksRef = useRef<SpeechBlock[]>([]);
  const pagesTextRef = useRef<string[]>([]);
  const prefetchingRef = useRef<boolean>(false);
  const playbackSpeedRef = useRef<PlaybackSpeed>(1.0);

  // Keep the ref in sync with state
  const setPlaybackSpeed = (speed: PlaybackSpeed) => {
    playbackSpeedRef.current = speed;
    setState(prev => ({ ...prev, playbackSpeed: speed }));
    // Update all currently playing sources
    audioQueueRef.current.forEach(item => {
      item.source.playbackRate.value = speed;
    });
  };

  const handleSaveKey = () => {
    if (tempOpenRouterKey.trim() && tempDeepgramKey.trim()) {
      localStorage.setItem('openrouter_api_key', tempOpenRouterKey.trim());
      localStorage.setItem('deepgram_api_key', tempDeepgramKey.trim());
      setOpenRouterKey(tempOpenRouterKey.trim());
      setDeepgramKey(tempDeepgramKey.trim());
      setShowKeyInput(false);
      setState(prev => ({ ...prev, error: null }));
    }
  };

  const handleClearKey = () => {
    localStorage.removeItem('openrouter_api_key');
    localStorage.removeItem('deepgram_api_key');
    setOpenRouterKey('');
    setDeepgramKey('');
    setTempOpenRouterKey('');
    setTempDeepgramKey('');
    setShowKeyInput(true);
    reset();
  };

  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  // Prefetch audio for the next section
  const prefetchNextSection = async (sectionIndex: number) => {
    if (prefetchingRef.current || sectionIndex >= state.sections.length) return;

    const section = state.sections[sectionIndex];
    if (section.status !== 'pending') return;

    prefetchingRef.current = true;
    const voiceName = state.selectedVoice === 'female' ? 'Kore' : 'Puck';

    try {
      // Update section status
      setState(prev => ({
        ...prev,
        sections: prev.sections.map((s, i) =>
          i === sectionIndex ? { ...s, status: 'processing' as const } : s
        )
      }));

      // Get pages for this section
      const sectionPages = pagesTextRef.current.slice(section.pageStart - 1, section.pageEnd);

      // Process section text
      const blocks = await processSectionText(
        openRouterKey,
        section.title,
        section.id,
        sectionPages
      );

      // Generate audio for all blocks
      const audioMap = await generateAudioBatch(
        deepgramKey,
        blocks,
        audioContextRef.current!,
        voiceName
      );

      // Build full blocks with audio
      const fullBlocks: SpeechBlock[] = blocks.map(b => ({
        ...b as SpeechBlock,
        audioBuffer: audioMap.get(b.id!) || null
      }));

      // Update state with processed section
      setState(prev => ({
        ...prev,
        sections: prev.sections.map((s, i) =>
          i === sectionIndex ? { ...s, blocks: fullBlocks, status: 'ready' as const } : s
        )
      }));

      allBlocksRef.current.push(...fullBlocks);
    } catch (err: any) {
      console.error('Prefetch failed:', err);
    } finally {
      prefetchingRef.current = false;
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setState(prev => ({ ...prev, error: "Please upload a valid PDF file." }));
      return;
    }

    setState(prev => ({
      ...prev,
      file,
      status: ProcessingState.PARSING_PDF,
      progress: 0,
      totalPages: 0,
      currentPage: 0,
      error: null,
      sections: [],
      currentSectionIndex: 0,
      currentlyPlayingBlockId: null
    }));

    allBlocksRef.current = [];
    nextStartTimeRef.current = 0;
    prefetchingRef.current = false;

    const voiceName = state.selectedVoice === 'female' ? 'Kore' : 'Puck';

    try {
      // Step 1: Parse PDF
      const pages = await parsePdf(file, (p) => setState(prev => ({ ...prev, progress: p })));
      pagesTextRef.current = pages.map(p => p.text);
      setState(prev => ({ ...prev, totalPages: pages.length, status: ProcessingState.EXTRACTING_SECTIONS }));

      initAudio();

      // Step 2: Extract sections
      const rawSections = await extractSections(openRouterKey, pagesTextRef.current);

      const sections: PaperSection[] = rawSections.map((s, i) => ({
        id: `section-${i}`,
        title: s.title,
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
        blocks: [],
        status: 'pending' as const
      }));

      setState(prev => ({
        ...prev,
        sections,
        status: ProcessingState.PROCESSING_SECTION,
        progress: 0
      }));

      // Step 3: Process sections sequentially, prefetching next while playing current
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];

        setState(prev => ({
          ...prev,
          currentSectionIndex: i,
          sections: prev.sections.map((s, idx) =>
            idx === i ? { ...s, status: 'processing' as const } : s
          ),
          progress: (i / sections.length) * 100
        }));

        // Get pages for this section
        const sectionPages = pagesTextRef.current.slice(section.pageStart - 1, section.pageEnd);

        // Process section text with LLM
        const blocks = await processSectionText(
          openRouterKey,
          section.title,
          section.id,
          sectionPages
        );

        setState(prev => {
          // Preserve PAUSED/PLAYING states during processing
          const status = (prev.status === ProcessingState.PAUSED || prev.status === ProcessingState.PLAYING)
            ? prev.status
            : ProcessingState.GENERATING_VOICE;
          return { ...prev, status };
        });

        // Generate audio for blocks
        const fullBlocks: SpeechBlock[] = [];
        for (const blockData of blocks) {
          const buffer = await generateAudio(deepgramKey, blockData.content!, audioContextRef.current!, voiceName);

          const fullBlock: SpeechBlock = {
            ...blockData as SpeechBlock,
            audioBuffer: buffer
          };

          fullBlocks.push(fullBlock);
          allBlocksRef.current.push(fullBlock);

          if (buffer) {
            queueAudio(fullBlock);
          }
        }

        // Update section with blocks
        setState(prev => {
          const status = (prev.status === ProcessingState.PAUSED || prev.status === ProcessingState.PLAYING)
            ? prev.status
            : ProcessingState.PROCESSING_SECTION;
          return {
            ...prev,
            sections: prev.sections.map((s, idx) =>
              idx === i ? { ...s, blocks: fullBlocks, status: 'ready' as const } : s
            ),
            status
          };
        });
      }

      setState(prev => ({ ...prev, status: ProcessingState.COMPLETED, progress: 100 }));
    } catch (err: any) {
      console.error(err);
      if (err.message === "INVALID_KEY") {
        setState(prev => ({ ...prev, status: ProcessingState.ERROR, error: "Your API key seems invalid. Please check your key and try again." }));
        setShowKeyInput(true);
      } else {
        setState(prev => ({ ...prev, status: ProcessingState.ERROR, error: err.message || "An unexpected error occurred." }));
      }
    }
  };

  const queueAudio = (block: SpeechBlock) => {
    if (!audioContextRef.current || !block.audioBuffer) return;

    const ctx = audioContextRef.current;
    const source = ctx.createBufferSource();
    source.buffer = block.audioBuffer;
    source.playbackRate.value = playbackSpeedRef.current; // Apply current speed
    source.connect(ctx.destination);

    if (nextStartTimeRef.current === 0) {
      nextStartTimeRef.current = ctx.currentTime + 0.1;
      // Only set to PLAYING if not already paused
      setState(prev => {
        if (prev.status === ProcessingState.PAUSED) return prev;
        return { ...prev, status: ProcessingState.PLAYING };
      });
    }

    const startTime = Math.max(nextStartTimeRef.current, ctx.currentTime);
    source.start(startTime);

    // Duration is affected by playback speed
    const duration = block.audioBuffer.duration / playbackSpeedRef.current;

    const timeToStart = (startTime - ctx.currentTime) * 1000;
    setTimeout(() => {
      setState(prev => ({ ...prev, currentlyPlayingBlockId: block.id }));
    }, Math.max(0, timeToStart));

    nextStartTimeRef.current = startTime + duration;
    audioQueueRef.current.push({ id: block.id, source });

    source.onended = () => {
      audioQueueRef.current = audioQueueRef.current.filter(item => item.source !== source);
      // Use functional update to get current state
      setState(prev => {
        if (audioQueueRef.current.length === 0 && prev.status === ProcessingState.COMPLETED) {
          return { ...prev, currentlyPlayingBlockId: null };
        }
        return prev;
      });
    };
  };

  const stopAudio = () => {
    audioQueueRef.current.forEach(item => {
      try { item.source.stop(); } catch (e) { }
    });
    audioQueueRef.current = [];
    nextStartTimeRef.current = 0;
  };

  const togglePlayback = () => {
    if (!audioContextRef.current) return;
    if (audioContextRef.current.state === 'running') {
      audioContextRef.current.suspend();
      setState(prev => ({ ...prev, status: ProcessingState.PAUSED }));
    } else {
      audioContextRef.current.resume();
      setState(prev => ({ ...prev, status: ProcessingState.PLAYING }));
    }
  };

  const reset = () => {
    stopAudio();
    setState(prev => ({
      ...prev,
      file: null,
      status: ProcessingState.IDLE,
      progress: 0,
      totalPages: 0,
      currentPage: 0,
      error: null,
      sections: [],
      currentSectionIndex: 0,
      currentlyPlayingBlockId: null
    }));
  };

  const setVoice = (voice: VoiceType) => {
    setState(prev => ({ ...prev, selectedVoice: voice }));
  };

  if (showKeyInput) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-slate-50 text-slate-900">
        <div className="w-full max-w-md glass p-8 rounded-3xl shadow-xl border border-white animate-in fade-in zoom-in duration-500">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-600 text-xs font-semibold mb-4">
              <Sparkles size={14} />
              <span>Setup Required</span>
            </div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">Paper Reader AI</h1>
            <p className="text-slate-500 text-sm">Enter your API keys to get started</p>
          </div>

          <div className="space-y-4 text-left">
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">OpenRouter API Key (for text analysis)</label>
              <div className="relative">
                <input
                  type={isOpenRouterKeyVisible ? "text" : "password"}
                  value={tempOpenRouterKey}
                  onChange={(e) => setTempOpenRouterKey(e.target.value)}
                  placeholder="Paste your OpenRouter API key here..."
                  className="w-full bg-slate-100 border border-slate-200 px-5 py-4 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all pr-12 font-mono"
                />
                <button
                  onClick={() => setIsOpenRouterKeyVisible(!isOpenRouterKeyVisible)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {isOpenRouterKeyVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Deepgram API Key (for TTS audio)</label>
              <div className="relative">
                <input
                  type={isDeepgramKeyVisible ? "text" : "password"}
                  value={tempDeepgramKey}
                  onChange={(e) => setTempDeepgramKey(e.target.value)}
                  placeholder="Paste your Deepgram API key here..."
                  className="w-full bg-slate-100 border border-slate-200 px-5 py-4 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all pr-12 font-mono"
                />
                <button
                  onClick={() => setIsDeepgramKeyVisible(!isDeepgramKeyVisible)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {isDeepgramKeyVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button
              onClick={handleSaveKey}
              disabled={!tempOpenRouterKey.trim() || !tempDeepgramKey.trim()}
              className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold text-lg shadow-lg shadow-indigo-100 hover:bg-indigo-700 hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:translate-y-0"
            >
              <Save size={18} />
              <span>Save & Continue</span>
            </button>
            <div className="flex gap-4 justify-center">
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-slate-400 hover:text-indigo-600 transition-colors uppercase tracking-widest"
              >
                Get OpenRouter Key <ExternalLink size={10} />
              </a>
              <a
                href="https://console.deepgram.com/signup"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-slate-400 hover:text-indigo-600 transition-colors uppercase tracking-widest"
              >
                Get Deepgram Key <ExternalLink size={10} />
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Flatten all blocks from all sections
  const allBlocksFlattened = state.sections.flatMap(s => s.blocks);
  const readySections = state.sections.filter(s => s.status === 'ready' || s.status === 'completed').length;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-6 bg-slate-50 text-slate-900 selection:bg-indigo-100 selection:text-indigo-900">
      <div className="fixed top-0 left-0 w-full h-full overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-[-5%] left-[-5%] w-[35%] h-[35%] bg-indigo-100/60 blur-[100px] rounded-full"></div>
        <div className="absolute bottom-[-5%] right-[-5%] w-[35%] h-[35%] bg-blue-100/60 blur-[100px] rounded-full"></div>
      </div>

      {state.status === ProcessingState.IDLE && (
        <header className="mb-8 text-center animate-in fade-in slide-in-from-top duration-700 w-full max-w-xl">
          <div className="flex items-center justify-center gap-2 mb-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-600 text-xs font-semibold">
              <Sparkles size={14} />
              <span>AI Research Assistant</span>
            </div>
            <button
              onClick={() => setShowKeyInput(true)}
              className="p-1.5 rounded-full bg-white border border-slate-200 text-slate-400 hover:text-indigo-600 transition-colors shadow-sm"
              title="Change API Key"
            >
              <Settings size={14} />
            </button>
          </div>
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src="/images/logo.png" alt="Paper Reader AI" className="w-14 h-14 md:w-16 md:h-16 rounded-2xl" />
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-slate-900 font-['Inter']">
              Paper Reader <span className="text-indigo-600">AI</span>
            </h1>
          </div>
          <p className="text-slate-600 max-w-lg mx-auto text-base md:text-lg leading-relaxed">
            Upload your PDF and listen to research papers. Papers are intelligently split into sections for natural narration.
          </p>
        </header>
      )}

      <main className="w-full max-w-4xl flex flex-col gap-6">
        {state.status === ProcessingState.IDLE && (
          <div className="glass p-8 md:p-12 rounded-[2rem] border-dashed border-2 border-indigo-200 flex flex-col items-center gap-8 transition-all hover:border-indigo-400 shadow-sm relative overflow-hidden">
            <div className="w-full flex flex-col items-center gap-4">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Select Narrator</span>
              <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200 shadow-inner">
                <button
                  onClick={() => setVoice('female')}
                  className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${state.selectedVoice === 'female' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <User size={16} />
                  Female
                </button>
                <button
                  onClick={() => setVoice('male')}
                  className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${state.selectedVoice === 'male' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <User size={16} />
                  Male
                </button>
              </div>
            </div>

            <div className="w-full flex flex-col items-center gap-6 py-4 border-t border-slate-100 group cursor-pointer active:scale-[0.99] transition-all">
              <div className="w-20 h-20 bg-indigo-50 rounded-[1.5rem] flex items-center justify-center text-indigo-500 group-hover:scale-110 transition-transform shadow-inner border border-indigo-100">
                <Upload size={36} />
              </div>
              <div className="text-center">
                <h2 className="text-xl md:text-2xl font-bold text-slate-800 mb-1">Ready to start?</h2>
                <p className="text-slate-500 text-sm">Select a PDF to begin intelligent narration</p>
              </div>
              <label className="relative cursor-pointer">
                <span className="bg-indigo-600 text-white px-10 py-3.5 rounded-2xl font-bold text-base shadow-lg shadow-indigo-200 hover:bg-indigo-700 hover:-translate-y-0.5 transition-all inline-block">
                  Choose PDF File
                </span>
                <input
                  type="file"
                  className="hidden"
                  accept="application/pdf"
                  onChange={handleFileUpload}
                />
              </label>
            </div>

            <div className="mt-2 flex gap-4 text-slate-400 text-[10px] md:text-xs font-medium uppercase tracking-wider">
              <span className="flex items-center gap-1"><BookOpen size={12} /> Section-based reading</span>
              <span className="flex items-center gap-1"><Sparkles size={12} /> Smart analysis</span>
            </div>
          </div>
        )}

        {state.status !== ProcessingState.IDLE && (
          <div className="glass rounded-[2rem] overflow-hidden shadow-xl border border-white flex flex-col h-[85vh] md:h-[75vh] animate-in fade-in zoom-in duration-500">
            <div className="px-6 md:px-10 py-5 md:py-6 border-b border-slate-100 flex items-center justify-between bg-white/40 sticky top-0 z-10">
              <div className="flex items-center gap-3 md:gap-4 overflow-hidden">
                <button onClick={reset} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                  <ArrowLeft size={20} className="text-slate-500" />
                </button>
                <div className="overflow-hidden">
                  <h3 className="text-slate-900 text-sm md:text-lg font-bold truncate">
                    {state.file?.name}
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${state.status === ProcessingState.PLAYING ? 'bg-indigo-500 animate-pulse' : 'bg-slate-300'}`}></span>
                    <p className="text-slate-500 text-[10px] md:text-xs font-semibold uppercase tracking-wider">
                      {state.status === ProcessingState.COMPLETED ? "Finished" : state.status.replace(/_/g, ' ')} • {state.selectedVoice} voice
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowKeyInput(true)}
                  className="p-2 rounded-full hover:bg-slate-100 text-slate-400 hover:text-indigo-600 transition-colors"
                  title="Settings"
                >
                  <Settings size={20} />
                </button>
                {state.status !== ProcessingState.COMPLETED && state.status !== ProcessingState.ERROR && (
                  <div className="px-3 py-1 bg-white rounded-full border border-slate-200 flex items-center gap-2 text-indigo-600 text-[10px] md:text-xs font-bold shadow-sm">
                    <Loader2 size={12} className="animate-spin" />
                    {Math.round(state.progress)}%
                  </div>
                )}
              </div>
            </div>

            {/* Section tabs */}
            {state.sections.length > 0 && (
              <div className="px-6 md:px-10 py-3 bg-slate-50/80 border-b border-slate-100 flex gap-2 overflow-x-auto custom-scrollbar">
                {state.sections.map((section, idx) => (
                  <div
                    key={section.id}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${section.status === 'ready' || section.status === 'completed'
                      ? 'bg-indigo-100 text-indigo-700'
                      : section.status === 'processing'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-500'
                      }`}
                  >
                    {section.status === 'processing' && <Loader2 size={10} className="inline mr-1 animate-spin" />}
                    {section.title}
                  </div>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-6 md:p-10 space-y-6 custom-scrollbar scroll-smooth bg-white/20">
              {allBlocksFlattened.length > 0 ? (
                allBlocksFlattened.map((block) => {
                  const isActive = state.currentlyPlayingBlockId === block.id;
                  const section = state.sections.find(s => s.id === block.sectionId);
                  return (
                    <div
                      key={block.id}
                      id={block.id}
                      className={`relative p-5 md:p-6 rounded-2xl transition-all duration-700 ${isActive
                        ? 'bg-white ring-1 ring-slate-200 shadow-lg shadow-indigo-100/20 translate-x-1'
                        : 'opacity-40 grayscale-[0.3]'
                        } ${block.type === BlockType.DESCRIPTION ? 'border-dashed border-2 border-indigo-100 bg-indigo-50/30' : ''}`}
                    >
                      {isActive && (
                        <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 h-8 bg-indigo-600 rounded-full shadow-[0_0_10px_rgba(79,70,229,0.4)]"></div>
                      )}

                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded ${block.type === BlockType.DESCRIPTION
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-100 text-slate-500'
                            }`}>
                            {block.type === BlockType.DESCRIPTION ? 'Analysis' : 'Paper Text'}
                          </span>
                          {section && (
                            <span className="text-[9px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                              {section.title}
                            </span>
                          )}
                        </div>
                        {isActive && <Volume2 size={14} className="text-indigo-600 animate-bounce" />}
                      </div>

                      <p className={`text-base md:text-lg font-['Inter'] leading-relaxed ${isActive ? 'text-slate-900 font-medium' : 'text-slate-600'}`}>
                        {block.content}
                      </p>
                    </div>
                  );
                })
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4 opacity-50">
                  <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center">
                    <Headphones size={32} className="animate-pulse" />
                  </div>
                  <p className="italic text-base font-medium">
                    {state.status === ProcessingState.EXTRACTING_SECTIONS
                      ? 'Detecting paper sections...'
                      : 'Processing sections...'}
                  </p>
                </div>
              )}
            </div>

            <div className="px-6 md:px-10 py-6 md:py-8 bg-white border-t border-slate-100 flex flex-col md:flex-row items-center gap-6 shadow-[0_-10px_20px_rgba(0,0,0,0.02)]">
              <div className="flex items-center gap-4 w-full md:w-auto justify-center">
                <button
                  onClick={togglePlayback}
                  disabled={allBlocksFlattened.length === 0}
                  className="w-14 h-14 md:w-16 md:h-16 bg-indigo-600 text-white rounded-2xl flex items-center justify-center hover:bg-indigo-700 hover:scale-105 active:scale-95 transition-all shadow-xl shadow-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed group"
                >
                  {state.status === ProcessingState.PLAYING ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" className="ml-1" />}
                </button>
              </div>

              <div className="flex-1 w-full max-w-md">
                <div className="flex justify-between items-end mb-2 px-1">
                  <div className="flex flex-col">
                    <span className="text-slate-800 text-[10px] md:text-xs font-bold uppercase tracking-wider">Sections Progress</span>
                  </div>
                  <div className="text-indigo-600 font-bold text-xs">
                    {readySections}/{state.sections.length} Sections
                  </div>
                </div>
                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden p-0 border border-slate-200">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-1000 ease-out shadow-[0_0_8px_rgba(79,70,229,0.2)]"
                    style={{ width: `${state.sections.length > 0 ? (readySections / state.sections.length) * 100 : 0}%` }}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Gauge size={16} className="text-slate-400" />
                <div className="flex bg-slate-100 rounded-lg p-0.5 border border-slate-200">
                  {SPEED_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setPlaybackSpeed(opt.value)}
                      className={`px-2 py-1 text-[10px] md:text-xs font-bold rounded-md transition-all ${state.playbackSpeed === opt.value
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                        }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {state.error && (
          <div className="bg-red-50 border border-red-100 p-5 rounded-3xl flex items-center gap-4 text-red-600 shadow-sm animate-in fade-in slide-in-from-bottom duration-300">
            <div className="p-2 bg-red-100 rounded-xl">
              <AlertCircle size={24} />
            </div>
            <div>
              <p className="font-bold text-sm">Action Required</p>
              <p className="text-xs font-medium opacity-80">{state.error}</p>
            </div>
            <button onClick={() => setState(s => ({ ...s, error: null }))} className="ml-auto text-xs font-bold bg-white px-3 py-1 rounded-lg border border-red-100">Dismiss</button>
          </div>
        )}
      </main>

      <footer className="mt-auto py-10 text-slate-400 text-xs flex flex-col items-center gap-2 w-full text-center">
        <p className="opacity-80">
          Vibe coded by <a href="https://bhavinjawade.github.io" target="_blank" rel="noopener noreferrer" className="text-indigo-600 font-semibold hover:underline">Bhavin Jawade</a> with <span className="text-indigo-600">Antigravity</span> + <span className="text-indigo-600">Claude Opus 4.5</span>
        </p>
        <p className="opacity-60 text-[10px]">
          LLM APIs from <span className="text-indigo-600">OpenRouter</span> · Speech Generation using <span className="text-indigo-600">Deepgram</span>
        </p>
        <p className="opacity-50 font-bold uppercase tracking-widest text-[9px] mt-1">
          Your key is never sent to our servers.
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #cbd5e1;
        }
      `}</style>
    </div>
  );
};

export default App;
