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
fun SettingsScreen(api: ArbApiClient, prefs: PrefsStore, pendingLink: Pair<String, String>? = null, onLinkHandled: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var serverUrl by remember { mutableStateOf(prefs.serverUrl) }
    var apiToken by remember { mutableStateOf(prefs.apiToken) }
    var pairingInput by remember { mutableStateOf("") }
    var livePush by remember { mutableStateOf(prefs.livePushServiceEnabled) }
    var bgPoll by remember { mutableStateOf(prefs.bgPollEnabled) }
    var statusMsg by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }

    // Remote Access: link with a one-time code from the desktop
    var linkUrl by remember { mutableStateOf(if (prefs.serverUrl.startsWith("https://")) prefs.serverUrl else "") }
    var linkCode by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf(prefs.deviceName.ifBlank { android.os.Build.MODEL ?: "Android" }) }
    var linking by remember { mutableStateOf(false) }
    var linked by remember { mutableStateOf(prefs.isLinkedDevice) }

    LaunchedEffect(pendingLink) {
        pendingLink?.let { (u, c) ->
            if (u.isNotBlank()) linkUrl = u
            linkCode = c
            statusMsg = "Link code received — check the address and tap Link."
            onLinkHandled()
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Remote Access (from anywhere, through the PC's tunnel)
        Surface(
            color = ArbColors.Panel,
            border = BorderStroke(1.dp, ArbColors.Green.copy(alpha = 0.5f)),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("REMOTE ACCESS — LINK WITH CODE", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = ArbColors.Green)
                if (linked) {
                    Text("✓ Linked to ${prefs.serverUrl}", fontSize = 11.sp, color = ArbColors.Green, fontFamily = FontFamily.Monospace)
                }
                Text(
                    "On the PC: Remote Access tab → Make link code. Scan the QR with the phone camera, or type the address and code here. Works from anywhere, not just Wi-Fi.",
                    fontSize = 11.sp, color = ArbColors.Muted
                )
                OutlinedTextField(
                    value = linkUrl, onValueChange = { linkUrl = it.trim() },
                    label = { Text("Remote address (https://…)") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = linkCode, onValueChange = { linkCode = it.uppercase() },
                    label = { Text("Link code (ABCD-2345)") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = deviceName, onValueChange = { deviceName = it },
                    label = { Text("Name this phone") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    Button(
                        enabled = !linking && linkUrl.isNotBlank() && linkCode.filter { it.isLetterOrDigit() }.length == 8,
                        modifier = Modifier.weight(1f),
                        onClick = {
                            scope.launch {
                                linking = true; statusMsg = "Linking…"
                                prefs.deviceName = deviceName
                                runCatching { api.linkWithCode(linkUrl, linkCode, deviceName) }
                                    .onSuccess {
                                        serverUrl = prefs.serverUrl; apiToken = prefs.apiToken
                                        linked = true; linkCode = ""
                                        statusMsg = "✓ Linked as $it"
                                        if (prefs.livePushServiceEnabled) { AlertForegroundService.stop(context); AlertForegroundService.start(context) }
                                    }
                                    .onFailure { statusMsg = "✗ ${it.message}" }
                                linking = false
                            }
                        }
                    ) { Text(if (linking) "Linking…" else "🔗 Link") }
                    if (linked) {
                        OutlinedButton(modifier = Modifier.weight(1f), onClick = {
                            scope.launch {
                                api.signOutDevice()
                                apiToken = ""; linked = false
                                statusMsg = "Signed out of Remote Access."
                            }
                        }) { Text("Sign out") }
                    }
                }
            }
        }

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
