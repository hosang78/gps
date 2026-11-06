import { apiBase } from './config.js';

const $ = id => document.getElementById(id);
const cars = [['cold-01','페라리 01'],['fresh-02','제네시스 02'],['work-03','업무용 탑차 03']];
const prefix = 'suhyup.fleet.v1.';
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(prefix + key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, value) { localStorage.setItem(prefix + key, JSON.stringify(value)); }
const savedTrip = read('active',null);
const previousTrip = savedTrip?.real ? savedTrip : read('pendingStart',null);
let active = previousTrip?.real ? {
  ...previousTrip, server:previousTrip.server ?? true,
  registered:previousTrip.registered ?? Boolean(savedTrip?.real), sent:previousTrip.sent || 0
} : null;
let selected = active?.vehicle || cars[0][0];
let records = read('gpsRecords',[]);
const parkingByVehicle = read('parkingByVehicle',{});
let points = active?.points || [];
let code = read('code','') || sessionStorage.getItem(prefix+'code') || '';
let cloudRecords = [], review, busy = false, syncTask, map, mapGeneration = 0;
let period = 'today', reviewRequest = 0;
let watchId, sampler, syncTimer, clock, latest;
let positionRequest, currentStops = [], kakaoLoad;
const stopNames = new Map(), stopLookups = new Set();
let timeline = [], selectedEvent, pendingMapPoint;
const eventRows = new Map();
let mapInteractive = false, replay;
const name = id => cars.find(([key]) => key === id)?.[1] || id;
const image = id => './vehicles/' + id + '-photo.webp';
const formatTime = value => new Date(value).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });

function vehicleVisual(id) {
  const visual = document.createElement('span'), img = document.createElement('img');
  visual.className = 'vehicle-visual';
  visual.dataset.vehicle = id;
  img.src = image(id);
  img.alt = '';
  visual.append(img);
  return visual;
}

function vehiclePin() {
  const pin = document.createElement('div');
  pin.className = 'vehicle-pin';
  pin.append(vehicleVisual(selected));
  return pin;
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function meters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function routeGroups(list) {
  const groups = [];
  for (const point of list) {
    const group = groups.at(-1);
    if (!group || point.ts - group.at(-1).ts > 15000) groups.push([point]);
    else group.push(point);
  }
  return groups;
}
function kilometers(list) {
  return routeGroups(list).reduce((sum, group) => sum + group.reduce((total, p, i) => total + (i ? meters(group[i-1], p) : 0), 0), 0) / 1000;
}
function duration(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000), hours = Math.floor(s / 3600);
  const clock = [Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2,'0')).join(':');
  return hours ? hours + ':' + clock : clock;
}

function findStops(list) {
  const stops = [];
  let anchor, last;
  const closeStop = () => {
    if (anchor && last.ts-anchor.ts >= 5*60000) stops.push({point:anchor,start:anchor.ts,end:last.ts});
  };
  for (const point of list) {
    if (!Number.isFinite(point.accuracy) || point.accuracy > 30) continue;
    if (!anchor || point.ts-last.ts > 15000 || meters(anchor,point) > 30) {
      closeStop();
      anchor = point;
    }
    last = point;
  }
  closeStop();
  return stops;
}

// Speed at each point from its neighbours, which evens out a single noisy GPS fix.
function pointSpeeds(list) {
  return list.map((p,i) => {
    const a = list[i-1], b = list[i+1];
    const from = a && p.ts-a.ts <= 15000 ? a : p, to = b && b.ts-p.ts <= 15000 ? b : p;
    return from === to ? 0 : meters(from,to) / ((to.ts-from.ts)/1000) * 3.6;
  });
}
function speedLimit() {
  const value = Number(read('speedLimit',80));
  return Number.isInteger(value) && value >= 20 && value <= 200 ? value : 80;
}
const speedColors = ['#2f9e8f','#087cbd','#e39b2d','#d23f4e'];
function speedBand(speed, limit) {
  return speed >= limit ? 3 : speed >= Math.min(60,limit) ? 2 : speed >= Math.min(30,limit) ? 1 : 0;
}

// Saved trips are drawn in speed colours; a live trip keeps one plain line.
function routeSegments(list) {
  if (!review || review.parking) return routeGroups(list).map(group => ({color:speedColors[1],points:group}));
  const speeds = pointSpeeds(list), limit = speedLimit(), segments = [];
  let current;
  for (let i = 0; i < list.length; i++) {
    const a = list[i-1], b = list[i];
    if (!a || b.ts-a.ts > 15000) {
      current = {color:speedColors[0],points:[b]};
      segments.push(current);
      continue;
    }
    const color = speedColors[speedBand((speeds[i-1]+speeds[i])/2,limit)];
    if (current.points.length > 1 && current.color === color) current.points.push(b);
    else if (current.points.length === 1) { current.color = color; current.points.push(b); }
    else { current = {color,points:[a,b]}; segments.push(current); }
  }
  return segments;
}

function speedEvents(list, speeds, limit) {
  const events = [];
  let run;
  const close = () => {
    if (run && run.last.ts-run.first.ts >= 5000) events.push({id:'speed-'+run.first.ts,kind:'speed',
      at:run.first.ts,until:run.last.ts,point:run.peak,top:run.top,
      title:'과속 구간',label:'과속 '+Math.round(run.top)});
    run = undefined;
  };
  list.forEach((p,i) => {
    if (run && p.ts-run.last.ts > 15000) close();
    if (speeds[i] < limit || !(p.accuracy <= 30)) return close();
    run ??= {first:p,top:0};
    run.last = p;
    if (speeds[i] > run.top) { run.top = speeds[i]; run.peak = p; }
  });
  close();
  return events;
}

function timelineClock(ts, seconds = false) {
  return new Date(ts).toLocaleTimeString('ko-KR',{
    hour:'2-digit',minute:'2-digit',...(seconds ? {second:'2-digit'} : {}),hourCycle:'h23'
  });
}

