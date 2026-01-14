
import { BlockType, SpeechBlock, PaperSection } from "../types";

// Helper function to chunk text for TTS (Deepgram has 2000 char limit)
const chunkText = (text: string, maxLength: number = 1900): string[] => {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf('. ', maxLength);
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakPoint === -1) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.substring(0, breakPoint + 1).trim());
    remaining = remaining.substring(breakPoint + 1).trim();
  }

  return chunks;
};

// Clean redundant information from text before TTS
const cleanTextForTTS = (text: string): string => {
  if (!text) return '';
  return text
    // Remove email addresses
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, '')
    // Remove URLs
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/www\.[^\s]+/g, '')
    // Remove DOIs
    .replace(/doi:\s*[\d./\w-]+/gi, '')
    .replace(/\b10\.\d{4,}\/[^\s]+/g, '')
    // Remove arXiv references
    .replace(/arXiv:\s*[\d.]+/gi, '')
    // Remove inline citations like [1], [2,3], [1-5], (Smith et al., 2023)
    .replace(/\[\d+(?:[-,]\s*\d+)*\]/g, '')
    .replace(/\([A-Z][a-z]+(?:\s+et\s+al\.?)?,?\s*\d{4}\)/g, '')
    .replace(/\([A-Z][a-z]+\s+and\s+[A-Z][a-z]+,?\s*\d{4}\)/g, '')
    // Remove sequences of 3-digit line numbers
    .replace(/^(\d{3}\s+)+/gm, '')
    .replace(/\b\d{3}\s+(?=\d{3}\b)/g, '')
    // Remove standalone line numbers at line start
    .replace(/^\s*\d{1,3}\s+(?=[A-Z])/gm, '')
    // Remove page numbers
    .replace(/\bPage\s+\d+\b/gi, '')
    // Remove copyright notices
    .replace(/©\s*\d{4}[^.]*\./gi, '')
    .replace(/copyright\s*\d{4}[^.]*\./gi, '')
    // Remove orphaned et al. from citations
    .replace(/\bet\s+al\.\s*,?\s*\d{4}/g, '')
    // Remove footnote markers
    .replace(/[*†‡§¶]\d*/g, '')
    // Remove ORCID identifiers
    .replace(/ORCID:\s*[\d-]+/gi, '')
    // Remove submission/acceptance dates
    .replace(/(?:Received|Accepted|Published|Submitted):\s*[^.]+\./gi, '')
    // Remove corresponding author notes
    .replace(/\*?\s*Corresponding author[.:]?/gi, '')
    // Clean up multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
};

interface RawSection {
  title: string;
  pageStart: number;
  pageEnd: number;
}

/**
 * Extract paper sections from the full text of all pages
 */
export const extractSections = async (
  openRouterApiKey: string,
  allPagesText: string[]
): Promise<RawSection[]> => {
  // Sample pages strategically for section detection
  let samplePages: { pageNum: number; text: string }[] = [];

  if (allPagesText.length <= 10) {
    samplePages = allPagesText.map((text, i) => ({ pageNum: i + 1, text }));
  } else {
    const indices = new Set<number>();
    for (let i = 0; i < 3; i++) indices.add(i);
    for (let i = 3; i < allPagesText.length - 2; i += 3) indices.add(i);
    if (allPagesText.length > 3) indices.add(allPagesText.length - 3);
    if (allPagesText.length > 2) indices.add(allPagesText.length - 2);

    samplePages = Array.from(indices)
      .sort((a, b) => a - b)
      .map(i => ({ pageNum: i + 1, text: allPagesText[i] }));
  }

  const sampleText = samplePages
    .map(p => `--- PAGE ${p.pageNum} ---\n${p.text}`)
    .join('\n\n');

  const prompt = `Analyze this research paper and identify its major sections.

Look for section headings like: Abstract, Introduction, Related Work, Methods, Experiments, Results, Discussion, Conclusion (Skip References).

The paper has ${allPagesText.length} total pages.

OUTPUT FORMAT: Return ONLY a valid JSON array:
[{"title": "Abstract", "pageStart": 1, "pageEnd": 1}, {"title": "Introduction", "pageStart": 1, "pageEnd": 2}]

RULES:
1. Use clean section names without numbering
2. Page numbers are 1-indexed
3. Cover ALL ${allPagesText.length} pages - don't leave gaps
4. Skip References section

PAPER SAMPLES:
${sampleText}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Paper Reader AI'
      },
      body: JSON.stringify({
        model: 'xiaomi/mimo-v2-flash:free',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else {
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        jsonStr = arrayMatch[0];
      }
    }

    const sections: RawSection[] = JSON.parse(jsonStr);

    return sections
      .filter(s => !s.title.toLowerCase().includes('reference'))
      .map(s => ({
        title: s.title,
        pageStart: Math.max(1, s.pageStart),
        pageEnd: Math.min(allPagesText.length, s.pageEnd)
      }));
  } catch (e) {
    console.error("Failed to extract sections:", e);
    return [{
      title: "Full Paper",
      pageStart: 1,
      pageEnd: allPagesText.length
    }];
  }
};

/**
 * Process a section's text and return speech blocks
 */
export const processSectionText = async (
  openRouterApiKey: string,
  sectionTitle: string,
  sectionId: string,
  pagesText: string[]
): Promise<Partial<SpeechBlock>[]> => {
  const combinedText = pagesText.join('\n\n');

  const prompt = `You are an expert academic voice assistant. Process this section titled "${sectionTitle}" from a research paper for reading aloud.

KEEP:
- Main scholarly content and section headings
- Paper title
- Author LAST NAMES and their companies/organizations (e.g., "Smith and Johnson from Google Research and OpenAI")
- Do NOT include full addresses, emails, or department details - just last names and company/organization names

REMOVE COMPLETELY:
- Line numbers (000, 001, 055, etc.)
- Email addresses, URLs, DOIs
- Citations: [1], [2,3], (Smith et al., 2023)
- Full postal addresses and department details
- Copyright notices, dates
- Footnote markers, ORCID IDs
- Grant acknowledgments
- Conference/journal headers

CRITICAL - HANDLING EQUATIONS AND MATH:
When you encounter mathematical equations or formulas, you MUST convert them to natural spoken language. Do NOT include LaTeX, symbols like $$, or raw math notation.

Examples of how to convert equations:
- "$$\\text{Attention}(Q, K, V) = \\text{softmax}(QK^T/\\sqrt{d_k})V$$" → "The Attention function takes Query, Key, and Value as inputs. It computes the softmax of the product of Query and Key-transpose, divided by the square root of the key dimension d-k, then multiplies the result by the Value matrix."
- "$$L = -\\sum_i y_i \\log(p_i)$$" → "The loss L equals the negative sum over all i of y-i times the log of p-i, which is the cross-entropy loss."
- "$$\\nabla_\\theta J(\\theta)$$" → "The gradient of the objective function J with respect to theta."
- "$$O(n^2)$$" → "O of n squared time complexity."
- "$$x \\in \\mathbb{R}^d$$" → "x is a d-dimensional real vector."

For figures and tables, describe what they show conceptually.

OUTPUT FORMAT: Return ONLY a valid JSON array:
[{"type": "text", "content": "Cleaned paragraph..."}, {"type": "description", "content": "The equation shows..."}]

SECTION TEXT:
${combinedText}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Paper Reader AI'
      },
      body: JSON.stringify({
        model: 'xiaomi/mimo-v2-flash:free',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('INVALID_KEY');
      }
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else {
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        jsonStr = arrayMatch[0];
      }
    }

    const rawBlocks = JSON.parse(jsonStr);
    return rawBlocks.map((b: any, i: number) => ({
      id: `${sectionId}-block-${i}`,
      type: b.type as BlockType,
      content: cleanTextForTTS(b.content),
      sectionId
    }));
  } catch (e: any) {
    console.error("Failed to process section:", e);
    if (e.message === 'INVALID_KEY') throw e;

    return [{
      id: `${sectionId}-fallback`,
      type: BlockType.TEXT,
      content: cleanTextForTTS(pagesText.join(' ')),
      sectionId
    }];
  }
};

