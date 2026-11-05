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
let points = active?.points || [];
let code = sessionStorage.getItem(prefix+'code') || '';
let cloudRecords = [], review, busy = false, syncTask, map, mapGeneration = 0;
let watchId, sampler, syncTimer, clock, latest;
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
  const s = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(s / 60), s % 60].map(v => String(v).padStart(2,'0')).join(':');
}

function fallbackMap(container) {
  const canvas = document.createElement('canvas');
  container.replaceChildren(canvas);
  return { update(list) {
    const width = container.clientWidth, height = container.clientHeight, ratio = devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
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
    const xy = p => [26+(p.lng-minLng)*scale,height-26-(p.lat-minLat)*scale];
    ctx.strokeStyle = '#087cbd'; ctx.lineWidth = 4;
    for (const group of routeGroups(list)) {
      ctx.beginPath(); group.forEach((p,i) => i ? ctx.lineTo(...xy(p)) : ctx.moveTo(...xy(p))); ctx.stroke();
    }
    ctx.font = '24px system-ui';
    ctx.fillText(({ 'cold-01':'🏎️', 'fresh-02':'🚘', 'work-03':'🚚' })[selected] || '🚘', ...xy(list.at(-1)));
  }, destroy() { canvas.remove(); } };
}
function osmMap(container, center) {
  const leaflet = window.L;
  if (!leaflet) {
    $('mapNote').textContent = '지도 연결 대기 · 경로만 표시';
    return fallbackMap(container);
  }
  const view = leaflet.map(container).setView(center,17);
  const layer = leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(view);
  layer.once('tileerror', () => { $('mapNote').textContent = '일부 배경 지도를 불러오지 못했습니다. 경로는 계속 기록됩니다.'; });
  const route = leaflet.polyline([], { color:'#087cbd', weight:4 }).addTo(view);
  const icon = () => leaflet.divIcon({html:vehiclePin(),className:'',iconSize:[40,30],iconAnchor:[20,15]});
  const marker = leaflet.marker(center, {icon:icon(), interactive:false, opacity:0}).addTo(view);
  let last, markerVehicle = selected;
  return { update(list, fit) {
    route.setLatLngs(routeGroups(list).map(g => g.map(p => [p.lat,p.lng])));
    const point = list.at(-1);
    marker.setOpacity(point ? 1 : 0);
    if (!point) { last = null; return; }
    if (markerVehicle !== selected) { marker.setIcon(icon()); markerVehicle = selected; }
    const pos = [point.lat,point.lng];
    marker.setLatLng(pos);
    if (fit && list.length > 1) view.fitBounds(route.getBounds(), {maxZoom:17,padding:[24,24]});
    else if (last !== point) view.panTo(pos);
    last = point;
  }, destroy() { view.remove(); } };
}
function kakaoMap(container, maps, center) {
  const coords = p => new maps.LatLng(p.lat,p.lng);
  const view = new maps.Map(container,{center:new maps.LatLng(...center),level:4});
  const marker = new maps.CustomOverlay({position:new maps.LatLng(...center),content:vehiclePin(),yAnchor:.5});
  let lines = [], last, markerVehicle = selected;
  return { update(list, fit) {
    const groups = routeGroups(list);
    while (lines.length > groups.length) lines.pop().setMap(null);
    groups.forEach((group,i) => {
      if (!lines[i]) lines[i] = new maps.Polyline({map:view,strokeColor:'#087cbd',strokeWeight:4});
      lines[i].setPath(group.map(coords));
    });
    const point = list.at(-1);
    marker.setMap(point ? view : null);
    if (!point) { last = null; return; }
    if (markerVehicle !== selected) { marker.setContent(vehiclePin()); markerVehicle = selected; }
    const pos = coords(point);
    marker.setPosition(pos);
    if (fit && list.length > 1) {
      const bounds = new maps.LatLngBounds();
      list.forEach(p => bounds.extend(coords(p)));
      view.setBounds(bounds);
    } else if (last !== point) view.panTo(pos);
    last = point;
  }, destroy() { container.replaceChildren(); } };
}
function loadKakao(key) {
  return new Promise((resolve,reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('지도 응답 시간 초과')),8000);
    script.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=' + encodeURIComponent(key);
    script.onerror = () => { clearTimeout(timer); reject(new Error('카카오 지도 연결 실패')); };
    script.onload = () => {
      if (!window.kakao?.maps?.load) { clearTimeout(timer); reject(new Error('카카오 지도 권한 확인 필요')); return; }
      window.kakao.maps.load(() => { clearTimeout(timer); resolve(window.kakao.maps); });
    };
    document.head.append(script);
  });
}
function clearMap() {
  mapGeneration++;
  map?.destroy();
  map = undefined;
  $('map').hidden = true;
  $('mapNote').hidden = true;
  $('mapWaiting').hidden = false;
}

