/* js/app.js */
/* BUILD: 20260303-final */
/* dry-ice-course-manager : 完成版（PART1/3） */
"use strict";

/* =========================
   Helpers
========================= */
const $ = (id) => document.getElementById(id);
const clampInt = (v, fallback = 0) => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const pad2 = (n) => String(n).padStart(2, "0");
const uuid = () => "r_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now().toString(36);

/* =========================
   Keys / Rules
========================= */
const APP_KEY = "dryIceCourseManager_vFinal";
const WEEK_KEY = `${APP_KEY}_weekId`;

const VALID_BASES = new Set([25, 30]);
const CUT_MAX = (base) => (base === 25 ? 24 : 29);

// 蓄冷：course×bin単位で加算（指定外は0＝作業しない）
function coolPacksPerCourse(course) {
  if (course >= 501 && course <= 510) return 60;
  if (course >= 601 && course <= 619) return 50;
  if (course >= 621 && course <= 648) return 40;
  return 0;
}

// 切り上げ禁止：ケース=floor、バラ=余り
function toCasesAndRemainder(total, base) {
  return { cases: Math.floor(total / base), rem: total % base };
}

/* =========================
   State
========================= */
const state = {
  // bin
  currentBin: 1,

  // base (25/30)
  baseFromCSV: null,
  baseOverride: null,
  override: false,

  // UI
  currentRange: "501-510",   // "501-510" | "601-619" | "621-648"
  searchKeyword: "",
  currentView: "cards",      // "cards" | "paper" | "data"

  // data
  rows: [],                  // {id, course, bin, shime, cut, group, deleted, selected, checkedPaper}
  groups: ["A","B","C","D","E"],

  // paper checklist
  paperChecklistEnabled: false
};

const els = {};

/* =========================
   Date / Week reset
========================= */
function mondayOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0..6
  const diff = (day === 0 ? -6 : 1 - day); // Monday
  x.setDate(x.getDate() + diff);
  x.setHours(0,0,0,0);
  return x;
}
function weekId(d) {
  const m = mondayOfWeek(d);
  return `${m.getFullYear()}-${pad2(m.getMonth()+1)}-${pad2(m.getDate())}`;
}
function ensureWeekReset() {
  const now = new Date();
  const cur = weekId(now);
  const saved = localStorage.getItem(WEEK_KEY);
  if (saved !== cur) {
    // 週が変わったら全削除（履歴なし）
    localStorage.removeItem(APP_KEY);
    localStorage.setItem(WEEK_KEY, cur);

    state.rows = [];
    state.baseFromCSV = null;
    state.baseOverride = null;
    state.override = false;
    state.currentBin = 1;
    state.currentRange = "501-510";
    state.searchKeyword = "";
    state.currentView = "cards";
    state.paperChecklistEnabled = false;
  }
}

