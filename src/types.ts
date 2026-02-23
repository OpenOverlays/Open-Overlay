// ---------------------------------------------------------------------------
// Element types
// ---------------------------------------------------------------------------
export type ElementType = 'shape' | 'text' | 'image' | 'path' | 'group' | 'mask';
export type ShapeType = 'rectangle' | 'circle' | 'triangle' | 'star' | 'hexagon' | 'octagon';
export type MaskType = 'none' | 'clip' | 'gradient' | 'opacity' | 'image';
export type GradientDir = 'to right' | 'to left' | 'to bottom' | 'to top' | 'to bottom right' | 'radial';
export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

// ---------------------------------------------------------------------------
// Keyframe Animation System
// ---------------------------------------------------------------------------
/** Properties that can be keyframed */
export type KeyframeProperty =
  | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'
  | 'fill' | 'strokeColor' | 'strokeWidth' | 'borderRadius'
  | 'fontSize' | 'letterSpacing' | 'lineHeight'
  | 'blur' | 'brightness' | 'contrast' | 'hueRotate' | 'saturate'
  | 'color' | 'scaleX' | 'scaleY';

/** Easing function names */
export type EasingType = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
  | 'cubic-bezier' | 'step-start' | 'step-end' | 'bounce' | 'elastic';

/**
 * A global keyframe captures the state of ALL elements at a point in time.
 * One keyframe = one "scene snapshot".
 */
export interface GlobalKeyframe {
  id: string;
  /** Time in seconds from animation start */
  time: number;
  /** Easing to use from this keyframe TO the next */
  easing: EasingType;
  /**
   * Map of elementId → animatable property values at this moment.
   * Every element present in the widget is included.
   */
  elementStates: Record<string, Partial<Record<KeyframeProperty, number | string>>>;
}

/** Animation timeline config on a widget */
export interface AnimationTimeline {
  /** Total duration in seconds */
  duration: number;
  /** Whether the animation loops */
  loop: boolean;
  /** Whether this animation auto-plays in OBS */
  autoplay: boolean;
  /** Playback speed multiplier (1 = normal) */
  speed: number;
  /** Global keyframes — each one captures ALL elements */
  keyframes: GlobalKeyframe[];
}

export interface OverlayElement {
  id: string;
  type: ElementType;
  name: string;
  /** Position relative to parent container (widget canvas or group) */
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  rotation: number;
  blendMode?: BlendMode;

  // ── Group / mask container ──────────────────────────────────────────────
  /** If type === 'group', children are rendered inside this container.
   *  Children x/y are relative to the group's top-left corner. */
  children?: OverlayElement[];
  /** Controls CSS masking applied to the whole group */
  maskType?: MaskType;
  gradientDir?: GradientDir;
  gradientStartOpacity?: number; // 0-1
  gradientEndOpacity?: number;   // 0-1
  /** For 'clip' mask: border-radius in px (0 = rect, 9999 = circle) */
  clipRadius?: number;
  /** For 'image' mask */
  maskImageSrc?: string;
  
  // ── Explicit Layer Mask ─────────────────────────────────────────────────
  /** If set, this element is masked by the vector shape/path of the referenced element ID. */
  maskWithLayerId?: string;
  maskInvert?: boolean;

  // ── Shape ───────────────────────────────────────────────────────────────
  fill?: string;          // hex / rgba
  fillOpacity?: number;   // 0-1, separate from element opacity
  borderRadius?: number;
  strokeColor?: string;
  strokeWidth?: number;
  shapeType?: ShapeType;

  // ── Path ────────────────────────────────────────────────────────────────
  pathData?: string;

  // ── Text ────────────────────────────────────────────────────────────────
  content?: string;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  textAlign?: 'left' | 'center' | 'right';
  fontWeight?: string;
  textShadow?: string;
  lineHeight?: number;
  letterSpacing?: number;

  // ── Image ───────────────────────────────────────────────────────────────
  src?: string;
  objectFit?: 'contain' | 'cover' | 'fill';

  // ── Filters ─────────────────────────────────────────────────────────────
  blur?: number;
  brightness?: number;
  contrast?: number;
  hueRotate?: number;
  saturate?: number;

  // ── Scale transforms (for keyframe animation) ──────────────────────────
  scaleX?: number;
  scaleY?: number;

  // ── Animation (preset effects) ─────────────────────────────────────────
  animationName?: string;
  animationDuration?: number;
  animationDelay?: number;
  animationIterationCount?: string;

  // (Keyframe data is stored globally on Widget.animationTimeline.keyframes)
}

// ---------------------------------------------------------------------------
// Widget — the primary canvas unit. Each widget gets its own OBS URL.
// ---------------------------------------------------------------------------
export type WidgetType = 'alert' | 'chat' | 'goal' | 'clock' | 'now_playing' | 'custom';

export const WIDGET_PRESETS: Record<WidgetType, { width: number; height: number; label: string }> = {
  alert:       { width: 600,  height: 180,  label: 'Alert'       },
  chat:        { width: 400,  height: 700,  label: 'Chat Box'    },
  goal:        { width: 550,  height: 110,  label: 'Goal Bar'    },
  clock:       { width: 320,  height: 100,  label: 'Clock'       },
  now_playing: { width: 550,  height: 130,  label: 'Now Playing' },
  custom:      { width: 400,  height: 300,  label: 'Custom'      },
};

export const WIDGET_COLORS: Record<WidgetType, string> = {
  alert:       '#f59e0b',
  chat:        '#10b981',
  goal:        '#3b82f6',
  clock:       '#8b5cf6',
  now_playing: '#ec4899',
  custom:      '#6b7280',
};

export interface Widget {
  id: string;
  name: string;
  widgetType: WidgetType;
  width: number;
  height: number;
  background: string;
  /** x/y on the artboard — only used for designer layout, not OBS */
  artboardX: number;
  artboardY: number;
  elements: OverlayElement[];
  /** Keyframe animation timeline settings */
  animationTimeline?: AnimationTimeline;
}

// ---------------------------------------------------------------------------
// Workspace — the top-level save unit containing all widgets
// ---------------------------------------------------------------------------
export interface WorkspaceConfig {
  id: string;
  name: string;
  widgets: Widget[];
}
