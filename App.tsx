
import React, { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Language, TranscriptionEntry, ConnectionStatus } from './types';
import { decodeBase64, decodeAudioData, createPcmBlob } from './utils/audio';
import { Visualizer } from './components/Visualizer';
import { TranscriptionList } from './components/TranscriptionList';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

const detectLanguage = (text: string): Language => {
  const ethioMatches = (text.match(/[\u1200-\u137F]/g) || []).length;
  const latinMatches = (text.match(/[a-zA-Z]/g) || []).length;
  return ethioMatches > latinMatches ? 'Amharic' : 'Afaan Oromoo';
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

      // Initialize strictly with process.env.API_KEY
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
      });
      micStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: 'You are a professional bidirectional translator. Detect if the user is speaking Afaan Oromoo or Amharic automatically. If Oromoo, translate to Amharic. If Amharic, translate to Oromoo. Respond with translation ONLY.',
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted || !sessionRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: createPcmBlob(inputData) });
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
                setTranscriptions(p => [...p.slice(-49), { id: Date.now().toString(), sender: 'user', text: input, language: detectLanguage(input), timestamp: new Date() }]);
                currentInputTransRef.current = '';
              }
              if (output) {
                setTranscriptions(p => [...p.slice(-49), { id: Date.now().toString() + 'm', sender: 'model', text: output, language: detectLanguage(output), timestamp: new Date() }]);
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

            if (message.serverContent?.interrupted) stopAllAudio();
          },
          onerror: (e) => {
            console.error('Session Error:', e);
            setStatus(ConnectionStatus.ERROR);
            setErrorMsg('Connection error. Please try again.');
          },
          onclose: () => disconnect()
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMsg(err.message || 'Access denied or service unavailable.');
      disconnect();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-inter">
      <header className="px-6 py-4 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🎙️</span>
          <div>
            <h1 className="text-lg font-bold leading-none">Oromo ↔ Amharic</h1>
            <p className="text-[9px] text-indigo-400 font-bold uppercase tracking-widest mt-1">Live AI Link</p>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-slate-800/50 px-3 py-1.5 rounded-full border border-slate-700">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 live-pulse' : 'bg-slate-600'}`} />
          <span className="text-[10px] font-black uppercase">{status}</span>
        </div>
      </header>

      {errorMsg && (
        <div className="bg-red-900/20 border-b border-red-800/50 px-6 py-2 text-red-300 text-xs flex items-center justify-between">
          <p>{errorMsg}</p>
          <button onClick={() => setErrorMsg(null)} className="text-lg">&times;</button>
        </div>
      )}

      <main className="flex-1 flex flex-col relative overflow-hidden">
        <TranscriptionList entries={transcriptions} />
        <div className="absolute bottom-28 left-0 right-0 flex justify-center pointer-events-none px-4">
          <div className="bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 rounded-2xl px-10 py-5 flex items-center gap-12 shadow-2xl">
            <div className="flex flex-col items-center">
              <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest mb-2">Speaker</span>
              <Visualizer isActive={status === ConnectionStatus.CONNECTED && !isMuted} color="#6366f1" />
            </div>
            <div className="w-px h-8 bg-slate-800" />
            <div className="flex flex-col items-center">
              <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest mb-2">Translator</span>
              <Visualizer isActive={status === ConnectionStatus.CONNECTED && sourcesRef.current.size > 0} color="#10b981" />
            </div>
          </div>
        </div>
      </main>

      <footer className="p-8 bg-slate-900/80 backdrop-blur-md border-t border-slate-800">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-6">
          <button
            onClick={() => setIsMuted(!isMuted)}
            disabled={status !== ConnectionStatus.CONNECTED}
            className={`p-5 rounded-2xl transition-all ${isMuted ? 'bg-red-500 text-white shadow-lg shadow-red-900/30' : 'bg-slate-800 text-slate-400'} disabled:opacity-20`}
          >
            {isMuted ? '🔇' : '🎙️'}
          </button>
          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnect : connect}
            className={`flex-1 py-5 rounded-2xl font-bold text-xl transition-all shadow-xl active:scale-[0.98] ${
              status === ConnectionStatus.CONNECTED ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            } disabled:opacity-50`}
            disabled={status === ConnectionStatus.CONNECTING}
          >
            {status === ConnectionStatus.CONNECTED ? 'STOP SESSION' : status === ConnectionStatus.CONNECTING ? 'INITIALIZING...' : 'START LIVE'}
          </button>
          <button onClick={() => setTranscriptions([])} className="p-5 rounded-2xl bg-slate-800 text-slate-400 hover:text-white transition-colors">
            🗑️
          </button>
        </div>
      </footer>
    </div>
  );
};

export default App;
