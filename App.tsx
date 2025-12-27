
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Language, TranscriptionEntry, ConnectionStatus } from './types';
import { decodeBase64, decodeAudioData, createPcmBlob } from './utils/audio';
import { Visualizer } from './components/Visualizer';
import { TranscriptionList } from './components/TranscriptionList';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

// Simple script detection to label transcriptions
const detectLanguage = (text: string): Language => {
  const amharicRegex = /[\u1200-\u137F]/;
  return amharicRegex.test(text) ? 'Amharic' : 'Afaan Oromoo';
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Refs for audio processing
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  
  // Transcription buffers
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
      sessionRef.current.close();
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

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const systemInstruction = `You are a professional real-time bidirectional translator between Afaan Oromoo (Oromiffa) and Amharic. 
      - Automatically detect whether the user is speaking Afaan Oromoo or Amharic.
      - If they speak Afaan Oromoo, immediately translate and speak the Amharic translation.
      - If they speak Amharic, immediately translate and speak the Afaan Oromoo translation.
      - Speak ONLY the translation, nothing else.
      - Maintain natural flow and the speaker's original intent.
      - If you truly don't understand, wait for more input or ask for a very brief clarification in the detected language.`;

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
                setTranscriptions(prev => [...prev, {
                  id: Math.random().toString(36).substr(2, 9),
                  sender: 'user',
                  text: input,
                  language: detectLanguage(input),
                  timestamp: new Date()
                }]);
                currentInputTransRef.current = '';
              }
              if (output) {
                setTranscriptions(prev => [...prev, {
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
            setErrorMsg('Connection failed. Reconnecting...');
            disconnect();
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
      setErrorMsg(err.message || 'Failed to connect.');
      disconnect();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <header className="px-6 py-4 border-b border-slate-800 bg-slate-900/50 backdrop-blur-md flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-900/20">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5c1.382 3.307 3.416 6.333 6.049 8.873m-3.355-1.92a18.07 18.07 0 01-1.34-4.203" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Oromo ↔ Amharic</h1>
            <p className="text-xs text-slate-400 font-medium uppercase tracking-widest">Auto-Detecting Translation</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`} />
          <span className="text-xs font-medium text-slate-400">
            {status === ConnectionStatus.CONNECTED ? 'Live Translation Active' : status === ConnectionStatus.CONNECTING ? 'Connecting...' : 'Ready to translate'}
          </span>
        </div>
      </header>

      {errorMsg && (
        <div className="bg-red-900/40 border-b border-red-800 px-6 py-2 text-red-200 text-sm flex items-center justify-between">
          <p>{errorMsg}</p>
          <button onClick={() => setErrorMsg(null)} className="p-1">&times;</button>
        </div>
      )}

      <main className="flex-1 flex flex-col relative">
        <TranscriptionList entries={transcriptions} />
        
        <div className="absolute bottom-24 left-0 right-0 flex justify-center pointer-events-none">
          <div className="bg-slate-900/80 backdrop-blur border border-slate-700 rounded-2xl px-8 py-4 flex flex-col items-center gap-2 shadow-2xl">
             <div className="flex items-center gap-8">
                <div className="flex flex-col items-center">
                   <span className="text-[10px] text-slate-500 font-bold uppercase mb-1">Incoming Voice</span>
                   <Visualizer isActive={status === ConnectionStatus.CONNECTED && !isMuted} color="#4f46e5" />
                </div>
                <div className="w-px h-8 bg-slate-700" />
                <div className="flex flex-col items-center">
                   <span className="text-[10px] text-slate-500 font-bold uppercase mb-1">Translation Output</span>
                   <Visualizer isActive={status === ConnectionStatus.CONNECTED && sourcesRef.current.size > 0} color="#10b981" />
                </div>
             </div>
             <p className="text-[10px] text-indigo-400 font-medium animate-pulse mt-2">
               {status === ConnectionStatus.CONNECTED ? "Speak either language" : ""}
             </p>
          </div>
        </div>
      </main>

      <footer className="p-6 bg-slate-900 border-t border-slate-800">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <button
            onClick={() => setIsMuted(!isMuted)}
            disabled={status !== ConnectionStatus.CONNECTED}
            className={`p-4 rounded-full transition-all ${
              isMuted ? 'bg-red-500/20 text-red-500 ring-2 ring-red-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            } disabled:opacity-30`}
          >
            {isMuted ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnect : connect}
            className={`flex-1 py-4 px-8 rounded-2xl font-bold text-lg transition-all shadow-lg ${
              status === ConnectionStatus.CONNECTED
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-red-900/20'
                : status === ConnectionStatus.CONNECTING
                ? 'bg-slate-800 text-slate-400 cursor-wait'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-900/20'
            }`}
          >
            {status === ConnectionStatus.CONNECTED ? 'Stop Session' : status === ConnectionStatus.CONNECTING ? 'Starting...' : 'Start Automatic Translation'}
          </button>

          <button
            onClick={() => setTranscriptions([])}
            className="p-4 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all"
            title="Clear history"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
};

export default App;