function tripTimeline(trip,list,stops) {
  const first = list[0], last = list.at(-1);
  const start = new Date(trip.start).getTime(), end = trip.end ? new Date(trip.end).getTime() : last.ts;
  const events = [{id:'departure',kind:'start',at:first.ts,point:first,title:'출발 위치',label:'출발'}];
  if (trip.end) events.push({id:'arrival',kind:'end',at:last.ts,point:last,title:'도착 위치',label:'도착'});
  if (trip.end && first === last) events.splice(0,2,{
    id:'arrival',kind:'end',at:last.ts,point:last,title:'출발·도착 위치',label:'출발·도착'
  });
  stops.forEach((stop,i) => events.push({id:'stop-'+i,kind:'stop',at:stop.start,point:stop.point,
    until:stop.end,title:'주요 정차 '+(i+1),label:'정차 '+Math.floor((stop.end-stop.start)/60000)+'분'}));

  const gap = (from,to) => {
    if (to-from > 15000) events.push({id:'gap-'+from,kind:'gap',at:from,until:to,title:'GPS 기록 공백'});
  };
  gap(start,first.ts);
  for (let i=1;i<list.length;i++) gap(list[i-1].ts,list[i].ts);
  gap(last.ts,end);
  let cursor = 0;
  const firstTick = Math.max(1,Math.ceil((first.ts-15000-start)/600000));
  const limit = Math.min(end,last.ts+15001);
  for (let tick=firstTick, target=start+tick*600000; target<limit; tick++,target+=600000) {
    while (cursor<list.length && list[cursor].ts<target) cursor++;
    const before = list[cursor-1], after = list[cursor];
    if (before && after && after.ts !== target && after.ts-before.ts > 15000) continue;
    if (!before && after?.ts !== target && first.ts-start > 15000 || !after && end-last.ts > 15000) continue;
    const point = !after || before && target-before.ts < after.ts-target ? before : after;
    if (!point || Math.abs(point.ts-target)>15000) continue;
    const minute = tick*10;
    events.push({id:'tick-'+minute,kind:'tick',at:target,point,title:'출발 후 '+minute+'분',label:timelineClock(target)});
  }
  events.push(...speedEvents(list,pointSpeeds(list),speedLimit()));
  return events.sort((a,b) => a.at-b.at);
}

function highlightTimeline(id, source) {
  const event = timeline.find(item => item.id === id);
  if (!event?.point) return;
  selectedEvent = id;
  pendingMapPoint = event.point;
  applyTimelineSelection();
  const row = eventRows.get(id), list = $('timelineList');
  if (row) {
    const item = row.getBoundingClientRect(), pane = list.getBoundingClientRect();
    if (item.top < pane.top || item.bottom > pane.bottom) list.scrollTop += item.top-pane.top-10;
  }
  if (source !== 'map') map?.focus?.(event.point);
}

function applyTimelineSelection() {
  for (const [id,row] of eventRows) {
    row.classList.toggle('is-selected',id === selectedEvent);
    if (id === selectedEvent) row.setAttribute('aria-current','true');
    else row.removeAttribute('aria-current');
  }
  $('map').querySelectorAll('[data-event-id]').forEach(pin => {
    pin.classList.toggle('is-selected',pin.dataset.eventId === selectedEvent);
    pin.setAttribute('aria-pressed',String(pin.dataset.eventId === selectedEvent));
  });
}

function routePins(list) {
  if (timeline.length) return timeline.filter(event => event.point)
    .map(event => ({...event,eventId:event.id}));
  const pins = currentStops.map((stop,i) => ({point:stop.point,kind:'stop',label:'정차 '+(i+1)}));
  if (!review?.end || !list.length) return pins;
  const first = list[0], last = list.at(-1);
  if (review.parking) return [{point:last,kind:'parking',label:'마지막 위치'}];
  if (meters(first,last) < 12) return [...pins,{point:last,kind:'end',label:'출발·도착'}];
  return [...pins,{point:first,kind:'start',label:'출발'},{point:last,kind:'end',label:'도착'}];
}

function pinLabel({kind,label,eventId,title}) {
  const node = document.createElement(eventId ? 'button' : 'span');
  node.className = 'route-pin ' + kind;
  node.textContent = label;
  if (eventId) {
    node.type = 'button';
    node.dataset.eventId = eventId;
    node.setAttribute('aria-label',title);
    node.setAttribute('aria-pressed',String(eventId === selectedEvent));
    node.classList.toggle('is-selected',eventId === selectedEvent);
    node.onclick = event => { event.stopPropagation(); highlightTimeline(eventId,'map'); };
  }
  return node;
}