/* =========================
   Storage
========================= */
function loadAll() {
  try {
    const raw = localStorage.getItem(APP_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;

    state.rows = Array.isArray(data.rows) ? data.rows : [];
    state.baseFromCSV = data.baseFromCSV ?? null;
    state.baseOverride = data.baseOverride ?? null;
    state.override = !!data.override;
    state.currentBin = data.currentBin === 2 ? 2 : 1;
    state.currentRange = data.currentRange || "501-510";
    state.searchKeyword = data.searchKeyword || "";
    state.currentView = data.currentView || "cards";
    state.paperChecklistEnabled = !!data.paperChecklistEnabled;
  } catch {
    // 何もしない（壊れた保存は無視）
  }
}
function saveAll() {
  const data = {
    rows: state.rows,
    baseFromCSV: state.baseFromCSV,
    baseOverride: state.baseOverride,
    override: state.override,
    currentBin: state.currentBin,
    currentRange: state.currentRange,
    searchKeyword: state.searchKeyword,
    currentView: state.currentView,
    paperChecklistEnabled: state.paperChecklistEnabled
  };
  localStorage.setItem(APP_KEY, JSON.stringify(data));
}

/* =========================
   Base mode
========================= */
function getEffectiveBase() {
  const b = state.override ? state.baseOverride : state.baseFromCSV;
  return VALID_BASES.has(b) ? b : null;
}
function setBaseFromCSV(base) {
  if (!VALID_BASES.has(base)) return;
  state.baseFromCSV = base;
  if (!state.override) state.baseOverride = null;
}
function setOverrideBase(base) {
  if (!VALID_BASES.has(base)) return;
  state.baseOverride = base;
  state.override = true;
}
function clearOverride() {
  state.override = false;
  state.baseOverride = null;
}

function askBaseIfNeeded() {
  const cur = getEffectiveBase();
  if (cur) return;
  const ans = prompt("〆基準を入力してください（25 または 30）", "25");
  if (ans === null) return;
  const b = clampInt(ans, NaN);
  if (!VALID_BASES.has(b)) {
    alert("25 または 30 のどちらかを入力してください");
    return askBaseIfNeeded();
  }
  // 最初はOVERRIDE扱いで確定（現場事故防止：必ず人が意思決定した基準を持つ）
  setOverrideBase(b);
  saveAll();
}

/* =========================
   CSV parse (OCR禁止：貼り付けのみ)
========================= */
function parseCSV(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error("CSV行が足りません");

  const head = lines[0].split(",").map(s => s.trim());
  if (head[0] !== "shime_size") throw new Error("1行目は shime_size,25 または shime_size,30");
  const base = clampInt(head[1], NaN);
  if (!VALID_BASES.has(base)) throw new Error("shime_size は 25 または 30");

  const cols = lines[1].split(",").map(s => s.trim());
  const ok = cols[0]==="course" && cols[1]==="bin" && cols[2]==="shime" && cols[3]==="cut";
  if (!ok) throw new Error("2行目は course,bin,shime,cut");

  const rows = [];
  for (let i=2; i<lines.length; i++) {
    const p = lines[i].split(",").map(s => s.trim());
    if (p.length < 4) continue;

    const course = clampInt(p[0], NaN);
    const bin = clampInt(p[1], NaN);
    const shime = Math.max(0, clampInt(p[2], 0));
    const cut = Math.max(0, clampInt(p[3], 0));

    if (!Number.isFinite(course)) continue;
    if (bin !== 1 && bin !== 2) continue;

    rows.push({
      id: uuid(),
      course,
      bin,
      shime,
      cut,
      group: "未振分",
      deleted: false,
      selected: false,
      checkedPaper: false
    });
  }
  return { base, rows };
}

/* =========================
   DOM cache
========================= */
function cacheEls() {
  [
    "monthPill","modePill","overridePill","buildLabel",
    "bin1Btn","bin2Btn","mode25Btn","mode30Btn",
    "tab501","tab601","tab621",
    "courseSearch","clearSearch",
    "viewCards","viewPaper","viewData",
    "dryCases","dryBara","coolCases","coolBara",
    "unassignedCount","groupACount","groupBCount","groupCCount","groupDCount","groupECount",
    "btnSelectAllVisible","btnSelectNone","btnRangeSelect","btnDeleteSelected","btnMoveUnassigned",
    "csvInput","applyCSV","clearCSV",
    "addGroupBtn","addCourseBtn","paperChecklistToggle",
    "paperGrid","dataMode","dataBin","dataCode"
  ].forEach((k)=>els[k]=$(k));

  els.content = document.querySelector(".content");
}

/* =========================
   UI helpers
========================= */
function setActive(el, on) {
  if (!el) return;
  if (on) el.classList.add("active");
  else el.classList.remove("active");
}

function updateHeaderPills() {
  const now = new Date();
  const mk = `${now.getFullYear()}-${pad2(now.getMonth()+1)}`;
  if (els.monthPill) els.monthPill.textContent = `MONTH: ${mk}`;

  const base = getEffectiveBase();
  if (els.modePill) els.modePill.textContent = base ? `MODE: ${base}` : `MODE: -`;

  if (els.overridePill) {
    els.overridePill.style.display = state.override ? "inline-block" : "none";
    els.overridePill.textContent = state.override ? "OVERRIDE" : "";
  }
  if (els.buildLabel) els.buildLabel.textContent = "BUILD: 20260303";
}

function applyActiveButtons() {
  setActive(els.bin1Btn, state.currentBin === 1);
  setActive(els.bin2Btn, state.currentBin === 2);

  const base = getEffectiveBase();
  setActive(els.mode25Btn, base === 25);
  setActive(els.mode30Btn, base === 30);

  setActive(els.tab501, state.currentRange === "501-510");
  setActive(els.tab601, state.currentRange === "601-619");
  setActive(els.tab621, state.currentRange === "621-648");

  setActive(els.viewCards, state.currentView === "cards");
  setActive(els.viewPaper, state.currentView === "paper");
  setActive(els.viewData, state.currentView === "data");
}

/* =========================
   Filtering / counts
========================= */
function inRange(course) {
  if (state.currentRange === "501-510") return course >= 501 && course <= 510;
  if (state.currentRange === "601-619") return course >= 601 && course <= 619;
  if (state.currentRange === "621-648") return course >= 621 && course <= 648;
  return true;
}

function getVisibleRows() {
  const kw = String(state.searchKeyword || "").trim();
  return state.rows
    .filter(r => !r.deleted)
    .filter(r => r.bin === state.currentBin)
    .filter(r => inRange(r.course))
    .filter(r => !kw || String(r.course).includes(kw))
    .sort((a,b)=>a.course-b.course || a.bin-b.bin);
}

function getGroupRows(groupName) {
  return getVisibleRows().filter(r => r.group === groupName);
}

// ===== PART1 END =====
/* ===== PART2 START ===== */

/* =========================
   Calculations / Warnings
========================= */
function calcDryForBin(bin) {
  const base = getEffectiveBase();
  if (!base) return { cases: "-", rem: "-", total: 0, base: null };

  const rows = state.rows.filter(r => !r.deleted && r.bin === bin);
  let totalShime = 0;
  let totalCut = 0;
  rows.forEach(r => { totalShime += (r.shime || 0); totalCut += (r.cut || 0); });

  const total = (totalShime * base) + totalCut;
  const { cases, rem } = toCasesAndRemainder(total, base);
  return { cases, rem, total, base };
}

function calcCoolForBin(bin) {
  // course×bin単位：重複は警告対象だが、蓄冷は「ユニーク course」で計算（事故防止）
  const rows = state.rows.filter(r => !r.deleted && r.bin === bin);
  const seen = new Set();
  let totalPacks = 0;

  rows.forEach(r => {
    const key = `${r.course}_${r.bin}`;
    if (seen.has(key)) return; // 重複は数えない（安全側）
    seen.add(key);
    const need = coolPacksPerCourse(r.course);
    // 指定外コースは0＝存在しない＝作業しない
    totalPacks += need;
  });

  const { cases, rem } = toCasesAndRemainder(totalPacks, 20);
  return { cases, rem, totalPacks };
}

function countGroupsForBin(bin) {
  const rows = state.rows.filter(r => !r.deleted && r.bin === bin);
  const counts = { "未振分": 0 };
  state.groups.forEach(g => counts[g] = 0);

  rows.forEach(r => {
    const g = r.group || "未振分";
    if (!(g in counts)) counts[g] = 0;
    counts[g] += 1;
  });
  return counts;
}

function warnDuplicateCourseBin() {
  const rows = state.rows.filter(r => !r.deleted);
  const map = new Map();
  const dup = new Set();
  rows.forEach(r => {
    const key = `${r.course}_${r.bin}`;
    if (map.has(key)) dup.add(key);
    else map.set(key, true);
  });
  return dup; // Set of "course_bin"
}

/* =========================
   Selection / Move / Delete
========================= */
function setSelected(rowId, on) {
  const r = state.rows.find(x => x.id === rowId);
  if (!r || r.deleted) return;
  r.selected = !!on;
}

function toggleSelected(rowId) {
  const r = state.rows.find(x => x.id === rowId);
  if (!r || r.deleted) return;
  r.selected = !r.selected;
}

function clearSelectedAll() {
  state.rows.forEach(r => { r.selected = false; });
}

function selectAllVisible() {
  getVisibleRows().forEach(r => { r.selected = true; });
}

function rangeSelect() {
  const from = prompt("範囲選択：開始course（例 501）", "");
  if (from === null) return;
  const to = prompt("範囲選択：終了course（例 510）", "");
  if (to === null) return;

  const a = clampInt(from, NaN);
  const b = clampInt(to, NaN);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return alert("数字で入力してね");
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  const kw = String(state.searchKeyword || "").trim();
  state.rows
    .filter(r => !r.deleted)
    .filter(r => r.bin === state.currentBin)
    .filter(r => inRange(r.course))
    .filter(r => !kw || String(r.course).includes(kw))
    .filter(r => r.course >= lo && r.course <= hi)
    .forEach(r => r.selected = true);

  saveAll();
  renderAll();
}

function moveSelectedTo(groupName) {
  const target = groupName || "未振分";
  const selected = state.rows.filter(r => !r.deleted && r.bin === state.currentBin && r.selected);
  if (!selected.length) return;

  selected.forEach(r => { r.group = target; r.selected = false; });

  saveAll();
  renderAll();
}

// 「削除＝削除済み棚へ（復活可能）」：直後に復活確認を出す（最短で戻せる）
let lastDeletedIds = [];

function deleteSelected() {
  const selected = state.rows.filter(r => !r.deleted && r.bin === state.currentBin && r.selected);
  if (!selected.length) return;

  if (!confirm(`選択 ${selected.length} 件を削除しますか？（復活可能）`)) return;

  lastDeletedIds = selected.map(r => r.id);
  selected.forEach(r => { r.deleted = true; r.selected = false; });

  saveAll();
  renderAll();

  // 直後に復活できる
  const undo = confirm("削除しました。今すぐ復活しますか？（OK=復活 / キャンセル=そのまま）");
  if (undo) restoreLastDeleted();
}

function restoreLastDeleted() {
  if (!lastDeletedIds.length) return;
  state.rows.forEach(r => {
    if (lastDeletedIds.includes(r.id)) r.deleted = false;
  });
  lastDeletedIds = [];
  saveAll();
  renderAll();
}

/* =========================
   Edit
========================= */
function editRow(rowId) {
  const r = state.rows.find(x => x.id === rowId);
  if (!r || r.deleted) return;

  const base = getEffectiveBase();
  if (!base) askBaseIfNeeded();

  const s = prompt(`course ${r.course} / ${r.bin}便\n〆（shime）を入力`, String(r.shime ?? 0));
  if (s === null) return;
  const c = prompt(`course ${r.course} / ${r.bin}便\ncut を入力`, String(r.cut ?? 0));
  if (c === null) return;

  const sh = Math.max(0, clampInt(s, NaN));
  const cu = Math.max(0, clampInt(c, NaN));
  if (!Number.isFinite(sh) || !Number.isFinite(cu)) return alert("数字で入力してね");

  r.shime = sh;
  r.cut = cu;

  // cut上限警告（事故防止）
  const eff = getEffectiveBase();
  if (eff && cu > CUT_MAX(eff)) {
    alert(`cutが上限を超えています（${eff}期の上限=${CUT_MAX(eff)}）`);
  }

  saveAll();
  renderAll();
}

/* =========================
   Add group / Add course
========================= */
function addGroup() {
  const name = prompt("追加するグループ名（例 F / 夜便 / 追加1）", "");
  if (name === null) return;
  const g = String(name).trim();
  if (!g) return;

  if (state.groups.includes(g)) return alert("同じ名前のグループが既にあります");
  state.groups.push(g);

  // 移動ボタンも追加（見た目は既存と同じ）
  const moveRow = document.querySelector(".moveRow");
  if (moveRow) {
    const b = document.createElement("button");
    b.className = "btn move";
    b.dataset.move = g;
    b.textContent = `${g}へ`;
    moveRow.appendChild(b);
  }

  saveAll();
  renderAll();
  bindMoveButtons(); // 新ボタンにリスナー付与
}

function addCourse() {
  const c = prompt("追加するcourse番号（例 501）", "");
  if (c === null) return;
  const course = clampInt(c, NaN);
  if (!Number.isFinite(course)) return alert("数字で入力してね");

  const b = prompt("bin（1便=1 / 2便=2）", String(state.currentBin));
  if (b === null) return;
  const bin = clampInt(b, NaN);
  if (bin !== 1 && bin !== 2) return alert("binは1か2");

  const s = prompt("〆（shime）", "0");
  if (s === null) return;
  const cut = prompt("cut", "0");
  if (cut === null) return;

  const shime = Math.max(0, clampInt(s, NaN));
  const cu = Math.max(0, clampInt(cut, NaN));
  if (!Number.isFinite(shime) || !Number.isFinite(cu)) return alert("数字で入力してね");

  // cut上限警告
  const eff = getEffectiveBase();
  if (eff && cu > CUT_MAX(eff)) {
    alert(`cutが上限を超えています（${eff}期の上限=${CUT_MAX(eff)}）`);
  }

  state.rows.push({
    id: uuid(),
    course,
    bin,
    shime,
    cut: cu,
    group: "未振分",
    deleted: false,
    selected: false,
    checkedPaper: false
  });

  saveAll();
  renderAll();
}

/* =========================
   Render
========================= */
function renderSummary() {
  const base = getEffectiveBase();
  const dry = calcDryForBin(state.currentBin);
  const cool = calcCoolForBin(state.currentBin);
  const counts = countGroupsForBin(state.currentBin);

  if (els.dryCases) els.dryCases.textContent = base ? String(dry.cases) : "-";
  if (els.dryBara)  els.dryBara.textContent  = base ? String(dry.rem) : "-";

  if (els.coolCases) els.coolCases.textContent = String(cool.cases);
  if (els.coolBara)  els.coolBara.textContent  = String(cool.rem);

  if (els.unassignedCount) els.unassignedCount.textContent = String(counts["未振分"] || 0);

  if (els.groupACount) els.groupACount.textContent = String(counts["A"] || 0);
  if (els.groupBCount) els.groupBCount.textContent = String(counts["B"] || 0);
  if (els.groupCCount) els.groupCCount.textContent = String(counts["C"] || 0);
  if (els.groupDCount) els.groupDCount.textContent = String(counts["D"] || 0);
  if (els.groupECount) els.groupECount.textContent = String(counts["E"] || 0);
}

function renderCards() {
  if (!els.content) return;
  els.content.innerHTML = "";

  const base = getEffectiveBase();
  const dup = warnDuplicateCourseBin();

  // 未振分 + groups
  const order = ["未振分", ...state.groups];

  order.forEach(groupName => {
    const list = getVisibleRows().filter(r => (r.group || "未振分") === groupName);
    const sec = document.createElement("section");
    sec.className = "section";

    const title = document.createElement("div");
    title.className = "sectionTitle";
    title.textContent = `${groupName}（${list.length}）`;
    sec.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "grid";

    if (!list.length) {
      const ph = document.createElement("div");
      ph.className = "card placeholder";
      ph.innerHTML = `<div class="phTitle">空</div><div class="phText">ここにカードが並ぶ</div>`;
      grid.appendChild(ph);
    } else {
      list.forEach(r => {
        const item = document.createElement("div");
        item.className = "item" + (r.selected ? " selected" : "");
        item.dataset.id = r.id;

        const head = document.createElement("div");
        head.className = "itemHead";

        const t = document.createElement("div");
        t.className = "itemTitle";
        t.textContent = `${r.course}`;

        const badges = document.createElement("div");
        badges.className = "badges";

        const b1 = document.createElement("span");
        b1.className = "badgeMini";
        b1.textContent = `${r.bin}便`;
        badges.appendChild(b1);

        const b2 = document.createElement("span");
        b2.className = "badgeMini";
        b2.textContent = `〆:${r.shime} cut:${r.cut}`;
        badges.appendChild(b2);

        // 重複警告
        if (dup.has(`${r.course}_${r.bin}`)) {
          const w = document.createElement("span");
          w.className = "badgeMini warn";
          w.textContent = "DUP";
          badges.appendChild(w);
        }

        // cut上限警告
        if (base && r.cut > CUT_MAX(base)) {
          const w2 = document.createElement("span");
          w2.className = "badgeMini warn";
          w2.textContent = `cut>${CUT_MAX(base)}`;
          badges.appendChild(w2);
        }

        head.appendChild(t);
        head.appendChild(badges);

        const body = document.createElement("div");
        body.className = "itemBody";

        const dryPieces = base ? (r.shime * base + r.cut) : "-";
        const cool = coolPacksPerCourse(r.course);

        body.innerHTML =
          `<div class="kv">ドライ個数: ${dryPieces}</div>` +
          `<div class="kv">蓄冷: ${cool}枚</div>`;

        const foot = document.createElement("div");
        foot.className = "itemFoot";

        const left = document.createElement("div");
        left.className = "kv";
        left.textContent = r.group || "未振分";

        const btns = document.createElement("div");
        btns.className = "itemBtns";

        const edit = document.createElement("button");
        edit.className = "btn small ghost";
        edit.textContent = "編集";
        edit.addEventListener("click", (e) => { e.stopPropagation(); editRow(r.id); });

        const un = document.createElement("button");
        un.className = "btn small ghost";
        un.textContent = "未振分へ";
        un.addEventListener("click", (e) => { e.stopPropagation(); r.selected = true; moveSelectedTo("未振分"); });

        btns.appendChild(edit);
        btns.appendChild(un);

        foot.appendChild(left);
        foot.appendChild(btns);

        item.appendChild(head);
        item.appendChild(body);
        item.appendChild(foot);

        // タップで選択
        item.addEventListener("click", () => {
          toggleSelected(r.id);
          saveAll();
          renderAll();
        });

        grid.appendChild(item);
      });
    }

    sec.appendChild(grid);
    els.content.appendChild(sec);
  });
}

function renderPaper() {
  if (!els.content) return;
  els.content.innerHTML = "";

  const base = getEffectiveBase();
  const rows = getVisibleRows();

  const table = document.createElement("div");
  table.className = "paperTable";

  const header = document.createElement("div");
  header.className = "paperRow header";
  header.innerHTML =
    `<div class="c">course</div><div class="c">〆/cut</div><div class="c">group</div><div class="c">✓</div>`;
  table.appendChild(header);

  rows.forEach(r => {
    const row = document.createElement("div");
    row.className = "paperRow";

    const col1 = document.createElement("div");
    col1.className = "c";
    col1.textContent = `${r.course}`;

    const col2 = document.createElement("div");
    col2.className = "c";
    const dryPieces = base ? (r.shime * base + r.cut) : "-";
    col2.textContent = `〆${r.shime} / cut${r.cut}（${dryPieces}）`;

    const col3 = document.createElement("div");
    col3.className = "c";
    col3.textContent = r.group || "未振分";

    const col4 = document.createElement("div");
    col4.className = "c";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = !!r.checkedPaper;
    chk.addEventListener("change", () => {
      r.checkedPaper = chk.checked;
      saveAll();
    });
    col4.appendChild(chk);

    row.appendChild(col1);
    row.appendChild(col2);
    row.appendChild(col3);
    row.appendChild(col4);

    table.appendChild(row);
  });

  els.content.appendChild(table);
}

function renderData() {
  if (!els.content) return;
  els.content.innerHTML = "";

  const base = getEffectiveBase();
  const bin = state.currentBin;
  const rows = state.rows.filter(r => !r.deleted && r.bin === bin).sort((a,b)=>a.course-b.course);

  const modeTxt = base ? `${base} MODE` : "MODE ?";
  const data =
`// DATA STREAM
// LIVE / BIN ${bin} / ${modeTxt}
// range=${state.currentRange} search="${state.searchKeyword}"
${rows.map(r => {
  return `{"course":${r.course},"bin":${r.bin},"shime":${r.shime},"cut":${r.cut},"group":"${(r.group||"未振分")}"}`;
}).join("\n")}

`;

  const pre = document.createElement("div");
  pre.className = "codeView";
  pre.textContent = data;

  els.content.appendChild(pre);
}

function renderAll() {
  updateHeaderPills();
  applyActiveButtons();
  renderSummary();

  if (state.currentView === "cards") renderCards();
  else if (state.currentView === "paper") renderPaper();
  else renderData();

  bindMoveButtons();
}

/* =========================
   Event binding
========================= */
function bindMoveButtons() {
  // ★重要：ここは相棒が迷った場所。行が潰れないように「必ずこの形」で入れてる
  document.querySelectorAll("button[data-move]").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => moveSelectedTo(btn.dataset.move));
  });
}

