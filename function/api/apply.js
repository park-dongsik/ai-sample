// 2026-11-28 rev.11 — 특강 신청서 저장 API
// 신청 페이지(index.html)의 신청서가 이 주소(/api/apply)로 입력값을 보내면
// Cloudflare D1 sample-db 의 applicants 표에 한 줄 저장하고, 저장된 내용을 돌려준다.
// Pages 설정 → Bindings 에 sample-db 를 연결해 두어야 한다 (변수 이름은 DB 권장).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// 연결된 D1 찾기: 변수 이름이 DB 가 아니어도 D1 연결을 찾아서 쓴다
function findDB(env) {
  if (env.DB && typeof env.DB.prepare === "function") return env.DB;
  return Object.values(env || {}).find((v) => v && typeof v.prepare === "function" && typeof v.batch === "function");
}

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  const db = findDB(env);
  if (!db) return json({ ok: false, error: "DB가 연결되지 않았습니다. Pages 설정의 Bindings에 sample-db를 연결해 주세요." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "잘못된 요청입니다." }, 400); }

  const d = {
    name: clean(body.name, 50),
    phone: clean(body.phone, 20),
    email: clean(body.email, 100),
    organization: clean(body.organization, 100),
    position: clean(body.position, 50),
  };

  if (!d.name) return json({ ok: false, field: "name", error: "이름을 입력해 주세요." }, 400);
  if (!/^[0-9+\-\s()]{8,20}$/.test(d.phone)) return json({ ok: false, field: "phone", error: "연락처를 다시 확인해 주세요." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return json({ ok: false, field: "email", error: "이메일 주소를 다시 확인해 주세요." }, 400);

  // 소속 칸 이름: 기본은 organization, 슬라이드 SQL로 만든 표라면 company
  const insert = (orgCol) =>
    db.prepare(
      `INSERT INTO applicants (name, ${orgCol}, position, phone, email)
       VALUES (?1, ?2, ?3, ?4, ?5)
       RETURNING id, name, ${orgCol} AS organization, position, phone, email, created_at`
    ).bind(d.name, d.organization || null, d.position || null, d.phone, d.email).first();

  try {
    let row;
    try {
      row = await insert("organization");
    } catch (e) {
      if (!/no column named organization|no such column: organization/i.test(String(e && e.message))) throw e;
      row = await insert("company");
    }
    return json({ ok: true, applicant: row }, 201);
  } catch (e) {
    const m = String(e && e.message);
    if (/UNIQUE/i.test(m)) return json({ ok: false, field: "email", error: "이미 신청한 이메일입니다." }, 409);
    if (/no such table/i.test(m)) return json({ ok: false, error: "applicants 표가 없습니다. D1 콘솔에서 표를 먼저 만들어 주세요." }, 500);
    return json({ ok: false, error: "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok: false, error: "POST로만 신청할 수 있습니다." }, 405);
}
