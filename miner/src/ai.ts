import OpenAI from "openai";

/**
 * AI Engine - Generates diverse candidate texts using LLM.
 * Each unique text opens a new hash search space for mining.
 */
export class AIEngine {
  private client: OpenAI;
  private model: string;
  private totalCalls: number = 0;
  private totalTokens: number = 0;
  public lastText: string = "";

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({
      apiKey,
      timeout: 30000,      // 30 second timeout
      maxRetries: 1,        // 1 retry on failure
    });
    this.model = model;
  }

  /**
   * Generate multiple diverse candidate texts for mining.
   * Each text will be used as a unique base for nonce searching.
   *
   * @param seed - Challenge seed (hex string) for theme derivation
   * @param count - Number of candidate texts to generate
   * @returns Array of candidate text strings (each 100-1000 bytes)
   */
  async generateCandidates(seed: string, count: number): Promise<string[]> {
    // Derive a "theme" from the seed to make each challenge's texts unique
    const seedNum = parseInt(seed.slice(2, 10), 16);
    const themes = [
      "quantum computing", "deep space exploration", "neural networks",
      "ancient civilizations", "genetic engineering", "dark matter",
      "artificial consciousness", "blockchain technology", "climate science",
      "mathematical theorems", "marine biology", "astrophysics",
      "cryptographic protocols", "evolutionary biology", "nanotechnology",
      "philosophical paradoxes", "renewable energy", "robotics engineering",
      "string theory", "synthetic biology", "virtual reality",
      "cybersecurity threats", "molecular gastronomy", "particle physics",
    ];
    const theme = themes[seedNum % themes.length];

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a creative text generator for a mining puzzle. " +
              "Generate unique, diverse paragraphs. Each paragraph must be " +
              "between 150 and 800 characters. Output ONLY the paragraphs, " +
              "one per line, separated by |||. No numbering or extra formatting.",
          },
          {
            role: "user",
            content:
              `Generate ${count} unique paragraphs about "${theme}". ` +
              `Each paragraph should be creative and diverse. Seed: ${seed.slice(0, 18)}. ` +
              `Separate paragraphs with ||| delimiter.`,
          },
        ],
        temperature: 1.2,
        max_tokens: count * 300,
      });

      this.totalCalls++;
      this.totalTokens += response.usage?.total_tokens || 0;

      const content = response.choices[0]?.message?.content || "";
      const candidates = content
        .split("|||")
        .map((t) => t.trim())
        .filter((t) => {
          const byteLen = Buffer.byteLength(t, "utf8");
          return byteLen >= 100 && byteLen <= 1000;
        });

      if (candidates.length > 0) {
        this.lastText = candidates[0].slice(0, 60) + "...";
      }

      // If we didn't get enough valid candidates, pad with seed-based texts
      while (candidates.length < count) {
        const padText = this._generateFallbackText(seed, candidates.length);
        candidates.push(padText);
      }

      return candidates.slice(0, count);
    } catch (error: any) {
      // Fallback: generate texts locally if API fails
      console.error(`AI API error: ${error.message}. Using fallback texts.`);
      return Array.from({ length: count }, (_, i) =>
        this._generateFallbackText(seed, i)
      );
    }
  }

  /**
   * Generate a deterministic fallback text when API is unavailable.
   * Less diverse than AI-generated text, but still functional.
   */
  private _generateFallbackText(seed: string, index: number): string {
    const base =
      `Mining candidate ${index} for seed ${seed.slice(0, 18)}. ` +
      `Timestamp: ${Date.now()}. ` +
      `Random entropy: ${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}. ` +
      `The quick brown fox jumps over the lazy dog. ` +
      `Proof of AI Work requires both intelligence and computation. ` +
      `Exploring the boundaries of decentralized mining with artificial intelligence.`;
    this.lastText = base.slice(0, 60) + "...";
    return base;
  }

  /** Total API calls made */
  get calls(): number {
    return this.totalCalls;
  }

  /** Total tokens consumed */
  get tokens(): number {
    return this.totalTokens;
  }
}
