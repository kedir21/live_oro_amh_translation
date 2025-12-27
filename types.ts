
export type Language = 'Afaan Oromoo' | 'Amharic';

export interface TranscriptionEntry {
  id: string;
  sender: 'user' | 'model';
  text: string;
  language: Language;
  timestamp: Date;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