function bindEvents() {
  // BIN
  els.bin1Btn?.addEventListener("click", () => { state.currentBin = 1; saveAll(); renderAll(); });
  els.bin2Btn?.addEventListener("click", () => { state.currentBin = 2; saveAll(); renderAll(); });

  // MODE (override)
  els.mode25Btn?.addEventListener("click", () => { setOverrideBase(25); saveAll(); renderAll(); });
  els.mode30Btn?.addEventListener("click", () => { setOverrideBase(30); saveAll(); renderAll(); });

  // RANGE
  els.tab501?.addEventListener("click", () => { state.currentRange = "501-510"; saveAll(); renderAll(); });
  els.tab601?.addEventListener("click", () => { state.currentRange = "601-619"; saveAll(); renderAll(); });
  els.tab621?.addEventListener("click", () => { state.currentRange = "621-648"; saveAll(); renderAll(); });

  // SEARCH
  els.courseSearch?.addEventListener("input", () => {
    state.searchKeyword = els.courseSearch.value || "";
    saveAll(); renderAll();
  });
  els.clearSearch?.addEventListener("click", () => {
    state.searchKeyword = "";
    if (els.courseSearch) els.courseSearch.value = "";
    saveAll(); renderAll();
  });

  // VIEW
  els.viewCards?.addEventListener("click", () => { state.currentView = "cards"; saveAll(); renderAll(); });
  els.viewPaper?.addEventListener("click", () => { state.currentView = "paper"; saveAll(); renderAll(); });
  els.viewData?.addEventListener("click", () => { state.currentView = "data"; saveAll(); renderAll(); });

  // SELECTION
  els.btnSelectAllVisible?.addEventListener("click", () => { selectAllVisible(); saveAll(); renderAll(); });
  els.btnSelectNone?.addEventListener("click", () => { clearSelectedAll(); saveAll(); renderAll(); });
  els.btnRangeSelect?.addEventListener("click", () => rangeSelect());
  els.btnDeleteSelected?.addEventListener("click", () => deleteSelected());
  els.btnMoveUnassigned?.addEventListener("click", () => moveSelectedTo("未振分"));

  // CSV
  els.applyCSV?.addEventListener("click", () => {
    const txt = els.csvInput?.value || "";
    try {
      const parsed = parseCSV(txt);

      // CSV基準最優先
      setBaseFromCSV(parsed.base);

      // 取り込み（既存に追加ではなく、貼り替え運用＝事故防止）
      state.rows = parsed.rows;

      // CSV基準が入ったので override解除（ただし手動で押したらOVERRIDE）
      clearOverride();

      // cut上限チェック（警告のみ）
      const base = getEffectiveBase();
      if (base) {
        const over = state.rows.filter(r => r.cut > CUT_MAX(base));
        if (over.length) alert(`cut上限超えが ${over.length} 件あります（${base}期の上限=${CUT_MAX(base)}）`);
      }

      saveAll();
      renderAll();
    } catch (e) {
      alert(e.message || "CSVエラー");
    }
  });

  els.clearCSV?.addEventListener("click", () => {
    if (els.csvInput) els.csvInput.value = "";
  });

  // ADD
  els.addGroupBtn?.addEventListener("click", () => addGroup());
  els.addCourseBtn?.addEventListener("click", () => addCourse());

  // PAPER CHECK SAVE (toggle)
  els.paperChecklistToggle?.addEventListener("click", () => {
    state.paperChecklistEnabled = !state.paperChecklistEnabled;
    saveAll();
    alert(state.paperChecklistEnabled ? "紙チェックを保存します" : "紙チェック保存をOFFにしました");
  });
}