function fallbackMap(container) {
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  overlay.className = 'canvas-pins';
  container.replaceChildren(canvas,overlay);
  let project, cursorPin;
  return { update(list, fit, pins) {
    const width = container.clientWidth, height = container.clientHeight, ratio = devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
    overlay.replaceChildren();
    ctx.scale(ratio,ratio);
    ctx.fillStyle = '#e8f1f6';
    ctx.fillRect(0,0,width,height);
    ctx.strokeStyle = '#d1e1eb';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 25) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,height); ctx.stroke(); }
    for (let y = 0; y < height; y += 25) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke(); }
    if (!list.length) return;
    const lats = list.map(p => p.lat), lngs = list.map(p => p.lng);
    const minLat = Math.min(...lats), minLng = Math.min(...lngs);
    const scale = Math.min((height-52)/Math.max(.0002,Math.max(...lats)-minLat), (width-52)/Math.max(.0002,Math.max(...lngs)-minLng));
    const xy = project = p => [26+(p.lng-minLng)*scale,height-26-(p.lat-minLat)*scale];
    ctx.lineWidth = 4;
    for (const {color,points:group} of routeSegments(list)) {
      ctx.strokeStyle = color;
      ctx.beginPath(); group.forEach((p,i) => i ? ctx.lineTo(...xy(p)) : ctx.moveTo(...xy(p))); ctx.stroke();
    }
    if (pins.length) {
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      for (const pin of pins) {
        const {point,kind,label} = pin;
        const [x,y] = xy(point);
        if (pin.eventId) {
          const element = pinLabel(pin);
          element.style.left = Math.max(26,Math.min(width-26,x))+'px';
          element.style.top = Math.max(15,Math.min(height-15,y+(kind === 'stop' ? 15 : -8)))+'px';
          overlay.append(element);
        } else {
          ctx.fillStyle = {start:'#21613f',end:'#954130',parking:'#14589d',stop:'#775217'}[kind];
          ctx.fillText(label, Math.max(32,Math.min(width-32,x)), y+(kind === 'stop' ? 15 : -5));
        }
      }
    }
    if (!pins.some(pin => pin.kind !== 'stop')) {
      ctx.font = '24px system-ui';
      ctx.fillText(({ 'cold-01':'🏎️', 'fresh-02':'🚘', 'work-03':'🚚' })[selected] || '🚘', ...xy(list.at(-1)));
    }
  }, cursor(point) {
    if (!point || !project) { cursorPin?.remove(); cursorPin = null; return; }
    if (!cursorPin) { cursorPin = vehiclePin(); cursorPin.classList.add('canvas-cursor'); }
    if (!overlay.contains(cursorPin)) overlay.append(cursorPin);
    const [x,y] = project(point);
    cursorPin.style.left = x+'px';
    cursorPin.style.top = y+'px';
  }, destroy() { canvas.remove(); overlay.remove(); } };
}
function osmMap(container, center) {
  const leaflet = window.L;
  if (!leaflet) {
    $('mapNote').textContent = '지도 연결 대기 · 경로만 표시';
    return fallbackMap(container);
  }
  const view = leaflet.map(container,{
    dragging:false,scrollWheelZoom:false,touchZoom:false,keyboard:false,
    doubleClickZoom:false,boxZoom:false,tapHold:false
  }).setView(center,17);
  const layer = leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(view);
  layer.once('tileerror', () => { $('mapNote').textContent = '일부 배경 지도를 불러오지 못했습니다. 경로는 계속 기록됩니다.'; });
  const route = leaflet.layerGroup().addTo(view);
  const labels = leaflet.layerGroup().addTo(view);
  const icon = () => leaflet.divIcon({html:vehiclePin(),className:'',iconSize:[40,30],iconAnchor:[20,15]});
  const marker = leaflet.marker(center, {icon:icon(), interactive:false, opacity:0}).addTo(view);
  let last, markerVehicle = selected, cursorMarker;
  return { update(list, fit, pins) {
    route.clearLayers();
    for (const {color,points:group} of routeSegments(list)) {
      leaflet.polyline(group.map(p => [p.lat,p.lng]),{color,weight:5}).addTo(route);
    }
    labels.clearLayers();
    for (const pin of pins) {
      const labelIcon = leaflet.divIcon({html:pinLabel(pin),className:'',iconSize:[1,1],
        iconAnchor:[{start:34,end:3,tick:-7}[pin.kind] ?? 18,pin.kind === 'stop' ? -16 : 14]});
      leaflet.marker([pin.point.lat,pin.point.lng],{icon:labelIcon,interactive:Boolean(pin.eventId),keyboard:false}).addTo(labels);
    }
    const point = list.at(-1);
    marker.setOpacity(point && !pins.some(pin => pin.kind !== 'stop') ? 1 : 0);
    if (!point) { last = null; return; }
    if (markerVehicle !== selected) { marker.setIcon(icon()); markerVehicle = selected; }
    const pos = [point.lat,point.lng];
    marker.setLatLng(pos);
    if (fit && list.length > 1) {
      view.invalidateSize?.({pan:false});
      view.fitBounds(leaflet.latLngBounds(list.map(p => [p.lat,p.lng])), {maxZoom:17,padding:[42,32]});
    }
    else if (last !== point) view.panTo(pos);
    last = point;
  }, cursor(point) {
    if (!point) { cursorMarker?.remove(); cursorMarker = null; return; }
    const pos = [point.lat,point.lng];
    if (!cursorMarker) cursorMarker = leaflet.marker(pos,{icon:icon(),interactive:false,zIndexOffset:1000}).addTo(view);
    else cursorMarker.setLatLng(pos);
    if (!view.getBounds().contains(pos)) view.panTo(pos);
  }, setInteractive(enabled) {
    for (const handler of [view.dragging,view.scrollWheelZoom,view.touchZoom,view.keyboard,view.doubleClickZoom]) {
      if (enabled) handler?.enable();
      else handler?.disable();
    }
  }, focus(point) { view.setView([point.lat,point.lng],17); }, destroy() { view.remove(); } };
}
function kakaoMap(container, maps, center) {
  const coords = p => new maps.LatLng(p.lat,p.lng);
  const view = new maps.Map(container,{
    center:new maps.LatLng(...center),level:4,draggable:false,zoomable:false,keyboardShortcuts:false
  });
  const marker = new maps.CustomOverlay({position:new maps.LatLng(...center),content:vehiclePin(),yAnchor:.5});
  let lines = [], labels = [], last, markerVehicle = selected, cursorPin;
  return { update(list, fit, pins) {
    lines.forEach(line => line.setMap(null));
    lines = routeSegments(list).map(({color,points:group}) => new maps.Polyline({
      map:view,path:group.map(coords),strokeColor:color,strokeWeight:5
    }));
    labels.forEach(label => label.setMap(null));
    labels = pins.map(pin => new maps.CustomOverlay({
      map:view,position:coords(pin.point),content:pinLabel(pin),clickable:Boolean(pin.eventId),
      xAnchor:{start:.97,end:.07,tick:0}[pin.kind] ?? .5,yAnchor:pin.kind === 'stop' ? -.8 : .8,zIndex:2
    }));
    const point = list.at(-1);
    marker.setMap(point && !pins.some(pin => pin.kind !== 'stop') ? view : null);
    if (!point) { last = null; return; }
    if (markerVehicle !== selected) { marker.setContent(vehiclePin()); markerVehicle = selected; }
    const pos = coords(point);
    marker.setPosition(pos);
    if (fit && list.length > 1) {
      view.relayout?.();
      const bounds = new maps.LatLngBounds();
      list.forEach(p => bounds.extend(coords(p)));
      view.setBounds(bounds);
    } else if (last !== point) view.panTo(pos);
    last = point;
  }, setInteractive(enabled) {
    view.setDraggable?.(enabled);
    view.setZoomable?.(enabled);
    view.setKeyboardShortcuts?.(enabled);
  }, cursor(point) {
    if (!point) { cursorPin?.setMap(null); cursorPin = null; return; }
    const pos = coords(point);
    if (!cursorPin) cursorPin = new maps.CustomOverlay({map:view,position:pos,content:vehiclePin(),yAnchor:.5,zIndex:3});
    else cursorPin.setPosition(pos);
    if (!view.getBounds().contain(pos)) view.panTo(pos);
  }, focus(point) { view.setLevel?.(3); view.panTo(coords(point)); }, destroy() {
    lines.forEach(line => line.setMap(null));
    cursorPin?.setMap(null);
    labels.forEach(label => label.setMap(null));
    marker.setMap(null);
    container.replaceChildren();
  } };
}
function loadKakao(key) {
  if (kakaoLoad?.key === key) return kakaoLoad.promise;
  const promise = new Promise((resolve,reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('지도 응답 시간 초과')),8000);
    script.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=' + encodeURIComponent(key);
    script.onerror = () => { clearTimeout(timer); reject(new Error('카카오 지도 연결 실패')); };
    script.onload = () => {
      if (!window.kakao?.maps?.load) { clearTimeout(timer); reject(new Error('카카오 지도 권한 확인 필요')); return; }
      window.kakao.maps.load(() => { clearTimeout(timer); resolve(window.kakao.maps); });
    };
    document.head.append(script);
  });
  kakaoLoad = {key,promise};
  return promise;
}

