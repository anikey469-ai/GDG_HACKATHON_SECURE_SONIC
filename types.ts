
export enum VoiceCategory {
  HUMAN = 'HUMAN',
  AI = 'AI',
  UNCERTAIN = 'UNCERTAIN'
}

export interface AnalysisResult {
  category: VoiceCategory;
  confidence: number;
  reasoning: string[];
  metadata: {
    detectedLanguage?: string;
    artifactPresence?: string;
  };
}

export interface WebsiteAnalysisResult {
  isValid: boolean;
  securityScore: number; // 0-100
  status: 'Safe' | 'Suspicious' | 'Dangerous' | 'Invalid';
  details: string[];
  siteInfo: {
    title?: string;
    description?: string;
    lastUpdated?: string;
  };
  groundingUrls?: string[];
}

export interface FileData {
  base64: string;
  mimeType: string;
  name: string;
}
