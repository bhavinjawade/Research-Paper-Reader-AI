
export enum BlockType {
  TEXT = 'text',
  DESCRIPTION = 'description'
}

export type VoiceType = 'male' | 'female';
export type PlaybackSpeed = 0.75 | 1.0 | 1.25 | 1.5 | 2.0;

export interface SpeechBlock {
  id: string;
  type: BlockType;
  content: string;
  audioBuffer: AudioBuffer | null;
  sectionId: string;
}

export interface PaperSection {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  blocks: SpeechBlock[];
  status: 'pending' | 'processing' | 'ready' | 'playing' | 'completed';
}

export interface ProcessedChunk {
  pageIndex: number;
  blocks: SpeechBlock[];
}

export enum ProcessingState {
  IDLE = 'IDLE',
  UPLOADING = 'UPLOADING',
  PARSING_PDF = 'PARSING_PDF',
  EXTRACTING_SECTIONS = 'EXTRACTING_SECTIONS',
  PROCESSING_SECTION = 'PROCESSING_SECTION',
  GENERATING_VOICE = 'GENERATING_VOICE',
  PLAYING = 'PLAYING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export interface AppState {
  file: File | null;
  status: ProcessingState;
  progress: number;
  totalPages: number;
  currentPage: number;
  error: string | null;
  sections: PaperSection[];
  currentSectionIndex: number;
  currentlyPlayingBlockId: string | null;
  selectedVoice: VoiceType;
  playbackSpeed: PlaybackSpeed;
}
