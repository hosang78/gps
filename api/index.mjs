import { createHash, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const site = 'https://hosang78.github.io';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vehicles = new Set(['cold-01', 'fresh-02', 'work-03']);

export default async function handler(request) {
  const headers = {
    'Access-Control-Allow-Origin': site,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  const reply = (data, status = 200) => Response.json(data, { status, headers });
  if (request.headers.get('origin') && request.headers.get('origin') !== site) return reply({ error: '허용되지 않은 사이트입니다.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  if (request.method === 'GET' && path === '/') return reply({ service: 'fleet-demo', ok: true });
  const code = request.headers.get('authorization')?.match(/^Bearer ([a-zA-Z0-9_-]{20,80})$/)?.[1];
  if (!code) return reply({ error: '시연 코드를 입력해 주세요.' }, 401);
  const hash = createHash('sha256').update(code).digest();
  const match = list => (list || '').split(',')
    .findIndex(item => /^[a-f0-9]{64}$/.test(item) && timingSafeEqual(hash, Buffer.from(item, 'hex')));
  // Codes added later live in a second variable, so the original list never has to be rewritten.
  const index = match(process.env.FLEET_CODE_HASHES), extra = index < 0 ? match(process.env.FLEET_EXTRA_CODE_HASHES) : -1;
  if (index < 0 && extra < 0) return reply({ error: '시연 코드를 확인해 주세요.' }, 401);
  const owner = index >= 0 ? 'participant-' + (index + 1) : 'owner-' + (extra + 1);
  try {
    const sql = neon(process.env.FLEET_DATABASE_URL);
    if (request.method === 'GET' && path === '/trips') {
      // Distance follows the app: points more than 15 seconds apart are not joined.
      const trips = await sql`SELECT t.id, t.vehicle_id, t.started_at, t.ended_at, v.label,
          COALESCE((SELECT round((sum(step) / 1000)::numeric, 3)::float8 FROM (
            SELECT CASE WHEN recorded_at - lag(recorded_at) OVER w <= interval '15 seconds' THEN
              12742000 * asin(least(1, sqrt(
                sin(radians(latitude - lag(latitude) OVER w) / 2) ^ 2 +
                cos(radians(lag(latitude) OVER w)) * cos(radians(latitude)) *
                sin(radians(longitude - lag(longitude) OVER w) / 2) ^ 2)))
            END AS step
            FROM fleet_demo.trip_points WHERE trip_id = t.id WINDOW w AS (ORDER BY seq)) steps), 0) AS distance_km
        FROM fleet_demo.trips t JOIN fleet_demo.vehicles v ON v.id = t.vehicle_id
        WHERE participant = ${owner} ORDER BY started_at DESC LIMIT 30`;
      return reply({ trips });
    }
    if (request.method === 'GET' && path.startsWith('/trip/')) {
      const id = path.slice(6);
      if (!uuid.test(id)) return reply({ error: '운행 번호를 확인해 주세요.' }, 400);
      const [trip] = await sql`SELECT t.id, t.vehicle_id, t.started_at, t.ended_at, v.label
        FROM fleet_demo.trips t JOIN fleet_demo.vehicles v ON v.id = t.vehicle_id
        WHERE t.id = ${id} AND t.participant = ${owner}`;
      if (!trip) return reply({ error: '운행기록을 찾을 수 없습니다.' }, 404);
      const points = await sql`SELECT seq, recorded_at, latitude AS lat, longitude AS lng, accuracy_m AS accuracy
        FROM fleet_demo.trip_points WHERE trip_id = ${id} ORDER BY seq LIMIT 8640`;
      return reply({ trip, points });
    }
    if (request.method !== 'POST' || !['/start','/points','/end'].includes(path)) return reply({ error: '경로를 확인해 주세요.' }, 404);
    let data;
    try {
      const raw = await request.text();
      if (raw.length > 48000) return reply({ error: '기록 묶음이 너무 큽니다.' }, 413);
      data = JSON.parse(raw);
    } catch {
      return reply({ error: '요청 내용을 확인해 주세요.' }, 400);
    }
    if (typeof data?.id !== 'string' || !uuid.test(data.id)) return reply({ error: '운행 번호를 확인해 주세요.' }, 400);
    const now = Date.now();
    // Phones send the real start/end time so trips synced later keep their recorded times.
    const clientTime = value => value === undefined ? null
      : Number.isInteger(value) && value >= now - 7 * 86400000 && value <= now + 300000 ? value : NaN;
    if (path === '/start') {
      if (!vehicles.has(data.vehicle)) return reply({ error: '등록된 차량을 선택해 주세요.' }, 400);
      const start = clientTime(data.start);
      if (Number.isNaN(start)) return reply({ error: '출발 시각을 확인해 주세요.' }, 400);
      // A trip left open for longer than the 12-hour recording limit can no longer receive points.
      await sql`UPDATE fleet_demo.trips t SET ended_at = COALESCE(
          (SELECT max(recorded_at) FROM fleet_demo.trip_points WHERE trip_id = t.id), t.started_at)
        WHERE t.vehicle_id = ${data.vehicle} AND t.participant = ${owner} AND t.ended_at IS NULL
          AND t.id <> ${data.id} AND t.started_at < now() - interval '13 hours'`;
      const inserted = await sql`INSERT INTO fleet_demo.trips (id, vehicle_id, participant, started_at)
        VALUES (${data.id}, ${data.vehicle}, ${owner}, COALESCE(to_timestamp(${start} / 1000.0), now()))
        ON CONFLICT DO NOTHING RETURNING id`;
      if (inserted.length) return reply({ ok: true }, 201);
      const same = await sql`SELECT id FROM fleet_demo.trips WHERE id = ${data.id}
        AND vehicle_id = ${data.vehicle} AND participant = ${owner} AND ended_at IS NULL`;
      return same.length ? reply({ ok: true }) : reply({ error: '이미 운행 중인 차량입니다.' }, 409);
    }
    if (path === '/end') {
      const end = clientTime(data.end);
      if (Number.isNaN(end)) return reply({ error: '종료 시각을 확인해 주세요.' }, 400);
      const ended = await sql`UPDATE fleet_demo.trips SET ended_at = COALESCE(ended_at,
          GREATEST(started_at, COALESCE(to_timestamp(${end} / 1000.0), now())))
        WHERE id = ${data.id} AND participant = ${owner} RETURNING id`;
      return ended.length ? reply({ ok: true }) : reply({ error: '운행기록을 찾을 수 없습니다.' }, 404);
    }
    const points = data.points;
    if (!Array.isArray(points) || !points.length || points.length > 100 || points.some(p =>
      !Number.isInteger(p?.seq) || p.seq < 0 || p.seq >= 8640 ||
      !Number.isFinite(p.lat) || Math.abs(p.lat) > 90 || !Number.isFinite(p.lng) || Math.abs(p.lng) > 180 ||
      !Number.isFinite(p.accuracy) || p.accuracy < 0 || p.accuracy > 100 ||
      !Number.isInteger(p.ts) || p.ts < now - 7 * 86400000 || p.ts > now + 300000)) {
      return reply({ error: '위치 기록 형식을 확인해 주세요.' }, 400);
    }
    const [{ authorized }] = await sql`WITH trip AS MATERIALIZED (
        SELECT id FROM fleet_demo.trips WHERE id = ${data.id} AND participant = ${owner}
          AND ended_at IS NULL FOR UPDATE
      ), saved AS (
        INSERT INTO fleet_demo.trip_points (trip_id, seq, recorded_at, latitude, longitude, accuracy_m)
        SELECT trip.id, point.seq, to_timestamp(point.ts / 1000.0), point.lat, point.lng, point.accuracy
        FROM trip CROSS JOIN jsonb_to_recordset(${JSON.stringify(points)}::jsonb)
          AS point(seq integer, ts bigint, lat double precision, lng double precision, accuracy real)
        ON CONFLICT DO NOTHING
      ) SELECT EXISTS (SELECT 1 FROM trip) AS authorized`;
    return authorized ? reply({ ok: true }) : reply({ error: '진행 중인 내 운행을 찾을 수 없습니다.' }, 404);
  } catch (error) {
    console.error('fleet database request failed', error.code || error.name);
    return reply({ error: '서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, 503);
  }
}