/* =========================
   Init
========================= */
document.addEventListener("DOMContentLoaded", () => {
  ensureWeekReset();
  cacheEls();
  loadAll();

  // UI復元
  if (els.courseSearch) els.courseSearch.value = state.searchKeyword || "";

  askBaseIfNeeded();     // 初回は必ず基準を持つ（事故防止）
  bindEvents();
  renderAll();
});

/* ===== PART2 END ===== */
/* ===== PART3 START ===== */

/* =========================
   UI Helpers
========================= */

function updateHeaderPills() {
  if (els.monthPill) {
    els.monthPill.textContent = state.monthKey || "-";
  }

  const base = getEffectiveBase();
  if (els.modePill) {
    if (!base) {
      els.modePill.textContent = "MODE ?";
    } else {
      els.modePill.textContent =
        state.overrideBase
          ? `${base}期（手動上書き）`
          : `${base}期`;
    }
  }

  if (els.overridePill) {
    els.overridePill.style.display = state.overrideBase ? "inline-block" : "none";
  }
}

function applyActiveButtons() {
  const toggle = (btn, on) => {
    if (!btn) return;
    if (on) btn.classList.add("active");
    else btn.classList.remove("active");
  };

  toggle(els.bin1Btn, state.currentBin === 1);
  toggle(els.bin2Btn, state.currentBin === 2);

  toggle(els.tab501, state.currentRange === "501-510");
  toggle(els.tab601, state.currentRange === "601-619");
  toggle(els.tab621, state.currentRange === "621-648");

  toggle(els.viewCards, state.currentView === "cards");
  toggle(els.viewPaper, state.currentView === "paper");
  toggle(els.viewData, state.currentView === "data");

  const base = getEffectiveBase();
  toggle(els.mode25Btn, base === 25);
  toggle(els.mode30Btn, base === 30);
}

