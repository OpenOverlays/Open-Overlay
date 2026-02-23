import React, { useState, useEffect, useRef, useCallback, createRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Settings, Save, Eye, EyeOff, Lock, Unlock, Trash2, Grid,
  Download, Upload, Type, Square, Image as ImageIcon, PenTool,
  Circle, Triangle, Star, CheckCheck, Copy, Link, Wifi, Layers,
  ChevronRight, ChevronDown, GripVertical, X, Scissors, Monitor,
  Blend, LayoutTemplate, RotateCw, Play, Pause, SkipBack, SkipForward,
  Repeat, Diamond, Clock, Zap, ChevronsRight, Eraser, Pencil, Hexagon, Octagon
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Rnd } from 'react-rnd';
import { AnimatePresence, motion } from 'motion/react';
import {
  WorkspaceConfig, Widget, OverlayElement, ElementType, MaskType,
  BlendMode, WIDGET_PRESETS, WIDGET_COLORS, WidgetType, GradientDir,
  GlobalKeyframe, KeyframeProperty, EasingType, AnimationTimeline
} from '../types';
import { cn } from '../utils';
import { listWorkspaces, getWorkspace, saveWorkspace, getWidgetObsUrl } from '../tauriApi';
import ColorPicker, { buildColor, parseColor } from './ColorPicker';

