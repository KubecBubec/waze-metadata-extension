/**
 * Waze Live Map metadata collector (MV3).
 * Aligns payload shape with local-metadata-agent / var/waze-metadata.json.
 */

const ALARM_NAME = "waze-metadata-refresh"
const DEFAULT_GEORSS_URL =
  "https://www.waze.com/live-map/api/georss?top=48.2&bottom=48.1&left=17&right=17.2&env=row&types=alerts,traffic"
const COOKIE_ORDER = ["_web_session", "_csrf_token", "recaptcha-ca-t"]
const POST_SETTLE_MS = 5000
const LOG_PREFIX = "[Waze-metadata-ext]"

/** Čitateľné logy v service workeri (chrome://extensions → Service worker → Inspect). */
function swLog(runId, phase, message, data) {
  const ts = new Date().toISOString()
  const rid = runId ? ` ${runId.slice(0, 8)}…` : ""
  const payload = data === undefined ? "" : data
  console.log(LOG_PREFIX, ts, phase + rid, message, payload)
}

function swWarn(runId, phase, message, data) {
  const ts = new Date().toISOString()
  const rid = runId ? ` ${runId.slice(0, 8)}…` : ""
  console.warn(LOG_PREFIX, ts, phase + rid, message, data === undefined ? "" : data)
}

function swError(runId, phase, message, data) {
  const ts = new Date().toISOString()
  const rid = runId ? ` ${runId.slice(0, 8)}…` : ""
  console.error(LOG_PREFIX, ts, phase + rid, message, data === undefined ? "" : data)
}

function metadataSummaryForLog(metadata) {
  return {
    runId: metadata.runId,
    acquiredAt: metadata.acquiredAt,
    importantCookiesPresent: metadata.importantCookiesPresent,
    cookieHeaderChars: metadata.cookieHeader?.length ?? 0,
    georssApiTest: metadata.georssApiTest,
    georssFromPage: metadata.diagnostics?.georssFromPage,
    georssHasRecaptchaHeader: Boolean(
      metadata.georssMirroredHeaders?.["x-recaptcha-token"] || metadata.diagnostics?.georssNetworkCapture?.hasRecaptcha
    ),
    userAgentPreview: (metadata.userAgent || "").slice(0, 80) + (metadata.userAgent?.length > 80 ? "…" : ""),
  }
}

