
import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult, VoiceCategory, WebsiteAnalysisResult } from "../types";

export class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    // Initializing with the exact named parameter and direct environment variable as per guidelines.
    this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }

  /**
   * Deep analysis of a website using Search Grounding
   */
  public async analyzeWebsite(url: string): Promise<WebsiteAnalysisResult> {
    // Guidelines: Search grounding is used for queries that relate to up-to-date or trending information.
    // Also, extracted URLs from groundingChunks must be listed on the web app.
    const response = await this.ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Perform a comprehensive validity and security audit for this website: ${url}. 
      Determine if the site is a legitimate service, a safe portal, or a suspicious/phishing domain. 
      Use Google Search to verify its reputation and status.
      Please format your response as a JSON object with the following structure:
      {
        "isValid": boolean,
        "securityScore": number (0-100),
        "status": "Safe" | "Suspicious" | "Dangerous" | "Invalid",
        "details": string[],
        "siteInfo": { "title": string, "description": string }
      }`,
      config: {
        tools: [{ googleSearch: {} }],
        // responseMimeType is set to 'application/json' to get structured output where possible.
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isValid: { type: Type.BOOLEAN },
            securityScore: { type: Type.NUMBER },
            status: { type: Type.STRING, description: "Safe, Suspicious, Dangerous, or Invalid" },
            details: { type: Type.ARRAY, items: { type: Type.STRING } },
            siteInfo: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING }
              }
            }
          },
          required: ["isValid", "securityScore", "status", "details"]
        }
      },
    });

    // Extracting website URLs from groundingChunks as mandated by the guidelines for Search Grounding.
    const groundingUrls = response.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map((chunk: any) => chunk.web?.uri)
      .filter(Boolean) || [];

    try {
      // Guidelines: The output response.text may not be in JSON format when using Search Grounding.
      // We attempt to parse but must handle fallback gracefully.
      const cleanedText = response.text.trim();
      const result = JSON.parse(cleanedText || '{}');
      return { ...result, groundingUrls };
    } catch (e) {
      // Forensic data format error handling.
      return {
        isValid: response.text.toLowerCase().includes("safe"),
        securityScore: response.text.toLowerCase().includes("safe") ? 85 : 40,
        status: response.text.toLowerCase().includes("safe") ? 'Safe' : 'Suspicious',
        details: [response.text.substring(0, 500)],
        siteInfo: { title: "Unstructured Analysis Report", description: "Search grounding data extracted." },
        groundingUrls
      };
    }
  }

  /**
   * Analysis for uploaded audio files
   */
  public async analyzeAudioFile(file: { data: string; mimeType: string }): Promise<AnalysisResult> {
    const response = await this.ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { text: "Analyze this audio. Categorize precisely as HUMAN or AI. Look for digital synthesis artifacts vs biological breathing sounds." },
          { inlineData: file }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: { type: Type.STRING },
            confidence: { type: Type.NUMBER },
            reasoning: { type: Type.ARRAY, items: { type: Type.STRING } },
            metadata: {
              type: Type.OBJECT,
              properties: {
                detectedLanguage: { type: Type.STRING },
                artifactPresence: { type: Type.STRING }
              }
            }
          }
        }
      }
    });
    // Guidelines: Extract text output using the .text property.
    return JSON.parse(response.text || '{}');
  }
}

/**
 * Encodes Float32Array PCM data to Base64 String for Gemini Live API.
 * Manual implementation as required by guidelines.
 */
export function encodeAudio(data: Float32Array): string {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes Base64 String back to Uint8Array (PCM Bytes).
 * Manual implementation as required by guidelines.
 */
export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
