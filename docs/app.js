import { apiBase } from './config.js';

const $ = id => document.getElementById(id);
const cars = [['cold-01','페라리 01'],['fresh-02','제네시스 02'],['work-03','업무용 탑차 03']];
const presenter = new URLSearchParams(location.search).get('view') === 'present';
const origin = [37.5147, 127.1058];
const demoPath = [[37.5147,127.1058],[37.5143,127.1064],[37.5138,127.1071],[37.5135,127.1080],[37.5132,127.1087],[37.5137,127.1091],[37.5145,127.1096],[37.5151,127.1091],[37.5158,127.1085],[37.5162,127.1076],[37.5157,127.1066],[37.5151,127.1061]];
const prefix = 'suhyup.fleet.v1.';
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(prefix + key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, value) { localStorage.setItem(prefix + key, JSON.stringify(value)); }
let active = presenter ? null : read('active', null);
let pending = presenter ? null : read('pendingStart', null);
let selected = active?.vehicle || pending?.vehicle || cars[0][0];
let records = read('demoRecords', []);
let points = active?.points || [];
let watchId, sampler, syncTimer, clock, latest, busy = false, syncTask, map;
let mapGeneration = 0;
let cloudRecords = [];
let presentedTrip, pinnedTrip, viewerCode = '', viewerTask, viewerRevision = 0;
const name = id => cars.find(([key]) => key === id)?.[1] || id;
const image = (id, animated) => './vehicles/' + id + (animated ? '.gif' : '.webp') + (id === 'work-03' ? '' : '?v=2');
const formatTime = value => new Date(value).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });

function vehiclePin() {
  const pin = document.createElement('div'), img = document.createElement('img');
  pin.className = 'vehicle-pin';
  img.src = image(selected,false);
  img.alt = '';
  pin.append(img);
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
function osmMap(container) {
  const leaflet = window.L;
  if (!leaflet) {
    $('mapNote').textContent = '지도 연결 대기 · 경로만 표시';
    return fallbackMap(container);
  }
  const view = leaflet.map(container).setView(origin, 15);
  const layer = leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(view);
  layer.once('tileerror', () => { $('mapNote').textContent = '일부 배경 지도를 불러오지 못했습니다. 경로는 계속 기록됩니다.'; });
  const route = leaflet.polyline([], { color:'#087cbd', weight:4 }).addTo(view);
  const icon = () => leaflet.divIcon({html:vehiclePin(),className:'',iconSize:[40,30],iconAnchor:[20,15]});
  const marker = leaflet.marker(origin, {icon:icon(), interactive:false, opacity:0}).addTo(view);
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
    else if (fit || (!last || $('follow').checked) && last !== point) view.panTo(pos);
    last = point;
  }, destroy() { view.remove(); } };
}
function kakaoMap(container, maps) {
  const coords = p => new maps.LatLng(p.lat,p.lng);
  const view = new maps.Map(container,{center:new maps.LatLng(...origin),level:4});
  const marker = new maps.CustomOverlay({position:new maps.LatLng(...origin),content:vehiclePin(),yAnchor:.5});
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
    } else if (fit || (!last || $('follow').checked) && last !== point) view.panTo(pos);
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
async function showMap() {
  const generation = ++mapGeneration;
  map?.destroy();
  map = undefined;
  const container = $('map');
  container.replaceChildren();
  const key = read('kakaoKey','');
  $('mapNote').textContent = key ? '카카오맵 연결 중' : 'OpenStreetMap';
  if (key) {
    try {
      const maps = await loadKakao(key);
      if (generation !== mapGeneration) return;
      map = kakaoMap(container,maps);
      $('mapNote').textContent = '카카오맵';
      map.update(points);
      return;
    } catch {
      if (generation !== mapGeneration) return;
      $('mapNote').textContent = '카카오맵 연결 실패 · OpenStreetMap 사용 중. 키와 등록 도메인을 확인하세요.';
    }
  }
  map = osmMap(container);
  map.update(points);
}
function currentCode() { return $('code').value.trim(); }
async function api(path, body) {
  if (!apiBase) throw new Error('실측 저장 서버가 아직 연결되지 않았습니다.');
  const headers = { Authorization:'Bearer ' + currentCode() };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiBase + path, { method:body ? 'POST':'GET', headers,
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '서버 요청에 실패했습니다.'), { status: response.status });
  return data;
}
function persist() {
  if (active) { active.points = points; save('active',active); }
  else localStorage.removeItem(prefix + 'active');
}
function updateUI() {
  const real = $('real').checked;
  $('mode').textContent = presenter ? '발표용 조회' : real ? '휴대폰 GPS' : '가상 경로';
  $('access').hidden = !real;
  $('real').disabled = presenter || Boolean(active || pending) || busy;
  $('code').disabled = Boolean(active) && Boolean(currentCode());
  for (const btn of $('vehicles').children) {
    btn.disabled = Boolean(active || pending) || busy;
    btn.setAttribute('aria-pressed', String(btn.dataset.vehicle === selected));
  }
  $('action').disabled = busy;
  $('action').textContent = active?.ending ? '저장 다시 시도' : active ? '운행 종료' : '운행 시작';
  $('action').classList.toggle('stop', Boolean(active));
  const last = points.at(-1), previous = points.at(-2);
  const fresh = last && Date.now() - last.ts <= (presenter ? 50000 : 15000);
  const running = presenter ? presentedTrip && !presentedTrip.ended_at : active && !active.ending;
  const moving = Boolean(running && fresh && previous && last.ts-previous.ts <= 15000 && meters(previous,last) > 5);
  const src = image(selected,moving);
  if ($('truck').getAttribute('src') !== src) $('truck').src = src;
  $('state').textContent = presenter
    ? (presentedTrip ? name(selected) + ' · ' + (running ? (fresh ? '운행 중' : '서버 위치 수신 대기') : '운행 종료') : '조회 대기')
    : active?.ending ? '저장 대기' : active ? (!fresh ? '위치 수신 대기' : moving ? '이동 중' : '정차 중') : '운행 대기';
  const elapsed = presentedTrip
    ? (presentedTrip.ended_at ? Date.parse(presentedTrip.ended_at) : Date.now()) - Date.parse(presentedTrip.started_at)
    : active ? (active.ending || Date.now())-active.start : 0;
  $('metrics').textContent = duration(elapsed) + ' · ' + kilometers(points).toFixed(2) + ' km';
  $('freshness').textContent = last ? (presenter ? '서버에 저장된 위치 ' : '최근 위치 ') + new Date(last.ts).toLocaleTimeString('ko-KR') + (real ? ' · 정확도 ±' + Math.round(last.accuracy) + 'm' : '')
    : presenter ? '서버에 도착한 위치가 지도에 표시됩니다.' : '운행을 시작하면 지도에 위치가 표시됩니다.';
}
function addPoint(point) {
  const previous = points.at(-1);
  if (!active || active.ending || points.length >= 8640 || previous && point.ts <= previous.ts) return;
  if (previous && point.ts-previous.ts <= 15000 && meters(previous,point) / ((point.ts-previous.ts)/1000) > 62) return;
  points.push({ ...point,seq:points.length });
  persist();
  map?.update(points);
  updateUI();
}
function sample() {
  if (!active || active.ending || document.hidden) return;
  if (!active.real) {
    const [lat,lng] = demoPath[points.length % demoPath.length];
    addPoint({lat,lng,accuracy:0,ts:Date.now()});
    return;
  }
  if (latest && Date.now()-latest.ts <= 12000) addPoint(latest);
}
function startTimers() {
  if (active.ending) return;
  if (active.real) {
    watchId = navigator.geolocation.watchPosition(pos => {
      if (pos.coords.accuracy > 100) return;
      latest = {lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy,ts:pos.timestamp};
      if (!points.length) sample();
    },error => message(error.code === 1 ? '브라우저에서 위치 권한을 허용해 주세요.' : 'GPS 신호를 기다리는 중입니다.',true),
    {enableHighAccuracy:true,maximumAge:0,timeout:12000});
    syncTimer = setInterval(() => { sync().catch(error => message(error.message + ' 위치는 이 기기에 임시 저장됩니다.',true)); },30000);
  } else if (!points.length) sample();
  sampler = setInterval(sample,5000);
  clock = setInterval(updateUI,1000);
}
function stopTimers() {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  clearInterval(sampler); clearInterval(syncTimer); clearInterval(clock);
  watchId = undefined;
  latest = null;
}
function sync() {
  if (!active?.real) return Promise.resolve();
  if (syncTask) return syncTask;
  syncTask = (async () => {
    while (active && active.sent < points.length) {
      const batch = points.slice(active.sent,active.sent+100);
      await api('/points',{id:active.id,points:batch});
      active.sent += batch.length;
      persist();
    }
  })().finally(() => { syncTask = null; });
  return syncTask;
}
async function action() {
  if (busy || presenter) return;
  busy = true;
  message('');
  updateUI();
  try {
    if (!active) {
      const real = $('real').checked;
      if (real && (!isSecureContext || !navigator.geolocation)) throw new Error('HTTPS 브라우저에서 위치 접근을 지원하는 기기로 열어 주세요.');
      if (real && !currentCode()) throw new Error('참가자별 시연 코드를 입력해 주세요.');
      const trip = pending || {id:crypto.randomUUID(),vehicle:selected,real,start:Date.now(),sent:0,points:[]};
      if (real) {
        if (!apiBase) throw new Error('실측 저장 서버가 아직 연결되지 않았습니다.');
        sessionStorage.setItem(prefix+'code',currentCode());
        pending = trip;
        save('pendingStart',trip);
        try { await api('/start',{id:trip.id,vehicle:trip.vehicle}); }
        catch (error) {
          if (error.status >= 400 && error.status < 500) {
            pending = null;
            localStorage.removeItem(prefix+'pendingStart');
          }
          throw error;
        }
      }
      active = trip; points = [];
      persist();
      pending = null;
      localStorage.removeItem(prefix+'pendingStart');
      map?.update(points);
      startTimers();
      message(real ? '유효한 GPS 좌표를 5초 단위로 기록합니다.' : '가상 경로를 5초 간격으로 재생합니다.');
    } else {
      active.ending ||= Date.now();
      persist();
      stopTimers();
      if (active.real) {
        await sync();
        await api('/end',{id:active.id});
      } else {
        records.unshift({id:active.id,vehicle:active.vehicle,start:active.start,end:active.ending,points});
        records = records.slice(0,20);
        save('demoRecords',records);
      }
      active = null;
      persist();
      message('운행일지를 저장했습니다.');
      await refresh();
    }
  } catch(error) { message(error.message || '잠시 후 다시 시도해 주세요.',true); }
  finally { busy = false; updateUI(); }
}
function showRecords() {
  const real = $('real').checked;
  const list = real ? cloudRecords : records;
  const ul = $('records'); ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li'); li.textContent = real && !currentCode() ? '코드를 입력한 뒤 새로고침하세요.' : '저장된 운행일지가 없습니다.'; ul.append(li);
  }
  for (const row of list) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.disabled = Boolean(active);
    if (presenter && row.id === presentedTrip?.id) {
      button.classList.add('records-selected');
      button.setAttribute('aria-current','true');
    }
    const start = row.start ?? row.started_at, end = row.end ?? row.ended_at;
    const elapsed = end ? ' · '+duration(new Date(end)-new Date(start)) : ' · 운행 중';
    button.textContent = name(row.vehicle ?? row.vehicle_id) + ' · ' + formatTime(start) + elapsed + (row.points ? ' · '+kilometers(row.points).toFixed(2)+' km' : '');
    button.onclick = async () => {
      if (active) return;
      if (presenter) {
        pinnedTrip = row.id;
        viewerRevision++;
        await refreshPresenter();
        return;
      }
      try {
        const detail = row.points || (await api('/trip/'+row.id)).points.map(p => ({...p,ts:Date.parse(p.recorded_at)}));
        points = detail;
        selected = row.vehicle ?? row.vehicle_id;
        map?.update(points,true);
        updateUI();
        message('선택한 운행 · '+kilometers(points).toFixed(2)+' km · '+points.length+'개 위치');
        $('driveTitle').scrollIntoView({block:'start'});
      } catch(error) { message(error.message,true); }
    };
    item.append(button); ul.append(item);
  }
}
async function refresh() {
  if ($('real').checked && currentCode()) {
    try { cloudRecords = (await api('/trips')).trips; }
    catch(error) { message(error.message,true); }
  }
  showRecords();
}