// Map voice names to Deepgram Aura-2 voices
const DEEPGRAM_VOICES: Record<string, string> = {
  'Kore': 'aura-2-thalia-en',
  'Puck': 'aura-2-orpheus-en',
};

/**
 * Generate audio for a text block
 */
export const generateAudio = async (
  deepgramApiKey: string,
  text: string,
  audioCtx: AudioContext,
  voiceName: string = 'Kore'
): Promise<AudioBuffer | null> => {
  try {
    const deepgramModel = DEEPGRAM_VOICES[voiceName] || 'aura-2-thalia-en';
    const textChunks = chunkText(text, 1900);

    if (textChunks.length === 1) {
      return await fetchAndDecodeAudio(deepgramApiKey, deepgramModel, textChunks[0], audioCtx);
    }

    const audioBuffers: AudioBuffer[] = [];
    for (const chunk of textChunks) {
      const buffer = await fetchAndDecodeAudio(deepgramApiKey, deepgramModel, chunk, audioCtx);
      if (buffer) {
        audioBuffers.push(buffer);
      }
    }

    if (audioBuffers.length === 0) {
      return null;
    }

    return concatenateAudioBuffers(audioBuffers, audioCtx);
  } catch (err: any) {
    console.error('TTS generation failed:', err);
    if (err.message === 'INVALID_KEY') {
      throw err;
    }
    return null;
  }
};

/**
 * Generate audio for multiple blocks in parallel (for prefetching)
 */
export const generateAudioBatch = async (
  deepgramApiKey: string,
  blocks: Partial<SpeechBlock>[],
  audioCtx: AudioContext,
  voiceName: string = 'Kore'
): Promise<Map<string, AudioBuffer | null>> => {
  const results = new Map<string, AudioBuffer | null>();

  const CONCURRENCY = 3;
  for (let i = 0; i < blocks.length; i += CONCURRENCY) {
    const batch = blocks.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (block) => {
      if (!block.content || !block.id) return;
      const buffer = await generateAudio(deepgramApiKey, block.content, audioCtx, voiceName);
      results.set(block.id, buffer);
    });
    await Promise.all(promises);
  }

  return results;
};

async function fetchAndDecodeAudio(
  apiKey: string,
  model: string,
  text: string,
  audioCtx: AudioContext
): Promise<AudioBuffer | null> {
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiKey}`,
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Deepgram TTS error:', response.status, errorText);
    if (response.status === 401 || response.status === 403) {
      throw new Error('INVALID_KEY');
    }
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

function concatenateAudioBuffers(buffers: AudioBuffer[], audioCtx: AudioContext): AudioBuffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const numberOfChannels = buffers[0].numberOfChannels;
  const sampleRate = buffers[0].sampleRate;

  const result = audioCtx.createBuffer(numberOfChannels, totalLength, sampleRate);

  let offset = 0;
  for (const buffer of buffers) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      result.getChannelData(channel).set(buffer.getChannelData(channel), offset);
    }
    offset += buffer.length;
  }

  return result;
}
