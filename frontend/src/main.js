/* ============================================================
   Afterlife 프론트엔드
   - 화면, 문진 렌더링, 결과 렌더링, 이미지 저장만 담당한다.
   - 프롬프트와 Gemini API 키는 백엔드(backend/)에 있다.
   - 문진 항목은 백엔드가 주는 /questions.json에서 읽는다.
   ============================================================ */
const API_BASE_URL = String(envValue("VITE_API_BASE_URL")).replace(/\/+$/, "");
const DEVICE_ID_STORAGE = "afterlife_device_id";

// Vite 빌드에서는 import.meta.env가 치환되고, 백엔드가 소스를 그대로 서빙할 때는 비어 있다.
function envValue(key) {
  try { return import.meta.env?.[key] || ""; } catch { return ""; }
}

const apiPath = (p) => `${API_BASE_URL}/api/v1${p}`;
const publicPath = (p) => `${API_BASE_URL}${p}`;

// 이용권을 붙일 기기 식별자. 로그인을 붙이면 이 자리를 세션 토큰으로 바꾸면 된다.
function deviceId() {
  try {
    let saved = localStorage.getItem(DEVICE_ID_STORAGE);
    if (!saved) {
      saved = (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(DEVICE_ID_STORAGE, saved);
    }
    return saved;
  } catch {
    return "anonymous";
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(apiPath(path), {
    ...options,
    headers: { "Content-Type": "application/json", "X-Device-Id": deviceId(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

const makeChargeKey = () => `AL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------------- 문진 (백엔드 /questions.json) ---------------- */
let AI_PICK = "캐해석에 맡김";
let PAIR_Q = [];
let SOLO_Q = [];
let APP_CONFIG = { title: "[배포물 이름]", demoMode: true, ticketEnabled: false };
let PASS = { ticketEnabled: false, remaining: null };

/* ---------------- 상태 ---------------- */
const state = {
  mode: "pair",
  answers: { pair: {}, solo: {} },   // id -> {value, etc}
  images: { pair: {}, solo: {} },    // slot -> {data, mime, url}
  last: null,                        // { mode, input }
};

/* ---------------- DOM 헬퍼 ---------------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

/* ---------------- 입력 화면 ---------------- */
function photoInput(mode) {
  const saved = state.images[mode].scene;
  const label = mode === "pair" ? "두 사람이 함께 있는 이미지 (선택)" : "캐릭터 이미지 (선택)";
  const file = h("input", { type: "file", accept: "image/*", class: "hidden", "aria-label": label });
  const btn = h("button", { type: "button", class: "photo scene", "aria-label": label },
    saved ? h("img", { src: saved.url, alt: "" }) : label);
  btn.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const img = await shrinkImage(f);
      state.images[mode].scene = img;
      btn.replaceChildren(h("img", { src: img.url, alt: "" }));
    } catch (e) { toast(e.message); }
  });
  return h("div", {}, btn, file);
}

function textField(mode, id, placeholder) {
  const a = state.answers[mode];
  const el = h("input", { type: "text", id: `${mode}-${id}`, placeholder, value: a[id]?.value === AI_PICK ? "" : (a[id]?.value || "") });
  el.addEventListener("input", () => { a[id] = { value: el.value.trim() }; clearErr(); if (id === "deadName" || id === "livingName") refreshDirLabels(); });
  return el;
}

function dirLabel(mode, v) {
  const a = state.answers[mode];
  const d = a.deadName?.value || "떠난 사람";
  const l = a.livingName?.value || (mode === "pair" ? "남은 사람" : "받을 사람");
  return v === "dead>living" ? `${d} → ${l}` : `${l} → ${d}`;
}
function refreshDirLabels() {
  document.querySelectorAll("[data-dir]").forEach((b) => { b.textContent = dirLabel(state.mode, b.dataset.dir); });
}

function textWithAI(mode, q) {
  const a = state.answers[mode];
  const input = textField(mode, q.id, q.text);
  const btn = h("button", { type: "button", class: "chip ai", "aria-pressed": "false", style: "margin-top:8px" }, "캐해석에 맡기기");
  const sync = () => {
    const on = a[q.id]?.value === AI_PICK;
    btn.setAttribute("aria-pressed", on);
    input.disabled = on;
    if (on) input.value = "";
  };
  btn.addEventListener("click", () => {
    if (a[q.id]?.value === AI_PICK) delete a[q.id]; else a[q.id] = { value: AI_PICK };
    sync(); if (!input.disabled) input.focus();
  });
  sync();
  return h("div", {}, input, btn);
}

function chipGroup(mode, q, isFollow) {
  const a = state.answers[mode];
  const wrap = h("div", {});
  const row = h("div", { class: "chips", role: "group", "aria-label": q.q });
  const etcIn = h("input", { type: "text", class: "etcin hidden", placeholder: "직접 적기" });
  const followBox = h("div", { class: "follow" });
  const items = q.dir
    ? [{ v: "dead>living", dir: true }, { v: "living>dead", dir: true }]
    : [...q.opts.map((o) => ({ v: o })), ...(q.noEtc ? [] : [{ v: "__etc", etc: true }])];
  items.push({ v: AI_PICK, ai: true });

  const showFollow = (val) => {
    followBox.replaceChildren();
    if (!q.follow) return;
    if (q.follow.when.includes(val)) {
      followBox.append(h("div", { class: "q sub" }, "└ " + q.follow.q), chipGroup(mode, q.follow, true));
    } else delete a[q.follow.id];
  };

  const btns = items.map((it) => {
    const b = h("button", { type: "button", class: "chip" + (it.etc ? " etc" : "") + (it.ai ? " ai" : ""), "aria-pressed": "false", "data-dir": it.dir ? it.v : null },
      it.dir ? dirLabel(mode, it.v) : it.etc ? "기타" : it.ai ? "캐해석에 맡기기" : it.v);
    b.addEventListener("click", () => {
      const already = b.getAttribute("aria-pressed") === "true";
      btns.forEach((x) => x.setAttribute("aria-pressed", "false"));
      if (already) { delete a[q.id]; etcIn.classList.add("hidden"); showFollow(null); return; }
      b.setAttribute("aria-pressed", "true");
      if (it.etc) { etcIn.classList.remove("hidden"); etcIn.focus(); a[q.id] = { value: etcIn.value.trim(), etc: true }; showFollow(null); }
      else { etcIn.classList.add("hidden"); a[q.id] = { value: it.v }; showFollow(it.v); }
    });
    return b;
  });
  etcIn.addEventListener("input", () => { if (a[q.id]?.etc) a[q.id].value = etcIn.value.trim(); });

  const cur = a[q.id];
  if (cur) {
    const i = cur.etc ? items.findIndex((it) => it.etc) : items.findIndex((it) => it.v === cur.value);
    if (i >= 0) {
      btns[i].setAttribute("aria-pressed", "true");
      if (cur.etc) { etcIn.value = cur.value; etcIn.classList.remove("hidden"); }
      else showFollow(cur.value);
    }
  }
  row.append(...btns);
  wrap.append(row, etcIn, followBox);
  return wrap;
}

function renderForm() {
  const m = state.mode;
  const form = $("form");
  form.replaceChildren();
  const isPair = m === "pair";

  if (isPair) {
    form.append(h("div", { class: "sec" }, "Ⅰ. 떠난 사람과 남은 사람"));
    form.append(h("div", { class: "pair" },
      h("div", { class: "person" },
        h("div", { class: "role" }, "故 떠난 사람"),
        textField(m, "deadName", "이름"),
        textField(m, "deadVoice", "상대를 부르는 호칭·말투"),
      ),
      h("div", { class: "person" },
        h("div", { class: "role" }, "남은 사람"),
        textField(m, "livingName", "이름"),
        textField(m, "livingVoice", "상대를 부르는 호칭·말투"),
      ),
    ));
  } else {
    form.append(h("div", { class: "sec" }, "Ⅰ. 떠난 사람"));
    form.append(h("div", { class: "person solo-card" },
      h("div", { class: "role" }, "故"),
      textField(m, "deadName", "이름"),
      textField(m, "deadVoice", "받을 사람을 부르는 호칭·말투"),
    ));
  }
  form.append(h("div", { class: "hint" }, "호칭·말투 예: 서하야, 반말 / 당신, 존댓말"));
  form.append(photoInput(m));
  form.append(h("div", { class: "hint" }, "올린 이미지는 결과지 중간과 마지막 장면에 흑백으로 깔려요."));
  form.append(h("div", { class: "q" }, "세계관 연도 표기"));
  form.append(textField(m, "era", "724년 / 제국력 / 현대"));

  for (const q of isPair ? PAIR_Q : SOLO_Q) {
    if (q.sec) { form.append(h("div", { class: "sec" }, q.sec)); continue; }
    form.append(h("div", { class: "q" }, q.q));
    form.append(q.text ? (q.core ? textField(m, q.id, q.text) : textWithAI(m, q)) : chipGroup(m, q));
  }

  form.append(h("div", { class: "sec" }, "덧붙임"));
  form.append(h("div", { class: "q" }, "넣고 싶은 키워드"));
  form.append(textField(m, "keyword", "귤, 남쪽 바다, 오래된 약속"));
  const story = h("textarea", { id: `${m}-story`, placeholder: "프로필 시트, 설정 메모, 서사 무엇이든" }, state.answers[m].story?.value || "");
  story.addEventListener("input", () => { state.answers[m].story = { value: story.value.trim() }; });
  form.append(h("details", {}, h("summary", {}, "서사·프로필 붙여넣기 (있으면 더 정확해져요)"), story));

  form.append(h("div", { class: "submit" },
    h("div", { id: "form-err", class: "err", role: "alert" }),
    h("button", { type: "button", class: "btn-main", id: "btn-submit", onclick: onSubmit }, "접수하기 · 이용권 1장"),
    h("div", { class: "fine" }, "고르지 않은 문항도 캐해석에 맡겨져요."),
  ));
}

function clearErr() { const e = $("form-err"); if (e) e.textContent = ""; }

function setMode(m) {
  state.mode = m;
  $("mode-pair").setAttribute("aria-pressed", m === "pair");
  $("mode-solo").setAttribute("aria-pressed", m === "solo");
  renderForm();
}

/* ---------------- 이미지: 결과지 배경용 흑백 (AI에는 보내지 않음) ---------------- */
function shrinkImage(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("이미지를 읽지 못했어요."));
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const px = ctx.getImageData(0, 0, c.width, c.height), d = px.data;
        for (let i = 0; i < d.length; i += 4) {
          const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          d[i] = d[i + 1] = d[i + 2] = g;
        }
        ctx.putImageData(px, 0, 0);
        const url = c.toDataURL("image/jpeg", 0.82);
        resolve({ url });
      };
      img.onerror = () => reject(new Error("이미지를 열지 못했어요."));
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

/* ---------------- 입력 정리 ---------------- */
function collectInput(mode) {
  const a = state.answers[mode];
  const v = (id) => (a[id]?.value || "").trim();
  const qs = mode === "pair" ? PAIR_Q : SOLO_Q;
  const choices = {};
  for (const q of qs) {
    if (!q.id || q.core) continue;
    let val = v(q.id) || AI_PICK;
    if (q.follow && q.follow.when.includes(val)) {
      const f = a[q.follow.id];
      const fv = !f || !f.value || f.value === AI_PICK ? AI_PICK : q.follow.dir ? dirLabel(mode, f.value) : f.value;
      val += ` (${q.follow.q}: ${fv})`;
    }
    choices[q.q] = val;
  }
  return {
    deadName: v("deadName"), deadVoice: v("deadVoice") || AI_PICK,
    livingName: v("livingName"), livingVoice: v("livingVoice") || AI_PICK,
    era: v("era") || AI_PICK, keyword: v("keyword"), story: v("story"),
    choices,
    raw: { temp: v("temp"), tempDir: a.tempDir?.value || "", relation: v("relation") },
  };
}

/* ---------------- 이용권 ---------------- */
function passText() {
  if (!PASS.ticketEnabled) return "이용권 1장";
  return `이용권 1장 (남은 ${Math.max(0, PASS.remaining || 0)}장)`;
}
function applyPass(pass) {
  if (pass) PASS = { ticketEnabled: !!pass.ticketEnabled, remaining: pass.remaining };
  const submit = $("btn-submit");
  if (submit) submit.textContent = `접수하기 · ${passText()}`;
  const again = $("btn-again");
  if (again) again.textContent = `다시 뽑기 · ${passText()}`;
}
async function refreshPasses() {
  try { applyPass(await apiFetch("/passes")); } catch { applyPass(null); }
}

/* ---------------- 결과 렌더링 ---------------- */
function blocksEl(blocks) {
  return (blocks || []).map((b) =>
    h("p", { class: b.t === "p" ? "r-p" : "r-cry" }, b.text));
}
function scenes(list) {
  const out = [];
  (list || []).forEach((s, i) => {
    if (i) out.push(h("div", { class: "r-rule" }));
    out.push(h("div", { class: "r-label" }, s.label), ...blocksEl(s.blocks));
  });
  return out;
}
function head(input, r, mode) {
  return h("div", { class: "r-head" },
    h("div", { class: "kicker" }, "訃 告"),
    h("div", { class: "name" }, "故 " + input.deadName),
    r.years ? h("div", { class: "years" }, r.years) : null,
    h("div", { class: "meta" },
      r.cause ? h("span", {}, "사인 · " + r.cause) : null,
      mode === "pair" && r.news ? h("span", {}, "소식 · " + r.news) : null),
    mode === "pair"
      ? h("div", { class: "tag" }, "남은 자 · " + input.livingName)
      : h("div", { class: "tag dark" }, "이번 죽음 · " + (r.death_type || "")),
  );
}
function chatBar(name, sub, mode) {
  return h("div", { class: "chat-bar" },
    h("div", { class: "av" }),
    h("div", {}, h("div", { class: "nm" }, name), sub ? h("div", { class: "st" }, sub) : null));
}
function interlude(mode) {
  const img = state.images[mode].scene;
  if (!img) return null;
  return h("div", { class: "interlude", "aria-hidden": "true" },
    h("div", { class: "i-bg", style: `background-image:url(${img.url})` }), h("div", { class: "i-fade" }));
}
function finalEl(f, mode) {
  const img = state.images[mode].scene;
  return h("div", { class: "night" },
    img ? h("div", { class: "n-bg", style: `background-image:url(${img.url})` }) : null,
    img ? h("div", { class: "n-fade" }) : null,
    h("div", { class: "lines" }, ...f.lines.map((l) => h("div", {}, l))),
    h("div", { class: "sig" }, f.signature || ""));
}

function renderPair(input, r) {
  const body = h("div", { class: "chat-body" });
  for (const m of r.messages) {
    if (m.date) body.append(h("div", { class: "day" }, m.date));
    if (m.from === "dead") body.append(h("div", { class: "bub l" }, m.text));
    else if (isAfterDeath(r.messages, m))
      body.append(h("div", { class: "unread" }, h("span", { class: "one" }, "1"), h("div", { class: "bub r" }, m.text)));
    else body.append(h("div", { class: "bub r" }, m.text));
  }
  if (r.end_notice) body.append(h("div", { class: "sys" }, r.end_notice));
  return [
    head(input, r, "pair"),
    h("div", { class: "r-sec boxed" }, h("div", { class: "r-title" }, "Ⅰ. 멈춘 대화"),
      h("div", { class: "chat" }, chatBar(input.deadName, null, "pair"), body)),
    interlude("pair"),
    h("div", { class: "r-sec" }, h("div", { class: "r-title" }, "Ⅱ. 그 후"), ...scenes(r.aftermath)),
    finalEl(r.final, "pair"),
  ];
}
// 떠난 사람의 마지막 메시지 이후 남은 사람의 메시지 = 읽히지 않은 메시지
function isAfterDeath(msgs, m) {
  let lastDead = -1;
  msgs.forEach((x, i) => { if (x.from === "dead") lastDead = i; });
  const idx = msgs.indexOf(m);
  const firstDateAfter = msgs.findIndex((x, i) => i > lastDead && x.date);
  return firstDateAfter >= 0 && idx >= firstDateAfter;
}

function renderSolo(input, r) {
  const drafts = h("div", { class: "drafts" },
    h("div", { class: "draft" }, h("div", { class: "d" }, "임시저장 기록")),
    ...r.drafts.map((d) => h("div", { class: "draft" }, h("div", { class: "d" }, d.date + " · 삭제됨"), h("div", { class: "t" }, d.text))));
  const composing = h("div", { class: "composing" },
    h("div", { class: "d" }, r.last_draft.date + " · 작성 중이던 메시지"),
    h("div", { class: "row" },
      h("div", { class: "t" }, r.last_draft.text, h("span", { class: "caret", "aria-hidden": "true" }, "|")),
      h("div", { class: "no" }, "전송 안 됨")));
  const replyChat = h("div", { class: "chat" },
    h("div", { class: "chat-body" },
      h("div", { class: "day" }, r.reply.date),
      h("div", { class: "unread" }, h("span", { class: "one" }, "1"), h("div", { class: "bub r" }, r.reply.text))));
  return [
    head(input, r, "solo"),
    h("div", { class: "r-sec", style: "border-bottom:1px solid var(--line)" },
      h("div", { class: "r-title" }, "Ⅰ. 마지막 순간"),
      h("p", { class: "r-logline" }, r.logline), ...scenes(r.senses)),
    h("div", { class: "r-sec boxed" }, h("div", { class: "r-title" }, "Ⅱ. 보내지 못한 메시지"),
      h("div", { class: "chat" }, chatBar(input.livingName, "보낸 메시지 없음", "solo"), drafts, composing)),
    interlude("solo"),
    h("div", { class: "r-sec" }, h("div", { class: "r-title" }, "Ⅲ. 발견"), ...scenes(r.discovery)),
    h("div", { class: "r-sec boxed", style: "padding-bottom:36px" }, replyChat),
    finalEl(r.final, "solo"),
  ];
}

function renderResult(mode, input, r) {
  const card = $("result-card");
  const img = state.images[mode].scene;
  card.replaceChildren(...(mode === "pair" ? renderPair(input, r) : renderSolo(input, r)));
  $("btn-again").textContent = "다시 뽑기 · 이용권 1장";
}

/* ---------------- 흐름 ---------------- */
function show(id) {
  for (const s of ["screen-form", "screen-loading", "screen-result"]) $(s).classList.toggle("hidden", s !== id);
  window.scrollTo(0, 0);
}
let loadTimer;
function startLoading() {
  const msgs = ["기록을 정리하는 중", "남은 말을 모으는 중", "마지막 장을 덮는 중"];
  let i = 0; $("loading-text").textContent = msgs[0];
  clearInterval(loadTimer);
  loadTimer = setInterval(() => { i = (i + 1) % msgs.length; $("loading-text").textContent = msgs[i]; }, 2600);
  show("screen-loading");
}
function toast(msg) {
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}

async function run(mode, input, isReroll) {
  if (PASS.ticketEnabled && (PASS.remaining || 0) <= 0) {
    toast("이용권이 없어요. 충전 후 다시 시도해 주세요.");
    return false;
  }
  startLoading();
  try {
    // 프롬프트 조립·Gemini 호출·응답 검증은 전부 백엔드가 한다.
    const data = await apiFetch("/afterlife", {
      method: "POST",
      body: JSON.stringify({ mode, input, chargeKey: makeChargeKey() }),
    });
    state.last = { mode, input };
    renderResult(mode, input, data.result);
    applyPass(data.pass);
    show("screen-result");
    if (data.result?.demo) toast("데모 모드: 예시 결과를 보여드려요.");
    return true;
  } catch (e) {
    console.error(e);
    show(isReroll ? "screen-result" : "screen-form");
    toast(e.message || "결과를 만들지 못했어요.");
    refreshPasses();
    return false;
  } finally { clearInterval(loadTimer); }
}

function onSubmit() {
  const m = state.mode, input = collectInput(m);
  const err = $("form-err");
  if (!input.deadName || !input.livingName) {
    err.textContent = m === "pair" ? "떠난 사람과 남은 사람의 이름을 적어 주세요." : "떠난 사람과 받을 사람의 이름을 적어 주세요.";
    return;
  }
  const cur = state.answers[m];
  const etcEmpty = Object.values(cur).some((a) => a.etc && !a.value);
  if (etcEmpty) { err.textContent = "기타를 고른 문항에 내용을 적어 주세요."; return; }
  run(m, input, false);
}

async function onSave() {
  const card = $("result-card");
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const px = card.offsetWidth * card.offsetHeight;
    const scale = Math.max(1, Math.min(2, Math.sqrt(10500000 / px)));   // 모바일 캔버스 한도 안쪽으로
    const canvas = await html2canvas(card, { backgroundColor: "#f4f1ea", scale, useCORS: true });
    const url = canvas.toDataURL("image/png");
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    const sheet = h("div", { class: "sheet", role: "dialog", "aria-label": "이미지 저장" },
      h("div", { class: "inner" },
        h("img", { src: url, alt: "결과 이미지" }),
        isIOS ? h("div", { class: "fine" }, "이미지를 길게 눌러 저장하세요.")
              : h("a", { href: url, download: "afterlife.png" }, "이미지 내려받기"),
        h("button", { type: "button", onclick: () => sheet.remove() }, "닫기")));
    document.body.append(sheet);
  } catch (e) { console.error(e); toast("이미지를 만들지 못했어요. 화면을 캡처해 주세요."); }
}

/* ---------------- 시작 ---------------- */
$("mode-pair").addEventListener("click", () => setMode("pair"));
$("mode-solo").addEventListener("click", () => setMode("solo"));
$("btn-save").addEventListener("click", onSave);
$("btn-again").addEventListener("click", () => { const l = state.last; if (l) run(l.mode, l.input, true); });
$("btn-back").addEventListener("click", () => { show("screen-form"); });

function applyTitle(title) {
  if (!title) return;
  document.title = title;
  document.querySelectorAll("[data-title]").forEach((el) => { el.textContent = title; });
}

async function boot() {
  try {
    const [questions, config] = await Promise.all([
      fetch(publicPath("/questions.json")).then((r) => {
        if (!r.ok) throw new Error("문진을 불러오지 못했어요.");
        return r.json();
      }),
      apiFetch("/config").catch(() => APP_CONFIG),
    ]);
    AI_PICK = questions.aiPick || AI_PICK;
    PAIR_Q = questions.pair || [];
    SOLO_Q = questions.solo || [];
    APP_CONFIG = { ...APP_CONFIG, ...config };
    applyTitle(APP_CONFIG.title);
    renderForm();
    await refreshPasses();
  } catch (e) {
    console.error(e);
    $("form").replaceChildren(h("div", { class: "err", style: "padding:40px 22px" },
      e.message || "화면을 불러오지 못했어요. 새로고침해 주세요."));
  }
}

boot();
