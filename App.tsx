
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { GeminiService, encodeAudio, decodeBase64 } from './services/geminiService';
import { VoiceCategory, AnalysisResult, WebsiteAnalysisResult } from './types';

const gemini = new GeminiService();

// Helper to decode PCM for Live API playback
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'audit' | 'instant' | 'link'>('instant');
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Audio Refs & State
  const [amplitude, setAmplitude] = useState(0);
  const [recordingTime, setRecordingTime] = useState(0);
  const [voiceResult, setVoiceResult] = useState<AnalysisResult | null>(null);

  // Instant State
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [liveVerdict, setLiveVerdict] = useState<{category: VoiceCategory; text: string} | null>(null);
  const [liveStatus, setLiveStatus] = useState('Standby');

  // Link State
  const [urlInput, setUrlInput] = useState('');
  const [linkResult, setLinkResult] = useState<WebsiteAnalysisResult | null>(null);

  // Refs for Cleanup and Processing
  const audioContextRef = useRef<AudioContext | null>(null);
  const outAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const liveSessionRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  // Added comment: Properly cleanup session and hardware resources. Calls session.close() as mandated.
  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (outAudioContextRef.current) {
      outAudioContextRef.current.close().catch(() => {});
      outAudioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (liveSessionRef.current) {
      // Fix: session.close() should be called to release resources.
      liveSessionRef.current.then((session) => {
        try {
          session.close();
        } catch (e) {
          console.debug('Session already closed');
        }
      });
      liveSessionRef.current = null;
    }
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setAmplitude(0);
  }, []);

  // --- INSTANT MODE LOGIC ---
  const startInstantScan = async () => {
    try {
      cleanup();
      setIsLiveActive(true);
      setLiveVerdict(null);
      setLiveStatus('Syncing Neural Engine...');
      setError(null);
      nextStartTimeRef.current = 0;

      // Always initialize a new instance before a session to ensure fresh environment variable access.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      await inCtx.resume();
      await outCtx.resume();
      
      audioContextRef.current = inCtx;
      outAudioContextRef.current = outCtx;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: 'You are a REAL-TIME voice authenticity analyzer. Listen to the stream. IMMEDIATELY tell me if the speaker is a HUMAN or an AI. Analyze spectral features and artifacts. Say exactly "VERDICT: HUMAN" or "VERDICT: AI". Be lightning fast. Use the output audio transcription modality to display results.',
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setLiveStatus('NEURAL LINK ACTIVE - ANALYZING...');
            
            // Fix: Removed incorrect and redundant sendRealtimeInput call with text parts.
            // The prompt is already in systemInstruction. sendRealtimeInput expects media parameters.

            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Calculate amplitude for UI wave
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setAmplitude(Math.sqrt(sum / inputData.length) * 3); 

              const b64Data = encodeAudio(inputData);
              // Ensure sessionPromise resolves before sending input to avoid race conditions.
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: { data: b64Data, mimeType: 'audio/pcm;rate=16000' } });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (msg) => {
            // Text results via transcription
            if (msg.serverContent?.outputTranscription) {
              const text = msg.serverContent.outputTranscription.text.toUpperCase();
              if (text.includes('HUMAN')) {
                setLiveVerdict({category: VoiceCategory.HUMAN, text: 'AUTHENTIC HUMAN DETECTED'});
                setLiveStatus('Verdict Finalized');
              } else if (text.includes('AI') || text.includes('SYNTHETIC') || text.includes('BOT')) {
                setLiveVerdict({category: VoiceCategory.AI, text: 'SYNTHETIC AI DETECTED'});
                setLiveStatus('Verdict Finalized');
              }
            }

            // Audio feedback from the model
            const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outCtx) {
              // Scheduling audio for gapless playback as per guidelines.
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const audioBytes = decodeBase64(base64Audio);
              const audioBuffer = await decodeAudioData(audioBytes, outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current = nextStartTimeRef.current + audioBuffer.duration;
            }

            if (msg.serverContent?.interrupted) {
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: any) => {
            console.error("Live Session Error:", e);
            setError("Network Link Failure. Please restart.");
            stopInstantScan();
          },
          onclose: () => stopInstantScan()
        }
      });
      liveSessionRef.current = sessionPromise;
    } catch (err) {
      console.error(err);
      setError("Microphone required for instant pulse analysis.");
      setIsLiveActive(false);
    }
  };

  const stopInstantScan = () => {
    setIsLiveActive(false);
    setLiveStatus('Standby');
    cleanup();
  };

  // --- AUDIT MODE LOGIC (RECORD THEN ANALYZE) ---
  const startRecording = async () => {
    try {
      cleanup();
      setIsRecording(true);
      setIsAnalyzing(false);
      setVoiceResult(null);
      setError(null);
      setRecordingTime(0);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = scriptProcessor;
      
      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        setAmplitude(Math.sqrt(sum / inputData.length));
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioCtx.destination);

      const mediaRecorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      mediaRecorder.onstop = async () => {
        setIsAnalyzing(true);
        const audioBlob = new Blob(chunks, { type: 'audio/wav' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(',')[1];
          const res = await gemini.analyzeAudioFile({ data: base64, mimeType: 'audio/wav' });
          setVoiceResult(res);
          setIsAnalyzing(false);
          cleanup();
        };
      };
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();

      timerRef.current = window.setInterval(() => setRecordingTime(prev => prev + 1), 1000);
    } catch (err) {
      setError("Microphone access denied.");
      setIsRecording(false);
    }
  };

  const stopAndAnalyze = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsLoading(true);
    setVoiceResult(null);
    setIsAnalyzing(true);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onloadend = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const res = await gemini.analyzeAudioFile({ data: base64, mimeType: file.type });
        setVoiceResult(res);
        setIsLoading(false);
        setIsAnalyzing(false);
      };
    } catch (err) {
      setError("File analysis failed.");
      setIsLoading(false);
      setIsAnalyzing(false);
    }
  };

  const handleLinkCheck = async () => {
    if (!urlInput) return;
    setIsLoading(true);
    setError(null);
    setLinkResult(null);
    try {
      const res = await gemini.analyzeWebsite(urlInput);
      setLinkResult(res);
    } catch (err) {
      setError("Website verification failed.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 relative overflow-x-hidden selection:bg-cyan-500/30">
      {/* Dynamic Background Glow */}
      {(isRecording || isLiveActive) && (
        <div 
          className="fixed inset-0 pointer-events-none transition-all duration-300 opacity-25 z-0"
          style={{
            background: `radial-gradient(circle at 50% 50%, hsla(${isLiveActive ? 180 : 260}, 100%, 50%, ${0.1 + amplitude * 4}) 0%, transparent 70%)`,
            transform: `scale(${1 + amplitude * 2})`
          }}
        />
      )}

      <header className="glass sticky top-0 z-50 px-8 py-5 border-b border-white/5 flex items-center justify-between shadow-2xl">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 bg-gradient-to-br from-cyan-600 to-indigo-700 rounded-2xl flex items-center justify-center shadow-lg shadow-cyan-500/30 border border-white/10">
            <i className="fa-solid fa-bolt text-white text-xl"></i>
          </div>
          <h1 className="text-xl font-black tracking-tighter uppercase">Veri<span className="text-cyan-400">Voice</span></h1>
        </div>
        
        <div className="hidden md:flex bg-slate-900/90 p-1.5 rounded-2xl border border-white/10">
          <button onClick={() => { setActiveTab('instant'); cleanup(); }} className={`px-6 py-2.5 rounded-xl text-[10px] font-black tracking-widest transition-all ${activeTab === 'instant' ? 'bg-cyan-600 text-white shadow-xl' : 'text-slate-500 hover:text-slate-300'}`}>INSTANT PULSE</button>
          <button onClick={() => { setActiveTab('audit'); cleanup(); }} className={`px-6 py-2.5 rounded-xl text-[10px] font-black tracking-widest transition-all ${activeTab === 'audit' ? 'bg-cyan-600 text-white shadow-xl' : 'text-slate-500 hover:text-slate-300'}`}>LAB AUDIT</button>
          <button onClick={() => { setActiveTab('link'); cleanup(); }} className={`px-6 py-2.5 rounded-xl text-[10px] font-black tracking-widest transition-all ${activeTab === 'link' ? 'bg-cyan-600 text-white shadow-xl' : 'text-slate-500 hover:text-slate-300'}`}>URL SHIELD</button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 relative z-10">
        {activeTab === 'instant' ? (
          <div className="space-y-12 animate-in fade-in zoom-in-95 duration-500">
            <div className="text-center space-y-4">
              <h2 className="text-7xl font-black tracking-tighter uppercase">Instant <span className="text-cyan-400 italic">Pulse</span></h2>
              <p className="text-slate-500 text-xs font-black tracking-[0.5em] uppercase">Live Neural Verification</p>
            </div>

            <div className={`glass rounded-[4rem] p-12 border-2 transition-all duration-700 relative overflow-hidden ${isLiveActive ? 'border-cyan-500 shadow-[0_0_100px_rgba(34,211,238,0.15)] scale-[1.02]' : 'border-white/5'}`}>
              <div className="flex justify-between items-center mb-16">
                <div className={`w-24 h-24 rounded-[2.5rem] flex items-center justify-center transition-all ${isLiveActive ? 'bg-cyan-500 text-white shadow-2xl shadow-cyan-500/50' : 'bg-slate-800 text-slate-500'}`}>
                   <i className={`fa-solid ${isLiveActive ? 'fa-satellite-dish animate-pulse' : 'fa-power-off'} text-4xl`}></i>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Live Feed Status</p>
                  <p className={`text-sm font-black uppercase tracking-wider ${isLiveActive ? 'text-cyan-400' : 'text-slate-600'}`}>{liveStatus}</p>
                </div>
              </div>

              <div className="h-40 flex flex-col items-center justify-center">
                {isLiveActive ? (
                  <div className="w-full flex justify-center items-center gap-2 h-32">
                    {[...Array(30)].map((_, i) => (
                      <div 
                        key={i} 
                        className="w-2 bg-gradient-to-t from-cyan-600 to-cyan-400 rounded-full transition-all duration-100 ease-out" 
                        style={{ height: `${20 + Math.random() * 80}%`, transform: `scaleY(${0.1 + amplitude * (10 + i)})`, opacity: 0.3 + (i/30) }}
                      ></div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center space-y-4 opacity-10">
                    <i className="fa-solid fa-wave-square text-8xl"></i>
                    <p className="text-[10px] font-black uppercase tracking-[1em]">Engine Idle</p>
                  </div>
                )}
              </div>

              {liveVerdict && (
                <div className={`mt-12 p-10 rounded-[3rem] border-2 text-center animate-in slide-in-from-top-6 duration-700 ${liveVerdict.category === VoiceCategory.AI ? 'bg-red-500/10 border-red-500/40 text-red-400 shadow-[0_0_60px_rgba(239,68,68,0.15)]' : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 shadow-[0_0_60px_rgba(16,185,129,0.15)]'}`}>
                  <p className="text-[11px] font-black tracking-[0.8em] mb-4 uppercase opacity-60">Forensic Identity Match</p>
                  <p className="text-5xl font-black tracking-tighter uppercase">{liveVerdict.text}</p>
                </div>
              )}

              <button 
                onClick={isLiveActive ? stopInstantScan : startInstantScan}
                className={`w-full py-8 rounded-[3rem] font-black tracking-[0.5em] uppercase transition-all mt-12 border-2 shadow-2xl text-lg ${isLiveActive ? 'bg-red-500/10 border-red-500/40 text-red-400 hover:bg-red-500/20' : 'bg-cyan-600 border-cyan-400 text-white shadow-cyan-600/30 hover:bg-cyan-500 hover:scale-[1.01]'}`}
              >
                {isLiveActive ? 'Terminate Neural Link' : 'Establish Pulse Connection'}
              </button>
            </div>
          </div>
        ) : activeTab === 'audit' ? (
          <div className="space-y-10 animate-in fade-in duration-500">
             <div className="text-center space-y-4">
              <h2 className="text-6xl font-black tracking-tighter uppercase">Lab <span className="text-cyan-400 italic">Audit</span></h2>
              <p className="text-slate-500 text-xs font-black tracking-[0.5em] uppercase">Deep Forensic Analysis</p>
            </div>
            <div className="grid md:grid-cols-2 gap-10">
              <div className={`glass rounded-[3rem] p-10 border-2 transition-all relative overflow-hidden ${isRecording ? 'border-indigo-500 shadow-xl' : 'border-white/5'}`}>
                <div className="h-44 flex flex-col items-center justify-center space-y-8">
                  {isRecording ? (
                    <div className="w-full text-center">
                       <div className="text-5xl font-black mb-4">{recordingTime}s</div>
                       <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest animate-pulse">Capturing Sample...</p>
                    </div>
                  ) : isAnalyzing ? (
                    <div className="text-center space-y-4">
                       <i className="fa-solid fa-microchip fa-spin text-5xl text-indigo-500"></i>
                       <p className="text-xs font-black uppercase text-slate-400">Scanning Artifacts...</p>
                    </div>
                  ) : (
                    <div className="text-center space-y-3 opacity-20">
                      <i className="fa-solid fa-microphone-lines text-5xl"></i>
                      <p className="text-xs font-black uppercase">Record Sample</p>
                    </div>
                  )}
                </div>
                <button onClick={isRecording ? stopAndAnalyze : startRecording} disabled={isAnalyzing} className={`w-full py-6 rounded-[2rem] font-black tracking-widest uppercase transition-all mt-10 border-2 ${isRecording ? 'bg-red-500/10 border-red-500/40 text-red-400' : 'bg-indigo-600 border-indigo-400 text-white disabled:opacity-50'}`}>{isRecording ? 'Process Audit' : 'Start Recording'}</button>
              </div>
              <div className="glass rounded-[3rem] p-10 border border-white/5 flex flex-col justify-between hover:border-white/10 transition-all">
                <div className="space-y-4"><i className="fa-solid fa-folder-open text-4xl text-slate-600"></i><h3 className="text-2xl font-black uppercase">Verify File</h3><p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Deep scan existing audio files.</p></div>
                <input type="file" onChange={handleFileUpload} className="hidden" id="file-input" accept="audio/*" />
                <label htmlFor="file-input" className="w-full py-6 rounded-[2rem] font-black tracking-widest uppercase bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-all flex items-center justify-center gap-4 cursor-pointer mt-10">
                  {isLoading ? <i className="fa-solid fa-circle-notch animate-spin"></i> : <i className="fa-solid fa-upload"></i>}Upload Audio
                </label>
              </div>
            </div>
            {voiceResult && !isAnalyzing && (
              <div className="glass rounded-[3rem] border border-cyan-500/20 p-12 shadow-4xl animate-in slide-in-from-bottom-10">
                <div className="flex flex-col md:flex-row items-center justify-between gap-12 mb-12">
                  <div className="text-center md:text-left"><p className="text-xs font-black text-slate-500 uppercase mb-4 tracking-widest">Audit Verdict</p><p className={`text-6xl font-black uppercase ${voiceResult.category === VoiceCategory.AI ? 'text-red-500' : 'text-emerald-500'}`}>{voiceResult.category}</p></div>
                  <div className="bg-slate-950 p-8 rounded-[2rem] border border-white/5"><p className="text-[10px] font-black text-slate-500 uppercase mb-2">Confidence Index</p><p className="text-4xl font-black text-white">{voiceResult.confidence}%</p></div>
                </div>
                <div className="space-y-4">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.4em]">Reasoning Report</p>
                  {voiceResult.reasoning.map((r, i) => (
                    <div key={i} className="p-5 bg-white/5 rounded-2xl text-sm text-slate-300 font-medium border border-white/5 hover:border-cyan-500/30 transition-all"><i className="fa-solid fa-check text-cyan-500 mr-4"></i>{r}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-12 animate-in fade-in duration-500">
            <div className="text-center space-y-4">
              <h2 className="text-6xl font-black tracking-tighter uppercase">URL <span className="text-cyan-400 italic">Shield</span></h2>
              <p className="text-slate-500 text-xs font-black tracking-[0.5em] uppercase">Domain Authenticity Baseline</p>
            </div>
            <div className="glass rounded-[3.5rem] p-12 border border-white/5">
              <div className="flex flex-col md:flex-row gap-6">
                <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="Paste URL for security audit..." className="flex-grow bg-slate-950 border border-white/10 rounded-[2.5rem] py-7 px-10 focus:outline-none focus:ring-4 focus:ring-cyan-500/20 text-white font-medium" />
                <button onClick={handleLinkCheck} disabled={isLoading} className="bg-cyan-600 px-12 rounded-[2.5rem] font-black uppercase tracking-widest hover:bg-cyan-500 disabled:opacity-50 shadow-xl transition-all shadow-cyan-600/20">{isLoading ? 'Scanning...' : 'Shield Audit'}</button>
              </div>
            </div>
            {linkResult && (
              <div className={`glass rounded-[4rem] p-16 border animate-in zoom-in-95 ${linkResult.isValid ? 'border-emerald-500/20' : 'border-red-500/20'}`}>
                <div className="flex flex-col md:flex-row gap-16 items-center">
                  <div className="text-center p-12 bg-black/40 rounded-[3rem] border border-white/5 min-w-[200px] shadow-inner"><span className="text-7xl font-black block tracking-tighter">{linkResult.securityScore}</span><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Security Score</span></div>
                  <div className="space-y-6 flex-grow">
                    <h4 className="text-4xl font-black uppercase tracking-tight">{linkResult.siteInfo.title || 'Domain Analysis'}</h4>
                    <p className="text-slate-400 text-lg leading-relaxed">{linkResult.siteInfo.description}</p>
                    <div className="grid gap-4">{linkResult.details.map((d, i) => (<div key={i} className="flex gap-4 items-center bg-white/5 p-5 rounded-2xl text-xs font-bold border border-white/5"><i className="fa-solid fa-shield-halved text-cyan-500"></i>{d}</div>))}</div>
                    {linkResult.groundingUrls && linkResult.groundingUrls.length > 0 && (
                      <div className="mt-8 space-y-4"><p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.5em]">Verification Sources</p><div className="flex flex-wrap gap-3">{linkResult.groundingUrls.map((url, i) => (<a key={i} href={url} target="_blank" rel="noopener noreferrer" className="px-5 py-3 bg-cyan-500/10 border border-cyan-500/20 rounded-2xl text-[10px] font-bold text-cyan-400 hover:bg-cyan-500/20 transition-all flex items-center gap-2 shadow-sm"><i className="fa-solid fa-up-right-from-square"></i>Source {i + 1}</a>))}</div></div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-16 bg-red-950/40 border-2 border-red-500/50 p-10 rounded-[3rem] flex items-center gap-8 animate-in slide-in-from-bottom-6">
            <i className="fa-solid fa-circle-exclamation text-4xl text-red-500"></i>
            <p className="text-sm font-bold text-red-200 uppercase tracking-widest leading-loose">{error}</p>
          </div>
        )}
      </main>

      <footer className="py-24 text-center opacity-30">
        <p className="text-[10px] font-black uppercase tracking-[1.5em] text-slate-500">Neural Engine v3.9.0 // VeriVoice Labs</p>
      </footer>
    </div>
  );
};

export default App;
