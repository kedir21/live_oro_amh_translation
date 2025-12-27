
import React, { useEffect, useRef } from 'react';
import { TranscriptionEntry } from '../types';

interface TranscriptionListProps {
  entries: TranscriptionEntry[];
}

export const TranscriptionList: React.FC<TranscriptionListProps> = ({ entries }) => {
  const listEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 scrollbar-hide">
      {entries.length === 0 && (
        <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center px-8">
          <div className="w-20 h-20 bg-slate-800/50 rounded-full flex items-center justify-center mb-6 ring-4 ring-slate-900">
            <svg className="w-10 h-10 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <p className="text-xl font-semibold text-slate-300">Automatic Translator</p>
          <p className="text-sm max-w-xs mt-2 text-slate-400">
            Speak in either <strong>Afaan Oromoo</strong> or <strong>Amharic</strong>. The AI will detect your language and translate it instantly.
          </p>
        </div>
      )}
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`flex flex-col ${entry.sender === 'user' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2 duration-300`}
        >
          <div
            className={`max-w-[85%] rounded-2xl p-5 shadow-xl ${
              entry.sender === 'user'
                ? 'bg-indigo-600 text-white rounded-tr-none'
                : 'bg-slate-800 text-slate-100 rounded-tl-none border border-slate-700'
            }`}
          >
            <div className={`text-[10px] uppercase tracking-widest mb-2 font-black ${
              entry.sender === 'user' ? 'text-indigo-200' : 'text-indigo-400'
            }`}>
              {entry.language}
            </div>
            <p className="text-lg leading-relaxed font-medium">
              {entry.text}
            </p>
          </div>
          <span className="text-[10px] mt-2 text-slate-500 px-1 font-bold">
            {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
      ))}
      <div ref={listEndRef} className="h-20" />
    </div>
  );
};
