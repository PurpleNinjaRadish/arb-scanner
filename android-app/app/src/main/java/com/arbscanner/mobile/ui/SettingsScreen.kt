package com.arbscanner.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arbscanner.mobile.data.ArbApiClient
import com.arbscanner.mobile.data.PrefsStore
import com.arbscanner.mobile.notifications.AlertForegroundService
import com.arbscanner.mobile.notifications.AlertPollWorker
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(api: ArbApiClient, prefs: PrefsStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var serverUrl by remember { mutableStateOf(prefs.serverUrl) }
    var apiToken by remember { mutableStateOf(prefs.apiToken) }
    var pairingInput by remember { mutableStateOf("") }
    var livePush by remember { mutableStateOf(prefs.livePushServiceEnabled) }
    var bgPoll by remember { mutableStateOf(prefs.bgPollEnabled) }
    var statusMsg by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Quick Pairing JSON Card
        Surface(
            color = ArbColors.Panel,
            border = BorderStroke(1.dp, ArbColors.Cyan.copy(alpha = 0.5f)),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("1-TAP PAIRING FROM DESKTOP", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = ArbColors.Cyan)
                Text(
                    "In Arb Scanner Desktop → Alerts & Mobile tab, tap 'Copy Pairing JSON' and paste below:",
                    fontSize = 11.sp, color = ArbColors.Muted
                )
                OutlinedTextField(
                    value = pairingInput,
                    onValueChange = { pairingInput = it },
                    placeholder = { Text("{\"url\":\"http://192.168.1.50:3001\",\"token\":\"arb_...\"}", fontSize = 11.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3
                )
                Button(onClick = {
                    prefs.applyPairingJson(pairingInput)
                        .onSuccess {
                            serverUrl = prefs.serverUrl
                            apiToken = prefs.apiToken
                            pairingInput = ""
                            statusMsg = "✓ $it"
                        }
                        .onFailure { statusMsg = "✗ ${it.message}" }
                }, modifier = Modifier.fillMaxWidth()) { Text("Apply Pairing JSON") }
            }
        }

        // Manual Server Connection
        Surface(
            color = ArbColors.Panel,
            border = BorderStroke(1.dp, ArbColors.Border),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("BACKEND CONNECTION", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = ArbColors.Blue)
                OutlinedTextField(
                    value = serverUrl,
                    onValueChange = { serverUrl = it },
                    label = { Text("Server URL (LAN IP, Tailscale, or VPS)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = apiToken,
                    onValueChange = { apiToken = it },
                    label = { Text("API Token (X-API-Token)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    Button(modifier = Modifier.weight(1f), onClick = {
                        prefs.serverUrl = serverUrl
                        prefs.apiToken = apiToken
                        statusMsg = "Saved connection settings."
                    }) { Text("Save") }

                    OutlinedButton(enabled = !testing, modifier = Modifier.weight(1f), onClick = {
                        prefs.serverUrl = serverUrl
                        prefs.apiToken = apiToken
                        scope.launch {
                            testing = true; statusMsg = "Connecting..."
                            runCatching { api.health() }
                                .onSuccess { statusMsg = "✓ Connected! Backend $it" }
                                .onFailure { statusMsg = "✗ Connection failed: ${it.message}" }
                            testing = false
                        }
                    }) { Text(if (testing) "Testing..." else "🔌 Test") }
                }
            }
        }

        // Native Push Notifications Settings
        Surface(
            color = ArbColors.Panel,
            border = BorderStroke(1.dp, ArbColors.Border),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("ANDROID PUSH NOTIFICATIONS", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = ArbColors.Green)

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Real-Time Live SSE Listener", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text("Sub-second heads-up alerts via Foreground Service (no Firebase needed)", fontSize = 10.sp, color = ArbColors.Muted)
                    }
                    Switch(checked = livePush, onCheckedChange = { enabled ->
                        livePush = enabled
                        prefs.livePushServiceEnabled = enabled
                        if (enabled) AlertForegroundService.start(context) else AlertForegroundService.stop(context)
                        statusMsg = if (enabled) "Live SSE alert service started!" else "Live SSE alert service stopped."
                    })
                }

                HorizontalDivider(color = ArbColors.Border)

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Background Periodic Check", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text("Battery-friendly WorkManager check every 15 min when app is closed", fontSize = 10.sp, color = ArbColors.Muted)
                    }
                    Switch(checked = bgPoll, onCheckedChange = { enabled ->
                        bgPoll = enabled
                        prefs.bgPollEnabled = enabled
                        AlertPollWorker.schedule(context, enabled)
                        statusMsg = if (enabled) "Background alert worker scheduled." else "Background alert worker cancelled."
                    })
                }

                if (prefs.ntfyTopic.isNotBlank()) {
                    Text(
                        "ntfy.sh topic synced: ${prefs.ntfyTopic}",
                        fontSize = 11.sp, color = ArbColors.Cyan, fontFamily = FontFamily.Monospace
                    )
                }
            }
        }

        statusMsg?.let {
            Surface(color = ArbColors.PanelAlt, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                Text(it, color = ArbColors.Cyan, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(12.dp))
            }
        }
    }
}