/* =========================
   Safety Guards
========================= */

// CSVが壊れてもUIが落ちないように
window.addEventListener("error", (e) => {
  console.error("Runtime error:", e.error);
});

// 想定外null保護
function safeText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

/* =========================
   Paper checklist persistence
========================= */

function exportPaperChecklist() {
  const bin = state.currentBin;
  const rows = state.rows.filter(r => !r.deleted && r.bin === bin);

  return rows
    .map(r => `${r.course},${r.checkedPaper ? 1 : 0}`)
    .join("\n");
}

function importPaperChecklist(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  lines.forEach(line => {
    const [c, flag] = line.split(",");
    const course = clampInt(c, NaN);
    if (!Number.isFinite(course)) return;

    state.rows.forEach(r => {
      if (!r.deleted && r.course === course && r.bin === state.currentBin) {
        r.checkedPaper = flag === "1";
      }
    });
  });
  saveAll();
  renderAll();
}

/* =========================
   Visual polish hook
========================= */

// 画面更新時に軽くフェード（動作確認しやすい）
function softFlash() {
  if (!els.content) return;
  els.content.classList.add("flash");
  setTimeout(() => {
    els.content.classList.remove("flash");
  }, 120);
}

// renderAllを軽く拡張
const _renderAllOriginal = renderAll;
renderAll = function () {
  _renderAllOriginal();
  softFlash();
};

/* =========================
   Final Check
========================= */

function finalIntegrityCheck() {
  const base = getEffectiveBase();
  if (!base) {
    console.warn("Base not set yet");
    return;
  }

  const overCut = state.rows.filter(r => !r.deleted && r.cut > CUT_MAX(base));
  if (overCut.length) {
    console.warn("cut over limit:", overCut.length);
  }

  const dup = warnDuplicateCourseBin();
  if (dup.size) {
    console.warn("duplicate course/bin detected:", dup.size);
  }
}

// 初期化後に1回実行
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => finalIntegrityCheck(), 500);
});

/* ===== PART3 END ===== */
