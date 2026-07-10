const form = document.getElementById("download-form");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const resultsBody = document.getElementById("results-body");

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

function parseFilename(contentDisposition, fallback) {
  if (!contentDisposition) return fallback;
  const match = /filename="?([^"]+)"?/i.exec(contentDisposition);
  return match ? match[1] : fallback;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus();
  resultsEl.classList.add("hidden");
  resultsBody.innerHTML = "";

  const invoiceNo = document.getElementById("invoice_no").value.trim();
  const lrNumbers = document.getElementById("lr_numbers").value.trim();

  if (!invoiceNo || !lrNumbers) {
    setStatus("Please fill in both Invoice No. and LR Numbers.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Downloading...";
  setStatus("Fetching documents from S3, please wait...", "loading");

  try {
    const formData = new FormData();
    formData.append("invoice_no", invoiceNo);
    formData.append("lr_numbers", lrNumbers);

    const resp = await fetch("/api/download", {
      method: "POST",
      body: formData,
    });

    const contentType = resp.headers.get("content-type") || "";

    if (!resp.ok || !contentType.includes("application/zip")) {
      const data = await resp.json().catch(() => ({}));
      setStatus(data.error || "Something went wrong.", "error");
      if (data.results) {
        renderResults({
          total: data.total || 0,
          success_count: data.success_count || 0,
          not_found_count: data.not_found_count || 0,
          results: data.results,
        });
      }
      return;
    }

    const blob = await resp.blob();
    const filename = parseFilename(
      resp.headers.get("content-disposition"),
      `${invoiceNo}.zip`
    );
    triggerZipDownload(blob, filename);

    const resultsHeader = resp.headers.get("x-results");
    const results = resultsHeader ? JSON.parse(resultsHeader) : [];
    const data = {
      total: Number(resp.headers.get("x-total") || results.length),
      success_count: Number(resp.headers.get("x-success-count") || 0),
      not_found_count: Number(resp.headers.get("x-not-found-count") || 0),
      results,
      zip_name: filename,
    };

    clearStatus();
    renderResults(data);
    setStatus(`Downloaded ${filename}`, "success");
  } catch (err) {
    setStatus(`Request failed: ${err.message}`, "error");
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
