const form = document.getElementById("download-form");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const resultsBody = document.getElementById("results-body");

// Keep each API call small enough for Vercel maxDuration. Hardcoded so a stale
// or missing config never sends the full list in one request.
// Keep in sync with server MAX_LR_PER_REQUEST default (multi-source needs smaller batches).
const BATCH_SIZE = 25;

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

function emptyBatchResult() {
  return {
    zipBlob: null,
    results: [],
    success_count: 0,
    not_found_count: 0,
    total: 0,
  };
}

function mergeBatchResults(a, b) {
  return {
    zipBlob: null,
    zipBlobs: [...(a.zipBlobs || (a.zipBlob ? [a.zipBlob] : [])), ...(b.zipBlobs || (b.zipBlob ? [b.zipBlob] : []))],
    results: [...a.results, ...b.results],
    success_count: a.success_count + b.success_count,
    not_found_count: a.not_found_count + b.not_found_count,
    total: a.total + b.total,
  };
}

async function fetchBatch(invoiceNo, lrChunk, onProgress) {
  if (!lrChunk.length) {
    return emptyBatchResult();
  }

  // Never send more than BATCH_SIZE in one HTTP call.
  if (lrChunk.length > BATCH_SIZE) {
    let combined = emptyBatchResult();
    combined.zipBlobs = [];
    const parts = chunkArray(lrChunk, BATCH_SIZE);
    for (let i = 0; i < parts.length; i++) {
      if (onProgress) onProgress(i + 1, parts.length, parts[i].length);
      combined = mergeBatchResults(
        combined,
        await fetchBatch(invoiceNo, parts[i])
      );
    }
    return combined;
  }

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
      zipBlob: blob,
      zipBlobs: [blob],
      results,
      success_count: Number(resp.headers.get("x-success-count") || 0),
      not_found_count: Number(resp.headers.get("x-not-found-count") || 0),
      total: Number(resp.headers.get("x-total") || results.length),
    };
  }

  const data = await resp.json().catch(() => ({}));

  // If the server still rejects the size, split and retry instead of surfacing
  // the restriction error to the user.
  if (resp.status === 413 && lrChunk.length > 1) {
    const mid = Math.ceil(lrChunk.length / 2);
    const left = await fetchBatch(invoiceNo, lrChunk.slice(0, mid));
    const right = await fetchBatch(invoiceNo, lrChunk.slice(mid));
    return mergeBatchResults(left, right);
  }

  if (resp.status === 404 && data.results) {
    return {
      zipBlob: null,
      zipBlobs: [],
      results: data.results,
      success_count: data.success_count || 0,
      not_found_count: data.not_found_count || 0,
      total: data.total || data.results.length,
    };
  }

  throw new Error(data.error || "Something went wrong while fetching documents.");
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

async function handleDownload() {
  clearStatus();
  resultsEl.classList.add("hidden");
  resultsBody.innerHTML = "";

  const invoiceNo = sanitizeName(
    document.getElementById("invoice_no").value.trim()
  );
  const lrNumbersRaw = document.getElementById("lr_numbers").value.trim();

  if (!invoiceNo || !lrNumbersRaw) {
    setStatus("Please enter both the Invoice No. and the LR numbers.", "error");
    return;
  }

  const lrList = parseLrNumbers(lrNumbersRaw);
  if (!lrList.length) {
    setStatus("Please enter at least one valid LR number.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Please wait...";

  const totalBatches = Math.ceil(lrList.length / BATCH_SIZE);
  if (totalBatches === 1) {
    setStatus("Downloading your documents…", "loading");
  } else {
    setStatus(
      `Preparing download — ${lrList.length} documents in ${totalBatches} parts…`,
      "loading"
    );
  }

  let successCount = 0;
  let notFoundCount = 0;
  let allResults = [];

  try {
    const batch = await fetchBatch(invoiceNo, lrList, (current, total, count) => {
      setStatus(
        `Downloading part ${current} of ${total} (${count} documents)…`,
        "loading"
      );
      submitBtn.textContent = `Part ${current}/${total}`;
    });
    allResults = batch.results;
    successCount = batch.success_count;
    notFoundCount = batch.not_found_count;
    const zipBlobs = batch.zipBlobs || (batch.zipBlob ? [batch.zipBlob] : []);

    if (successCount === 0) {
      setStatus(
        "We couldn't find any documents for these LR numbers. Please double-check and try again.",
        "error"
      );
      renderResults({
        total: lrList.length,
        success_count: 0,
        not_found_count: notFoundCount,
        results: allResults,
      });
      return;
    }

    setStatus("Almost done — packing everything into one ZIP file…", "loading");
    submitBtn.textContent = "Packing ZIP…";

    const payload = {
      invoice_no: invoiceNo,
      total: lrList.length,
      success_count: successCount,
      not_found_count: notFoundCount,
      results: allResults,
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
    setStatus(
      `All set! Your file “${zipName}” is ready (${successCount} of ${lrList.length} documents).`,
      "success"
    );
  } catch (err) {
    setStatus(
      `Sorry, the download couldn't be completed. ${err.message}`,
      "error"
    );
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
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  e.stopPropagation();
  handleDownload();
});

submitBtn.addEventListener("click", (e) => {
  e.preventDefault();
  handleDownload();
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