// ---------------------------------------------------------------------------
// DimInput — buffered dimension input: only commits on blur to avoid NaN/clamping mid-type
// ---------------------------------------------------------------------------
function DimInput({ value, onCommit, min = 1, max = 99999 }: { value: number; onCommit: (v: number) => void; min?: number; max?: number }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={local}
      onChange={e => setLocal(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => {
        const parsed = parseInt(local, 10);
        if (!isNaN(parsed) && parsed >= min) {
          const clamped = Math.min(max, Math.max(min, parsed));
          onCommit(clamped);
          setLocal(String(clamped));
        } else {
          setLocal(String(value)); // revert on invalid
        }
      }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-16 bg-white/5 rounded-md px-2 py-1 text-center text-xs text-white/80 border border-white/5 outline-none focus:border-white/20 focus:bg-white/10 transition-colors"
    />
  );
}

// ---------------------------------------------------------------------------
// LiveText / LiveTextArea
// Keeps its own local state for the typed value so React re-renders from the
// parent (caused by every state update) do NOT reset cursor position or focus.
// Syncs from props only when `syncKey` changes (i.e. a different element is selected).
// ---------------------------------------------------------------------------
function LiveText({ syncKey, value, onChange, className, placeholder }: {
  syncKey: string; value: string; onChange: (v: string) => void;
  className?: string; placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const prevKey = useRef(syncKey);
  if (prevKey.current !== syncKey) { prevKey.current = syncKey; setLocal(value); }
  return (
    <input value={local} placeholder={placeholder}
      onChange={e => { setLocal(e.target.value); onChange(e.target.value); }}
      className={className} />
  );
}

function LiveTextArea({ syncKey, value, onChange, className }: {
  syncKey: string; value: string; onChange: (v: string) => void; className?: string;
}) {
  const [local, setLocal] = useState(value);
  const prevKey = useRef(syncKey);
  if (prevKey.current !== syncKey) { prevKey.current = syncKey; setLocal(value); }
  return (
    <textarea value={local}
      onChange={e => { setLocal(e.target.value); onChange(e.target.value); }}
      className={className} />
  );
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
function newWorkspace(): WorkspaceConfig {
  const widgetId = uuidv4();
  return {
    id: uuidv4(),
    name: 'My Overlay',
    widgets: [{
      id: widgetId,
      name: 'Alert',
      widgetType: 'alert',
      width: WIDGET_PRESETS.alert.width,
      height: WIDGET_PRESETS.alert.height,
      background: 'transparent',
      artboardX: 60,
      artboardY: 60,
      elements: [],
    }],
  };
}

function newElement(type: ElementType, extra?: Partial<OverlayElement>): OverlayElement {
  return {
    id: uuidv4(), type, name: `New ${type}`,
    x: 20, y: 20, width: type === 'text' ? 280 : 200, height: type === 'text' ? 60 : 200,
    zIndex: 0, visible: true, locked: false, opacity: 1, rotation: 0,
    fill: '#3b82f6', borderRadius: 0, fontSize: 48, color: '#ffffff',
    fontFamily: 'Inter', textAlign: 'center', fontWeight: '600',
    content: type === 'text' ? 'Text' : '', shapeType: 'rectangle',
    animationName: 'none', animationDuration: 1, animationDelay: 0, animationIterationCount: '1',
    ...extra,
  };
}

function newGroup(): OverlayElement {
  return {
    id: uuidv4(), type: 'group', name: `Group`,
    x: 20, y: 20, width: 300, height: 200,
    zIndex: 0, visible: true, locked: false, opacity: 1, rotation: 0,
    blendMode: 'normal', children: [],
  };
}

function newMask(maskType: MaskType = 'clip'): OverlayElement {
  return {
    id: uuidv4(), type: 'mask', name: `${maskType} mask`,
    x: 20, y: 20, width: 300, height: 200,
    zIndex: 0, visible: true, locked: false, opacity: 1, rotation: 0,
    maskType, clipRadius: 0,
    gradientDir: 'to bottom', gradientStartOpacity: 1, gradientEndOpacity: 0,
    blendMode: 'normal', children: [],
  };
}
// ---------------------------------------------------------------------------
// Keyframe interpolation engine
// ---------------------------------------------------------------------------
const NUMERIC_KEYFRAME_PROPS: KeyframeProperty[] = [
  'x','y','width','height','rotation','opacity',
  'strokeWidth','borderRadius','fontSize','letterSpacing','lineHeight',
  'blur','brightness','contrast','hueRotate','saturate','scaleX','scaleY'
];
const COLOR_KEYFRAME_PROPS: KeyframeProperty[] = ['fill','strokeColor','color'];

function easingFn(t: number, type: EasingType): number {
  switch (type) {
    case 'linear': return t;
    case 'ease-in': return t * t;
    case 'ease-out': return t * (2 - t);
    case 'ease-in-out': return t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    case 'bounce': {
      if (t < 1/2.75) return 7.5625*t*t;
      if (t < 2/2.75) { t -= 1.5/2.75; return 7.5625*t*t+0.75; }
      if (t < 2.5/2.75) { t -= 2.25/2.75; return 7.5625*t*t+0.9375; }
      t -= 2.625/2.75; return 7.5625*t*t+0.984375;
    }
    case 'elastic': return t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2,10*(t-1))*Math.sin((t-1.1)*5*Math.PI);
    default: return t;
  }
}

function lerpColor(a: string, b: string, t: number): string {
  const parse = (c: string) => {
    if (c.startsWith('#')) {
      const hex = c.slice(1);
      const full = hex.length===3 ? hex.split('').map(ch=>ch+ch).join('') : hex;
      return [parseInt(full.slice(0,2),16), parseInt(full.slice(2,4),16), parseInt(full.slice(4,6),16)];
    }
    const m = c.match(/\d+/g);
    return m ? m.slice(0,3).map(Number) : [0,0,0];
  };
  const ca = parse(a), cb = parse(b);
  const r = Math.round(ca[0]+(cb[0]-ca[0])*t);
  const g = Math.round(ca[1]+(cb[1]-ca[1])*t);
  const bl = Math.round(ca[2]+(cb[2]-ca[2])*t);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${bl.toString(16).padStart(2,'0')}`;
}

function solveSpline(pts: {x:number,y:number}[], tension=1) {
  if(!pts || pts.length===0) return '';
  if(pts.length===1) return `M ${pts[0].x} ${pts[0].y}`;
  if(pts.length===2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let res = `M ${pts[0].x} ${pts[0].y}`;
  for(let i=0; i<pts.length-1; i++) {
    const p0 = i===0 ? pts[0] : pts[i-1];
    const p1 = pts[i];
    const p2 = pts[i+1];
    const p3 = i+2 < pts.length ? pts[i+2] : p2;
    const cp1x = p1.x + (p2.x - p0.x)/6 * tension;
    const cp1y = p1.y + (p2.y - p0.y)/6 * tension;
    const cp2x = p2.x - (p3.x - p1.x)/6 * tension;
    const cp2y = p2.y - (p3.y - p1.y)/6 * tension;
    res += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return res;
}

/**
 * Given global keyframes, an element ID, and a current time,
 * return interpolated property overrides for that element.
 */
function interpolateElementFromGlobal(
  keyframes: GlobalKeyframe[], elId: string, el: OverlayElement, time: number
): Partial<Record<KeyframeProperty, number|string>> {
  if (keyframes.length === 0) return {};
  const sorted = [...keyframes].sort((a,b) => a.time - b.time);

  // Get element state from a keyframe (falls back to empty)
  const getState = (kf: GlobalKeyframe) => kf.elementStates[elId] ?? {};

  if (time <= sorted[0].time) return { ...getState(sorted[0]) };
  if (time >= sorted[sorted.length-1].time) return { ...getState(sorted[sorted.length-1]) };

  let prev = sorted[0], next = sorted[1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (time >= sorted[i].time && time <= sorted[i+1].time) {
      prev = sorted[i]; next = sorted[i+1]; break;
    }
  }

  const prevState = getState(prev);
  const nextState = getState(next);
  const span = next.time - prev.time;
  const rawT = span > 0 ? (time - prev.time) / span : 1;
  const t = easingFn(rawT, prev.easing);

  const result: Partial<Record<KeyframeProperty, number|string>> = {};
  const allProps = new Set([...Object.keys(prevState),...Object.keys(nextState)]) as Set<KeyframeProperty>;

  for (const prop of allProps) {
    const pv = prevState[prop];
    const nv = nextState[prop];
    if (pv === undefined && nv === undefined) continue;
    if (NUMERIC_KEYFRAME_PROPS.includes(prop)) {
      const a = (pv as number) ?? (el as any)[prop] ?? 0;
      const b = (nv as number) ?? (el as any)[prop] ?? 0;
      result[prop] = a + (b - a) * t;
    } else if (COLOR_KEYFRAME_PROPS.includes(prop)) {
      const a = (pv as string) ?? (el as any)[prop] ?? '#000000';
      const b = (nv as string) ?? (el as any)[prop] ?? '#000000';
      result[prop] = lerpColor(a, b, t);
    }
  }
  return result;
}

/** Default timeline config */
function defaultTimeline(): AnimationTimeline {
  return { duration: 5, loop: false, autoplay: false, speed: 1, keyframes: [] };
}

// ---------------------------------------------------------------------------
// Element renderer (shared between designer and inline)
// ---------------------------------------------------------------------------
function ElementContent({ el }: { el: OverlayElement }) {
  if (el.type === 'shape') {
    if (el.shapeType === 'triangle')
      return <div style={{ width:'100%',height:'100%',background:el.fill,clipPath:'polygon(50% 0%,0% 100%,100% 100%)' }} />;
    if (el.shapeType === 'star')
      return <div style={{ width:'100%',height:'100%',background:el.fill,clipPath:'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)' }} />;
    if (el.shapeType === 'hexagon')
      return <div style={{ width:'100%',height:'100%',background:el.fill,clipPath:'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' }} />;
    if (el.shapeType === 'octagon')
      return <div style={{ width:'100%',height:'100%',background:el.fill,clipPath:'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)' }} />;
    return null; // rect/circle handled by container style
  }
  if (el.type === 'path' && el.pathData)
    return <svg viewBox={`0 0 ${el.width} ${el.height}`} style={{width:'100%',height:'100%',overflow:'visible'}}>
      <path d={el.pathData} fill={el.fill||'none'} stroke={el.strokeColor||'#3b82f6'} strokeWidth={el.strokeWidth||4} />
    </svg>;
  if (el.type === 'text')
    return <div style={{ fontSize:`${el.fontSize}px`,color:el.color,fontFamily:el.fontFamily,textAlign:el.textAlign,fontWeight:el.fontWeight,textShadow:el.textShadow,lineHeight:el.lineHeight,letterSpacing:el.letterSpacing?`${el.letterSpacing}px`:undefined,width:'100%',padding:'0 8px',wordBreak:'break-word' }}>{el.content}</div>;
  if (el.type === 'image' && el.src)
    return <img src={el.src} style={{width:'100%',height:'100%',objectFit:el.objectFit||'contain'}} draggable={false} />;
  return null;
}

function getMaskCss(el: OverlayElement): React.CSSProperties {
  if (el.maskType === 'clip') {
    return { overflow:'hidden', borderRadius:`${el.clipRadius??0}px` };
  }
  if (el.maskType === 'gradient') {
    const dir = el.gradientDir ?? 'to bottom';
    const s = el.gradientStartOpacity ?? 1, e = el.gradientEndOpacity ?? 0;
    const grad = dir === 'radial'
      ? `radial-gradient(circle,rgba(0,0,0,${el.maskInvert ? 1 - s : s}) 0%,rgba(0,0,0,${el.maskInvert ? 1 - e : e}) 100%)`
      : `linear-gradient(${dir},rgba(0,0,0,${el.maskInvert ? 1 - s : s}) 0%,rgba(0,0,0,${el.maskInvert ? 1 - e : e}) 100%)`;
    return { WebkitMaskImage: grad, maskImage: grad } as React.CSSProperties;
  }
  if (el.maskType === 'image' && el.maskImageSrc) {
    const imgGrad = `url(${el.maskImageSrc})`;
    return { WebkitMaskImage: imgGrad, maskImage: imgGrad, WebkitMaskSize: 'cover', maskSize: 'cover', WebkitMaskPosition: 'center', maskPosition: 'center' } as React.CSSProperties;
  }
  if (el.maskType === 'opacity') {
    return { opacity: el.maskInvert ? 1 - (el.opacity ?? 1) : el.opacity };
  }
  return {};
}

// ---------------------------------------------------------------------------
// TransformBox (Custom rotation & bounds manager replacing react-rnd)
// ---------------------------------------------------------------------------
function TransformBox({ el, isSelected, scale, containerW, containerH, onUpdate, onSelect, style, isDrawing, children }: any) {
  const handleDragDown = (e: React.PointerEvent) => {
    if (el.locked || isDrawing) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startElX = el.x;
    const startElY = el.y;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      let nx = startElX + dx;
      let ny = startElY + dy;
      
      const cx = nx + el.width / 2;
      const cy = ny + el.height / 2;
      if (cx < 0) nx = -el.width / 2;
      if (cx > containerW) nx = containerW - el.width / 2;
      if (cy < 0) ny = -el.height / 2;
      if (cy > containerH) ny = containerH - el.height / 2;
      
      onUpdate(el.id, { x: nx, y: ny });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleResizeDown = (e: React.PointerEvent, dir: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (el.locked || isDrawing) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = Math.max(0, el.width);
    const startH = Math.max(0, el.height);
    const startElX = el.x;
    const startElY = el.y;
    const rot = el.rotation || 0;
    const rad = rot * Math.PI / 180;
    const initialCx = startElX + startW / 2;
    const initialCy = startElY + startH / 2;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;

      const dx_local = dx * Math.cos(-rad) - dy * Math.sin(-rad);
      const dy_local = dx * Math.sin(-rad) + dy * Math.cos(-rad);

      let dw = 0, dh = 0;
      if (dir.includes('e')) dw = dx_local;
      if (dir.includes('w')) dw = -dx_local;
      if (dir.includes('s')) dh = dy_local;
      if (dir.includes('n')) dh = -dy_local;

      let newW = Math.max(4, startW + dw);
      let newH = Math.max(4, startH + dh);

      let actual_dw = newW - startW;
      let actual_dh = newH - startH;

      let dcx_local = 0;
      let dcy_local = 0;
      if (dir.includes('e')) dcx_local = actual_dw / 2;
      if (dir.includes('w')) dcx_local = -actual_dw / 2;
      if (dir.includes('s')) dcy_local = actual_dh / 2;
      if (dir.includes('n')) dcy_local = -actual_dh / 2;

      const dcx = dcx_local * Math.cos(rad) - dcy_local * Math.sin(rad);
      const dcy = dcx_local * Math.sin(rad) + dcy_local * Math.cos(rad);

      let nx = initialCx + dcx - newW / 2;
      let ny = initialCy + dcy - newH / 2;

      // Ensure center doesn't exceed bounds
      const cx = nx + newW / 2;
      const cy = ny + newH / 2;
      if (cx < 0) nx = -newW / 2;
      if (cx > containerW) nx = containerW - newW / 2;
      if (cy < 0) ny = -newH / 2;
      if (cy > containerH) ny = containerH - newH / 2;

      onUpdate(el.id, { width: Math.round(newW), height: Math.round(newH), x: Math.round(nx), y: Math.round(ny) });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const isMask = el.type === 'mask';
  const isGroup = el.type === 'group';
  const colorStr = isMask ? 'rgb(45,212,191)' : isGroup ? 'rgb(168,85,247)' : 'rgb(59,130,246)'; 

  return (
    <div
      className="absolute"
      onPointerDown={(e) => { onSelect?.(e); handleDragDown(e); }}
      style={{
        width: el.width, height: el.height, left: el.x, top: el.y,
        transform: `rotate(${el.rotation || 0}deg)`,
        transformOrigin: 'center center',
        cursor: el.locked || isDrawing ? 'default' : 'move',
        ...style
      }}
    >
      <div className="w-full h-full relative" style={{ pointerEvents: !isSelected ? 'auto' : 'none' }}>
        {children}
      </div>

      {isSelected && !el.locked && !isDrawing && (
        <>
          {['nw','ne','sw','se','n','s','e','w'].map(pos => {
            const hs: any = { position: 'absolute', width: 8, height: 8, background: '#111', border: `1.5px solid ${colorStr}`, zIndex: 9999, borderRadius: pos.length === 2 ? '50%' : '2px', boxShadow: '0 0 4px rgba(0,0,0,0.5)' };
            if (pos.includes('n')) hs.top = -4;
            if (pos.includes('s')) hs.bottom = -4;
            if (pos.includes('w')) hs.left = -4;
            if (pos.includes('e')) hs.right = -4;
            if (pos === 'n' || pos === 's') { hs.left = '50%'; hs.transform = 'translateX(-50%)'; hs.cursor = 'ns-resize'; hs.width = 12; hs.height = 6; }
            if (pos === 'e' || pos === 'w') { hs.top = '50%'; hs.transform = 'translateY(-50%)'; hs.cursor = 'ew-resize'; hs.width = 6; hs.height = 12;}
            if (pos === 'nw' || pos === 'se') hs.cursor = 'nwse-resize';
            if (pos === 'ne' || pos === 'sw') hs.cursor = 'nesw-resize';

            return <div key={pos} style={hs} onPointerDown={(e) => handleResizeDown(e, pos)} />;
          })}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Designer
// ---------------------------------------------------------------------------
export default function Designer() {
  const [workspace, setWorkspace] = useState<WorkspaceConfig>(newWorkspace());
  const [activeWidgetId, setActiveWidgetId] = useState<string>(workspace.widgets[0].id);
  const [selectedPath, setSelectedPath] = useState<string[]>([]); // path of element IDs to selected
  const [scale, setScale] = useState(0.5);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<'layers'|'properties'>('layers');
  const [showObsPanel, setShowObsPanel] = useState(false);
  const [widgetObsUrl, setWidgetObsUrl] = useState('');
  const [urlCopied, setUrlCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle'|'saving'|'saved'|'error'>('idle');
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [workspaceList, setWorkspaceList] = useState<{id:string;name:string}[]>([]);
  const [activeTool, setActiveTool] = useState<'select'|'curvature'|'pencil'|'eraser'>('select');
  const isDrawing = activeTool !== 'select';
  const [showGrid, setShowGrid] = useState(false);
  const [currentPath, setCurrentPath] = useState<{x:number;y:number}[]>([]);
  const [previewPoint, setPreviewPoint] = useState<{x:number;y:number} | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string|null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{id: string, position: 'before'|'after'|'inside'|'mask-spot'}|null>(null);
  const [rotatingId, setRotatingId] = useState<string|null>(null);
  const [clipboard, setClipboard] = useState<OverlayElement | null>(null);

  // ── Timeline / Keyframe state ──────────────────────────────────────────
  const [showTimeline, setShowTimeline] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string|null>(null);
  const playStartRef = useRef<number>(0);
  const playTimeOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);

  const activeWidget = workspace.widgets.find(w => w.id === activeWidgetId) ?? workspace.widgets[0];
  const timeline = activeWidget.animationTimeline ?? defaultTimeline();

  // Update canvas size → update scale
  useEffect(() => {
    const update = () => {
      if (!canvasRef.current) return;
      const c = canvasRef.current.parentElement;
      if (c) setScale(Math.min((c.clientWidth-60)/activeWidget.width, (c.clientHeight-60)/activeWidget.height));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [activeWidget.width, activeWidget.height]);

  useEffect(() => {
    getWidgetObsUrl(activeWidgetId).then(setWidgetObsUrl).catch(console.error);
  }, [activeWidgetId]);

  // ── Workspace mutation helpers ──────────────────────────────────────────
  const updateWidget = (wid: string, up: Partial<Widget>) =>
    setWorkspace(ws => ({ ...ws, widgets: ws.widgets.map(w => w.id === wid ? { ...w, ...up } : w) }));

  /** Recursively find & update an element inside a widget's element tree */
  function patchElements(elements: OverlayElement[], id: string, up: Partial<OverlayElement>): OverlayElement[] {
    return elements.map(el => {
      if (el.id === id) return { ...el, ...up };
      if (el.children) return { ...el, children: patchElements(el.children, id, up) };
      return el;
    });
  }
  function removeFromElements(elements: OverlayElement[], id: string): OverlayElement[] {
    return elements
      .filter(el => el.id !== id)
      .map(el => el.children ? { ...el, children: removeFromElements(el.children, id) } : el);
  }
  function findElement(elements: OverlayElement[], id: string): OverlayElement | null {
    for (const el of elements) {
      if (el.id === id) return el;
      if (el.children) { const f = findElement(el.children, id); if (f) return f; }
    }
    return null;
  }

  const updateEl = useCallback((id: string, up: Partial<OverlayElement>) => {
    setWorkspace(ws => {
      const activeW = ws.widgets.find(w => w.id === activeWidgetId);
      if (!activeW) return ws;

      if (selectedKeyframeId) {
        const tl = activeW.animationTimeline || { duration: 5, loop: false, autoplay: false, speed: 1, keyframes: [] };
        const newKfs = tl.keyframes.map(kf => {
          if (kf.id === selectedKeyframeId) {
            return {
              ...kf,
              elementStates: {
                ...kf.elementStates,
                [id]: { ...(kf.elementStates[id] || {}), ...up }
              }
            };
          }
          return kf;
        });
        return {
          ...ws,
          widgets: ws.widgets.map(w => w.id === activeWidgetId ? {
            ...w,
            animationTimeline: { ...tl, keyframes: newKfs }
          } : w)
        };
      }

      return {
        ...ws,
        widgets: ws.widgets.map(w => w.id === activeWidgetId ? {
          ...w,
          elements: patchElements(w.elements, id, up)
        } : w)
      };
    });
  }, [activeWidgetId, selectedKeyframeId]);

  const deleteEl = useCallback((id: string) => {
    setWorkspace(ws => ({
      ...ws,
      widgets: ws.widgets.map(w => w.id === activeWidgetId ? {
        ...w,
        elements: removeFromElements(w.elements, id)
      } : w)
    }));
  }, [activeWidgetId]);

  function flattenElements(els: OverlayElement[]): OverlayElement[] {
    return els.flatMap(e => e.children ? [e, ...flattenElements(e.children)] : [e]);
  }
  const allElements = flattenElements(activeWidget.elements);

  const shouldAnimate = isPlaying || isScrubbing || !!selectedKeyframeId;
  const getPreviousKeyframeTime = () => {
    if (!selectedKeyframeId) return null;
    const sorted = [...timeline.keyframes].sort((a,b) => a.time - b.time);
    const idx = sorted.findIndex(k => k.id === selectedKeyframeId);
    if (idx > 0) return sorted[idx - 1].time;
    return null;
  };
  const prevKfTime = getPreviousKeyframeTime();

  const selectedId = selectedPath[selectedPath.length - 1] ?? null;
  let selected = selectedId ? findElement(activeWidget.elements, selectedId) : null;

  if (selected && shouldAnimate && timeline.keyframes.length >= 1) {
    const overrides = interpolateElementFromGlobal(timeline.keyframes, selected.id, selected, currentTime);
    if (Object.keys(overrides).length > 0) {
      selected = { ...selected, ...overrides as any };
    }
  }


  // ── Add elements ──────────────────────────────────────────────────────
  const addEl = (el: OverlayElement, groupId?: string) => {
    el.zIndex = activeWidget.elements.length;
    if (groupId) {
      updateWidget(activeWidgetId, {
        elements: patchElements(activeWidget.elements, groupId, {
          children: [...(findElement(activeWidget.elements, groupId)?.children ?? []), el]
        } as any)
      });
      // expand the group
      setExpandedGroups(s => new Set([...s, groupId]));
    } else {
      updateWidget(activeWidgetId, { elements: [...activeWidget.elements, el] });
    }
    setSelectedPath([el.id]);
  };

  function deepCloneElement(el: OverlayElement, isRoot = true): OverlayElement {
    const clone = { ...el, id: uuidv4() };
    if (isRoot) {
      clone.x += 20;
      clone.y += 20;
      clone.name = `${el.name} (Copy)`;
    }
    if (clone.children) {
      clone.children = clone.children.map(child => deepCloneElement(child, false));
    }
    return clone;
  }

  // ── Keyboard Shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    // If we switch away from a drawing tool midway, clear any partial path
    if (activeTool === 'select' && currentPath.length > 0) {
      setCurrentPath([]);
      setPreviewPoint(null);
    }
  }, [activeTool, currentPath.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (activeTool !== 'select') {
          if (activeTool === 'curvature' && currentPath.length >= 2) {
            commitCurvaturePath();
          } else if (activeTool === 'pencil' && currentPath.length >= 2) {
            commitPencilPath();
          } else {
            setCurrentPath([]);
            setPreviewPoint(null);
          }
          setActiveTool('select');
          return;
        } else if (selectedId) {
          // generic escape in select mode un-selects layer
          setSelectedPath([]);
        }
      }

      if (isDrawing) return;

      const cmdOrCtrl = e.metaKey || e.ctrlKey;

      if (cmdOrCtrl && (e.key === 'c' || e.key === 'C')) {
        if (selected) setClipboard(selected);
      } else if (cmdOrCtrl && (e.key === 'v' || e.key === 'V')) {
        if (clipboard) {
          addEl(deepCloneElement(clipboard));
        }
      } else if (cmdOrCtrl && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (selected) {
          addEl(deepCloneElement(selected));
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          deleteEl(selectedId);
          setSelectedPath([]);
        }
      } else if ((e.key === 'k' || e.key === 'K') && !cmdOrCtrl && showTimeline) {
        e.preventDefault();
        addGlobalKeyframe(currentTime);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // ── Timeline Playback ──────────────────────────────────────────────────
  const playAnimation = useCallback(() => {
    setIsPlaying(true);
    playStartRef.current = performance.now();
    playTimeOffsetRef.current = currentTime;
    const tick = () => {
      const elapsed = (performance.now() - playStartRef.current) / 1000 * timeline.speed;
      let t = playTimeOffsetRef.current + elapsed;
      if (t >= timeline.duration) {
        if (timeline.loop) { t = t % timeline.duration; }
        else { t = timeline.duration; setIsPlaying(false); }
      }
      setCurrentTime(t);
      if (t < timeline.duration || timeline.loop) animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, [currentTime, timeline]);

  const pauseAnimation = useCallback(() => {
    setIsPlaying(false);
    cancelAnimationFrame(animFrameRef.current);
  }, []);

  const stopAnimation = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    cancelAnimationFrame(animFrameRef.current);
  }, []);

  useEffect(() => () => cancelAnimationFrame(animFrameRef.current), []);

  const setTimelineProp = (up: Partial<AnimationTimeline>) => {
    updateWidget(activeWidgetId, { animationTimeline: { ...timeline, ...up } });
  };

  // ── Keyframe management (global) ──────────────────────────────────────────
  /** Snapshot ALL elements’ current properties into a global keyframe */
  const snapshotAllElements = (elements: OverlayElement[], time?: number, keyframes?: GlobalKeyframe[]): Record<string, Partial<Record<KeyframeProperty, number|string>>> => {
    const states: Record<string, Partial<Record<KeyframeProperty, number|string>>> = {};
    const flatten = (els: OverlayElement[]) => {
      for (const el of els) {
        let stateEl = el;
        if (time !== undefined && keyframes && keyframes.length > 0) {
          const overrides = interpolateElementFromGlobal(keyframes, el.id, el, time);
          if (Object.keys(overrides).length > 0) {
            stateEl = { ...el, ...overrides as any };
          }
        }
        states[el.id] = {
          x: stateEl.x, y: stateEl.y, width: stateEl.width, height: stateEl.height,
          rotation: stateEl.rotation, opacity: stateEl.opacity,
          scaleX: stateEl.scaleX ?? 1, scaleY: stateEl.scaleY ?? 1,
          ...(stateEl.fill ? { fill: stateEl.fill } : {}),
          ...(stateEl.strokeColor ? { strokeColor: stateEl.strokeColor } : {}),
          ...(stateEl.color ? { color: stateEl.color } : {}),
          ...(stateEl.borderRadius !== undefined ? { borderRadius: stateEl.borderRadius } : {}),
          ...(stateEl.blur ? { blur: stateEl.blur } : {}),
          ...(stateEl.brightness ? { brightness: stateEl.brightness } : {}),
          ...(stateEl.fontSize ? { fontSize: stateEl.fontSize } : {}),
        };
        if (el.children) flatten(el.children);
      }
    };
    flatten(elements);
    return states;
  };

  const addGlobalKeyframe = (time: number) => {
    const kf: GlobalKeyframe = {
      id: uuidv4(),
      time: Math.round(time * 100) / 100,
      easing: 'linear' as EasingType,
      elementStates: snapshotAllElements(activeWidget.elements, time, timeline.keyframes),
    };
    const existing = timeline.keyframes;
    // Replace if keyframe exists at same time
    const filtered = existing.filter(k => Math.abs(k.time - time) > 0.01);
    setTimelineProp({ keyframes: [...filtered, kf] });
    setSelectedKeyframeId(kf.id);
  };

  const deleteGlobalKeyframe = (kfId: string) => {
    setTimelineProp({ keyframes: timeline.keyframes.filter(k => k.id !== kfId) });
    if (selectedKeyframeId === kfId) setSelectedKeyframeId(null);
  };

  const updateGlobalKeyframeEasing = (kfId: string, easing: EasingType) => {
    setTimelineProp({
      keyframes: timeline.keyframes.map(k => k.id === kfId ? { ...k, easing } : k)
    });
  };

  const updateGlobalKeyframeTime = (kfId: string, newTime: number) => {
    setTimelineProp({
      keyframes: timeline.keyframes.map(k => k.id === kfId ? { ...k, time: Math.max(0, Math.min(timeline.duration, newTime)) } : k)
    });
  };

  // ── Drawing ──────────────────────────────────────────────────────────
  const commitCurvaturePath = (overridePath?: {x:number,y:number}[]) => {
    const pts = overridePath || currentPath;
    if (pts.length < 2) { setCurrentPath([]); setPreviewPoint(null); return; }
    const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const norm = pts.map(p=>({x:p.x-minX,y:p.y-minY}));
    addEl({
      ...newElement('path'),
      x:minX,y:minY,width:Math.max(maxX-minX,4),height:Math.max(maxY-minY,4),
      pathData: solveSpline(norm),
      fill:'none',strokeColor:'#3b82f6',strokeWidth:4
    });
    setCurrentPath([]); setPreviewPoint(null); setActiveTool('select');
  };

  const commitPencilPath = (overridePath?: {x:number,y:number}[]) => {
    const pts = overridePath || currentPath;
    if (!pts.length || pts.length < 2) { setCurrentPath([]); return; }
    const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const norm = pts.map(p=>({x:p.x-minX,y:p.y-minY}));
    addEl({
      ...newElement('path'),
      x:minX,y:minY,width:Math.max(maxX-minX,4),height:Math.max(maxY-minY,4),
      pathData:`M ${norm.map(p=>`${p.x} ${p.y}`).join(' L ')}`,
      fill:'none',strokeColor:'#3b82f6',strokeWidth:4
    });
    setCurrentPath([]); setActiveTool('select');
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activeTool === 'select') return;
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
    const pt = { x:(e.clientX-rect.left)/scale, y:(e.clientY-rect.top)/scale };
    
    if (activeTool === 'curvature') {
      if (currentPath.length > 2) {
        const first = currentPath[0];
        if (Math.abs(first.x - pt.x) < 10 && Math.abs(first.y - pt.y) < 10) {
          commitCurvaturePath([...currentPath, first]);
          return;
        }
      }

      setCurrentPath(p => {
        if (p.length > 0) {
          const last = p[p.length-1];
          if (Math.abs(last.x - pt.x) < 5 && Math.abs(last.y - pt.y) < 5) return p;
        }
        return [...p, pt];
      });
    } else if (activeTool === 'pencil') {
      setCurrentPath([pt]);
    }
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (activeTool === 'select') return;
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
    const pt = { x:(e.clientX-rect.left)/scale, y:(e.clientY-rect.top)/scale };
    
    if (activeTool === 'curvature') {
      if (currentPath.length > 0) setPreviewPoint(pt);
    } else if (activeTool === 'pencil') {
      if (!currentPath.length) return;
      setCurrentPath(p => [...p, pt]);
    }
  };
  const handleMouseUp = () => {
    if (activeTool === 'curvature' || activeTool === 'select' || activeTool === 'eraser') return;
    
    if (activeTool === 'pencil') {
      commitPencilPath();
    }
  };
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (activeTool === 'curvature') {
      commitCurvaturePath();
    }
  };

  // ── Import / Export ──────────────────────────────────────────────────
  const handleExportWorkspace = async () => {
    let useBrowserFallback = false;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const filePath = await save({
        defaultPath: `${workspace.name.replace(/[^a-z0-9_-]/gi, '_')}.oo`,
        filters: [{ name: 'Open Overlay File', extensions: ['oo'] }],
      });
      if (!filePath) return; // user cancelled
      // Ensure .oo extension
      const finalPath = filePath.endsWith('.oo') ? filePath : filePath + '.oo';
      const jsonStr = JSON.stringify(workspace, null, 2);
      try {
        await writeTextFile(finalPath, jsonStr);
        console.log('Workspace exported successfully to', finalPath);
      } catch (writeErr) {
        console.error('writeTextFile failed:', writeErr);
        useBrowserFallback = true;
      }
    } catch(err) {
      console.warn("Tauri dialog not available, using browser fallback", err);
      useBrowserFallback = true;
    }
    if (useBrowserFallback) {
      const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = workspace.name.replace(/[^a-z0-9_-]/gi, '_') + '.oo';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleExportWidget = async () => {
    let useBrowserFallback = false;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const filePath = await save({
        defaultPath: `${activeWidget.name.replace(/[^a-z0-9_-]/gi, '_')}.oo`,
        filters: [{ name: 'Open Overlay File', extensions: ['oo'] }],
      });
      if (!filePath) return; // user cancelled
      const finalPath = filePath.endsWith('.oo') ? filePath : filePath + '.oo';
      const jsonStr = JSON.stringify(activeWidget, null, 2);
      try {
        await writeTextFile(finalPath, jsonStr);
        console.log('Widget exported successfully to', finalPath);
      } catch (writeErr) {
        console.error('writeTextFile failed:', writeErr);
        useBrowserFallback = true;
      }
    } catch(err) {
      console.warn("Tauri dialog not available, using browser fallback", err);
      useBrowserFallback = true;
    }
    if (useBrowserFallback) {
      const blob = new Blob([JSON.stringify(activeWidget, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = activeWidget.name.replace(/[^a-z0-9_-]/gi, '_') + '.oo';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleImportFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const selected = await open({
        filters: [{ name: 'Open Overlay File', extensions: ['oo', 'json'] }],
        multiple: false,
      });
      if (!selected) return; // user cancelled
      const filePath = typeof selected === 'string' ? selected : (selected as any)?.path ?? String(selected);
      const content = await readTextFile(filePath);
      const data = JSON.parse(content);
      if (data.widgets && data.id) {
        setWorkspace(data);
        setActiveWidgetId(data.widgets[0]?.id || '');
      } else if (data.widgetType || (data.id && data.elements)) {
        const newWidget = { ...data, id: uuidv4(), name: data.name + ' (Imported)' };
        setWorkspace(ws => ({ ...ws, widgets: [...ws.widgets, newWidget] }));
        setActiveWidgetId(newWidget.id);
      }
    } catch(err) {
      console.warn("Tauri open dialog failed, using browser fallback", err);
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.oo,.json,application/json';
      input.onchange = (e: any) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (re) => {
          try {
            const data = JSON.parse(re.target?.result as string);
            if (data.widgets && data.id) {
              setWorkspace(data);
              setActiveWidgetId(data.widgets[0]?.id || '');
            } else if (data.widgetType || (data.id && data.elements)) {
              const newWidget = { ...data, id: uuidv4(), name: data.name + ' (Imported)' };
              setWorkspace(ws => ({ ...ws, widgets: [...ws.widgets, newWidget] }));
              setActiveWidgetId(newWidget.id);
            }
          } catch(e) { console.error("Error parsing JSON", e); }
        };
        reader.readAsText(file);
      };
      input.click();
    }
  };

  // ── Save ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaveStatus('saving');
    try { await saveWorkspace(workspace); setSaveStatus('saved'); setTimeout(()=>setSaveStatus('idle'),2000); }
    catch { setSaveStatus('error'); setTimeout(()=>setSaveStatus('idle'),3000); }
  };

  // ── Layer Reordering & Drag/Drop ─────────────────────────────────────
  // The Layers panel renders top-to-bottom by **descending** zIndex
  // (highest z = top of list, like Photoshop).  We sort the same way here
  // so that 'before' / 'after' match the visual panel order.
  const moveLayer = (draggedId: string, targetId: string, position: 'before'|'after'|'inside') => {
    if (draggedId === targetId) return;
    const draggedEl = findElement(activeWidget.elements, draggedId);
    if (!draggedEl) return;
    
    // Check if dragging group into its own descendant
    if (draggedEl.type === 'group' || draggedEl.type === 'mask') {
      const isDescendant = !!findElement(draggedEl.children || [], targetId);
      if (isDescendant) return;
    }

    // Sort descending (matches Layers panel display order)
    const sortTree = (nodes: OverlayElement[]): OverlayElement[] => 
      [...nodes].sort((a,b) => b.zIndex - a.zIndex).map(n => ({
         ...n, children: n.children ? sortTree(n.children) : undefined
      }));

    let baseElements = sortTree(activeWidget.elements);
    let withoutDragged = removeFromElements(baseElements, draggedId);

    const insert = (nodes: OverlayElement[]): { changed: boolean, nodes: OverlayElement[] } => {
      const idx = nodes.findIndex(n => n.id === targetId);
      if (idx !== -1) {
        if (position === 'inside' && (nodes[idx].type === 'group' || nodes[idx].type === 'mask')) {
          const arr = [...nodes];
          arr[idx] = { 
             ...arr[idx], 
             children: [...(arr[idx].children || []), draggedEl]
          };
          setExpandedGroups(s => new Set([...s, targetId]));
          return { changed: true, nodes: arr };
        }
        const arr = [...nodes];
        // 'before' = above in the panel = earlier in the desc-sorted array
        arr.splice(position === 'before' ? idx : idx + 1, 0, draggedEl);
        return { changed: true, nodes: arr };
      }
      
      let changed = false;
      const res = nodes.map(n => {
        if (n.children) {
          const r = insert(n.children);
          if (r.changed) { changed = true; return { ...n, children: r.nodes }; }
        }
        return n;
      });
      return { changed, nodes: res };
    };

    const res = insert(withoutDragged);
    if (!res.changed) return;

    // Assign zIndex so first item in desc-sorted array gets the highest index
    const fixZ = (nodes: OverlayElement[]): OverlayElement[] => 
      nodes.map((n, i) => ({
        ...n,
        zIndex: nodes.length - 1 - i,
        children: n.children ? fixZ(n.children) : undefined,
      }));

    updateWidget(activeWidgetId, { elements: fixZ(res.nodes) });
  };

  const removeFromGroup = (elId: string, groupId: string) => {
    const group = findElement(activeWidget.elements, groupId);
    const el = group?.children?.find(c => c.id === elId);
    if (!el || !group) return;
    const newChildren = (group.children ?? []).filter(c => c.id !== elId);
    const newEl = { ...el, x: group.x + el.x, y: group.y + el.y };
    const patched = patchElements(activeWidget.elements, groupId, { children: newChildren } as any);
    updateWidget(activeWidgetId, { elements: [...patched, newEl] });
  };

  // ── Widget management ─────────────────────────────────────────────────
  const addWidget = (type: WidgetType) => {
    const preset = WIDGET_PRESETS[type];
    const newW: Widget = {
      id: uuidv4(), name: preset.label, widgetType: type,
      width: preset.width, height: preset.height, background: 'transparent',
      artboardX: 60 + workspace.widgets.length * 40,
      artboardY: 60 + workspace.widgets.length * 40,
      elements: [],
    };
    setWorkspace(ws => ({ ...ws, widgets: [...ws.widgets, newW] }));
    setActiveWidgetId(newW.id);
    setSelectedPath([]);
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const renderElements = (elements: OverlayElement[], containerW: number, containerH: number, inGroup = false, overrideTime?: number, isGhost = false): React.ReactNode[] => {
    const timeToUse = overrideTime !== undefined ? overrideTime : currentTime;
    return elements.filter(el => el.visible !== false).sort((a,b)=>a.zIndex-b.zIndex).map(rawEl => {
      // Apply keyframe interpolation during playback, scrubbing, or keyframe preview
      let el = rawEl;
      if ((shouldAnimate || overrideTime !== undefined) && timeline.keyframes.length >= 1) {
        const overrides = interpolateElementFromGlobal(timeline.keyframes, rawEl.id, rawEl, timeToUse);
        if (Object.keys(overrides).length > 0) {
          el = { ...rawEl, ...overrides as any };
        }
      }

      const isSelected = isGhost ? false : selectedId === el.id;
      const maskParams: React.CSSProperties = {};
      if (el.maskWithLayerId) {
        maskParams.maskImage = `url(#explicit-mask-${el.id})`;
        maskParams.WebkitMaskImage = `url(#explicit-mask-${el.id})`;
      }

      const sx = el.scaleX ?? 1, sy = el.scaleY ?? 1;
      const hasScale = sx !== 1 || sy !== 1;

      const commonStyle: React.CSSProperties = {
        opacity: el.opacity,
        filter: `blur(${el.blur||0}px) brightness(${el.brightness||100}%) contrast(${el.contrast||100}%) hue-rotate(${el.hueRotate||0}deg) saturate(${el.saturate||100}%)`,
        mixBlendMode: el.blendMode !== 'normal' ? el.blendMode as any : undefined,
        ...(hasScale ? { transform: `scale(${sx}, ${sy})` } : {}),
        ...maskParams,
      };

      if (el.type === 'group' || el.type === 'mask') {
        return (
          <TransformBox key={isGhost ? `ghost-${el.id}` : el.id} el={el} isSelected={isSelected} scale={scale} containerW={containerW} containerH={containerH} onUpdate={isGhost ? ()=>{} : updateEl} isDrawing={isGhost ? true : isDrawing} onSelect={isGhost ? undefined : (e:any)=>{
            if (activeTool === 'curvature' || activeTool === 'pencil') return;
            e.stopPropagation();
            if (activeTool === 'eraser') {
              deleteEl(el.id);
              setActiveTool('select');
            } else {
              setSelectedPath([el.id]);
            }
          }} style={commonStyle}>
            <div className={cn("w-full h-full relative", isSelected && (el.type === 'mask' ? 'ring-2 ring-teal-400 shadow-[0_0_15px_rgba(45,212,191,0.3)]' : 'ring-2 ring-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.3)]'))} style={{ isolation:'isolate', ...getMaskCss(el) }}>
              {/* group outline in designer */}
              <div className={cn("absolute inset-0 pointer-events-none border border-dashed rounded-[inherit]", el.type === 'mask' ? "border-teal-500/30" : "border-purple-500/30", isGhost ? "opacity-0" : "")} />
              <div className={cn("absolute top-0 left-0 text-white text-[9px] px-1 rounded-br pointer-events-none z-50", el.type === 'mask' ? "bg-teal-500/70" : "bg-purple-500/70", isGhost ? "opacity-0" : "")}>{el.name}</div>
              {inGroup ? null : renderElements(el.children ?? [], el.width, el.height, true, overrideTime, isGhost)}
            </div>
          </TransformBox>
        );
      }

      const shapeStyle: React.CSSProperties = {
        backgroundColor: el.type === 'shape' && el.shapeType !== 'triangle' && el.shapeType !== 'star' ? el.fill : 'transparent',
        borderRadius: `${el.borderRadius ?? 0}px`,
        border: el.strokeWidth ? `${el.strokeWidth}px solid ${el.strokeColor||'transparent'}` : 'none',
        display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',
      };

      return (
        <TransformBox key={isGhost ? `ghost-${el.id}` : el.id} el={el} isSelected={isSelected} scale={scale} containerW={containerW} containerH={containerH} onUpdate={isGhost ? ()=>{} : updateEl} isDrawing={isGhost ? true : isDrawing} onSelect={isGhost ? undefined : (e:any)=>{
          if (activeTool === 'curvature' || activeTool === 'pencil') return;
          e.stopPropagation();
          if (activeTool === 'eraser') {
            deleteEl(el.id);
            setActiveTool('select');
          } else {
            setSelectedPath([el.id]);
          }
        }} style={commonStyle}>
          <div className={cn("w-full h-full", isSelected && 'ring-2 ring-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.3)]')} style={shapeStyle}>
            <ElementContent el={el} />
          </div>
        </TransformBox>
      );
    });
  };

  return (
    <div className="flex h-full bg-[#050505] text-white overflow-hidden font-sans">

      {/* ── Left: Widget List + Toolbar ── */}
      <div className="w-56 bg-[#0E0E11] border-r border-white/5 flex flex-col shrink-0 z-40 shadow-2xl">
        {/* Widget tabs */}
        <div className="p-4 border-b border-white/5">
          <div className="text-[10px] uppercase font-semibold tracking-widest text-white/40 mb-3">Widgets</div>
          <div className="space-y-1.5">
            {workspace.widgets.map(w => (
              <button key={w.id} onClick={()=>{setActiveWidgetId(w.id);setSelectedPath([]);}}
                className={cn("w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all flex items-center gap-3",
                  activeWidgetId===w.id ? "bg-white/10 text-white shadow-sm font-medium" : "text-white/50 hover:bg-white/5 hover:text-white/90")}>
                <span className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm" style={{background:WIDGET_COLORS[w.widgetType]}} />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{w.name}</div>
                  <div className="text-[10px] text-white/30">{w.width}×{w.height}</div>
                </div>
              </button>
            ))}
          </div>
          {/* Add widget */}
          <div className="group relative mt-3">
            <button className="w-full py-2 rounded-xl border border-dashed border-white/10 text-white/40 hover:text-white/80 hover:border-white/20 hover:bg-white/[0.02] transition-all text-xs flex items-center justify-center gap-1.5">
              <Plus size={14} /> Add Widget
            </button>
            <div className="absolute left-full top-0 pl-2 hidden group-hover:block z-50">
              <div className="bg-[#18181B] border border-white/10 rounded-xl p-2 shadow-2xl w-44 backdrop-blur-xl">
                {(Object.keys(WIDGET_PRESETS) as WidgetType[]).map(t => (
                  <button key={t} onClick={()=>addWidget(t)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-sm flex items-center gap-2 transition-colors">
                    <span className="w-2 h-2 rounded-full shadow-sm" style={{background:WIDGET_COLORS[t]}} />
                    {WIDGET_PRESETS[t].label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Tools */}
        <div className="p-4 space-y-1 border-b border-white/5">
          <div className="text-[10px] uppercase font-semibold tracking-widest text-white/40 mb-3">Tools</div>
          {/* Shapes */}
          <div className="group relative">
            <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/5 text-sm font-medium text-white/60 hover:text-white transition-colors"><Square size={16}/> Shape</button>
            <div className="absolute left-full top-0 pl-2 hidden group-hover:block z-50">
              <div className="bg-[#18181B] border border-white/10 rounded-xl p-2 shadow-2xl w-40 backdrop-blur-xl">
                {([['rectangle','Rectangle',Square],['circle','Circle',Circle],['triangle','Triangle',Triangle],['star','Star',Star],['hexagon','Hexagon',Hexagon],['octagon','Octagon',Octagon]] as any[]).map(([s,l,Icon]:any)=>(
                  <button key={s} onClick={()=>addEl(newElement('shape',{name:l,shapeType:s,borderRadius:s==='circle'?9999:0}))}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-sm flex items-center gap-2.5 transition-colors"><Icon size={14}/>{l}</button>
                ))}
              </div>
            </div>
          </div>
          <button onClick={()=>addEl(newElement('text',{name:'Text Element'}))} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/5 text-sm font-medium text-white/60 hover:text-white transition-colors"><Type size={16}/>Text</button>
          <button onClick={()=>addEl(newElement('image',{name:'Image',fill:'transparent'}))} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/5 text-sm font-medium text-white/60 hover:text-white transition-colors"><ImageIcon size={16}/>Image</button>
          
          <button onClick={()=>{setActiveTool(t=>t==='curvature'?'select':'curvature');}} className={cn("w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors",activeTool==='curvature'?"bg-blue-500/20 text-blue-400":"hover:bg-white/5 text-white/60 hover:text-white")}><PenTool size={16}/>Curvature Pen</button>
          <button onClick={()=>{setActiveTool(t=>t==='pencil'?'select':'pencil');}} className={cn("w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors",activeTool==='pencil'?"bg-blue-500/20 text-blue-400":"hover:bg-white/5 text-white/60 hover:text-white")}><Pencil size={16}/>Pencil</button>
          <button onClick={()=>{setActiveTool(t=>t==='eraser'?'select':'eraser');}} className={cn("w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors",activeTool==='eraser'?"bg-red-500/20 text-red-400":"hover:bg-white/5 text-white/60 hover:text-white")}><Eraser size={16}/>Eraser</button>
          
          <div className="h-px bg-white/5 my-2" />
          
          {/* Groups & Masks */}
          <div className="group relative">
            <button onClick={()=>addEl(newGroup())} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-purple-500/10 text-sm font-medium text-purple-400/80 hover:text-purple-300 transition-colors"><Layers size={16}/>Layer Group</button>
          </div>
          
          <div className="group relative">
            <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-teal-500/10 text-sm font-medium text-teal-400/80 hover:text-teal-300 transition-colors"><Blend size={16}/>Mask Group</button>
            <div className="absolute left-full top-0 pl-2 hidden group-hover:block z-50">
              <div className="bg-[#18181B] border border-white/10 rounded-xl p-2 shadow-2xl w-52 backdrop-blur-xl">
                {([['clip','Clip Mask','Clips children to shape'],['gradient','Gradient Mask','Fades children with gradient'],['opacity','Opacity Mask','Controls group opacity'],['image','Image Mask','Mask with external image']] as [MaskType,string,string][]).map(([mt,label,sub])=>(
                  <button key={mt} onClick={()=>addEl(newMask(mt))} className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-teal-500/15 transition-colors">
                    <div className="text-sm text-white font-medium">{label}</div>
                    <div className="text-[10px] text-teal-200/50 mt-0.5">{sub}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 mt-auto space-y-1.5">
          <button onClick={()=>setShowObsPanel(v=>!v)} className={cn("w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors",showObsPanel?"bg-purple-500/20 text-purple-300":"hover:bg-white/5 text-white/50 hover:text-white")}><Wifi size={16}/>OBS Link</button>
          {/* Import Dropdown */}
          <div className="group relative">
            <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/5 text-sm font-medium text-white/50 hover:text-white transition-colors">
              <Upload size={16}/>Load / Import
            </button>
            <div className="absolute left-full bottom-0 pl-2 hidden group-hover:block z-50">
              <div className="bg-[#18181B] border border-white/10 rounded-xl p-2 shadow-2xl w-48 backdrop-blur-xl flex flex-col gap-1">
                <button
                  onClick={()=>{
                    listWorkspaces().then(setWorkspaceList).catch(console.error);
                    setShowLoadModal(true);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-sm flex items-center gap-2 transition-colors">
                  From Saved Workspaces
                </button>
                <div className="h-px bg-white/10 my-0.5 mx-2" />
                <button
                  onClick={handleImportFile}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-sm flex items-center gap-2 transition-colors">
                  From .OO File
                </button>
              </div>
            </div>
          </div>

          {/* Export Dropdown */}
          <div className="group relative">
            <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/5 text-sm font-medium text-white/50 hover:text-white transition-colors">
              <Download size={16}/>Export
            </button>
            <div className="absolute left-full bottom-0 pl-2 hidden group-hover:block z-50">
              <div className="bg-[#18181B] border border-white/10 rounded-xl p-2 shadow-2xl w-48 backdrop-blur-xl flex flex-col gap-1">
                <button
                  onClick={handleExportWorkspace}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-sm flex items-center gap-2 transition-colors">
                  Export Entire Workspace
                </button>
                <button
                  onClick={handleExportWidget}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-sm flex items-center gap-2 transition-colors">
                  Export Current Widget
                </button>
              </div>
            </div>
          </div>
          <button onClick={handleSave} className={cn("w-full flex items-center justify-center gap-2 px-3 py-2 mt-2 rounded-xl text-sm font-bold shadow-sm transition-all",saveStatus==='saved'?"bg-emerald-500 text-white":saveStatus==='error'?"bg-red-500 text-white":"bg-white/10 hover:bg-white/20 text-white")}>
            {saveStatus==='saved'?<CheckCheck size={16}/>:<Save size={16}/>}
            {saveStatus==='saving'?'Saving…':saveStatus==='saved'?'Saved':saveStatus==='error'?'Error':'Save Workspace'}
          </button>
        </div>
      </div>

      {/* ── Centre: Canvas ── */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Header */}
        <div className="h-14 border-b border-white/5 bg-[#0E0E11]/90 backdrop-blur-xl flex items-center px-6 gap-6 shrink-0 z-10 shadow-sm">
          <input value={activeWidget.name} onChange={e=>updateWidget(activeWidgetId,{name:e.target.value})}
            className="bg-transparent border-none outline-none text-base font-medium w-48 focus:ring-0 placeholder-white/30" placeholder="Widget Name" />
          <div className="flex items-center gap-2 text-sm text-white/40 font-medium bg-white/5 px-3 py-1.5 rounded-lg">
            <DimInput value={activeWidget.width} min={100} max={7680} onCommit={v => updateWidget(activeWidgetId,{width:v})} />
            <span>×</span>
            <DimInput value={activeWidget.height} min={100} max={4320} onCommit={v => updateWidget(activeWidgetId,{height:v})} />
          </div>
          <button onClick={() => setShowGrid(g => !g)} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ml-auto", showGrid ? "bg-blue-500/20 text-blue-400" : "bg-white/5 text-white/40 hover:text-white/80")}>
            <Grid size={14} /> Grid
          </button>
          <select value={activeWidget.background} onChange={e=>updateWidget(activeWidgetId,{background:e.target.value})}
            className="bg-white/5 rounded-lg px-3 py-1.5 text-sm font-medium text-white/70 border border-white/5 outline-none focus:border-white/20 transition-colors">
            <option value="transparent">Transparent</option>
            <option value="#00FF00">Green Screen</option>
            <option value="#000000">Black</option>
            <option value="#111111">Dark</option>
            <option value="#ffffff">White</option>
          </select>
          <div className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">OBS: {activeWidget.width}w</div>
        </div>

        {/* OBS URL bar */}
        <AnimatePresence>
          {showObsPanel && (
            <motion.div initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}}
              className="border-b border-purple-500/20 bg-gradient-to-r from-purple-500/10 to-transparent overflow-hidden shrink-0 z-0">
              <div className="px-6 py-3 flex items-center gap-4">
                <Wifi size={16} className="text-purple-400 shrink-0"/>
                <div className="flex-1 flex items-center gap-3 bg-black/40 rounded-xl px-4 py-2 border border-purple-500/20 backdrop-blur-md">
                  <span className="text-sm font-mono text-white/70 truncate flex-1">{widgetObsUrl||'Save first to get URL'}</span>
                  <button onClick={async()=>{await navigator.clipboard.writeText(widgetObsUrl);setUrlCopied(true);setTimeout(()=>setUrlCopied(false),2000);}} className="shrink-0 p-1 hover:bg-white/10 rounded-md transition-colors">
                    {urlCopied?<CheckCheck size={14} className="text-emerald-400"/>:<Copy size={14} className="text-white/40 hover:text-white"/>}
                  </button>
                </div>
                <span className="text-xs font-medium text-white/30 shrink-0">{activeWidget.width}×{activeWidget.height} native · live reload</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Canvas */}
        <div className="flex-1 bg-[#050505] flex items-center justify-center overflow-auto p-12"
          style={{backgroundImage:'radial-gradient(circle,rgba(255,255,255,0.02) 1px,transparent 1px)',backgroundSize:'24px 24px'}}>
          <div ref={canvasRef}
            style={{
              width:activeWidget.width, height:activeWidget.height,
              transform:`scale(${scale})`, transformOrigin:'center center',
              background: activeWidget.background==='transparent'
                ? 'linear-gradient(45deg,#111 25%,transparent 25%),linear-gradient(-45deg,#111 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#111 75%),linear-gradient(-45deg,transparent 75%,#111 75%)'
                : activeWidget.background,
              backgroundSize: activeWidget.background==='transparent' ? '24px 24px' : undefined,
              backgroundPosition: activeWidget.background==='transparent' ? '0 0,0 12px,12px -12px,-12px 0' : undefined,
              cursor: isDrawing ? 'crosshair' : 'default',
              position:'relative',
            }}
            className="shadow-[0_0_80px_rgba(0,0,0,0.6)] ring-1 ring-white/10 rounded-sm"
            onClick={e=>{
              if(e.target===e.currentTarget){
                if (activeTool === 'select') {
                  setSelectedPath([]);
                  setSelectedKeyframeId(null);
                }
              }
            }}
            onMouseDown={e => { 
              if (activeTool === 'curvature' || activeTool === 'pencil') handleMouseDown(e);
              else if (e.target === e.currentTarget) handleMouseDown(e); 
            }}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onDoubleClick={e => {
              if (activeTool === 'curvature') handleDoubleClick(e);
            }}
          >
            {showGrid && (
              <div 
                className="absolute inset-0 pointer-events-none z-0 overflow-hidden"
                style={{
                  backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)`,
                  backgroundSize: '100px 100px'
                }}
              >
                <div className="absolute inset-0" style={{
                  backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)`,
                  backgroundSize: '20px 20px'
                }} />
                {/* Center lines */}
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-blue-500/30 -translate-x-px" />
                <div className="absolute top-1/2 left-0 right-0 h-px bg-blue-500/30 -translate-y-px" />
              </div>
            )}
            {/* Explicit SVGs Masks */}
            <svg width="0" height="0" className="absolute pointer-events-none">
              <defs>
                {allElements.map(el => {
                  if (!el.maskWithLayerId) return null;
                  const maskTarget = allElements.find(m => m.id === el.maskWithLayerId);
                  if (!maskTarget) return null;

                  // Compute rough relative position for mask (assumes flat hierarchy or simple grouping)
                  const dx = maskTarget.x - el.x;
                  const dy = maskTarget.y - el.y;
                  const invert = !!el.maskInvert;

                  return (
                    <mask id={`explicit-mask-${el.id}`} key={`mask-${el.id}`} style={{ maskType: 'luminance' }}>
                      {/* Black background removes everything else by default, White keeps everything if inverted */}
                      <rect x="-9999" y="-9999" width="19998" height="19998" fill={invert ? "white" : "black"} />
                      <g filter={`url(#alpha-lum-filter-${invert ? 'inv' : 'norm'})`} transform={`translate(${dx}, ${dy}) rotate(${maskTarget.rotation}, ${maskTarget.width/2}, ${maskTarget.height/2})`}>
                        {maskTarget.type === 'shape' && maskTarget.shapeType !== 'triangle' && maskTarget.shapeType !== 'star' && (
                          <rect width={maskTarget.width} height={maskTarget.height} rx={maskTarget.borderRadius||0} fill={maskTarget.fill} fillOpacity={maskTarget.opacity} />
                        )}
                        {maskTarget.type === 'path' && maskTarget.pathData && (
                          <path d={maskTarget.pathData} fill={maskTarget.fill || 'none'} stroke={maskTarget.strokeColor || 'transparent'} strokeWidth={maskTarget.strokeWidth||4} opacity={maskTarget.opacity} />
                        )}
                        {maskTarget.type === 'text' && (
                          <text x="0" y={maskTarget.height/2} fill={maskTarget.color} fontSize={maskTarget.fontSize} fontFamily={maskTarget.fontFamily} fontWeight={maskTarget.fontWeight} dominantBaseline="middle" opacity={maskTarget.opacity}>{maskTarget.content}</text>
                        )}
                        {maskTarget.type === 'image' && maskTarget.src && (
                          <image href={maskTarget.src} width={maskTarget.width} height={maskTarget.height} preserveAspectRatio={maskTarget.objectFit === 'cover' ? 'xMidYMid slice' : maskTarget.objectFit === 'fill' ? 'none' : 'xMidYMid meet'} opacity={maskTarget.opacity} />
                        )}
                        {/* complex shapes */}
                        {maskTarget.type === 'shape' && maskTarget.shapeType === 'triangle' && <polygon points={`${maskTarget.width/2},0 0,${maskTarget.height} ${maskTarget.width},${maskTarget.height}`} fill={maskTarget.fill} opacity={maskTarget.opacity} />}
                        {maskTarget.type === 'shape' && maskTarget.shapeType === 'star' && <polygon points={`${maskTarget.width/2},0 ${maskTarget.width*0.61},${maskTarget.height*0.35} ${maskTarget.width*0.98},${maskTarget.height*0.35} ${maskTarget.width*0.68},${maskTarget.height*0.57} ${maskTarget.width*0.79},${maskTarget.height*0.91} ${maskTarget.width/2},${maskTarget.height*0.7} ${maskTarget.width*0.21},${maskTarget.height*0.91} ${maskTarget.width*0.32},${maskTarget.height*0.57} ${maskTarget.width*0.02},${maskTarget.height*0.35} ${maskTarget.width*0.39},${maskTarget.height*0.35}`} fill={maskTarget.fill} opacity={maskTarget.opacity} />}
                      </g>
                    </mask>
                  );
                })}

                <filter id="alpha-lum-filter-norm">
                  <feColorMatrix type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1" />
                </filter>
                <filter id="alpha-lum-filter-inv">
                  <feColorMatrix type="matrix" values="0 0 0 -1 1  0 0 0 -1 1  0 0 0 -1 1  0 0 0 0 1" />
                </filter>
              </defs>
            </svg>

            {/* drawing preview */}
            {isDrawing && currentPath.length>0 && (
              <svg className="absolute inset-0 pointer-events-none w-full h-full" style={{overflow:'visible'}}>
                {activeTool === 'pencil' ? (
                  <path d={`M ${currentPath.map(p=>`${p.x} ${p.y}`).join(' L ')}`} fill="none" stroke="#3b82f6" strokeWidth="3" strokeDasharray="5 3"/>
                ) : activeTool === 'curvature' ? (
                  <path d={solveSpline([...currentPath, previewPoint].filter(Boolean) as {x:number,y:number}[])} fill="none" stroke="#3b82f6" strokeWidth="3" strokeDasharray="5 3"/>
                ) : null}
                {activeTool === 'curvature' && currentPath.map((p,i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={4} fill="#3b82f6" />
                ))}
              </svg>
            )}

            {/* Ghost rendering of previous keyframe */}
            {prevKfTime !== null && (
               <div className="absolute inset-0 pointer-events-none" style={{ opacity: 0.2 }}>
                 {renderElements(activeWidget.elements, activeWidget.width, activeWidget.height, false, prevKfTime, true)}
               </div>
            )}

            {renderElements(activeWidget.elements, activeWidget.width, activeWidget.height)}

            {/* ── Rotation handles for selected element ── */}
            {selected && !selected.locked && !isDrawing && (() => {
              const el = selected;
              // Simpler: just position with CSS transform from the center
              return (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: el.x, top: el.y,
                    width: el.width, height: el.height,
                    transform: `rotate(${el.rotation || 0}deg)`,
                    transformOrigin: 'center center',
                  }}
                >
                  {/* Stem line */}
                  <div className="absolute left-1/2 -translate-x-px" style={{ bottom: '100%', width: 2, height: 24, background: 'rgba(45,212,191,0.5)' }} />
                  {/* Rotation grab circle */}
                  <div
                    className="absolute left-1/2 -translate-x-1/2 pointer-events-auto cursor-grab active:cursor-grabbing"
                    style={{ bottom: 'calc(100% + 18px)', width: 16, height: 16, borderRadius: '50%', background: 'rgb(45,212,191)', border: '2px solid white', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setRotatingId(el.id);
                      const rect = canvasRef.current?.getBoundingClientRect();
                      if (!rect) return;
                      const elCx = rect.left + (el.x + el.width / 2) * scale;
                      const elCy = rect.top + (el.y + el.height / 2) * scale;

                      const onMove = (ev: MouseEvent) => {
                        const dx = ev.clientX - elCx;
                        const dy = ev.clientY - elCy;
                        let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
                        // Snap to 15° increments when holding Shift
                        if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
                        // Normalize to -360..360
                        angle = Math.round(angle * 10) / 10;
                        updateEl(el.id, { rotation: angle });
                      };
                      const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        document.body.style.cursor = '';
                        setRotatingId(null);
                      };
                      document.body.style.cursor = 'grabbing';
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                    }}
                  >
                    <RotateCw size={8} className="text-white absolute inset-0 m-auto" />
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* Timeline toggle bar */}
        <div className="flex items-center justify-center py-1.5 shrink-0 bg-[#0A0A0D] border-t border-white/5">
          <button onClick={() => setShowTimeline(v => !v)}
            className={cn("px-4 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-all shadow-sm border",
              showTimeline
                ? "bg-amber-500/20 text-amber-300 border-amber-500/30 hover:bg-amber-500/30"
                : "bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/80"
            )}>
            <span className="flex items-center gap-1.5"><Zap size={12} />Timeline</span>
          </button>
        </div>

        {/* ── Timeline Panel ── */}
        <AnimatePresence>
          {showTimeline && (
            <motion.div
              initial={{height: 0, opacity: 0}}
              animate={{height: 'auto', opacity: 1}}
              exit={{height: 0, opacity: 0}}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="border-t border-amber-500/20 bg-[#0A0A0D] shrink-0 overflow-hidden z-20"
            >
              {/* Transport controls & time display */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
                <button onClick={stopAnimation} className="p-1.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors" title="Stop">
                  <SkipBack size={14} />
                </button>
                <button onClick={isPlaying ? pauseAnimation : playAnimation}
                  className={cn("p-2 rounded-lg transition-all", isPlaying ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30" : "bg-white/10 text-white hover:bg-white/15")}
                  title={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button onClick={() => setCurrentTime(timeline.duration)} className="p-1.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors" title="Skip to End">
                  <SkipForward size={14} />
                </button>
                <button onClick={() => setTimelineProp({ loop: !timeline.loop })}
                  className={cn("p-1.5 rounded-md transition-colors", timeline.loop ? "bg-amber-500/20 text-amber-300" : "text-white/30 hover:text-white/60 hover:bg-white/5")}
                  title="Loop">
                  <Repeat size={14} />
                </button>

                <div className="flex items-center gap-1.5 px-3 py-1 bg-white/5 rounded-lg ml-2">
                  <span className="text-[11px] font-mono text-amber-300 w-12 text-right">{currentTime.toFixed(2)}s</span>
                  <span className="text-[10px] text-white/20">/</span>
                  <span className="text-[11px] font-mono text-white/40 w-10">{timeline.duration.toFixed(1)}s</span>
                </div>

                <div className="flex items-center gap-1.5 ml-auto text-[10px]">
                  <span className="text-white/30 uppercase tracking-wider">Duration</span>
                  <input type="number" min={0.5} max={120} step={0.5}
                    value={timeline.duration}
                    onChange={e => setTimelineProp({ duration: Math.max(0.5, +e.target.value) })}
                    className="w-14 bg-white/5 rounded px-1.5 py-1 text-xs text-white border border-white/10 outline-none text-center"
                  />
                  <span className="text-white/30 uppercase tracking-wider ml-2">Speed</span>
                  <select value={timeline.speed} onChange={e => setTimelineProp({ speed: +e.target.value })}
                    className="bg-white/5 rounded px-1.5 py-1 text-xs text-white border border-white/10 outline-none">
                    <option value={0.25}>0.25×</option>
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={1.5}>1.5×</option>
                    <option value={2}>2×</option>
                  </select>
                  <label className="flex items-center gap-1 ml-2 cursor-pointer">
                    <input type="checkbox" checked={timeline.autoplay} onChange={e => setTimelineProp({ autoplay: e.target.checked })}
                      className="accent-amber-500 w-3 h-3" />
                    <span className="text-white/40">Autoplay</span>
                  </label>
                </div>
              </div>

              {/* Scrubber + Tracks */}
              <div className="relative" style={{ minHeight: 100 }}>
                {/* Time ruler */}
                <div className="h-6 bg-[#0D0D10] border-b border-white/5 relative overflow-hidden cursor-pointer pl-28"
                  onMouseDown={e => {
                    const rulerEl = e.currentTarget;
                    setIsScrubbing(true);
                    const scrub = (ev: MouseEvent) => {
                      const rect = rulerEl.getBoundingClientRect();
                      const x = ev.clientX - rect.left;
                      setCurrentTime(Math.max(0, Math.min(timeline.duration, (x / rect.width) * timeline.duration)));
                    };
                    scrub(e.nativeEvent);
                    const onMove = (ev: MouseEvent) => scrub(ev);
                    const onUp = () => { setIsScrubbing(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }}
                >
                  {/* Time markers */}
                  {Array.from({ length: Math.ceil(timeline.duration * 2) + 1 }, (_, i) => i * 0.5).map(t => (
                    <div key={t} className="absolute top-0 h-full flex flex-col items-center"
                      style={{ left: `${(t / timeline.duration) * 100}%` }}>
                      <div className={cn("w-px h-full", Number.isInteger(t) ? "bg-white/15" : "bg-white/5")} />
                      {Number.isInteger(t) && (
                        <span className="absolute top-0.5 text-[8px] text-white/25 font-mono -translate-x-1/2">{t}s</span>
                      )}
                    </div>
                  ))}
                  {/* Playhead */}
                  <div className="absolute top-0 h-full w-0.5 bg-amber-400 z-10 pointer-events-none"
                    style={{ left: `${(currentTime / timeline.duration) * 100}%` }}>
                    <div className="absolute -top-0 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-amber-400 rotate-45 rounded-sm shadow-lg" />
                  </div>
                </div>

                {/* Unified keyframe track (Standard mode) */}
                <div className="overflow-y-auto max-h-40">
                  {/* Single scene track */}
                  <div className="flex items-center h-10 border-b border-white/[0.03] bg-amber-500/[0.03]">
                    <div className="w-28 px-3 text-[10px] truncate shrink-0 h-full flex items-center gap-1.5 border-r border-white/5 text-amber-300 font-medium">
                      <Diamond size={8} className={timeline.keyframes.length > 0 ? "text-amber-400" : "text-white/15"} />
                      Scene
                    </div>
                    <div className="flex-1 relative h-full cursor-pointer"
                      onDoubleClick={e => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = e.clientX - rect.left;
                        const time = Math.max(0, Math.min(timeline.duration, (x / rect.width) * timeline.duration));
                        setCurrentTime(time);
                        addGlobalKeyframe(time);
                      }}
                    >
                      {/* Keyframe diamonds (draggable) */}
                      {[...timeline.keyframes].sort((a,b) => a.time - b.time).map(kf => (
                        <div key={kf.id}
                          className={cn("absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rotate-45 rounded-[2px] cursor-grab transition-colors border z-10",
                            selectedKeyframeId === kf.id
                              ? "bg-amber-400 border-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.5)] scale-125"
                              : "bg-amber-500/60 border-amber-500/40 hover:bg-amber-400 hover:scale-110"
                          )}
                          style={{ left: `${(kf.time / timeline.duration) * 100}%` }}
                          title={`${kf.time.toFixed(2)}s \u2014 ${kf.easing} \u2014 ${Object.keys(kf.elementStates).length} elements`}
                          onMouseDown={e => {
                            e.stopPropagation();
                            e.preventDefault();
                            setSelectedKeyframeId(kf.id);
                            setCurrentTime(kf.time);
                            const trackEl = e.currentTarget.parentElement!;
                            const startX = e.clientX;
                            let dragged = false;
                            const onMove = (ev: MouseEvent) => {
                              if (!dragged && Math.abs(ev.clientX - startX) < 3) return;
                              dragged = true;
                              document.body.style.cursor = 'grabbing';
                              const rect = trackEl.getBoundingClientRect();
                              const x = ev.clientX - rect.left;
                              const newTime = Math.round(Math.max(0, Math.min(timeline.duration, (x / rect.width) * timeline.duration)) * 100) / 100;
                              updateGlobalKeyframeTime(kf.id, newTime);
                              setCurrentTime(newTime);
                            };
                            const onUp = () => {
                              document.body.style.cursor = '';
                              window.removeEventListener('mousemove', onMove);
                              window.removeEventListener('mouseup', onUp);
                            };
                            window.addEventListener('mousemove', onMove);
                            window.addEventListener('mouseup', onUp);
                          }}
                        />
                      ))}
                      {/* Connection lines between keyframes */}
                      {timeline.keyframes.length > 1 && (() => {
                        const sorted = [...timeline.keyframes].sort((a,b) => a.time - b.time);
                        return sorted.slice(0, -1).map((kf, i) => {
                          const next = sorted[i + 1];
                          const left = (kf.time / timeline.duration) * 100;
                          const width = ((next.time - kf.time) / timeline.duration) * 100;
                          return (
                            <div key={`conn-${kf.id}`} className="absolute top-1/2 h-0.5 bg-gradient-to-r from-amber-500/30 to-amber-500/30 -translate-y-[0.5px]"
                              style={{ left: `${left}%`, width: `${width}%` }} />
                          );
                        });
                      })()}
                      {/* Current time indicator line */}
                      <div className="absolute top-0 h-full w-px bg-amber-400/40 pointer-events-none"
                        style={{ left: `${(currentTime / timeline.duration) * 100}%` }} />
                    </div>
                  </div>
                  {/* Hint text if no keyframes */}
                  {timeline.keyframes.length === 0 && (
                    <div className="text-center text-[10px] text-white/20 py-3">
                      Double-click the track or press <kbd className="px-1 py-0.5 bg-white/10 rounded text-[9px] font-mono">K</kbd> to add a keyframe
                    </div>
                  )}
                </div>

                {/* Selected keyframe info bar */}
                {selectedKeyframeId && (() => {
                  const selKf = timeline.keyframes.find(k => k.id === selectedKeyframeId);
                  if (!selKf) return null;
                  const numElements = Object.keys(selKf.elementStates).length;
                  return (
                    <div className="flex items-center gap-3 px-4 py-2 bg-[#111114] border-t border-white/5">
                      <Diamond size={10} className="text-amber-400" />
                      <span className="text-[10px] text-white/50 font-medium">{numElements} elements captured</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-white/30">Time:</span>
                        <input type="number" min={0} max={timeline.duration} step={0.05}
                          value={selKf.time}
                          onChange={e => updateGlobalKeyframeTime(selKf.id, +e.target.value)}
                          className="w-14 bg-white/5 rounded px-1.5 py-0.5 text-[10px] text-white border border-white/10 outline-none text-center"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-white/30">Easing:</span>
                        <select value={selKf.easing}
                          onChange={e => updateGlobalKeyframeEasing(selKf.id, e.target.value as EasingType)}
                          className="bg-white/5 rounded px-1.5 py-0.5 text-[10px] text-white border border-white/10 outline-none">
                          {(['linear','ease-in','ease-out','ease-in-out','bounce','elastic'] as EasingType[]).map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </select>
                      </div>
                      <button onClick={() => deleteGlobalKeyframe(selKf.id)}
                        className="ml-auto p-1 rounded hover:bg-red-500/20 text-red-400/60 hover:text-red-400 transition-colors"
                        title="Delete Keyframe">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })()}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* ── Right: Layers + Properties ── */}
      <div className="w-80 bg-[#0E0E11] border-l border-white/5 flex flex-col shrink-0 z-40 shadow-[-10px_0_30px_rgba(0,0,0,0.5)]">
        <div className="flex border-b border-white/5 p-1 gap-1">
          {(['layers','properties'] as const).map(t=>(
            <button key={t} onClick={()=>setActiveTab(t)} className={cn("flex-1 py-2 text-[11px] font-bold uppercase tracking-widest transition-all rounded-lg",activeTab===t?"bg-white/10 text-white shadow-sm":"text-white/40 hover:text-white/80 hover:bg-white/5")}>{t}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:transparent">
          {activeTab==='layers'
            ? <LayersPanel elements={activeWidget.elements} selectedId={selectedId}
                onSelect={id=>setSelectedPath([id])} onUpdate={updateEl} onDelete={deleteEl}
                expandedGroups={expandedGroups} setExpandedGroups={setExpandedGroups}
                draggingId={draggingId} setDraggingId={setDraggingId}
                dragOverTarget={dragOverTarget} setDragOverTarget={setDragOverTarget}
                moveLayer={moveLayer} removeFromGroup={removeFromGroup}
              />
            : <PropertiesPanel selected={selected} allElements={allElements} onUpdate={updateEl} onDelete={deleteEl}
                onDuplicate={(id: string)=>{
                  const el=findElement(activeWidget.elements,id);
                  if(el) addEl({...el,id:uuidv4(),name:el.name+' copy',x:el.x+20,y:el.y+20});
                }}
                showTimeline={showTimeline}
                currentTime={currentTime}
                timeline={timeline}
                onAddGlobalKeyframe={addGlobalKeyframe}
                onDeleteGlobalKeyframe={deleteGlobalKeyframe}
                onUpdateGlobalKeyframeEasing={updateGlobalKeyframeEasing}
              />
          }
        </div>
      </div>

      {/* Load modal */}
      {showLoadModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <h2 className="font-bold">Load Workspace</h2>
              <button onClick={()=>setShowLoadModal(false)} className="text-white/40 hover:text-white"><X size={16}/></button>
            </div>
            <div className="p-4 max-h-72 overflow-y-auto space-y-2 empty:py-8">
              {workspaceList.length===0
                ? <p className="text-center text-white/30 text-sm py-8">No saved workspaces.</p>
                : workspaceList.map(w=>(
                  <button key={w.id} onClick={async()=>{const d=await getWorkspace(w.id);if(d){setWorkspace(d.config);setActiveWidgetId(d.config.widgets[0]?.id??'');setShowLoadModal(false);}}}
                    className="w-full text-left p-3 rounded-xl bg-white/5 hover:bg-white/10 text-sm flex justify-between">
                    <span className="font-medium">{w.name}</span>
                    <span className="text-white/20 text-xs">{w.id.slice(0,8)}</span>
                  </button>
                ))
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layers Panel — custom mouse-based drag (HTML5 D&D breaks in Tauri WebView2)
// ---------------------------------------------------------------------------
function LayersPanel({ elements, selectedId, onSelect, onUpdate, onDelete, expandedGroups, setExpandedGroups, draggingId, setDraggingId, dragOverTarget, setDragOverTarget, moveLayer, removeFromGroup }: any) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Mouse-based drag helpers ──────────────────────────────────────────
  const DRAG_THRESHOLD = 5; // pixels — must move this far before drag activates

  const startDrag = useCallback((elId: string, startEvent: React.MouseEvent) => {
    startEvent.preventDefault();
    startEvent.stopPropagation();

    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    let activated = false;

    const computeDropTarget = (e: MouseEvent) => {
      const els = document.elementsFromPoint(e.clientX, e.clientY);
      
      const maskSpot = els.find(el => el.getAttribute('data-mask-spot') && el.getAttribute('data-mask-spot') !== elId);
      if (maskSpot) {
        return { id: maskSpot.getAttribute('data-mask-spot')!, position: 'mask-spot' as const };
      }

      const row = els.find(el => el.getAttribute('data-layer-id') && el.getAttribute('data-layer-id') !== elId) as HTMLElement | undefined;
      if (!row) return null;

      const targetId = row.getAttribute('data-layer-id')!;
      const isGroup = row.getAttribute('data-layer-group') === 'true';
      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const h = rect.height;

      let pos: 'before'|'after'|'inside' = 'after';
      if (isGroup) {
        if (y < h * 0.25) pos = 'before';
        else if (y > h * 0.75) pos = 'after';
        else pos = 'inside';
      } else {
        pos = y < h * 0.5 ? 'before' : 'after';
      }
      return { id: targetId, position: pos };
    };

    const onMove = (e: MouseEvent) => {
      // Only activate after moving past the threshold
      if (!activated) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        activated = true;
        setDraggingId(elId);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      setDragOverTarget(computeDropTarget(e));
    };

    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (activated) {
        const target = computeDropTarget(e);
        if (target) {
          if (target.position === 'mask-spot') {
             onUpdate(target.id, { maskWithLayerId: elId });
          } else {
             moveLayer(elId, target.id, target.position);
          }
        }
      }

      setDraggingId(null);
      setDragOverTarget(null);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [setDraggingId, setDragOverTarget, moveLayer]);

  const renderLayer = (el: OverlayElement, depth = 0, parentGroupId?: string) => {
    const isGroup = el.type === 'group' || el.type === 'mask';
    const expanded = expandedGroups.has(el.id);
    const dropPosition = dragOverTarget?.id === el.id ? dragOverTarget.position : null;
    const isDragged = draggingId === el.id;

    return (
      <div key={el.id} style={{marginLeft: depth>0?12:0}}>
        <div
          data-layer-id={el.id}
          data-layer-group={isGroup ? 'true' : 'false'}
          className={cn("flex items-center gap-1.5 px-3 py-2.5 rounded-xl cursor-pointer border transition-all relative select-none",
            selectedId===el.id?"bg-blue-500/15 border-blue-500/30 shadow-sm":"border-transparent hover:bg-white/5 hover:border-white/5",
            dropPosition==='inside'?"bg-purple-500/20 border-purple-400/40 border-dashed":"",
            isDragged?"opacity-40":""
          )}
          onClick={(e)=>{e.stopPropagation();onSelect(el.id);}}
        >
          {dropPosition==='before' && <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-400 -translate-y-px z-10 pointer-events-none" />}
          {dropPosition==='after' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400 translate-y-px z-10 pointer-events-none" />}

          {/* Drag handle — mousedown starts the custom drag */}
          <div
            className="shrink-0 cursor-grab active:cursor-grabbing p-0.5 -m-0.5"
            onMouseDown={(e) => startDrag(el.id, e)}
          >
            {isGroup
              ? <button onClick={e=>{e.stopPropagation();setExpandedGroups((s:Set<string>)=>{const n=new Set(s);expanded?n.delete(el.id):n.add(el.id);return n;});}} className="text-white/30 hover:text-white shrink-0 pointer-events-auto"
                  onMouseDown={e => e.stopPropagation() /* let click toggle, not drag */}
                >
                  {expanded?<ChevronDown size={11}/>:<ChevronRight size={11}/>}
                </button>
              : <GripVertical size={10} className="text-white/15"/>
            }
          </div>

          <LayerIcon type={el.type} />
          <span className={cn("text-xs flex-1 truncate",el.type==='mask'?"text-teal-300":el.type==='group'?"text-purple-300":"")}>{el.name}</span>
          {el.type === 'mask' && <span className="text-[9px] bg-teal-500/20 text-teal-400 px-1 rounded">{el.maskType}</span>}

          <div
            data-mask-spot={el.id}
            className={cn("w-5 h-5 ml-1 rounded flex items-center justify-center shrink-0 transition-all pointer-events-auto",
              dropPosition === 'mask-spot' ? "border-2 border-teal-400 bg-teal-500/30 text-teal-300 scale-110" :
              el.maskWithLayerId ? "border border-teal-500/50 bg-teal-500/20 text-teal-300" :
              isDragged ? "opacity-0" : "border border-dashed border-white/20 text-white/20 hover:border-teal-500/50 hover:text-teal-400 hover:bg-teal-500/10"
            )}
            title={el.maskWithLayerId ? "Masked. Click to remove." : "Drag a layer here to mask"}
            onClick={(ev) => {
              ev.stopPropagation();
              if (el.maskWithLayerId) onUpdate(el.id, { maskWithLayerId: undefined });
            }}
          >
            {el.maskWithLayerId || dropPosition === 'mask-spot' ? <Blend size={10} /> : <div className="w-1.5 h-1.5 rounded-full bg-current pointer-events-none" />}
          </div>

          <div className="flex gap-0.5 shrink-0" onClick={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()}>
            <button onClick={()=>onUpdate(el.id,{visible:!el.visible})} className="p-0.5 text-white/25 hover:text-white">
              {el.visible?<Eye size={11}/>:<EyeOff size={11} className="text-red-400"/>}
            </button>
            <button onClick={()=>onUpdate(el.id,{locked:!el.locked})} className="p-0.5 text-white/25 hover:text-white">
              {el.locked?<Lock size={11} className="text-orange-400"/>:<Unlock size={11}/>}
            </button>
            {parentGroupId && <button onClick={()=>removeFromGroup(el.id,parentGroupId)} title="Remove from group" className="p-0.5 text-white/20 hover:text-orange-400"><X size={11}/></button>}
            <button onClick={()=>onDelete(el.id)} className="p-0.5 text-white/20 hover:text-red-400"><Trash2 size={11}/></button>
          </div>
        </div>
        {isGroup && expanded && (
          <div className="ml-3 mt-0.5 border-l border-purple-500/15 pl-1.5 space-y-0.5 relative">
            {dropPosition==='inside' && <div className="absolute inset-0 bg-purple-500/10 pointer-events-none z-10 rounded border border-purple-500/20 border-dashed"/>}
            {(el.children??[]).slice().sort((a:OverlayElement,b:OverlayElement)=>b.zIndex-a.zIndex).map((c:OverlayElement)=>renderLayer(c,depth+1,el.id))}
            {(el.children??[]).length===0&&<div className="text-[10px] text-white/20 py-1.5 px-2 pointer-events-none">{el.type==='mask'?'Drag elements here to mask them':'Empty group'}</div>}
          </div>
        )}
      </div>
    );
  };

  const sorted = [...elements].sort((a,b)=>b.zIndex-a.zIndex);
  return (
    <div ref={containerRef} className="p-3 space-y-1">
      {sorted.map(el=>renderLayer(el))}
      {elements.length===0&&<div className="text-center text-white/20 py-12 text-xs font-medium">No elements. Add from the toolbar.</div>}
    </div>
  );
}

function LayerIcon({ type }: { type: ElementType; }) {
  if (type==='mask') return <Blend size={12} className="text-teal-400 shrink-0"/>;
  if (type==='group') return <Layers size={12} className="text-purple-400 shrink-0"/>;
  if (type==='text') return <Type size={12} className="text-white/40 shrink-0"/>;
  if (type==='shape') return <Square size={12} className="text-white/40 shrink-0"/>;
  if (type==='image') return <ImageIcon size={12} className="text-white/40 shrink-0"/>;
  if (type==='path') return <PenTool size={12} className="text-white/40 shrink-0"/>;
  return null;
}

// ---------------------------------------------------------------------------
// Properties Panel
// ---------------------------------------------------------------------------
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v:string)=>void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef  = useRef<HTMLButtonElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  const { hex, alpha } = parseColor(value || '#ffffff');
  const display = buildColor(hex, alpha);

  // Close on outside click. Capture phase fires before any element handler.
  // One-frame delay so the button's open-click doesn't immediately fire this.
  useEffect(() => {
    if (!open) return;
    let rafId: number;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pickRef.current?.contains(t)) return; // inside picker — keep open
      if (btnRef.current?.contains(t)) return;  // button — toggle handles it
      setOpen(false);
    };
    rafId = requestAnimationFrame(() => {
      window.addEventListener('mousedown', handler, true);
    });
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousedown', handler, true);
    };
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({
        top:  Math.max(8, Math.min(r.top - 20, window.innerHeight - 520)),
        left: Math.max(8, r.left - 278),
      });
    }
    setOpen(v => !v);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-white/50 shrink-0 min-w-[48px]">{label}</span>
      <div className="flex items-center gap-2">
        <button ref={btnRef} onClick={handleOpen}
          className="w-8 h-8 rounded-lg border border-white/10 overflow-hidden relative shrink-0 shadow-sm hover:border-white/30 transition-colors">
          <div className="absolute inset-0" style={{background:'repeating-conic-gradient(#555 0% 25%,#222 0% 50%) 0 0/8px 8px'}}/>
          <div className="absolute inset-0 rounded-lg" style={{background:display}}/>
        </button>
        <span className="text-[10px] font-mono text-white/40 truncate max-w-[80px]">
          {value?.startsWith('rgba') ? value.slice(0,14)+'…' : value}
        </span>
      </div>
      {open && createPortal(
        <div ref={pickRef} className="fixed z-[9999]" style={{ top: pos.top, left: pos.left }}>
          <ColorPicker value={value||'#ffffff'} onChange={onChange} onClose={() => setOpen(false)} />
        </div>,
        document.body
      )}
    </div>
  );
}


function Sec({title,children}:{title:string;children:React.ReactNode}) {
  return (
    <div className="px-5 py-4 border-b border-white/5 space-y-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-white/40">{title}</h3>
      {children}
    </div>
  );
}

function Row({label,children}:{label:string;children:React.ReactNode}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-white/50 shrink-0 min-w-[48px]">{label}</span>
      <div className="flex-1 flex justify-end">{children}</div>
    </div>
  );
}

function Num({el,set,k,label,min,max,step=1}:{el:any;set:(up:any)=>void;k:string;label:string;min?:number;max?:number;step?:number}) {
  return (
    <Row label={label}>
      <DimInput
        value={el[k] ?? 0}
        min={min ?? -99999} max={max ?? 99999}
        onCommit={v => set({[k]: v})}
      />
    </Row>
  );
}

function PropertiesPanel({ selected, allElements, onUpdate, onDelete, onDuplicate, showTimeline, currentTime, timeline, onAddGlobalKeyframe, onDeleteGlobalKeyframe, onUpdateGlobalKeyframeEasing }: any) {
  if (!selected) return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-2 opacity-20 p-6">
      <Settings size={32}/><p className="text-xs">Select an element</p>
    </div>
  );
  const el: OverlayElement = selected;
  const set = (up: Partial<OverlayElement>) => onUpdate(el.id, up);

  return (
    <div>
      <Sec title="Element">
        <Row label="Name">
          <LiveText syncKey={el.id} value={el.name} onChange={v=>set({name:v})}
            className="flex-1 bg-[#222] rounded px-2 py-1 text-xs border-none outline-none"/>
        </Row>
        <div className="flex gap-1.5">
          <button onClick={()=>set({visible:!el.visible})} className={cn("flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1",el.visible?"bg-white/10":"bg-red-500/20 text-red-400")}>
            {el.visible?<Eye size={12}/>:<EyeOff size={12}/>}{el.visible?'Visible':'Hidden'}
          </button>
          <button onClick={()=>set({locked:!el.locked})} className={cn("flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1",el.locked?"bg-orange-500/20 text-orange-400":"bg-white/10")}>
            {el.locked?<Lock size={12}/>:<Unlock size={12}/>}{el.locked?'Locked':'Unlocked'}
          </button>
        </div>
      </Sec>

      <Sec title="Transform">
        <div className="grid grid-cols-2 gap-2">
          {([['x','X'],['y','Y'],['width','W'],['height','H']] as [keyof OverlayElement,string][]).map(([k,l])=>(
            <div key={k as string}><Row label={l}>
              <DimInput value={(el as any)[k]??0} min={-9999} max={99999} onCommit={v=>set({[k]:v})}/>
            </Row></div>
          ))}
        </div>
        <Row label="Rotate°">
          <div className="flex items-center gap-2 flex-1">
            <input type="range" min={-180} max={180} step={1} value={el.rotation||0}
              onChange={e=>set({rotation:+e.target.value})} className="flex-1 accent-teal-500"/>
            <DimInput value={el.rotation||0} min={-360} max={360} onCommit={v=>set({rotation:v})}/>
          </div>
        </Row>
        <Row label="Opacity">
          <div className="flex items-center gap-2 flex-1">
            <input type="range" min={0} max={1} step={0.01} value={el.opacity}
              onChange={e=>set({opacity:+e.target.value})} className="flex-1 accent-blue-500"/>
            <span className="text-[10px] text-white/40 w-8 text-right">{Math.round(el.opacity*100)}%</span>
          </div>
        </Row>
        <Row label="Blend">
          <select value={el.blendMode??'normal'} onChange={e=>set({blendMode:e.target.value as BlendMode})}
            className="bg-[#222] rounded px-2 py-1 text-xs border-none outline-none">
            {['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity'].map(m=><option key={m} value={m}>{m}</option>)}
          </select>
        </Row>
        <Row label="Explicit Mask">
          <select value={el.maskWithLayerId??''} onChange={e=>set({maskWithLayerId:e.target.value||undefined})}
            className="bg-[#222] rounded px-2 py-1 text-[10px] border-none outline-none overflow-hidden max-w-[120px]">
            <option value="">None</option>
            {allElements.filter((m: OverlayElement) => m.id !== el.id).map((m: OverlayElement) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Row>
        {el.maskWithLayerId && (
          <Row label="Invert Mask">
            <button onClick={()=>set({maskInvert:!el.maskInvert})} className={cn("px-2 py-1 rounded text-[10px] flex-1", el.maskInvert ? "bg-teal-500/20 text-teal-400" : "bg-white/10 text-white/60 hover:bg-white/20")}>
              {el.maskInvert ? 'Inverted' : 'Normal'}
            </button>
          </Row>
        )}
      </Sec>

      {/* Group & Mask settings */}
      {el.type === 'group' && (
        <Sec title="Layer Group">
          <p className="text-[10px] text-white/30 mt-1">Groups isolate their children. Blend modes apply only inside.</p>
        </Sec>
      )}

      {el.type === 'mask' && (
        <Sec title="Mask Properties">
          <Row label="Mask Type">
            <select value={el.maskType??'clip'} onChange={e=>set({maskType:e.target.value as MaskType})}
              className="bg-[#222] rounded px-2 py-1 text-xs border-none outline-none">
              <option value="clip">Clip (Shape)</option>
              <option value="gradient">Gradient (Fade)</option>
              <option value="opacity">Opacity (Alpha)</option>
              <option value="image">Image Mask</option>
            </select>
          </Row>
          
          <div className="flex gap-1.5 mt-2 mb-1">
            <button onClick={()=>set({maskInvert:!el.maskInvert})} className={cn("flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1",el.maskInvert?"bg-teal-500/20 text-teal-400 border border-teal-500/30":"bg-white/5 border border-white/10 hover:bg-white/10 text-white/60 hover:text-white")}>
              Invert: {el.maskInvert ? 'Yes' : 'No'}
            </button>
          </div>

          {el.maskType==='clip'&&<Num el={el} set={set} k="clipRadius" label="Radius" min={0} max={400}/>}
          {el.maskType==='gradient'&&(<>
            <Row label="Direction">
              <select value={el.gradientDir??'to bottom'} onChange={e=>set({gradientDir:e.target.value as GradientDir})}
                className="bg-[#222] rounded px-2 py-1 text-xs border-none outline-none">
                {(['to right','to left','to bottom','to top','to bottom right','radial'] as GradientDir[]).map(d=><option key={d} value={d}>{d}</option>)}
              </select>
            </Row>
            <Row label="Start α">
              <div className="flex items-center gap-2 flex-1">
                <input type="range" min={0} max={1} step={0.01} value={el.gradientStartOpacity??1} onChange={e=>set({gradientStartOpacity:+e.target.value})} className="flex-1 accent-teal-500"/>
                <span className="text-[10px] w-7 text-right text-white/40">{Math.round((el.gradientStartOpacity??1)*100)}%</span>
              </div>
            </Row>
            <Row label="End α">
              <div className="flex items-center gap-2 flex-1">
                <input type="range" min={0} max={1} step={0.01} value={el.gradientEndOpacity??0} onChange={e=>set({gradientEndOpacity:+e.target.value})} className="flex-1 accent-teal-500"/>
                <span className="text-[10px] w-7 text-right text-white/40">{Math.round((el.gradientEndOpacity??0)*100)}%</span>
              </div>
            </Row>
          </>)}
          {el.maskType==='image'&&(
            <Row label="Img URL">
              <LiveText syncKey={el.id} value={el.maskImageSrc||''} onChange={v=>set({maskImageSrc:v})}
                placeholder="https://… or blob:…"
                className="flex-1 w-full bg-[#222] rounded px-2 py-1 text-[10px] font-mono border-none outline-none overflow-hidden truncate max-w-[120px]"/>
            </Row>
          )}
          <p className="text-[10px] text-white/30 leading-snug">Drag elements inside this component to mask them by its area/settings.</p>
        </Sec>
      )}

      {/* Shape */}
      {el.type==='shape'&&(
        <Sec title="Shape">
          <ColorField label="Fill" value={el.fill??'#3b82f6'} onChange={v=>set({fill:v})}/>
          <Num el={el} set={set} k="borderRadius" label="Radius" min={0} max={400}/>
          <ColorField label="Stroke" value={el.strokeColor??'transparent'} onChange={v=>set({strokeColor:v})}/>
          <Num el={el} set={set} k="strokeWidth" label="Stroke W" min={0} max={50}/>
        </Sec>
      )}

      {/* Path */}
      {el.type==='path'&&(
        <Sec title="Path">
          <ColorField label="Fill" value={el.fill??'none'} onChange={v=>set({fill:v})}/>
          <ColorField label="Stroke" value={el.strokeColor??'#3b82f6'} onChange={v=>set({strokeColor:v})}/>
          <Num el={el} set={set} k="strokeWidth" label="Stroke W" min={0} max={50}/>
        </Sec>
      )}

      {/* Text */}
      {el.type==='text'&&(
        <Sec title="Text">
          <LiveTextArea syncKey={el.id} value={el.content??''} onChange={v=>set({content:v})}
            className="w-full bg-[#222] rounded p-2 text-xs h-14 border-none outline-none resize-none"/>
          <ColorField label="Color" value={el.color??'#ffffff'} onChange={v=>set({color:v})}/>
          <Num el={el} set={set} k="fontSize" label="Size" min={6} max={500}/>
          <Row label="Weight">
            <select value={el.fontWeight??'600'} onChange={e=>set({fontWeight:e.target.value})}
              className="bg-[#222] rounded px-2 py-1 text-xs border-none outline-none">
              {['100','200','300','400','500','600','700','800','900','bold','normal'].map(w=><option key={w} value={w}>{w}</option>)}
            </select>
          </Row>
          <Row label="Align">
            <div className="flex gap-1">
              {(['left','center','right'] as const).map(a=>(
                <button key={a} onClick={()=>set({textAlign:a})}
                  className={cn("px-2 py-0.5 rounded text-xs",el.textAlign===a?"bg-blue-500":"bg-white/10 hover:bg-white/20")}>{a[0].toUpperCase()}</button>
              ))}
            </div>
          </Row>
          <Num el={el} set={set} k="letterSpacing" label="Spacing" min={-5} max={50} step={0.5}/>
        </Sec>
      )}

      {/* Image */}
      {el.type==='image'&&(
        <Sec title="Image">
          <button
            onClick={async () => {
              try {
                const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
                const path = await openDialog({
                  filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','webp','svg','bmp','avif'] }],
                  multiple: false,
                });
                if (path && typeof path === 'string') {
                  // Use plugin-fs to read the file with the temporary permission granted by plugin-dialog
                  const { readFile } = await import('@tauri-apps/plugin-fs');
                  const bytes = await readFile(path);
                  
                  // Convert bytes to base64 (handled smoothly in chunks to prevent Maximum Call Stack Size Exceeded logic)
                  let binary = '';
                  const chunkSize = 8192;
                  for (let i = 0; i < bytes.length; i += chunkSize) {
                    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
                  }
                  const base64 = btoa(binary);
                  
                  // Determine mime type
                  const ext = path.split('.').pop()?.toLowerCase() || 'png';
                  const typeMap: Record<string, string> = { svg: 'svg+xml', png: 'png', webp: 'webp', gif: 'gif', jpg: 'jpeg', jpeg: 'jpeg', bmp: 'bmp', avif: 'avif' };
                  const mime = `image/${typeMap[ext] || 'png'}`;
                  
                  set({ src: `data:${mime};base64,${base64}` });
                }
              } catch(err) { console.error('Image pick error:', err); }
            }}
            className="w-full py-2 rounded-lg bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 text-xs transition-colors flex items-center justify-center gap-1.5">
            <ImageIcon size={12}/>Pick Image File
          </button>
          <Row label="URL">
            <LiveText syncKey={el.id} value={el.src||''} onChange={v=>set({src:v})}
              placeholder="https://…"
              className="flex-1 bg-[#222] rounded px-2 py-1 text-xs border-none outline-none"/>
          </Row>
          <Row label="Fit">
            <select value={el.objectFit||'contain'} onChange={e=>set({objectFit:e.target.value as any})}
              className="bg-[#222] rounded px-2 py-1 text-xs border-none outline-none">
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="fill">Fill</option>
            </select>
          </Row>
        </Sec>
      )}

      <Sec title="Filters">
        {([['blur','Blur',0,30,0.5],['brightness','Bright',0,300,1],['contrast','Contrast',0,300,1],['saturate','Saturate',0,300,1],['hueRotate','Hue Rot',0,360,1]] as [keyof OverlayElement,string,number,number,number][]).map(([k,l,min,max,step])=>(
          <div key={String(k)}><Row label={l}>
            <div className="flex items-center gap-2 flex-1">
              <input type="range" min={min} max={max} step={step} value={(el as any)[k]??( k==='brightness'||k==='contrast'||k==='saturate'?100:0)}
                onChange={e=>set({[k]:+e.target.value})} className="flex-1 accent-blue-500"/>
              <span className="text-[10px] w-8 text-right text-white/40">{(el as any)[k]??( k==='brightness'||k==='contrast'||k==='saturate'?100:0)}</span>
            </div>
          </Row></div>
        ))}
      </Sec>

      {/* Scale */}
      <Sec title="Scale">
        <div className="grid grid-cols-2 gap-2">
          <div><Row label="Scale X">
            <div className="flex items-center gap-2 flex-1">
              <input type="range" min={0.1} max={3} step={0.05} value={el.scaleX??1}
                onChange={e=>set({scaleX:+e.target.value})} className="flex-1 accent-amber-500"/>
              <span className="text-[10px] text-white/40 w-8 text-right">{((el.scaleX??1)*100).toFixed(0)}%</span>
            </div>
          </Row></div>
          <div><Row label="Scale Y">
            <div className="flex items-center gap-2 flex-1">
              <input type="range" min={0.1} max={3} step={0.05} value={el.scaleY??1}
                onChange={e=>set({scaleY:+e.target.value})} className="flex-1 accent-amber-500"/>
              <span className="text-[10px] text-white/40 w-8 text-right">{((el.scaleY??1)*100).toFixed(0)}%</span>
            </div>
          </Row></div>
        </div>
      </Sec>

      {/* Animation */}
      {el.type!=='group'&&(
        <Sec title="Animation">
          <Row label="Effect">
            <select value={el.animationName??'none'} onChange={e=>set({animationName:e.target.value})}
              className="bg-[#222] rounded px-2 py-1 text-xs border-none outline-none">
              {['none','fadeIn','slideInLeft','slideInRight','bounceIn','pulse-slow'].map(a=><option key={a} value={a}>{a}</option>)}
            </select>
          </Row>
          <Num el={el} set={set} k="animationDuration" label="Duration" min={0.1} max={10} step={0.1}/>
          <Num el={el} set={set} k="animationDelay" label="Delay" min={0} max={10} step={0.1}/>
        </Sec>
      )}

      {/* ── Keyframes ── */}
      <Sec title="Keyframes">
        {showTimeline ? (
          <>
            <button
              onClick={() => onAddGlobalKeyframe(currentTime)}
              className="w-full py-2 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 text-xs transition-colors flex items-center justify-center gap-1.5 mb-2">
              <Diamond size={10} /> Add Scene Keyframe at {currentTime.toFixed(2)}s
            </button>
            {timeline.keyframes.length > 0 ? (
              <div className="space-y-1">
                {[...timeline.keyframes].sort((a: GlobalKeyframe, b: GlobalKeyframe) => a.time - b.time).map((kf: GlobalKeyframe) => (
                  <div key={kf.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
                    <Diamond size={8} className="text-amber-400 shrink-0" />
                    <span className="text-[10px] font-mono text-amber-300 w-10">{kf.time.toFixed(2)}s</span>
                    <span className="text-[9px] text-white/20">{Object.keys(kf.elementStates).length} els</span>
                    <select value={kf.easing}
                      onChange={e => onUpdateGlobalKeyframeEasing(kf.id, e.target.value)}
                      className="bg-[#222] rounded px-1 py-0.5 text-[9px] border-none outline-none flex-1 text-white/60">
                      {(['linear','ease-in','ease-out','ease-in-out','bounce','elastic'] as EasingType[]).map(e => (
                        <option key={e} value={e}>{e}</option>
                      ))}
                    </select>
                    <button onClick={() => onDeleteGlobalKeyframe(kf.id)}
                      className="p-0.5 rounded hover:bg-red-500/20 text-red-400/40 hover:text-red-400 transition-colors shrink-0">
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-white/25 text-center py-2">No keyframes yet. Press K or double-click the timeline track.</p>
            )}
          </>
        ) : (
          <p className="text-[10px] text-white/30 text-center py-2">Open the Timeline panel to manage keyframes.</p>
        )}
      </Sec>

      <div className="p-4 flex gap-2">
        <button onClick={()=>onDuplicate(el.id)} className="flex-1 py-2 rounded-lg bg-white/8 hover:bg-white/15 text-xs flex items-center justify-center gap-1 transition-colors"><Plus size={12}/>Duplicate</button>
        <button onClick={()=>onDelete(el.id)} className="flex-1 py-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white text-xs flex items-center justify-center gap-1 transition-colors"><Trash2 size={12}/>Delete</button>
      </div>
    </div>
  );
}
