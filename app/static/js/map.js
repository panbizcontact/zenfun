/* ZENFUN 全墳マップ 本体ロジック */
(function () {
  "use strict";

  const CFG = window.ZENFUN_CONFIG || {};
  const IS_AUTH = CFG.isAuthenticated;
  const IS_ADMIN = CFG.isAdmin;
  const SHAPES = CFG.shapes || {};
  // このズーム未満: 透明度のある丸で表現。このズーム以上: 輪郭Pathがあればそれを表示
  // (未登録の古墳は丸のまま)。
  const OUTLINE_ZOOM = 11;

  // ── 地図の初期化: 国土地理院タイル ──
  // 陰影起伏図で地形（山・平野・海）を、淡色地図で道路・注記を重ねる。
  const GSI_ATTR =
    '地理院タイル（<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>）';

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        gsi_hillshade: {
          type: "raster",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png"],
          tileSize: 256, minzoom: 2, maxzoom: 16, attribution: GSI_ATTR,
        },
        gsi_pale: {
          type: "raster",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
          tileSize: 256, minzoom: 2, maxzoom: 18, attribution: GSI_ATTR,
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#c9d3d6" } },
        { id: "hillshade", type: "raster", source: "gsi_hillshade" },
        // 淡色地図を薄く重ねて道路・地名を出す（陰影の地形感を残す）
        { id: "pale", type: "raster", source: "gsi_pale", paint: { "raster-opacity": 0.55 } },
      ],
    },
    center: [135.78, 34.55], // 大和・河内あたり（古墳の密集地）
    zoom: 9,
    maxZoom: 18, minZoom: 4,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

  // ── 状態 ──
  let currentItems = [];     // 現在の取得結果
  let fetchTimer = null;
  let currentDetailId = null;

  // ── 古墳データの取得（範囲＋ズーム＋絞り込み） ──
  function currentFilters() {
    return {
      q: document.getElementById("q").value.trim(),
      prefecture: document.getElementById("f-pref").value,
      shape: document.getElementById("f-shape").value,
      min_length: document.getElementById("f-minlen").value.trim(),
      max_length: document.getElementById("f-maxlen").value.trim(),
    };
  }

  function fetchKofun() {
    const b = map.getBounds();
    const params = new URLSearchParams({
      min_lat: b.getSouth(), max_lat: b.getNorth(),
      min_lng: b.getWest(),  max_lng: b.getEast(),
      zoom: Math.round(map.getZoom()),
    });
    const f = currentFilters();
    Object.entries(f).forEach(([k, v]) => { if (v) params.set(k, v); });

    fetch("/api/kofun?" + params.toString())
      .then((r) => r.json())
      .then((data) => {
        currentItems = data.items;
        renderMapLayers(data.items);
        renderList(data.items, data.count);
      })
      .catch(() => flash("データの取得に失敗しました。", "error"));
  }

  function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchKofun, 250);
  }

  // ── 地図描画: ズーム1〜10は透明度のある丸、ズーム11以上は輪郭Path（あれば） ──
  function renderMapLayers(items) {
    const src = map.getSource("kofun-src");
    const outlineSrc = map.getSource("kofun-outline-src");
    if (!src || !outlineSrc) return; // map "load" 前は無視（load 後に再取得される）

    src.setData({
      type: "FeatureCollection",
      features: items.map((k) => ({
        type: "Feature",
        properties: { id: k.id, has_outline: !!k.has_outline },
        geometry: { type: "Point", coordinates: [k.lng, k.lat] },
      })),
    });

    const outlineFeatures = [];
    items.forEach((k) => {
      if (!k.outline) return;
      // 周堤(複数可。外側・内側)を先に、墳丘を後に積んで墳丘が上に見えるようにする
      (k.outline.moats || []).forEach((m) => {
        const outerOk = m.outer && m.outer.length >= 3;
        const innerOk = m.inner && m.inner.length >= 3;
        if (outerOk && innerOk) {
          outlineFeatures.push(moatRingFeature(k.id, m.outer, m.inner));
        } else if (outerOk) {
          outlineFeatures.push(ringFeature(k.id, "moat", m.outer));
        } else if (innerOk) {
          outlineFeatures.push(ringFeature(k.id, "moat", m.inner));
        }
      });
      if (k.outline.mound && k.outline.mound.length >= 3) {
        outlineFeatures.push(ringFeature(k.id, "mound", k.outline.mound));
      }
      (k.outline.lines || []).forEach((l) => {
        if (l.length >= 2) {
          outlineFeatures.push({
            type: "Feature", properties: { id: k.id, kind: "line" },
            geometry: { type: "LineString", coordinates: l },
          });
        }
      });
    });
    outlineSrc.setData({ type: "FeatureCollection", features: outlineFeatures });
  }

  function closeRing(ring) {
    const coords = ring.slice();
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return coords;
  }

  function ringFeature(id, kind, ring) {
    return {
      type: "Feature",
      properties: { id, kind },
      geometry: { type: "Polygon", coordinates: [closeRing(ring)] },
    };
  }

  // 周堤: 外側の輪の中に内側の輪を「穴」として持たせ、その間の輪状の領域を描く
  function moatRingFeature(id, outer, inner) {
    return {
      type: "Feature",
      properties: { id, kind: "moat" },
      geometry: { type: "Polygon", coordinates: [closeRing(outer), closeRing(inner)] },
    };
  }

  // ── 件数表示（左パネル） ──
  function renderList(items, count) {
    document.getElementById("result-count").textContent = count + " 基";
  }

  // ── 詳細（画面中央・論文体裁） ──
  // 別の記入用紙は設けず、鉛筆アイコンでこの紙をそのまま編集に切り替える。
  let currentKofun = null;     // 表示中の古墳（編集の下敷き。新規追加時は null）
  let historyItems = [];

  function openDetail(id) {
    currentDetailId = id;
    closeSuggest();
    fetch("/api/kofun/" + id).then((r) => r.json()).then((k) => {
      currentKofun = k;
      renderDetail(k);
      setEditing(false);
      document.getElementById("detail-paper").classList.remove("is-new");
      document.getElementById("detail-overlay").classList.add("open");
    });
  }

  // 輪郭の内容を一行で言い表す（閲覧・編集で同じ書式を使う）
  function outlineSummary(outline) {
    if (!outline) return "未設定";
    const parts = [];
    if ((outline.mound || []).length >= 3) parts.push(`墳丘${outline.mound.length}点`);
    const moats = (outline.moats || [])
      .filter((m) => (m.outer || []).length >= 3 || (m.inner || []).length >= 3);
    if (moats.length) parts.push(`周堤${moats.length}`);
    const lines = (outline.lines || []).filter((l) => l.length >= 2);
    if (lines.length) parts.push(`線${lines.length}本`);
    return parts.length ? parts.join(" / ") : "未設定";
  }

  function renderDetail(k) {
    const place = [k.prefecture, k.municipality].filter(Boolean).join(" ");
    document.getElementById("d-eyebrow").textContent = place || "所在地不明";
    document.getElementById("d-name").textContent = k.name;
    document.getElementById("d-kana").textContent = k.name_kana || "";
    document.getElementById("d-byline").textContent =
      [k.shape_ja, k.designation].filter(Boolean).join("　／　");

    const rows = [
      ["所在地", place || "—"],
      ["形状", k.shape_ja || "—"],
      ["墳丘長", k.length_m ? k.length_m + " m" : "—"],
      ["墳丘高", k.height_m ? k.height_m + " m" : "—"],
      ["築造年代", periodText(k)],
      ["指定", k.designation || "—"],
      ["座標", k.lat.toFixed(5) + ", " + k.lng.toFixed(5)],
      ["Path", outlineSummary(k.outline)],
    ];
    document.getElementById("d-table").innerHTML = rows
      .map(([t, v]) => `<tr><th>${t}</th><td>${escapeHtml(String(v))}</td></tr>`).join("");

    document.getElementById("d-desc").textContent = k.description || "";
    document.getElementById("d-desc-section").style.display = k.description ? "" : "none";

    resetHistoryView();

    const deleteBtn = document.getElementById("d-delete");
    if (IS_AUTH) {
      deleteBtn.style.display = "";
      deleteBtn.textContent = IS_ADMIN ? "削除する" : "削除を申請";
      deleteBtn.onclick = () => requestDelete(k);
    } else { deleteBtn.style.display = "none"; }
  }

  function closeDetail() {
    document.getElementById("detail-overlay").classList.remove("open");
    setEditing(false);
    exitOutlineDrawMode();
  }
  document.getElementById("d-close").onclick = closeDetail;
  document.getElementById("detail-overlay").addEventListener("click", (e) => {
    // 編集中は、紙の外を押しても書きかけを失わないようにする
    if (e.target.id === "detail-overlay" && !isEditing()) closeDetail();
  });

  // ── 削除（管理者は即時削除、一般会員は承認申請） ──
  function requestDelete(k) {
    const msg = IS_ADMIN
      ? `「${k.name}」を削除します。よろしいですか？`
      : `「${k.name}」の削除を管理者に申請します。よろしいですか？`;
    if (!confirm(msg)) return;
    apiRequest("/api/kofun/" + k.id, { method: "DELETE" }).then(({ ok, status, d }) => {
      if (!ok) { flash(d.error || "処理に失敗しました。", "error"); return; }
      if (status === 202) { flash(d.message, "success"); return; }
      flash("削除しました。", "success");
      closeDetail();
      fetchKofun();
    });
  }

  // ── 改訂履歴・差し戻し ──
  // 一度に全件並べると紙が長くなるため、履歴は枠の中でスクロールさせる。
  function resetHistoryView() {
    historyItems = [];
    const box = document.getElementById("d-history-scroll");
    box.style.display = "none";
    box.scrollTop = 0;
    document.getElementById("d-history-list").innerHTML = "";
    document.getElementById("d-history-toggle").textContent = "履歴を表示する";
  }

  document.getElementById("d-history-toggle").onclick = () => {
    const box = document.getElementById("d-history-scroll");
    const opening = box.style.display === "none";
    if (opening) loadHistory(currentDetailId);
    box.style.display = opening ? "" : "none";
    document.getElementById("d-history-toggle").textContent =
      opening ? "履歴を閉じる" : "履歴を表示する";
  };

  const ACTION_JA = { create: "追加", update: "編集", delete: "削除", revert: "差し戻し" };

  function loadHistory(id) {
    fetch(`/api/kofun/${id}/history`).then((r) => r.json()).then((items) => {
      historyItems = items;
      renderHistory();
    });
  }

  function renderHistory() {
    const ul = document.getElementById("d-history-list");
    if (!historyItems.length) {
      ul.innerHTML = "<li>履歴はありません。</li>";
      return;
    }
    ul.innerHTML = historyItems.map((h) => {
      const canRevert = IS_ADMIN && h.has_snapshot;
      return `<li>${fmtDate(h.created_at)}・${ACTION_JA[h.action] || h.action}・${escapeHtml(h.username)}` +
        (canRevert ? `<button class="link-btn" data-hist="${h.id}">差し戻す</button>` : "") +
        `</li>`;
    }).join("");
    ul.querySelectorAll("button[data-hist]").forEach((btn) => {
      btn.onclick = () => revertHistory(currentDetailId, btn.dataset.hist);
    });
  }

  function revertHistory(kofunId, histId) {
    if (!confirm("この版に差し戻しますか？")) return;
    apiRequest(`/api/kofun/${kofunId}/history/${histId}/revert`, { method: "POST" })
      .then(({ ok, d }) => {
        if (!ok) { flash(d.error || "差し戻しに失敗しました。", "error"); return; }
        flash("差し戻しました。", "success");
        fetchKofun();
        openDetail(kofunId);
      });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso + "Z").toLocaleString("ja-JP");
  }

  // ── 共通 fetch ラッパー: 429(レート制限)を統一的に扱う ──
  function apiRequest(url, opts) {
    return fetch(url, opts).then((r) => {
      if (r.status === 429) {
        flash("操作が多すぎます。しばらく時間を置いてから再度お試しください。", "error");
        return { ok: false, status: 429, d: {} };
      }
      return r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} }));
    });
  }

  // ── 編集（詳細と同じ紙の上で切り替える） ──
  function isEditing() {
    return document.getElementById("detail-paper").classList.contains("editing");
  }

  function setEditing(on) {
    document.getElementById("detail-paper").classList.toggle("editing", on);
    // 閲覧中だけ鉛筆を出す（未ログインでは出さない）
    document.getElementById("d-edit").style.display = (!on && IS_AUTH) ? "" : "none";
    // 高さは表示されてからでないと測れないので、切り替えたあとに合わせる
    if (on) autoGrow(document.getElementById("e-desc"));
  }

  // 編集欄に値を入れる。k が null なら新規追加。
  function fillEditor(k) {
    k = k || {};
    setVal("e-name", k.name);
    setVal("e-kana", k.name_kana);
    setVal("e-shape", k.shape || "");
    setVal("e-designation", k.designation);
    setVal("e-length", k.length_m);
    setVal("e-height", k.height_m);
    setVal("e-desc", k.description);
    setVal("e-lat", k.lat); setVal("e-lng", k.lng);
    setVal("e-pref", k.prefecture); setVal("e-muni", k.municipality);
    document.getElementById("e-height-note").textContent = "";
    document.getElementById("e-address").textContent =
      [k.prefecture, k.municipality].filter(Boolean).join(" ") || "—";
    setVal("e-period", yearRangeText(k));
    updateCoordText();
    outlineDraft = {
      mound: (k.outline && k.outline.mound) ? k.outline.mound.slice() : [],
      moats: (k.outline && k.outline.moats)
        ? k.outline.moats.map((m) => ({ outer: (m.outer || []).slice(), inner: (m.inner || []).slice() }))
        : [],
      lines: (k.outline && k.outline.lines) ? k.outline.lines.map((l) => l.slice()) : [],
    };
    outlineActiveTarget = "mound";
    updateOutlineStatus();
    updateByline();
  }

  // 築造年代の入力は「400〜500」「690」のように数字と〜だけを受け付ける
  const periodInput = document.getElementById("e-period");
  periodInput.addEventListener("input", () => {
    const cleaned = periodInput.value.replace(/[~～]/g, "〜").replace(/[^0-9〜]/g, "");
    if (cleaned !== periodInput.value) {
      const at = periodInput.selectionStart - (periodInput.value.length - cleaned.length);
      periodInput.value = cleaned;
      periodInput.setSelectionRange(at, at);
    }
    document.getElementById("e-period-note").textContent =
      parseYearRange(periodInput.value) ? "" : "数字と〜だけで入力してください";
  });

  function yearRangeText(k) {
    if (k.year_from == null && k.year_to == null) return "";
    return [k.year_from, k.year_to].filter((y) => y != null).join("〜");
  }

  // "400〜500" → {from:400, to:500} / "690" → {from:690, to:null} / 空 → 両方 null
  // 解釈できない書き方のときは null を返す
  function parseYearRange(text) {
    const t = (text || "").trim();
    if (!t) return { from: null, to: null };
    const m = t.match(/^(\d+)(?:〜(\d+)?)?$/);
    if (!m) return null;
    return { from: parseInt(m[1], 10), to: m[2] ? parseInt(m[2], 10) : null };
  }

  function updateCoordText() {
    const lat = parseFloat(val("e-lat"));
    const lng = parseFloat(val("e-lng"));
    document.getElementById("e-coord").textContent =
      isNaN(lat) || isNaN(lng) ? "—" : lat.toFixed(5) + ", " + lng.toFixed(5);
  }

  // 形状・指定を書き換えたら、見出し下の肩書きもその場で追従させる
  function updateByline() {
    const shape = val("e-shape");
    document.getElementById("d-byline").textContent =
      [shape ? SHAPES[shape] : "", val("e-designation")].filter(Boolean).join("　／　");
  }
  ["e-shape", "e-designation"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateByline);
    document.getElementById(id).addEventListener("change", updateByline);
  });

  // 概要は枠のない本文として書くので、中身に合わせて高さを伸ばす
  function autoGrow(ta) {
    ta.style.height = "0px";       // auto だと行数ぶんの下限が残り、本文より高くなる
    ta.style.height = ta.scrollHeight + "px";
  }
  document.getElementById("e-desc").addEventListener("input", (e) => autoGrow(e.target));

  // 鉛筆アイコン: 表示中の古墳をその場で編集に切り替える
  document.getElementById("d-edit").onclick = () => {
    if (!currentKofun) return;
    fillEditor(currentKofun);
    setEditing(true);
  };

  // 追加: 同じ紙を空のまま編集状態で開く
  function openNewEditor() {
    currentDetailId = null;
    currentKofun = null;
    closeSuggest();
    const c = map.getCenter();
    fillEditor({ lat: c.lat.toFixed(6), lng: c.lng.toFixed(6) });
    document.getElementById("d-eyebrow").textContent = "新規登録";
    document.getElementById("d-kana").textContent = "";
    document.getElementById("detail-paper").classList.add("is-new");
    setEditing(true);
    document.getElementById("detail-overlay").classList.add("open");
    refreshAddress();   // 地図中心の行政区画を裏で引いておく
  }

  document.getElementById("e-cancel").onclick = () => {
    exitOutlineDrawMode();
    if (currentKofun) { renderDetail(currentKofun); setEditing(false); }  // 肩書きも元に戻る
    else { closeDetail(); }
  };

  document.getElementById("e-save").onclick = async () => {
    // val() は空欄のとき null を返すので、必ず文字列に均してから判定する
    const name = (val("e-name") || "").trim();
    const shape = val("e-shape") || "";
    const designation = (val("e-designation") || "").trim();
    const years = parseYearRange(val("e-period"));
    if (!years) { flash("築造年代は「400〜500」のように数字と〜で入力してください。", "error"); return; }
    const missing = [];
    if (!name) missing.push("名称");
    if (!shape) missing.push("形状");
    if (!designation) missing.push("指定");
    if (missing.length) { flash(missing.join("・") + "を入力してください。", "error"); return; }

    // 行政区画がまだ解決できていなければ、保存前に取得を待つ
    if (!val("e-pref") && val("e-lat") && val("e-lng")) {
      try {
        const d = await fetch(`/api/reverse-geocode?lat=${val("e-lat")}&lng=${val("e-lng")}`)
          .then((r) => r.json());
        setVal("e-pref", d.prefecture || "");
        setVal("e-muni", d.municipality || "");
      } catch (_) { /* 取得できなくても保存は続行する */ }
    }

    const outlineObj = {};
    if (outlineDraft.mound.length >= 3) outlineObj.mound = outlineDraft.mound;
    const validMoats = outlineDraft.moats
      .map((m) => {
        const entry = {};
        if (m.outer.length >= 3) entry.outer = m.outer;
        if (m.inner.length >= 3) entry.inner = m.inner;
        return entry;
      })
      .filter((entry) => entry.outer || entry.inner);
    if (validMoats.length) outlineObj.moats = validMoats;
    const validLines = outlineDraft.lines.filter((l) => l.length >= 2);
    if (validLines.length) outlineObj.lines = validLines;

    const payload = {
      name: name, name_kana: val("e-kana"),
      latitude: val("e-lat"), longitude: val("e-lng"),
      prefecture: val("e-pref"), municipality: val("e-muni"),
      shape: shape, length_m: val("e-length"), height_m: val("e-height"),
      year_from: years.from, year_to: years.to,
      designation: designation,
      description: val("e-desc"),
      outline_geojson: Object.keys(outlineObj).length ? JSON.stringify(outlineObj) : "",
    };
    const id = currentDetailId;
    apiRequest(id ? "/api/kofun/" + id : "/api/kofun", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(({ ok, status, d }) => {
      if (!ok) { flash(d.error || "保存に失敗しました。", "error"); return; }
      if (status === 202) { flash(d.message, "success"); closeDetail(); return; }
      flash(id ? "更新しました。" : "追加しました。", "success");
      fetchKofun();
      openDetail(d.id);
    });
  };

  // ── 行政区画の自動判定（緯度経度 → 都道府県・市区町村） ──
  // 入力欄は設けず、座標から国土地理院の逆ジオコーダーで裏側で解決する。
  let addressSeq = 0;

  function refreshAddress() {
    const out = document.getElementById("e-address");
    const lat = parseFloat(val("e-lat"));
    const lng = parseFloat(val("e-lng"));
    if (isNaN(lat) || isNaN(lng)) {
      setVal("e-pref", ""); setVal("e-muni", ""); out.textContent = "—"; return;
    }
    const seq = ++addressSeq;
    out.textContent = "判定中…";
    fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq !== addressSeq) return;  // 新しい問い合わせが始まっていれば破棄
        setVal("e-pref", d.prefecture || "");
        setVal("e-muni", d.municipality || "");
        out.textContent = [d.prefecture, d.municipality].filter(Boolean).join(" ") || "—";
      })
      .catch(() => { if (seq === addressSeq) out.textContent = "—"; });
  }

  // ── 墳丘長: 輪郭（墳丘）が描かれていれば、その最大差し渡しを自動計算する ──
  function distanceMeters(a, b) {
    const R = 6378137;
    const toRad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toRad;
    const dLng = (b[0] - a[0]) * toRad;
    const lat1 = a[1] * toRad, lat2 = b[1] * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // 墳丘長は、墳丘Pathが最も長く伸びる向き（主軸）に沿った差し渡しで測る。
  // 頂点間の最長距離をとると、前方部の角どうしのような斜めの対角線を拾って
  // 実際の墳丘長より長く出てしまうため、主軸に射影した範囲を長さとする。
  function ringMaxLength(ring) {
    if (ring.length < 2) return 0;
    // 緯度経度のままでは向きが歪むので、重心を原点とした平面(メートル)に直す
    const latC = ring.reduce((s2, p) => s2 + p[1], 0) / ring.length;
    const lngC = ring.reduce((s2, p) => s2 + p[0], 0) / ring.length;
    const mPerLat = 111132.0;
    const mPerLng = 111320.0 * Math.cos(latC * Math.PI / 180);
    const pts = ring.map((p) => [(p[0] - lngC) * mPerLng, (p[1] - latC) * mPerLat]);

    // 主軸 = 頂点のばらつきが最大になる向き（二次モーメントの主軸）
    let sxx = 0, syy = 0, sxy = 0;
    pts.forEach(([x, y]) => { sxx += x * x; syy += y * y; sxy += x * y; });
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(theta), uy = Math.sin(theta);

    let min = Infinity, max = -Infinity;
    pts.forEach(([x, y]) => {
      const t = x * ux + y * uy;
      if (t < min) min = t;
      if (t > max) max = t;
    });
    return max - min;
  }

  // 墳丘のPathがあるときは墳丘長を自動計算し、手入力できないようにする
  function syncLengthFromOutline() {
    const input = document.getElementById("e-length");
    const note = document.getElementById("e-length-note");
    const mound = outlineDraft.mound;
    if (mound.length >= 2) {
      input.value = ringMaxLength(mound).toFixed(1);
      input.readOnly = true;
      note.textContent = "Pathの主軸から自動計算";
    } else {
      input.readOnly = false;
      note.textContent = "";
    }
  }

  // ── 墳丘高: 国土地理院の標高から推定する ──
  document.getElementById("e-height-btn").addEventListener("click", () => {
    const lat = parseFloat(val("e-lat"));
    const lng = parseFloat(val("e-lng"));
    const note = document.getElementById("e-height-note");
    if (isNaN(lat) || isNaN(lng)) { note.textContent = "座標が未設定です"; return; }

    const body = { lat, lng };
    if (outlineDraft.mound.length >= 3) {
      body.ring = outlineDraft.mound;   // 墳丘の輪郭を周囲の基準面として使う
    } else if (val("e-length")) {
      body.length_m = val("e-length");  // 輪郭がなければ墳丘長から基準円の大きさを決める
    }

    note.textContent = "標高を取得中…";
    fetch("/api/mound-height", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.height_m === null || d.height_m === undefined) {
          note.textContent = "標高を取得できませんでした";
          return;
        }
        document.getElementById("e-height").value = d.height_m;
        note.textContent = `墳頂 ${d.summit_m}m − 周囲 ${d.base_m}m（DEMによる概算）`;
      })
      .catch(() => { note.textContent = "標高を取得できませんでした"; });
  });

  // ── 輪郭（墳丘・周堤）を地図上のクリックで描く ──
  // 周堤(moat)は二重・三重の周濠を持つ古墳もあるため複数持てる。各周堤は外側・内側の
  // 輪を別々になぞり、両方あれば間の輪状の領域、片方だけならその輪単体を面として保存する。
  // line は閉じないただの線（赤）として複数持てる。
  let outlineDraft = { mound: [], moats: [], lines: [] };  // moats: [{outer:[], inner:[]}, ...]
  let outlineActiveTarget = "mound"; // "mound" | "moat:<i>:outer" | "moat:<i>:inner" | "line:<i>"

  function outlineActiveRing() {
    if (outlineActiveTarget === "mound") return outlineDraft.mound;
    const parts = outlineActiveTarget.split(":");
    if (parts[0] === "moat") {
      const m = outlineDraft.moats[parseInt(parts[1], 10)];
      return m ? m[parts[2]] : null;
    }
    if (parts[0] === "line") {
      return outlineDraft.lines[parseInt(parts[1], 10)] || null;
    }
    return null;
  }

  function updateOutlineStatus() {
    const parts = [];
    if (outlineDraft.mound.length >= 3) parts.push(`墳丘${outlineDraft.mound.length}点`);
    const validMoats = outlineDraft.moats.filter((m) => m.outer.length >= 3 || m.inner.length >= 3);
    if (validMoats.length) parts.push(`周堤${validMoats.length}`);
    const validLines = outlineDraft.lines.filter((l) => l.length >= 2);
    if (validLines.length) parts.push(`線${validLines.length}本`);
    document.getElementById("e-outline-status").textContent =
      parts.length ? parts.join(" / ") : "未設定";
    document.getElementById("e-outline-btn").textContent =
      parts.length ? "Pathを編集する" : "Pathを設定する";
    syncLengthFromOutline();   // 墳丘のPathから墳丘長を引き直す
  }

  function updateOutlineDraftLayer() {
    const src = map.getSource("outline-draft-src");
    if (!src) return;
    const features = [];
    function addRing(pts, kind, closeIt) {
      if (pts.length >= 2) {
        const coords = (closeIt && pts.length >= 3) ? pts.concat([pts[0]]) : pts;
        features.push({
          type: "Feature", properties: { kind, role: "line" },
          geometry: { type: "LineString", coordinates: coords },
        });
      }
      pts.forEach((p) => {
        features.push({
          type: "Feature", properties: { kind, role: "vertex" },
          geometry: { type: "Point", coordinates: p },
        });
      });
    }
    addRing(outlineDraft.mound, "mound", true);
    outlineDraft.moats.forEach((m) => {
      addRing(m.outer, "moat", true);
      addRing(m.inner, "moat", true);
    });
    outlineDraft.lines.forEach((l) => addRing(l, "line", false));
    src.setData({ type: "FeatureCollection", features });
    const ring = outlineActiveRing();
    document.getElementById("outline-point-count").textContent = (ring ? ring.length : 0) + "点";
  }

  // 対象（墳丘 / 周堤N：外側・内側 / 線N）の切り替えボタンを都度組み立てる
  function renderOutlineTargets() {
    const wrap = document.getElementById("outline-targets");
    wrap.innerHTML = "";
    const addToggle = (label, target) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.classList.toggle("active", outlineActiveTarget === target);
      b.addEventListener("click", () => {
        outlineActiveTarget = target;
        renderOutlineTargets();
        updateOutlineDraftLayer();
      });
      wrap.appendChild(b);
    };
    const addDelete = (label, onClick) => {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = label;
      del.addEventListener("click", onClick);
      wrap.appendChild(del);
    };

    addToggle("墳丘のPath", "mound");
    outlineDraft.moats.forEach((m, i) => {
      addToggle(`周堤${i + 1}：外側`, `moat:${i}:outer`);
      addToggle(`周堤${i + 1}：内側`, `moat:${i}:inner`);
      addDelete(`周堤${i + 1}を削除`, () => {
        outlineDraft.moats.splice(i, 1);
        if (outlineActiveTarget.startsWith(`moat:${i}:`)) outlineActiveTarget = "mound";
        renderOutlineTargets();
        updateOutlineDraftLayer();
      });
    });
    outlineDraft.lines.forEach((l, i) => {
      addToggle(`線${i + 1}`, `line:${i}`);
      addDelete(`線${i + 1}を削除`, () => {
        outlineDraft.lines.splice(i, 1);
        if (outlineActiveTarget === `line:${i}`) outlineActiveTarget = "mound";
        renderOutlineTargets();
        updateOutlineDraftLayer();
      });
    });

    const addMoatBtn = document.createElement("button");
    addMoatBtn.type = "button";
    addMoatBtn.className = "add";
    addMoatBtn.textContent = "＋ 周堤を追加";
    addMoatBtn.addEventListener("click", () => {
      outlineDraft.moats.push({ outer: [], inner: [] });
      outlineActiveTarget = `moat:${outlineDraft.moats.length - 1}:outer`;
      renderOutlineTargets();
      updateOutlineDraftLayer();
    });
    wrap.appendChild(addMoatBtn);

    const addLineBtn = document.createElement("button");
    addLineBtn.type = "button";
    addLineBtn.className = "add";
    addLineBtn.textContent = "＋ 線を追加";
    addLineBtn.addEventListener("click", () => {
      outlineDraft.lines.push([]);
      outlineActiveTarget = `line:${outlineDraft.lines.length - 1}`;
      renderOutlineTargets();
      updateOutlineDraftLayer();
    });
    wrap.appendChild(addLineBtn);
  }

  document.getElementById("outline-undo").addEventListener("click", () => {
    const ring = outlineActiveRing();
    if (ring) ring.pop();
    updateOutlineDraftLayer();
  });
  document.getElementById("outline-clear-shape").addEventListener("click", () => {
    const ring = outlineActiveRing();
    if (ring) ring.length = 0;
    updateOutlineDraftLayer();
  });

  function onOutlineMapClick(e) {
    const ring = outlineActiveRing();
    if (!ring) return;
    ring.push([e.lngLat.lng, e.lngLat.lat]);
    updateOutlineDraftLayer();
  }

  function enterOutlineDrawMode() {
    document.getElementById("outline-map-toolbar").classList.add("open");
    document.body.classList.add("map-edit-mode");
    const lat = parseFloat(val("e-lat"));
    const lng = parseFloat(val("e-lng"));
    if (!isNaN(lat) && !isNaN(lng)) map.panTo([lng, lat], { duration: 300 });
    outlineActiveTarget = "mound";
    renderOutlineTargets();
    updateOutlineDraftLayer();
    map.on("click", onOutlineMapClick);
  }

  function exitOutlineDrawMode() {
    const toolbar = document.getElementById("outline-map-toolbar");
    if (!toolbar.classList.contains("open")) return;   // 描画中でなければ何もしない
    map.off("click", onOutlineMapClick);
    toolbar.classList.remove("open");
    document.body.classList.remove("map-edit-mode");
    const src = map.getSource("outline-draft-src");
    if (src) src.setData({ type: "FeatureCollection", features: [] });
    // 墳丘を描いたら、その重心をこの古墳の座標として採用する
    // （地点と輪郭がずれたまま登録されるのを防ぐ）
    if (outlineDraft.mound.length >= 3) {
      const n = outlineDraft.mound.length;
      const lng = outlineDraft.mound.reduce((s, p) => s + p[0], 0) / n;
      const lat = outlineDraft.mound.reduce((s, p) => s + p[1], 0) / n;
      setVal("e-lat", lat.toFixed(6)); setVal("e-lng", lng.toFixed(6));
      updateCoordText();
      refreshAddress();
    }
    updateOutlineStatus();
  }

  document.getElementById("e-outline-btn").addEventListener("click", enterOutlineDrawMode);
  document.getElementById("outline-done").addEventListener("click", exitOutlineDrawMode);

  // 追加ボタン
  const addBtn = document.getElementById("btn-add");
  if (addBtn) addBtn.onclick = () => IS_AUTH ? openNewEditor()
    : (location.href = "/auth/login");

  // ── フィルタ操作 ──
  ["f-pref", "f-shape", "f-minlen", "f-maxlen"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", scheduleFetch);
    el.addEventListener("change", scheduleFetch);
  });

  // ── 検索候補（文字のみのサジェスト） ──
  const qInput = document.getElementById("q");
  const suggestList = document.getElementById("suggest-list");
  let suggestTimer = null;
  let suggestItems = [];
  let suggestIndex = -1;

  function closeSuggest() {
    suggestList.classList.remove("open");
    suggestList.innerHTML = "";
    suggestItems = [];
    suggestIndex = -1;
    qInput.setAttribute("aria-expanded", "false");
  }

  function renderSuggest(items) {
    suggestItems = items;
    suggestIndex = -1;
    if (!items.length) {
      suggestList.innerHTML = '<li class="empty">該当する古墳が見つかりません</li>';
    } else {
      suggestList.innerHTML = items
        .map((k, i) => `<li role="option" data-i="${i}">${escapeHtml(k.name)}</li>`).join("");
      suggestList.querySelectorAll("li[data-i]").forEach((li) => {
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();  // input の blur より先に選択を確定させる
          chooseSuggest(parseInt(li.dataset.i, 10));
        });
      });
    }
    suggestList.classList.add("open");
    qInput.setAttribute("aria-expanded", "true");
  }

  function chooseSuggest(i) {
    const k = suggestItems[i];
    if (!k) return;
    qInput.value = k.name;
    closeSuggest();
    map.flyTo({ center: [k.lng, k.lat], zoom: Math.max(map.getZoom(), 15) });
    openDetail(k.id);
  }

  function highlightSuggest(next) {
    const lis = suggestList.querySelectorAll("li[data-i]");
    if (!lis.length) return;
    suggestIndex = (next + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle("active", i === suggestIndex));
  }

  qInput.addEventListener("input", () => {
    scheduleFetch();  // 地図側の絞り込みも従来どおり連動させる
    const kw = qInput.value.trim();
    clearTimeout(suggestTimer);
    if (!kw) { closeSuggest(); return; }
    suggestTimer = setTimeout(() => {
      fetch("/api/kofun/suggest?q=" + encodeURIComponent(kw))
        .then((r) => r.json())
        .then(renderSuggest)
        .catch(() => closeSuggest());
    }, 180);
  });

  qInput.addEventListener("keydown", (e) => {
    if (!suggestList.classList.contains("open")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); highlightSuggest(suggestIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlightSuggest(suggestIndex - 1); }
    else if (e.key === "Enter") {
      if (suggestIndex >= 0) { e.preventDefault(); chooseSuggest(suggestIndex); }
    } else if (e.key === "Escape") { closeSuggest(); }
  });

  qInput.addEventListener("blur", () => setTimeout(closeSuggest, 120));
  qInput.addEventListener("focus", () => {
    if (qInput.value.trim() && suggestItems.length) suggestList.classList.add("open");
  });

  // ── 地図イベント ──
  map.on("moveend", scheduleFetch);
  map.on("load", () => {
    setupMapLayers();
    const flyToId = new URLSearchParams(location.search).get("flyto");
    if (flyToId) {
      flyToKofun(flyToId);
    } else {
      fetchKofun();
    }
  });

  // ── レビュー画面などからの「地図で見る」リンク対応 ──
  // 規模フィルタに関わらず対象の古墳へ寄って詳細を開く（?flyto=<id>）。
  function flyToKofun(id) {
    fetch("/api/kofun/" + id).then((r) => {
      if (!r.ok) throw new Error("not found");
      return r.json();
    }).then((k) => {
      map.jumpTo({ center: [k.lng, k.lat], zoom: 15 });
      fetchKofun();
      // 地図の読み込みが遅れてこの処理が編集中に走ることがあるため、
      // 書きかけを上書きしないようにする
      if (!isEditing()) openDetail(k.id);
    }).catch(() => {
      flash("指定された古墳が見つかりませんでした。", "error");
      fetchKofun();
    });
  }

  // ── 地図レイヤーのセットアップ（1回だけ） ──
  function setupMapLayers() {
    // 古墳の位置（円）。ズーム11未満は全件、11以上は輪郭Path未登録のものだけ。
    map.addSource("kofun-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: OUTLINE_ZOOM,
      clusterRadius: 50,
    });
    // 輪郭Path（墳丘・周堤）。ズーム11以上のみ表示。
    map.addSource("kofun-outline-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    // 輪郭を描いている最中のプレビュー
    map.addSource("outline-draft-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "clusters", type: "circle", source: "kofun-src",
      filter: ["has", "point_count"],
      maxzoom: OUTLINE_ZOOM,
      paint: {
        "circle-color": ["step", ["get", "point_count"], "#a9863f", 50, "#9e3b2e", 200, "#5a2b22"],
        "circle-radius": ["step", ["get", "point_count"], 16, 50, 22, 200, 28],
        "circle-opacity": 0.55,
        "circle-stroke-width": 2, "circle-stroke-color": "#fff8ec", "circle-stroke-opacity": 0.9,
      },
    });
    map.addLayer({
      id: "kofun-circles", type: "circle", source: "kofun-src",
      filter: ["!", ["has", "point_count"]],
      maxzoom: OUTLINE_ZOOM,
      paint: {
        "circle-color": "#9e3b2e", "circle-opacity": 0.45,
        "circle-radius": 6,
        "circle-stroke-width": 1.5, "circle-stroke-color": "#9e3b2e", "circle-stroke-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "kofun-circles-hi", type: "circle", source: "kofun-src",
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "has_outline"], false]],
      minzoom: OUTLINE_ZOOM,
      paint: {
        "circle-color": "#9e3b2e", "circle-opacity": 0.45,
        "circle-radius": 7,
        "circle-stroke-width": 1.5, "circle-stroke-color": "#9e3b2e", "circle-stroke-opacity": 0.85,
      },
    });
    // 墳丘・周堤・線とも同じ赤(#9e3b2e)。重なりが見えるよう周堤は不透明度を下げる。
    map.addLayer({
      id: "kofun-outline-fill", type: "fill", source: "kofun-outline-src",
      minzoom: OUTLINE_ZOOM,
      filter: ["!=", ["get", "kind"], "line"],
      paint: {
        "fill-color": "#9e3b2e",
        "fill-opacity": ["match", ["get", "kind"], "moat", 0.3, 0.55],
      },
    });
    map.addLayer({
      id: "kofun-outline-line", type: "line", source: "kofun-outline-src",
      minzoom: OUTLINE_ZOOM,
      filter: ["!=", ["get", "kind"], "line"],
      paint: { "line-color": "#9e3b2e", "line-width": 1.5 },
    });
    // 単純な線（ただの赤い線として描く）
    map.addLayer({
      id: "kofun-outline-userline", type: "line", source: "kofun-outline-src",
      minzoom: OUTLINE_ZOOM,
      filter: ["==", ["get", "kind"], "line"],
      paint: { "line-color": "#9e3b2e", "line-width": 2.5 },
    });

    // 輪郭の描画中プレビュー
    map.addLayer({
      id: "outline-draft-line", type: "line", source: "outline-draft-src",
      filter: ["==", ["get", "role"], "line"],
      paint: { "line-color": "#9e3b2e", "line-width": 2, "line-dasharray": [2, 1] },
    });
    map.addLayer({
      id: "outline-draft-points", type: "circle", source: "outline-draft-src",
      filter: ["==", ["get", "role"], "vertex"],
      paint: {
        "circle-radius": 5, "circle-color": "#9e3b2e",
        "circle-stroke-width": 2, "circle-stroke-color": "#fff8ec",
      },
    });

    map.on("click", "clusters", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
      const clusterId = features[0].properties.cluster_id;
      map.getSource("kofun-src").getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });
    const openFromFeature = (e) => openDetail(e.features[0].properties.id);
    ["kofun-circles", "kofun-circles-hi", "kofun-outline-fill", "kofun-outline-userline"].forEach((id) => {
      map.on("click", id, openFromFeature);
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    });
    map.on("mouseenter", "clusters", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; });
  }

  // ── ユーティリティ ──
  function val(id) { const v = document.getElementById(id).value.trim(); return v === "" ? null : v; }
  function setVal(id, v) { document.getElementById(id).value = (v ?? "") === null ? "" : (v ?? ""); }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // 築造年代の「期」は、記録された年から機械的に決める
  // （〜299 出現期 / 300〜399 前期 / 400〜499 中期 / 500〜599 後期 / 600〜 終末期）
  const PERIOD_BANDS = [[300, "出現期"], [400, "前期"], [500, "中期"], [600, "後期"]];

  function periodOf(year) {
    for (const [upto, name] of PERIOD_BANDS) if (year < upto) return name;
    return "終末期";
  }

  function periodText(k) {
    const base = k.year_from != null ? k.year_from : k.year_to;
    if (base == null) return k.period || "—";
    const f = k.year_from != null ? fmtYear(k.year_from) : "";
    const t = k.year_to != null ? fmtYear(k.year_to) : "";
    return periodOf(base) + " " + [f, t].filter(Boolean).join("〜");
  }
  function fmtYear(y) { return y < 0 ? "前" + (-y) : y + ""; }

  window.zenfunFlash = flash;
  function flash(msg, type) {
    const box = document.getElementById("flash");
    const el = document.createElement("div");
    el.className = "flash-item " + (type || "success");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
})();