async function lookupStop(point, key, lookupId) {
  stopLookups.add(lookupId);
  try {
    const {services} = await loadKakao(key);
    if (!services?.Geocoder || key !== read('kakaoKey','')) return;
    const address = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(null),8000);
      new services.Geocoder().coord2Address(point.lng,point.lat,(results,status) => {
        clearTimeout(timeout);
        resolve(status === services.Status.OK ? results?.[0] : null);
      });
    });
    const road = address?.road_address;
    const street = road?.address_name || address?.address?.address_name || '';
    stopNames.set(lookupId,{building:road?.building_name?.trim() || '',street});
  } catch {
    stopNames.set(lookupId,null);
  } finally {
    stopLookups.delete(lookupId);
    if (!stopNames.has(lookupId)) stopNames.set(lookupId,null);
    if (key === read('kakaoKey','') && (review || currentStops.length)) {
      renderStops();
      for (const event of timeline) {
        const detail = eventRows.get(event.id)?.querySelector('small');
        if (detail) detail.textContent = timelineDetail(event);
      }
      updateUI();
    }
  }
}

// Building or address from Kakao, or '' until the lookup finishes (or without a Kakao key).
function placeName(point,key = read('kakaoKey','')) {
  const coordinates = point.lat.toFixed(5)+', '+point.lng.toFixed(5);
  const lookupId = key+'|'+coordinates;
  if (key && !stopNames.has(lookupId) && !stopLookups.has(lookupId)) lookupStop(point,key,lookupId);
  const place = stopNames.get(lookupId);
  return place?.building ? place.building+' 인근'+(place.street ? ' · '+place.street : '')
    : place?.street || '';
}

function stopPlace(point,key) {
  return placeName(point,key) || 'GPS 좌표 '+point.lat.toFixed(5)+', '+point.lng.toFixed(5);
}

function renderStops() {
  $('stopDetails').hidden = !currentStops.length || Boolean(timeline.length);
  const list = $('stopList'), key = read('kakaoKey','');
  list.replaceChildren();
  currentStops.forEach(({point,start,end},i) => {
    const item = document.createElement('li'), title = document.createElement('strong'), location = document.createElement('small');
    const minutes = Math.floor((end-start)/60000), seconds = Math.floor((end-start)/1000)%60;
    title.textContent = '정차 '+(i+1)+' · '+minutes+'분'+(seconds ? ' '+seconds+'초' : '');
    location.textContent = stopPlace(point,key)+' · '+formatTime(start)+' ~ '+formatTime(end);
    item.append(title,location);
    list.append(item);
  });
}

function timelineDetail(event) {
  if (event.kind === 'gap') return timelineClock(event.at,true)+' ~ '+timelineClock(event.until,true);
  if (event.kind === 'stop') return stopPlace(event.point,read('kakaoKey',''))
    +' · '+timelineClock(event.at,true)+' ~ '+timelineClock(event.until,true);
  if (event.kind === 'speed') return '최고 '+Math.round(event.top)+' km/h · '
    +timelineClock(event.at,true)+' ~ '+timelineClock(event.until,true)
    +(placeName(event.point) ? ' · '+placeName(event.point) : '');
  const place = event.kind === 'start' || event.kind === 'end' ? placeName(event.point) : '';
  return (place ? place+' · ' : '')+'GPS '+timelineClock(event.point.ts,true)+' · 정확도 ±'+Math.round(event.point.accuracy)+'m';
}

function renderTimeline() {
  const list = $('timelineList'), fragment = document.createDocumentFragment();
  $('timelinePanel').hidden = !timeline.length;
  $('routeLayout').classList.toggle('has-timeline',Boolean(timeline.length));
  eventRows.clear();
  let longest;
  for (const event of timeline) {
    const item = document.createElement('li');
    const row = document.createElement(event.point ? 'button' : 'div');
    const clock = document.createElement('time'), content = document.createElement('span');
    const title = document.createElement('strong'), detail = document.createElement('small');
    row.className = 'timeline-entry '+event.kind;
    clock.textContent = timelineClock(event.at);
    title.textContent = event.title+(event.kind === 'stop' ? ' · '+Math.floor((event.until-event.at)/60000)+'분' : '');
    detail.textContent = timelineDetail(event);
    content.append(title,detail);
    row.append(clock,content);
    if (event.point) {
      row.type = 'button';
      row.onclick = () => highlightTimeline(event.id,'timeline');
      eventRows.set(event.id,row);
    }
    if (event.kind === 'stop' && (!longest || event.until-event.at > longest.until-longest.at)) longest = event;
    item.append(row);
    fragment.append(item);
  }
  list.replaceChildren(fragment);
  const button = $('longestStop');
  button.hidden = !longest;
  button.onclick = longest ? () => highlightTimeline(longest.id,'timeline') : null;
  applyTimelineSelection();
}

function setMapInteraction(enabled) {
  mapInteractive = enabled && Boolean(map?.setInteractive);
  $('mapTools').hidden = !map?.setInteractive;
  $('map').classList.toggle('map-interactive',mapInteractive);
  $('mapGesture').setAttribute('aria-pressed',String(mapInteractive));
  $('mapGestureHint').textContent = mapInteractive ? '지도를 이동하거나 확대할 수 있습니다.' : '지도를 쓸어도 화면이 스크롤됩니다.';
  map?.setInteractive?.(mapInteractive);
}

function renderReplay(status) {
  $('replayToggle').textContent = replay ? '재생 정지' : '경로 재생';
  $('replayToggle').setAttribute('aria-pressed',String(Boolean(replay)));
  if (status !== undefined) $('replayStatus').textContent = status;
}

function stopReplay() {
  if (!replay) return;
  cancelAnimationFrame(replay.frame);
  replay = undefined;
  map?.cursor?.(null);
  renderReplay('');
}

// Moves the vehicle along the saved route, faster than real time; GPS gaps are skipped.
function startReplay() {
  stopReplay();
  const list = points, speeds = pointSpeeds(list);
  if (list.length < 2 || !map?.cursor) return;
  const run = replay = {index:0,time:list[0].ts,last:performance.now()};
  const frame = now => {
    if (replay !== run) return;
    run.time += (now-run.last) * Number($('replaySpeed').value);
    run.last = now;
    let i = run.index;
    while (i < list.length-1 && list[i+1].ts <= run.time) i++;
    if (i < list.length-1 && list[i+1].ts-list[i].ts > 15000) run.time = list[++i].ts;
    run.index = i;
    const a = list[i], b = list[i+1];
    const t = b ? Math.min(1,Math.max(0,(run.time-a.ts)/(b.ts-a.ts))) : 0;
    map.cursor(b ? {lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t} : a);
    const speed = b ? speeds[i]+(speeds[i+1]-speeds[i])*t : speeds[i];
    if (!b) {
      replay = undefined;
      renderReplay('재생 끝 · '+timelineClock(a.ts,true));
      return;
    }
    renderReplay(timelineClock(run.time,true)+' · '+Math.round(speed)+' km/h');
    run.frame = requestAnimationFrame(frame);
  };
  run.frame = requestAnimationFrame(frame);
  renderReplay();
}