/** Escaping pre PowerShell v jednoducho uzavretých reťazcoch ('...'). */
function psEscape(s) {
  return String(s).replace(/'/g, "''")
}

/**
 * Rovnaký georss request ako overenie v prehliadači, ale s hlavičkami z metadát (Cookie + User-Agent + extraHeaders).
 * Výstup na skopírovanie do powershell.exe alebo Windows Terminal.
 */
function buildWindowsGeorssTestCommands(metadata, georssUrl) {
  const url = georssUrl || DEFAULT_GEORSS_URL
  const mirrored = metadata.georssMirroredHeaders || {}
  const xh = metadata.extraHeaders || {}
  const ua = psEscape(metadata.userAgent || "")
  const cookie = psEscape(metadata.cookieHeader || "")
  const accept = psEscape(mirrored.accept || xh.Accept || "*/*")
  const acceptLang = psEscape(mirrored["accept-language"] || xh["Accept-Language"] || "sk,en;q=0.8")
  const referer = psEscape(mirrored.referer || xh.Referer || metadata.liveMapUrl || "https://www.waze.com/live-map/")
  const origin = psEscape(xh.Origin || "https://www.waze.com")
  const recaptcha = psEscape(mirrored["x-recaptcha-token"] || "")
  const ifNoneMatch = psEscape(mirrored["if-none-match"] || "")
  const priority = psEscape(mirrored.priority || "")
  const u = psEscape(url)

  const psRecaptcha = recaptcha ? `;'x-recaptcha-token'='${recaptcha}'` : ""
  const psIfNoneMatch = ifNoneMatch ? `;'If-None-Match'='${ifNoneMatch}'` : ""
  const psPriority = priority ? `;'Priority'='${priority}'` : ""
  const powershell = `$r = Invoke-WebRequest -Uri '${u}' -Headers (@{'User-Agent'='${ua}';'Cookie'='${cookie}';'Accept'='${accept}';'Accept-Language'='${acceptLang}';'Referer'='${referer}';'Origin'='${origin}';'Sec-Fetch-Dest'='empty';'Sec-Fetch-Mode'='cors';'Sec-Fetch-Site'='same-origin'${psRecaptcha}${psIfNoneMatch}${psPriority}}) -UseBasicParsing; "StatusCode: $($r.StatusCode)  Bytes: $($r.Content.Length)"`

  const curlRecaptcha = recaptcha ? ` -H 'x-recaptcha-token: ${recaptcha}'` : ""
  const curlIfNoneMatch = ifNoneMatch ? ` -H 'If-None-Match: ${ifNoneMatch}'` : ""
  const curlPriority = priority ? ` -H 'Priority: ${priority}'` : ""
  const curl = `curl.exe -sS -w "\\nHTTP_CODE:%{http_code}\\n" -o NUL '${u}' -H 'User-Agent: ${ua}' -H 'Cookie: ${cookie}' -H 'Accept: ${accept}' -H 'Accept-Language: ${acceptLang}' -H 'Referer: ${referer}' -H 'Origin: ${origin}' -H 'Sec-Fetch-Dest: empty' -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Site: same-origin'${curlRecaptcha}${curlIfNoneMatch}${curlPriority}`

  return { powershell, curl }
}

function logWindowsTestCommands(runId, blocks) {
  const rid = runId ? `${runId.slice(0, 8)}… ` : ""
  console.log(`${LOG_PREFIX} ${rid}Georss test — PowerShell (1 riadok):\n${blocks.powershell}`)
  console.log(`${LOG_PREFIX} ${rid}Georss test — curl.exe (1 riadok, PowerShell/cmd):\n${blocks.curl}`)
}

async function getSettings() {
  const d = await chrome.storage.sync.get({
    liveMapUrl: "https://www.waze.com/live-map/",
    georssVerifyUrl: DEFAULT_GEORSS_URL,
    ingestUrl: "",
    ingestToken: "",
    refreshIntervalMinutes: 5,
    postSettleMs: POST_SETTLE_MS,
  })
  return d
}

function buildExtraHeaders(finalUrl, acceptLanguage) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": acceptLanguage,
    Referer: finalUrl,
    Origin: "https://www.waze.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  }
}

function buildCookieHeader(cookieMap) {
  return COOKIE_ORDER.map((name) => {
    const value = cookieMap.get(name)
    return value ? `${name}=${value}` : null
  })
    .filter(Boolean)
    .join("; ")
}

async function collectWazeCookies() {
  const url = "https://www.waze.com/"
  const list = await chrome.cookies.getAll({ url })
  const map = new Map()
  for (const c of list) {
    if (COOKIE_ORDER.includes(c.name)) map.set(c.name, c.value)
  }
  return map
}

function isWazeLiveMapTabUrl(url) {
  try {
    const u = new URL(url)
    if (u.hostname !== "www.waze.com") return false
    return u.pathname.includes("live-map")
  } catch {
    return false
  }
}

/**
 * Nájde kartu Live Map vrátane lokalizovaných ciest (napr. /sk/live-map/, /en/live-map/).
 * Predtým stačil len https://www.waze.com/live-map* — to /sk/ nechytilo.
 */
async function findLiveMapTab(liveMapUrl) {
  const tabs = await chrome.tabs.query({ url: "https://www.waze.com/*" })
  const candidates = tabs.filter((t) => t.url && isWazeLiveMapTabUrl(t.url))
  if (candidates.length === 0) return null

  const prefix = (liveMapUrl || "").trim().replace(/\/$/, "").split("?")[0]
  if (prefix) {
    const byPrefix = candidates.find((t) => t.url.startsWith(prefix))
    if (byPrefix) return byPrefix.id
  }
  return candidates[0].id
}

