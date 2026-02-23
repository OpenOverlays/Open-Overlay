import React, { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '../utils';

// ---------------------------------------------------------------------------
// Colour utilities
// ---------------------------------------------------------------------------
interface HSV { h: number; s: number; v: number; }
interface RGB { r: number; g: number; b: number; }

function hsvToRgb({ h, s, v }: HSV): RGB {
  const f = (n: number, k = (n + h / 60) % 6) =>
    v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255) };
}

function rgbToHsv({ r, g, b }: RGB): HSV {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Parse any color string → { hex, alpha } */
export function parseColor(value: string): { hex: string; alpha: number } {
  if (!value) return { hex: '#ffffff', alpha: 1 };
  if (value.startsWith('rgba')) {
    const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) {
      const hex = rgbToHex({ r: +m[1], g: +m[2], b: +m[3] });
      return { hex, alpha: m[4] !== undefined ? +m[4] : 1 };
    }
  }
  if (value.startsWith('#')) {
    if (value.length === 9) { // #rrggbbaa
      const hex = value.slice(0, 7);
      const alpha = parseInt(value.slice(7, 9), 16) / 255;
      return { hex, alpha: Math.round(alpha * 100) / 100 };
    }
    return { hex: value.length === 4 ? '#' + value.slice(1).split('').map(c=>c+c).join('') : value, alpha: 1 };
  }
  return { hex: '#ffffff', alpha: 1 };
}