function renderSpeedInfo() {
  const show = Boolean(review && !review.parking && points.length > 1);
  $('speedLegend').hidden = !show;
  if (!show) { $('speedSummary').textContent = ''; return; }
  const limit = speedLimit(), low = Math.min(30,limit), mid = Math.min(60,limit);
  const legend = ['속도(km/h)',low+' 미만',low+'~'+mid,mid+'~'+limit,limit+' 이상 과속'].map((text,i) => {
    const item = document.createElement('span');
    if (i) item.style.setProperty('--speed',speedColors[i-1]);
    item.textContent = text;
    return item;
  });
  $('speedLegend').replaceChildren(...legend);
  const speeds = pointSpeeds(points).filter((speed,i) => points[i].accuracy <= 30);
  const hours = (new Date(review.end || points.at(-1).ts)-new Date(review.start)) / 3600000;
  const overs = timeline.filter(event => event.kind === 'speed').length;
  $('speedSummary').textContent = '최고 '+Math.round(Math.max(0,...speeds))+' km/h · 평균 '
    +Math.round(hours > 0 ? kilometers(points)/hours : 0)+' km/h · '
    +(overs ? '과속 '+overs+'회' : '과속 없음')+' (기준 '+limit+' km/h)';
}

function clearMap() {
  stopReplay();
  renderReplay('');
  mapGeneration++;
  map?.destroy();
  map = undefined;
  setMapInteraction(false);
  $('map').hidden = true;
  $('mapNote').hidden = true;
  $('mapWaiting').hidden = false;
  currentStops = [];
  timeline = [];
  selectedEvent = pendingMapPoint = undefined;
  renderTimeline();
  renderStops();
  renderSpeedInfo();
}

function drawMap(fit = false) {
  const first = points[0];
  if (!first) return;
  currentStops = review?.parking ? [] : findStops(points);
  timeline = review && !review.parking ? tripTimeline(review,points,currentStops) : [];
  renderTimeline();
  renderStops();
  renderSpeedInfo();
  if (map) {
    map.update(points,fit,routePins(points));
    return;
  }
  const generation = ++mapGeneration;
  const container = $('map'), center = [first.lat,first.lng];
  container.hidden = false;
  $('mapWaiting').hidden = true;
  $('mapNote').hidden = false;
  $('mapNote').textContent = 'OpenStreetMap';
  map = osmMap(container,center);
  setMapInteraction(false);
  map.update(points,fit,routePins(points));
  const key = read('kakaoKey','');
  if (!key) return;
  loadKakao(key).then(maps => {
    if (generation !== mapGeneration) return;
    const last = points.at(-1);
    stopReplay();
    map.destroy();
    map = undefined;
    container.replaceChildren();
    try {
      map = kakaoMap(container,maps,[last.lat,last.lng]);
      map.update(points,fit || Boolean(review),routePins(points));
    } catch (error) {
      // The SDK loaded but could not draw (e.g. the map service is off for this key): keep OpenStreetMap.
      try { map?.destroy(); } catch { /* Already broken. */ }
      container.replaceChildren();
      map = osmMap(container,[last.lat,last.lng]);
      map.update(points,fit || Boolean(review),routePins(points));
      setMapInteraction(mapInteractive);
      throw error;
    }
    setMapInteraction(mapInteractive);
    $('mapNote').textContent = '카카오맵';
    if (pendingMapPoint) map.focus(pendingMapPoint);
  }).catch(() => {
    if (generation === mapGeneration) $('mapNote').textContent = '카카오맵 연결 실패 · OpenStreetMap 사용 중';
  });
}

async function api(path, body, token = code) {
  if (!apiBase) throw new Error('기록 서버를 연결할 수 없습니다.');
  const headers = { Authorization:'Bearer ' + token };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiBase + path, {method:body ? 'POST':'GET', headers,
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(15000)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '서버 응답 오류(' + response.status + ')입니다.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function persist() {
  if (active) save('active',active);
  else localStorage.removeItem(prefix+'active');
}

function updateUI() {
  for (const btn of $('vehicles').children) {
    btn.disabled = Boolean(active) || busy;
    btn.setAttribute('aria-pressed',String(btn.dataset.vehicle === selected));
  }
  $('action').disabled = busy;
  $('parking').disabled = Boolean(active) || busy;
  $('action').textContent = active ? '운행 종료' : '운행 시작';
  $('action').classList.toggle('stop',Boolean(active));
  const last = points.at(-1), previous = points.at(-2);
  const fresh = last && Date.now()-last.ts <= 15000;
  const lastStop = currentStops.at(-1);
  const stopped = active && fresh && lastStop && last.ts-lastStop.end <= 15000 && meters(lastStop.point,last) <= 30;
  const moving = Boolean(active && fresh && !stopped && previous && last.ts-previous.ts <= 15000 && meters(previous,last) > 5);
  const vehicleImage = $('truck');
  const src = image(selected);
  if (vehicleImage.getAttribute('src') !== src) vehicleImage.src = src;
  const visual = $('rideVisual');
  visual.dataset.vehicle = selected;
  visual.classList.toggle('is-moving',moving);
  $('vehicleName').textContent = name(selected);
  $('state').textContent = active ? (fresh ? (stopped ? '장시간 정차 중' : moving ? '이동 중' : '위치 수신 완료') : 'GPS 위치 수신 중')
    : review?.parking ? '마지막 주차 위치' : review ? '저장된 운행' : '운행 대기';
  const elapsed = active ? Date.now()-active.start : review ? new Date(review.end)-new Date(review.start) : 0;
  $('metrics').textContent = review?.parking
    ? formatTime(last.ts)
    : duration(elapsed) + ' · ' + kilometers(points).toFixed(2) + ' km';
  const parkedAt = review?.parking && last ? placeName(last) : '';
  $('freshness').textContent = parkedAt ? parkedAt+' · 정확도 ±'+Math.round(last.accuracy)+'m'
    : last
    ? (review ? '기록 위치 ' : '최근 위치 ') + new Date(last.ts).toLocaleTimeString('ko-KR') + ' · 정확도 ±' + Math.round(last.accuracy) + 'm'
    : active ? '휴대폰에서 받은 첫 위치를 기다립니다.' : '운행을 시작하면 GPS를 켭니다.';
  updateAwakeNote();
  $('mapWaiting').textContent = active ? '현재 위치를 확인하고 있습니다.' : review ? '저장된 위치가 없습니다.' : '운행을 시작하면 현재 위치를 표시합니다.';
}

function sample(requestFresh = true) {
  if (!active || active.ending || document.hidden || !latest || points.length >= 8640) return;
  const previous = points.at(-1);
  if (Date.now()-latest.ts > 12000 || previous && latest.ts <= previous.ts) {
    if (requestFresh) requestStationaryFix(active);
    return;
  }
  if (previous && latest.ts-previous.ts <= 15000 && meters(previous,latest) / ((latest.ts-previous.ts)/1000) > 62) return;
  points.push({...latest,seq:points.length});
  try { persist(); }
  catch { message('기기 저장 공간을 확인해 주세요.',true); }
  drawMap();
  updateUI();
}

function acceptPosition(pos,trip,requested = false) {
  if (active !== trip) return;
  const {latitude:lat,longitude:lng,accuracy} = pos.coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) ||
      !Number.isFinite(pos.timestamp) || pos.timestamp < trip.start-1000) return;
  if (accuracy > 100) {
    message('GPS 정확도를 높이는 중입니다. 실내라면 창가나 실외에서 다시 확인해 주세요.');
    return;
  }
  if (!latest || pos.timestamp > latest.ts) latest = {lat,lng,accuracy,ts:pos.timestamp};
  if (requested || !points.length || Date.now()-points.at(-1).ts > 15000) sample(false);
  if (points.length) message('');
}