/** Viditeľný riadok v konzole stránky hneď na začiatku (nie v collapsed skupine). */
async function logPageBanner(tabId, runId, trigger) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [runId, trigger, LOG_PREFIX],
      func: (rid, trig, pref) => {
        const short = rid.slice(0, 8)
        console.warn(
          `%c${pref}%c Spúšťam zber metadát · run ${short}… · zdroj: ${trig}`,
          "background:#ff9800;color:#111;padding:3px 8px;font-weight:bold;border-radius:3px",
          "color:#e65100;font-weight:bold"
        )
      },
    })
  } catch {
    // karta nie je pripravená na inject (napr. chrome://)
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      reject(new Error("Timeout waiting for tab load"))
    }, 120000)

    function onUpdated(id, info) {
      if (id !== tabId) return
      if (info.status === "complete") {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated)

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve()
      }
    })
  })
}

function headersArrayToObject(list) {
  const out = {}
  for (const h of list || []) {
    const key = String(h?.name || "").trim()
    if (!key) continue
    out[key] = h?.value != null ? String(h.value) : ""
  }
  return out
}

async function captureGeorssRequestFromNetwork(tabId, timeoutMs = 9000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try {
        chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders)
      } catch {
        // noop
      }
      clearTimeout(timer)
      resolve(result)
    }

    const onBeforeSendHeaders = (details) => {
      if (details.tabId !== tabId) return
      if (!details.url?.includes("/live-map/api/georss")) return
      finish({
        matched: true,
        capturedAt: new Date().toISOString(),
        url: details.url,
        method: details.method || "GET",
        requestHeaders: headersArrayToObject(details.requestHeaders),
      })
    }

    const timer = setTimeout(() => {
      finish({
        matched: false,
        capturedAt: new Date().toISOString(),
        url: null,
        method: null,
        requestHeaders: {},
      })
    }, Math.max(1000, timeoutMs))

    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      { urls: ["https://www.waze.com/live-map/api/georss*"] },
      ["requestHeaders", "extraHeaders"]
    )
  })
}

async function verifyGeorssInTab(tabId, georssUrl, requestHeaders = {}) {
  const safeHeaders = {}
  const forwardNames = ["accept", "accept-language", "x-recaptcha-token", "if-none-match", "priority"]
  for (const n of forwardNames) {
    const v = requestHeaders[n] ?? requestHeaders[n.toLowerCase()] ?? requestHeaders[n.toUpperCase()]
    if (v) safeHeaders[n] = String(v)
  }
  if (!safeHeaders.accept) safeHeaders.accept = "application/json, text/plain, */*"

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [georssUrl, safeHeaders],
    func: async (url, headers) => {
      try {
        const res = await fetch(url, { credentials: "same-origin", headers })
        return { status: res.status, ok: res.ok }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
  })
  return result
}

async function getNavigatorInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      userAgent: navigator.userAgent,
      language: navigator.language || "en-US",
    }),
  })
  return result
}

