package com.arbscanner.mobile.data

import android.content.Context
import org.json.JSONObject

class PrefsStore(context: Context) {
    private val prefs = context.getSharedPreferences("arb_scanner_v3", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", "http://10.0.2.2:3001") ?: "http://10.0.2.2:3001"
        set(v) = prefs.edit().putString("server_url", v.trim().trimEnd('/')).apply()

    var apiToken: String
        get() = prefs.getString("api_token", "") ?: ""
        set(v) = prefs.edit().putString("api_token", v.trim()).apply()

    var ntfyTopic: String
        get() = prefs.getString("ntfy_topic", "") ?: ""
        set(v) = prefs.edit().putString("ntfy_topic", v.trim()).apply()

    var defaultHost: String
        get() = prefs.getString("default_host", "local") ?: "local"
        set(v) = prefs.edit().putString("default_host", v).apply()

    var lastNotifiedAlertTs: Long
        get() = prefs.getLong("last_alert_ts", 0L)
        set(v) = prefs.edit().putLong("last_alert_ts", v).apply()

    var livePushServiceEnabled: Boolean
        get() = prefs.getBoolean("live_push_service", false)
        set(v) = prefs.edit().putBoolean("live_push_service", v).apply()

    var bgPollEnabled: Boolean
        get() = prefs.getBoolean("bg_poll_enabled", true)
        set(v) = prefs.edit().putBoolean("bg_poll_enabled", v).apply()

    fun applyPairingJson(raw: String): Result<String> = runCatching {
        val obj = JSONObject(raw.trim())
        val url = obj.optString("url", "")
        require(url.startsWith("http")) { "Pairing JSON missing valid 'url'" }
        serverUrl = url
        apiToken = obj.optString("token", "")
        ntfyTopic = obj.optString("ntfyTopic", "")
        "Paired to $url"
    }
}
