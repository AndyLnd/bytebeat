import './style.css';

// ── Bytebeat Audio Engine ──

interface AudioEngine {
  start(): void;
  stop(): void;
  setExpression(expr: string): void;
  setSampleRate(rate: number): void;
  setVolume(v: number): void;
  getTime(): number;      // elapsed seconds
  getT(): number;          // current t value
}

/**
 * Generates 8-bit unsigned PCM samples by evaluating a bytebeat expression.
 *
 * The expression is a JavaScript expression using variable `t`.
 * `t` is a 32-bit signed integer that increments each sample.
 * The result is masked to 8 bits (0–255), then centered to float [-1, 1].
 *
 * Bitwise operators in JS already work on 32-bit signed ints, matching the
 * semantics of C bytebeat programs. `| 0` forces 32-bit signed truncation.
 */
class BytebeatEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private expr: string = 't';
  private sampleRate: number = 22050;
  private volume: number = 0.5;
  private t: number = 0;
  private startTime: number = 0;
  private running: boolean = false;
  /** Called after each chunk of samples is generated. Receives raw 8-bit values (0-255). */
  public onSamples: ((raw: Uint8Array) => void) | null = null;

  /**
   * Compile expression into a function. Returns null on syntax error.
   */
  private compile(expr: string): ((t: number) => number) | null {
    try {
      // Wrap in closure; use `|0` to enforce 32-bit signed semantics,
      // then `&0xFF` to get unsigned 8-bit sample value.
      const fn = new Function('t', `return (${expr}) | 0;`) as (t: number) => number;
      // Test with a sample value to catch runtime errors
      fn(0);
      fn(1);
      fn(-1);
      fn(0x7FFFFFFF);
      return fn;
    } catch {
      return null;
    }
  }

  setExpression(expr: string): void {
    this.expr = expr;
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  setVolume(v: number): void {
    this.volume = v;
  }

  getTime(): number {
    if (!this.running || !this.ctx) return 0;
    // elapsed = samples generated / actual playback rate
    return this.t / this.ctx.sampleRate;
  }

  getT(): number {
    return this.t;
  }

  start(): void {
    if (this.running) return;

    const fn = this.compile(this.expr);
    if (!fn) return;

    this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    this.t = 0;
    this.running = true;

    // Use buffer-based scheduling: generate chunks of samples,
    // write them to AudioBuffers, and schedule ahead of playback.
    this.startWithBuffers(fn);
  }

  /**
   * Buffer-based playback: generate chunks of samples, schedule them
   * as AudioBufferSourceNodes ahead of time.
   */
  private startWithBuffers(fn: (t: number) => number): void {
    const ctx = this.ctx!;
    const chunkSize = 4096; // samples per chunk
    const chunkDuration = chunkSize / ctx.sampleRate;
    const lookAhead = 0.2; // seconds to schedule ahead
    let nextScheduleTime = ctx.currentTime;

    const scheduleChunk = () => {
      if (!this.running || !this.ctx) return;

      const now = ctx.currentTime;

      // Schedule chunks until we're `lookAhead` seconds ahead
      while (nextScheduleTime < now + lookAhead) {
        const buffer = ctx.createBuffer(1, chunkSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        const rawSamples = new Uint8Array(chunkSize);

        for (let i = 0; i < chunkSize; i++) {
          const raw = fn(this.t) & 0xFF;        // 8-bit unsigned (0–255)
          data[i] = (raw - 128) / 128 * this.volume; // center to [-1, 1]
          rawSamples[i] = raw;
          this.t = (this.t + 1) | 0;            // 32-bit signed increment
        }

        // Feed visualizer
        if (this.onSamples) this.onSamples(rawSamples);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(nextScheduleTime);
        source.onended = () => source.disconnect();

        nextScheduleTime += chunkDuration;
      }

      // Check again soon
      setTimeout(scheduleChunk, 50);
    };

    scheduleChunk();
  }

  stop(): void {
    this.running = false;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

// ── Visualization ──

/**
 * Renders bytebeat samples as a scrolling texture + waveform on a canvas.
 * The texture view reveals Sierpinski/fractal patterns inherent in the
 * bitwise formulas — this is the classic "bytebeat bitmap" visualization.
 */
class BytebeatVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sampleBuf: number[] = [];
  private animId: number = 0;
  private running: boolean = false;
  private sampleRate: number = 22050;
  private col: number = 0; // current column position (wraps)

  private readonly W = 640;
  private readonly TEX_H = 155;
  private readonly WAVE_H = 45;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    canvas.width = this.W;
    canvas.height = this.TEX_H + this.WAVE_H;
    this.clear();
  }

  setRate(rate: number): void {
    this.sampleRate = rate;
  }

  /** Called by the audio engine with raw 8-bit samples. */
  feed(raw: Uint8Array): void {
    const MAX = this.W * 20;
    if (this.sampleBuf.length > MAX) {
      this.sampleBuf.splice(0, this.sampleBuf.length - MAX / 2);
    }
    for (let i = 0; i < raw.length; i++) {
      this.sampleBuf.push(raw[i]);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.col = 0;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animId);
    this.sampleBuf = [];
    this.clear();
  }

  private clear(): void {
    this.ctx.fillStyle = '#080c12';
    this.ctx.fillRect(0, 0, this.W, this.TEX_H + this.WAVE_H);
  }

  private loop(): void {
    if (!this.running) return;
    this.animId = requestAnimationFrame(() => this.loop());
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const W = this.W;
    const TH = this.TEX_H;
    const WH = this.WAVE_H;

    const samplesPerFrame = Math.max(1, Math.round(this.sampleRate / 60));
    const count = Math.min(this.sampleBuf.length, samplesPerFrame);
    if (count < 1) return;

    // ── Texture: draw columns at current position, wrapping ──
    // First, draw background over the region we're about to overwrite
    // (erase old content that's W columns old)
    const eraseW = Math.min(count, W - this.col);
    ctx.fillStyle = '#080c12';
    ctx.fillRect(this.col, 0, eraseW, TH);
    if (count > eraseW) {
      ctx.fillRect(0, 0, count - eraseW, TH);
    }

    // Draw new phosphor columns
    const imgData = ctx.getImageData(this.col, 0, eraseW, TH);
    const px1 = imgData.data;
    for (let i = 0; i < eraseW; i++) {
      this.drawDash(px1, i, eraseW, TH, this.sampleBuf[i]);
    }
    ctx.putImageData(imgData, this.col, 0);

    if (count > eraseW) {
      const wrapW = count - eraseW;
      const imgData2 = ctx.getImageData(0, 0, wrapW, TH);
      const px2 = imgData2.data;
      for (let i = 0; i < wrapW; i++) {
        this.drawDash(px2, i, wrapW, TH, this.sampleBuf[eraseW + i]);
      }
      ctx.putImageData(imgData2, 0, 0);
    }

    // Advance column pointer (wrapping)
    this.col = (this.col + count) % W;

    // ── Waveform: draw in the erased region, split at wrap boundary ──
    ctx.fillStyle = '#080c12';
    ctx.fillRect(this.col, TH, eraseW, WH);
    if (count > eraseW) {
      ctx.fillRect(0, TH, count - eraseW, WH);
    }

    const midY = TH + WH / 2;
    const amp = WH / 2 - 3;
    ctx.strokeStyle = '#3fb950';
    ctx.lineWidth = 1;

    // Helper: draw a segment of the waveform
    const drawSegment = (startX: number, bufOffset: number, segLen: number) => {
      if (segLen < 2) return;
      ctx.beginPath();
      for (let i = 0; i < segLen; i++) {
        const sample = this.sampleBuf[bufOffset + i];
        const x = startX + i;
        const y = midY + ((sample - 128) / 128) * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    // Segment 1: from col to edge (or all if no wrap)
    drawSegment(this.col, 0, eraseW);
    // Segment 2: wrapped part from 0
    if (count > eraseW) {
      drawSegment(0, eraseW, count - eraseW);
    }

    // Divider
    ctx.strokeStyle = '#1a2230';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, TH);
    ctx.lineTo(W, TH);
    ctx.stroke();

    this.sampleBuf.splice(0, count);
  }

  /** Draw a phosphor dash for one sample into image data. */
  private drawDash(px: Uint8ClampedArray, i: number, stride: number, TH: number, sample: number): void {
    const y = Math.floor((255 - sample) / 255 * (TH - 1));
    const lum = Math.floor(30 + (sample / 255) * 220);

    const dashH = 8;
    const y0 = Math.max(0, y - 2);
    const y1 = Math.min(TH - 1, y + dashH - 3);

    for (let dy = y0; dy <= y1; dy++) {
      const dist = Math.abs(dy - y);
      const glow = dist <= 1 ? 1.0 : dist === 2 ? 0.75 : dist === 3 ? 0.45 : 0.2;
      const g = Math.floor(lum * glow);
      const r = Math.floor(g * 0.2);
      const b = Math.floor(g * 0.15);
      const idx = dy * stride * 4 + i * 4;
      px[idx] = r;
      px[idx + 1] = g;
      px[idx + 2] = b;
      px[idx + 3] = 255;
    }
  }
}

// ── Presets ──

interface Preset {
  name: string;
  author: string;
  expr: string;
  rate?: number;
}

const PRESETS: Preset[] = [
  {
    name: 'Original Symphony',
    author: 'viznut',
    expr: 't * (((t>>12)|(t>>8)) & (63 & (t>>4)))',
  },
  {
    name: 'Munching Squares',
    author: 'viznut',
    expr: 't & (t>>8)',
  },
  {
    name: 'Lost in Space',
    author: 'xpansive',
    expr: '(t&t>>13|t>>6) * t',
  },
  {
    name: 'Sierpinski Harmony',
    author: 'viznut',
    expr: '(t*5&t>>7)|(t*3&t>>10)',
  },
  {
    name: 'Ringtone',
    author: 'anonymous',
    expr: 't * ((t>>3|t>>9)&74&t>>15)',
  },
  {
    name: 'Arpeggio Rise',
    author: 'viznut',
    expr: 't * (t>>8)',
  },
  {
    name: 'C64 Bassline',
    author: 'viznut/Visy',
    expr: '(t>>6^t&0x25|t+(t^t>>11)) - t*((t%24?2:6)&t>>11)^t<<1&(t&0x256?t>>4:t>>10)',
  },
  {
    name: 'Glitch Percussion',
    author: 'dae',
    expr: 't & ~t>>4 ^ ~t>>7 - 0.1',
    rate: 8000,
  },
  {
    name: 'Funk',
    author: 'George',
    expr: '20 * t*t*(t>>11)/7',
  },
  {
    name: 'Mario Glitch',
    author: 'Niklas Roy',
    expr: '(t*((t>>9|t>>13)&15))&129',
  },
  {
    name: 'Dark Drone',
    author: 'PandaMindset',
    expr: '((t+(t>>4+t>>2)+50)+Math.sin(t))%((t/(t>>5+t>>5|t%(t<<14+t<<12))+125))+t',
    rate: 8000,
  },
  {
    name: 'Vocal Exercise',
    author: 'anonymous',
    expr: 't*((t+13217)/1211)&(t>>2|t>>4|t>>6)/512',
    rate: 8000,
  },
  {
    name: 'Bass & Snare',
    author: 'Ola',
    expr: '((1-(((t+10)>>((t>>9)&((t>>14))))&(t>>4&-2)))*2)*(((t>>10)^((t+((t>>6)&127))>>10))&1)*32+128',
  },
  {
    name: 'Sierpinski Beat',
    author: 'FreeFull',
    expr: '(~t/100|(t*3))^(t*3&(t>>5))&t',
  },
  {
    name: 'Crescendo',
    author: 'Benjohn',
    expr: '((t*2)&(t>>(t>>10)))+((t*1.2)&(t>>9)&31)',
    rate: 8000,
  },
  {
    name: 'Drone Chords',
    author: 'Frank Eriksson',
    expr: '(t%31337>>3)|(t|t>>7)',
  },
  {
    name: 'Pink Noise',
    author: 'Madgarden',
    expr: '(t*t*t)>>t',
    rate: 8000,
  },
  {
    name: 'Tribal',
    author: 'Aaron Krister Johnson',
    expr: '((t>>4)|(t%10))+3.3|(((t%101)|(t>>14))&((t>>7)|(t*t%17)))',
    rate: 8000,
  },
  {
    name: 'Micro Drum',
    author: 'FreeFull',
    expr: '(t*t/4>>((t/8)%4))&(t+t/3*t/4)',
  },

  // ── From "Some deep analysis of one-line music programs" (viznut, Oct 2011) ──

  {
    name: 'Forty-Two Melody',
    author: 'community',
    expr: 't*(42&t>>10)',
    rate: 8000,
  },
  {
    name: 'Forty-Two Modulo',
    author: 'viznut',
    expr: 't*((42&t>>10)%14)',
    rate: 8000,
  },
  {
    name: 'Western Scale (E3–D4)',
    author: 'viznut',
    expr: 't*(5+((t>>11)&5))',
    rate: 8000,
  },
  {
    name: 'Rrrola Melody',
    author: 'Rrrola',
    expr: 't*(0xCA98>>(t>>9&14)&15)|t>>8',
    rate: 8000,
  },
  {
    name: 'Miiro Sierpinski',
    author: 'miiro',
    expr: 't*5&(t>>7)|t*3&(t*4>>10)',
    rate: 8000,
  },
  {
    name: 'Stephth Triple Sierpinski',
    author: 'stephth',
    expr: 't*9&t>>4|t*5&t>>7|t*3&t/1024',
    rate: 8000,
  },
  {
    name: 'Wrap Drum',
    author: 'viznut',
    expr: '(t&t>>4)-5',
    rate: 8000,
  },
  {
    name: 'Sierpinski + Wrap Drum',
    author: 'viznut',
    expr: '(t*9&t>>4|t*5&t>>7|t*3&t/1024)-1',
    rate: 8000,
  },
  {
    name: 'Mu6k Song (3 instruments)',
    author: 'Mu6k',
    expr: '((3e3/((t&16383)||1)&1)*35)+((t*("6689".charCodeAt(t>>16&3)&15)/24&127)*((t&16383)||1)/4e4)+((t>>8^t>>10|t>>14|(t*("6689".charCodeAt(t>>16&3)&15)/24&127))&63)',
    rate: 32000,
  },
  {
    name: 'PWM Drone',
    author: 'viznut',
    expr: 't&t%255',
    rate: 8000,
  },
  {
    name: 'Droid Ternary',
    author: 'droid',
    expr: 't>>6&1?t>>5:-t>>4',
    rate: 8000,
  },
  {
    name: 'Bst Glitch',
    author: 'bst',
    expr: '(t/1e7*t*t+t)%127|t>>4|t>>5|t%127+(t>>16)|t',
    rate: 8000,
  },
];

// ── UI ──

class BytebeatUI {
  private engine: BytebeatEngine;
  private visualizer: BytebeatVisualizer;
  private playing: boolean = false;

  // DOM elements
  private exprInput!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private rateSelect!: HTMLSelectElement;
  private volumeSlider!: HTMLInputElement;
  private volumeVal!: HTMLSpanElement;
  private presetSelect!: HTMLSelectElement;
  private timeDisplay!: HTMLSpanElement;
  private tDisplay!: HTMLSpanElement;
  private errorDiv!: HTMLDivElement;
  private updateTimer: number = 0;
  // Pitch table
  private pitchToggle!: HTMLButtonElement;
  private pitchBody!: HTMLDivElement;
  private pitchGrid!: HTMLDivElement;
  private vizCanvas!: HTMLCanvasElement;

  constructor() {
    this.engine = new BytebeatEngine();
    this.cacheDom();
    this.visualizer = new BytebeatVisualizer(this.vizCanvas);
    // Wire engine → visualizer
    this.engine.onSamples = (raw) => this.visualizer.feed(raw);
    this.bindEvents();
    this.populatePresets();
    this.buildPitchTable();
    this.loadFromURL();
  }

  private cacheDom(): void {
    this.exprInput = document.getElementById('expr') as HTMLInputElement;
    this.playBtn = document.getElementById('play-btn') as HTMLButtonElement;
    this.rateSelect = document.getElementById('rate') as HTMLSelectElement;
    this.volumeSlider = document.getElementById('volume') as HTMLInputElement;
    this.volumeVal = document.getElementById('volume-val') as HTMLSpanElement;
    this.presetSelect = document.getElementById('preset') as HTMLSelectElement;
    this.timeDisplay = document.getElementById('time-display') as HTMLSpanElement;
    this.tDisplay = document.getElementById('t-display') as HTMLSpanElement;
    this.errorDiv = document.getElementById('expr-error') as HTMLDivElement;
    this.pitchToggle = document.getElementById('pitch-toggle') as HTMLButtonElement;
    this.pitchBody = document.getElementById('pitch-body') as HTMLDivElement;
    this.pitchGrid = document.getElementById('pitch-grid') as HTMLDivElement;
    this.vizCanvas = document.getElementById('viz') as HTMLCanvasElement;
  }

  private bindEvents(): void {
    this.playBtn.addEventListener('click', () => this.togglePlay());

    this.exprInput.addEventListener('input', () => {
      this.validateExpr();
      this.updateURL();
    });

    this.rateSelect.addEventListener('change', () => {
      this.engine.setSampleRate(parseInt(this.rateSelect.value, 10));
      this.visualizer.setRate(parseInt(this.rateSelect.value, 10));
      this.buildPitchTable(); // refresh Hz values in tooltips
      this.updateURL();
    });

    this.volumeSlider.addEventListener('input', () => {
      const v = parseInt(this.volumeSlider.value, 10);
      this.volumeVal.textContent = `${v}%`;
      this.engine.setVolume(v / 100);
    });

    this.presetSelect.addEventListener('change', () => {
      const idx = this.presetSelect.selectedIndex - 1; // -1 because "— choose —"
      if (idx >= 0 && idx < PRESETS.length) {
        const p = PRESETS[idx];
        this.exprInput.value = p.expr;

        // Update rate dropdown and engine
        if (p.rate !== undefined) {
          this.rateSelect.value = String(p.rate);
          // Only update engine directly if NOT playing;
          // if playing, the stop/start below handles it.
          if (!this.playing) {
            this.engine.setSampleRate(p.rate);
          }
        }

        this.validateExpr();
        this.updateURL();

        // Restart if currently playing (picks up new expr + rate from select)
        if (this.playing) {
          this.stop();
          this.start();
        }
      }
    });

    // Keyboard shortcut: Enter to toggle play
    this.exprInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.togglePlay();
      }
    });

    // Pitch table toggle
    this.pitchToggle.addEventListener('click', () => {
      const hidden = this.pitchBody.hidden;
      this.pitchBody.hidden = !hidden;
      this.pitchToggle.classList.toggle('open', hidden);
      const arrow = this.pitchToggle.querySelector('.toggle-arrow') as HTMLSpanElement;
      if (arrow) arrow.textContent = hidden ? '▼' : '▶';
    });
  }

  private populatePresets(): void {
    for (const p of PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name} (${p.author})`;
      this.presetSelect.appendChild(opt);
    }
  }

  /** Pitch table: maps multiplier n (1–31) to nearest 12-TET note and cents deviation. */
  private buildPitchTable(): void {
    // 12-TET note names, anchored so n=1 → C
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    const rows: string[] = [];
    for (let n = 1; n <= 31; n++) {
      // Semitones from base pitch (n=1)
      const semitones = 12 * (Math.log(n) / Math.LN2);
      const semitonesRounded = Math.round(semitones);
      const cents = Math.round((semitones - semitonesRounded) * 100);
      const noteIndex = ((semitonesRounded % 12) + 12) % 12;
      const octave = Math.floor(semitonesRounded / 12);
      const noteName = NOTE_NAMES[noteIndex];
      const deviation = Math.abs(cents);
      const isWestern = deviation < 25;

      // Format cents: ±NN
      const centsStr = cents === 0 ? '±0' : `${cents > 0 ? '+' : ''}${cents}`;

      // Frequency at current sample rate
      const rate = parseInt(this.rateSelect.value, 10);
      const freq = (n * rate / 256).toFixed(1);

      rows.push(
        `<div class="pitch-row ${isWestern ? 'western' : 'non-western'}">` +
          `<span class="mult">${n}</span>` +
          `<span class="note">${noteName}${octave >= 0 ? octave : ''}</span>` +
          `<span class="cents" title="${freq} Hz at ${rate / 1000} kHz">${centsStr}¢</span>` +
        `</div>`
      );
    }
    this.pitchGrid.innerHTML = rows.join('');
  }

  private validateExpr(): boolean {
    const expr = this.exprInput.value.trim();
    if (!expr) {
      this.errorDiv.textContent = '';
      this.exprInput.classList.remove('invalid');
      return false;
    }

    try {
      const fn = new Function('t', `return (${expr}) | 0;`);
      fn(0);
      fn(1000);
      fn(-1);
      fn(0x7FFFFFFF);
      this.errorDiv.textContent = '';
      this.exprInput.classList.remove('invalid');
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errorDiv.textContent = `⚠ ${msg}`;
      this.exprInput.classList.add('invalid');
      return false;
    }
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stop();
    } else {
      this.start();
    }
  }

  private start(): void {
    if (!this.validateExpr()) return;

    const expr = this.exprInput.value.trim();
    this.engine.setExpression(expr);
    this.engine.setSampleRate(parseInt(this.rateSelect.value, 10));
    this.engine.setVolume(parseInt(this.volumeSlider.value, 10) / 100);

    this.visualizer.setRate(parseInt(this.rateSelect.value, 10));
    this.engine.start();
    this.playing = true;
    this.playBtn.textContent = '⏹';
    this.playBtn.classList.add('playing');
    this.exprInput.readOnly = true;

    // Update time display
    this.startTimeUpdate();

    // Start visualization
    this.visualizer.start();

    this.updateURL();
  }

  private stop(): void {
    this.engine.stop();
    this.visualizer.stop();
    this.playing = false;
    this.playBtn.textContent = '▶';
    this.playBtn.classList.remove('playing');
    this.exprInput.readOnly = false;
    clearInterval(this.updateTimer);
  }

  private startTimeUpdate(): void {
    clearInterval(this.updateTimer);
    this.updateTimer = window.setInterval(() => {
      const tVal = this.engine.getT();
      // Convert to unsigned 32-bit for display (like original bytebeat)
      const tUnsigned = tVal >>> 0;
      this.tDisplay.textContent = `t = ${tUnsigned.toLocaleString()}`;

      // Elapsed time
      const secs = Math.floor(this.engine.getTime());
      const mins = Math.floor(secs / 60);
      const s = secs % 60;
      this.timeDisplay.textContent = `${mins < 10 ? '0' : ''}${mins}:${s < 10 ? '0' : ''}${s}`;
    }, 250);
  }

  // ── URL Sharing ──

  private updateURL(): void {
    const expr = this.exprInput.value.trim();
    const rate = this.rateSelect.value;
    const params = new URLSearchParams();
    if (expr) params.set('expr', expr);
    if (rate !== '22050') params.set('rate', rate);
    const url = `${location.pathname}?${params.toString()}`;
    history.replaceState(null, '', url);
  }

  private loadFromURL(): void {
    const params = new URLSearchParams(location.search);
    const expr = params.get('expr');
    const rate = params.get('rate');

    if (expr) {
      this.exprInput.value = expr;
      this.validateExpr();
    }

    if (rate) {
      this.rateSelect.value = rate;
      this.engine.setSampleRate(parseInt(rate, 10));
    }
  }
}

// ── Bootstrap ──

document.addEventListener('DOMContentLoaded', () => {
  new BytebeatUI();
});
