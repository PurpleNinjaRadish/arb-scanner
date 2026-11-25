package com.arbscanner.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arbscanner.mobile.data.*
import kotlinx.coroutines.launch
import java.util.Locale

@Composable
fun RemoteControlScreen(api: ArbApiClient, prefs: PrefsStore) {
    val scope = rememberCoroutineScope()
    var hosts by remember { mutableStateOf<List<HostInfo>>(emptyList()) }
    var target by remember { mutableStateOf(prefs.defaultHost) }
    var containers by remember { mutableStateOf<List<BotContainer>>(emptyList()) }
    var paper by remember { mutableStateOf<PaperSimSummary?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var logDialogTitle by remember { mutableStateOf<String?>(null) }
    var logDialogText by remember { mutableStateOf("") }

    fun refresh() {
        scope.launch {
            busy = true
            runCatching {
                val h = api.getHostsStatus()
                val c = runCatching { api.getContainers(target) }.getOrDefault(emptyList())
                val p = runCatching { api.getPaperSim() }.getOrNull()
                Triple(h, c, p)
            }.onSuccess { (h, c, p) ->
                hosts = h; containers = c; paper = p
            }.onFailure { msg = "Error: ${it.message}" }
            busy = false
        }
    }

    LaunchedEffect(target) { refresh() }

    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Host selector strip
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            hosts.forEach { h ->
                FilterChip(
                    selected = target == h.id,
                    onClick = { target = h.id; prefs.defaultHost = h.id },
                    label = { Text("${if (h.online) "🟢" else "🔴"} ${h.name} (${h.runningCount})", fontSize = 11.sp) }
                )
            }
            OutlinedButton(onClick = { refresh() }, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp)) {
                Text(if (busy) "..." else "↻", fontSize = 12.sp)
            }
        }

        // Paper Lab Remote Control Card
        paper?.let { p ->
            Surface(
                color = ArbColors.Panel,
                border = BorderStroke(1.dp, ArbColors.Purple.copy(alpha = 0.5f)),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("PAPER ACCURACY LAB", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = ArbColors.Purple)
                        PillBadge(if (p.running) "RUNNING" else if (p.active) "PAUSED" else "IDLE", if (p.running) ArbColors.Green else ArbColors.Yellow)
                    }
                    if (p.active) {
                        Text(
                            "P&L: ${fmtUsd(p.actualProfit)} (${String.format(Locale.US, "%+.2f%%", p.roiPct)}) · ${p.filledTrades} filled · ${p.decayedSignals} decayed" +
                                (p.avgDriftBps?.let { " · Drift ${String.format(Locale.US, "%.1f", it)} bps" } ?: ""),
                            fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = ArbColors.Text
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (!p.running) {
                            Button(onClick = {
                                scope.launch {
                                    runCatching { api.controlPaperSim(if (p.active) "resume" else "start") }
                                        .onSuccess { msg = "Paper Lab started"; refresh() }
                                        .onFailure { msg = it.message }
                                }
                            }, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) { Text("▶ Start", fontSize = 11.sp) }
                        } else {
                            OutlinedButton(onClick = {
                                scope.launch {
                                    runCatching { api.controlPaperSim("stop") }
                                        .onSuccess { msg = "Paper Lab paused"; refresh() }
                                }
                            }, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) { Text("⏸ Pause", fontSize = 11.sp) }
                        }
                        if (p.active) {
                            OutlinedButton(onClick = {
                                scope.launch {
                                    msg = "Running L2 accuracy tick..."
                                    runCatching { api.controlPaperSim("tick", forceTop = true) }
                                        .onSuccess { msg = "L2 accuracy tick done"; refresh() }
                                        .onFailure { msg = it.message }
                                }
                            }, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) { Text("⚡ L2 Test", fontSize = 11.sp) }
                        }
                    }
                }
            }
        }

        // Hummingbot Bulk Controls
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Button(modifier = Modifier.weight(1f), onClick = {
                scope.launch {
                    runCatching { api.deployBaseBot(target) }
                        .onSuccess { msg = it; refresh() }
                        .onFailure { msg = it.message }
                }
            }) { Text("+ Base Bot", fontSize = 11.sp) }

            OutlinedButton(modifier = Modifier.weight(1f), onClick = {
                scope.launch {
                    runCatching { api.stopAllBots(target) }
                        .onSuccess { msg = it; refresh() }
                        .onFailure { msg = it.message }
                }
            }) { Text("■ Stop All ($target)", fontSize = 11.sp, color = ArbColors.Red) }
        }

        msg?.let { Text(it, color = ArbColors.Cyan, fontSize = 11.sp, fontFamily = FontFamily.Monospace) }

        // Containers List
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (containers.isEmpty()) {
                item {
                    Surface(color = ArbColors.Panel, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "No Hummingbot containers found on '$target'. Deploy a strategy from the Scanner tab or launch a Base Bot above.",
                            color = ArbColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(16.dp)
                        )
                    }
                }
            }
            items(containers, key = { it.id }) { c ->
                val running = c.state == "running"
                Surface(
                    color = ArbColors.Panel,
                    border = BorderStroke(1.dp, if (running) ArbColors.Green.copy(alpha = 0.5f) else ArbColors.Border),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(c.name, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                PillBadge(c.state.uppercase(), if (running) ArbColors.Green else ArbColors.Red)
                                if (c.paper == true) PillBadge("PAPER", ArbColors.Cyan)
                                if (c.paper == false) PillBadge("LIVE", ArbColors.Red)
                            }
                        }
                        Text(
                            "${c.configFile.ifBlank { "base instance" }} · ${c.status}" +
                                (c.memUsedMb?.let { " · ${it}MB / ${String.format(Locale.US, "%.1f", c.cpuPct ?: 0.0)}% CPU" } ?: ""),
                            fontSize = 10.sp, color = ArbColors.Muted, fontFamily = FontFamily.Monospace
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (!running) {
                                OutlinedButton(onClick = {
                                    scope.launch { runCatching { api.containerAction(target, c.id, "start") }; refresh() }
                                }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)) { Text("▶ Start", fontSize = 10.sp, color = ArbColors.Green) }
                            } else {
                                OutlinedButton(onClick = {
                                    scope.launch { runCatching { api.containerAction(target, c.id, "restart") }; refresh() }
                                }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)) { Text("↻ Restart", fontSize = 10.sp) }
                                OutlinedButton(onClick = {
                                    scope.launch { runCatching { api.containerAction(target, c.id, "stop") }; refresh() }
                                }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)) { Text("■ Stop", fontSize = 10.sp, color = ArbColors.Red) }
                            }
                            OutlinedButton(onClick = {
                                scope.launch {
                                    logDialogTitle = c.name
                                    logDialogText = "Loading logs..."
                                    logDialogText = runCatching { api.getContainerLogs(target, c.id) }.getOrElse { "Error: ${it.message}" }
                                }
                            }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)) { Text("📜 Logs", fontSize = 10.sp, color = ArbColors.Cyan) }
                        }
                    }
                }
            }
        }
    }

    logDialogTitle?.let { title ->
        AlertDialog(
            onDismissRequest = { logDialogTitle = null },
            containerColor = ArbColors.Panel,
            title = { Text("Logs: $title", fontSize = 14.sp, fontWeight = FontWeight.Bold) },
            text = {
                Box(Modifier.height(340.dp).verticalScroll(rememberScrollState())) {
                    Text(logDialogText, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = ArbColors.Green)
                }
            },
            confirmButton = { TextButton(onClick = { logDialogTitle = null }) { Text("Close") } }
        )
    }
}
