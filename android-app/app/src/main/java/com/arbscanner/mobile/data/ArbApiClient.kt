package com.arbscanner.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ArbApiClient(private val prefs: PrefsStore) {
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    val streamClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // infinite read for SSE stream
        .build()

    private fun url(path: String, params: Map<String, String> = emptyMap()): String {
        val base = prefs.serverUrl.trimEnd('/')
        if (params.isEmpty()) return "$base$path"
        val qs = params.entries.joinToString("&") { (k, v) ->
            "${URLEncoder.encode(k, "UTF-8")}=${URLEncoder.encode(v, "UTF-8")}"
        }
        return "$base$path?$qs"
    }

    private fun reqBuilder(fullUrl: String): Request.Builder {
        val b = Request.Builder().url(fullUrl)
        val tok = prefs.apiToken
        if (tok.isNotBlank()) b.header("X-API-Token", tok)
        return b
    }

    private suspend fun getJson(path: String, params: Map<String, String> = emptyMap()): JSONObject =
        withContext(Dispatchers.IO) {
            val req = reqBuilder(url(path, params)).get().build()
            client.newCall(req).execute().use { res ->
                val body = res.body?.string() ?: "{}"
                val obj = runCatching { JSONObject(body) }.getOrDefault(JSONObject())
                if (!res.isSuccessful) throw IllegalStateException(errorText(res.code, obj))
                obj
            }
        }

    private fun errorText(code: Int, obj: JSONObject): String =
        if (code == 401 && obj.optBoolean("auth")) "Signed out — link this phone again (Connect tab → Link with code)"
        else obj.optString("error", "HTTP $code")

    private suspend fun postJson(path: String, bodyObj: JSONObject = JSONObject()): JSONObject =
        withContext(Dispatchers.IO) {
            val req = reqBuilder(url(path))
                .post(bodyObj.toString().toRequestBody(jsonMedia))
                .build()
            client.newCall(req).execute().use { res ->
                val body = res.body?.string() ?: "{}"
                val obj = runCatching { JSONObject(body) }.getOrDefault(JSONObject())
                if (!res.isSuccessful) throw IllegalStateException(errorText(res.code, obj))
                obj
            }
        }

    fun buildAlertStreamRequest(): Request {
        val tok = prefs.apiToken
        // A linked-device token travels only in the header — never in a URL that a tunnel might log
        val params = if (tok.isNotBlank() && !prefs.isLinkedDevice) mapOf("token" to tok) else emptyMap()
        return reqBuilder(url("/api/alerts/stream", params))
            .header("Accept", "text/event-stream")
            .get()
            .build()
    }

    /** Redeem a one-time link code from the desktop's Remote Access page. Returns the server's device name. */
    suspend fun linkWithCode(serverUrl: String, code: String, deviceName: String): String =
        withContext(Dispatchers.IO) {
            val base = serverUrl.trim().trimEnd('/')
            require(base.startsWith("https://") || base.startsWith("http://")) { "Address must start with https://" }
            val body = JSONObject().put("code", code.trim()).put("deviceName", deviceName.ifBlank { "Android" })
            val req = Request.Builder().url("$base/api/remote/link")
                .post(body.toString().toRequestBody(jsonMedia)).build()
            client.newCall(req).execute().use { res ->
                val obj = runCatching { JSONObject(res.body?.string() ?: "{}") }.getOrDefault(JSONObject())
                if (!res.isSuccessful) throw IllegalStateException(obj.optString("error", "HTTP ${res.code}"))
                val token = obj.optString("token", "")
                require(token.startsWith("arbd_")) { "Server did not return a device token" }
                prefs.applyLink(base, token)
                val dev = obj.optJSONObject("device")
                "${dev?.optString("name") ?: deviceName} (${if (dev?.optString("role") == "viewer") "view only" else "full control"})"
            }
        }

    /** Sign this phone out of Remote Access (revokes its token on the PC). */
    suspend fun signOutDevice() {
        runCatching { postJson("/api/remote/logout") }
        prefs.apiToken = ""
    }

    suspend fun health(): String {
        val o = getJson("/api/health")
        return "v${o.optString("version", "3")} · uptime ${o.optInt("uptimeSec")}s"
    }

    suspend fun scan(pair: String, quote: String, tradeSize: Int, feeMode: String): List<Opportunity> {
        val o = getJson("/api/scan", mapOf(
            "pair" to pair, "quote" to quote, "tradeSize" to tradeSize.toString(),
            "feeMode" to feeMode, "slippageBps" to "5"
        ))
        val arr = o.optJSONArray("opportunities") ?: JSONArray()
        return List(arr.length()) { i ->
            val it = arr.getJSONObject(i)
            Opportunity(
                symbol = it.optString("symbol"),
                buyOn = it.optString("buyOn"),
                sellOn = it.optString("sellOn"),
                buyPrice = it.optDouble("buyPrice", 0.0),
                sellPrice = it.optDouble("sellPrice", 0.0),
                spread = it.optDouble("spread", 0.0),
                netProfit = it.optDouble("netProfit", 0.0),
                netDollar = it.optDouble("netDollar", 0.0),
                feePct = it.optDouble("feePct", 0.0),
                minVol = if (it.isNull("minVol")) null else it.optDouble("minVol"),
                estimated = it.optBoolean("estimated", false),
                isViable = it.optBoolean("isViable", false),
                tradeSize = it.optDouble("tradeSize", tradeSize.toDouble()),
            )
        }
    }

    suspend fun verifyFill(pair: String, opp: Opportunity, quote: String, feeMode: String, latencyMs: Int = 250): L2VerifyResult {
        val parts = pair.split("_")
        val o = postJson("/api/paper-sim/verify", JSONObject().apply {
            put("exA", parts.getOrElse(0) { "kraken" })
            put("exB", parts.getOrElse(1) { "coinbase" })
            put("symbol", opp.symbol)
            put("quote", quote)
            put("tradeSize", opp.tradeSize)
            put("feeMode", feeMode)
            put("simulatedLatencyMs", latencyMs)
            put("predictedBuyOn", opp.buyOn)
            put("predictedSellOn", opp.sellOn)
            put("predictedBuyPrice", opp.buyPrice)
            put("predictedSellPrice", opp.sellPrice)
            put("predictedNetDollar", opp.netDollar)
        })
        val actual = o.optJSONObject("actual") ?: JSONObject()
        val acc = o.optJSONObject("accuracy") ?: JSONObject()
        return L2VerifyResult(
            symbol = o.optString("symbol", opp.symbol),
            quote = o.optString("quote", quote),
            stillProfitable = acc.optBoolean("stillProfitable", false),
            actualNetDollar = actual.optDouble("netDollar", 0.0),
            actualNetPct = actual.optDouble("netPct", 0.0),
            buyVwap = actual.optDouble("buyVwap", 0.0),
            sellVwap = actual.optDouble("sellVwap", 0.0),
            totalDriftBps = acc.optDouble("totalDriftBps", 0.0),
            totalProcessingMs = o.optInt("totalProcessingMs", 0),
            complete = actual.optBoolean("complete", false),
        )
    }

    suspend fun deployQuickBot(
        targetHost: String, pair: String, opp: Opportunity, quote: String,
        strategy: String, paperTrade: Boolean, tradeSizeUsd: Double, minProfPct: Double
    ): String {
        val parts = pair.split("_")
        val prev = postJson("/api/strategy/preview", JSONObject().apply {
            put("strategy", strategy)
            put("symbol", opp.symbol)
            put("quote", quote)
            put("exA", parts.getOrElse(0) { "kraken" })
            put("exB", parts.getOrElse(1) { "coinbase" })
            put("makerEx", opp.buyOn)
            put("takerEx", opp.sellOn)
            put("tradeSizeUsd", tradeSizeUsd)
            put("refPrice", opp.buyPrice)
            put("minProfitabilityPct", minProfPct)
            put("paperTrade", paperTrade)
        })
        val yaml = prev.optString("yaml")
        val name = "arb_${opp.symbol.lowercase()}_${quote.lowercase()}_${System.currentTimeMillis() % 100000}"
        val dep = postJson("/api/deploy", JSONObject().apply {
            put("target", targetHost)
            put("configName", name)
            put("yaml", yaml)
            put("launchMode", "detached")
            put("autoStart", true)
        })
        return dep.optString("message", "Deployed $name")
    }

    // ─── Alerts ───────────────────────────────────────────────────────────────
    suspend fun getAlertStatus(): AlertWatcherStatus {
        val o = getJson("/api/alerts/status")
        val st = o.optJSONObject("status") ?: JSONObject()
        val s = o.optJSONObject("settings") ?: JSONObject()
        return AlertWatcherStatus(
            enabled = s.optBoolean("enabled", false),
            checksCount = st.optInt("checksCount", 0),
            lastCheckAt = st.optLong("lastCheckAt", 0L),
            unreadCount = st.optInt("unreadCount", 0),
            pair = s.optString("pair", "kraken_coinbase"),
            quote = s.optString("quote", "USD"),
            minNetPct = s.optDouble("minNetPct", 0.25),
            minNetDollar = s.optDouble("minNetDollar", 2.0),
            verifyOrderBook = s.optBoolean("verifyOrderBook", true),
            ntfyTopic = s.optString("ntfyTopic", ""),
        )
    }

    suspend fun getAlerts(since: Long = 0L): List<TargetAlert> {
        val o = getJson("/api/alerts", if (since > 0) mapOf("since" to since.toString()) else emptyMap())
        val arr = o.optJSONArray("alerts") ?: JSONArray()
        return List(arr.length()) { i -> parseAlert(arr.getJSONObject(i)) }
    }

    fun parseAlert(it: JSONObject): TargetAlert = TargetAlert(
        id = it.optString("id"),
        ts = it.optLong("ts", System.currentTimeMillis()),
        isTest = it.optBoolean("isTest", false),
        read = it.optBoolean("read", false),
        symbol = it.optString("symbol"),
        quote = it.optString("quote", "USD"),
        pair = it.optString("pair", "kraken_coinbase"),
        buyOn = it.optString("buyOn"),
        sellOn = it.optString("sellOn"),
        buyPrice = it.optDouble("buyPrice", 0.0),
        sellPrice = it.optDouble("sellPrice", 0.0),
        tradeSize = it.optDouble("tradeSize", 1000.0),
        netProfitPct = it.optDouble("netProfitPct", 0.0),
        netDollar = it.optDouble("netDollar", 0.0),
        verifiedL2 = it.optBoolean("verifiedL2", false),
        title = it.optString("title"),
        message = it.optString("message"),
    )

    suspend fun updateAlertSettings(enabled: Boolean? = null, minNetPct: Double? = null, verifyOrderBook: Boolean? = null) {
        val body = JSONObject()
        if (enabled != null) body.put("enabled", enabled)
        if (minNetPct != null) body.put("minNetPct", minNetPct)
        if (verifyOrderBook != null) body.put("verifyOrderBook", verifyOrderBook)
        postJson("/api/alerts/settings", body)
    }

    suspend fun checkAlertsNow(): String {
        val o = postJson("/api/alerts/check")
        return "Scanned ${o.optInt("checked")} pairs · ${o.optInt("triggeredCount")} alert(s)"
    }

    suspend fun sendTestAlert(): TargetAlert {
        val o = postJson("/api/alerts/test")
        return parseAlert(o.getJSONObject("alert"))
    }

    suspend fun markAllAlertsRead() {
        postJson("/api/alerts/read", JSONObject().put("id", "all"))
    }

    // ─── Remote Control: Hosts, Hummingbot Containers & Paper Lab ────────────
    suspend fun getHostsStatus(): List<HostInfo> {
        val o = getJson("/api/system/status")
        val arr = o.optJSONArray("hosts") ?: JSONArray()
        return List(arr.length()) { i ->
            val it = arr.getJSONObject(i)
            HostInfo(
                id = it.optString("target"),
                name = it.optString("name", it.optString("target")),
                kind = it.optString("kind"),
                online = it.optBoolean("online", false),
                runningCount = it.optInt("runningCount", 0),
                totalCount = it.optInt("totalCount", 0),
            )
        }
    }

    suspend fun getContainers(target: String): List<BotContainer> {
        val o = getJson("/api/instances", mapOf("target" to target))
        val arr = o.optJSONArray("instances") ?: JSONArray()
        return List(arr.length()) { i ->
            val it = arr.getJSONObject(i)
            val st = it.optJSONObject("stats")
            BotContainer(
                id = it.optString("id"),
                name = it.optString("name"),
                state = it.optString("state"),
                status = it.optString("status"),
                configFile = it.optString("configFile"),
                paper = if (it.isNull("paper")) null else it.optBoolean("paper"),
                cpuPct = st?.optDouble("cpuPct"),
                memUsedMb = st?.optInt("memUsedMb"),
            )
        }
    }

    suspend fun containerAction(target: String, containerId: String, action: String) {
        postJson("/api/instance/$containerId/action", JSONObject().apply {
            put("target", target)
            put("action", action)
        })
    }

    suspend fun stopAllBots(target: String): String {
        val o = postJson("/api/stop-all", JSONObject().put("target", target).put("remove", false))
        return "Stopped ${o.optInt("stopped")} bot(s)"
    }

    suspend fun deployBaseBot(target: String): String {
        val o = postJson("/api/deploy-base", JSONObject().put("target", target).put("launchMode", "detached"))
        return o.optString("message", "Started base bot")
    }

    suspend fun getContainerLogs(target: String, containerId: String): String {
        val o = getJson("/api/instance/$containerId/logs", mapOf("target" to target, "tail" to "150", "source" to "auto"))
        return o.optString("logs", "(empty)")
    }

    suspend fun getPaperSim(): PaperSimSummary {
        val o = getJson("/api/paper-sim/state")
        if (!o.optBoolean("active", false)) {
            return PaperSimSummary(false, false, 0, 0, 0, 0.0, 0.0, null, null)
        }
        val s = o.getJSONObject("session")
        val st = s.getJSONObject("stats")
        val d = o.getJSONObject("derived")
        return PaperSimSummary(
            active = true,
            running = s.optBoolean("running", false),
            tickCount = s.optInt("tickCount", 0),
            filledTrades = st.optInt("filledTrades", 0),
            decayedSignals = st.optInt("decayedSignals", 0),
            actualProfit = st.optDouble("actualProfitTotal", 0.0),
            roiPct = d.optDouble("roiPct", 0.0),
            signalSurvivalPct = if (d.isNull("signalSurvivalPct")) null else d.optDouble("signalSurvivalPct"),
            avgDriftBps = if (d.isNull("avgDriftBps")) null else d.optDouble("avgDriftBps"),
        )
    }

    suspend fun controlPaperSim(action: String, forceTop: Boolean = false) {
        val body = JSONObject()
        if (action == "start") {
            body.put("exA", "kraken").put("exB", "coinbase").put("quote", "USD")
                .put("tradeSize", 500).put("simulatedLatencyMs", 250).put("feeMode", "maker_taker")
        }
        if (forceTop) body.put("forceTestTop", true)
        postJson("/api/paper-sim/$action", body)
    }

    // ─── Holdings & Transactions ─────────────────────────────────────────────
    suspend fun getPortfolio(target: String): PortfolioSnapshot {
        val o = getJson("/api/portfolio", mapOf("target" to target))
        val sum = o.optJSONObject("summary") ?: JSONObject()
        val acctArr = o.optJSONArray("accounts") ?: JSONArray()
        val txArr = o.optJSONArray("transactions") ?: JSONArray()

        val accounts = List(acctArr.length()) { i ->
            val a = acctArr.getJSONObject(i)
            val hArr = a.optJSONArray("holdings") ?: JSONArray()
            val holdings = List(hArr.length()) { j ->
                val h = hArr.getJSONObject(j)
                HoldingItem(
                    asset = h.optString("asset"),
                    total = h.optDouble("total", 0.0),
                    free = h.optDouble("free", 0.0),
                    priceUsd = h.optDouble("priceUsd", 0.0),
                    valueUsd = h.optDouble("valueUsd", 0.0),
                    pct = h.optDouble("pct", 0.0),
                )
            }
            AccountSummary(
                id = a.optString("id"),
                source = a.optString("source"),
                label = a.optString("label"),
                status = a.optString("status"),
                error = if (a.isNull("error")) null else a.optString("error"),
                totalUsd = a.optDouble("totalUsd", 0.0),
                holdings = holdings,
            )
        }

        val txs = List(txArr.length()) { i ->
            val t = txArr.getJSONObject(i)
            TxItem(
                id = t.optString("id"),
                ts = t.optLong("ts", 0L),
                source = t.optString("source"),
                account = t.optString("account"),
                type = t.optString("type"),
                side = t.optString("side"),
                symbol = t.optString("symbol"),
                amount = t.optDouble("amount", 0.0),
                price = t.optDouble("price", 0.0),
                valueUsd = t.optDouble("valueUsd", 0.0),
                feeUsd = t.optDouble("feeUsd", 0.0),
                pnlUsd = if (t.isNull("pnlUsd")) null else t.optDouble("pnlUsd"),
            )
        }

        return PortfolioSnapshot(
            totalUsd = sum.optDouble("totalUsd", 0.0),
            liveUsd = sum.optDouble("liveUsd", 0.0),
            paperHummingbotUsd = sum.optDouble("paperHummingbotUsd", 0.0),
            paperLabUsd = sum.optDouble("paperLabUsd", 0.0),
            openOrderCount = sum.optInt("openOrderCount", 0),
            accounts = accounts,
            transactions = txs,
        )
    }
}
