const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// PostgreSQL 연결 설정
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: '',   // ← 본인 DB 이름으로 변경
  user: '',       // ← 본인 DB 유저로 변경
  password: '',           // ← 있으면 입력
});

// 미들웨어
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'airline-secret',
  resave: false,
  saveUninitialized: false,
}));

// ───────────────────────────────
// 페이지 라우트
// ───────────────────────────────

// 루트 → 로그인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// 항공편 페이지 (로그인 필요)
app.get('/flights', (req, res) => {
  if (!req.session.passengerId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'flights.html'));
});

// ───────────────────────────────
// API 라우트
// ───────────────────────────────

// 회원가입
app.post('/api/register', async (req, res) => {
  const { name, email } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO passengers (name, email) VALUES ($1, $2) RETURNING passenger_id, name',
      [name, email]
    );
    res.json({ ok: true, passenger: result.rows[0] });
  } catch (err) {
    res.json({ ok: false, message: '이미 사용 중인 이메일입니다.' });
  }
});

// 로그인 (passenger_id만 입력)
app.post('/api/login', async (req, res) => {
  const { passenger_id } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM passengers WHERE passenger_id = $1',
      [passenger_id]
    );
    if (result.rows.length === 0) {
      return res.json({ ok: false, message: '존재하지 않는 ID입니다.' });
    }
    req.session.passengerId = result.rows[0].passenger_id;
    req.session.passengerName = result.rows[0].name;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, message: '서버 오류' });
  }
});

// 로그아웃
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// 현재 로그인 정보
app.get('/api/me', (req, res) => {
  if (!req.session.passengerId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.passengerName, id: req.session.passengerId });
});

// 항공편 조회
app.get('/api/flights', async (req, res) => {
  const { from, to } = req.query;
  let query = `
    SELECT f.flight_id, f.flight_number,
           f.departure_airport, f.arrival_airport,
           f.departure_time, f.arrival_time,
           m.model_name
    FROM flights f
    JOIN aircraft_models m ON f.model_id = m.model_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { params.push(from.toUpperCase()); query += ` AND f.departure_airport = $${params.length}`; }
  if (to)   { params.push(to.toUpperCase());   query += ` AND f.arrival_airport = $${params.length}`; }
  query += ' ORDER BY f.departure_time';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// 잔여 좌석 조회
app.get('/api/flights/:id/seats', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(`
    SELECT st.seat_number, st.seat_class,
           CASE WHEN r.seat_number IS NULL THEN true ELSE false END AS available
    FROM seat_templates st
    JOIN flights f ON f.model_id = st.model_id
    LEFT JOIN reservations r ON r.flight_id = f.flight_id AND r.seat_number = st.seat_number
    WHERE f.flight_id = $1
    ORDER BY st.seat_class, st.seat_number
  `, [id]);
  res.json(result.rows);
});

// 예약하기
app.post('/api/reserve', async (req, res) => {
  if (!req.session.passengerId) return res.json({ ok: false, message: '로그인 필요' });
  const { flight_id, seat_number } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'INSERT INTO reservations (flight_id, passenger_id, seat_number) VALUES ($1, $2, $3)',
      [flight_id, req.session.passengerId, seat_number]
    );

    await client.query('COMMIT');
    res.json({ ok: true });

  } catch (err) {
    await client.query('ROLLBACK');
    res.json({ ok: false, message: '이미 예약된 좌석입니다.' });
  } finally {
    client.release();
  }
});

// 내 예약 조회
app.get('/api/my-reservations', async (req, res) => {
  if (!req.session.passengerId) return res.json([]);
  const result = await pool.query(`
    SELECT r.reservation_id, r.seat_number, r.reserved_at,
           f.flight_number, f.departure_airport, f.arrival_airport,
           f.departure_time, f.arrival_time
    FROM reservations r
    JOIN flights f ON r.flight_id = f.flight_id
    WHERE r.passenger_id = $1
    ORDER BY r.reserved_at DESC
  `, [req.session.passengerId]);
  res.json(result.rows);
});

// 예약 취소
app.delete('/api/reserve/:id', async (req, res) => {
  if (!req.session.passengerId) return res.json({ ok: false, message: '로그인 필요' });
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'DELETE FROM reservations WHERE reservation_id = $1 AND passenger_id = $2',
      [id, req.session.passengerId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: false, message: '본인 예약이 아닙니다.' });
    }

    await client.query('COMMIT');
    res.json({ ok: true });

  } catch (err) {
    await client.query('ROLLBACK');
    res.json({ ok: false, message: '취소 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// ───────────────────────────────
app.listen(80, () => {
  console.log('서버 시작: http://localhost:80');
});
