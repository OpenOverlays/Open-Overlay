use actix_cors::Cors;
use actix_web::{get, web, App, HttpResponse, HttpServer, Responder};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::db;

pub const OBS_HTTP_PORT: u16 = 7878;

// ---------------------------------------------------------------------------
// Find a widget across all saved workspaces
// ---------------------------------------------------------------------------
fn find_widget(widget_id: &str) -> Option<Value> {
    let workspaces = db::list_overlays().ok()?;
    for summary in workspaces {
        if let Ok(Some(row)) = db::get_overlay(&summary.id) {
            if let Ok(ws) = serde_json::from_str::<Value>(&row.config) {
                if let Some(widgets) = ws.get("widgets").and_then(|w| w.as_array()) {
                    for widget in widgets {
                        if widget.get("id").and_then(|id| id.as_str()) == Some(widget_id) {
                            return Some(widget.clone());
                        }
                    }
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// HTML renderer for a single widget
// ---------------------------------------------------------------------------
fn render_widget_html(widget: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    widget.to_string().hash(&mut hasher);
    let hash = hasher.finish();

    let w = widget.get("width").and_then(|v| v.as_u64()).unwrap_or(400);
    let h = widget.get("height").and_then(|v| v.as_u64()).unwrap_or(300);
    let bg = widget.get("background").and_then(|v| v.as_str()).unwrap_or("transparent");
    let elements_json = widget.get("elements").map(|e| e.to_string()).unwrap_or_else(|| "[]".to_string());
    let timeline_json = widget.get("animationTimeline").map(|e| e.to_string()).unwrap_or_else(|| "null".to_string());

    format!(r#"<!DOCTYPE html>
<html>
<!-- #HASH_{hash} -->
<head>
<meta charset="utf-8">
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
html {{ width:{w}px; height:{h}px; overflow:hidden; background:transparent; }}
body {{ width:{w}px; height:{h}px; overflow:hidden; background:transparent; }}
@keyframes fadeIn {{ from{{opacity:0}} to{{opacity:1}} }}
@keyframes slideInLeft {{ from{{transform:translateX(-100%);opacity:0}} to{{transform:translateX(0);opacity:1}} }}
@keyframes slideInRight {{ from{{transform:translateX(100%);opacity:0}} to{{transform:translateX(0);opacity:1}} }}
@keyframes bounceIn {{
  0%{{transform:scale(0.3);opacity:0}} 50%{{transform:scale(1.05);opacity:1}}
  70%{{transform:scale(0.9)}} 100%{{transform:scale(1)}}
}}
@keyframes pulse-slow {{ 0%,100%{{opacity:1}} 50%{{opacity:0.5}} }}
</style>
</head>
<body>
<div id="root"></div>
<script>
const ELEMENTS = {elements_json};
const TIMELINE = {timeline_json};
const CURRENT_HASH = "{hash}";
const BG = "{bg}";
const W = {w}, H = {h};

(function render() {{
  const root = document.getElementById('root');
  root.style.cssText = `position:relative;width:${{W}}px;height:${{H}}px;overflow:hidden;background:${{BG === 'transparent' ? 'transparent' : BG}}`;

  function applyAnim(el, data) {{
    if (!data.animationName || data.animationName === 'none') return;
    el.style.animationName = data.animationName;
    el.style.animationDuration = (data.animationDuration || 1) + 's';
    el.style.animationDelay = (data.animationDelay || 0) + 's';
    el.style.animationFillMode = 'both';
    el.style.animationIterationCount = data.animationIterationCount || '1';
  }}

  function gradStr(d) {{
    const start = d.gradientStartOpacity ?? 1, end = d.gradientEndOpacity ?? 0;
    const dirs = {{'to right':'to right','to left':'to left','to bottom':'to bottom','to top':'to top','to bottom right':'to bottom right'}};
    if(d.gradientDir === 'radial') return `radial-gradient(circle,rgba(0,0,0,${{start}}) 0%,rgba(0,0,0,${{end}}) 100%)`;
    return `linear-gradient(${{dirs[d.gradientDir]||'to bottom'}},rgba(0,0,0,${{start}}) 0%,rgba(0,0,0,${{end}}) 100%)`;
  }}

  function applyAnimProps(el, merged) {{
    if (!el) return;
    el.style.left = merged.x + 'px';
    el.style.top = merged.y + 'px';
    el.style.width = merged.width + 'px';
    el.style.height = merged.height + 'px';
    el.style.opacity = merged.opacity ?? 1;

    let filter = `blur(${{merged.blur||0}}px) brightness(${{merged.brightness||100}}%) contrast(${{merged.contrast||100}}%) hue-rotate(${{merged.hueRotate||0}}deg) saturate(${{merged.saturate||100}}%)`;

    if (merged.type === 'group' || merged.type === 'mask') {{
      el.style.transform = `scale(${{merged.scaleX??1}}, ${{merged.scaleY??1}}) rotate(${{merged.rotation||0}}deg)`;
      el.style.filter = filter;
    }} else {{
      el.style.transform = `scale(${{merged.scaleX??1}}, ${{merged.scaleY??1}}) rotate(${{merged.rotation||0}}deg)`;
      el.style.filter = filter;

      if (merged.type === 'shape') {{
        if (merged.shapeType !== 'triangle' && merged.shapeType !== 'star') {{
          el.style.backgroundColor = merged.fill || 'transparent'; // instead of background to keep structure
          el.style.borderRadius = (merged.borderRadius || 0) + 'px';
          if (merged.strokeWidth) el.style.border = merged.strokeWidth + 'px solid ' + (merged.strokeColor || 'transparent');
          else el.style.border = 'none';
        }} else {{
          const i = el.firstChild;
          if (i) i.style.background = merged.fill || '#3b82f6';
        }}
      }} else if (merged.type === 'path' && merged.pathData) {{
        const svg = el.firstChild;
        if (svg && svg.firstChild) {{
           svg.firstChild.setAttribute('fill', merged.fill || 'none');
           svg.firstChild.setAttribute('stroke', merged.strokeColor || '#3b82f6');
           svg.firstChild.setAttribute('stroke-width', merged.strokeWidth || 4);
        }}
      }} else if (merged.type === 'text') {{
        el.style.fontSize = (merged.fontSize || 48) + 'px';
        el.style.color = merged.color || '#fff';
        if (merged.letterSpacing !== undefined) el.style.letterSpacing = merged.letterSpacing + 'px';
        if (merged.lineHeight !== undefined) el.style.lineHeight = merged.lineHeight;
      }}
    }}
  }}

  function buildEl(data, parentEl) {{
    if (data.visible === false) return;

    let el = document.createElement('div');
    el.id = 'el_' + data.id;

    if (data.type === 'group' || data.type === 'mask') {{
      el.style.cssText = `position:absolute;z-index:${{data.zIndex}};isolation:isolate;transform-origin:center center;`;
      if (data.blendMode && data.blendMode !== 'normal') el.style.mixBlendMode = data.blendMode;
      if (data.maskType === 'clip') {{
        const r = data.clipRadius !== undefined ? data.clipRadius : 0;
        el.style.overflow = 'hidden';
        el.style.borderRadius = r + 'px';
      }} else if (data.maskType === 'gradient') {{
        const gs = gradStr(data);
        el.style.webkitMaskImage = gs; el.style.maskImage = gs;
      }} else if (data.maskType === 'opacity') {{
        // opacity applied in applyAnimProps
      }}
      (data.children || []).filter(c => c.visible !== false).sort((a,b) => a.zIndex - b.zIndex).forEach(c => buildEl(c, el));
    }} else {{
      el.style.cssText = `position:absolute;z-index:${{data.zIndex}};transform-origin:center center;display:flex;align-items:center;justify-content:center;overflow:hidden;`;
      if (data.blendMode && data.blendMode !== 'normal') el.style.mixBlendMode = data.blendMode;
      applyAnim(el, data);

      if (data.type === 'shape') {{
        if (data.shapeType === 'triangle') {{
          const i = document.createElement('div');
          i.style.cssText = `width:100%;height:100%;background:${{data.fill||'#3b82f6'}};clip-path:polygon(50% 0%,0% 100%,100% 100%)`;
          el.appendChild(i);
        }} else if (data.shapeType === 'star') {{
          const i = document.createElement('div');
          i.style.cssText = `width:100%;height:100%;background:${{data.fill||'#3b82f6'}};clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)`;
          el.appendChild(i);
        }} else {{
          // basic styling done in applyAnimProps
        }}
      }} else if (data.type === 'path' && data.pathData) {{
        const s = document.createElementNS('http://www.w3.org/2000/svg','svg');
        s.setAttribute('viewBox',`0 0 ${{data.width}} ${{data.height}}`);
        s.style.cssText = 'width:100%;height:100%';
        const p = document.createElementNS('http://www.w3.org/2000/svg','path');
        p.setAttribute('d', data.pathData);
        s.appendChild(p); el.appendChild(s);
      }} else if (data.type === 'text') {{
        el.style.fontFamily = data.fontFamily || 'Inter,sans-serif';
        el.style.textAlign = data.textAlign || 'center';
        el.style.fontWeight = data.fontWeight || '600';
        if (data.textShadow) el.style.textShadow = data.textShadow;
        el.style.wordBreak = 'break-word';
        el.style.width = '100%';
        el.style.padding = '0 8px';
        el.textContent = data.content || '';
      }} else if (data.type === 'image' && data.src) {{
        const img = document.createElement('img');
        img.src = data.src; img.style.width = '100%'; img.style.height = '100%';
        img.style.objectFit = data.objectFit || 'contain';
        el.appendChild(img);
      }}
    }}

    applyAnimProps(el, data);
    parentEl.appendChild(el);
  }}

  ELEMENTS.filter(e => e.visible !== false)
    .sort((a,b) => a.zIndex - b.zIndex)
    .forEach(e => buildEl(e, root));

  // --- Animation Engine ---
  const allElementsMap = {{}};
  function flatten(els) {{
    for (const el of els) {{
      allElementsMap[el.id] = el;
      if (el.children) flatten(el.children);
    }}
  }}
  flatten(ELEMENTS);

  const NUMERIC_PROPS = ['x','y','width','height','rotation','opacity','strokeWidth','borderRadius','fontSize','letterSpacing','lineHeight','blur','brightness','contrast','hueRotate','saturate','scaleX','scaleY'];
  const COLOR_PROPS = ['fill','strokeColor','color'];

  function easingFn(t, type) {{
    switch (type) {{
      case 'linear': return t;
      case 'ease-in': return t * t;
      case 'ease-out': return t * (2 - t);
      case 'ease-in-out': return t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      case 'bounce':
        if (t < 1/2.75) return 7.5625*t*t;
        if (t < 2/2.75) {{ t -= 1.5/2.75; return 7.5625*t*t+0.75; }}
        if (t < 2.5/2.75) {{ t -= 2.25/2.75; return 7.5625*t*t+0.9375; }}
        t -= 2.625/2.75; return 7.5625*t*t+0.984375;
      case 'elastic': return t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2,10*(t-1))*Math.sin((t-1.1)*5*Math.PI);
      default: return t;
    }}
  }}

  function lerpColor(a, b, t) {{
    const parse = (c) => {{
      if (c.startsWith('#')) {{
        const hex = c.slice(1);
        const full = hex.length===3 ? hex.split('').map(ch=>ch+ch).join('') : hex;
        return [parseInt(full.slice(0,2),16), parseInt(full.slice(2,4),16), parseInt(full.slice(4,6),16)];
      }}
      const m = c.match(/\d+/g);
      return m ? m.slice(0,3).map(Number) : [0,0,0];
    }};
    const ca = parse(a), cb = parse(b);
    const r = Math.round(ca[0]+(cb[0]-ca[0])*t);
    const g = Math.round(ca[1]+(cb[1]-ca[1])*t);
    const bl = Math.round(ca[2]+(cb[2]-ca[2])*t);
    return `#${{r.toString(16).padStart(2,'0')}}${{g.toString(16).padStart(2,'0')}}${{bl.toString(16).padStart(2,'0')}}`;
  }}

  function interpolate(keyframes, elId, el, time) {{
    if (!keyframes || keyframes.length === 0) return {{}};
    const sorted = [...keyframes].sort((a,b) => a.time - b.time);
    const getState = (kf) => kf.elementStates[elId] || {{}};

    if (time <= sorted[0].time) return {{ ...getState(sorted[0]) }};
    if (time >= sorted[sorted.length-1].time) return {{ ...getState(sorted[sorted.length-1]) }};

    let prev = sorted[0], next = sorted[1];
    for (let i = 0; i < sorted.length - 1; i++) {{
      if (time >= sorted[i].time && time <= sorted[i+1].time) {{ prev = sorted[i]; next = sorted[i+1]; break; }}
    }}

    const prevState = getState(prev);
    const nextState = getState(next);
    const span = next.time - prev.time;
    const rawT = span > 0 ? (time - prev.time) / span : 1;
    const t = easingFn(rawT, prev.easing);

    const result = {{}};
    const allProps = new Set([...Object.keys(prevState),...Object.keys(nextState)]);
    for (const prop of allProps) {{
      const pv = prevState[prop];
      const nv = nextState[prop];
      if (pv === undefined && nv === undefined) continue;
      if (NUMERIC_PROPS.includes(prop)) {{
        const a = pv !== undefined ? pv : (el[prop] ?? 0);
        const b = nv !== undefined ? nv : (el[prop] ?? 0);
        result[prop] = a + (b - a) * t;
      }} else if (COLOR_PROPS.includes(prop)) {{
        const a = pv !== undefined ? pv : (el[prop] ?? '#000000');
        const b = nv !== undefined ? nv : (el[prop] ?? '#000000');
        result[prop] = lerpColor(a, b, t);
      }}
    }}
    return result;
  }}

  let startT = performance.now();
  function tick() {{
    if (!TIMELINE || !TIMELINE.keyframes || TIMELINE.keyframes.length === 0 || !TIMELINE.autoplay) return;
    const elapsed = (performance.now() - startT) / 1000 * (TIMELINE.speed || 1);
    let t = elapsed;
    if (t >= TIMELINE.duration) {{
      if (TIMELINE.loop) t = t % TIMELINE.duration;
      else t = TIMELINE.duration;
    }}
    
    for (const [id, originalData] of Object.entries(allElementsMap)) {{
      const elNode = document.getElementById('el_' + id);
      if(!elNode) continue;
      const overrides = interpolate(TIMELINE.keyframes, id, originalData, t);
      if (Object.keys(overrides).length > 0) {{
        applyAnimProps(elNode, {{ ...originalData, ...overrides }});
      }}
    }}
    
    if (t < TIMELINE.duration || TIMELINE.loop) {{
      requestAnimationFrame(tick);
    }}
  }}

  if (TIMELINE && TIMELINE.autoplay && TIMELINE.keyframes && TIMELINE.keyframes.length > 0) {{
     requestAnimationFrame(tick);
  }}

  // Hash-based smart reload (polls instead of blind reloading)
  setInterval(async () => {{
    try {{
      const r = await fetch(location.href);
      const text = await r.text();
      const match = text.match(/#HASH_(\d+)/);
      if (match && match[1] !== CURRENT_HASH) {{
        location.reload();
      }}
    }} catch(e) {{}}
  }}, 2000);
}})();
</script>
</body>
</html>"#,
        hash = hash, w = w, h = h, bg = bg,
        elements_json = elements_json,
        timeline_json = timeline_json
    )
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
#[get("/widget/{id}")]
async fn serve_widget(path: web::Path<String>) -> impl Responder {
    let id = path.into_inner();
    match find_widget(&id) {
        Some(widget) => HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body(render_widget_html(&widget)),
        None => HttpResponse::NotFound().body(format!("Widget '{id}' not found")),
    }
}

#[get("/api/workspaces")]
async fn api_list_workspaces() -> impl Responder {
    match db::list_overlays() {
        Ok(list) => HttpResponse::Ok().json(list),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

pub async fn start_obs_server_async() {
    let server = HttpServer::new(|| {
        let cors = Cors::default().allow_any_origin().allow_any_method().allow_any_header();
        App::new().wrap(cors).service(serve_widget).service(api_list_workspaces)
    })
    .bind(("127.0.0.1", OBS_HTTP_PORT))
    .expect("Failed to bind OBS HTTP server")
    .run();

    if let Err(e) = server.await {
        eprintln!("OBS HTTP server error: {e}");
    }
}
