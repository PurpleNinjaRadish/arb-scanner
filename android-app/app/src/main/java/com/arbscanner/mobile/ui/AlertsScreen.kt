package com.arbscanner.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arbscanner.mobile.data.AlertWatcherStatus
import com.arbscanner.mobile.data.ArbApiClient
import com.arbscanner.mobile.data.TargetAlert
import com.arbscanner.mobile.notifications.AlertNotificationHelper
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun AlertsScreen(api: ArbApiClient, onUnreadUpdated: (Int) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<AlertWatcherStatus?>(null) }
    var alerts by remember { mutableStateOf<List<TargetAlert>>(emptyList()) }
    var minPctText by remember { mutableStateOf("0.25") }
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun refresh() {
        scope.launch {
            runCatching {
                val st = api.getAlertStatus()
                val list = api.getAlerts()
                st to list
            }.onSuccess { (st, list) ->
                status = st
                alerts = list
                minPctText = st.minNetPct.toString()
                onUnreadUpdated(st.unreadCount)
            }.onFailure { msg = "Error: ${it.message}" }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Watcher Control Card
        Surface(
            color = ArbColors.Panel,
            border = BorderStroke(1.dp, ArbColors.Border),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column {
                        Text("PROFITABLE TARGET WATCHER", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = ArbColors.Blue)
                        Text(
                            status?.let { "${it.pair.uppercase()} (${it.quote}) · Scans: ${it.checksCount}" } ?: "Connecting...",
                            fontSize = 11.sp, color = ArbColors.Muted
                        )
                    }
                    Switch(
                        checked = status?.enabled == true,
                        onCheckedChange = { enabled ->
                            scope.launch {
                                busy = true
                                runCatching { api.updateAlertSettings(enabled = enabled) }
                                    .onSuccess { msg = if (enabled) "24/7 Target Watcher ENABLED" else "Watcher paused"; refresh() }
                                    .onFailure { msg = it.message }
                                busy = false
                            }
                        }
                    )
                }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = minPctText,
                        onValueChange = { minPctText = it },
                        label = { Text("Min Net %", fontSize = 10.sp) },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    Button(enabled = !busy, onClick = {
                        scope.launch {
                            busy = true
                            val v = minPctText.toDoubleOrNull() ?: 0.25
                            runCatching { api.updateAlertSettings(minNetPct = v) }
                                .onSuccess { msg = "Threshold saved ($v%)"; refresh() }
                                .onFailure { msg = it.message }
                            busy = false
                        }
                    }) { Text("Save", fontSize = 11.sp) }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(enabled = !busy, modifier = Modifier.weight(1f), onClick = {
                        scope.launch {
                            busy = true
                            runCatching { api.checkAlertsNow() }
                                .onSuccess { msg = it; refresh() }
                                .onFailure { msg = it.message }
                            busy = false
                        }
                    }) { Text("🔍 Scan Now", fontSize = 11.sp) }

                    OutlinedButton(enabled = !busy, modifier = Modifier.weight(1f), onClick = {
                        scope.launch {
                            busy = true
                            runCatching { api.sendTestAlert() }
                                .onSuccess { al ->
                                    AlertNotificationHelper.showTargetAlert(context, al)
                                    msg = "Test push sent!"
                                    refresh()
                                }
                                .onFailure { msg = it.message }
                            busy = false
                        }
                    }) { Text("🔔 Test Push", fontSize = 11.sp) }

                    OutlinedButton(enabled = !busy, onClick = {
                        scope.launch {
                            runCatching { api.markAllAlertsRead() }
                            refresh()
                        }
                    }) { Text("✓ Read", fontSize = 11.sp) }
                }
            }
        }

        msg?.let { Text(it, color = ArbColors.Cyan, fontSize = 11.sp, fontFamily = FontFamily.Monospace) }

        val timeFmt = remember { SimpleDateFormat("MM-dd HH:mm:ss", Locale.US) }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (alerts.isEmpty()) {
                item {
                    Surface(color = ArbColors.Panel, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "No target alerts yet. Turn on the 24/7 Watcher above or tap Test Push to verify Android notifications.",
                            color = ArbColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(16.dp)
                        )
                    }
                }
            }
            items(alerts, key = { it.id }) { a ->
                Surface(
                    color = if (a.read) ArbColors.Panel else ArbColors.Green.copy(alpha = 0.08f),
                    border = BorderStroke(1.dp, if (a.read) ArbColors.Border else ArbColors.Green.copy(alpha = 0.55f)),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(a.title, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (a.isTest) ArbColors.Yellow else ArbColors.Green, modifier = Modifier.weight(1f))
                            if (a.verifiedL2) PillBadge("L2", ArbColors.Cyan)
                        }
                        Text(a.message, fontSize = 11.sp, color = ArbColors.Text, fontFamily = FontFamily.Monospace)
                        Text(timeFmt.format(Date(a.ts)), fontSize = 10.sp, color = ArbColors.Muted)
                    }
                }
            }
        }
    }
}
