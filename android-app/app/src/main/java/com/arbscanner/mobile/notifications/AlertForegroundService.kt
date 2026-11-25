package com.arbscanner.mobile.notifications

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.arbscanner.mobile.MainActivity
import com.arbscanner.mobile.data.ArbApiClient
import com.arbscanner.mobile.data.PrefsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

// Optional Foreground Service that streams `/api/alerts/stream` (SSE) for sub-second
// profitable target push notifications directly from your Arb Scanner server (no Firebase needed).
class AlertForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var streamJob: Job? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AlertNotificationHelper.ensureChannels(this)
        val openPi = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notif = NotificationCompat.Builder(this, AlertNotificationHelper.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Arb Scanner Live Alerts")
            .setContentText("Watching for profitable arbitrage targets...")
            .setOngoing(true)
            .setContentIntent(openPi)
            .build()
        val fgType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }
        ServiceCompat.startForeground(this, 1001, notif, fgType)

        if (streamJob == null || streamJob?.isActive != true) {
            startStreamLoop()
        }
        return START_STICKY
    }

    private fun startStreamLoop() {
        val prefs = PrefsStore(applicationContext)
        val api = ArbApiClient(prefs)
        streamJob = scope.launch {
            while (isActive) {
                try {
                    val req = api.buildAlertStreamRequest()
                    api.streamClient.newCall(req).execute().use { res ->
                        if (!res.isSuccessful) {
                            delay(8000)
                            return@use
                        }
                        val reader = res.body?.charStream()?.buffered() ?: return@use
                        var currentEvent = ""
                        while (isActive) {
                            val line = reader.readLine() ?: break
                            when {
                                line.startsWith("event:") -> currentEvent = line.removePrefix("event:").trim()
                                line.startsWith("data:") && currentEvent == "alert" -> {
                                    val json = line.removePrefix("data:").trim()
                                    runCatching {
                                        val alert = api.parseAlert(JSONObject(json))
                                        if (alert.ts > prefs.lastNotifiedAlertTs) {
                                            prefs.lastNotifiedAlertTs = alert.ts
                                        }
                                        AlertNotificationHelper.showTargetAlert(applicationContext, alert)
                                    }
                                    currentEvent = ""
                                }
                            }
                        }
                    }
                } catch (_: Exception) {
                    // reconnect backoff
                }
                delay(5000)
            }
        }
    }

    override fun onDestroy() {
        streamJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, AlertForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AlertForegroundService::class.java))
        }
    }
}