/** Build rgba() or hex string from rgb+alpha */
export function buildColor(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// PRESETS
// ---------------------------------------------------------------------------
const PRESETS = [
  '#ffffff','#000000','#ff0000','#ff6600','#ffcc00',
  '#00cc44','#0088ff','#6644ff','#cc00ff','#ff0066',
  '#87ceeb','#ffa07a','#98fb98','#dda0dd','#f0e68c',
  'rgba(255,255,255,0.5)','rgba(0,0,0,0.5)','transparent',
];

// ---------------------------------------------------------------------------
// ColorPicker props
// ---------------------------------------------------------------------------
interface ColorPickerProps {
  value: string;         // hex / rgba / 'transparent'
  onChange: (v: string) => void;
  onClose?: () => void;
}

export default function ColorPicker({ value, onChange, onClose }: ColorPickerProps) {
  const { hex: initHex, alpha: initAlpha } = parseColor(value === 'transparent' ? 'rgba(255,255,255,0)' : value);
  const initRgb = hexToRgb(initHex);
  const initHsv = rgbToHsv(initRgb);

  const [hsv, setHsv] = useState<HSV>(initHsv);
  const [alpha, setAlpha] = useState(value === 'transparent' ? 0 : initAlpha);
  const [hexInput, setHexInput] = useState(initHex.slice(1).toUpperCase());

  // Derived values
  const rgb = hsvToRgb(hsv);
  const currentHex = rgbToHex(rgb);

  const emit = useCallback((h: HSV, a: number) => {
    const c = buildColor(rgbToHex(hsvToRgb(h)), a);
    onChange(c);
  }, [onChange]);

  // Update hex input when hsv changes
  useEffect(() => { setHexInput(currentHex.slice(1).toUpperCase()); }, [currentHex]);

  // ── SV Picker ──────────────────────────────────────────────────────────
  const svRef = useRef<HTMLDivElement>(null);
  const draggingSV = useRef(false);

  const pickSV = (e: React.MouseEvent | MouseEvent) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    const newHsv = { ...hsv, s, v };
    setHsv(newHsv);
    emit(newHsv, alpha);
  };

  useEffect(() => {
    const up = () => { draggingSV.current = false; };
    const move = (e: MouseEvent) => { if (draggingSV.current) pickSV(e); };
    window.addEventListener('mouseup', up);
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('mousemove', move); };
  });

  // ── Hue slider ─────────────────────────────────────────────────────────
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingH = useRef(false);

  const pickH = (e: React.MouseEvent | MouseEvent) => {
    const el = hueRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const h = Math.round(Math.max(0, Math.min(359, ((e.clientX - rect.left) / rect.width) * 360)));
    const newHsv = { ...hsv, h };
    setHsv(newHsv);
    emit(newHsv, alpha);
  };

  useEffect(() => {
    const up = () => { draggingH.current = false; };
    const move = (e: MouseEvent) => { if (draggingH.current) pickH(e); };
    window.addEventListener('mouseup', up);
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('mousemove', move); };
  });

  const handleHexInput = (raw: string) => {
    setHexInput(raw.toUpperCase());
    const clean = raw.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 6) {
      const newRgb = hexToRgb('#' + clean);
      const newHsv = rgbToHsv(newRgb);
      setHsv(newHsv);
      emit(newHsv, alpha);
    }
  };

  const hueColor = `hsl(${hsv.h},100%,50%)`;
  const cursorLeft = `${hsv.s * 100}%`;
  const cursorTop  = `${(1 - hsv.v) * 100}%`;

  return (
    <div className="bg-[#1c1c1c] border border-white/10 rounded-2xl shadow-2xl p-4 w-64 select-none" onMouseDown={e => e.stopPropagation()}>

      {/* SV Box */}
      <div ref={svRef}
        className="relative rounded-xl mb-3 cursor-crosshair"
        style={{
          height: 160,
          background: `linear-gradient(to right, #fff, ${hueColor})`,
        }}
        onMouseDown={e => { draggingSV.current = true; pickSV(e); }}
      >
        {/* Black overlay */}
        <div className="absolute inset-0 rounded-xl" style={{ background: 'linear-gradient(to top, #000, transparent)' }} />
        {/* Cursor */}
        <div className="absolute w-4 h-4 rounded-full border-2 border-white shadow-lg -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: cursorLeft, top: cursorTop, background: currentHex }} />
      </div>

      {/* Hue slider */}
      <div className="mb-2">
        <label className="text-[10px] text-white/30 uppercase tracking-widest mb-1 block">Hue</label>
        <div ref={hueRef}
          className="relative rounded-full cursor-pointer"
          style={{ height: 14, background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}
          onMouseDown={e => { draggingH.current = true; pickH(e); }}
        >
          <div className="absolute top-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
        </div>
      </div>

      {/* Alpha slider */}
      <div className="mb-3">
        <label className="text-[10px] text-white/30 uppercase tracking-widest mb-1 block">Alpha</label>
        <div className="relative rounded-full cursor-pointer" style={{ height: 14 }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const a = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const rounded = Math.round(a * 100) / 100;
            setAlpha(rounded); emit(hsv, rounded);
          }}
        >
          {/* Checkerboard bg */}
          <div className="absolute inset-0 rounded-full" style={{ background: 'repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 0 0 / 8px 8px' }} />
          {/* Gradient */}
          <div className="absolute inset-0 rounded-full" style={{ background: `linear-gradient(to right, transparent, ${currentHex})` }} />
          {/* Thumb */}
          <div className="absolute top-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{ left: `${alpha * 100}%`, background: buildColor(currentHex, alpha) }} />
        </div>
      </div>

      {/* Inputs */}
      <div className="flex gap-2 mb-3">
        {/* Preview swatch */}
        <div className="relative w-9 h-9 rounded-lg overflow-hidden shrink-0">
          <div className="absolute inset-0" style={{ background: 'repeating-conic-gradient(#555 0% 25%,#222 0% 50%) 0 0/8px 8px' }} />
          <div className="absolute inset-0 rounded-lg" style={{ background: buildColor(currentHex, alpha) }} />
        </div>
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-1 bg-[#2a2a2a] rounded-lg px-2 py-1">
            <span className="text-[10px] text-white/30">#</span>
            <input value={hexInput} onChange={e => handleHexInput(e.target.value)}
              maxLength={6}
              className="flex-1 bg-transparent text-xs font-mono outline-none text-white/80 w-full" />
          </div>
          <div className="flex gap-1">
            {(['r','g','b'] as const).map((ch, i) => (
              <div key={ch} className="flex-1 flex items-center gap-0.5 bg-[#2a2a2a] rounded px-1.5 py-1">
                <span className="text-[9px] text-white/30 uppercase">{ch}</span>
                <input type="number" min={0} max={255}
                  value={[rgb.r,rgb.g,rgb.b][i]}
                  onChange={e => {
                    const newRgb = { ...rgb, [ch === 'r' ? 'r' : ch === 'g' ? 'g' : 'b']: Math.max(0,Math.min(255,+e.target.value)) };
                    const newHsv = rgbToHsv(newRgb);
                    setHsv(newHsv); emit(newHsv, alpha);
                  }}
                  className="flex-1 bg-transparent text-[10px] font-mono outline-none text-white/70 w-full min-w-0" />
              </div>
            ))}
            <div className="flex items-center gap-0.5 bg-[#2a2a2a] rounded px-1.5 py-1">
              <span className="text-[9px] text-white/30">A</span>
              <input type="number" min={0} max={100}
                value={Math.round(alpha * 100)}
                onChange={e => { const a = Math.max(0,Math.min(100,+e.target.value))/100; setAlpha(a); emit(hsv,a); }}
                className="w-7 bg-transparent text-[10px] font-mono outline-none text-white/70" />
            </div>
          </div>
        </div>
      </div>

      {/* Presets */}
      <div>
        <label className="text-[10px] text-white/30 uppercase tracking-widest mb-1.5 block">Presets</label>
        <div className="grid grid-cols-9 gap-1">
          {PRESETS.map((p, i) => {
            const isTransparent = p === 'transparent';
            return (
              <button key={i}
                onClick={() => {
                  if (isTransparent) { setAlpha(0); emit(hsv, 0); return; }
                  const { hex, alpha: a } = parseColor(p);
                  const newHsv = rgbToHsv(hexToRgb(hex));
                  setHsv(newHsv); setAlpha(a); emit(newHsv, a);
                }}
                className="relative w-6 h-6 rounded-md overflow-hidden border border-white/10 hover:scale-110 transition-transform"
                title={p}
              >
                {isTransparent ? (
                  <>
                    <div className="absolute inset-0" style={{ background: 'repeating-conic-gradient(#555 0% 25%,#222 0% 50%) 0 0/6px 6px' }} />
                    <div className="absolute inset-0 flex items-center justify-center text-white/60 text-[8px]">✕</div>
                  </>
                ) : (
                  <>
                    <div className="absolute inset-0" style={{ background: 'repeating-conic-gradient(#555 0% 25%,#222 0% 50%) 0 0/6px 6px' }} />
                    <div className="absolute inset-0" style={{ background: p }} />
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
