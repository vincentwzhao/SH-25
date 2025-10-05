// Error overlay
window.addEventListener('error', (e)=>{
  const el = document.getElementById('errOverlay');
  if (el) { el.style.display='block'; el.textContent = 'Error: ' + (e.message || e.error || e.filename); }
  console.error('Runtime error', e);
});

// Map init
const map = L.map('map', { center: [49.2827, -123.1207], zoom: 17 });
// Dedicated pane for fences to ensure clickability
const fencesPane = map.createPane('fencesPane');
fencesPane.style.zIndex = 650; // above overlayPane(400) and below markers if needed

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20, attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// State
let fences = []; // array of fence objects
let userMarker = null;
let watching = false;
let selectedFence = null;
let currentlyPlayingFenceId = null;

// Waypoints
let waypoints = []; // { id, latlng, marker }
let simTimer = null;
let routePolyline = null;
let approachPolyline = null;

// UI refs
const shapeSel = document.getElementById('shape');
const sizeInput = document.getElementById('size');
const buildingMode = document.getElementById('buildingMode');
const panel = document.getElementById('panel');
const panelTitle = document.getElementById('panelTitle');
const audioInfo = document.getElementById('audioInfo');
const btnClosePanel = document.getElementById('btnClosePanel');
const btnSetAudio = document.getElementById('btnSetAudio');
const fileInput = document.getElementById('fileInput');
const btnDelete = document.getElementById('btnDelete');
const vol = document.getElementById('vol');
const btnTest = document.getElementById('btnTest');
const btnStop = document.getElementById('btnStop');
const btnEnableAudio = document.getElementById('btnEnableAudio');
const shapeInfo = document.getElementById('shapeInfo');

const btnAddWP = document.getElementById('btnAddWP');
const btnClearWP = document.getElementById('btnClearWP');
const wpSelect = document.getElementById('wpSelect');
const wpSpeed = document.getElementById('wpSpeed');
const wpRoads = document.getElementById('wpRoads');
const btnSimGo = document.getElementById('btnSimGo');
const btnSimStop = document.getElementById('btnSimStop');
const btnLibrary = document.getElementById('btnLibrary');

// Toast helper
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// Audio unlock
let audioCtx = null;
btnEnableAudio.addEventListener('click', async () => {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.value = 0.0001; o.frequency.value = 880; o.start();
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.2);
    o.stop(audioCtx.currentTime + 0.22);
    toast('Audio enabled');
  } catch (e) { alert('Audio could not be enabled: ' + e); }
});

// Geolocation
document.getElementById('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocation not supported.');
  if (watching) return;
  watching = true;
  navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude } = pos.coords;
    updateUserMarker(latitude, longitude);
    checkFences(latitude, longitude);
  }, err => {
    console.error('Geolocation error:', err);
    alert(`Failed to get location.\ncode=${err.code}\nmessage=${err.message}`);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 });
});

function updateUserMarker(lat, lng) {
  if (!userMarker) {
    userMarker = L.marker([lat, lng], { title: 'You' }).addTo(map);
    map.setView([lat, lng], 18);
  } else {
    userMarker.setLatLng([lat, lng]);
  }
}