function requestStationaryFix(trip) {
  const gps = navigator.geolocation;
  if (positionRequest || !gps.getCurrentPosition) return;
  positionRequest = trip;
  const clearRequest = () => { if (positionRequest === trip) positionRequest = null; };
  gps.getCurrentPosition(pos => {
    clearRequest();
    acceptPosition(pos,trip,true);
  },clearRequest,{enableHighAccuracy:true,maximumAge:0,timeout:9000});
}

function startTimers() {
  const trip = active;
  watchId = navigator.geolocation.watchPosition(pos => acceptPosition(pos,trip),error => {
    if (active !== trip) return;
    message(error.code === 1 ? '브라우저에서 이 사이트의 위치 권한을 허용해 주세요.' : 'GPS 신호를 기다리는 중입니다.',true);
  },{enableHighAccuracy:true,maximumAge:0,timeout:12000});
  sampler = setInterval(sample,5000);
  clock = setInterval(updateUI,1000);
  if (trip.server) syncTimer = setInterval(sync,30000);
  keepAwake();
}

function stopTimers() {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  clearInterval(sampler);
  clearInterval(syncTimer);
  clearInterval(clock);
  watchId = undefined;
  positionRequest = null;
  latest = null;
  releaseAwake();
}

async function codeTag(token) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest),n => n.toString(16).padStart(2,'0')).join('');
}

// Returns how many old trips had to be dropped to fit, or -1 when even the newest trip does not fit.
function saveRecords() {
  let removed = 0;
  for (;;) {
    try { save('gpsRecords',records); return removed; }
    catch {
      const index = records.findLastIndex((trip,i) => i > 0 && !(trip.server && !trip.synced));
      if (index < 0) return -1;
      records.splice(index,1);
      removed++;
    }
  }
}

const pendingTrips = () => records.filter(trip => trip.server && !trip.synced);

// The server accepts times from the last 7 days; keep an hour of margin for slow uploads.
const localOnly = () => records.filter(trip => !trip.server && trip.end && trip.points?.length);
const uploadable = trip => new Date(trip.start).getTime() > Date.now()-7*86400000+3600000;

function showSyncState() {
  const pending = pendingTrips().length, note = $('syncState');
  note.hidden = !pending;
  note.textContent = '서버 전송 대기 ' + pending + '건'
    + (code ? (syncTask ? ' · 전송 중' : '') : ' · 설정에서 접근 코드를 입력하면 전송됩니다');
  const local = localOnly(), ready = local.filter(uploadable).length, old = local.length-ready;
  $('localOnly').hidden = !local.length;
  $('localOnlyText').textContent = '이 기기에만 있는 운행 '+local.length+'건'
    + (old ? ' (7일 지난 '+old+'건은 보낼 수 없음)' : '')
    + (ready && !code ? ' · 설정에서 접근 코드를 입력하면 서버로 보낼 수 있습니다' : '');
  $('uploadLocal').hidden = !code || !ready;
  $('uploadLocal').disabled = Boolean(active || syncTask);
}

async function uploadLocal() {
  if (!code || active) return;
  const tag = await codeTag(code);
  for (const trip of localOnly().filter(uploadable)) {
    Object.assign(trip,{server:true,codeTag:tag,registered:false,sent:0,synced:false});
  }
  saveRecords();
  showRecords();
  sync();
}

function sync() {
  if (!code || !apiBase) return;
  if (syncTask) return syncTask;
  const token = code;
  syncTask = (async () => {
    const tag = await codeTag(token);
    // Oldest first, so an earlier open trip is closed before a later one on the same vehicle starts.
    const queued = pendingTrips().sort((a,b) => a.start-b.start);
    if (active?.server) queued.push(active);
    let failure;
    for (const trip of queued) {
      if (trip.codeTag === null || trip.codeTag && trip.codeTag !== tag) continue;
      if (!trip.points.length && !trip.registered) continue;
      try {
        trip.codeTag = tag;
        if (!trip.registered) {
          await api('/start',{id:trip.id,vehicle:trip.vehicle,start:trip.start},token);
          trip.registered = true;
        }
        while (trip.sent < trip.points.length) {
          const batch = trip.points.slice(trip.sent,trip.sent+100);
          await api('/points',{id:trip.id,points:batch},token);
          trip.sent += batch.length;
        }
        if (trip.end) {
          await api('/end',{id:trip.id,end:trip.end},token);
          trip.synced = true;
        }
      } catch (error) {
        failure ??= error;
        // Without a server reply (offline, timeout) the remaining trips would fail the same way.
        if (!error.status) break;
      } finally {
        if (active === trip) persist();
        else saveRecords();
      }
    }
    if (failure) throw failure;
  })().catch(error => {
    if (code === token) message('서버 저장 대기 · ' + error.message + ' 기록은 이 기기에 보관됩니다.',true);
  }).finally(() => { syncTask = null; showRecords(); });
  showSyncState();
  return syncTask;
}