async function startGeorssRequestProbe(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const KEY = "__wmeGeorssProbe"
      const nowIso = () => new Date().toISOString()
      if (window[KEY]?.active) return

      const state = {
        active: true,
        startedAt: nowIso(),
        matches: [],
        origFetch: window.fetch,
        origXhrOpen: XMLHttpRequest.prototype.open,
        origXhrSend: XMLHttpRequest.prototype.send,
        origXhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
      }

      const capHeaders = (h) => {
        try {
          if (!h) return {}
          if (h instanceof Headers) return Object.fromEntries(h.entries())
          if (Array.isArray(h)) return Object.fromEntries(h)
          return { ...h }
        } catch {
          return {}
        }
      }

      const isGeorssUrl = (u) => typeof u === "string" && u.includes("/live-map/api/georss")

      const record = (item) => {
        state.matches.push({ ...item, seenAt: nowIso() })
        if (state.matches.length > 20) state.matches = state.matches.slice(-20)
      }

      window.fetch = async function patchedFetch(input, init) {
        try {
          const req = input instanceof Request ? input : null
          const url = req ? req.url : String(input)
          if (isGeorssUrl(url)) {
            record({
              channel: "fetch",
              url,
              method: (init?.method || req?.method || "GET").toUpperCase(),
              credentials: init?.credentials || req?.credentials || null,
              mode: init?.mode || req?.mode || null,
              referrer: init?.referrer || req?.referrer || null,
              headers: capHeaders(init?.headers || req?.headers),
            })
          }
        } catch {
          // noop
        }
        return state.origFetch.apply(this, arguments)
      }

      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__wmeProbeMeta = {
          method: String(method || "GET").toUpperCase(),
          url: String(url || ""),
          headers: {},
        }
        return state.origXhrOpen.apply(this, arguments)
      }

      XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
        try {
          if (this.__wmeProbeMeta?.headers) this.__wmeProbeMeta.headers[String(name)] = String(value)
        } catch {
          // noop
        }
        return state.origXhrSetRequestHeader.apply(this, arguments)
      }

      XMLHttpRequest.prototype.send = function patchedSend() {
        try {
          const m = this.__wmeProbeMeta
          if (m && isGeorssUrl(m.url)) {
            record({
              channel: "xhr",
              url: m.url,
              method: m.method,
              credentials: null,
              mode: null,
              referrer: null,
              headers: { ...m.headers },
            })
          }
        } catch {
          // noop
        }
        return state.origXhrSend.apply(this, arguments)
      }

      window[KEY] = state
    },
  })
}

async function stopGeorssRequestProbe(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const KEY = "__wmeGeorssProbe"
      const s = window[KEY]
      if (!s?.active) return { active: false, startedAt: null, finishedAt: new Date().toISOString(), matches: [] }

      window.fetch = s.origFetch
      XMLHttpRequest.prototype.open = s.origXhrOpen
      XMLHttpRequest.prototype.send = s.origXhrSend
      XMLHttpRequest.prototype.setRequestHeader = s.origXhrSetRequestHeader

      s.active = false
      const out = {
        active: false,
        startedAt: s.startedAt || null,
        finishedAt: new Date().toISOString(),
        matches: Array.isArray(s.matches) ? s.matches.slice(-20) : [],
      }
      delete window[KEY]
      return out
    },
  })
  return result
}

/**
 * Zbalená skupina v konzole stránky Waze — ľahšie odlíšiť od stoviek Trusted Types hlášok z waze.com.
 */
async function flushPageRunLog(tabId, runId, lines) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [runId, lines],
      func: (rid, L) => {
        const short = rid.slice(0, 8)
        console.group(
          `%c Waze metadata ext %c · beh ${short}… (detailný log)`,
          "background:#1a73e8;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold",
          "color:#174ea6;font-weight:bold"
        )
        console.log(
          "%cPoznámka:%c Riadky typu „TrustedScriptURL“ / „TrustedHTML“ (report-only) pochádzajú z %cwaze.com%c (Trusted Types), nie z tohto rozšírenia. Filtruj konzolu podľa „Waze metadata ext“ alebo otvor túto skupinu.",
          "font-weight:bold",
          "font-weight:normal",
          "font-weight:bold",
          "font-weight:normal"
        )
        for (const row of L) {
          const { level, msg, data } = row
          if (level === "warn") console.warn(msg, data !== undefined ? data : "")
          else if (level === "error") console.error(msg, data !== undefined ? data : "")
          else console.log(msg, data !== undefined ? data : "")
        }
        console.groupEnd()
      },
    })
  } catch {
    // karta sa medzitým zavrela
  }
}