async function sha1OfArrayBuffer(buf) {
  const hashBuf = await crypto.subtle.digest('SHA-1', buf);
  const arr = Array.from(new Uint8Array(hashBuf));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ======= Create / Select / Delete / Audio =======
map.on('click', async (e) => {
  // Ctrl+Click: simulate position (empty map)
  if (e.originalEvent.ctrlKey) {
    const { lat, lng } = e.latlng;
    updateUserMarker(lat, lng);
    checkFences(lat, lng);
    toast(`Simulated position: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    return;
  }

  // Building mode: fetch OSM building polygon at click
  if (buildingMode.checked) {
    try {
      const poly = await fetchBuildingPolygon(e.latlng.lat, e.latlng.lng);
      if (!poly) { toast('No building found here. Zoom in and click the roof outline.'); return; }
      const f = createPolyFence(poly);
      toast(`Added ${f.id} (Building)`);
      return;
    } catch (err) {
      console.error(err);
      alert('Building lookup failed (Overpass). Try again or zoom in closer.');
      return;
    }
  }

  // Fallback hit-test selection
  {
  // Fallback: if click wasn't for ctrl/shift/building, try hit-test to select fence
  const hit = findFenceAt(e.latlng);
  if (hit) { selectFence(hit.id); return; }
  }

  // Default: add shape with Shift+Click
  if (e.originalEvent.shiftKey) {
    const shape = shapeSel.value;
    const sizeM = parseFloat(sizeInput.value || '120');
    if (shape === 'circle') {
      const f = createCircleFence(e.latlng, sizeM);
      toast(`Added ${f.id} (Circle R≈${sizeM}m)`);
    } else {
      const f = createRectFence(e.latlng, sizeM*2, sizeM*1.2, 0);
      toast(`Added ${f.id} (Rectangle ~${Math.round(f.width)}×${Math.round(f.height)}m)`);
    }
  }
});

function selectFence(id) {
  const f = fences.find(x=>x.id===id);
  if (!f) return;
  fences.forEach(x => {
    x.layer.getElement()?.classList.remove('selected');
    showHandles(x, false);
  });
  f.layer.getElement()?.classList.add('selected');
  showHandles(f, f.type!=='poly'); // handles for circle/rect only
  selectedFence = f;
  panelTitle.textContent = f.id;
  audioInfo.textContent = f.audioName ? `Audio: ${f.audioName}` : 'No audio set';
  updateShapeInfo(f);
  vol.value = f.audioEl ? f.audioEl.volume : 0.9;
  panel.classList.remove('hidden');
}

btnClosePanel.addEventListener('click', ()=>{
  panel.classList.add('hidden');
  fences.forEach(x => { x.layer.getElement()?.classList.remove('selected'); showHandles(x,false); });
  selectedFence = null;
});

btnSetAudio.addEventListener('click', ()=>fileInput.click());
fileInput.addEventListener('change', async ()=>{
  if (!selectedFence) return;
  const file = fileInput.files?.[0];
  if (!file) return;
  // Auto-add to Music Library if not present (IPC or fallback)
  try {
    try {
      if (window.api && window.api.musicSave) {
        const buf = await file.arrayBuffer();
        const id = await sha1OfArrayBuffer(buf);
        const ext = (file.name.split('.').pop() || 'bin');
        await window.api.musicSave({ id, name: file.name.replace(/\.[^/.]+$/, ''), ext, data: buf });
      } else {
        await fallbackLibrarySave(file);
      }
    } catch(e) { console.warn('Auto-add failed', e); }
  } catch(e){ console.warn('Auto-add to library failed', e); }

  if (selectedFence.audioUrl) { try { URL.revokeObjectURL(selectedFence.audioUrl); } catch {} }
  if (selectedFence.audioEl) { try { selectedFence.audioEl.pause(); selectedFence.audioEl.currentTime=0; } catch {} }
  const url = URL.createObjectURL(file);
  const el = new Audio(url); el.loop = true; el.volume = parseFloat(vol.value||'0.9');
  selectedFence.audioEl = el; selectedFence.audioUrl = url; selectedFence.audioName = file.name; selectedFence._audioFile = file;
  audioInfo.textContent = `Audio: ${file.name}`;
  updateShapeInfo(selectedFence);
  if (currentlyPlayingFenceId === selectedFence.id) {
    try { el.currentTime = 0; el.play().catch(err=>alert('Play error: ' + err)); } catch(e){}
  }
  toast(`Set audio for ${selectedFence.id}`);
});

vol.addEventListener('input', ()=>{
  if (!selectedFence) return;
  if (selectedFence.audioEl) selectedFence.audioEl.volume = parseFloat(vol.value||'0.9');
});

btnTest.addEventListener('click', async ()=>{
  if (!selectedFence) return;
  if (!selectedFence.audioEl) return alert('No audio set.');
  try { await selectedFence.audioEl.play(); } catch (e) { alert('Play error: ' + e); }
});
btnStop.addEventListener('click', ()=>{
  if (!selectedFence) return;
  if (selectedFence.audioEl) { selectedFence.audioEl.pause(); selectedFence.audioEl.currentTime=0; }
});

btnDelete.addEventListener('click', ()=>{
  if (!selectedFence) return;
  if (selectedFence.playing) stopFenceAudio(selectedFence);
  map.removeLayer(selectedFence.layer);
  removeHandles(selectedFence);
  fences = fences.filter(x => x.id !== selectedFence.id);
  toast(`Deleted ${selectedFence.id}`);
  panel.classList.add('hidden');
  selectedFence = null;
});

// ===== Fence creation helpers =====
function createCircleFence(latlng, radius) {
  const id = `Fence-${fences.length + 1}`;
  const circle = L.circle(latlng, { radius, pane:'fencesPane', className:'fence-layer', color:'#1e88e5', weight:3, fill:true, fillColor:'#1e88e5', fillOpacity:0.25, interactive:true, bubblingMouseEvents:true }).addTo(map);
  circle.on('add', ()=> { try { circle.bringToFront(); } catch{} });
  circle.on('click', function(ev){
    // Ctrl+Click inside: move into, don't select
    if (ev && ev.originalEvent && ev.originalEvent.ctrlKey) {
      const ll = ev.latlng || circle.getLatLng();
      updateUserMarker(ll.lat, ll.lng);
      checkFences(ll.lat, ll.lng);
      L.DomEvent.stopPropagation(ev);
      return;
    }
    L.DomEvent.stopPropagation(ev);
    selectFence(id);
  });
  circle.on('mousedown', (ev)=> beginDragCircle(id, ev));
  const f = { id, type:'circle', center:[latlng.lat, latlng.lng], radius, layer:circle, handles:{},
              dragging:{on:false, anchor:null}, playing:false, audioName:null, audioUrl:null, audioEl:null };
  addCircleHandle(f);
  fences.push(f);
  return f;
}
function createRectFence(a, b, c, d) {
  // Supports signatures:
  //  (centerLatLng, widthM, heightM, rotationDeg)  OR  (bounds)
  let bounds, center, width, height, rotation = 0;

  function toBoundsFromCenter(centerLL, wM, hM){
    const lat = centerLL.lat || centerLL[0], lng = centerLL.lng || centerLL[1];
    const phi = (lat * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(phi);
    const dLat = (hM/2) / mPerDegLat;
    const dLng = (wM/2) / mPerDegLng;
    const sw = L.latLng(lat - dLat, lng - dLng);
    const ne = L.latLng(lat + dLat, lng + dLng);
    return L.latLngBounds(sw, ne);
  }

  function isBoundsArg(x){
    return !!(x && (typeof x.getSouthWest === 'function' || (Array.isArray(x) && x.length===2)));
  }

  if (isBoundsArg(a)) {
    bounds = a.getSouthWest ? a : L.latLngBounds(a[0], a[1]);
    center = bounds.getCenter();
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const midLat = (sw.lat + ne.lat)/2;
    width = map.distance([midLat, sw.lng], [midLat, ne.lng]);
    const midLng = (sw.lng + ne.lng)/2;
    height = map.distance([sw.lat, midLng], [ne.lat, midLng]);
  } else {
    const centerLL = a;
    width = Number(b)||0; height = Number(c)||0; rotation = Number(d)||0;
    bounds = toBoundsFromCenter(centerLL, width, height);
    center = bounds.getCenter();
  }

  const id = `Fence-${fences.length + 1}`;
  const layer = L.rectangle(bounds, {
    pane:'fencesPane',
    className:'fence rect',
    color:'#06c', weight:2,
    fillOpacity:0.25,
    interactive:true, bubblingMouseEvents:true
  }).addTo(map);

  layer.on('add', ()=> { try { layer.bringToFront(); } catch{} });
  layer.on('click', function(ev){
    if (ev && ev.originalEvent && ev.ctrlKey) {
      const ll = ev.latlng || layer.getBounds().getCenter();
      updateUserMarker(ll.lat, ll.lng);
      checkFences(ll.lat, ll.lng);
      L.DomEvent.stopPropagation(ev);
      return;
    }
    L.DomEvent.stopPropagation(ev);
    selectFence(id);
  });

  const rect = {
    id,
    type:'rect',
    center,
    bounds,
    width, height, rotation,
    layer,
    handles:{},
    dragging:{on:false, anchor:null},
    playing:false,
    audioName:null,
    audioUrl:null,
    audioEl:null,
    _audioFile:null
  };

  layer.on('mousedown', (ev)=> beginDragRect(rect, ev));
  fences.push(rect);
  return rect;
}
function createPolyFence(vertices) {
  const id = `Fence-${fences.length + 1}`;
  const layer = L.polygon(vertices, { pane:'fencesPane', className:'fence-layer', color:'#1e88e5', weight:3, fill:true, fillColor:'#1e88e5', fillOpacity:0.25, interactive:true, bubblingMouseEvents:true }).addTo(map);
  layer.on('add', ()=> { try { layer.bringToFront(); } catch{} });
  layer.on('click', function(ev){
    if (ev && ev.originalEvent && ev.originalEvent.ctrlKey) {
      const ll = ev.latlng || layer.getBounds().getCenter();
      updateUserMarker(ll.lat, ll.lng);
      checkFences(ll.lat, ll.lng);
      L.DomEvent.stopPropagation(ev);
      return;
    }
    L.DomEvent.stopPropagation(ev);
    selectFence(id);
  });
  const center = centroid(vertices);
  const f = { id, type:'poly', center, vertices, layer, handles:{},
              dragging:{on:false, anchor:null}, playing:false, audioName:null, audioUrl:null, audioEl:null };
  layer.on('mousedown', (ev)=> beginDragPoly(f, ev));
  fences.push(f);
  return f;
}

// ===== Dragging & handles =====
function beginDragCircle(id, ev) {
  const f = fences.find(x=>x.id===id); if (!f) return;
  beginDragGeneric(f, ev, (f, deltaMeters)=>{
    f.center = offsetLatLng(f.center, deltaMeters.dx, deltaMeters.dy);
    f.layer.setLatLng(f.center);
    moveCircleHandle(f);
  });
}
function beginDragRect(id, ev) {
  const f = fences.find(x=>x.id===id); if (!f) return;
  beginDragGeneric(f, ev, (f, deltaMeters)=>{
    f.center = offsetLatLng(f.center, deltaMeters.dx, deltaMeters.dy);
    updateRectangleLayer(f);
  });
}
function beginDragPoly(f, ev) {
  beginDragGeneric(f, ev, (f, deltaMeters)=>{
    f.center = offsetLatLng(f.center, deltaMeters.dx, deltaMeters.dy);
    f.vertices = f.vertices.map(([lat,lng]) => offsetLatLng([lat,lng], deltaMeters.dx, deltaMeters.dy));
    f.layer.setLatLngs(f.vertices);
  });
}
function beginDragGeneric(f, ev, applyDelta) {
  f.dragging.on = true;
  f.dragging.anchor = ev.latlng;
  function onMove(mev) {
    if (!f.dragging.on) return;
    const d = metersDelta(f.dragging.anchor, mev.latlng);
    applyDelta(f, d);
    f.dragging.anchor = mev.latlng;
    if (selectedFence && selectedFence.id===f.id) updateShapeInfo(f);
  }
  function onUp() {
    f.dragging.on = false;
    map.off('mousemove', onMove);
    map.off('mouseup', onUp);
  }
  map.on('mousemove', onMove);
  map.on('mouseup', onUp);
}

// Circle radius handle
function addCircleHandle(f) {
  const HandleIcon = L.divIcon({ className:'handle', iconSize:[12,12] });
  const h = L.marker([0,0], { draggable:true, icon:HandleIcon }).addTo(map);
  f.handles.r = h;
  moveCircleHandle(f);
  h.on('drag', (ev)=>{
    const d = metersDelta(f.center, [ev.latlng.lat, ev.latlng.lng]);
    const dist = Math.hypot(d.dx, d.dy);
    f.radius = Math.max(10, dist - 10);
    f.layer.setRadius(f.radius);
    moveCircleHandle(f);
    if (selectedFence && selectedFence.id===f.id) updateShapeInfo(f);
  });
}
function moveCircleHandle(f) {
  if (!f.handles || !f.handles.r) return;
  const pos = offsetLatLng(f.center, f.radius + 12, 0);
  f.handles.r.setLatLng(pos);
}

// Rectangle handles
function addRectHandles(r) {
  const HandleIcon = L.divIcon({ className:'handle', iconSize:[12,12] });
  r.handles.rotate = L.marker([0,0], { draggable:true, icon:HandleIcon }).addTo(map);
  r.handles.n = L.marker([0,0], { draggable:true, icon:HandleIcon }).addTo(map);
  r.handles.e = L.marker([0,0], { draggable:true, icon:HandleIcon }).addTo(map);
  r.handles.s = L.marker([0,0], { draggable:true, icon:HandleIcon }).addTo(map);
  r.handles.w = L.marker([0,0], { draggable:true, icon:HandleIcon }).addTo(map);

  r.handles.rotate.on('drag', (ev)=>{
    const d = metersDelta(r.center, [ev.latlng.lat, ev.latlng.lng]);
    const angle = Math.atan2(d.dy, d.dx);
    r.angleDeg = (toDeg(angle) - 90 + 360) % 360;
    updateRectangleLayer(r);
  });

  ['n','e','s','w'].forEach(edge=>{
    r.handles[edge].on('drag', (ev)=>{
      adjustRectEdge(r, ev.latlng, edge);
    });
  });

  moveRectHandles(r);
}
function moveRectHandles(r) {
  if (!r.handles) return;
  const a = toRad(r.angleDeg);
  const hw = r.width/2, hh = r.height/2;
  const N = [0, -hh - 12], S = [0, hh + 12], E = [ hw + 12, 0], W = [-hw - 12, 0], ROT = [0, -hh - 32];
  function localToLatLng([x,y]) {
    const xr =  x*Math.cos(a) - y*Math.sin(a);
    const yr =  x*Math.sin(a) + y*Math.cos(a);
    return offsetLatLng(r.center, xr, yr);
  }
  r.handles.n.setLatLng(localToLatLng(N));
  r.handles.s.setLatLng(localToLatLng(S));
  r.handles.e.setLatLng(localToLatLng(E));
  r.handles.w.setLatLng(localToLatLng(W));
  r.handles.rotate.setLatLng(localToLatLng(ROT));
}
function adjustRectEdge(r, ll, edge) {
  const d = metersDelta(r.center, [ll.lat, ll.lng]);
  const a = toRad(r.angleDeg);
  const localX =  Math.cos(a)*d.dx + Math.sin(a)*d.dy;
  const localY = -Math.sin(a)*d.dx + Math.cos(a)*d.dy;
  const minSize = 20;
  if (edge==='e' || edge==='w') {
    let newHalfW = Math.max(minSize/2, Math.abs(localX) - 10);
    r.width = newHalfW * 2;
  } else {
    let newHalfH = Math.max(minSize/2, Math.abs(localY) - 10);
    r.height = newHalfH * 2;
  }
  updateRectangleLayer(r);
}

// ===== Geometry helpers =====
function toRad(d){ return d*Math.PI/180; }
function toDeg(r){ return r*180/Math.PI; }

function offsetLatLng([lat,lng], dxMeters, dyMeters) {
  const R = 6378137;
  const dLat = (dyMeters / R) * 180/Math.PI;
  const dLng = (dxMeters / (R * Math.cos(Math.PI * lat/180))) * 180/Math.PI;
  return [ lat + dLat, lng + dLng ];
}
function metersDelta(ll0, ll1) {
  const [lat0,lng0] = [ll0.lat||ll0[0], ll0.lng||ll0[1]];
  const [lat1,lng1] = [ll1.lat||ll1[0], ll1.lng||ll1[1]];
  const R = 6378137;
  const dLat = (lat1-lat0) * Math.PI/180;
  const dLng = (lng1-lng0) * Math.PI/180;
  const dy = dLat * R;
  const dx = dLng * R * Math.cos(lat0*Math.PI/180);
  return { dx, dy };
}
function rectCorners(center, width, height, angleDeg) {
  const a = toRad(angleDeg);
  const hw = width/2, hh = height/2;
  const cornersLocal = [ [-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh] ];
  return cornersLocal.map(([x,y])=>{
    const xr = x*Math.cos(a) - y*Math.sin(a);
    const yr = x*Math.sin(a) + y*Math.cos(a);
    return offsetLatLng(center, xr, yr);
  });
}
function drawRectangle(r) {
  const corners = rectCorners(r.center, r.width, r.height, r.angleDeg);
  return L.polygon(corners, { pane:'fencesPane', className:'fence-layer', color:'#1e88e5', weight:3, fill:true, fillColor:'#1e88e5', fillOpacity:0.25, interactive:true, bubblingMouseEvents:true });
}
function updateRectangleLayer(r) {
  const corners = rectCorners(r.center, r.width, r.height, r.angleDeg);
  r.layer.setLatLngs(corners);
  moveRectHandles(r);
  if (selectedFence && selectedFence.id===r.id) updateShapeInfo(r);
}
function centroid(poly) {
  let x=0,y=0,z=0;
  for (const [lat,lon] of poly) {
    const latRad = lat * Math.PI/180;
    const lonRad = lon * Math.PI/180;
    x += Math.cos(latRad) * Math.cos(lonRad);
    y += Math.cos(latRad) * Math.sin(lonRad);
    z += Math.sin(latRad);
  }
  const total = poly.length;
  x/=total; y/=total; z/=total;
  const lon = Math.atan2(y, x);
  const hyp = Math.sqrt(x*x + y*y);
  const lat = Math.atan2(z, hyp);
  return [ lat*180/Math.PI, lon*180/Math.PI ];
}
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
function pointInPolygon(lat, lng, vertices) {
  let inside = false;
  for (let i=0, j=vertices.length-1; i<vertices.length; j=i++) {
    const xi = vertices[i][1], yi = vertices[i][0];
    const xj = vertices[j][1], yj = vertices[j][0];
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ======= Overpass building lookup =======
async function fetchBuildingPolygon(lat, lng) {
  const around = 30;
  const query = `[out:json][timeout:20];
  (
    way["building"](around:${around},${lat},${lng});
    relation["building"](around:${around},${lat},${lng});
  );
  out body; >; out skel qt;`;

  const url = 'https://overpass-api.de/api/interpreter';
  const res = await fetch(url, { method:'POST', body:query, headers:{'Content-Type':'text/plain'} });
  if (!res.ok) throw new Error('Overpass API error: ' + res.status);
  const data = await res.json();

  const nodes = new Map();
  for (const el of data.elements) if (el.type==='node') nodes.set(el.id, [el.lat, el.lon]);

  const polygons = [];
  for (const el of data.elements) {
    if (el.type === 'way' && el.nodes && el.nodes.length > 2) {
      const pts = el.nodes.map(id => nodes.get(id)).filter(Boolean);
      if (pts.length>2) {
        const first = pts[0], last = pts[pts.length-1];
        if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
        polygons.push(pts);
      }
    } else if (el.type === 'relation' && el.members) {
      const outers = el.members.filter(m => m.role === 'outer' && m.type === 'way');
      let ring = [];
      for (const m of outers) {
        const way = data.elements.find(x => x.type==='way' && x.id===m.ref);
        if (!way) continue;
        const pts = way.nodes.map(id => nodes.get(id)).filter(Boolean);
        if (pts.length>2) {
          const first = pts[0], last = pts[pts.length-1];
          if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
          ring = ring.concat(pts);
        }
      }
      if (ring.length>2) polygons.push(ring);
    }
  }
  if (!polygons.length) return null;

  const containing = polygons.filter(poly => pointInPolygon(lat, lng, poly));
  if (containing.length) return simplify(containing[0]);

  polygons.sort((a,b)=>{
    const ca = centroid(a), cb = centroid(b);
    const da = haversineMeters(lat,lng, ca[0],ca[1]);
    const db = haversineMeters(lat,lng, cb[0],cb[1]);
    return da - db;
  });
  return simplify(polygons[0]);
}
function simplify(poly) {
  const out = []; const eps = 1e-6;
  for (const p of poly) {
    if (!out.length) { out.push(p); continue; }
    const last = out[out.length-1];
    if (Math.abs(p[0]-last[0])>eps || Math.abs(p[1]-last[1])>eps) out.push(p);
  }
  return out;
}

// ===== Geofence logic =====
function checkFences(lat, lng) {
  const insideList = [];
  for (const f of fences) {
    if (f.type==='circle') {
      const d = haversineMeters(lat, lng, f.center[0], f.center[1]);
      if (d <= f.radius) insideList.push({ f, dist: d });
    } else if (f.type==='rect') {
      const delta = metersDelta({lat:f.center[0],lng:f.center[1]}, {lat, lng});
      const a = toRad(f.angleDeg);
      const localX =  Math.cos(a)*delta.dx + Math.sin(a)*delta.dy;
      const localY = -Math.sin(a)*delta.dx + Math.cos(a)*delta.dy;
      if (Math.abs(localX) <= f.width/2 && Math.abs(localY) <= f.height/2) {
        const centerDist = Math.hypot(delta.dx, delta.dy);
        insideList.push({ f, dist: centerDist });
      }
    } else if (f.type==='poly') {
      if (pointInPolygon(lat, lng, f.vertices)) {
        const d = haversineMeters(lat, lng, f.center[0], f.center[1]);
        insideList.push({ f, dist: d });
      }
    }
  }
  insideList.sort((a,b)=>a.dist-b.dist);
  const target = insideList.length ? insideList[0].f : null;
  if (target) {
    if (currentlyPlayingFenceId !== target.id) { switchToFence(target); }
  } else {
    const current = fences.find(x=>x.id===currentlyPlayingFenceId);
    if (current) fadeOutFence(current, 800);
  }
}

function playFenceAudio(f) {
  if (f.audioEl) {
    f.audioEl.currentTime = 0;
    f.audioEl.play().catch(err => alert('Play error: ' + err));
  } else {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.value = 0.12;
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      f._osc = o; f._gain = g;
    } catch (e) { console.warn('Beep failed', e); }
  }
  f.playing = true;
  currentlyPlayingFenceId = f.id;
  toast(`Entered ${f.id} • Playing ${f.audioName || 'beep'}`);
}

function stopFenceAudio(f) {
  if (f.audioEl) { try { f.audioEl.pause(); f.audioEl.currentTime = 0; } catch {} }
  if (f._osc && f._gain && audioCtx) {
    try {
      f._gain.gain.setTargetAtTime(0.0001, audioCtx.currentTime, 0.02);
      f._osc.stop(audioCtx.currentTime + 0.05);
    } catch {}
    f._osc = null; f._gain = null;
  }
  f.playing = false;
  if (currentlyPlayingFenceId === f.id) currentlyPlayingFenceId = null;
  toast(`Exited ${f.id} • Stopped`);
}
function stopAllFences() { fences.forEach(f => { if (f.playing) stopFenceAudio(f); }); }

// ===== Fade helpers =====
function cancelFade(f) {
  if (!f) return;
  if (f._fadeRAF) { cancelAnimationFrame(f._fadeRAF); f._fadeRAF = null; }
  if (f._fadeTimer) { clearTimeout(f._fadeTimer); f._fadeTimer = null; }
}
function fadeAudioEl(el, from, to, ms, onDone) {
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / ms);
    const v = from + (to - from) * t;
    try { el.volume = Math.max(0, Math.min(1, v)); } catch {}
    if (t < 1) {
      const raf = requestAnimationFrame(step);
      // return raf id if needed
      return raf;
    } else { if (onDone) onDone(); }
  }
  return requestAnimationFrame(step);
}
function fadeInFence(f, ms=800) {
  if (!f) return;
  cancelFade(f);
  // Resolve target base volume
  const base = f.audioEl ? (f.audioEl.volume || 0.9) : 0.12; // for beep, use gain default
  if (f.audioEl) {
    try { f.audioEl.volume = 0.0001; f.audioEl.currentTime = 0; f.audioEl.play().catch(()=>{}); } catch {}
    f._fadeRAF = fadeAudioEl(f.audioEl, f.audioEl.volume, base, ms, ()=>{ f._fadeRAF = null; });
  } else if (f._gain && audioCtx) {
    try {
      f._gain.gain.cancelScheduledValues(audioCtx.currentTime);
      f._gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      f._gain.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + ms/1000);
    } catch {}
  }
  f.playing = true;
  currentlyPlayingFenceId = f.id;
}
function fadeOutFence(f, ms=800) {
  if (!f) return;
  cancelFade(f);
  if (f.audioEl) {
    const startVol = f.audioEl.volume;
    f._fadeRAF = fadeAudioEl(f.audioEl, startVol, 0.0001, ms, ()=>{
      try { f.audioEl.pause(); f.audioEl.currentTime = 0; } catch {}
      f._fadeRAF = null;
      f.playing = false;
      if (currentlyPlayingFenceId === f.id) currentlyPlayingFenceId = null;
    });
  } else if (f._gain && audioCtx) {
    try {
      f._gain.gain.cancelScheduledValues(audioCtx.currentTime);
      f._gain.gain.setTargetAtTime(0.0001, audioCtx.currentTime, ms/1000/3);
      f._fadeTimer = setTimeout(()=>{
        try { f._osc && f._osc.stop(); } catch {}
        f._fadeTimer = null;
        f.playing = false;
        if (currentlyPlayingFenceId === f.id) currentlyPlayingFenceId = null;
      }, ms + 50);
    } catch {}
  } else {
    // nothing to fade; just stop
    try { stopFenceAudio(f); } catch {}
  }
}

// ===== Auto-save when entering a fence =====

async function existsInLibraryById(id) {
  try {
    if (window.api && window.api.musicList) {
      const list = await window.api.musicList();
      return !!list.find(x => x.id === id);
    } else if (typeof fallbackLibraryList === 'function') {
      const list = await fallbackLibraryList();
      return !!list.find(x => x.id === id);
    }
  } catch {}
  return false;
}

async function ensureTrackSaved(f) { // returns true if saved/newly indexed, false otherwise
  try {
    if (!f) return;
    if (f.audioSavedId) return; // already saved
    let src = f.audioEl ? f.audioEl.src || '' : '';
    // 1) If we still have original File (from Set Audio)
    if (f._audioFile) {
      console.log('[autosave] using original file for fence', f.id);
      if (window.api && window.api.musicSave) {
        const buf = await f._audioFile.arrayBuffer();
        const id = await sha1OfArrayBuffer(buf);
        const ext = (f._audioFile.name.split('.').pop() || 'bin');
        const res = await window.api.musicSave({ id, name: f._audioFile.name.replace(/\.[^/.]+$/, ''), ext, data: buf });
        if (res && res.ok) { f.audioSavedId = id; toast('Saved to Library'); console.log('[autosave] saved via IPC', id); return true; }
      } else {
        // fallback (no IPC)
        const r = await fallbackLibrarySave(f._audioFile);
        if (r && r.ok) { f.audioSavedId = r.id; toast('Saved to Library'); console.log('[autosave] saved via fallback(original file)', r.id); return true; }
      }
    }
    // 2) If BLOB URL source (e.g., from URL.createObjectURL)
    if (src && src.startsWith('blob:')) {
      console.log('[autosave] using blob URL for fence', f.id);
      try {
        const ab = await (await fetch(src)).arrayBuffer();
        const id = await sha1OfArrayBuffer(ab);
        // if already present, mark success
        if (await existsInLibraryById(id)) { f.audioSavedId = id; toast('Already in Library'); console.log('[autosave] already existed (blob)', id); return true; }
        if (window.api && window.api.musicSave) {
          const name = (f.audioName || 'track');
          const ext = name.includes('.') ? name.split('.').pop() : 'bin';
          if (await existsInLibraryById(id)) { f.audioSavedId = id; toast('Already in Library'); console.log('[autosave] already existed (dataURL)', id); return true; }
        const res = await window.api.musicSave({ id, name: name.replace(/\.[^/.]+$/, ''), ext, data: ab });
          if (res && res.ok) { f.audioSavedId = id; toast('Saved to Library'); console.log('[autosave] saved via IPC(blob)', id); return true; }
        } else {
          // Save to fallback(IDB)
          const file = new File([ab], f.audioName || 'track', { type: 'audio/mpeg' });
          const r = await fallbackLibrarySave(file);
          if (r && r.ok) { f.audioSavedId = r.id; toast('Saved to Library'); console.log('[autosave] saved via fallback(blob)', r.id); return true; }
        }
      } catch(e) { console.warn('blob autosave failed', e); }
    }

    // 3) If data URL source
    if (src && src.startsWith('data:')) { console.log('[autosave] using dataURL for fence', f.id);
      if (window.api && window.api.musicSave) {
        const ab = await (await fetch(src)).arrayBuffer();
        const id = await sha1OfArrayBuffer(ab);
        const name = f.audioName || 'track';
        const ext = name.includes('.') ? name.split('.').pop() : 'bin';
        if (await existsInLibraryById(id)) { f.audioSavedId = id; toast('Already in Library'); console.log('[autosave] already existed (dataURL)', id); return true; }
        const res = await window.api.musicSave({ id, name: name.replace(/\.[^/.]+$/, ''), ext, data: ab });
        if (res && res.ok) { f.audioSavedId = id; toast('Saved to Library'); console.log('[autosave] saved via IPC', id); return true; }
      } else {
        // Try dedupe by hash first
        const ab2 = await (await fetch(src)).arrayBuffer();
        const id2 = await sha1OfArrayBuffer(ab2);
        if (await existsInLibraryById(id2)) { f.audioSavedId = id2; toast('Already in Library'); console.log('[autosave] already existed (dataURL-fallback)', id2); return true; }
        const saved = await fallbackLibrarySaveFromDataUrl(src, f.audioName || 'track');
        if (saved && saved.ok) { f.audioSavedId = saved.id; toast('Saved to Library'); console.log('[autosave] saved via fallback(dataURL)', saved.id); return true; }
      }
    }
    // 3) If file:// source (Electron)
    if (src && src.startsWith('file://')) { console.log('[autosave] using file:// for fence', f.id);
      const path = src.replace('file://','');
      const name = (f.audioName || path.split('/').pop() || 'track');
      if (window.api && window.api.musicSavePath) {
        // compute hash by fetching locally is not possible from renderer; rely on savePath dedupe
        const r = await window.api.musicSavePath({ path, name });
        if (r && r.ok) { f.audioSavedId = r.id || true; toast('Saved to Library'); console.log('[autosave] saved via music-save-path', r.id); return true; }
      }
      // no IPC fallback for file path (cannot read file:// in browser); skip
    }
  } catch(e) { console.warn('ensureTrackSaved error', e); toast('Autosave error'); return false; }
  return false;
}

// Fallback: save directly from data URL (browser mode)
async function fallbackLibrarySaveFromDataUrl(dataUrl, name='track') {
  try {
    const ab = await (await fetch(dataUrl)).arrayBuffer();
    const file = new File([ab], name, { type: (dataUrl.split(';')[0] || 'audio/mpeg').replace('data:','') });
    return await fallbackLibrarySave(file);
  } catch (e) {
    console.warn('fallback save from data url failed', e);
    return { ok:false };
  }
}

function switchToFence(target) {
  const current = fences.find(x=>x.id===currentlyPlayingFenceId);
  if (target && current && current.id === target.id) {
    // Already on target
    return;
  }
  if (current) fadeOutFence(current, 800);
  if (target) { toast('Autosave check…'); (async()=>{ const ok = await ensureTrackSaved(target); highlightLibrary(!!ok); })(); fadeInFence(target, 800); }
}


// Find fence under a latlng (nearest center among those containing the point)
function findFenceAt(latlng) {
  const lat = latlng.lat, lng = latlng.lng;
  const candidates = [];
  for (const f of fences) {
    if (f.type==='circle') {
      const d = haversineMeters(lat, lng, f.center[0], f.center[1]);
      if (d <= f.radius) candidates.push({ f, dist: d });
    } else if (f.type==='rect') {
      const delta = metersDelta({lat:f.center[0],lng:f.center[1]}, {lat, lng});
      const a = toRad(f.angleDeg);
      const localX =  Math.cos(a)*delta.dx + Math.sin(a)*delta.dy;
      const localY = -Math.sin(a)*delta.dx + Math.cos(a)*delta.dy;
      if (Math.abs(localX) <= f.width/2 && Math.abs(localY) <= f.height/2) {
        const centerDist = Math.hypot(delta.dx, delta.dy);
        candidates.push({ f, dist: centerDist });
      }
    } else if (f.type==='poly') {
      if (pointInPolygon(lat, lng, f.vertices)) {
        const d = haversineMeters(lat, lng, f.center[0], f.center[1]);
        candidates.push({ f, dist: d });
      }
    }
  }
  candidates.sort((a,b)=>a.dist-b.dist);
  return candidates.length ? candidates[0].f : null;
}


// ===== Serialization helpers (internal only) =====
function updateShapeInfo(f) {
  if (f.type==='circle') shapeInfo.textContent = `Circle • radius ${Math.round(f.radius)} m`;
  else if (f.type==='rect') shapeInfo.textContent = `Rect • ${Math.round(f.width)}×${Math.round(f.height)} m @ ${Math.round(f.angleDeg)}°`;
  else shapeInfo.textContent = `Polygon • ${f.vertices.length} pts`;
}

// ===== Waypoints =====
function addWaypoint(latlng) {
  const id = `WP-${waypoints.length+1}`;
  const marker = L.marker(latlng, { draggable:true, title:id }).addTo(map);
  marker.bindTooltip(id, { permanent:true, direction:'top', offset:[0,-10] }).openTooltip();
  marker.on('dragend', ()=> updateWpSelect());
  waypoints.push({ id, latlng:[latlng.lat, latlng.lng], marker });
  updateWpSelect();
  toast(`Added ${id}`);
}
function clearWaypoints() {
  waypoints.forEach(wp => { try { map.removeLayer(wp.marker); } catch{} });
  waypoints = [];
  updateWpSelect();
  toast('Waypoints cleared');
}
function updateWpSelect() {
  wpSelect.innerHTML = '';
  waypoints.forEach((wp, idx) => {
    const opt = document.createElement('option');
    const lat = wp.marker.getLatLng().lat, lng = wp.marker.getLatLng().lng;
    opt.value = idx;
    opt.textContent = `${wp.id} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
    wpSelect.appendChild(opt);
  });
}
btnAddWP.addEventListener('click', ()=> addWaypoint(map.getCenter()));
btnClearWP.addEventListener('click', clearWaypoints);

// Sim buttons
btnSimGo.addEventListener('click', ()=>{
  if (!waypoints.length) return alert('Add a waypoint first.');
  if (!userMarker) { const c = map.getCenter(); updateUserMarker(c.lat, c.lng); }
  const idx = parseInt(wpSelect.value || '0', 10) || 0;
  const target = waypoints[idx].marker.getLatLng();
  const speed = Math.max(0.2, parseFloat(wpSpeed.value || '2.0'));
  startSimulation(userMarker.getLatLng(), target, speed);
});
btnSimStop.addEventListener('click', stopSimulation);
btnLibrary.addEventListener('click', async ()=>{ await window.api.openMusicWindow(); });

function clearRouteLines() {
  if (routePolyline) { try { map.removeLayer(routePolyline); } catch{}; routePolyline = null; }
  if (approachPolyline) { try { map.removeLayer(approachPolyline); } catch{}; approachPolyline = null; }
}

// OSRM helpers
async function osrmSnap(lat, lng) {
  const url = `https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('OSRM nearest failed');
  const data = await res.json();
  if (!data.waypoints || !data.waypoints[0]) throw new Error('No snap result');
  const wp = data.waypoints[0].location; // [lng, lat]
  return { lat: wp[1], lng: wp[0] };
}
async function osrmRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('OSRM route failed');
  const data = await res.json();
  if (!data.routes || !data.routes[0]) throw new Error('No route');
  const coords = data.routes[0].geometry.coordinates; // [lng,lat][]
  return coords.map(([lng, lat]) => ({ lat, lng }));
}
function pathLengthMeters(points) {
  let sum = 0;
  for (let i=1;i<points.length;i++) {
    sum += haversineMeters(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
  }
  return sum;
}
function interpolateAlongPath(points, distMeters) {
  let acc = 0;
  for (let i=1;i<points.length;i++) {
    const seg = haversineMeters(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
    if (acc + seg >= distMeters) {
      const t = (distMeters - acc) / seg;
      return {
        lat: points[i-1].lat + (points[i].lat - points[i-1].lat)*t,
        lng: points[i-1].lng + (points[i].lng - points[i-1].lng)*t
      };
    }
    acc += seg;
  }
  return points[points.length-1];
}

function startSimulation(from, to, speedMS) {
  stopSimulation();
  clearRouteLines();
  const stepMs = 100;

  const doStraight = async () => {
    const totalDist = haversineMeters(from.lat, from.lng, to.lat, to.lng);
    if (totalDist < 0.5) return;
    const steps = Math.ceil((totalDist / speedMS) * 1000 / stepMs);
    let t = 0;
    simTimer = setInterval(()=>{
      t += 1;
      const frac = Math.min(1, t/steps);
      const lat = from.lat + (to.lat - from.lat) * frac;
      const lng = from.lng + (to.lng - from.lng) * frac;
      updateUserMarker(lat, lng);
      checkFences(lat, lng);
      if (frac >= 1) stopSimulation();
    }, stepMs);
    toast('Simulation started (straight)');
  };

  const doRoads = async () => {
    try {
      const startSnap = await osrmSnap(from.lat, from.lng);
      const endSnap = await osrmSnap(to.lat, to.lng);

      const distToStart = haversineMeters(from.lat, from.lng, startSnap.lat, startSnap.lng);
      if (distToStart > 1) {
        approachPolyline = L.polyline([[from.lat,from.lng],[startSnap.lat,startSnap.lng]], { color:'#333', weight:3, dashArray:'6,6', className:'approach-line' }).addTo(map);
      }

      const path = await osrmRoute(startSnap, endSnap);
      if (!path || path.length < 2) { await doStraight(); return; }

      routePolyline = L.polyline(path.map(p=>[p.lat,p.lng]), { color:'#1976d2', weight:4, className:'route-line' }).addTo(map);

      const total = pathLengthMeters(path);
      if (total < 0.5) { await doStraight(); return; }
      let dist = 0;
      simTimer = setInterval(()=>{
        dist += speedMS * (stepMs/1000);
        const pos = interpolateAlongPath(path, Math.min(total, dist));
        updateUserMarker(pos.lat, pos.lng);
        checkFences(pos.lat, pos.lng);
        if (dist >= total) stopSimulation();
      }, stepMs);
      toast('Simulation started (roads)');
    } catch (e) {
      console.warn('Road sim failed, fallback to straight:', e);
      await doStraight();
    }
  };

  if (wpRoads && wpRoads.checked) doRoads();
  else doStraight();
}
function stopSimulation() {
  if (simTimer) clearInterval(simTimer);
  simTimer = null;
  clearRouteLines();
  toast('Simulation stopped');
}

// ===== Handles visibility/removal helpers =====
function showHandles(f, show) {
  if (!f.handles) return;
  Object.values(f.handles).forEach(h => {
    if (show) map.addLayer(h); else map.removeLayer(h);
  });
}
function removeHandles(f) {
  if (!f.handles) return;
  Object.values(f.handles).forEach(h => { try { map.removeLayer(h); } catch {} });
  f.handles = {};
}





// Apply track coming from Music Library (IPC)
window.api?.onApplyTrack?.((payload)=>{
  const { filePath, name, id } = payload || {};
  if (!selectedFence) { toast('Select a fence first.'); return; }
  if (selectedFence.audioEl) { try { selectedFence.audioEl.pause(); } catch{} }
  try {
    selectedFence.audioEl = new Audio('file://' + filePath);
    selectedFence.audioEl.loop = true;
    selectedFence.audioName = name;
    selectedFence.audioSavedId = id || true;
    selectedFence._audioFile = null;
    audioInfo.textContent = `Audio: ${name}`;
    toast('Track applied to fence.');
  } catch (e) {
    alert('Failed to apply track: ' + e);
  }
});




// ===== IndexedDB Library Fallback (large files safe) =====
let _idb_db = null;
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (_idb_db) return resolve(_idb_db);
    const req = indexedDB.open('gm_library_db', 1);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const store = db.createObjectStore('tracks', { keyPath: 'id' });
        store.createIndex('by_added', 'addedAt');
        store.createIndex('by_name', 'name');
      }
    };
    req.onsuccess = ()=>{ _idb_db = req.result; resolve(_idb_db); };
    req.onerror = (e)=> reject(e.target.error);
  });
}
async function idbSaveFile(file, id) {
  const db = await idbOpen();
  return new Promise(async (resolve, reject)=>{
    const tx = db.transaction('tracks', 'readwrite');
    const st = tx.objectStore('tracks');
    const name = file.name.replace(/\.[^/.]+$/, '');
    const mime = file.type || 'application/octet-stream';
    const addedAt = new Date().toISOString();
    const data = await file.arrayBuffer();
    const rec = { id, name, favorite:false, addedAt, mime, blob: new Blob([data], { type: mime }) };
    st.put(rec);
    tx.oncomplete = ()=> resolve({ ok:true, id });
    tx.onerror = (e)=> reject(e.target.error);
  });
}
async function idbList() {
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('tracks', 'readonly');
    const st = tx.objectStore('tracks');
    const req = st.getAll();
    req.onsuccess = ()=> resolve(req.result.sort((a,b)=> (a.addedAt < b.addedAt ? 1 : -1)));
    req.onerror = (e)=> reject(e.target.error);
  });
}
async function idbOpenTrack(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('tracks', 'readonly');
    const st = tx.objectStore('tracks');
    const req = st.get(id);
    req.onsuccess = ()=>{
      const it = req.result;
      if (!it) return resolve({ ok:false });
      const url = URL.createObjectURL(it.blob);
      resolve({ ok:true, dataUrl: url, name: it.name, id: it.id });
    };
    req.onerror = (e)=> reject(e.target.error);
  });
}
async function idbDelete(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('tracks', 'readwrite');
    const st = tx.objectStore('tracks');
    st.delete(id);
    tx.oncomplete = ()=> resolve({ ok:true });
    tx.onerror = (e)=> reject(e.target.error);
  });
}
async function idbToggleFav(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('tracks', 'readwrite');
    const st = tx.objectStore('tracks');
    const req = st.get(id);
    req.onsuccess = ()=>{
      const it = req.result; if (!it) return resolve({ ok:false });
      it.favorite = !it.favorite;
      st.put(it);
      tx.oncomplete = ()=> resolve({ ok:true, favorite: it.favorite });
      tx.onerror = (e)=> reject(e.target.error);
    };
    req.onerror = (e)=> reject(e.target.error);
  });
}
async function fallbackLibrarySave(file) {
  const buf = await file.arrayBuffer();
  const id = await sha1OfArrayBuffer(buf);
  // Save with IDB (no size limits like localStorage)
  await idbSaveFile(new File([buf], file.name, { type: file.type||'audio/mpeg' }), id);
  return { ok:true, id };
}
async function fallbackLibraryList() { return await idbList(); }
async function fallbackLibraryOpen(id) { return await idbOpenTrack(id); }
async function fallbackLibraryDelete(id) { return await idbDelete(id); }
async function fallbackLibraryToggleFav(id) { return await idbToggleFav(id); }
async function fallbackLibrarySaveFromDataUrl(dataUrl, name='track') {
  const ab = await (await fetch(dataUrl)).arrayBuffer();
  const mime = (dataUrl.split(';')[0] || 'audio/mpeg').replace('data:','');
  const file = new File([ab], name, { type: mime });
  return await fallbackLibrarySave(file);
}

function lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
async function arrayBufferToDataURL(buf, mime='audio/mpeg') {
  const blob = new Blob([buf], { type: mime });
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}
async function sha1OfArrayBuffer(buf) {
  const hashBuf = await crypto.subtle.digest('SHA-1', buf);
  const arr = Array.from(new Uint8Array(hashBuf));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}
async function fallbackLibrarySave(file) {
  const buf = await file.arrayBuffer();
  const id = await sha1OfArrayBuffer(buf);
  let lib = lsGet('gm_library', []);
  if (!lib.find(x => x.id === id)) {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const mime = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
    const dataUrl = await arrayBufferToDataURL(buf, mime);
    lib.unshift({ id, name: file.name.replace(/\.[^/.]+$/, ''), dataUrl, favorite:false, addedAt: new Date().toISOString() });
    lsSet('gm_library', lib);
  }
  return { ok:true, id };
}
async function fallbackLibraryList() { return lsGet('gm_library', []); }
async function fallbackLibraryOpen(id) {
  const it = lsGet('gm_library', []).find(x => x.id === id);
  if (!it) return { ok:false };
  return { ok:true, dataUrl: it.dataUrl, name: it.name, id: it.id };
}
async function fallbackLibraryDelete(id) {
  let lib = lsGet('gm_library', []);
  lib = lib.filter(x => x.id !== id);
  lsSet('gm_library', lib);
  return { ok:true };
}
async function fallbackLibraryToggleFav(id) {
  let lib = lsGet('gm_library', []);
  const it = lib.find(x => x.id === id);
  if (!it) return { ok:false };
  it.favorite = !it.favorite;
  lsSet('gm_library', lib);
  return { ok:true, favorite: it.favorite };
}


function highlightLibrary(ok=true) {
  const btn = document.getElementById('btnLibrary') || document.querySelector('#btnLibrary');
  if (!btn) return;
  btn.classList.remove('lib-ok','lib-fail');
  btn.classList.add(ok ? 'lib-ok' : 'lib-fail');
  setTimeout(()=>{ btn.classList.remove('lib-ok','lib-fail'); }, 1600);
}

// ===== Inline Music Library Panel =====
async function openLibraryPanel() {
  try {
    const panel = document.getElementById('libraryPanel');
    const body = document.getElementById('libBody');
    const search = document.getElementById('libSearch');
    const close = document.getElementById('libClose');
    panel.classList.remove('hidden');
    async function loadList() {
      body.innerHTML = '';
      let items = [];
      try {
        if (window.api && window.api.musicList) items = await window.api.musicList();
        else items = await fallbackLibraryList();
      } catch (e) {
        const div = document.createElement('div');
        div.className='lib-empty';
        div.textContent = 'Library API not available. Make sure you are running via Electron (npm start).';
        body.appendChild(div);
        return;
      }
      const q = (search.value||'').toLowerCase();
      const filtered = items.filter(it => !q || (it.name||'').toLowerCase().includes(q));
      if (!filtered.length) {
        const empty = document.createElement('div'); empty.className='lib-empty'; empty.textContent = q ? 'No results' : 'No tracks yet. Add audio to a fence to auto-save here.';
        body.appendChild(empty);
        return;
      }
      for (const it of filtered) {
        const card = document.createElement('div'); card.className='lib-card';
        const meta = document.createElement('div'); 
        const t = document.createElement('div'); t.className='lib-title'; t.textContent = it.name;
        const s = document.createElement('div'); s.className='lib-sub'; s.textContent = (it.favorite?'★ ':'') + it.filePath;
        meta.appendChild(t); meta.appendChild(s);
        const actions = document.createElement('div'); actions.className='lib-actions';
        const prev = document.createElement('button'); prev.textContent='Preview';
        const use = document.createElement('button'); use.textContent='Use';
        const fav = document.createElement('button'); fav.textContent = it.favorite ? '★ Unfavorite' : '☆ Favorite';
        const del = document.createElement('button'); del.textContent='Delete'; del.className='danger';

        let audio=null;
        prev.onclick = async ()=>{
          if (audio) { audio.pause(); audio=null; prev.textContent='Preview'; return; }
          let src = null;
          if (window.api && window.api.musicOpen) {
            const res = await window.api.musicOpen(it.id);
            if (!res.ok) return alert('Open failed');
            src = 'file://' + res.filePath;
          } else {
            const res = await fallbackLibraryOpen(it.id);
            if (!res.ok) return alert('Open failed');
            src = res.dataUrl;
          }
          audio = new Audio(src); audio.loop=true; audio.play(); prev.textContent='Stop';
        };
        use.onclick = async ()=>{
          if (!selectedFence) return alert('Select a fence first.');
          if (!window.api || !window.api.musicOpen) return alert('API missing.');
          const res = await window.api.musicOpen(it.id);
          if (!res.ok) return alert('Open failed');
          try {
            if (selectedFence.audioEl) { try { selectedFence.audioEl.pause(); } catch{} }
            selectedFence.audioEl = new Audio('file://' + res.filePath);
            selectedFence.audioEl.loop = true;
            selectedFence.audioName = it.name;
            selectedFence.audioSavedId = it.id;
            selectedFence._audioFile = null;
            audioInfo.textContent = `Audio: ${it.name}`;
            toast('Track applied to fence.');
          } catch (e) { alert('Apply error: ' + e); }
        };
        fav.onclick = async ()=>{
          if (window.api && window.api.musicToggleFav) {
            const r = await window.api.musicToggleFav(it.id);
            if (r.ok) loadList();
          } else {
            const r = await fallbackLibraryToggleFav(it.id);
            if (r.ok) loadList();
          }
        };
        del.onclick = async ()=>{
          if (window.api && window.api.musicDelete) { await window.api.musicDelete(it.id); }
          else { await fallbackLibraryDelete(it.id); }
          loadList();
        };

        card.appendChild(meta); card.appendChild(actions);
        actions.appendChild(prev); actions.appendChild(use); actions.appendChild(fav); actions.appendChild(del);
        body.appendChild(card);
      }
    }
    search.oninput = loadList;
    close.onclick = ()=> panel.classList.add('hidden');
    await loadList();
  } catch (e) {
    alert('Open Library error: ' + e);
  }
}
// Shortcut: Ctrl/Cmd+L opens the panel
window.addEventListener('keydown', (ev)=>{
  if ((ev.ctrlKey || ev.metaKey) && (ev.key==='l' || ev.key==='L')) {
    ev.preventDefault(); openLibraryPanel();
  }
});