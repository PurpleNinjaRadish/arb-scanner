package com.arbscanner.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
import com.arbscanner.mobile.data.L2VerifyResult
import com.arbscanner.mobile.data.Opportunity
import com.arbscanner.mobile.data.PrefsStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

@Composable
fun ScannerScreen(api: ArbApiClient, prefs: PrefsStore) {
    val scope = rememberCoroutineScope()
    var pair by remember { mutableStateOf("kraken_coinbase") }
    var quote by remember { mutableStateOf("USD") }
    var feeMode by remember { mutableStateOf("maker_taker") }
    var tradeSize by remember { mutableIntStateOf(1000) }
    var viableOnly by remember { mutableStateOf(false) }
    var livePolling by remember { mutableStateOf(true) }

    var opps by remember { mutableStateOf<List<Opportunity>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedOpp by remember { mutableStateOf<Opportunity?>(null) }

    fun refresh() {
        scope.launch {
            loading = true
            error = null
            runCatching { api.scan(pair, quote, tradeSize, feeMode) }
                .onSuccess { opps = it }
                .onFailure { error = it.message }
            loading = false
        }
    }

    LaunchedEffect(pair, quote, feeMode, tradeSize, livePolling) {
        refresh()
        while (livePolling) {
            delay(15_000)
            refresh()
        }
    }

    val visible = remember(opps, viableOnly) {
        if (viableOnly) opps.filter { it.isViable } else opps
    }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        // Pair & Quote controls
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            listOf(
                "kraken_coinbase" to "Kraken×CB",
                "binanceus_kraken" to "BinUS×KRK",
                "binance_kraken" to "Bin×KRK",
                "bybit_kraken" to "Bybit×KRK",
            ).forEach { (id, label) ->
                FilterChip(
                    selected = pair == id,
                    onClick = {
                        pair = id
                        quote = if (id.contains("coinbase") || id.contains("binanceus")) "USD" else "USDT"
                    },
                    label = { Text(label, fontSize = 11.sp) }
                )
            }
        }

        Spacer(Modifier.height(4.dp))

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf("USD", "USDT", "USDC").forEach { q ->
                    FilterChip(selected = quote == q, onClick = { quote = q }, label = { Text(q, fontSize = 10.sp) })
                }
                FilterChip(
                    selected = feeMode == "maker_taker",
                    onClick = { feeMode = if (feeMode == "maker_taker") "taker_taker" else "maker_taker" },
                    label = { Text(if (feeMode == "maker_taker") "XEMM" else "Taker", fontSize = 10.sp) }
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(
                    selected = viableOnly,
                    onClick = { viableOnly = !viableOnly },
                    label = { Text("Viable", fontSize = 10.sp) }
                )
                OutlinedButton(
                    onClick = { refresh() },
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp)
                ) {
                    Text(if (loading) "..." else "↻", fontSize = 12.sp)
                }
            }
        }

        if (error != null) {
            Surface(
                color = ArbColors.Red.copy(alpha = 0.14f),
                border = BorderStroke(1.dp, ArbColors.Red.copy(alpha = 0.5f)),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)
            ) {
                Text("⚠ $error", color = ArbColors.Red, fontSize = 11.sp, modifier = Modifier.padding(10.dp))
            }
        }

        val viableCount = opps.count { it.isViable }
        Text(
            text = "${visible.size} pairs shown · $viableCount viable · Size ${fmtUsd(tradeSize.toDouble(), 0)} · Tap coin for L2 test / Deploy",
            color = ArbColors.Muted, fontSize = 10.sp, modifier = Modifier.padding(vertical = 6.dp)
        )

        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(visible.take(80), key = { it.symbol }) { o ->
                Surface(
                    color = ArbColors.Panel,
                    border = BorderStroke(1.dp, if (o.isViable) ArbColors.Green.copy(alpha = 0.6f) else ArbColors.Border),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth().clickable { selectedOpp = o }
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(o.symbol, fontWeight = FontWeight.Bold, fontSize = 15.sp, fontFamily = FontFamily.Monospace)
                                PillBadge(if (o.estimated) "EST" else "BOOK", if (o.estimated) ArbColors.Muted else ArbColors.Cyan)
                            }
                            Text(
                                text = String.format(Locale.US, "%+.3f%% (%s)", o.netProfit, fmtUsd(o.netDollar)),
                                color = if (o.netProfit > 0) ArbColors.Green else ArbColors.Red,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 13.sp,
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                "Buy ${o.buyOn.uppercase()} ${fmtPrice(o.buyPrice)} → Sell ${o.sellOn.uppercase()} ${fmtPrice(o.sellPrice)}",
                                color = ArbColors.Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace
                            )
                        }
                    }
                }
            }
        }
    }

    selectedOpp?.let { opp ->
        OppActionDialog(
            api = api,
            prefs = prefs,
            pair = pair,
            quote = quote,
            feeMode = feeMode,
            opp = opp,
            onDismiss = { selectedOpp = null }
        )
    }
}