async function postIngest(ingestUrl, body, ingestToken) {
  if (!ingestUrl?.trim()) return { skipped: true }
  const headers = { "Content-Type": "application/json" }
  const tok = ingestToken?.trim()
  if (tok) headers["Authorization"] = `Bearer ${tok}`
  const r = await fetch(ingestUrl.trim(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const text = await r.text().catch(() => "")
  return { ok: r.ok, status: r.status, bodyPreview: text.slice(0, 500) }
}

async function collectMetadataOnce({ trigger = "neznámy" } = {}) {
  const settings = await getSettings()
  const runId = crypto.randomUUID()
  const t0 = performance.now()
  const pageLines = []

  function page(level, msg, data) {
    pageLines.push({ level, msg, data })
  }

  swLog(runId, "štart", `Beh začal (zdroj: ${trigger}, vždy F5 pred zberom)`)
  page("log", "► Štart zberu", { zdroj: trigger, reloadKarty: true, runId })

  const tabId = await findLiveMapTab(settings.liveMapUrl)

  if (tabId == null) {
    const msg = "Nenašiel som otvorenú kartu Waze Live Map (www.waze.com/live-map). Otvor ju a skús znova."
    swWarn(runId, "karta", msg)
    page("warn", "✕ Žiadna Live Map karta", msg)
    return { ok: false, error: msg }
  }

  swLog(runId, "karta", "Našiel som kartu", { tabId })
  page("log", "► Karta nájdená", { tabId })
  await logPageBanner(tabId, runId, trigger)

  try {
    swLog(runId, "reload", "Obnovujem kartu a čakám na status „complete“…")
    page("log", "► Obnovujem stránku", "Čakám na dokončenie načítania…")
    const loaded = waitForTabComplete(tabId)
    await chrome.tabs.reload(tabId)
    await loaded
    swLog(runId, "reload", "Karta hlási načítanie dokončené")
    page("log", "► Stránka znova načítaná", "Ďalší krok: čakanie na ustálenie mapy")
    const georssNetCapturePromise = captureGeorssRequestFromNetwork(
      tabId,
      Math.max(4000, (Number(settings.postSettleMs) || POST_SETTLE_MS) + 3000)
    )
    swLog(runId, "probe", "Spustený georss request probe (webRequest)")
    page("log", "► Probe", "Sledujem reálny georss request v sieti")

    const settle = Math.max(0, Number(settings.postSettleMs) || POST_SETTLE_MS)
    if (settle > 0) {
      swLog(runId, "čakanie", `Čakám ${settle} ms — ustálenie mapy / session po reload`)
      page("log", "► Pauza pred zberom", { ms: settle, poReload: true })
      await new Promise((r) => setTimeout(r, settle))
      swLog(runId, "čakanie", "Čakanie skončilo")
      page("log", "► Čakanie skončilo", "Čítam cookies a User-Agent")
    }

    const tab = await chrome.tabs.get(tabId)
    const finalUrl = tab.url || settings.liveMapUrl
    const nav = await getNavigatorInfo(tabId)
    const acceptLanguage = nav.language.startsWith("sk") ? "sk,en;q=0.8" : `${nav.language},en;q=0.8`
    const extraHeaders = buildExtraHeaders(finalUrl, acceptLanguage)

    swLog(runId, "page", "Kontext stránky", {
      url: finalUrl,
      jazyk: nav.language,
      acceptLanguage,
    })
    page("log", "► Stránka", { url: finalUrl, jazyk: nav.language })

    const cookieMap = await collectWazeCookies()
    const importantCookiesPresent = COOKIE_ORDER.filter((n) => cookieMap.has(n))
    const cookieHeader = buildCookieHeader(cookieMap)

    swLog(runId, "cookies", "Dôležité cookies", {
      prítomné: importantCookiesPresent,
      chýbajúce: COOKIE_ORDER.filter((n) => !cookieMap.has(n)),
    })
    page("log", "► Cookies (názvy, nie hodnoty)", {
      prítomné: importantCookiesPresent,
      chýbajúce: COOKIE_ORDER.filter((n) => !cookieMap.has(n)),
    })

    if (importantCookiesPresent.length === 0) {
      const err = "Žiadne dôležité cookies (_web_session, _csrf_token, recaptcha-ca-t). Otvor Live Map a nech načíta mapu."
      swError(runId, "cookies", err)
      page("error", "✕ Žiadne session cookies", err)
      await flushPageRunLog(tabId, runId, pageLines)
      return { ok: false, error: err }
    }

    const georssNetworkCapture = await georssNetCapturePromise
    const georssVerifyUrl = georssNetworkCapture?.url || settings.georssVerifyUrl
    const netHeaders = Object.fromEntries(
      Object.entries(georssNetworkCapture?.requestHeaders || {}).map(([k, v]) => [String(k).toLowerCase(), v])
    )
    swLog(runId, "probe", "Zachytený georss request zo siete", {
      matched: georssNetworkCapture?.matched,
      url: georssNetworkCapture?.url,
      hasRecaptcha: Boolean(netHeaders["x-recaptcha-token"]),
    })
    page("log", "► Probe výsledok", {
      matched: georssNetworkCapture?.matched,
      url: georssNetworkCapture?.url,
      hasRecaptcha: Boolean(netHeaders["x-recaptcha-token"]),
    })

    swLog(runId, "georss", "Overujem georss fetch v kontexte stránky…", { url: georssVerifyUrl })
    page("log", "► Georss overenie", "fetch() na stránke…")
    const georssFromPage = await verifyGeorssInTab(tabId, georssVerifyUrl, netHeaders)
    swLog(runId, "georss", "Výsledok georss", georssFromPage)
    page(georssFromPage.ok ? "log" : "warn", georssFromPage.ok ? "► Georss OK" : "△ Georss problém", georssFromPage)

    const georssHttpStatus =
      typeof georssFromPage.status === "number" && Number.isFinite(georssFromPage.status) ? georssFromPage.status : null

    const georssApiTest = {
      url: georssVerifyUrl,
      httpStatus: georssHttpStatus,
      ok: Boolean(georssFromPage.ok),
      error: georssFromPage.error != null ? String(georssFromPage.error) : null,
    }

    const metadata = {
      version: 1,
      runId,
      acquiredAt: new Date().toISOString(),
      validUntil: null,
      ttlKnown: false,
      note:
        "Chrome extension collector. Real metadata lifetime is unknown; refresh on 403/5xx. georss uses mirrored headers captured via webRequest when available.",
      browser: "chrome-extension",
      liveMapUrl: settings.liveMapUrl,
      userAgent: nav.userAgent,
      cookieHeader,
      extraHeaders,
      georssMirroredHeaders: netHeaders,
      importantCookiesPresent,
      georssApiTest,
      diagnostics: {
        georssFromPage,
        georssNetworkCapture: {
          matched: georssNetworkCapture?.matched || false,
          hasRecaptcha: Boolean(netHeaders["x-recaptcha-token"]),
          url: georssNetworkCapture?.url || null,
          method: georssNetworkCapture?.method || null,
          requestHeaders: georssNetworkCapture?.requestHeaders || {},
        },
      },
    }

    const summary = metadataSummaryForLog(metadata)
    swLog(runId, "metadata", "Súhrn metadát (bez hodnôt cookies)", summary)
    page("log", "► Súhrn metadát (celý objekt ide na server / súbor)", summary)

    const winTest = buildWindowsGeorssTestCommands(metadata, georssVerifyUrl)
    logWindowsTestCommands(runId, winTest)
    page("log", "► Windows PowerShell — 1 riadok (georss)", winTest.powershell)
    page("log", "► curl.exe — 1 riadok", winTest.curl)

    let ingestResult = { skipped: true }
    if (settings.ingestUrl?.trim()) {
      swLog(runId, "ingest", "Pokus o POST na ingest URL…", { url: settings.ingestUrl })
      page("log", "► Ingest", { url: settings.ingestUrl })
      try {
        const ingestOrigin = new URL(settings.ingestUrl).origin + "/*"
        const granted = await chrome.permissions.contains({ origins: [ingestOrigin] })
        if (!granted) {
          ingestResult = {
            ok: false,
            error:
              "Chýba host permission pre ingest URL. Na stránke Možnosti klikni „Povoliť odosielanie na tento server“.",
          }
          swWarn(runId, "ingest", "Chýba oprávnenie pre origin", ingestResult.error)
          page("warn", "△ Ingest — chýba oprávnenie", ingestResult.error)
        } else {
          ingestResult = await postIngest(settings.ingestUrl, metadata, settings.ingestToken)
          swLog(runId, "ingest", "Odpoveď servera", ingestResult)
          page(ingestResult.ok ? "log" : "warn", ingestResult.ok ? "► Ingest OK" : "△ Ingest zlyhal", ingestResult)
        }
      } catch (e) {
        ingestResult = { ok: false, error: String(e?.message || e) }
        swError(runId, "ingest", "Výnimka pri ingest", ingestResult.error)
        page("error", "✕ Ingest výnimka", ingestResult.error)
      }
    } else {
      swLog(runId, "ingest", "Ingest URL nie je nastavený — preskakujem POST")
      page("log", "► Ingest", "Nenastavený (OK pre lokálny test)")
    }

    const ms = Math.round(performance.now() - t0)
    if (!georssFromPage.ok) {
      swWarn(runId, "hotovo", "Beh skončil, ale georss overenie nie je OK", { ms })
      page("warn", "△ Koniec behu", { trvanieMs: ms, georssOk: false })
    } else {
      swLog(runId, "hotovo", `Beh úspešne dokončený za ${ms} ms`)
      page("log", "► Koniec behu", { trvanieMs: ms, georssOk: true })
    }

    await flushPageRunLog(tabId, runId, pageLines)

    return { ok: true, metadata, ingestResult }
  } catch (e) {
    const errMsg = String(e?.message || e)
    swError(runId, "výnimka", "Beh prerušený chybou", errMsg)
    page("error", "✕ Neočakávaná chyba", errMsg)
    await flushPageRunLog(tabId, runId, pageLines).catch(() => {})
    throw e
  }
}

async function ensureAlarm() {
  const { refreshIntervalMinutes } = await getSettings()
  const period = Math.max(1, Number(refreshIntervalMinutes) || 5)
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: period })
  swLog("", "alarm", `Alarm „${ALARM_NAME}“ nastavený na každých ${period} min`)
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm().catch(console.error)
})

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(console.error)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  swLog("", "alarm", "Budík vyvolal zber metadát")
  collectMetadataOnce({ trigger: "alarm (interval)" }).catch((e) =>
    console.error(LOG_PREFIX, "Nezachytená chyba behu:", e)
  )
})

chrome.action.onClicked.addListener(() => {
  swLog("", "akcia", "Klik na ikonu rozšírenia — spúšťam zber")
  collectMetadataOnce({ trigger: "ikonka rozšírenia" }).catch((e) =>
    console.error(LOG_PREFIX, "Nezachytená chyba behu:", e)
  )
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "collect-now") {
    swLog("", "správa", "Možnosti: „Zbierať teraz“")
    collectMetadataOnce({ trigger: "stránka Možnosti" })
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  if (msg?.type === "reschedule-alarm") {
    ensureAlarm()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  return false
})

// Ensure alarm exists when service worker wakes (e.g. after options save from another path).
ensureAlarm().catch(console.error)