function resetPresenter(code) {
  viewerCode = code;
  viewerRevision++;
  pinnedTrip = undefined;
  presentedTrip = undefined;
  cloudRecords = [];
  points = [];
  map?.update(points);
  showRecords();
  updateUI();
}

function refreshPresenter(manual = false) {
  if (manual) {
    if (!currentCode()) {
      message('휴대폰에서 사용한 시연 코드를 입력해 주세요.',true);
      $('code').focus();
      return;
    }
    resetPresenter(currentCode());
    sessionStorage.setItem(prefix+'code',viewerCode);
  }
  if (!viewerCode || document.hidden) return;
  const revision = viewerRevision;
  if (viewerTask) return viewerTask.then(() => {
    if (viewerRevision === revision) return refreshPresenter();
  });
  viewerTask = (async () => {
    try {
      const {trips} = await api('/trips');
      if (viewerRevision !== revision) return;
      cloudRecords = trips;
      const row = trips.find(t => t.id === pinnedTrip) || trips.find(t => !t.ended_at) || trips[0];
      if (row && (row.id !== presentedTrip?.id || !presentedTrip.ended_at)) {
        const detail = await api('/trip/'+row.id);
        if (viewerRevision !== revision) return;
        const fit = detail.trip.id !== presentedTrip?.id || !points.length && detail.points.length > 0;
        presentedTrip = detail.trip;
        selected = detail.trip.vehicle_id;
        points = detail.points.map(p => ({...p,ts:Date.parse(p.recorded_at)}));
        map?.update(points,fit);
      }
      if (row) message(pinnedTrip ? '선택한 운행 기록을 표시합니다.' : '최신 운행 기록을 표시합니다.');
      else message('아직 저장된 운행이 없습니다. 휴대폰에서 운행을 시작하면 여기에 표시됩니다.');
      showRecords();
      updateUI();
    } catch(error) {
      if (viewerRevision !== revision) return;
      if (error.status === 401) resetPresenter('');
      message(error.message,true);
    }
  })().finally(() => { viewerTask = null; });
  return viewerTask;
}

