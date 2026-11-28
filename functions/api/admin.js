// 2026-11-28 rev.1 — 특강 신청자 관리자 API (/api/admin)
// - 로그인(POST {action:"login", password})        : Cloudflare Secret ADMIN_PASSWORD 와 비교 → 맞으면 입장권(token) 발급
// - 목록(GET)                                      : 입장권 확인 → applicants 표 전체(최근 신청 순) + 총 인원
// - 수정(PUT {id, name, organization, position, phone, email}) : 입장권 확인 → 한 줄 고침
// - 삭제(DELETE ?id=번호)                           : 입장권 확인 → 한 줄 지움
// 비밀번호는 코드에 없음. 입장권은 ADMIN_PASSWORD로 서명하므로 비밀번호를 바꾸면 이전 입장권은 모두 무효.
// D1 바인딩 이름: DB

const TOKEN_HOURS = 12; // 입장권 유효 시간 (탭을 닫으면 브라우저에서 먼저 사라짐)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const enc = new TextEncoder();
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

// 길이와 상관없이 같은 시간에 비교 (비밀번호를 한 글자씩 알아내는 공격 방지)
async function sameText(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

async function makeToken(secret) {
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  return exp + "." + (await hmac(secret, "admin:" + exp));
}

async function checkToken(request, secret) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\d+)\.([\w-]+)$/);
  if (!m) return false;
  if (Number(m[1]) < Date.now()) return false;
  return sameText(m[2], await hmac(secret, "admin:" + m[1]));
}

// 소속 칸 이름 찾기: organization(기본) 또는 company(슬라이드 SQL)
async function orgColumn(db) {
  try {
    const { results } = await db.prepare("PRAGMA table_info(applicants)").all();
    const names = (results || []).map((r) => r.name);
    if (!names.includes("organization") && names.includes("company")) return "company";
  } catch (e) { /* 확인이 안 되면 기본값 */ }
  return "organization";
}

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

function dbError(e) {
  const m = String(e && e.message);
  if (/UNIQUE/i.test(m)) return json({ ok: false, field: "email", error: "이미 다른 신청자가 사용 중인 이메일입니다." }, 409);
  if (/no such table/i.test(m)) return json({ ok: false, error: "applicants 표가 없습니다." }, 500);
  return json({ ok: false, error: "DB 작업에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 500);
}

// 모든 요청 공통 준비: 설정 확인 + 입장권 확인
async function guard(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "ADMIN_PASSWORD가 설정되지 않았습니다. Cloudflare Secret을 확인해 주세요." }, 500);
  if (!env.DB) return json({ ok: false, error: "DB가 연결되지 않았습니다. Bindings에서 이름 DB로 sample-db를 연결해 주세요." }, 500);
  if (!(await checkToken(request, env.ADMIN_PASSWORD))) return json({ ok: false, auth: false, error: "다시 로그인해 주세요." }, 401);
  return null;
}

// 로그인
export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "ADMIN_PASSWORD가 설정되지 않았습니다. Cloudflare Secret을 확인해 주세요." }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) { /* 빈 요청 */ }
  if (body.action !== "login") return json({ ok: false, error: "잘못된 요청입니다." }, 400);
  if (!(await sameText(body.password || "", env.ADMIN_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 600)); // 연속으로 마구 넣어 보는 것을 느리게
    return json({ ok: false, error: "비밀번호가 맞지 않습니다" }, 401);
  }
  return json({ ok: true, token: await makeToken(env.ADMIN_PASSWORD) });
}

// 목록 (최근 신청 순)
export async function onRequestGet({ request, env }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  try {
    const org = await orgColumn(env.DB);
    const { results } = await env.DB.prepare(
      `SELECT id, name, ${org} AS organization, position, phone, email, created_at
       FROM applicants ORDER BY created_at DESC, id DESC`
    ).all();
    return json({ ok: true, total: results.length, applicants: results });
  } catch (e) {
    return dbError(e);
  }
}

// 수정
export async function onRequestPut({ request, env }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "잘못된 요청입니다." }, 400); }

  const id = Number(body.id);
  const d = {
    name: clean(body.name, 50),
    organization: clean(body.organization, 100),
    position: clean(body.position, 50),
    phone: clean(body.phone, 20),
    email: clean(body.email, 100),
  };
  if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: "신청 번호가 올바르지 않습니다." }, 400);
  if (!d.name) return json({ ok: false, field: "name", error: "이름을 입력해 주세요." }, 400);
  if (!/^[0-9+\-\s()]{8,20}$/.test(d.phone)) return json({ ok: false, field: "phone", error: "연락처를 다시 확인해 주세요." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return json({ ok: false, field: "email", error: "이메일 주소를 다시 확인해 주세요." }, 400);

  try {
    const org = await orgColumn(env.DB);
    const row = await env.DB.prepare(
      `UPDATE applicants SET name = ?1, ${org} = ?2, position = ?3, phone = ?4, email = ?5 WHERE id = ?6
       RETURNING id, name, ${org} AS organization, position, phone, email, created_at`
    ).bind(d.name, d.organization || null, d.position || null, d.phone, d.email, id).first();
    if (!row) return json({ ok: false, error: "이미 삭제된 신청입니다. 목록을 새로 불러옵니다." }, 404);
    return json({ ok: true, applicant: row });
  } catch (e) {
    return dbError(e);
  }
}

// 삭제
export async function onRequestDelete({ request, env }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: "신청 번호가 올바르지 않습니다." }, 400);
  try {
    const r = await env.DB.prepare("DELETE FROM applicants WHERE id = ?1").bind(id).run();
    const changed = r && r.meta ? r.meta.changes : 1;
    if (!changed) return json({ ok: false, error: "이미 삭제된 신청입니다." }, 404);
    return json({ ok: true, id });
  } catch (e) {
    return dbError(e);
  }
}
