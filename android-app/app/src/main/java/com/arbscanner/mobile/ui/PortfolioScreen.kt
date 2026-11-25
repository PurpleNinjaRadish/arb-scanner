package com.arbscanner.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arbscanner.mobile.data.ArbApiClient
import com.arbscanner.mobile.data.PortfolioSnapshot
import com.arbscanner.mobile.data.PrefsStore
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun PortfolioScreen(api: ArbApiClient, prefs: PrefsStore) {
    val scope = rememberCoroutineScope()
    var snap by remember { mutableStateOf<PortfolioSnapshot?>(null) }
    var subTab by remember { mutableStateOf("holdings") } // "holdings" | "txns"
    var txFilter by remember { mutableStateOf("ALL") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun refresh() {
        scope.launch {
            loading = true; error = null
            runCatching { api.getPortfolio(prefs.defaultHost) }
                .onSuccess { snap = it }
                .onFailure { error = it.message }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Total Equity Card
        Surface(
            color = ArbColors.Panel,
            border = BorderStroke(1.dp, ArbColors.Green.copy(alpha = 0.45f)),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if ((snap?.liveUsd ?: 0.0) > 0) "LIVE PORTFOLIO EQUITY" else "PORTFOLIO EQUITY (PAPER)",
                        fontSize = 10.sp, color = ArbColors.Muted, fontWeight = FontWeight.Bold
                    )
                    OutlinedButton(onClick = { refresh() }, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp)) {
                        Text(if (loading) "Sync..." else "↻ Sync", fontSize = 11.sp)
                    }
                }
                Text(
                    fmtUsd(snap?.totalUsd ?: 0.0),
                    fontSize = 26.sp, fontWeight = FontWeight.Bold, color = ArbColors.Green, fontFamily = FontFamily.Monospace
                )
                snap?.let { s ->
                    Text(
                        "Live: ${fmtUsd(s.liveUsd)} · HB Paper: ${fmtUsd(s.paperHummingbotUsd)} · Paper Lab: ${fmtUsd(s.paperLabUsd)} · Open Orders: ${s.openOrderCount}",
                        fontSize = 10.sp, color = ArbColors.Muted, fontFamily = FontFamily.Monospace
                    )
                }
            }
        }

        // Sub-tab switcher
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            FilterChip(
                selected = subTab == "holdings",
                onClick = { subTab = "holdings" },
                label = { Text("💼 Holdings (${snap?.accounts?.size ?: 0})", fontSize = 11.sp) },
                modifier = Modifier.weight(1f)
            )
            FilterChip(
                selected = subTab == "txns",
                onClick = { subTab = "txns" },
                label = { Text("🧾 Transactions (${snap?.transactions?.size ?: 0})", fontSize = 11.sp) },
                modifier = Modifier.weight(1f)
            )
        }

        error?.let {
            Text("⚠ $it", color = ArbColors.Red, fontSize = 11.sp)
        }

        if (subTab == "holdings") {
            val accts = snap?.accounts ?: emptyList()
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (accts.isEmpty() && !loading) {
                    item {
                        Surface(color = ArbColors.Panel, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                            Text(
                                "No holdings loaded yet. Add read-only Kraken/Coinbase keys in the desktop Holdings tab or start Paper Mode.",
                                color = ArbColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(16.dp)
                            )
                        }
                    }
                }
                items(accts, key = { it.id }) { acct ->
                    Surface(
                        color = ArbColors.Panel,
                        border = BorderStroke(1.dp, ArbColors.Border),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(acct.label, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                    PillBadge(
                                        if (acct.source == "live") "LIVE" else "PAPER",
                                        if (acct.source == "live") ArbColors.Green else ArbColors.Purple
                                    )
                                }
                                Text(fmtUsd(acct.totalUsd), fontWeight = FontWeight.Bold, color = ArbColors.Cyan, fontFamily = FontFamily.Monospace)
                            }
                            if (acct.error != null) {
                                Text("⚠ ${acct.error}", color = ArbColors.Red, fontSize = 11.sp)
                            } else {
                                acct.holdings.take(12).forEach { h ->
                                    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                            Text(
                                                "${h.asset} (${String.format(Locale.US, "%.4f", h.total)})",
                                                fontSize = 11.sp, fontFamily = FontFamily.Monospace
                                            )
                                            Text(
                                                "${fmtUsd(h.valueUsd)} (${String.format(Locale.US, "%.1f%%", h.pct)})",
                                                fontSize = 11.sp, color = ArbColors.Cyan, fontFamily = FontFamily.Monospace
                                            )
                                        }
                                        LinearProgressIndicator(
                                            progress = { (h.pct / 100.0).toFloat().coerceIn(0f, 1f) },
                                            modifier = Modifier.fillMaxWidth().height(4.dp).padding(top = 2.dp),
                                            color = if (acct.source == "live") ArbColors.Green else ArbColors.Blue,
                                            trackColor = ArbColors.PanelAlt,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // Transactions feed
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("ALL", "TRADE", "PAPER_TRADE", "DEPOSIT", "WITHDRAWAL").forEach { f ->
                    FilterChip(selected = txFilter == f, onClick = { txFilter = f }, label = { Text(f, fontSize = 10.sp) })
                }
            }
            val txs = (snap?.transactions ?: emptyList()).filter { txFilter == "ALL" || it.type == txFilter }
            val timeFmt = remember { SimpleDateFormat("MM-dd HH:mm", Locale.US) }
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (txs.isEmpty()) {
                    item {
                        Surface(color = ArbColors.Panel, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                            Text("No transactions matching filter.", color = ArbColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(16.dp))
                        }
                    }
                }
                items(txs.take(100), key = { it.id }) { t ->
                    Surface(
                        color = ArbColors.Panel,
                        border = BorderStroke(1.dp, ArbColors.Border),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(t.symbol, fontWeight = FontWeight.Bold, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                                    PillBadge(t.side, if (t.side in listOf("BUY", "IN", "FILLED")) ArbColors.Green else ArbColors.Red)
                                }
                                Text(
                                    t.pnlUsd?.let { String.format(Locale.US, "%s P&L", fmtUsd(it)) } ?: fmtUsd(t.valueUsd),
                                    color = (t.pnlUsd ?: 1.0).let { if (it >= 0) ArbColors.Green else ArbColors.Red },
                                    fontWeight = FontWeight.Bold, fontSize = 12.sp, fontFamily = FontFamily.Monospace
                                )
                            }
                            Text(
                                "${timeFmt.format(Date(t.ts))} · ${t.account} · ${t.type} · Qty ${String.format(Locale.US, "%.4f", t.amount)} @ ${fmtPrice(t.price)}",
                                fontSize = 10.sp, color = ArbColors.Muted, fontFamily = FontFamily.Monospace
                            )
                        }
                    }
                }
            }
        }
    }
}