let wakeLock, wakeRequest;
function updateAwakeNote() {
  const note = $('awakeNote');
  note.hidden = !active;
  note.textContent = wakeLock
    ? '화면 꺼짐 방지 켜짐 · 화면을 잠그거나 다른 앱으로 나가면 기록이 멈춥니다.'
    : '운행 중에는 화면을 켜 두세요. 화면이 꺼지면 기록이 멈춥니다.';
}
function keepAwake() {
  if (!active || document.hidden || wakeLock || wakeRequest || !navigator.wakeLock) return updateAwakeNote();
  wakeRequest = navigator.wakeLock.request('screen').then(lock => {
    if (!active) { lock.release().catch(() => {}); return; }
    wakeLock = lock;
    lock.addEventListener('release',() => {
      if (wakeLock === lock) wakeLock = undefined;
      updateAwakeNote();
    });
  }).catch(() => {}).finally(() => { wakeRequest = undefined; updateAwakeNote(); });
}
function releaseAwake() {
  const lock = wakeLock;
  wakeLock = undefined;
  lock?.release().catch(() => {});
  updateAwakeNote();
}

function finishTrip() {
  if (!active.end) active.end = active.ending || Date.now();
  active.ending = active.end;
  stopTimers();
  let notice = '';
  if (active.points.length || active.registered) {
    if (!records.some(trip => trip.id === active.id)) {
      records = [active,...records].filter((trip,i) => i < 30 || trip.server && !trip.synced);
    }
    // The finished trip moves into the log, so its separate copy no longer needs the space.
    localStorage.removeItem(prefix+'active');
    const removed = saveRecords();
    if (removed < 0) notice = ' 기기 저장 공간이 부족해 이 일지는 페이지를 닫으면 사라집니다.';
    else if (removed) notice = ' 저장 공간이 부족해 오래된 운행일지 '+removed+'건을 지웠습니다.';
    if (active.points.length) {
      parkingByVehicle[active.vehicle] = {id:active.id,vehicle:active.vehicle,start:active.start,
        end:active.end,points:[active.points.at(-1)]};
      try { save('parkingByVehicle',parkingByVehicle); }
      catch { /* The trip itself is already stored. */ }
    }
    review = active;
    message((active.points.length ? '운행일지를 이 기기에 저장했습니다.' : 'GPS 좌표 없이 운행을 종료했습니다.')+notice,Boolean(notice));
  } else {
    review = undefined;
    message('GPS 위치를 받지 못해 저장된 경로가 없습니다.');
  }
  active = null;
  persist();
  localStorage.removeItem(prefix+'pendingStart');
  if (review) drawMap(true);
  showRecords();
  sync();
}

function action() {
  if (busy) return;
  busy = true;
  message('');
  try {
    if (active) {
      finishTrip();
    } else {
      if (!isSecureContext || !navigator.geolocation) throw new Error('휴대폰 브라우저에서 HTTPS 주소로 열어 주세요.');
      reviewRequest++;
      const trip = {id:crypto.randomUUID(),vehicle:selected,real:true,server:Boolean(code && apiBase),
        registered:false,sent:0,start:Date.now(),points:[]};
      // Capture the owner before recording so a later code change cannot reassign this trip.
      if (trip.server) {
        const token = code;
        trip.codeTag = null;
        codeTag(token).then(tag => {
          trip.codeTag = tag;
          if (active === trip) { persist(); sync(); }
          else if (records.includes(trip)) { saveRecords(); sync(); }
        }).catch(() => { trip.server = false; });
      }
      active = trip;
      points = trip.points;
      review = undefined;
      persist();
      clearMap();
      startTimers();
      showRecords();
    }
  } catch(error) { message(error.message || '잠시 후 다시 시도해 주세요.',true); }
  finally { busy = false; updateUI(); }
}

function tripRows() {
  const remoteOnly = cloudRecords.filter(row => !records.some(trip => trip.id === row.id))
    .map(row => ({id:row.id,vehicle:row.vehicle_id,start:row.started_at,end:row.ended_at,
      distance:Number.isFinite(row.distance_km) ? row.distance_km : undefined}));
  return [...records,...remoteOnly].sort((a,b) => new Date(b.start)-new Date(a.start));
}

const tripKm = row => row.points ? kilometers(row.points) : row.distance;

function showTotals() {
  const now = new Date();
  const from = new Date(now.getFullYear(),now.getMonth(),period === 'today' ? now.getDate() : 1);
  const to = period === 'today'
    ? new Date(now.getFullYear(),now.getMonth(),now.getDate()+1)
    : new Date(now.getFullYear(),now.getMonth()+1,1);
  let count = 0, distance = 0, time = 0;
  for (const trip of tripRows()) {
    const start = new Date(trip.start);
    if (!trip.end || trip.points && !trip.points.length || !(start >= from && start < to)) continue;
    count++;
    distance += tripKm(trip) || 0;
    time += Math.max(0,new Date(trip.end)-start);
  }
  $('totalsNote').textContent = (cloudRecords.length ? '이 기기와 서버에 저장된' : '이 기기에 저장된')+' GPS 운행 · 시작 시각 기준';
  const secs = Math.floor(time/1000), mins = Math.floor(secs/60);
  $('totalTrips').textContent = count + '회';
  $('totalDistance').textContent = distance.toFixed(2) + ' km';
  $('totalDuration').textContent = mins >= 60 ? Math.floor(mins/60)+'시간 '+mins%60+'분'
    : mins ? mins+'분 '+secs%60+'초' : secs+'초';
  $('periodToday').setAttribute('aria-pressed',String(period === 'today'));
  $('periodMonth').setAttribute('aria-pressed',String(period === 'month'));
}

async function tripPoints(row) {
  return row.points || (await api('/trip/'+row.id)).points.map(p => ({...p,ts:Date.parse(p.recorded_at)}));
}

function showTripOnMap(row, detail, parking = false) {
  review = {...row,parking};
  selected = row.vehicle;
  points = parking ? [detail.at(-1)] : detail;
  clearMap();
  drawMap(true);
  updateUI();
  message(parking
    ? '운행 종료 전 마지막으로 수신한 GPS 위치입니다.'
    : '선택한 운행 · '+points.length+'개 위치');
  $('driveTitle').scrollIntoView({block:'start'});
}

async function showParking() {
  if (active) return;
  const request = ++reviewRequest;
  const candidates = tripRows().filter(row => row.end && row.vehicle === selected);
  const lastParking = parkingByVehicle[selected];
  if (lastParking && !candidates.some(row => row.id === lastParking.id && row.points?.length)) {
    candidates.unshift(lastParking);
  }
  candidates.sort((a,b) => new Date(b.end)-new Date(a.end));
  try {
    for (const row of candidates) {
      const detail = await tripPoints(row);
      if (request !== reviewRequest || active) return;
      if (detail.length) {
        showTripOnMap(row,detail,true);
        return;
      }
    }
    if (request === reviewRequest) message(name(selected)+'의 저장된 주차 위치가 없습니다.');
  } catch(error) {
    if (request === reviewRequest) message(error.message,true);
  }
}