function drawMap(fit = false) {
  const first = points[0];
  if (!first) return;
  if (map) {
    map.update(points,fit);
    return;
  }
  const generation = ++mapGeneration;
  const container = $('map'), center = [first.lat,first.lng];
  container.hidden = false;
  $('mapWaiting').hidden = true;
  $('mapNote').hidden = false;
  $('mapNote').textContent = 'OpenStreetMap';
  map = osmMap(container,center);
  map.update(points,fit);
  const key = read('kakaoKey','');
  if (!key) return;
  loadKakao(key).then(maps => {
    if (generation !== mapGeneration) return;
    const last = points.at(-1);
    map.destroy();
    container.replaceChildren();
    map = kakaoMap(container,maps,[last.lat,last.lng]);
    $('mapNote').textContent = '카카오맵';
    map.update(points,fit);
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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '서버 요청에 실패했습니다.');
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
  $('action').textContent = active ? '운행 종료' : '운행 시작';
  $('action').classList.toggle('stop',Boolean(active));
  const last = points.at(-1), previous = points.at(-2);
  const fresh = last && Date.now()-last.ts <= 15000;
  const moving = Boolean(active && fresh && previous && last.ts-previous.ts <= 15000 && meters(previous,last) > 5);
  const vehicleImage = $('truck');
  const src = image(selected);
  if (vehicleImage.getAttribute('src') !== src) vehicleImage.src = src;
  const visual = $('rideVisual');
  visual.dataset.vehicle = selected;
  visual.classList.toggle('is-moving',moving);
  $('vehicleName').textContent = name(selected);
  $('state').textContent = active ? (fresh ? (moving ? '이동 중' : '위치 수신 완료') : 'GPS 위치 수신 중')
    : review ? '저장된 운행' : '운행 대기';
  const elapsed = active ? Date.now()-active.start : review ? new Date(review.end)-new Date(review.start) : 0;
  $('metrics').textContent = duration(elapsed) + ' · ' + kilometers(points).toFixed(2) + ' km';
  $('freshness').textContent = last
    ? (review ? '기록 위치 ' : '최근 위치 ') + new Date(last.ts).toLocaleTimeString('ko-KR') + ' · 정확도 ±' + Math.round(last.accuracy) + 'm'
    : active ? '휴대폰에서 받은 첫 위치를 기다립니다.' : '운행을 시작하면 GPS를 켭니다.';
  $('mapWaiting').textContent = active ? '현재 위치를 확인하고 있습니다.' : review ? '저장된 위치가 없습니다.' : '운행을 시작하면 현재 위치를 표시합니다.';
}

function sample() {
  if (!active || active.ending || document.hidden || !latest || Date.now()-latest.ts > 12000) return;
  const previous = points.at(-1);
  if (points.length >= 8640 || previous && latest.ts <= previous.ts) return;
  if (previous && latest.ts-previous.ts <= 15000 && meters(previous,latest) / ((latest.ts-previous.ts)/1000) > 62) return;
  points.push({...latest,seq:points.length});
  try { persist(); }
  catch { message('기기 저장 공간을 확인해 주세요.',true); }
  drawMap();
  updateUI();
}

function startTimers() {
  const trip = active;
  watchId = navigator.geolocation.watchPosition(pos => {
    if (active !== trip) return;
    const {latitude:lat,longitude:lng,accuracy} = pos.coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) ||
        !Number.isFinite(pos.timestamp) || pos.timestamp < trip.start-1000) return;
    if (accuracy > 100) {
      message('GPS 정확도를 높이는 중입니다. 실내라면 창가나 실외에서 다시 확인해 주세요.');
      return;
    }
    latest = {lat,lng,accuracy,ts:pos.timestamp};
    if (!points.length || Date.now()-points.at(-1).ts > 15000) sample();
    if (points.length) message('');
  }, error => {
    if (active !== trip) return;
    message(error.code === 1 ? '브라우저에서 이 사이트의 위치 권한을 허용해 주세요.' : 'GPS 신호를 기다리는 중입니다.',true);
  },{enableHighAccuracy:true,maximumAge:0,timeout:12000});
  sampler = setInterval(sample,5000);
  clock = setInterval(updateUI,1000);
  if (trip.server) syncTimer = setInterval(sync,30000);
}

