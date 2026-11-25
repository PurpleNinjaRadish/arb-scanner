package com.arbscanner.mobile.notifications

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.arbscanner.mobile.data.ArbApiClient
import com.arbscanner.mobile.data.PrefsStore
import java.util.concurrent.TimeUnit

// Periodic WorkManager job that polls `/api/alerts?since=...` even when the app is closed.
class AlertPollWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val prefs = PrefsStore(applicationContext)
        if (!prefs.bgPollEnabled) return Result.success()
        val api = ArbApiClient(prefs)
        return try {
            val since = prefs.lastNotifiedAlertTs
            val fresh = api.getAlerts(since = since).sortedBy { it.ts }
            var newest = since
            for (al in fresh) {
                AlertNotificationHelper.showTargetAlert(applicationContext, al)
                if (al.ts > newest) newest = al.ts
            }
            if (newest > since) prefs.lastNotifiedAlertTs = newest
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val WORK_NAME = "arb_target_alert_poll"

        fun schedule(context: Context, enabled: Boolean) {
            val wm = WorkManager.getInstance(context)
            if (!enabled) {
                wm.cancelUniqueWork(WORK_NAME)
                return
            }
            val req = PeriodicWorkRequestBuilder<AlertPollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()
            wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