@Composable
private fun OppActionDialog(
    api: ArbApiClient,
    prefs: PrefsStore,
    pair: String,
    quote: String,
    feeMode: String,
    opp: Opportunity,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var paperTrade by remember { mutableStateOf(true) }
    var strategy by remember { mutableStateOf("amm_arb") }
    var verifyResult by remember { mutableStateOf<L2VerifyResult?>(null) }
    var statusMsg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = ArbColors.Panel,
        title = {
            Text("${opp.symbol}-$quote · ${opp.buyOn.uppercase()} → ${opp.sellOn.uppercase()}", fontSize = 15.sp, fontWeight = FontWeight.Bold)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Ask: ${fmtPrice(opp.buyPrice)} | Bid: ${fmtPrice(opp.sellPrice)}\nExec Spread: ${String.format(Locale.US, "%.3f%%", opp.spread)} | Net: ${String.format(Locale.US, "%+.3f%%", opp.netProfit)} (${fmtUsd(opp.netDollar)})",
                    fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = ArbColors.Text
                )

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = strategy == "amm_arb", onClick = { strategy = "amm_arb" }, label = { Text("amm_arb", fontSize = 11.sp) })
                    FilterChip(selected = strategy == "cross_exchange_market_making", onClick = { strategy = "cross_exchange_market_making" }, label = { Text("XEMM", fontSize = 11.sp) })
                }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(if (paperTrade) "🟢 Paper Mode (Safe)" else "⚠ LIVE Real Funds", color = if (paperTrade) ArbColors.Green else ArbColors.Red, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Switch(checked = paperTrade, onCheckedChange = { paperTrade = it })
                }

                verifyResult?.let { r ->
                    Surface(
                        color = (if (r.stillProfitable) ArbColors.Green else ArbColors.Yellow).copy(alpha = 0.14f),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            "L2 Fill (${r.totalProcessingMs}ms): ${if (r.stillProfitable) "PROFITABLE" else "NEGATIVE"}\n" +
                                "Actual Net: ${fmtUsd(r.actualNetDollar)} (${String.format(Locale.US, "%+.3f%%", r.actualNetPct)})\n" +
                                "Drift: ${String.format(Locale.US, "%.1f", r.totalDriftBps)} bps | Buy VWAP ${fmtPrice(r.buyVwap)}",
                            fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(8.dp)
                        )
                    }
                }

                statusMsg?.let {
                    Text(it, color = ArbColors.Cyan, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(enabled = !busy, onClick = {
                    scope.launch {
                        busy = true; statusMsg = null
                        runCatching { api.verifyFill(pair, opp, quote, feeMode, 250) }
                            .onSuccess { verifyResult = it }
                            .onFailure { statusMsg = "L2 check error: ${it.message}" }
                        busy = false
                    }
                }) { Text("🧪 L2 Test", fontSize = 11.sp) }

                Button(enabled = !busy, onClick = {
                    scope.launch {
                        busy = true; statusMsg = "Deploying to ${prefs.defaultHost}..."
                        runCatching {
                            api.deployQuickBot(
                                targetHost = prefs.defaultHost,
                                pair = pair, opp = opp, quote = quote,
                                strategy = strategy, paperTrade = paperTrade,
                                tradeSizeUsd = opp.tradeSize,
                                minProfPct = maxOf(opp.netProfit * 0.75, 0.25)
                            )
                        }.onSuccess { statusMsg = "✓ $it" }
                            .onFailure { statusMsg = "✗ ${it.message}" }
                        busy = false
                    }
                }) { Text("🤖 Deploy", fontSize = 11.sp) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } }
    )
}
