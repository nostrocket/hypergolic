/** A generation accepts each correlation at most once, even after its recent slots cycle. */
export class RequestHistory {
  private readonly recent = new Float64Array(256);
  private readonly legacy = new Set<string>();
  private highest = 0;

  private readonly legacyLimit: number;

  constructor(legacyLimit: number) { this.legacyLimit = legacyLimit; }

  claim(id: string, scope = ''): 'used' | 'quota' | null {
    const match = /^hg-([1-9][0-9]{0,15})-(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(id);
    const sequence = match && Number(match[1]);
    if (sequence && Number.isSafeInteger(sequence)) {
      // Older sequence numbers are permanently closed, including holes in the window.
      const slot = sequence % this.recent.length;
      if (sequence <= this.highest - this.recent.length || this.recent[slot] === sequence) return 'used';
      this.recent[slot] = sequence;
      this.highest = Math.max(this.highest, sequence);
      return null;
    }

    // An opaque legacy ID has no ordering proof. Keep exact history for this generation.
    const key = JSON.stringify([scope, id]);
    if (this.legacy.has(key)) return 'used';
    if (this.legacy.size >= this.legacyLimit) return 'quota';
    this.legacy.add(key);
    return null;
  }
}