function stopTimers() {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  clearInterval(sampler);
  clearInterval(syncTimer);
  clearInterval(clock);
  watchId = undefined;
  latest = null;
}

async function codeTag(token) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest),n => n.toString(16).padStart(2,'0')).join('');
}

function saveRecords() {
  save('gpsRecords',records);
}

function sync() {
  if (!code || !apiBase) return;
  if (syncTask) return syncTask;
  const token = code;
  syncTask = (async () => {
    const tag = await codeTag(token);
    const queued = records.filter(trip => trip.server && !trip.synced);
    if (active?.server) queued.push(active);
    for (const trip of queued) {
      if (trip.codeTag === null || trip.codeTag && trip.codeTag !== tag) continue;
      if (!trip.points.length && !trip.registered) continue;
      trip.codeTag = tag;
      if (!trip.registered) {
        await api('/start',{id:trip.id,vehicle:trip.vehicle},token);
        trip.registered = true;
      }
      while (trip.sent < trip.points.length) {
        const batch = trip.points.slice(trip.sent,trip.sent+100);
        await api('/points',{id:trip.id,points:batch},token);
        trip.sent += batch.length;
      }
      if (trip.end) {
        await api('/end',{id:trip.id},token);
        trip.synced = true;
      }
      if (active === trip) persist();
      else saveRecords();
    }
  })().catch(error => {
    if (code === token) message('서버 저장 대기 · ' + error.message + ' 기록은 이 기기에 보관됩니다.',true);
  }).finally(() => { syncTask = null; });
  return syncTask;
}

function finishTrip() {
  if (!active.end) active.end = active.ending || Date.now();
  active.ending = active.end;
  stopTimers();
  if (active.points.length || active.registered) {
    if (!records.some(trip => trip.id === active.id)) {
      records = [active,...records].filter((trip,i) => i < 30 || trip.server && !trip.synced);
    }
    saveRecords();
    review = active;
    message(active.points.length ? '운행일지를 이 기기에 저장했습니다.' : 'GPS 좌표 없이 운행을 종료했습니다.');
  } else {
    review = undefined;
    message('GPS 위치를 받지 못해 저장된 경로가 없습니다.');
  }
  active = null;
  persist();
  localStorage.removeItem(prefix+'pendingStart');
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

function showRecords() {
  const remoteOnly = cloudRecords.filter(row => !records.some(trip => trip.id === row.id))
    .map(row => ({id:row.id,vehicle:row.vehicle_id,start:row.started_at,end:row.ended_at}));
  const list = [...records,...remoteOnly].sort((a,b) => new Date(b.start)-new Date(a.start));
  const ul = $('records');
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.textContent = '저장된 운행일지가 없습니다.';
    ul.append(li);
  }
  for (const row of list) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.disabled = Boolean(active);
    button.textContent = name(row.vehicle) + ' · ' + formatTime(row.start)
      + (row.end ? ' · '+duration(new Date(row.end)-new Date(row.start)) : ' · 종료 기록 없음')
      + (row.points ? ' · '+kilometers(row.points).toFixed(2)+' km' : '');
    button.onclick = async () => {
      if (active) return;
      try {
        const detail = row.points || (await api('/trip/'+row.id)).points.map(p => ({...p,ts:Date.parse(p.recorded_at)}));
        if (active) return;
        review = row;
        selected = row.vehicle;
        points = detail;
        clearMap();
        drawMap(true);
        updateUI();
        message('선택한 운행 · '+points.length+'개 위치');
        $('driveTitle').scrollIntoView({block:'start'});
      } catch(error) { message(error.message,true); }
    };
    item.append(button);
    ul.append(item);
  }
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
$('settings').onclick = () => {
  $('mapKey').value = read('kakaoKey','');
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
  if (key !== read('kakaoKey','')) {
    save('kakaoKey',key);
    clearMap();
    drawMap(Boolean(review));
  }
  if (!active && token !== code) {
    code = token;
    sessionStorage.setItem(prefix+'code',code);
    cloudRecords = [];
    showRecords();
    refreshCloud();
    sync();
  }
  $('mapSettings').close();
};
window.addEventListener('online',sync);
document.addEventListener('visibilitychange',() => { if (!document.hidden && active) sample(); });
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
