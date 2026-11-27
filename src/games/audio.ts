export class ProceduralAudio {
  private context?: AudioContext;
  private muted = false;

  async unlock(): Promise<void> {
    try {
      if (!this.context) this.context = new AudioContext();
      if (this.context.state === 'suspended') await this.context.resume();
    } catch {
      this.context = undefined;
    }
  }

  setMuted(muted: boolean): void { this.muted = muted; }

  hit(power = 0.5): void {
    if (!this.context || this.muted) return;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    const amount = Math.max(0, Math.min(1, power));
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180 + amount * 130, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18 + amount * 0.2, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain).connect(this.context.destination);
    osc.start(now); osc.stop(now + 0.17);
  }

  /** Racket on ball: a bright click of strings over the body of the hit. */
  racket(power = 0.5): void {
    this.hit(power);
    this.noise(0.05, 0.25 + 0.2 * power, 2600);
  }

  /** A short burst of applause. */
  cheer(intensity = 1): void {
    for (let clap = 0; clap < 40 * intensity; clap += 1) this.noise(0.04, 0.03 + Math.random() * 0.05, 1500 + Math.random() * 1500, Math.random() * 1.4);
  }

  /** The umpire's call, in the browser's own voice; silent where there is none. */
  say(text: string): void {
    if (this.muted || typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const call = new SpeechSynthesisUtterance(text);
    call.lang = 'pt-BR';
    call.rate = 1.1;
    speechSynthesis.speak(call);
  }

  private noise(duration: number, volume: number, frequency: number, delay = 0): void {
    if (!this.context || this.muted) return;
    const startAt = this.context.currentTime + delay;
    const buffer = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * duration), this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(this.context.destination);
    source.start(startAt);
  }

  jump(): void { this.hit(0.25); }

  step(side: 'left' | 'right'): void {
    if (!this.context || this.muted) return;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(side === 'left' ? 92 : 82, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.07);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(gain).connect(this.context.destination);
    osc.start(now); osc.stop(now + 0.1);
  }

  bounce(intensity = 0.5): void {
    const amount = Math.max(0, Math.min(1, intensity));
    this.tone(88 + amount * 32, 0.07, 0.06 + amount * 0.05, 'sine');
  }

  success(intensity = 1): void {
    const amount = Math.max(0, Math.min(1, intensity));
    this.tone(440, 0.14, 0.08 + amount * 0.06, 'triangle');
    this.tone(660 + amount * 120, 0.18, 0.07 + amount * 0.06, 'triangle', 0.09);
  }

  failure(): void {
    this.tone(190, 0.16, 0.11, 'triangle');
    this.tone(130, 0.22, 0.09, 'triangle', 0.12);
  }

  milestone(): void {
    this.tone(523, 0.2, 0.12, 'triangle');
    this.tone(659, 0.2, 0.12, 'triangle', 0.12);
    this.tone(784, 0.28, 0.14, 'triangle', 0.24);
  }

  private tone(frequency: number, duration: number, volume: number, type: OscillatorType, delay = 0): void {
    if (!this.context || this.muted) return;
    const startAt = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.01);
  }

  dispose(): void { void this.context?.close(); this.context = undefined; }
}
