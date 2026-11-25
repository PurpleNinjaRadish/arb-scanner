package com.arbscanner.mobile.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.arbscanner.mobile.MainActivity
import com.arbscanner.mobile.data.TargetAlert

object AlertNotificationHelper {
    const val CHANNEL_TARGETS = "arb_profitable_targets"
    const val CHANNEL_SERVICE = "arb_live_watcher_service"

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val targets = NotificationChannel(
            CHANNEL_TARGETS,
            "Profitable Arb Targets",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Instant heads-up alerts when a profitable cross-exchange arbitrage target triggers"
            enableVibration(true)
            enableLights(true)
        }

        val service = NotificationChannel(
            CHANNEL_SERVICE,
            "Live Alert Listener",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps live connection open for sub-second arbitrage notifications"
        }

        nm.createNotificationChannel(targets)
        nm.createNotificationChannel(service)
    }

    fun showTargetAlert(context: Context, alert: TargetAlert) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return
        }
        ensureChannels(context)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_tab", "alerts")
        }
        val pi = PendingIntent.getActivity(
            context, alert.id.hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(context, CHANNEL_TARGETS)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(alert.title)
            .setContentText(alert.message.lineSequence().firstOrNull() ?: alert.message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()

        NotificationManagerCompat.from(context).notify(alert.id.hashCode(), notif)
    }
}