function showRecords() {
  showTotals();
  const list = tripRows();
  const ul = $('records');
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.textContent = '저장된 운행일지가 없습니다.';
    ul.append(li);
  }
  for (const row of list) {
    const item = document.createElement('li'), button = document.createElement('button');
    const title = document.createElement('strong'), detail = document.createElement('small');
    const local = records.includes(row);
    item.className = 'record';
    button.className = 'record-open';
    button.disabled = Boolean(active);
    title.textContent = name(row.vehicle) + ' · ' + formatTime(row.start);
    detail.textContent = (row.end ? duration(new Date(row.end)-new Date(row.start)) : '종료 기록 없음')
      + (tripKm(row) !== undefined ? ' · '+tripKm(row).toFixed(2)+' km' : '')
      + (local ? '' : ' · 서버 기록');
    button.append(title,detail);
    if (local && row.server && !row.synced) {
      const badge = document.createElement('span');
      badge.className = 'record-badge';
      badge.textContent = '전송 대기';
      button.append(badge);
    }
    button.onclick = async () => {
      if (active) return;
      const request = ++reviewRequest;
      try {
        const detail = await tripPoints(row);
        if (request === reviewRequest && !active) showTripOnMap(row,detail);
      } catch(error) {
        if (request === reviewRequest) message(error.message,true);
      }
    };
    item.append(button);
    if (local) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'record-delete';
      remove.textContent = '삭제';
      remove.disabled = Boolean(active);
      remove.setAttribute('aria-label',name(row.vehicle)+' '+formatTime(row.start)+' 운행일지 삭제');
      remove.onclick = () => deleteRecord(row);
      item.append(remove);
    }
    ul.append(item);
  }
  showSyncState();
}

function deleteRecord(trip) {
  if (active) return;
  const pending = trip.server && !trip.synced;
  const note = pending ? '\n서버로 아직 보내지 않은 기록이라 서버에도 남지 않습니다.'
    : trip.synced ? '\n서버에 저장된 기록은 서버에 그대로 남습니다.' : '';
  if (!confirm(name(trip.vehicle)+' '+formatTime(trip.start)+' 운행일지를 이 기기에서 삭제할까요?'+note)) return;
  // Close a half-sent trip on the server so it does not keep the vehicle marked as driving.
  if (pending && trip.registered && code) api('/end',{id:trip.id,end:trip.end},code).catch(() => {});
  records = records.filter(item => item !== trip);
  saveRecords();
  if (parkingByVehicle[trip.vehicle]?.id === trip.id) {
    delete parkingByVehicle[trip.vehicle];
    try { save('parkingByVehicle',parkingByVehicle); } catch { /* Deleting only frees space. */ }
  }
  if (review?.id === trip.id) {
    reviewRequest++;
    review = undefined;
    points = [];
    clearMap();
    updateUI();
  }
  showRecords();
  message('운행일지를 삭제했습니다.');
}

async function refreshCloud() {
  if (!code) { cloudRecords = []; showRecords(); return; }
  const token = code;
  try {
    const {trips} = await api('/trips',undefined,token);
    if (code === token) { cloudRecords = trips; showRecords(); }
  } catch(error) {
    if (code === token) message(error.message,true);
  }
}

for (const [id,label] of cars) {
  const button = document.createElement('button');
  button.className = 'vehicle';
  button.dataset.vehicle = id;
  button.append(vehicleVisual(id),label);
  button.onclick = () => {
    reviewRequest++;
    if (selected !== id && review) {
      review = undefined;
      points = [];
      clearMap();
    }
    selected = id;
    updateUI();
  };
  $('vehicles').append(button);
}
$('action').onclick = action;
$('parking').onclick = showParking;
$('mapGesture').onclick = () => setMapInteraction(!mapInteractive);
$('overviewRoute').onclick = () => {
  selectedEvent = pendingMapPoint = undefined;
  map?.update(points,true,routePins(points));
  applyTimelineSelection();
  $('timelineList').scrollTop = 0;
};
$('replayToggle').onclick = () => replay ? stopReplay() : startReplay();
$('uploadLocal').onclick = uploadLocal;
$('periodToday').onclick = () => { period = 'today'; showTotals(); };
$('periodMonth').onclick = () => { period = 'month'; showTotals(); };
$('settings').onclick = () => {
  $('mapKey').value = read('kakaoKey','');
  $('speedLimit').value = speedLimit();
  $('code').value = code;
  $('code').disabled = Boolean(active);
  $('serverSettings').open = false;
  $('settingsError').textContent = '';
  $('mapSettings').showModal();
};
$('cancel').onclick = () => $('mapSettings').close();
$('mapForm').onsubmit = event => {
  event.preventDefault();
  const key = $('mapKey').value.trim(), token = $('code').value.trim();
  if (key && !/^[a-z0-9_-]{20,128}$/i.test(key)) {
    $('settingsError').textContent = '카카오 JavaScript 키 값을 확인해 주세요.';
    return;
  }
  if (!active && token && !/^[a-z0-9_-]{20,80}$/i.test(token)) {
    $('settingsError').textContent = '개인 기록 접근 코드 값을 확인해 주세요.';
    return;
  }
  const limit = Number($('speedLimit').value);
  if (!Number.isInteger(limit) || limit < 20 || limit > 200) {
    $('settingsError').textContent = '과속 기준은 20~200 km/h 사이 정수로 입력해 주세요.';
    return;
  }
  if (key !== read('kakaoKey','') || limit !== speedLimit()) {
    save('kakaoKey',key);
    save('speedLimit',limit);
    clearMap();
    drawMap(Boolean(review));
  }
  if (!active && token !== code) {
    code = token;
    if (code) save('code',code);
    else localStorage.removeItem(prefix+'code');
    sessionStorage.removeItem(prefix+'code');
    cloudRecords = [];
    showRecords();
    refreshCloud();
    sync();
  }
  $('mapSettings').close();
};
window.addEventListener('online',sync);
document.addEventListener('visibilitychange',() => {
  if (document.hidden) return;
  showTotals();
  if (active) { sample(); keepAwake(); }
});
updateUI();
showRecords();
if (active?.ending) action();
else if (active) {
  if (points.length && Date.now()-points.at(-1).ts <= 15000) drawMap();
  if (active.codeTag === null && code) {
    const trip = active;
    codeTag(code).then(tag => {
      trip.codeTag = tag;
      if (active === trip) persist();
      else if (records.includes(trip)) saveRecords();
      sync();
    }).catch(() => { trip.server = false; });
  }
  if (navigator.geolocation) startTimers();
}
if (code) { refreshCloud(); sync(); }