for (const [id,label] of cars) {
  const button = document.createElement('button'); button.className = 'vehicle'; button.dataset.vehicle = id;
  const img = document.createElement('img'); img.src = image(id,false); img.alt = '';
  button.append(img,label); button.onclick = () => { selected = id; updateUI(); };
  $('vehicles').append(button);
}
$('real').checked = presenter || Boolean((active || pending)?.real);
$('code').value = sessionStorage.getItem(prefix+'code') || '';
$('code').addEventListener('change',() => {
  if (currentCode()) sessionStorage.setItem(prefix+'code',currentCode());
  if (active?.real) { updateUI(); sync().catch(error => message(error.message,true)); }
});
$('real').onchange = () => { points = []; map?.update(points); updateUI(); refresh(); };
$('action').onclick = action;
$('reload').onclick = presenter ? () => viewerCode ? refreshPresenter() : refreshPresenter(true) : refresh;
$('accessForm').onsubmit = event => {
  event.preventDefault();
  if (presenter) refreshPresenter(true);
  else refresh();
};
if (presenter) {
  document.body.classList.add('presenter');
  $('vehicleTitle').textContent = '발표 화면 연결';
  $('real').closest('label').hidden = true;
  $('vehicles').hidden = true;
  $('action').hidden = true;
  $('connect').hidden = false;
  $('latestTrip').hidden = false;
  $('presentHelp').hidden = false;
  $('presentLink').textContent = '운행 화면';
  $('presentLink').href = './';
  $('presentLink').removeAttribute('target');
  $('latestTrip').onclick = () => refreshPresenter(true);
  $('code').addEventListener('input',() => {
    if (viewerCode && currentCode() !== viewerCode) {
      resetPresenter('');
      message('시연 코드를 입력하고 조회를 시작하세요.');
    }
  });
  setInterval(() => { if (!viewerTask) refreshPresenter(); },15000);
}
$('settings').onclick = () => { $('mapKey').value = read('kakaoKey',''); $('settingsError').textContent = ''; $('mapSettings').showModal(); };
$('cancel').onclick = () => $('mapSettings').close();
$('mapForm').onsubmit = event => {
  event.preventDefault();
  const key = $('mapKey').value.trim();
  if (key && !/^[a-z0-9_-]{20,128}$/i.test(key)) { $('settingsError').textContent = '카카오 JavaScript 키 값을 확인해 주세요.'; return; }
  save('kakaoKey',key);
  location.reload();
};
window.addEventListener('online',() => { if (active?.real) sync().catch(error => message(error.message,true)); });
document.addEventListener('visibilitychange',() => {
  if (document.hidden) return;
  if (active) sample();
  if (presenter && !viewerTask) refreshPresenter();
});
showMap();
updateUI();
if (presenter) showRecords();
else refresh();
if (active && !active.ending && (!active.real || navigator.geolocation)) startTimers();
