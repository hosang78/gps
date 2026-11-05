CREATE SCHEMA IF NOT EXISTS fleet_demo;

CREATE TABLE IF NOT EXISTS fleet_demo.vehicles (
  id text PRIMARY KEY,
  label text NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_demo.trips (
  id uuid PRIMARY KEY,
  vehicle_id text NOT NULL REFERENCES fleet_demo.vehicles,
  participant text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_one_open_trip
  ON fleet_demo.trips (vehicle_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_demo.trip_points (
  trip_id uuid NOT NULL REFERENCES fleet_demo.trips,
  seq integer NOT NULL,
  recorded_at timestamptz NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m real NOT NULL CHECK (accuracy_m BETWEEN 0 AND 100),
  PRIMARY KEY (trip_id, seq)
);

INSERT INTO fleet_demo.vehicles (id, label)
VALUES ('cold-01', '냉동탑차 01'), ('fresh-02', '냉장탑차 02'), ('work-03', '업무용 탑차 03')
ON CONFLICT DO NOTHING;
