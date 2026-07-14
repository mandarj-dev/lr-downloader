const form = document.getElementById("download-form");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const resultsBody = document.getElementById("results-body");

const MAX_LR_PER_REQUEST =
  (window.LR_DOWNLOADER_CONFIG && window.LR_DOWNLOADER_CONFIG.maxLrPerRequest) ||
  50;

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove("hidden");
}

function clearStatus() {
  statusEl.classList.add("hidden");
}

function triggerZipDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function sanitizeName(value) {
  const cleaned = String(value)
    .trim()
    .replace(/[^A-Za-z0-9_\-. ]+/g, "_")
    .replace(/\.\./g, "_");
  return cleaned || "unnamed";
}

function parseLrNumbers(raw) {
  const lines = raw
    .replace(/,/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const cleaned = sanitizeName(line);
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchBatch(invoiceNo, lrChunk) {
  const formData = new FormData();
  formData.append("invoice_no", invoiceNo);
  formData.append("lr_numbers", lrChunk.join("\n"));

  const resp = await fetch("/api/download", {
    method: "POST",
    body: formData,
  });

  const contentType = resp.headers.get("content-type") || "";

  if (contentType.includes("application/zip")) {
    const blob = await resp.blob();
    const resultsHeader = resp.headers.get("x-results");
    const results = resultsHeader ? JSON.parse(resultsHeader) : [];
    return {
      ok: true,
      zipBlob: blob,
      results,
      success_count: Number(resp.headers.get("x-success-count") || 0),
      not_found_count: Number(resp.headers.get("x-not-found-count") || 0),
      total: Number(resp.headers.get("x-total") || results.length),
    };
  }

  const data = await resp.json().catch(() => ({}));
  if (resp.status === 404 && data.results) {
    return {
      ok: true,
      zipBlob: null,
      results: data.results,
      success_count: data.success_count || 0,
      not_found_count: data.not_found_count || 0,
      total: data.total || data.results.length,
    };
  }

  throw new Error(data.error || `Batch failed (HTTP ${resp.status}).`);
}

async function mergeZipBlobs(zipBlobs, invoiceFolder, combinedPayload) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip failed to load. Check your network or CDN access.");
  }

  const master = new JSZip();
  const folder = master.folder(invoiceFolder);

  for (const blob of zipBlobs) {
    const zip = await JSZip.loadAsync(blob);
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const baseName = path.split("/").pop();
      if (!baseName || baseName === "_results.json") continue;
      const content = await entry.async("uint8array");
      folder.file(baseName, content);
    }
  }

  folder.file("_results.json", JSON.stringify(combinedPayload, null, 2));
  return master.generateAsync({ type: "blob" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus();
  resultsEl.classList.add("hidden");
  resultsBody.innerHTML = "";

  const invoiceNo = sanitizeName(
    document.getElementById("invoice_no").value.trim()
  );
  const lrNumbersRaw = document.getElementById("lr_numbers").value.trim();

  if (!invoiceNo || !lrNumbersRaw) {
    setStatus("Please fill in both Invoice No. and LR Numbers.", "error");
    return;
  }

  const lrList = parseLrNumbers(lrNumbersRaw);
  if (!lrList.length) {
    setStatus("No valid LR numbers provided.", "error");
    return;
  }

  const batches = chunkArray(lrList, MAX_LR_PER_REQUEST);
  const zipBlobs = [];
  const allResults = [];
  let successCount = 0;
  let notFoundCount = 0;

  submitBtn.disabled = true;
  submitBtn.textContent = "Downloading...";

  try {
    // Collect all chunk ZIPs in memory first — no browser download until the end.
    setStatus("Downloading...", "loading");
    for (let i = 0; i < batches.length; i++) {
      const batch = await fetchBatch(invoiceNo, batches[i]);
      allResults.push(...batch.results);
      successCount += batch.success_count;
      notFoundCount += batch.not_found_count;
      if (batch.zipBlob) {
        zipBlobs.push(batch.zipBlob);
      }
    }

    if (successCount === 0) {
      setStatus("No documents found for the given LR numbers.", "error");
      renderResults({
        total: lrList.length,
        success_count: 0,
        not_found_count: notFoundCount,
        results: allResults,
      });
      return;
    }

    setStatus("Building ZIP...", "loading");
    submitBtn.textContent = "Building ZIP...";

    const payload = {
      invoice_no: invoiceNo,
      total: lrList.length,
      success_count: successCount,
      not_found_count: notFoundCount,
      results: allResults,
      batches: batches.length,
      timestamp: new Date().toISOString().slice(0, 19),
    };

    const zipBlob = await mergeZipBlobs(zipBlobs, invoiceNo, payload);
    const zipName = `${invoiceNo}.zip`;
    triggerZipDownload(zipBlob, zipName);

    clearStatus();
    renderResults({
      ...payload,
      zip_name: zipName,
    });
    setStatus(`Downloaded ${zipName}`, "success");
  } catch (err) {
    setStatus(`Request failed: ${err.message}`, "error");
    if (allResults.length) {
      renderResults({
        total: lrList.length,
        success_count: successCount,
        not_found_count: notFoundCount,
        results: allResults,
      });
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Download Documents";
  }
});

function renderResults(data) {
  summaryEl.innerHTML = `
    <strong>${data.success_count}</strong> of <strong>${data.total}</strong> documents downloaded successfully.
    ${data.not_found_count > 0 ? `<span style="color:#c0392b;"> ${data.not_found_count} not found.</span>` : ""}
    ${data.zip_name ? `<br>ZIP file: <code>${data.zip_name}</code>` : ""}
  `;

  data.results.forEach((r) => {
    const row = document.createElement("tr");
    const badgeClass = r.status === "success" ? "success" : "not_found";
    const badgeText = r.status === "success" ? "Success" : "Not Found";
    row.innerHTML = `
      <td>${r.lr_no}</td>
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      <td>${r.file_name ? r.file_name : "—"}</td>
    `;
    resultsBody.appendChild(row);
  });

  resultsEl.classList.remove("hidden");
}
