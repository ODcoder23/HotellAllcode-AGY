/*
 * Channel manager alohida sahifalari — umumiy yordamchi (2026-09-27).
 *
 * Sahifada ma'lumot yo'q: hammasi admin panelda kirilgan token bilan
 * API'dan olinadi (`localStorage.pms_token`). Faqat FOUNDER — backend
 * boshqa rolga 403 qaytaradi, sahifa esa buni aniq aytadi.
 * PMS Beds24'dan faqat o'qiydi: bu sahifalarda Beds24'ga yozadigan
 * tugma yo'q.
 */
(function () {
  function token() {
    try { return localStorage.getItem("pms_token") || ""; } catch (e) { return ""; }
  }

  window.esc = function (v) {
    return v === null || v === undefined ? "" : String(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  window.when = function (iso) {
    if (!iso) return "—";
    const t = new Date(new Date(iso).getTime() + 5 * 3600000);   // Toshkent
    const p = (n) => String(n).padStart(2, "0");
    return p(t.getUTCDate()) + "." + p(t.getUTCMonth() + 1) + "." + t.getUTCFullYear() + " " + p(t.getUTCHours()) + ":" + p(t.getUTCMinutes());
  };

  window.msg = function (text, isErr) {
    const el = document.getElementById("msg");
    if (!el) return;
    el.textContent = text;
    el.className = "msg show " + (isErr ? "err" : "ok");
  };

  function guard(text) {
    const wrap = document.querySelector(".wrap");
    if (wrap) wrap.innerHTML = '<div class="guard">' + text + '<br><br><a href="/admin-panel">Admin panelga o\'tish</a></div>';
  }

  window.api = async function (path, opts) {
    const t = token();
    if (!t) { guard("Avval admin panelga egasi (FOUNDER) hisobi bilan kiring."); throw new Error("token yo'q"); }
    const o = Object.assign({ headers: {} }, opts || {});
    o.headers.Authorization = "Bearer " + t;
    if (o.body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(o.body); }
    const res = await fetch(path, o);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { guard("Sessiya tugagan. Admin panelga qaytadan kiring."); throw new Error("401"); }
    if (res.status === 403) { guard("Bu sahifa faqat mehmonxona egasi (FOUNDER) uchun."); throw new Error("403"); }
    if (!res.ok) throw new Error(data.error || "status " + res.status);
    return data;
  };
})();
