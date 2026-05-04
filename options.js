const DEFAULT_GEORSS =
  "https://www.waze.com/live-map/api/georss?top=48.2&bottom=48.1&left=17&right=17.2&env=row&types=alerts,traffic"

async function load() {
  const d = await chrome.storage.sync.get({
    liveMapUrl: "https://www.waze.com/live-map/",
    georssVerifyUrl: DEFAULT_GEORSS,
    ingestUrl: "https://waze-assistance.site/api/waze-metadata-ingest",
    ingestToken: "",
    refreshIntervalMinutes: 10,
    postSettleMs: 5000,
  })
  document.getElementById("liveMapUrl").value = d.liveMapUrl
  document.getElementById("georssVerifyUrl").value = d.georssVerifyUrl
  document.getElementById("ingestUrl").value = d.ingestUrl
  document.getElementById("ingestToken").value = d.ingestToken || ""
  document.getElementById("refreshIntervalMinutes").value = String(d.refreshIntervalMinutes)
  document.getElementById("postSettleMs").value = String(d.postSettleMs)
}

function setStatus(text, isError) {
  const el = document.getElementById("status")
  el.textContent = text
  el.style.color = isError ? "#a30" : "#060"
}

document.getElementById("save").addEventListener("click", async () => {
  const liveMapUrl = document.getElementById("liveMapUrl").value.trim() || "https://www.waze.com/live-map/"
  const georssVerifyUrl = document.getElementById("georssVerifyUrl").value.trim() || DEFAULT_GEORSS
  const ingestUrl = document.getElementById("ingestUrl").value.trim()
  const ingestToken = document.getElementById("ingestToken").value.trim()
  const refreshIntervalMinutes = Math.max(1, parseInt(document.getElementById("refreshIntervalMinutes").value, 10) || 10)
  const postSettleMs = Math.max(0, parseInt(document.getElementById("postSettleMs").value, 10) || 5000)

  await chrome.storage.sync.set({
    liveMapUrl,
    georssVerifyUrl,
    ingestUrl,
    ingestToken,
    refreshIntervalMinutes,
    postSettleMs,
  })
  await chrome.runtime.sendMessage({ type: "reschedule-alarm" })
  setStatus("Uložené a alarm preplánovaný.")
})

document.getElementById("collectNow").addEventListener("click", async () => {
  setStatus("Zbieram…")
  try {
    const r = await chrome.runtime.sendMessage({ type: "collect-now" })
    if (r?.ok) {
      setStatus("Hotovo. Pozri konzolu service workeru a stránky Waze.")
    } else {
      setStatus(r?.error || "Zlyhalo", true)
    }
  } catch (e) {
    setStatus(String(e?.message || e), true)
  }
})

load().catch((e) => setStatus(String(e?.message || e), true))
