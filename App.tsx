
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Language, TranscriptionEntry, ConnectionStatus } from './types';
import { decodeBase64, decodeAudioData, createPcmBlob } from './utils/audio';
import { Visualizer } from './components/Visualizer';
import { TranscriptionList } from './components/TranscriptionList';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

// More robust script detection
const detectLanguage = (text: string): Language => {
  const amharicRegex = /[\u1200-\u137F]/;
  // If text contains mostly Ethiopic characters, it's Amharic
  const ethioMatches = (text.match(/[\u1200-\u137F]/g) || []).length;
  const latinMatches = (text.match(/[a-zA-Z]/g) || []).length;
  
  if (ethioMatches > latinMatches) return 'Amharic';
  return 'Afaan Oromoo';
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  
  const currentInputTransRef = useRef<string>('');
  const currentOutputTransRef = useRef<string>('');

  const stopAllAudio = () => {
    sourcesRef.current.forEach((source) => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    stopAllAudio();
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const connect = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setErrorMsg(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      micStreamRef.current = stream;

      const systemInstruction = `You are a professional real-time bidirectional translator between Afaan Oromoo (Oromiffa) and Amharic. 
      - Automatically detect whether the user is speaking Afaan Oromoo or Amharic.
      - If they speak Afaan Oromoo, immediately translate to Amharic.
      - If they speak Amharic, immediately translate to Afaan Oromoo.
      - Speak ONLY the translation.
      - Maintain natural phrasing.
      - If input is unclear, wait for more context.`;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              currentInputTransRef.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTransRef.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const input = currentInputTransRef.current.trim();
              const output = currentOutputTransRef.current.trim();

              if (input) {
                setTranscriptions(prev => [...prev.slice(-19), {
                  id: Math.random().toString(36).substr(2, 9),
                  sender: 'user',
                  text: input,
                  language: detectLanguage(input),
                  timestamp: new Date()
                }]);
                currentInputTransRef.current = '';
              }
              if (output) {
                setTranscriptions(prev => [...prev.slice(-19), {
                  id: Math.random().toString(36).substr(2, 9),
                  sender: 'model',
                  text: output,
                  language: detectLanguage(output),
                  timestamp: new Date()
                }]);
                currentOutputTransRef.current = '';
              }
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const ctx = outputAudioContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decodeBase64(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              stopAllAudio();
            }
          },
          onerror: (e) => {
            console.error('Session Error:', e);
            setStatus(ConnectionStatus.ERROR);
            setErrorMsg('Session interrupted. Trying to reconnect...');
            setTimeout(connect, 2000);
          },
          onclose: () => {
            disconnect();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error(err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMsg(err.message || 'Failed to access microphone or connect.');
      disconnect();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-inter selection:bg-indigo-500/30">
      <header className="px-6 py-4 border-b border-slate-800 bg-slate-900/40 backdrop-blur-xl flex items-center justify-between z-20">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-900/20 rotate-3 transition-transform hover:rotate-0">
            <svg className="w-6 h-6 text-white drop-shadow-md" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5c1.382 3.307 3.416 6.333 6.049 8.873m-3.355-1.92a18.07 18.07 0 01-1.34-4.203" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight leading-none bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">Oromo ↔ Amharic</h1>
            <p className="text-[10px] text-indigo-400/80 font-bold uppercase tracking-[0.2em] mt-1">Live AI Engine</p>
          </div>
        </div>

        <div className="flex items-center gap-3 bg-slate-800/30 px-3 py-1.5 rounded-full border border-slate-700/50">
          <div className={`w-2.5 h-2.5 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 live-pulse' : 'bg-slate-600'}`} />
          <span className="text-[11px] font-bold text-slate-300 tracking-wide">
            {status === ConnectionStatus.CONNECTED ? 'CONNECTED' : status === ConnectionStatus.CONNECTING ? 'LINKING...' : 'OFFLINE'}
          </span>
        </div>
      </header>

      {errorMsg && (
        <div className="bg-red-900/20 border-b border-red-800/50 px-6 py-2.5 text-red-300 text-xs font-medium flex items-center justify-between animate-in slide-in-from-top duration-300">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <p>{errorMsg}</p>
          </div>
          <button onClick={() => setErrorMsg(null)} className="p-1 hover:bg-red-800/30 rounded">&times;</button>
        </div>
      )}

      <main className="flex-1 flex flex-col relative overflow-hidden">
        <TranscriptionList entries={transcriptions} />
        
        <div className="absolute bottom-28 left-0 right-0 flex justify-center pointer-events-none px-4">
          <div className="bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 rounded-3xl px-10 py-5 flex flex-col items-center gap-2 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
             <div className="flex items-center gap-10">
                <div className="flex flex-col items-center">
                   <span className="text-[9px] text-slate-500 font-black uppercase tracking-widest mb-2">Input Voice</span>
                   <Visualizer isActive={status === ConnectionStatus.CONNECTED && !isMuted} color="#6366f1" />
                </div>
                <div className="w-px h-10 bg-slate-800" />
                <div className="flex flex-col items-center">
                   <span className="text-[9px] text-slate-500 font-black uppercase tracking-widest mb-2">Translator</span>
                   <Visualizer isActive={status === ConnectionStatus.CONNECTED && sourcesRef.current.size > 0} color="#10b981" />
                </div>
             </div>
             {status === ConnectionStatus.CONNECTED && (
                <p className="text-[10px] text-indigo-400 font-bold tracking-wider animate-pulse mt-2 uppercase">
                  Listening for Oromiffa or Amharic...
                </p>
             )}
          </div>
        </div>
      </main>

      <footer className="p-8 bg-slate-900/80 backdrop-blur-md border-t border-slate-800/60">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-6">
          <button
            onClick={() => setIsMuted(!isMuted)}
            disabled={status !== ConnectionStatus.CONNECTED}
            className={`p-5 rounded-2xl transition-all duration-300 ${
              isMuted 
                ? 'bg-red-500/20 text-red-500 ring-2 ring-red-500/40 shadow-lg shadow-red-900/20' 
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:scale-105 active:scale-95'
            } disabled:opacity-30 disabled:grayscale`}
          >
            {isMuted ? (
              <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            ) : (
              <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnect : connect}
            className={`flex-1 py-5 px-10 rounded-3xl font-black text-xl tracking-tight transition-all duration-300 shadow-2xl active:scale-[0.98] ${
              status === ConnectionStatus.CONNECTED
                ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white shadow-red-900/30'
                : status === ConnectionStatus.CONNECTING
                ? 'bg-slate-800 text-slate-400 cursor-wait'
                : 'bg-gradient-to-r from-indigo-600 to-blue-700 hover:from-indigo-500 hover:to-blue-600 text-white shadow-indigo-900/40'
            }`}
          >
            {status === ConnectionStatus.CONNECTED ? 'STOP SESSION' : status === ConnectionStatus.CONNECTING ? 'INITIALIZING...' : 'START TRANSLATING'}
          </button>

          <button
            onClick={() => setTranscriptions([])}
            className="p-5 rounded-2xl bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white transition-all duration-300 group"
            title="Clear history"
          >
            <svg className="w-7 h-7 group-hover:rotate-12 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
};

export default App;
